/**
 * Подмножество протокола `codex app-server` (JSON-RPC 2.0 поверх stdio, newline-delimited), которое
 * нужно Agentura. Сверено с `codex-cli 0.160.0` (`codex app-server generate-ts`). Протокол помечен
 * experimental: типы НЕ копируем целиком (600+ файлов), а описываем используемое и сверяем скриптом
 * `npm run codex:protocol` (регенерирует схему во временную папку и проверяет, что нужные методы и поля
 * на месте). Всё, чего здесь нет, — `unknown`, а не выдумка.
 *
 * Только типы и таблицы методов: ни рантайма, ни импортов `vscode`.
 */

/** Версия CLI, с которой сверены типы. Меньшую/большую не блокируем: app-server experimental. */
export const CODEX_PROTOCOL_VERSION = '0.160.0';

export type RequestId = string | number;
type JsonValue = unknown;

// ---- общие значения -------------------------------------------------------------------------

/** `untrusted` — спрашивать почти всё; `on-request` — модель решает; `never` — не спрашивать. */
export type AskForApproval =
  'untrusted' | 'on-request' | 'never' | { granular: Record<string, boolean> };
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
/** Строка: набор уровней зависит от модели (`Model.supportedReasoningEfforts`). */
export type ReasoningEffort = string;

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'localImage'; path: string }
  | { type: 'image'; url: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface TurnError {
  message: string;
  /** Строка (`usageLimitExceeded`, `unauthorized`, …) или объект с кодом HTTP. */
  codexErrorInfo: string | Record<string, unknown> | null;
  additionalDetails: string | null;
}
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type PatchChangeKind =
  { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  /** unified diff (для add/delete — содержимое файла). */
  diff: string;
}
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type CollabAgentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent'
  | 'sendMessage'
  | 'followupTask'
  | 'interruptAgent'
  | 'listAgents';
export type CollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';
export type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';
export interface CollabAgentState {
  status: CollabAgentStatus;
  message: string | null;
}
export type SubAgentActivityKind = 'started' | 'interacted' | 'interrupted' | 'completed';

/** Элементы ленты хода. Остальные виды (`webSearch`, `imageView`, …) приходят как `{ type, id, … }`. */
export type ThreadItem =
  | { type: 'userMessage'; id: string; clientId: string | null; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: ItemStatus;
      source: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: ItemStatus }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: JsonValue;
      result: JsonValue;
      error: JsonValue;
      durationMs: number | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      tool: string;
      namespace: string | null;
      arguments: JsonValue;
      status: string;
      success: boolean | null;
    }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: CollabAgentTool;
      status: CollabAgentToolCallStatus;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
      agentsStates: Record<string, CollabAgentState | undefined>;
    }
  | { type: 'subAgentActivity'; id: string; kind: SubAgentActivityKind; agentThreadId: string; agentPath: string }
  | { type: 'contextCompaction'; id: string }
  | {
      type: 'webSearch';
      id: string;
      query: string;
      action: { type: string; query?: string | null; queries?: string[] | null; url?: string | null } | null;
    }
  | {
      type:
        | 'imageView'
        | 'sleep'
        | 'imageGeneration'
        | 'hookPrompt'
        | 'enteredReviewMode'
        | 'exitedReviewMode'
        | 'functionCallOutput';
      id: string;
    };

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export type ThreadStatus =
  { type: 'notLoaded' | 'idle' | 'systemError' } | { type: 'active'; activeFlags: string[] };

/** Секунды Unix (`createdAt`/`updatedAt`) — не миллисекунды. */
export interface Thread {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  /** Первое сообщение, обрезанное. */
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  /** Путь к rollout-файлу (`~/.codex/sessions/…`) — читать самим не нужно, есть `thread/read`. */
  path: string | null;
  cwd: string;
  cliVersion: string;
  /** Пользовательское имя (`thread/name/set`). */
  name: string | null;
  /** Только при `includeTurns` / у ответа `thread/read`; иначе пусто. */
  turns: Turn[];
}

export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export interface ReasoningEffortOption {
  reasoningEffort: ReasoningEffort;
  description: string;
}
export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

// ---- запросы клиента -------------------------------------------------------------------------

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    /** `true` открывает experimental-методы и поля. */
    experimentalApi: boolean;
    requestAttestation: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

interface ThreadSettings {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
}
export interface ThreadStartParams extends ThreadSettings {
  ephemeral?: boolean | null;
  serviceName?: string | null;
}
export interface ThreadResumeParams extends ThreadSettings {
  threadId: string;
  /** Не отдавать историю ходов в ответе (её читаем `thread/read`). */
  excludeTurns?: boolean;
}
export interface ThreadSession {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
  reasoningEffort: ReasoningEffort | null;
}
export type ThreadStartResponse = ThreadSession;
export type ThreadResumeResponse = ThreadSession;

export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}
export interface ThreadReadResponse {
  thread: Thread;
}
export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: 'created_at' | 'updated_at' | 'recency_at' | null;
  sortDirection?: 'asc' | 'desc' | null;
  /** Один каталог или список; сверка с `cwd` треда — на стороне сервера. */
  cwd?: string | string[] | null;
  archived?: boolean | null;
  sourceKinds?: ThreadSourceKind[] | null;
  searchTerm?: string | null;
}
export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}
export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}
export interface ThreadCompactStartParams {
  threadId: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
}
export interface TurnStartResponse {
  turn: Turn;
}
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}
export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  expectedTurnId: string;
}
export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}
export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}

/** Окно лимита `account/rateLimits/read`: `usedPercent` 0…100, `resetsAt` — epoch в секундах. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
  credits?: unknown;
}
export interface CodexRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}
export interface CodexAccountResponse {
  account: { type: string; email?: string | null; planType?: string | null } | null;
  requiresOpenaiAuth?: boolean;
}

/** Метод → [params, result] для `CodexRpcClient.request`. */
export interface CodexRequests {
  initialize: [InitializeParams, InitializeResponse];
  'thread/start': [ThreadStartParams, ThreadStartResponse];
  'thread/resume': [ThreadResumeParams, ThreadResumeResponse];
  'thread/read': [ThreadReadParams, ThreadReadResponse];
  'thread/list': [ThreadListParams, ThreadListResponse];
  'thread/name/set': [ThreadSetNameParams, Record<string, never>];
  'thread/compact/start': [ThreadCompactStartParams, Record<string, never>];
  'turn/start': [TurnStartParams, TurnStartResponse];
  'turn/interrupt': [TurnInterruptParams, Record<string, never>];
  'turn/steer': [TurnSteerParams, { turnId: string }];
  'model/list': [ModelListParams, ModelListResponse];
  'account/rateLimits/read': [Record<string, never> | undefined, CodexRateLimitsResponse];
  'account/read': [{ refreshToken: boolean }, CodexAccountResponse];
}
export type CodexRequestMethod = keyof CodexRequests;

// ---- notifications сервера -------------------------------------------------------------------

export interface CodexNotifications {
  'thread/started': { thread: Thread };
  'thread/status/changed': { threadId: string; status: ThreadStatus };
  'thread/name/updated': { threadId: string; threadName?: string };
  'thread/tokenUsage/updated': { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage };
  'thread/compacted': { threadId: string; turnId: string };
  'turn/started': { threadId: string; turn: Turn };
  'turn/completed': { threadId: string; turn: Turn };
  'item/started': { item: ThreadItem; threadId: string; turnId: string; startedAtMs: number };
  'item/completed': { item: ThreadItem; threadId: string; turnId: string; completedAtMs: number };
  'item/agentMessage/delta': { threadId: string; turnId: string; itemId: string; delta: string };
  'item/reasoning/summaryTextDelta': {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    summaryIndex: number;
  };
  'item/reasoning/textDelta': {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    contentIndex: number;
  };
  'item/commandExecution/outputDelta': {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
  'item/fileChange/patchUpdated': {
    threadId: string;
    turnId: string;
    itemId: string;
    changes: FileUpdateChange[];
  };
  'serverRequest/resolved': { threadId: string; requestId: RequestId };
  error: { error: TurnError; willRetry: boolean; threadId: string; turnId: string };
}
export type CodexNotificationMethod = keyof CodexNotifications;

export function isCodexNotification(method: string): method is CodexNotificationMethod {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_METHODS, method);
}
const NOTIFICATION_METHODS: Record<CodexNotificationMethod, true> = {
  'thread/started': true,
  'thread/status/changed': true,
  'thread/name/updated': true,
  'thread/tokenUsage/updated': true,
  'thread/compacted': true,
  'turn/started': true,
  'turn/completed': true,
  'item/started': true,
  'item/completed': true,
  'item/agentMessage/delta': true,
  'item/reasoning/summaryTextDelta': true,
  'item/reasoning/textDelta': true,
  'item/commandExecution/outputDelta': true,
  'item/fileChange/patchUpdated': true,
  'serverRequest/resolved': true,
  error: true,
};

// ---- запросы сервера (approval) и ответы на них -----------------------------------------------

export type CommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: string } } };
export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandApprovalParams {
  /** `writeStdin` — запись в stdin уже идущего процесса, не новая команда. */
  kind: 'command' | 'writeStdin';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
  proposedExecpolicyAmendment?: string[] | null;
  proposedNetworkPolicyAmendments?: unknown[] | null;
  /** Запрос сетевого доступа к хосту (команды может не быть). */
  networkApprovalContext?: { host: string; protocol: string } | null;
  /**
   * Нет в сгенерированных типах 0.160.0, но живой сервер шлёт: какие решения запрос принимает
   * (например `["accept", {acceptWithExecpolicyAmendment: …}, "cancel"]`). Нет поля — любое из схемы.
   */
  availableDecisions?: (CommandApprovalDecision | string)[] | null;
}
export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
  /** См. `CommandApprovalParams.availableDecisions`. */
  availableDecisions?: string[] | null;
}
export interface PermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  /** Что просят: `network.enabled` и пути `fileSystem.read|write` (`null` — не просят). */
  permissions: RequestedPermissions;
}
export interface RequestedPermissions {
  network?: { enabled: boolean | null } | null;
  fileSystem?: {
    read?: string[] | null;
    write?: string[] | null;
    /** Новая форма (0.160 помечает read/write устаревшими): путь + `read`/`write`/`deny`. */
    entries?: { path: FileSystemEntryPath; access: 'read' | 'write' | 'deny' }[];
    [k: string]: unknown;
  } | null;
}
export type FileSystemEntryPath =
  | { type: 'path'; path: string }
  | { type: 'glob_pattern'; pattern: string }
  | {
      type: 'special';
      value:
        | { kind: 'root' | 'minimal' | 'tmpdir' | 'slash_tmp' }
        | { kind: 'project_roots'; subpath: string | null }
        | { kind: 'unknown'; path: string; subpath: string | null };
    };
/** Что отдаём в ответ (`GrantedPermissionProfile`): только непустые поля запроса. */
export type GrantedPermissions = {
  network?: { enabled: boolean | null };
  fileSystem?: NonNullable<RequestedPermissions['fileSystem']>;
};
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
}
export interface UserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
}

/** Метод → [params, result] для `CodexRpcClient.respond`. */
export interface CodexServerRequests {
  'item/commandExecution/requestApproval': [
    CommandApprovalParams,
    { decision: CommandApprovalDecision },
  ];
  'item/fileChange/requestApproval': [
    FileChangeApprovalParams,
    { decision: FileChangeApprovalDecision },
  ];
  'item/permissions/requestApproval': [
    PermissionsApprovalParams,
    { permissions: GrantedPermissions; scope: 'turn' | 'session' },
  ];
  'item/tool/requestUserInput': [
    UserInputParams,
    { answers: Record<string, { answers: string[] }> },
  ];
}
export type CodexServerRequestMethod = keyof CodexServerRequests;

export function isCodexServerRequest(method: string): method is CodexServerRequestMethod {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'item/tool/requestUserInput'
  );
}
