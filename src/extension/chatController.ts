import type {
  LimitWindow,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  EffortLevel,
  PermissionMode,
} from '../agent/types';
import {
  nextStatus,
  tabTitle,
  updateInTurn,
  updatePending,
  type ChatStatus,
} from '../agent/status';
import type { FromWebview, PlanChoice, SessionSummary, ToWebview } from '../protocol';
import { appliedSides, previewOf, proposedSides, type EditSides } from './editDiff';
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
  settings(): { defaultModel?: string; allowBypass: boolean; contextThresholds?: number[] };
  /** Лимиты подписки (этап 4): `refresh` ограничен кулдауном сервиса, ответ уходит в webview. */
  usage?: { refresh(): Promise<{ windows: LimitWindow[]; updatedAt: number; error?: string }> };
  /** Окна из `rate_limit_event` движка — запас для `LimitsSource`. */
  observeLimits?(windows: LimitWindow[]): void;
  findFiles(query: string): Promise<FileHit[]>;
  pickFiles(): Promise<FileHit[]>;
  /** Текст выделения для вложения `selection`. */
  readSelection(a: Attachment): Promise<string | undefined>;
  listRecent(): Promise<SessionSummary[]>;
  showSessions(): void;
  live?: LiveSessions;
  /** Текст файла с диска для превью правки; `undefined` — файла нет или не прочитан. */
  readText?(path: string): Promise<string | undefined>;
  /** Нативный дифф VS Code (`vscode.diff` над `agentura-diff:`). */
  openDiff?(d: OpenDiff): Promise<void>;
}

export interface OpenDiff {
  /** Ключ документов: одна правка на одной стадии — одни и те же `agentura-diff:` URI. */
  key: string;
  filePath: string;
  before: string;
  after: string;
  /** Правка ещё не применена (карточка разрешения) или уже в файле. */
  stage: 'proposed' | 'applied';
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Инструменты, у которых есть дифф правки. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
/** Сколько правок помнить для «diff» в ленте (стороны — файлы целиком). */
const MAX_EDITS = 50;

/** Текст модели при «Отклонить» план: ход останавливается (`interrupt`), режим plan остаётся. */
export const PLAN_REJECT_MESSAGE =
  'The user rejected this plan. Stop and wait for further instructions; do not start implementing.';
/** «Доработать план» с текстом из поля: текст пользователя после этой фразы. */
export const PLAN_REFINE_PREFIX = 'The user wants the plan revised before execution: ';
/** «Доработать план» с пустым полем. */
export const PLAN_REFINE_MESSAGE =
  'The user wants to refine the plan before execution. Ask what should change, then present an updated plan.';

/**
 * Владелец сессии агента для одной вкладки чата: создаёт сессию, гонит события в webview,
 * принимает команды webview. Этап 5: ответы карточек разрешения, вопроса и плана уходят в
 * сессию; правки агента запоминаются для нативного диффа (до и после применения).
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
  private sendQueue: Promise<void> = Promise.resolve();
  /** Запросы (разрешение, вопрос, план), ждущие ответа, — для `waiting` при нескольких сразу. */
  private pending: string[] = [];
  /** Идёт ход основного агента — куда вернуться после ответа на запрос субагента. */
  private inTurn = false;
  /** Правки для «открыть дифф» / «diff»: предложенные (карточка) и применённые (строка ленты). */
  private readonly edits = new Map<string, { sides: EditSides; stage: OpenDiff['stage'] }>();
  /** Вход Edit/Write по `toolUseId` до `tool.result` (в результате имени инструмента нет). */
  private readonly editInputs = new Map<string, { name: string; input: Record<string, unknown> }>();

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
      ...(deps.settings().contextThresholds?.length
        ? { contextThresholds: deps.settings().contextThresholds! }
        : {}),
    });
    void this.refreshLimits();
    if (this.editorContext) deps.post(this.editorContext);
    void deps
      .listRecent()
      .then((sessions) => deps.post({ type: 'sessions.update', sessions }))
      .catch((e) => deps.log.warn(`список сессий не получен: ${String(e)}`));
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch((e) => deps.log.warn(`возможности движка: ${String(e)}`));
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
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch((e) => this.deps.log.warn(`возможности движка: ${String(e)}`));
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
        await this.openDiff(m.toolUseId);
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
        await this.refreshLimits();
        return;
      default:
        break;
    }
    const session = await this.ensureSession();
    if (!session) return;
    try {
      switch (m.type) {
        case 'send': {
          // по очереди: сообщение с выделением (ждёт чтения файла) не обгоняется следующим
          const run = this.sendQueue.then(() => this.sendNow(session, m));
          this.sendQueue = run.catch(() => undefined);
          await run;
          return;
        }
        case 'interrupt':
          await session.interrupt();
          return;
        case 'mode.set':
          if (m.mode === 'bypassPermissions' && !deps.settings().allowBypass) {
            deps.log.warn(
              'mode.set bypassPermissions: выключено настройкой agentura.allowBypassPermissions',
            );
            return;
          }
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
        // Ответ на карточку: сессия та же, что прислала запрос, — иначе (после /clear) id не
        // найдётся в брокере новой сессии и ответ просто отбросится (`false` в журнал).
        case 'permission.respond':
          this.answered(m.type, session.respondPermission(m.toolUseId, m.decision));
          return;
        case 'question.answer':
          this.answered(m.type, session.answerQuestion(m.toolUseId, m.answers));
          return;
        case 'plan.decide':
          this.answered(
            m.type,
            session.decidePlan(m.toolUseId, planDecision(m.decision, m.feedback)),
          );
          return;
        default:
          return;
      }
    } catch (e) {
      deps.log.error(`${m.type}: ${String(e)}`);
    }
  }

  private answered(type: string, ok: boolean): void {
    if (!ok)
      this.deps.log.warn(`${type}: запрос уже закрыт или не из этой сессии — ответ отброшен`);
  }

  /** «открыть дифф» на карточке правки и «diff» в строке ленты. */
  private async openDiff(toolUseId: string): Promise<void> {
    const { deps } = this;
    const edit = this.edits.get(toolUseId);
    if (!edit) {
      deps.log.warn(`diff.open ${toolUseId}: правка не найдена (старая сессия или не Edit/Write)`);
      return;
    }
    if (!deps.openDiff) return;
    try {
      await deps.openDiff({
        key: `${toolUseId}-${edit.stage}`,
        filePath: edit.sides.filePath,
        before: edit.sides.before,
        after: edit.sides.after,
        stage: edit.stage,
      });
    } catch (e) {
      deps.log.error(`diff.open: ${String(e)}`);
    }
  }

  private remember(toolUseId: string, sides: EditSides, stage: OpenDiff['stage']): void {
    this.edits.delete(toolUseId);
    this.edits.set(toolUseId, { sides, stage });
    while (this.edits.size > MAX_EDITS) this.edits.delete(this.edits.keys().next().value!);
  }

  /** Превью правки к карточке разрешения: файл с диска → стороны → ханки вдогонку событию. */
  private async preparePreview(
    session: AgentSession,
    e: Extract<AgentEvent, { type: 'permission.request' }>,
  ): Promise<void> {
    const diff = e.diff;
    if (!diff) return;
    const text = await (this.deps.readText?.(diff.filePath) ?? Promise.resolve(undefined)).catch(
      () => undefined,
    );
    if (session !== this.current) return;
    const sides = proposedSides(diff, text);
    // результат мог прийти раньше чтения файла — применённая правка важнее предложенной
    if (this.edits.get(e.toolUseId)?.stage !== 'applied')
      this.remember(e.toolUseId, sides, 'proposed');
    this.deps.post({
      type: 'diff.preview',
      sessionId: session.id,
      toolUseId: e.toolUseId,
      preview: previewOf(sides),
    });
  }

  private async sendNow(
    session: AgentSession,
    m: Extract<FromWebview, { type: 'send' }>,
  ): Promise<void> {
    const { deps } = this;
    const texts: Record<string, string> = {};
    for (const a of m.attachments ?? []) {
      if (a.kind !== 'selection') continue;
      // файл закрыт/удалён — сообщение всё равно уходит, просто без текста выделения
      const t = await deps.readSelection(a).catch((e: unknown) => {
        deps.log.warn(`выделение ${a.path}: ${String(e)}`);
        return undefined;
      });
      if (t) texts[attachmentKey(a)] = t;
    }
    if (!session.send(buildPrompt(m.text, m.attachments ?? [], texts))) {
      deps.log.warn('send: сессия закрыта, сообщение не принято');
    }
  }

  /** Лимиты подписки → webview (`limits.update`). Не чаще кулдауна `UsageService`. */
  private async refreshLimits(): Promise<void> {
    const { usage, post } = this.deps;
    if (!usage) return;
    try {
      const snap = await usage.refresh();
      post({ type: 'limits.update', ...snap });
    } catch (e) {
      this.deps.log.warn(`лимиты для чата: ${String(e)}`);
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
        // сессию уже заменили (`/clear`, новая) — падение старой не касается ни новой, ни ленты
        if (gen !== this.generation) return;
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
    this.pending = updatePending(this.pending, e);
    this.inTurn = updateInTurn(this.inTurn, e);
    this.status = nextStatus(this.status, e, this.pending.length, this.inTurn);
    if (e.type === 'session.title' && !e.agentId) this.title = e.title;
    if (this.status !== prev || e.type === 'session.title') {
      this.deps.setTitle(tabTitle(this.status, this.title));
    }

    switch (e.type) {
      case 'permission.request':
        this.deps.log.info(`permission.request ${e.toolName}: ${e.description ?? ''}`);
        if (e.diff) void this.preparePreview(session, e);
        break;
      case 'question.request':
      case 'plan.request':
        this.deps.log.info(e.type);
        break;
      case 'tool.start':
        if (EDIT_TOOLS.has(e.name))
          this.editInputs.set(e.toolUseId, { name: e.name, input: e.input });
        break;
      case 'tool.result': {
        const call = this.editInputs.get(e.toolUseId);
        if (!call) break;
        this.editInputs.delete(e.toolUseId);
        const sides = e.isError ? undefined : appliedSides(call.name, call.input, e.result);
        if (sides) this.remember(e.toolUseId, sides, 'applied');
        break;
      }
      case 'session.init':
        this.register(session.id);
        this.deps.log.info(`session.init: ${e.model}, режим ${e.permissionMode}`);
        break;
      case 'turn.result':
        this.deps.log.info(
          `ход завершён: ${e.ok ? 'ok' : 'ошибка'}, $${(e.costUsd ?? 0).toFixed(4)}, ${e.durationMs} мс`,
        );
        if (session.id) this.deps.live?.set(session.id, this.liveState(), e.totalCostUsd);
        void this.refreshLimits();
        break;
      case 'limit.update':
        if (!e.agentId) {
          this.deps.observeLimits?.(e.windows);
          // упёрлись или близко — забрать точные проценты и время сброса
          if (e.status && e.status !== 'allowed') void this.refreshLimits();
        }
        break;
      case 'error':
        this.deps.log.warn(`error: ${e.message}`);
        break;
      case 'session.closed':
        this.deps.log.info(`session.closed: ${e.reason}${e.message ? ` — ${e.message}` : ''}`);
        if (this.registeredId) this.deps.live?.delete(this.registeredId);
        // закрытая сессия больше не «живая»: не возвращать её в список ниже
        this.registeredId = undefined;
        return;
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
    this.pending = [];
    this.inTurn = false;
    this.edits.clear();
    this.editInputs.clear();
  }
}

/** Кнопка карточки плана → решение сессии (семантика — docs/spikes/sdk-probe.md, раздел 9). */
export function planDecision(
  choice: PlanChoice,
  feedback?: string,
): Parameters<AgentSession['decidePlan']>[1] {
  switch (choice) {
    case 'run':
      return { approve: true, mode: 'default' };
    case 'run-edits':
      return { approve: true, mode: 'acceptEdits' };
    case 'refine': {
      const text = feedback?.trim();
      return {
        approve: false,
        feedback: text ? `${PLAN_REFINE_PREFIX}${text}` : PLAN_REFINE_MESSAGE,
      };
    }
    case 'reject':
      return { approve: false, feedback: PLAN_REJECT_MESSAGE, interrupt: true };
  }
}
