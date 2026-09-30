/**
 * Граница агента по форме ACP: интерфейс адаптера и модель событий, не зависящие от Claude.
 * Реализация на Claude Agent SDK — `src/agent/claude/`. Webview получает `AgentEvent` как есть
 * (`src/protocol.ts`, сообщение `agent.event`), поэтому здесь только сериализуемые данные.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionDecision = 'allow' | 'allow-always' | 'deny';

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
    })
  | (Base & { type: 'session.title'; title: string })
  | (Base & {
      type: 'turn.start';
      /** Текст, с которого начался ход; нет — ход начал движок (пробуждение после фоновой задачи). */
      prompt?: string;
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
      diff?: DiffPreview;
    })
  | (Base & { type: 'question.request'; toolUseId: string; questions: Question[] })
  | (Base & { type: 'plan.request'; toolUseId: string; plan: string; planFilePath?: string })
  | (Base & {
      type: 'permission.resolved';
      toolUseId: string;
      decision: 'allow' | 'deny';
      /** `user` — ответ из интерфейса; `abort` — движок отменил запрос (прерывание, закрытие). */
      by: 'user' | 'abort';
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

export interface ResumeOptions extends SessionOptions {
  /**
   * Последний известный `total_cost_usd` сессии: движок продолжает счёт с него, и без базы
   * стоимость первого хода после resume неизвестна.
   */
  baselineCostUsd?: number;
}

export type PlanDecision =
  { approve: true; mode?: 'acceptEdits' | 'default' } | { approve: false; feedback: string };

export interface AgentSession {
  /** Id сессии движка; до первого `session.init` — пусто для новой, id для возобновлённой. */
  readonly id: string;
  readonly events: EventStream<AgentEvent>;
  /** `false` — сессия закрыта, сообщение не принято. */
  send(text: string): boolean;
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
  /** Точный контекст от движка; то же уходит событием `context.usage` после каждого хода. */
  contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined>;
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
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiProvider?: string;
  tokenSource?: string;
}

export interface AgentAdapter {
  readonly id: string;
  createSession(options: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession>;
  listSessions(dir: string): Promise<SessionInfo[]>;
  accountInfo(cwd: string): Promise<AccountInfo>;
}
