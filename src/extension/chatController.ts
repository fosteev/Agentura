import { isAbsolute } from 'node:path';
import { resolveFrom } from './pathKey';
import type {
  LimitWindow,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  EffortLevel,
  PermissionMode,
  RetryPoint,
} from '../agent/types';
import {
  nextStatus,
  tabTitle,
  updateInTurn,
  updatePending,
  type ChatStatus,
} from '../agent/status';
import type {
  FromWebview,
  PickedFile,
  PickedImage,
  PlanChoice,
  SessionSummary,
  ToWebview,
} from '../protocol';
import { ENGINE_MISSING_CODE } from '../protocol';
import type {
  FileKind,
  ImageMediaType,
  PromptFile,
  PromptImage,
  SessionHistory,
} from '../agent/types';
import { hostImage, imageTokens, MAX_IMAGES_PER_MESSAGE } from '../shared/images';
import {
  attachFileTokens,
  attachTokenBudget,
  hostFile,
  MAX_FILES_PER_MESSAGE,
  MAX_MESSAGE_ATTACH_CHARS,
  sessionPdfPages,
  sessionProblem,
  type SessionAttach,
} from '../shared/files';
import { resolveDefaultEffort, resolveDefaultMode, type AgentsView, type FeedStyle } from '../settings';
import { hostStrings, type Lang } from '../shared/l10n';
import { appliedSides, previewOf, proposedSides, type EditSides } from './editDiff';
import {
  buildPrompt,
  attachmentKey,
  splitPrompt,
  type Attachment,
  type FileHit,
} from '../shared/prompt';
import type { LiveSessions } from '../data/sessions';
import { mergeReplay, StreamTail } from './reseedReplay';

/** Всё, что контроллеру нужно от VS Code, — через этот интерфейс: сам контроллер vscode не импортирует. */
class EngineMissingError extends Error {}

export interface ChatDeps {
  /** Язык текстов для пользователя; по умолчанию русский. */
  lang?: Lang;
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
  settings(): {
    defaultModel?: string;
    allowBypass: boolean;
    contextThresholds?: number[];
    /** `agentura.feed.style`: вид ленты, уходит в `chat.info`. */
    feedStyle?: FeedStyle | undefined;
    /** `agentura.agents.view`: вид вкладки «агенты», уходит в `chat.info`. */
    agentsView?: AgentsView | undefined;
    /** `agentura.defaultPermissionMode` как в настройке (`manual` | …): применяется к новым сессиям. */
    defaultPermissionMode?: string | undefined;
    /** `agentura.defaultEffort` (пусто — выбор движка): применяется к новым сессиям. */
    defaultEffort?: string | undefined;
  };
  /** Лимиты подписки (этап 4): `refresh` ограничен кулдауном сервиса, ответ уходит в webview. */
  usage?: { refresh(): Promise<{ windows: LimitWindow[]; updatedAt: number; error?: string }> };
  /** Окна из `rate_limit_event` движка — запас для `LimitsSource`. */
  observeLimits?(windows: LimitWindow[]): void;
  findFiles(query: string): Promise<FileHit[]>;
  pickFiles(): Promise<FileHit[]>;
  /**
   * «Изображение или файл…» в «+» (этапы 4 и 8 roadmap 0.2): диалог выбора без фильтра; картинки
   * base64, текст и pdf — содержимым или причиной отказа.
   */
  pickAttachments?(): Promise<{ images: PickedImage[]; files: PickedFile[] }>;
  /** Перетаскивание из проводника VS Code (этап 8): прочитать файлы по uri (`workspace.fs`). */
  readUris?(
    uris: string[],
  ): Promise<{ images: PickedImage[]; files: PickedFile[]; folders?: FileHit[] }>;
  /** Картинка во вкладке редактора: временный файл в storage расширения. */
  openImage?(image: { mediaType: ImageMediaType; data: string }): Promise<void>;
  /**
   * Чип файла в ленте (этап 8): путь относительно рабочей папки — сам файл, иначе копия из `data`
   * (без неё — исходный файл, если есть).
   */
  openFile?(file: { kind: FileKind; path: string; data?: string }): Promise<void>;
  /** Текст выделения для вложения `selection`. */
  readSelection(a: Attachment): Promise<string | undefined>;
  listRecent(): Promise<SessionSummary[]>;
  showSessions(): void;
  live?: LiveSessions;
  /** Текст файла с диска для превью правки; `undefined` — файла нет или не прочитан. */
  readText?(path: string): Promise<string | undefined>;
  /**
   * Сохранить несохранённые изменения файла в редакторе. Зовётся, когда человек разрешил правку:
   * движок правит диск, и иначе правка разошлась бы с тем, что видит человек.
   */
  saveFile?(path: string): Promise<void>;
  /** Нативный дифф VS Code (`vscode.diff` над `agentura-diff:`). */
  openDiff?(d: OpenDiff): Promise<void>;
  /** Мульти-дифф нескольких файлов (`vscode.changes`): заголовок и по паре сторон на файл. */
  openChanges?(title: string, files: OpenDiff[]): Promise<void>;
  /** Текст документом только для чтения (транскрипт субагента, этап 2 roadmap 0.2). */
  openText?(d: { key: string; name: string; text: string }): Promise<void>;
  /** Превью `.html` в соседней вкладке (абсолютный путь). */
  openPreview?(path: string): Promise<void>;
  /** Открыть ссылку в браузере (только https://claude.ai/). */
  openExternal?(url: string): void;
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
  /**
   * Готов ли `claude` (поиск асинхронный, прогрев при активации). Не готов — движок не запускается, в ленте
   * карточка с инструкцией. Нет поля — проверки нет (тесты, свой бинарник SDK).
   */
  engine?: { ready(): Promise<{ ok: true } | { ok: false; problem: string }> };
  /** Карточка «claude не найден» и `settings.open`: вкладка настроек (`agentura.openSettings`). */
  openSettings?(): void;
  /** Граф агентов во вкладке редактора (roadmap 11, этап 2): открыть или показать, выбрать агента. */
  openGraph?(agentId?: string): void;
  /** Снимок карты агентов от webview чата — в его вкладку графа (если она открыта). */
  graphSnapshot?(m: Extract<FromWebview, { type: 'agents.snapshot' }>): void;
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
  /** Файл каждой применённой правки за сессию — для «изменений»; без вытеснения (`MAX_EDITS` — только стороны). */
  private readonly editFiles = new Map<string, string>();
  /**
   * По файлу — стороны первой и последней целых применённых правок сессии (одна копия на файл): дифф «изменений»
   * за сессию верен и в длинной сессии, где ранние правки уже вытеснены из `edits`.
   */
  private readonly fileSpans = new Map<
    string,
    { firstId: string; before: string; lastId: string; after: string }
  >();
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
  /** Сведения о воркспейсе и настройках для webview: на `ready` и при смене `agentura.*` (без переоткрытия). */
  pushInfo(): void {
    const { deps } = this;
    const s = deps.settings();
    deps.post({
      type: 'chat.info',
      project: deps.project,
      cwd: deps.cwd,
      allowBypass: s.allowBypass,
      ...(s.contextThresholds?.length ? { contextThresholds: s.contextThresholds } : {}),
      ...(s.feedStyle ? { feedStyle: s.feedStyle } : {}),
      ...(s.agentsView ? { agentsView: s.agentsView } : {}),
    });
  }

  /** Webview прислал `ready` столько раз: второй и дальше — webview пересоздан, ленту надо пересеять. */
  private readyCount = 0;
  /** История ждёт `ready` (вкладка восстановлена до готовности webview). */
  private seedPending = false;
  /** Пересев читает транскрипт: события движка копятся здесь и доигрываются после `session.history`. */
  private reseedBuffer: { sessionId: string; event: AgentEvent }[] | undefined;
  /** Дельты ответа, который ещё пишется (его нет в транскрипте) — для пересева. */
  private readonly streamTail = new StreamTail();
  /** Счётчик `teardown()`: пересев, начатый до смены сессии во вкладке, ничего не шлёт. */
  private teardowns = 0;
  /** Номер последнего пересева: два подряд (двойной «Reload Webviews») — шлёт только последний. */
  private reseedSeq = 0;
  /** Команда боковой панели, пришедшая до готовности webview. */
  private queuedCommand: 'status' | undefined;
  // Снимок для пересева: то, что webview пропустил бы, окажись он пересоздан при живом хосте.
  private lastInit: Extract<AgentEvent, { type: 'session.init' }> | undefined;
  /** Режим и effort новой сессии из настроек: webview получает их снова, если готов позже создания сессии. */
  private defaults: Extract<ToWebview, { type: 'session.defaults' }> | undefined;
  private lastContext: Extract<AgentEvent, { type: 'context.usage' }> | undefined;
  private turnStartedAt: number | undefined;
  /** С прошлого итога приходил `turn.start` — иначе итог закрывает самое старое сообщение очереди. */
  private turnSeen = false;
  private readonly pendingRequests = new Map<string, AgentEvent>();
  private readonly previews = new Map<string, Extract<ToWebview, { type: 'diff.preview' }>>();
  /** Вкладка закрыта или расширение выгружается: никаких новых процессов движка после этого. */
  private disposed = false;
  /**
   * Последний известный id сессии вкладки. `sessionId` после `session.closed` у новой сессии пуст
   * (`registeredId` снят), а «Повторить ход» должен знать, какую сессию возобновлять (этап 7).
   */
  private lastSessionId: string | undefined;
  /**
   * Отправленные и ещё не завершённые успешно промпты по порядку (очередь, а не один — сообщение,
   * отправленное во время хода, ждёт своего): их повторяет «Повторить ход». `started` — движок начал
   * ход с этим сообщением (`turn.start`/`turn.input`); успешный итог снимает такие.
   */
  private inflight: { m: Extract<FromWebview, { type: 'send' }>; started: boolean }[] = [];
  /**
   * Вложения в истории сессии с последней компакции: страницы pdf и символы base64/текста. Лимиты API
   * — на запрос, а CLI шлёт всю историю с её `image`/`document`-блоками (живой прогон этапа 6).
   */
  private attached: SessionAttach = { pdfPages: 0, chars: 0 };
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
    if (!this.retrying) {
      this.inflight = [];
      this.dropRefused = false;
      this.retryAgain = false;
    }
    this.resumed = undefined;
    this.status = 'idle';
    this.touched = true;
    let history: SessionHistory;
    try {
      // оборванный ход «Повторить» отбросит — в ленте его промпта до повтора быть не должно
      history = this.retryDrop
        ? await deps.adapter.loadHistory(id, deps.cwd, { stopBefore: this.retryDrop.promptUuid })
        : await deps.adapter.loadHistory(id, deps.cwd);
    } catch (e) {
      if (token !== this.resumeToken) return;
      this.log.warn(`история сессии ${id} не прочитана: ${String(e)}`);
      this.resumeId = undefined;
      this.resumed = undefined;
      this.touched = false;
      this.title = undefined;
      deps.setTitle(this.tabLabel());
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
    this.attached = history.attach ?? { pdfPages: 0, chars: 0 };
    this.title = title;
    deps.setTitle(this.tabLabel());
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
    this.postAttach();
  }

  /** Вложения сессии — webview проверяет по ним новые вложения (плашка «начните новую»). */
  private postAttach(): void {
    this.deps.post({ type: 'session.attach', ...this.attached });
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
    // события, пришедшие во время чтения, — после истории (иначе она их сотрёт); с хвостом текущего ответа.
    // Прошлый пересев ещё читает — его накопленное переходит к этому, а сам он ничего не пошлёт.
    const buffer =
      this.reseedBuffer !== undefined
        ? [...this.reseedBuffer]
        : this.streamTail.snapshot().map((event) => ({ sessionId: id, event }));
    this.reseedBuffer = buffer;
    const teardowns = this.teardowns;
    const seq = ++this.reseedSeq;
    if (!this.seedPending || !history) {
      try {
        // сессия зарегистрирована живой — процесс движка жив, его фоновые задачи ещё идут
        history = await this.deps.adapter.loadHistory(id, this.deps.cwd, {
          live: this.inTurn,
          tasksAlive: this.registeredId !== undefined,
        });
      } catch (e) {
        // новая сессия без единого сообщения: транскрипта ещё нет — пересеивать нечего, кроме снимка
        this.log.debug(`пересев: история ${id}: ${String(e)}`);
        history = undefined;
      }
    }
    // пересев, начатый позже, — его история новее; этот ничего не шлёт
    if (seq !== this.reseedSeq) return;
    if (this.reseedBuffer === buffer) this.reseedBuffer = undefined;
    // вкладку закрыли или сменили в ней сессию, пока читали, — эта история и события уже не нужны
    if (this.disposed || this.teardowns !== teardowns) return;
    const merged = mergeReplay(
      history?.events ?? [],
      buffer.map((b) => b.event),
    );
    if (history) {
      this.postHistory({ ...history, events: merged.history }, this.resumed?.title ?? this.title);
    } else this.deps.post({ type: 'session.reset' });
    this.postAttach();
    if (this.lastInit) this.forward(id, this.lastInit);
    if (this.lastContext) this.forward(id, this.lastContext);
    if (this.title) this.forward(id, { type: 'session.title', title: this.title });
    if (this.inTurn && this.turnStartedAt !== undefined) {
      this.forward(id, { type: 'turn.start', at: this.turnStartedAt });
    }
    for (const e of this.pendingRequests.values()) this.forward(id, e);
    for (const p of this.previews.values()) this.deps.post(p);
    const replay = new Set(merged.replay);
    for (const b of buffer) if (replay.has(b.event)) this.forward(b.sessionId, b.event);
    void this.ensureSession()
      .then((s) => this.postCapabilities(s))
      .catch(() => undefined);
  }

  /** Команда из боковой панели (`/status`): выполнить во вкладке, когда webview готов. */
  runCommand(name: 'status'): void {
    if (this.readyCount > 0) this.deps.post({ type: 'chat.command', name });
    else this.queuedCommand = name;
  }

  private tabLabel(): string {
    return tabTitle(this.status, this.title, hostStrings(this.deps.lang ?? 'ru').untitledTab);
  }

  /** Название сессии сменили снаружи (переименование в списке). */
  setTitle(title: string): void {
    const id = this.sessionId;
    this.title = title;
    if (this.resumed) this.resumed = { ...this.resumed, title };
    this.deps.setTitle(this.tabLabel());
    if (id) this.forward(id, { type: 'session.title', title });
  }

  /**
   * Список сессий перечитан. Название, которое придумал ИИ (`ai-title` в транскрипте), движок событием
   * не присылает — `session_title_changed` приходит только на наше переименование, — поэтому берём его из списка.
   */
  syncTitle(title: string): void {
    if (title !== this.title) this.setTitle(title);
  }

  /** Webview прислал `ready`: отдать ему всё, что накопилось до его готовности. */
  onReady(): void {
    const { deps } = this;
    this.readyCount++;
    const reseed = this.seedPending || this.readyCount > 1;
    this.pushInfo();
    // сессия создана до готовности webview (`start()`), `session.init` ещё не было — меню режима из настроек
    if (this.defaults && !this.lastInit) deps.post(this.defaults);
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
    if (!this.retrying) {
      this.inflight = [];
      this.dropRefused = false;
      this.retryAgain = false;
    }
    this.resumed = undefined;
    this.seedPending = false;
    this.touched = false;
    this.deps.onSession?.(undefined);
    this.status = 'idle';
    this.title = undefined;
    this.deps.setTitle(this.tabLabel());
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
      case 'diff.changes':
        await this.openChanges(m.toolUseIds);
        return;
      case 'agent.transcript': {
        const id = m.sessionId || this.current?.id;
        if (!id || !deps.adapter.agentTranscript || !deps.openText) return;
        const text = await deps.adapter.agentTranscript(id, deps.cwd, m.taskId, '');
        if (text === undefined) {
          this.log.warn(`транскрипт субагента ${m.taskId}: файла нет`);
          return;
        }
        await deps.openText({ key: `agent-${m.taskId}`, name: `agent-${m.taskId}.md`, text });
        return;
      }
      case 'preview.open':
        if (!isAbsolute(m.path) || !/\.html?$/i.test(m.path)) {
          this.log.warn(`превью: не абсолютный путь к .html — ${m.path}`);
          return;
        }
        await deps.openPreview?.(m.path);
        return;
      case 'link.open':
        if (!/^https:\/\/claude\.ai\//.test(m.url)) {
          this.log.warn(`ссылка не открыта: ${m.url}`);
          return;
        }
        deps.openExternal?.(m.url);
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
      case 'image.pick':
        this.postPicked(await deps.pickAttachments?.());
        return;
      case 'attach.uris': {
        const uris = Array.isArray(m.uris) ? m.uris.filter((u) => typeof u === 'string') : [];
        if (uris.length === 0) return;
        const r = await deps.readUris?.(uris);
        this.postPicked(r);
        // папка из перетаскивания — чип-ссылка, как из «Файл или папка…» (этап 8b)
        if (r?.folders?.length) deps.post({ type: 'attach.picked', items: r.folders });
        return;
      }
      case 'file.open': {
        const kind = m.kind === 'pdf' || m.kind === 'text' ? m.kind : undefined;
        if (!kind || typeof m.path !== 'string' || !m.path) {
          this.log.warn('файл не открыт: нет пути или типа');
          return;
        }
        const data = typeof m.data === 'string' && m.data ? m.data : undefined;
        await deps.openFile?.({ kind, path: m.path, ...(data ? { data } : {}) });
        return;
      }
      case 'image.open': {
        const checked =
          typeof m.mediaType === 'string' && typeof m.data === 'string'
            ? hostImage(m)
            : ({ problem: 'format' } as const);
        if ('problem' in checked) {
          this.log.warn(`картинка не открыта: ${String(m.mediaType)}, ${checked.problem}`);
          return;
        }
        await deps.openImage?.({ mediaType: checked.mediaType, data: m.data });
        return;
      }
      case 'limits.refresh':
        await this.refreshLimits();
        return;
      case 'log.show':
        deps.showLogs?.();
        return;
      case 'settings.open':
        deps.openSettings?.();
        return;
      case 'turn.retry':
        await this.retry(m.turn);
        return;
      // граф агентов: сессия движка для этого не нужна
      case 'agents.openGraph':
        deps.openGraph?.(m.agentId);
        return;
      case 'agents.snapshot':
        deps.graphSnapshot?.(m);
        return;
      default:
        break;
    }
    const session = await this.ensureSession();
    if (!session) {
      if (m.type === 'send' && !this.disposed) {
        // движок не поднялся (нет `claude`, ошибка старта): сообщение не теряем — карточка ошибки видит
        // открытый ход, и «Проверить снова» / «Повторить ход» (`retry(true)`) отправит его из `inflight`
        this.touched = true;
        this.noteSent(m);
        // вложения не ушли — вернуть webview точный счёт сессии (он прибавил их заранее)
        if (m.images?.length || m.files?.length) this.postAttach();
      }
      return;
    }
    try {
      switch (m.type) {
        case 'send': {
          this.touched = true;
          this.noteSent(m);
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
          if (this.defaults) this.defaults = { ...this.defaults, mode: m.mode as PermissionMode };
          return;
        case 'model.set':
          await session.setModel(m.model);
          return;
        case 'effort.set':
          if (EFFORTS.includes(m.effort)) {
            await session.setEffort(m.effort as EffortLevel);
            if (this.defaults)
              this.defaults = { ...this.defaults, effort: m.effort as EffortLevel };
          }
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
          // правку разрешили — движок сейчас запишет файл: сначала сохранить несохранённое в редакторе
          // (в `acceptEdits`/`bypass` карточки нет, так что и сохранять нечего — см. «Решения» этапа 6)
          if (m.decision !== 'deny') await this.saveBeforeEdit(m.toolUseId);
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
  /** Точка отката для «Повторить ход» (SDK `resumeSessionAt`): живёт, пока возобновляется сессия. */
  private retryDrop: RetryPoint | undefined;
  /** Текущая сессия поднята с отбрасыванием оборванного хода — отказ SDK («Resume rejected») лечится повтором без него. */
  private usedDrop = false;
  /** SDK отказал в отбрасывании хода: дальше «Повторить» возобновляет сессию целиком. */
  private dropRefused = false;
  /** Отказ SDK пришёл во время `retry`: повторить ещё раз, когда тот закончится. */
  private retryAgain = false;

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
      const prompts = withPrompt ? this.inflight.map((x) => x.m) : [];
      const id = this.lastSessionId;
      this.log.info(
        `повтор хода: ${id ? `resume ${id}` : 'новая сессия'}${prompts.length ? `, промптов к повтору: ${prompts.length}` : ', без промпта'}`,
      );
      if (id) {
        // оборванный ход начался и его промпт — последний в транскрипте: возобновляем без него, чтобы
        // повторный промпт не двоился. Нет точки (первый ход, чужие сообщения после него) — как раньше
        this.retryDrop =
          prompts.length && this.inflight[0]?.started && !this.dropRefused
            ? await this.deps.adapter
                .retryPoint?.(id, this.deps.cwd, prompts[0]!.text)
                .catch((e: unknown) => {
                  this.log.warn(`точка отката хода: ${String(e)}`);
                  return undefined;
                })
            : undefined;
        if (this.retryDrop)
          this.log.info('повтор хода: оборванный ход отбрасывается при возобновлении');
        await this.resume(id);
      } else this.newSession(true);
      if (!prompts.length) return;
      const session = await this.ensureSession();
      if (!session) return;
      this.touched = true;
      this.inflight = prompts.map((m) => ({ m, started: false }));
      for (const prompt of prompts) {
        const run = this.sendQueue.then(() => this.sendNow(session, prompt));
        this.sendQueue = run.catch(() => undefined);
        await run;
      }
    } finally {
      this.retrying = false;
      this.retryDrop = undefined;
    }
    // отказ SDK пришёл, пока этот повтор ещё шёл: теперь — возобновление целиком
    this.kickRetry();
  }

  /** Отложенный повтор после отказа SDK: когда не идут ни повтор, ни ход (итог, закрытие процесса). */
  private kickRetry(): void {
    if (!this.retryAgain || this.retrying || this.inTurn || this.disposed) return;
    this.retryAgain = false;
    void this.retry(true);
  }

  /**
   * SDK отказал отбросить оборванный ход (`Resume rejected by --resume-drops-turn:` — в диапазоне оказалось
   * лишнее). Отказ детерминирован: повторяем сразу, но возобновляя сессию целиком (как до этапа 6).
   */
  private dropRejected(messages: readonly string[]): boolean {
    if (!this.usedDrop) return false;
    const msg = messages.find((x) => x.includes('Resume rejected'));
    if (!msg) return false;
    this.log.warn(`SDK отказал в отбрасывании хода: ${msg}`);
    this.usedDrop = false;
    this.dropRefused = true;
    // повтор — в конце `onEvent` (или после идущего `retry`), когда событие обработано целиком
    this.retryAgain = true;
    return true;
  }

  /** Несохранённый файл редактора, который собирается править агент: сохранить до ответа движку. */
  private async saveBeforeEdit(toolUseId: string): Promise<void> {
    const req = this.pendingRequests.get(toolUseId);
    if (req?.type !== 'permission.request' || !req.diff || !this.deps.saveFile) return;
    const path = resolveFrom(this.deps.cwd, req.diff.filePath);
    await this.deps.saveFile(path).catch((e: unknown) => {
      this.log.warn(`сохранение ${path} перед правкой: ${String(e)}`);
    });
  }

  /** Новое сообщение человека: завершённые (упавшие) ходы больше не повторяются, это — в очередь. */
  private noteSent(m: Extract<FromWebview, { type: 'send' }>): void {
    if (!this.inTurn) this.inflight = this.inflight.filter((x) => !x.started);
    this.inflight.push({ m, started: false });
  }

  /** Движок начал ход с этими сообщениями (или влил их в идущий): отметить их в очереди. */
  private noteStarted(prompts: string[]): void {
    if (prompts.length === 0) {
      const first = this.inflight.find((x) => !x.started);
      if (first) first.started = true;
      return;
    }
    for (const p of prompts) {
      const text = splitPrompt(p).text;
      const i = this.inflight.findIndex((x) => !x.started && x.m.text === text);
      const j = i >= 0 ? i : this.inflight.findIndex((x) => !x.started);
      if (j >= 0) this.inflight[j]!.started = true;
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
   * Дифф вкладки «изменения»: правки группируются по файлу (порядок правок), левая сторона — `before` первой правки
   * файла, правая — `after` последней. Склеиваются только целые стороны; первая/последняя целая правка сессии
   * берётся из `fileSpans` (её стороны могли вытеснить из `edits`). Фрагмент (правка без исходного файла) с целыми
   * не сшить — он идёт сам, если целых нет. Предложенная, ещё не применённая правка — не изменение. Один файл —
   * обычный дифф, несколько — мульти-дифф.
   */
  private async openChanges(toolUseIds: readonly string[]): Promise<void> {
    const { deps } = this;
    const wanted = new Set(toolUseIds);
    const lost = [...wanted].filter((id) => !this.editFiles.has(id) && !this.edits.has(id));
    if (lost.length)
      this.log.warn(`diff.changes: правок не найдено — ${lost.length} (старая сессия или не Edit/Write)`);
    const byFile = new Map<string, string[]>();
    for (const [id, filePath] of this.editFiles) {
      if (!wanted.has(id)) continue;
      byFile.set(filePath, [...(byFile.get(filePath) ?? []), id]);
    }
    const files: OpenDiff[] = [];
    for (const [filePath, ids] of byFile) {
      const span = this.fileSpans.get(filePath);
      const known = ids.flatMap((id) => {
        const e = this.edits.get(id);
        return e?.stage === 'applied' ? [{ id, sides: e.sides }] : [];
      });
      const whole = known.filter((e) => !e.sides.fragment);
      const first =
        span && ids.includes(span.firstId)
          ? { id: span.firstId, text: span.before }
          : whole[0] && { id: whole[0].id, text: whole[0].sides.before };
      const lastWhole = whole[whole.length - 1];
      const last =
        span && ids.includes(span.lastId)
          ? { id: span.lastId, text: span.after }
          : lastWhole && { id: lastWhole.id, text: lastWhole.sides.after };
      const fragment = known[known.length - 1];
      if (first && last)
        files.push({
          key: `changes-${first.id}-${last.id}`,
          filePath,
          before: first.text,
          after: last.text,
          stage: 'applied',
        });
      else if (fragment)
        files.push({
          key: `changes-${fragment.id}-${fragment.id}`,
          filePath,
          before: fragment.sides.before,
          after: fragment.sides.after,
          stage: 'applied',
        });
    }
    if (files.length === 0) return;
    try {
      if (files.length === 1) await deps.openDiff?.(files[0]!);
      else
        await deps.openChanges?.(hostStrings(deps.lang ?? 'ru').changesTitle(files.length), files);
    } catch (e) {
      this.log.error(`diff.changes: ${String(e)}`);
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
      if (!sides) return;
      const filePath = resolveFrom(this.deps.cwd, sides.filePath);
      this.remember(e.toolUseId, { ...sides, filePath }, 'applied');
      this.editFiles.set(e.toolUseId, filePath);
      if (sides.fragment) return;
      const span = this.fileSpans.get(filePath);
      if (span) Object.assign(span, { lastId: e.toolUseId, after: sides.after });
      else
        this.fileSpans.set(filePath, {
          firstId: e.toolUseId,
          before: sides.before,
          lastId: e.toolUseId,
          after: sides.after,
        });
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
    if (!e.diff) return;
    // `file_path` модели может быть относительным: отсчёт от `cwd` сессии, а не процесса расширения
    const diff = { ...e.diff, filePath: resolveFrom(this.deps.cwd, e.diff.filePath) };
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
      preview: previewOf(sides, undefined, this.deps.lang ?? 'ru'),
    };
    // запрос уже закрыт, пока читали файл, — превью хранить незачем (пересев отдаст только ждущие)
    if (this.pendingRequests.has(e.toolUseId)) this.previews.set(e.toolUseId, msg);
    this.deps.post(msg);
  }

  private async sendNow(
    session: AgentSession,
    m: Extract<FromWebview, { type: 'send' }>,
  ): Promise<void> {
    try {
      await this.sendBody(session, m);
    } finally {
      // webview уже прибавил вложения к счёту сессии; точный снимок — и когда хост их отбросил или
      // сессия не приняла сообщение, иначе завышенный счёт ложно не пустил бы следующие вложения
      if (m.images?.length || m.files?.length) this.postAttach();
    }
  }

  private async sendBody(
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
    const images0 = this.checkImages(m.images);
    const used = (images0 ?? []).reduce((sum, i) => sum + i.data.length, 0);
    const { images, files, add } = this.fitSession(images0, this.checkFiles(m.files, used));
    // все вложения отброшены, текста нет — пустое сообщение API не примет
    if (!images && !files && !m.text.trim() && !m.attachments?.length) {
      this.log.warn('send: пустое сообщение (вложения отброшены) — не отправлено');
      return;
    }
    if (!session.send(buildPrompt(m.text, m.attachments ?? [], texts), images, files)) {
      this.log.warn('send: сессия закрыта, сообщение не принято');
      return;
    }
    if (add.chars > 0) {
      this.attached = {
        pdfPages: this.attached.pdfPages + add.pdfPages,
        chars: this.attached.chars + add.chars,
      };
    }
  }

  /**
   * Лимиты API — на запрос, а в запрос уходит вся история: вложения сверх 100 страниц pdf и 24 МБ на
   * сессию (с последней компакции), а также сверх 70 % свободного окна модели отбрасываются с
   * предупреждением в журнал. Webview проверяет то же по снимку `session.attach` до плашки; здесь —
   * последний рубеж (гонка двух сообщений, устаревший снимок).
   */
  private fitSession(
    images: PromptImage[] | undefined,
    files: PromptFile[] | undefined,
  ): {
    images: PromptImage[] | undefined;
    files: PromptFile[] | undefined;
    add: SessionAttach;
  } {
    const total: SessionAttach = { ...this.attached };
    const add: SessionAttach = { pdfPages: 0, chars: 0 };
    // окно знает только движок (после первого хода); до того — после resume окно сессии может быть 1M, а
    // счёт по умолчанию (200k) молча выбросил бы то, что webview по HUD истории пропустил: проверка — его
    const budget = this.lastContext?.maxTokens
      ? attachTokenBudget(this.lastContext.maxTokens, this.lastContext.usedTokens)
      : Number.POSITIVE_INFINITY;
    let tokens = 0;
    const take = (what: string, chars: number, pages: number, t: number): boolean => {
      const problem =
        sessionProblem(total, { pages, chars }) ??
        (tokens + t > budget ? ('context' as const) : undefined);
      if (problem) {
        this.log.warn(`${what} отброшен: ${problem}`);
        return false;
      }
      total.pdfPages += pages;
      total.chars += chars;
      add.pdfPages += pages;
      add.chars += chars;
      tokens += t;
      return true;
    };
    const keptImages = images?.filter((i) =>
      take('картинка', i.data.length, 0, i.width && i.height ? imageTokens(i.width, i.height) : 0),
    );
    const keptFiles = files?.filter((f) =>
      take(`файл ${f.path}`, f.data.length, sessionPdfPages(f), attachFileTokens(f)),
    );
    return {
      images: keptImages?.length ? keptImages : undefined,
      files: keptFiles?.length ? keptFiles : undefined,
      add,
    };
  }

  /**
   * Картинки из webview — ещё раз по лимитам (формат, 5 МБ base64, число): webview проверяет до
   * плашки, но сообщение пришло снаружи. Негодные отбрасываются с предупреждением в журнал.
   */
  private checkImages(images: unknown): PromptImage[] | undefined {
    if (!Array.isArray(images) || images.length === 0) return undefined;
    const out: PromptImage[] = [];
    let total = 0;
    for (const i of images as Partial<PromptImage>[]) {
      const checked =
        typeof i?.data !== 'string' || typeof i.mediaType !== 'string'
          ? ({ problem: 'format' } as const)
          : hostImage({ mediaType: i.mediaType, data: i.data });
      const problem =
        'problem' in checked
          ? checked.problem
          : out.length >= MAX_IMAGES_PER_MESSAGE
            ? 'count'
            : total + (i.data as string).length > MAX_MESSAGE_ATTACH_CHARS
              ? 'total'
              : undefined;
      if (problem || 'problem' in checked) {
        this.log.warn(`картинка отброшена: ${problem}`);
        continue;
      }
      total += (i.data as string).length;
      out.push({
        mediaType: checked.mediaType,
        data: i.data as string,
        ...(typeof i.width === 'number' ? { width: i.width } : {}),
        ...(typeof i.height === 'number' ? { height: i.height } : {}),
        ...(typeof i.name === 'string' ? { name: i.name.slice(0, 200) } : {}),
      });
    }
    return out.length ? out : undefined;
  }

  /**
   * Файлы из webview (этап 8) — ещё раз: тип, путь, содержимое (`hostFile`), не больше 10 и общий
   * лимит сообщения вместе с картинками (`used` — уже занято картинками). Негодные — в журнал.
   */
  private checkFiles(files: unknown, used: number): PromptFile[] | undefined {
    if (!Array.isArray(files) || files.length === 0) return undefined;
    const out: PromptFile[] = [];
    let total = used;
    for (const f of files as unknown[]) {
      const checked = hostFile(f);
      const problem =
        'problem' in checked
          ? checked.problem
          : out.length >= MAX_FILES_PER_MESSAGE
            ? 'count'
            : total + checked.data.length > MAX_MESSAGE_ATTACH_CHARS
              ? 'total'
              : undefined;
      if (problem || 'problem' in checked) {
        this.log.warn(`файл отброшен: ${problem}`);
        continue;
      }
      total += checked.data.length;
      out.push(checked);
    }
    return out.length ? out : undefined;
  }

  /** Результат диалога «+» или перетаскивания: картинки — `image.picked`, файлы — `file.picked`. */
  private postPicked(p: { images: PickedImage[]; files: PickedFile[] } | undefined): void {
    if (p?.images.length) this.deps.post({ type: 'image.picked', items: p.images });
    if (p?.files.length) this.deps.post({ type: 'file.picked', items: p.files });
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
      this.usedDrop = !!resume && !!this.retryDrop;
      const base = {
        cwd: deps.cwd,
        allowBypassPermissions: s.allowBypass,
      };
      const open = (): Promise<AgentSession> =>
        resume
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
                ...(this.retryDrop ? { dropTurn: this.retryDrop } : {}),
              });
            })()
          : (() => {
              // настройки «режим» и «effort по умолчанию» — только новым сессиям (resume берёт своё)
              const mode = resolveDefaultMode(s.defaultPermissionMode, s.allowBypass);
              const effort = resolveDefaultEffort(s.defaultEffort);
              // меню под полем ввода — сразу, не дожидаясь `session.init` после первого хода
              this.defaults = { type: 'session.defaults', mode, ...(effort ? { effort } : {}) };
              deps.post(this.defaults);
              return deps.adapter.createSession({
                ...base,
                permissionMode: mode,
                ...(s.defaultModel ? { model: s.defaultModel } : {}),
                ...(effort ? { effort } : {}),
              });
            })();
      // без `claude` движок не запускаем: SDK в `.vsix` своего бинарника не имеет и упал бы невнятной ошибкой
      const opened = deps.engine
        ? deps.engine.ready().then((ready) => {
            // пока шёл поиск, сессию заменили (`/clear`, resume) или вкладку закрыли: не спавнить движок
            // и не трогать чужие `resumed`/`retryDrop` — отказ этого поколения `catch` ниже проглотит
            if (gen !== this.generation || this.disposed)
              throw new Error('сессия заменена до старта');
            if (!ready.ok) throw new EngineMissingError(ready.problem);
            return open();
          })
        : open();
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
        if (gen !== this.generation || this.disposed) return;
        const message = e instanceof Error ? e.message : String(e);
        this.log.error(`сессия не создана: ${message}`);
        this.session = undefined;
        this.forward('', {
          type: 'error',
          message,
          fatal: true,
          ...(e instanceof EngineMissingError ? { code: ENGINE_MISSING_CODE } : {}),
        });
        this.forward('', { type: 'session.closed', reason: 'error', message });
        this.status = 'error';
        deps.setTitle(this.tabLabel());
      });
    }
    return this.session.catch(() => undefined);
  }

  private onEvent(session: AgentSession, e: AgentEvent): void {
    if (session !== this.current) return;
    if (e.type === 'session.init' && session.id) this.lastSessionId = session.id;
    this.log.debug(`← ${describeEvent(e)}`);
    this.streamTail.note(e);
    if (this.reseedBuffer) this.reseedBuffer.push({ sessionId: session.id, event: e });
    else this.forward(session.id, e);

    const prev = this.status;
    this.pending = updatePending(this.pending, e);
    this.inTurn = updateInTurn(this.inTurn, e);
    this.status = nextStatus(this.status, e, this.pending.length, this.inTurn);
    if (e.type === 'session.title' && !e.agentId) this.title = e.title;
    if (this.status !== prev || e.type === 'session.title') {
      this.deps.setTitle(this.tabLabel());
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
        if (!e.agentId) {
          this.turnStartedAt = e.at;
          this.turnSeen = true;
          // ход без промпта начал сам движок (пробуждение фоновой задачей, отказ resume) — сообщения
          // очереди он не берёт: иначе успешный итог пробуждения снял бы ещё не отвеченное сообщение
          const prompts = e.prompts ?? (e.prompt !== undefined ? [e.prompt] : []);
          if (prompts.length) this.noteStarted(prompts);
        }
        break;
      case 'turn.input':
        if (!e.agentId) this.noteStarted([e.prompt]);
        break;
      case 'tool.start':
      case 'tool.result':
        this.trackEdit(e);
        break;
      case 'compaction.end':
        // после компакции в истории остаётся сводка: картинки и документы из запросов уходят
        if (e.ok && !e.agentId) {
          this.attached = { pdfPages: 0, chars: 0 };
          this.postAttach();
        }
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
        // отказ resume с отбрасыванием приходит итогом `error_during_execution` (и, бывает, ещё `error`)
        if (!e.agentId && !e.ok) this.dropRejected([...(e.errors ?? []), e.text ?? '']);
        // успешный (или остановленный человеком) ход закрыт — повторять нечего
        if (!e.agentId && (e.ok || e.interrupted)) {
          // итог без единого `turn.start` (движок не прислал начало хода) — закрыл самое старое сообщение
          if (!this.turnSeen) this.noteStarted([]);
          this.inflight = this.inflight.filter((x) => !x.started);
          // отказ SDK касался того оборванного хода; следующий «Повторить» снова пробует отбросить
          this.dropRefused = false;
        }
        if (!e.agentId) this.turnSeen = false;
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
        if (this.dropRejected([e.message])) break;
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
        this.kickRetry();
        return;
      }
      default:
        break;
    }
    if (this.status !== prev && session.id) this.deps.live?.set(session.id, this.liveState());
    this.kickRetry();
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
    this.editFiles.clear();
    this.fileSpans.clear();
    this.editInputs.clear();
    this.lastInit = undefined;
    this.defaults = undefined;
    this.lastContext = undefined;
    this.attached = { pdfPages: 0, chars: 0 };
    this.usedDrop = false;
    this.turnStartedAt = undefined;
    this.pendingRequests.clear();
    this.previews.clear();
    this.reseedBuffer = undefined;
    this.streamTail.clear();
    this.teardowns++;
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
