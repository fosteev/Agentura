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
import type { SessionHistory } from '../agent/types';
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
  /** Возобновить эту сессию сразу (вкладка восстановлена сериализатором или открыта из списка). */
  resumeId?: string;
  /** Клик по сессии в попапе или на экране empty: вкладку выбирает менеджер вкладок. */
  openSession?(id: string): void;
  /** Название сессии по id (строка списка) — заголовок вкладки и webview после `resume`. */
  titleOf?(id: string): Promise<string | undefined>;
  /** Вкладка сменила сессию (`undefined` — пока нет): реестр открытых сессий и строка `cur` списка. */
  onSession?(id: string | undefined): void;
  /** Версия движка из `session.init` — секция «Аккаунт» боковой панели. */
  onEngineVersion?(version: string): void;
  /** Показать канал журнала расширения (карточка ошибки, этап 7). */
  showLogs?(): void;
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
  /** Возобновляемая сессия: `ensureSession` зовёт `resumeSession`, а не `createSession`. */
  private resumeId: string | undefined;
  private resumeToken = 0;
  /** Идёт чтение истории для `resume`: до его конца сессию движка не поднимаем (нужны модель и режим). */
  private loading: Promise<void> | undefined;
  /** История возобновлённой сессии и то, с чем её продолжать (модель, режим, база стоимости). */
  private resumed: { history: SessionHistory; title?: string } | undefined;
  /** Кто-то уже писал в сессию или сессия возобновлена: вкладка не «пустая» (`pristine`). */
  private touched = false;
  /** Webview прислал `ready` столько раз: второй и дальше — webview пересоздан, ленту надо пересеять. */
  private readyCount = 0;
  /** История ждёт `ready` (вкладка восстановлена до готовности webview). */
  private seedPending = false;
  /** Команда боковой панели, пришедшая до готовности webview. */
  private queuedCommand: 'status' | undefined;
  // Снимок для пересева: то, что webview пропустил бы, окажись он пересоздан при живом хосте.
  private lastInit: Extract<AgentEvent, { type: 'session.init' }> | undefined;
  private lastContext: Extract<AgentEvent, { type: 'context.usage' }> | undefined;
  private turnStartedAt: number | undefined;
  private readonly pendingRequests = new Map<string, AgentEvent>();
  private readonly previews = new Map<string, Extract<ToWebview, { type: 'diff.preview' }>>();
  /** Вкладка закрыта или расширение выгружается: никаких новых процессов движка после этого. */
  private disposed = false;
  /**
   * Последний известный id сессии вкладки. `sessionId` после `session.closed` у новой сессии пуст
   * (`registeredId` снят), а «Повторить ход» должен знать, какую сессию возобновлять (этап 7).
   */
  private lastSessionId: string | undefined;
  /** Последний отправленный и ещё не завершённый успешно промпт: его повторяет «Повторить ход». */
  private inflight: Extract<FromWebview, { type: 'send' }> | undefined;
  /** Сессия, помеченная в списке как `error`/`limit` после закрытия: снять при возобновлении. */
  private stickyLive: string | undefined;
  /** Журнал с префиксом — первые 8 символов id сессии: канал один на окно, вкладок несколько. */
  private readonly log: ChatDeps['log'];

  constructor(private readonly deps: ChatDeps) {
    this.resumeId = deps.resumeId;
    this.lastSessionId = deps.resumeId;
    const tag = (m: string) => `[${this.logTag()}] ${m}`;
    this.log = {
      debug: (m) => deps.log.debug(tag(m)),
      info: (m) => deps.log.info(tag(m)),
      warn: (m) => deps.log.warn(tag(m)),
      error: (m) => deps.log.error(tag(m)),
    };
  }

  private logTag(): string {
    const id = this.sessionId ?? this.lastSessionId;
    return id ? id.slice(0, 8) : 'новая';
  }

  /** Id сессии вкладки: живой или возобновляемой; нет — новая ещё не стартовала. */
  get sessionId(): string | undefined {
    return this.registeredId ?? this.resumeId;
  }

  /** Вкладка не тронута: новая сессия без сообщений — её можно занять под другую сессию. */
  get pristine(): boolean {
    return !this.touched && this.resumeId === undefined;
  }

  /** Поднимает сессию; вызывать при открытии вкладки. */
  start(engine = true): void {
    if (this.resumeId) void this.resume(this.resumeId, engine);
    else if (engine) void this.ensureSession();
  }

  /** Вкладка, история которой уже прочитана, стала видимой: поднять движок. */
  wake(): void {
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch((e) => this.log.warn(`возможности движка: ${String(e)}`));
  }

  /**
   * Возобновить сессию `id` в этой вкладке: история из транскрипта → лента, движок — `resume`.
   * Нет транскрипта — вкладка остаётся с новой сессией, причина в журнале.
   */
  resume(id: string, engine = true): Promise<void> {
    const run = this.doResume(id, engine);
    this.loading = run;
    return run.finally(() => {
      if (this.loading === run) this.loading = undefined;
    });
  }

  private async doResume(id: string, engine: boolean): Promise<void> {
    const { deps } = this;
    this.teardown();
    const token = ++this.resumeToken;
    this.resumeId = id;
    this.lastSessionId = id;
    // другая сессия во вкладке — её неотвеченный промпт сюда не относится (кроме «Повторить ход»)
    if (!this.retrying) this.inflight = undefined;
    this.resumed = undefined;
    this.status = 'idle';
    this.touched = true;
    let history: SessionHistory;
    try {
      history = await deps.adapter.loadHistory(id, deps.cwd);
    } catch (e) {
      if (token !== this.resumeToken) return;
      this.log.warn(`история сессии ${id} не прочитана: ${String(e)}`);
      this.resumeId = undefined;
      this.resumed = undefined;
      this.touched = false;
      this.title = undefined;
      deps.setTitle(tabTitle(this.status, this.title));
      deps.post({ type: 'session.reset' });
      deps.onSession?.(undefined);
      this.loading = undefined;
      void this.ensureSession()
        .then((s) => this.postCapabilities(s))
        .catch(() => undefined);
      return;
    }
    const title = await (deps.titleOf?.(id) ?? Promise.resolve(undefined)).catch(() => undefined);
    // пока читали, вкладку успели переключить (другой resume, /clear) — эта история уже не нужна
    if (token !== this.resumeToken) return;
    this.resumed = { history, ...(title ? { title } : {}) };
    this.title = title;
    deps.setTitle(tabTitle(this.status, this.title));
    deps.onSession?.(id);
    for (const e of history.events) this.trackEdit(e);
    // webview уже прислал `ready`, пока читали историю, — шлём сразу; иначе она уйдёт на его `ready`
    if (this.readyCount > 0) this.postHistory();
    else this.seedPending = true;
    this.loading = undefined;
    // фоновая вкладка после перезагрузки: процесс — когда её откроют (`ready` → `ensureSession`)
    if (!engine) return;
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch((e) => this.log.warn(`возможности движка: ${String(e)}`));
  }

  /** `session.history` для webview: события без тяжёлых результатов (файлы целиком остались у хоста). */
  private postHistory(history = this.resumed?.history, title = this.resumed?.title): void {
    const id = this.sessionId;
    if (!history || !id) return;
    this.seedPending = false;
    this.deps.post({
      type: 'session.history',
      sessionId: id,
      events: slimHistory(history.events),
      skippedTurns: history.skippedTurns,
      ...(title ? { title } : {}),
      ...(history.model ? { model: history.model } : {}),
      ...(history.mode ? { mode: history.mode } : {}),
    });
  }

  /**
   * Webview пересоздан при живом хосте (панель перенесена в окно, «Reload Webviews»): лента пуста, а
   * брокер всё ещё ждёт ответов. История — из транскрипта, затем то, чего в нём нет: `init`, контекст
   * движка, ждущие запросы разрешений с превью диффа, идущий ход.
   */
  private async reseed(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    let history = this.resumed?.history;
    if (!this.seedPending || !history) {
      try {
        history = await this.deps.adapter.loadHistory(id, this.deps.cwd, { live: this.inTurn });
      } catch (e) {
        // новая сессия без единого сообщения: транскрипта ещё нет — пересеивать нечего, кроме снимка
        this.log.debug(`пересев: история ${id}: ${String(e)}`);
        history = undefined;
      }
    }
    if (this.disposed) return;
    if (history) this.postHistory(history, this.resumed?.title ?? this.title);
    else this.deps.post({ type: 'session.reset' });
    if (this.lastInit) this.forward(id, this.lastInit);
    if (this.lastContext) this.forward(id, this.lastContext);
    if (this.title) this.forward(id, { type: 'session.title', title: this.title });
    if (this.inTurn && this.turnStartedAt !== undefined) {
      this.forward(id, { type: 'turn.start', at: this.turnStartedAt });
    }
    for (const e of this.pendingRequests.values()) this.forward(id, e);
    for (const p of this.previews.values()) this.deps.post(p);
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch(() => undefined);
  }

  /** Команда из боковой панели (`/status`): выполнить во вкладке, когда webview готов. */
  runCommand(name: 'status'): void {
    if (this.readyCount > 0) this.deps.post({ type: 'chat.command', name });
    else this.queuedCommand = name;
  }

  /** Название сессии сменили снаружи (переименование в списке). */
  setTitle(title: string): void {
    const id = this.sessionId;
    this.title = title;
    if (this.resumed) this.resumed = { ...this.resumed, title };
    this.deps.setTitle(tabTitle(this.status, this.title));
    if (id) this.forward(id, { type: 'session.title', title });
  }

  /** Webview прислал `ready`: отдать ему всё, что накопилось до его готовности. */
  onReady(): void {
    const { deps } = this;
    this.readyCount++;
    const reseed = this.seedPending || this.readyCount > 1;
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
      .then((sessions) =>
        deps.post({
          type: 'sessions.update',
          sessions,
          ...(this.sessionId ? { current: this.sessionId } : {}),
        }),
      )
      .catch((e) => this.log.warn(`список сессий не получен: ${String(e)}`));
    if (reseed) void this.reseed();
    else
      void this.ensureSession()
        .then((s) => this.postCapabilities(s))
        .catch((e) => this.log.warn(`возможности движка: ${String(e)}`));
    if (this.queuedCommand) {
      deps.post({ type: 'chat.command', name: this.queuedCommand });
      this.queuedCommand = undefined;
    }
  }

  postEditorContext(ctx: Omit<Extract<ToWebview, { type: 'editor.context' }>, 'type'>): void {
    this.editorContext = { type: 'editor.context', ...ctx };
    this.deps.post(this.editorContext);
  }

  /** Новая сессия по команде (палитра, `/clear`): `notify` — сообщить webview, чтобы очистил ленту. */
  newSession(notify: boolean): void {
    this.teardown();
    this.resumeToken++;
    this.resumeId = undefined;
    this.lastSessionId = undefined;
    // «Повторить ход» уже начатой новой сессии (retry без id) сохраняет промпт: его сбрасывает только человек
    if (!this.retrying) this.inflight = undefined;
    this.resumed = undefined;
    this.seedPending = false;
    this.touched = false;
    this.deps.onSession?.(undefined);
    this.status = 'idle';
    this.title = undefined;
    this.deps.setTitle(tabTitle(this.status, this.title));
    if (notify) this.deps.post({ type: 'session.reset' });
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch((e) => this.log.warn(`возможности движка: ${String(e)}`));
  }

  dispose(): void {
    this.disposed = true;
    // хвосты `doResume` после `await` сверяют токен — без этого они подняли бы движок уже закрытой вкладки
    this.resumeToken++;
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
        // какую вкладку занять — решает менеджер вкладок (та же, открытая или новая)
        if (deps.openSession) deps.openSession(m.sessionId);
        else await this.resume(m.sessionId);
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
          this.log.warn(`поиск файлов: ${String(e)}`);
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
      case 'log.show':
        deps.showLogs?.();
        return;
      case 'turn.retry':
        await this.retry(m.turn);
        return;
      default:
        break;
    }
    const session = await this.ensureSession();
    if (!session) return;
    try {
      switch (m.type) {
        case 'send': {
          this.touched = true;
          this.inflight = m;
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
            this.log.warn(
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
      this.log.error(`${m.type}: ${String(e)}`);
    }
  }

  private retrying = false;

  /**
   * «Повторить ход» (карточка ошибки): сессия возобновляется (`resume`: движок поднимается заново, лента
   * пересобирается из транскрипта), затем уходит тот же промпт, если ход был оборван. Без промпта
   * (ошибка между ходами) — просто возобновление. Новая сессия, не дожившая до `session.init`, —
   * заново с тем же промптом.
   */
  private async retry(withPrompt: boolean): Promise<void> {
    if (this.retrying || this.disposed) return;
    // идёт ход (кнопка на устаревшей карточке): `resume` убил бы процесс посреди него и повторил промпт
    if (this.inTurn) {
      this.log.warn('повтор хода: идёт ход — повтор пропущен');
      return;
    }
    this.retrying = true;
    try {
      // промпт — только если карточка видела оборванный ход: иначе ушёл бы промпт давно законченного
      // неудачного хода (`turn.result ok:false` не сбрасывает `inflight`)
      const prompt = withPrompt ? this.inflight : undefined;
      const id = this.lastSessionId;
      this.log.info(
        `повтор хода: ${id ? `resume ${id}` : 'новая сессия'}${prompt ? ', промпт будет отправлен снова' : ', без промпта'}`,
      );
      if (id) await this.resume(id);
      else this.newSession(true);
      if (!prompt) return;
      const session = await this.ensureSession();
      if (!session) return;
      this.touched = true;
      this.inflight = prompt;
      const run = this.sendQueue.then(() => this.sendNow(session, prompt));
      this.sendQueue = run.catch(() => undefined);
      await run;
    } finally {
      this.retrying = false;
    }
  }

  private answered(type: string, ok: boolean): void {
    if (!ok) this.log.warn(`${type}: запрос уже закрыт или не из этой сессии — ответ отброшен`);
  }

  /** «открыть дифф» на карточке правки и «diff» в строке ленты. */
  private async openDiff(toolUseId: string): Promise<void> {
    const { deps } = this;
    const edit = this.edits.get(toolUseId);
    if (!edit) {
      this.log.warn(`diff.open ${toolUseId}: правка не найдена (старая сессия или не Edit/Write)`);
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
      this.log.error(`diff.open: ${String(e)}`);
    }
  }

  /**
   * Правки Edit/Write для «diff»: вход на `tool.start`, стороны — на `tool.result`. Те же события,
   * что у живой сессии, идут и из восстановленной истории — иначе `diff` в ней не нашёл бы правку.
   */
  private trackEdit(e: AgentEvent): void {
    if (e.type === 'tool.start') {
      if (EDIT_TOOLS.has(e.name))
        this.editInputs.set(e.toolUseId, { name: e.name, input: e.input });
    } else if (e.type === 'tool.result') {
      const call = this.editInputs.get(e.toolUseId);
      if (!call) return;
      this.editInputs.delete(e.toolUseId);
      const sides = e.isError ? undefined : appliedSides(call.name, call.input, e.result);
      if (sides) this.remember(e.toolUseId, sides, 'applied');
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
    const msg = {
      type: 'diff.preview' as const,
      sessionId: session.id,
      toolUseId: e.toolUseId,
      preview: previewOf(sides),
    };
    // запрос уже закрыт, пока читали файл, — превью хранить незачем (пересев отдаст только ждущие)
    if (this.pendingRequests.has(e.toolUseId)) this.previews.set(e.toolUseId, msg);
    this.deps.post(msg);
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
        this.log.warn(`выделение ${a.path}: ${String(e)}`);
        return undefined;
      });
      if (t) texts[attachmentKey(a)] = t;
    }
    if (!session.send(buildPrompt(m.text, m.attachments ?? [], texts))) {
      this.log.warn('send: сессия закрыта, сообщение не принято');
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
      this.log.warn(`лимиты для чата: ${String(e)}`);
    }
  }

  private async postCapabilities(session: AgentSession | undefined): Promise<void> {
    if (!session) return;
    const caps = await session.capabilities();
    if (session !== this.current) return;
    this.deps.post({ type: 'capabilities', sessionId: session.id, ...caps });
  }

  private ensureSession(): Promise<AgentSession | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (this.loading) return this.loading.then(() => this.ensureSession());
    if (!this.session) {
      const gen = ++this.generation;
      const { deps } = this;
      const s = deps.settings();
      const resume = this.resumeId;
      const base = {
        cwd: deps.cwd,
        allowBypassPermissions: s.allowBypass,
      };
      const opened = resume
        ? (() => {
            const h = this.resumed?.history;
            // режим и модель — с конца сессии: движок при `resume` берёт их из опций, а не из записи
            const mode =
              h?.mode === 'bypassPermissions' && !s.allowBypass
                ? 'default'
                : (h?.mode ?? 'default');
            const model = h?.model ?? s.defaultModel;
            // база = то, с чего движок сам продолжит `total_cost_usd`: он восстанавливает итог из записи
            // `cost-state` транскрипта (нет записи — с нуля). Любая другая база (память расширения)
            // занизила бы стоимость первого хода после `resume` (`turn.result.costUsd = итог − база`)
            const baseline = h?.totalCostUsd ?? 0;
            return deps.adapter.resumeSession(resume, {
              ...base,
              permissionMode: mode,
              ...(model ? { model } : {}),
              baselineCostUsd: baseline,
            });
          })()
        : deps.adapter.createSession({
            ...base,
            permissionMode: 'default',
            ...(s.defaultModel ? { model: s.defaultModel } : {}),
          });
      this.session = opened.then((session) => {
        if (gen !== this.generation) {
          session.dispose();
          return session;
        }
        this.current = session;
        this.unsubscribe = session.events.on((e) => this.onEvent(session, e));
        this.log.info('Сессия агента создана');
        return session;
      });
      this.session.catch((e: unknown) => {
        // сессию уже заменили (`/clear`, новая) — падение старой не касается ни новой, ни ленты
        if (gen !== this.generation) return;
        const message = e instanceof Error ? e.message : String(e);
        this.log.error(`сессия не создана: ${message}`);
        this.session = undefined;
        this.forward('', { type: 'error', message, fatal: true });
        this.forward('', { type: 'session.closed', reason: 'error', message });
        this.status = 'error';
        deps.setTitle(tabTitle(this.status, this.title));
      });
    }
    return this.session.catch(() => undefined);
  }

  private onEvent(session: AgentSession, e: AgentEvent): void {
    if (session !== this.current) return;
    if (e.type === 'session.init' && session.id) this.lastSessionId = session.id;
    this.log.debug(`← ${describeEvent(e)}`);
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
        this.log.info(`permission.request ${e.toolName}: ${e.description ?? ''}`);
        this.pendingRequests.set(e.toolUseId, e);
        if (e.diff) void this.preparePreview(session, e);
        break;
      case 'question.request':
      case 'plan.request':
        this.log.info(e.type);
        this.pendingRequests.set(e.toolUseId, e);
        break;
      case 'permission.resolved':
        this.pendingRequests.delete(e.toolUseId);
        this.previews.delete(e.toolUseId);
        break;
      case 'turn.start':
        if (!e.agentId) this.turnStartedAt = e.at;
        break;
      case 'tool.start':
      case 'tool.result':
        this.trackEdit(e);
        break;
      case 'session.init':
        this.register(session.id);
        this.lastSessionId = session.id || this.lastSessionId;
        this.lastInit = e;
        this.deps.onEngineVersion?.(e.engineVersion);
        this.log.info(`session.init: ${e.model}, режим ${e.permissionMode}`);
        break;
      case 'context.usage':
        if (e.source === 'engine' && !e.agentId) this.lastContext = e;
        break;
      case 'turn.result':
        // успешный (или остановленный человеком) ход закрыт — повторять нечего
        if (!e.agentId && (e.ok || e.interrupted)) this.inflight = undefined;
        this.log.info(
          `ход завершён: ${e.ok ? 'ok' : 'ошибка'}, $${(e.costUsd ?? 0).toFixed(4)}, ${e.durationMs} мс`,
        );
        if (session.id) {
          this.deps.live?.set(session.id, this.liveState(), e.totalCostUsd);
        }
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
        if (e.fatal) this.log.error(`error (fatal): ${e.message}`);
        else if (e.code === 'api_retry') this.log.info(`error: ${e.message}`);
        else this.log.warn(`error${e.code ? ` ${e.code}` : ''}: ${e.message}`);
        break;
      case 'session.closed': {
        const text = `session.closed: ${e.reason}${e.message ? ` — ${e.message}` : ''}`;
        if (e.reason === 'error') this.log.error(text);
        else this.log.info(text);
        if (this.registeredId) this.deps.live?.delete(this.registeredId);
        // закрытая сессия больше не «живая», но упавшая или упёршаяся в лимит остаётся в списке
        // строкой `err`/`limit` — до «Повторить ход», возобновления или закрытия вкладки
        const id = session.id || this.registeredId;
        if (id && (this.status === 'error' || this.status === 'limited')) {
          this.deps.live?.set(id, this.liveState());
          this.stickyLive = id;
        }
        this.registeredId = undefined;
        return;
      }
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
    this.deps.onSession?.(id);
  }

  private forward(sessionId: string, event: AgentEvent): void {
    this.deps.post({ type: 'agent.event', sessionId, event });
  }

  private teardown(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.registeredId) this.deps.live?.delete(this.registeredId);
    if (this.stickyLive) this.deps.live?.delete(this.stickyLive);
    this.stickyLive = undefined;
    this.registeredId = undefined;
    this.current?.dispose();
    this.current = undefined;
    this.session = undefined;
    this.pending = [];
    this.inTurn = false;
    this.edits.clear();
    this.editInputs.clear();
    this.lastInit = undefined;
    this.lastContext = undefined;
    this.turnStartedAt = undefined;
    this.pendingRequests.clear();
    this.previews.clear();
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

/**
 * События истории для webview без тяжёлого: у правок `originalFile` и `content` (файлы целиком)
 * остаются у хоста для «diff» — ленте хватает `structuredPatch` для счётчиков `+N −M`.
 */
export function slimHistory(events: readonly AgentEvent[]): AgentEvent[] {
  return events.map((e) => {
    if (e.type !== 'tool.result' || typeof e.result !== 'object' || e.result === null) return e;
    const r = e.result as Record<string, unknown>;
    if (!('originalFile' in r) && !('structuredPatch' in r)) return e;
    const { originalFile: _o, content: _c, ...rest } = r;
    void _o;
    void _c;
    return { ...e, result: rest };
  });
}

/** Одна строка журнала на событие адаптера (уровень debug): тип и ключевые поля, без текстов и результатов. */
export function describeEvent(e: AgentEvent): string {
  const who = e.agentId ? ` [агент ${e.agentId.slice(0, 8)}]` : '';
  let extra = '';
  switch (e.type) {
    case 'text.delta':
    case 'thinking.delta':
      extra = `${e.text.length} симв.`;
      break;
    case 'tool.start':
    case 'tool.progress':
      extra = e.name;
      break;
    case 'tool.result':
      extra = `${e.toolUseId.slice(-6)} ${e.isError ? 'ошибка' : 'ok'}`;
      break;
    case 'permission.request':
      extra = e.toolName;
      break;
    case 'permission.resolved':
      extra = `${e.decision} (${e.by})`;
      break;
    case 'context.usage':
      extra = `${e.usedTokens}${e.maxTokens ? `/${e.maxTokens}` : ''} (${e.source})`;
      break;
    case 'turn.result':
      extra = `${e.ok ? 'ok' : 'ошибка'} ${e.subtype}${e.interrupted ? ' interrupted' : ''}`;
      break;
    case 'limit.update':
      extra =
        `${e.source} ${e.status ?? ''} ${e.windows.map((w) => `${w.kind} ${w.percent}%`).join(', ')}`.trim();
      break;
    case 'error':
      extra = `${e.code ?? ''}${e.fatal ? ' fatal' : ''} ${e.message}`.trim();
      break;
    case 'session.closed':
      extra = `${e.reason}${e.message ? ` ${e.message}` : ''}`;
      break;
    case 'compaction.end':
      extra = e.ok ? `${e.preTokens ?? '?'} → ${e.postTokens ?? '?'}` : `ошибка ${e.error ?? ''}`;
      break;
    case 'mode.changed':
      extra = e.mode;
      break;
    default:
      break;
  }
  return `${e.type}${who}${extra ? ` ${extra}` : ''}`;
}
