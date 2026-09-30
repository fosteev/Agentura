import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  EffortLevel,
  PermissionMode,
} from '../agent/types';
import { nextStatus, tabTitle, type ChatStatus } from '../agent/status';
import type { FromWebview, SessionSummary, ToWebview } from '../protocol';
import { buildPrompt, attachmentKey, type Attachment, type FileHit } from '../shared/prompt';
import type { LiveSessions } from '../data/sessions';

/** Всё, что контроллеру нужно от VS Code, — через этот интерфейс: сам контроллер vscode не импортирует. */
export interface ChatDeps {
  adapter: AgentAdapter;
  cwd: string;
  project: string;
  post(message: ToWebview): void;
  setTitle(title: string): void;
  log: {
    debug(m: string): void;
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
  };
  settings(): { defaultModel?: string; allowBypass: boolean };
  findFiles(query: string): Promise<FileHit[]>;
  pickFiles(): Promise<FileHit[]>;
  /** Текст выделения для вложения `selection`. */
  readSelection(a: Attachment): Promise<string | undefined>;
  listRecent(): Promise<SessionSummary[]>;
  showSessions(): void;
  live?: LiveSessions;
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const STUB_DENY = 'Интерфейс запросов разрешений ещё не готов (этап 5 Agentura): запрос отклонён.';

/**
 * Владелец сессии агента для одной вкладки чата: создаёт сессию, гонит события в webview,
 * принимает команды webview. Этап 3: разрешения, вопросы и планы отклоняются заглушкой с записью
 * в журнал (карточки — этап 5).
 */
export class ChatController {
  private session: Promise<AgentSession> | undefined;
  private current: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private status: ChatStatus = 'idle';
  private title: string | undefined;
  private generation = 0;
  private editorContext: Extract<ToWebview, { type: 'editor.context' }> | undefined;
  private registeredId: string | undefined;

  constructor(private readonly deps: ChatDeps) {}

  /** Поднимает сессию; вызывать при открытии вкладки. */
  start(): void {
    void this.ensureSession();
  }

  /** Webview прислал `ready`: отдать ему всё, что накопилось до его готовности. */
  onReady(): void {
    const { deps } = this;
    deps.post({
      type: 'chat.info',
      project: deps.project,
      cwd: deps.cwd,
      allowBypass: deps.settings().allowBypass,
    });
    if (this.editorContext) deps.post(this.editorContext);
    void deps
      .listRecent()
      .then((sessions) => deps.post({ type: 'sessions.update', sessions }))
      .catch((e) => deps.log.warn(`список сессий не получен: ${String(e)}`));
    void this.ensureSession().then((s) => this.postCapabilities(s));
  }

  postEditorContext(ctx: Omit<Extract<ToWebview, { type: 'editor.context' }>, 'type'>): void {
    this.editorContext = { type: 'editor.context', ...ctx };
    this.deps.post(this.editorContext);
  }

  /** Новая сессия по команде (палитра, `/clear`): `notify` — сообщить webview, чтобы очистил ленту. */
  newSession(notify: boolean): void {
    this.teardown();
    this.status = 'idle';
    this.title = undefined;
    this.deps.setTitle(tabTitle(this.status, this.title));
    if (notify) this.deps.post({ type: 'session.reset' });
    void this.ensureSession().then((s) => this.postCapabilities(s));
  }

  dispose(): void {
    this.teardown();
  }

  async handle(m: FromWebview): Promise<void> {
    const { deps } = this;
    switch (m.type) {
      case 'ready':
        this.onReady();
        return;
      case 'session.new':
        this.newSession(false);
        return;
      case 'sessions.show':
        deps.showSessions();
        return;
      case 'session.resume':
        deps.log.info(`Возобновление сессии ${m.sessionId}: появится на этапе 6`);
        return;
      case 'diff.open':
        deps.log.info(`Diff для ${m.toolUseId}: появится на этапе 5`);
        return;
      case 'files.find':
        try {
          deps.post({
            type: 'files.result',
            requestId: m.requestId,
            items: await deps.findFiles(m.query),
          });
        } catch (e) {
          deps.log.warn(`поиск файлов: ${String(e)}`);
          deps.post({ type: 'files.result', requestId: m.requestId, items: [] });
        }
        return;
      case 'attach.pick': {
        const items = await deps.pickFiles();
        if (items.length) deps.post({ type: 'attach.picked', items });
        return;
      }
      case 'limits.refresh':
        return;
      default:
        break;
    }
    const session = await this.ensureSession();
    if (!session) return;
    try {
      switch (m.type) {
        case 'send': {
          const texts: Record<string, string> = {};
          for (const a of m.attachments ?? []) {
            if (a.kind !== 'selection') continue;
            const t = await deps.readSelection(a);
            if (t) texts[attachmentKey(a)] = t;
          }
          if (!session.send(buildPrompt(m.text, m.attachments ?? [], texts))) {
            deps.log.warn('send: сессия закрыта, сообщение не принято');
          }
          return;
        }
        case 'interrupt':
          await session.interrupt();
          return;
        case 'mode.set':
          await session.setMode(m.mode as PermissionMode);
          return;
        case 'model.set':
          await session.setModel(m.model);
          return;
        case 'effort.set':
          if (EFFORTS.includes(m.effort)) await session.setEffort(m.effort as EffortLevel);
          return;
        case 'compact':
          session.compact();
          return;
        case 'agent.stop':
          await session.stopTask(m.taskId);
          return;
        case 'permission.respond':
          session.respondPermission(m.toolUseId, m.decision);
          return;
        case 'question.answer':
          session.answerQuestion(m.toolUseId, m.answers);
          return;
        case 'plan.decide':
          session.decidePlan(
            m.toolUseId,
            m.approve ? { approve: true } : { approve: false, feedback: '' },
          );
          return;
        default:
          return;
      }
    } catch (e) {
      deps.log.error(`${m.type}: ${String(e)}`);
    }
  }

  private async postCapabilities(session: AgentSession | undefined): Promise<void> {
    if (!session) return;
    const caps = await session.capabilities();
    if (session !== this.current) return;
    this.deps.post({ type: 'capabilities', sessionId: session.id, ...caps });
  }

  private ensureSession(): Promise<AgentSession | undefined> {
    if (!this.session) {
      const gen = ++this.generation;
      const { deps } = this;
      const s = deps.settings();
      this.session = deps.adapter
        .createSession({
          cwd: deps.cwd,
          permissionMode: 'default',
          allowBypassPermissions: s.allowBypass,
          ...(s.defaultModel ? { model: s.defaultModel } : {}),
        })
        .then((session) => {
          if (gen !== this.generation) {
            session.dispose();
            return session;
          }
          this.current = session;
          this.unsubscribe = session.events.on((e) => this.onEvent(session, e));
          deps.log.info('Сессия агента создана');
          return session;
        });
      this.session.catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        deps.log.error(`сессия не создана: ${message}`);
        this.session = undefined;
        this.forward('', { type: 'error', message, fatal: true });
        this.forward('', { type: 'session.closed', reason: 'error', message });
      });
    }
    return this.session.catch(() => undefined);
  }

  private onEvent(session: AgentSession, e: AgentEvent): void {
    if (session !== this.current) return;
    this.forward(session.id, e);

    const prev = this.status;
    this.status = nextStatus(this.status, e);
    if (e.type === 'session.title' && !e.agentId) this.title = e.title;
    if (this.status !== prev || e.type === 'session.title') {
      this.deps.setTitle(tabTitle(this.status, this.title));
    }

    switch (e.type) {
      case 'permission.request':
      case 'question.request':
      case 'plan.request':
        // заглушка этапа 3: запрос в журнал и отказ, чтобы ход не завис
        this.deps.log.warn(`${e.type} (${'toolName' in e ? e.toolName : 'n/a'}): ${STUB_DENY}`);
        session.respondPermission(e.toolUseId, 'deny', STUB_DENY);
        break;
      case 'session.init':
        this.register(session.id);
        this.deps.log.info(`session.init: ${e.model}, режим ${e.permissionMode}`);
        break;
      case 'turn.result':
        this.deps.log.info(
          `ход завершён: ${e.ok ? 'ok' : 'ошибка'}, $${(e.costUsd ?? 0).toFixed(4)}, ${e.durationMs} мс`,
        );
        if (session.id) this.deps.live?.set(session.id, this.liveState(), e.totalCostUsd);
        break;
      case 'error':
        this.deps.log.warn(`error: ${e.message}`);
        break;
      case 'session.closed':
        this.deps.log.info(`session.closed: ${e.reason}${e.message ? ` — ${e.message}` : ''}`);
        if (this.registeredId) this.deps.live?.delete(this.registeredId);
        break;
      default:
        break;
    }
    if (this.status !== prev && session.id) this.deps.live?.set(session.id, this.liveState());
  }

  private liveState(): 'idle' | 'live' | 'waiting' | 'error' | 'limit' {
    switch (this.status) {
      case 'working':
        return 'live';
      case 'waiting':
        return 'waiting';
      case 'error':
        return 'error';
      case 'limited':
        return 'limit';
      case 'idle':
        return 'idle';
    }
  }

  private register(id: string): void {
    if (!id || this.registeredId === id) return;
    this.registeredId = id;
    this.deps.live?.set(id, this.liveState());
  }

  private forward(sessionId: string, event: AgentEvent): void {
    this.deps.post({ type: 'agent.event', sessionId, event });
  }

  private teardown(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.registeredId) this.deps.live?.delete(this.registeredId);
    this.registeredId = undefined;
    this.current?.dispose();
    this.current = undefined;
    this.session = undefined;
  }
}
