/**
 * Граница агента по форме ACP: интерфейс адаптера и модель событий, не зависящие от Claude.
 * Реализация на Claude Agent SDK — `src/agent/claude/`. Webview получает `AgentEvent` как есть
 * (`src/protocol.ts`, сообщение `agent.event`), поэтому здесь только сериализуемые данные.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
/** Внешний движок сессии. Во всех долговечных ссылках id хранится вместе с провайдером. */
export type AgentProvider = 'claude' | 'codex' | 'antigravity';
export interface SessionRef {
  provider: AgentProvider;
  id: string;
}
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * Ответ на запрос разрешения. `allow-always` — принять подсказки движка как есть (правило в
 * `.claude/settings.local.json` у Bash); `allow-edits` — разрешить и перейти в `acceptEdits` до
 * конца сессии (карточка правки, этап 5).
 */
export type PermissionDecision = 'allow' | 'allow-always' | 'allow-edits' | 'deny';

/** Форматы картинок, которые принимает API (этап 4 roadmap 0.2). */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Картинка в сообщении пользователя: base64 без `data:`-префикса. */
export interface PromptImage {
  mediaType: ImageMediaType;
  data: string;
  /** Размер после уменьшения, px — для оценки токенов (ш×в/750) и подписи. */
  width?: number;
  height?: number;
  /** Имя для подписи («скриншот 1», имя файла). */
  name?: string;
}

/**
 * Картинка реплики в ленте (`turn.start`/`turn.input`). `data` нет — транскрипт её не сохранил или
 * история отдала только плашку «скриншот» (слишком много картинок в истории).
 */
export interface ImageRef {
  mediaType?: string;
  data?: string;
  width?: number;
  height?: number;
  name?: string;
}

/** Файл-вложение (этап 8 roadmap 0.2): текстовый (UTF-8) или pdf. */
export type FileKind = 'text' | 'pdf';

/**
 * Файл в сообщении пользователя: уходит движку `document`-блоком с `title` = `path`.
 * `path` — относительно рабочей папки сессии (с `/`), для файла вне её — абсолютный.
 */
export interface PromptFile {
  kind: FileKind;
  path: string;
  /** `text` — содержимое строкой, `pdf` — base64 без `data:`-префикса. */
  data: string;
  /** Размер файла, байт. */
  size: number;
  /** Страниц pdf, если удалось посчитать (оценка токенов). */
  pages?: number;
}

/**
 * Файл реплики в ленте (`turn.start`/`turn.input`): чип с именем и размером. `data` есть у
 * строки из поля ввода и у истории (в пределах лимита) — из неё хост делает временную копию для
 * просмотра файла вне рабочей папки.
 */
export interface FileRef {
  kind: FileKind;
  path: string;
  size?: number;
  pages?: number;
  data?: string;
}

/** Что сделает «всегда» — сводка подсказок движка для подписи кнопки (этап 5). */
export interface PermissionAlways {
  /** Правила в форме настроек: `Bash(npm test:*)`, `Edit`. */
  rules: string[];
  /** Куда движок запишет правила: `localSettings` → `.claude/settings.local.json`. */
  destination?:
    | 'localSettings'
    | 'projectSettings'
    | 'userSettings'
    | 'session'
    | 'cliArg'
    /** Правила Codex (`~/.codex/rules`): постоянное «всегда» у Codex. */
    | 'codexRules';
  /** Все места, если у правил разные `destination` (первое — `destination`); иначе поля нет. */
  destinations?: NonNullable<PermissionAlways['destination']>[];
  /** Подсказка-режим на сессию (`setMode`) — у Edit/Write это `acceptEdits`. */
  mode?: PermissionMode;
  /** Папки, добавляемые на сессию (`addDirectories`). */
  directories: string[];
}

/** Токены одного API-ответа или хода. `cacheWrite` = `cacheWrite5m + cacheWrite1h`. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** Рассуждение (входит в `output`). */
  thinking?: number;
}

export interface LimitWindow {
  /** `weekly-model` — недельное окно отдельной модели (`weekly_scoped` в /api/oauth/usage). */
  kind: 'five-hour' | 'weekly' | 'weekly-model';
  /** Имя модели словом провайдера (`Fable`) — только у `weekly-model`. */
  model?: string;
  /** Проценты 0…100. */
  percent: number;
  /** Момент сброса, мс; нет — окно неактивно (`resets_at: null`). */
  resetsAt?: number;
}

export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** Превью правки до применения: для Edit — фрагменты, для Write — новый текст целиком. */
export type DiffPreview =
  | { kind: 'edit'; filePath: string; oldText: string; newText: string; replaceAll: boolean }
  | { kind: 'write'; filePath: string; content: string };

interface Base {
  /**
   * Субагент или фоновая задача, от которой пришло событие: id вызова инструмента `Agent`
   * (`parent_tool_use_id` SDK). Нет поля — основной агент.
   */
  agentId?: string;
}

/**
 * События агента. Порядок внутри хода: `turn.start` → (`thinking.*` | `text.delta` | `tool.*` |
 * `permission.*` | `usage.message` | `context.usage`)* → `turn.result`. Субагенты и лимиты
 * могут приходить и между ходами.
 */
export type AgentEvent =
  | (Base & {
      type: 'session.init';
      sessionId: string;
      model: string;
      cwd: string;
      permissionMode: PermissionMode;
      tools: string[];
      slashCommands: string[];
      skills: string[];
      agents: string[];
      /** `none` — вход CLI (подписка), иначе источник ключа API. */
      apiKeySource: string;
      engineVersion: string;
      /** Effort, с которым расширение открыло сессию или выбрало в меню (движок его не сообщает). */
      effort?: EffortLevel;
    })
  | (Base & { type: 'session.title'; title: string })
  | (Base & {
      type: 'turn.start';
      /** Текст, с которого начался ход; нет — ход начал движок (пробуждение после фоновой задачи). */
      prompt?: string;
      /**
       * Отдельные сообщения, если движок склеил несколько в один ход (`prompt` — они через
       * пустую строку). Добавлено на приёмке этапа 3: лента сопоставляет каждое со своей строкой.
       */
      prompts?: string[];
      /** Картинки сообщения (этап 4 roadmap 0.2), в порядке отправки. */
      images?: ImageRef[];
      /** Файлы сообщения (этап 8 roadmap 0.2); живой ход — без `data`, она у строки поля ввода. */
      files?: FileRef[];
      at: number;
    })
  /**
   * Сообщение пользователя, которое движок влил в уже идущий ход (эхо uuid посреди хода).
   * Своего `turn.start` у него не будет. Добавлено на приёмке этапа 3.
   */
  | (Base & {
      type: 'turn.input';
      prompt: string;
      images?: ImageRef[];
      files?: FileRef[];
      at: number;
    })
  | (Base & { type: 'text.delta'; messageId: string; text: string })
  | (Base & { type: 'thinking.start'; messageId: string; at: number })
  | (Base & { type: 'thinking.delta'; messageId: string; text: string; estimatedTokens?: number })
  | (Base & { type: 'thinking.stop'; messageId: string; at: number; estimatedTokens?: number })
  | (Base & {
      type: 'tool.start';
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      /** Время из `timestamp` сообщения, мс. */
      at?: number;
    })
  | (Base & { type: 'tool.progress'; toolUseId: string; name: string; elapsedMs: number })
  | (Base & {
      type: 'tool.result';
      toolUseId: string;
      isError: boolean;
      /** Текст `tool_result` (что увидела модель). */
      content: string;
      /** Структурный результат инструмента (`tool_use_result`): патч правки, stdout, ответы… */
      result?: unknown;
      at?: number;
      /** Разность `timestamp` результата и вызова. */
      durationMs?: number;
    })
  | (Base & {
      type: 'permission.request';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      /** Готовая фраза запроса от движка, если есть. */
      title?: string;
      /** Короткое описание: имя файла, команда. */
      description?: string;
      reason?: string;
      blockedPath?: string;
      /** Движок предложил правило «всегда» — кнопка «всегда» имеет смысл. */
      canAlwaysAllow: boolean;
      /** Сводка подсказок «всегда» (этап 5); есть, когда `canAlwaysAllow`. */
      always?: PermissionAlways;
      diff?: DiffPreview;
    })
  | (Base & { type: 'question.request'; toolUseId: string; questions: Question[] })
  | (Base & { type: 'plan.request'; toolUseId: string; plan: string; planFilePath?: string })
  | (Base & {
      type: 'permission.resolved';
      toolUseId: string;
      decision: 'allow' | 'deny';
      /**
       * `user` — ответ из интерфейса; `remote` — ответили на claude.ai / с телефона (Remote Control);
       * `abort` — движок отменил запрос (прерывание, закрытие).
       */
      by: 'user' | 'remote' | 'abort';
    })
  | (Base & {
      type: 'usage.message';
      messageId: string;
      model: string;
      usage: TokenUsage;
      /** `false` — вывод ещё плейсхолдер (ответ оборван или пришёл без потока). */
      final: boolean;
      at?: number;
    })
  | (Base & {
      type: 'context.usage';
      usedTokens: number;
      maxTokens?: number;
      /** `usage` — сумма ввода последнего ответа; `engine` — `getContextUsage()`. */
      source: 'usage' | 'engine';
      percentage?: number;
      autoCompactThreshold?: number;
      categories?: { name: string; tokens: number; kind: string }[];
    })
  | (Base & {
      type: 'turn.result';
      ok: boolean;
      subtype: string;
      interrupted: boolean;
      durationMs: number;
      apiDurationMs: number;
      numTurns: number;
      usage: TokenUsage;
      /** Стоимость хода: разность `total_cost_usd` соседних ходов. Нет — неизвестна база (resume). */
      costUsd?: number;
      totalCostUsd: number;
      /**
       * `totalCostUsd` без части ходов: у модели нет цены в таблице (история по транскрипту, этап 5 roadmap 0.2).
       * У живого хода не бывает — `total_cost_usd` движка точный.
       */
      costPartial?: boolean;
      model?: string;
      contextWindow?: number;
      stopReason?: string;
      terminalReason?: string;
      /** `task-notification` и т. п. — ход начат движком. */
      origin?: string;
      permissionDenials: { toolName: string; toolUseId: string }[];
      errors?: string[];
      /** Текст итогового ответа. */
      text?: string;
    })
  | (Base & { type: 'compaction.start' })
  | (Base & {
      type: 'compaction.end';
      ok: boolean;
      trigger?: 'manual' | 'auto';
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
      error?: string;
    })
  | (Base & {
      type: 'agent.start';
      agentId: string;
      taskId: string;
      description: string;
      taskType: string;
      subagentType?: string;
      background: boolean;
      prompt?: string;
      /** Задачу запустил субагент (например, его фоновый Bash) — id этого субагента. */
      parentAgentId?: string;
      /** Время запуска, мс: есть у восстановленной истории (живой `task_started` без времени). */
      at?: number;
    })
  | (Base & {
      type: 'agent.progress';
      agentId: string;
      taskId: string;
      description?: string;
      status?: string;
      lastToolName?: string;
      totalTokens?: number;
      toolUses?: number;
      durationMs?: number;
    })
  | (Base & {
      type: 'agent.end';
      agentId: string;
      taskId: string;
      status: 'completed' | 'failed' | 'stopped';
      summary?: string;
      totalTokens?: number;
      toolUses?: number;
      durationMs?: number;
      /** Время конца, мс: есть у восстановленной истории. */
      at?: number;
    })
  | (Base & {
      type: 'limit.update';
      source: 'engine' | 'oauth';
      status?: 'allowed' | 'allowed_warning' | 'rejected';
      windows: LimitWindow[];
      /** Сброс окна, упёршегося в лимит (или ближайшего), мс. */
      resetsAt?: number;
    })
  | (Base & { type: 'mode.changed'; mode: PermissionMode })
  /**
   * Remote Control (roadmap 17): состояние моста к claude.ai. `on` — сессия видна на claude.ai/code и в
   * приложении, `url` — её ссылка. `error` — причина: нет токена, OAuth отвергнут, сервер отказал, сеть,
   * транспорт закрыт; `superseded` (при `off`) — сессию подхватил другой воркер.
   */
  | (Base & {
      type: 'remote.state';
      state: 'connecting' | 'on' | 'off' | 'error';
      url?: string;
      error?: 'no-token' | 'oauth' | 'rejected' | 'network' | 'closed' | 'superseded';
      detail?: string;
    })
  /** Промпт, набранный на claude.ai (`web`) или в мобильном приложении (`phone`): уже ушёл движку. */
  | (Base & { type: 'remote.prompt'; uuid: string; text: string; from: 'phone' | 'web' })
  | (Base & {
      type: 'session.closed';
      /** `exit` — процесс движка завершился; `error` — поток оборвался ошибкой; `disposed` — закрыли мы. */
      reason: 'exit' | 'error' | 'disposed';
      message?: string;
    })
  | (Base & {
      type: 'error';
      message: string;
      /** `true` — сессия больше не работает. */
      fatal: boolean;
      code?: string;
    });

export type AgentEventType = AgentEvent['type'];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

export type Unsubscribe = () => void;

/**
 * Поток событий сессии: подписка колбэком или `for await`. Подписчик видит события с момента
 * подписки; накопленное до первой подписки достаётся первому подписчику.
 */
export interface EventStream<T> extends AsyncIterable<T> {
  on(listener: (event: T) => void): Unsubscribe;
}

export interface SessionOptions {
  /** Папка воркспейса — `cwd` движка. */
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  title?: string;
  /** Разрешить `bypassPermissions` (настройка `agentura.allowBypassPermissions`). */
  allowBypassPermissions?: boolean;
}

/**
 * Точка отката для «Повторить ход» (`resumeSessionAt` + `resumeDropsTurn` SDK): последнее целое
 * сообщение перед оборванным ходом и промпт этого хода. Возобновление отбрасывает ход, и повторный
 * промпт не двоится в транскрипте.
 */
export interface RetryPoint {
  keepUuid: string;
  promptUuid: string;
}

export interface ResumeOptions extends SessionOptions {
  /** Отбросить оборванный ход при возобновлении (только «Повторить ход»). */
  dropTurn?: RetryPoint;
  /**
   * Последний известный `total_cost_usd` сессии: движок продолжает счёт с него, и без базы
   * стоимость первого хода после resume неизвестна.
   */
  baselineCostUsd?: number;
}

/**
 * Решение по плану (`ExitPlanMode`). Одобрить — выйти в режим `mode`; не одобрить — отказ с
 * текстом, который видит модель (доработка), с `interrupt` — ещё и остановить ход (отклонить).
 */
export type PlanDecision =
  | { approve: true; mode?: 'acceptEdits' | 'default' }
  | { approve: false; feedback: string; interrupt?: boolean };

/** Модель из `supportedModels()` движка (этап 3: переключатель модели и effort). */
export interface ModelOption {
  value: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  effortLevels?: EffortLevel[];
}

/** Команда или скилл из `supportedCommands()` (этап 3: меню «/»). */
export interface CommandOption {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Что движок умеет в этой сессии; доступно до первого сообщения. */
export interface SessionCapabilities {
  models: ModelOption[];
  commands: CommandOption[];
}

export interface AgentSession {
  /** Id сессии движка; до первого `session.init` — пусто для новой, id для возобновлённой. */
  readonly id: string;
  readonly events: EventStream<AgentEvent>;
  /**
   * `false` — сессия закрыта, сообщение не принято. `images` уходят движку image-блоками перед
   * текстом (этап 4 roadmap 0.2); формат и размер проверяет вызывающий (`src/shared/images.ts`).
   * `files` — `document`-блоками после картинок (этап 8, проверка — `src/shared/files.ts`).
   */
  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]): boolean;
  respondPermission(toolUseId: string, decision: PermissionDecision, message?: string): boolean;
  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean;
  decidePlan(toolUseId: string, decision: PlanDecision): boolean;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: EffortLevel): Promise<void>;
  interrupt(): Promise<void>;
  /** Сжать контекст: `/compact` промптом. */
  compact(): boolean;
  stopTask(taskId: string): Promise<void>;
  /** Модели и команды движка (`supportedModels()`, `supportedCommands()`); ошибка движка — пустые списки. */
  capabilities(): Promise<SessionCapabilities>;
  /** Точный контекст от движка; то же уходит событием `context.usage` после каждого хода. */
  contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined>;
  /**
   * Remote Control (roadmap 17): сессия видна и управляема с claude.ai/code и телефона. Состояние приходит
   * событием `remote.state`. Необязателен: есть только у Claude (`features.remote`).
   */
  setRemote?(on: boolean): Promise<void>;
  dispose(): void;
}

export interface SessionInfo {
  id: string;
  title: string;
  firstPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  createdAt?: number;
  updatedAt: number;
  fileSize?: number;
  /** Чей это тред; нет — Claude (так отдаёт `ClaudeAdapter`). */
  provider?: AgentProvider;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiProvider?: string;
  tokenSource?: string;
}

/**
 * Одноразовый запрос к модели вне сессии (✦ сообщение коммита, roadmap 12): без инструментов, один ход,
 * без транскрипта — в список сессий не попадает.
 */
export interface CompletionRequest {
  /** Системный промпт целиком (не пресет Claude Code). */
  system: string;
  prompt: string;
  /** Модель или алиас (`sonnet`); нет — модель по умолчанию движка. */
  model?: string;
  /** Нет ответа за это время — ошибка; по умолчанию 60 с. */
  timeoutMs?: number;
}

/**
 * Восстановленная история сессии (этап 6): события, которыми её видела лента, — те же `AgentEvent`,
 * что у живой сессии (`turn.start`, `text.delta`, `tool.start/result`, `usage.message`, `turn.result`…).
 */
export interface SessionHistory {
  events: AgentEvent[];
  /** Ходов в сессии всего (промпты пользователя). */
  turns: number;
  /** Сколько ранних ходов не вошло в `events` (показываются последние). */
  skippedTurns: number;
  /** Режим разрешений на конец сессии (из транскрипта); нет — неизвестен. */
  mode?: PermissionMode;
  /** Модель последнего ответа — с ней продолжаем (движок при `resume` берёт модель из опций, не из сессии). */
  model?: string;
  /**
   * Вложения с последней компакции (до обрезки данных в `events`): страницы pdf и символы
   * base64/текста. Нет — вложений нет. Нужны лимитам API на запрос со всей историей (этап 6 roadmap 0.2).
   */
  attach?: { pdfPages: number; chars: number };
  /** Последний `total_cost_usd` движка (запись `cost-state` транскрипта) — база стоимости после `resume`. */
  totalCostUsd?: number;
}

export interface AgentAdapter {
  readonly id: string;
  createSession(options: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession>;
  listSessions(dir: string): Promise<SessionInfo[]>;
  /**
   * История сессии для ленты: сообщения транскрипта → события. `live: true` — сессия сейчас идёт
   * (пересев webview), последний ход остаётся открытым.
   */
  loadHistory(
    sessionId: string,
    cwd: string,
    /** `tasksAlive` — процесс движка жив: незакрытые фоновые задачи из транскрипта ещё идут. */
    options?: {
      live?: boolean;
      tasksAlive?: boolean;
      maxTurns?: number;
      /** История до этого сообщения, без него: промпт хода, который «Повторить» отбросит. */
      stopBefore?: string;
    },
  ): Promise<SessionHistory>;
  /**
   * Где оборвался ход с промптом `prompt` (текст пользователя): точка отката для «Повторить ход».
   * `undefined` — отбросить ход нельзя (промпта нет в транскрипте, после него есть чужие сообщения,
   * ход первый в сессии): тогда сессию возобновляют целиком, и промпт в транскрипте будет дважды.
   */
  retryPoint?(sessionId: string, cwd: string, prompt: string): Promise<RetryPoint | undefined>;
  /** Переименование (`customTitle` в транскрипте). */
  renameSession(sessionId: string, title: string, cwd: string): Promise<void>;
  /**
   * Транскрипт субагента (`taskId` — id задачи движка) текстом Markdown для документа только для
   * чтения; нет — `undefined`. Необязателен: у адаптера без субагентов кнопки «транскрипт» нет.
   */
  agentTranscript?(
    sessionId: string,
    cwd: string,
    taskId: string,
    title: string,
  ): Promise<string | undefined>;
  accountInfo(cwd: string): Promise<AccountInfo>;
  /** Одноразовый запрос (`CompletionRequest`): текст ответа модели. Нет — у адаптера такой возможности нет. */
  complete?(cwd: string, request: CompletionRequest): Promise<string>;
}
