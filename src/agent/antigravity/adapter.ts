import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { Lang } from '../../shared/l10n';
import { AcpRpcClient, AcpRpcError, MAX_LINE_BYTES, PERMISSION_METHOD, type RpcId, type RpcProcess } from '../acp/client';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentEvent,
  AgentEventOf,
  AgentAdapter,
  AgentSession,
  DiffPreview,
  EffortLevel,
  PermissionMode,
  PromptFile,
  PromptImage,
  ResumeOptions,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
} from '../types';
import { AgyAcpMapper, toolInput, toolName, usageOf } from './acpMapper';
import {
  AGY_CLIENT_CAPABILITIES,
  AGY_PROTOCOL_VERSION,
  ELICITATION_METHOD,
  agentVersionOf,
  agyModeId,
  availableCommandsOf,
  chunkText,
  currentModeId,
  elicitationDecline,
  formatElicitationAnswer,
  isEffort,
  mergeConfig,
  modelOptionsFrom,
  normalizeModel,
  parseConfig,
  parseElicitation,
  permissionModeOf,
  permissionRefusal,
  promptBlocks,
  record,
  sessionIdOf,
  sessionTitleOf,
  sessionUpdateKind,
  stopReasonOf,
  tierNameOf,
  type AgyConfig,
  type ParsedElicitation,
} from './acpProtocol';
import {
  buildAgyContextUsage,
  readLastTranscriptUsage,
  singleStepUsageTokens,
} from './context';
import { AGY_NOT_FOUND } from './executable';
import { buildAgyHistory } from './history';
import { agyContextWindow } from './models';
import { AgySessionIndex, type AgySessionSettings, type AgyStateStore } from './sessionIndex';
import {
  AgyParentToolOutputReader,
  AgyParentTranscriptTailer,
  AgySubagentReader,
  DEFAULT_SUBAGENT_POLL_MS,
  DEFAULT_WAITING_THRESHOLD_MS,
  agySubagentMarkdown,
  isValidAgyUuid,
  parseCreatedSubagent,
  parseManagedSubagents,
  resolveAgySubagentModelEffort,
  withAgySubagentTimelines,
  type AgySubagentMeta,
  type ManagedSubagentsResult,
} from './subagents';
import { mapAgyTool, readAgyMcpServers } from './tools';

export interface AgyAcpProcess extends RpcProcess {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface AgySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface AntigravityAdapterConfig {
  /** Каталог данных Antigravity (~/.gemini/antigravity-cli), где лежат brain/<sessionId>/... */
  dataDir?: string;
  /** Путь к `agy` (`antigravityEngine.path()`); нет пути — `createSession` бросает «не найден». */
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  log?: LogFn;
  /** База окружения процесса; по умолчанию `process.env` целиком (вход agy живёт в `~/.gemini`). */
  env?: NodeJS.ProcessEnv;
  /** Версия `agy` для `session.init.engineVersion` (из локатора); нет — `agentInfo.version` из `initialize`. */
  engineVersion?: string | (() => string | undefined);
  clientVersion?: string;
  /** Язык локализованных плашек маппера (`api_retry`); по умолчанию `'ru'`. */
  lang?: () => Lang;
  /** Хранилище Agentura (`globalState`): пользовательские имена сессий (`renameSession`). */
  state?: AgyStateStore;
  /** Подмена запуска процесса в тестах. */
  spawn?: (path: string, args: string[], options: AgySpawnOptions) => AgyAcpProcess;
  timeoutMs?: number;
  /** `stdin.end()` → пауза (беседа сохраняется при штатном закрытии) → SIGTERM → ещё пауза → SIGKILL. */
  graceMs?: number;
  /** Сколько Stop ждёт `stopReason`, прежде чем закрыть зависший транспорт. */
  interruptWaitMs?: number;
  /** Пауза тишины потока (мс) перед закрытием внеходового реактивного хода пробуждения (`wakeupTurn`). */
  wakeupIdleMs?: number;
  /** Интервал опроса дочерних `transcript.jsonl` субагентов (мс); по умолчанию 400. */
  subagentPollMs?: number;
  /** Порог ожидания (мс) незакрытого вызова в субагенте до пометки `waiting_for_input`; по умолчанию 2500. */
  subagentWaitingMs?: number;
}

const DEFAULT_GRACE_MS = 2000;
const INTERRUPT_WAIT_MS = 10_000;
const DEFAULT_WAKEUP_IDLE_MS = 800;
const SILENT_WAKEUP_WATCH_MS = 15_000;
const PARENT_TOOL_RESOLVE_TTL_MS = 3_000;
const PARENT_TOOL_FAST_RETRY_MS = 50;
/** Тариф аккаунта меняется редко; `session/new` ради него — отдельный процесс `agy acp`. */
const ACCOUNT_TTL_MS = 10 * 60_000;

/**
 * Аргументы запуска `agy`: `--dangerously-skip-permissions` передаётся строго при
 * `permissionMode === 'bypassPermissions' && allowBypass`, чтобы дочерние субагенты унаследовали обход прав.
 */
export function agySpawnArgs(permissionMode: PermissionMode | undefined, allowBypass: boolean): string[] {
  return permissionMode === 'bypassPermissions' && allowBypass
    ? ['acp', '--dangerously-skip-permissions']
    : ['acp'];
}

function defaultSpawn(path: string, args: string[], options: AgySpawnOptions): AgyAcpProcess {
  return spawn(path, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as unknown as AgyAcpProcess;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesCwd(itemCwd: string, targetDir: string): boolean {
  if (itemCwd === targetDir) return true;
  try {
    const realTarget = realpathSync(targetDir);
    if (itemCwd === realTarget) return true;
    try {
      const realItem = realpathSync(itemCwd);
      if (realItem === realTarget || realItem === targetDir) return true;
    } catch {
      // item path doesn't exist
    }
  } catch {
    // targetDir doesn't exist
  }
  return false;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  private readonly index: AgySessionIndex;
  private tier: { name: string | undefined; at: number } | undefined;
  private accountLoad: Promise<AccountInfo> | undefined;
  private mcpServers: readonly string[] | undefined;
  private readonly subagentMeta = new Map<string, AgySubagentMeta>();

  constructor(private readonly config: AntigravityAdapterConfig = {}) {
    this.index = new AgySessionIndex(config.state);
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new AgySession(
      this.config,
      await this.executable(),
      options,
      (name) => this.noteTier(name),
      this.index,
      this.knownMcpServers(),
      (uuid, meta) => this.noteSubagentMeta(uuid, meta),
    );
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    const saved = this.index.settingsOf(sessionId);
    const model = options.model ?? saved?.model;
    const effort = options.effort ?? saved?.effort;
    const permissionMode =
      options.permissionMode !== undefined ? options.permissionMode : saved?.permissionMode;
    return new AgySession(
      this.config,
      await this.executable(),
      {
        ...saved,
        ...options,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      },
      (name) => this.noteTier(name),
      this.index,
      this.knownMcpServers(),
      (uuid, meta) => this.noteSubagentMeta(uuid, meta),
      sessionId,
    );
  }

  /**
   * Список сессий проекта: `session/list` через кратковременный `agy acp` с фильтрацией по `cwd` (с учётом realpath)
   * и наложением пользовательских имён из `sessionIndex`.
   */
  async listSessions(dir: string): Promise<SessionInfo[]> {
    let executable: string;
    try {
      executable = await this.executable();
    } catch {
      return [];
    }
    try {
      const result = await this.acp(executable, dir, async (client) => {
        await client.request('initialize', initializeParams(this.config));
        return client.request('session/list', { cwd: dir });
      });
      const list = record(result)?.sessions;
      if (!Array.isArray(list)) return [];
      const out: SessionInfo[] = [];
      for (const item of list) {
        const row = record(item);
        const id = typeof row?.sessionId === 'string' ? row.sessionId : undefined;
        const cwd = typeof row?.cwd === 'string' ? row.cwd : undefined;
        if (!id || !cwd || !matchesCwd(cwd, dir)) continue;
        const title = this.index.nameOf(id) ?? (typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : id);
        const updatedAt = typeof row?.updatedAt === 'string' ? Date.parse(row.updatedAt) : 0;
        out.push({
          id,
          title,
          cwd: dir,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
          provider: 'antigravity',
        });
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      return out;
    } catch (error) {
      this.config.log?.('warn', `agy: listSessions failed: ${errorText(error)}`);
      return [];
    }
  }

  /** Реконструкция истории: вызов `session/load` в кратковременном `agy acp` и сборка событий `AgentEvent[]`. */
  async loadHistory(
    sessionId: string,
    cwd: string,
    options: { live?: boolean; tasksAlive?: boolean; maxTurns?: number; stopBefore?: string } = {},
  ): Promise<SessionHistory> {
    const executable = await this.executable();
    try {
      const loaded = await this.acp(executable, cwd, async (client, updates) => {
        await client.request('initialize', initializeParams(this.config));
        const result = await client.request('session/load', { sessionId, cwd, mcpServers: [] });
        return { updates: [...updates], result };
      });
      const history = buildAgyHistory(loaded.updates, loaded.result, {
        ...(options.live ? { live: true } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(this.config.lang ? { lang: this.config.lang } : {}),
        mcpServers: this.knownMcpServers(),
      });
      const saved = this.index.settingsOf(sessionId);
      if (saved?.model) history.model = saved.model;
      if (saved?.permissionMode) history.mode = saved.permissionMode;
      const ctxModel = history.model ?? parseConfig(loaded.result).model?.current;
      const ctxEffort =
        saved?.effort ??
        (() => {
          const th = parseConfig(loaded.result).thoughtLevel?.current;
          return th && isEffort(th) ? th : undefined;
        })();
      history.events = await withAgySubagentTimelines(
        history.events,
        this.config.dataDir,
        this.knownMcpServers(),
        {
          ...(options.live ? { live: true } : {}),
          ...(options.tasksAlive ? { tasksAlive: true } : {}),
          ...(ctxModel ? { parentModel: ctxModel } : {}),
          ...(ctxEffort ? { parentEffort: ctxEffort } : {}),
          parentSessionId: sessionId,
          ...(this.config.subagentWaitingMs !== undefined
            ? { waitingThresholdMs: this.config.subagentWaitingMs }
            : {}),
          onSubagentMeta: (uuid, meta) => this.noteSubagentMeta(uuid, meta),
          warn: (msg) => this.config.log?.('warn', msg),
        },
      );
      const snap = await readLastTranscriptUsage(sessionId, this.config.dataDir);
      if (snap) {
        history.events.push(buildAgyContextUsage(snap.usedTokens, ctxModel));
      }
      return history;
    } catch (error) {
      this.config.log?.('warn', `agy: session/load failed: ${errorText(error)}`);
      return { events: [], turns: 0, skippedTurns: 0 };
    }
  }

  /**
   * Read-only Markdown транскрипта субагента из `brain/<taskId>/.system_generated/logs/transcript.jsonl`.
   */
  async agentTranscript(
    sessionId: string,
    cwd: string,
    taskId: string,
    title: string,
  ): Promise<string | undefined> {
    void sessionId;
    void cwd;
    if (!isValidAgyUuid(taskId)) return undefined;
    const saved = this.subagentMeta.get(taskId.toLowerCase());
    return agySubagentMarkdown(taskId, this.config.dataDir, {
      title: title || saved?.description || taskId.toLowerCase(),
      ...(saved?.agentType ? { agentType: saved.agentType } : {}),
      ...(saved?.model ? { model: saved.model } : {}),
      ...(saved?.effort ? { effort: saved.effort } : {}),
      ...(this.config.lang ? { lang: this.config.lang() } : {}),
      mcpServers: this.knownMcpServers(),
    });
  }

  /** Сохранение пользовательского имени сессии в `sessionIndex`. */
  async renameSession(sessionId: string, title: string, cwd?: string): Promise<void> {
    void cwd;
    await this.index.rename(sessionId, title);
  }

  /**
   * Тариф из `_meta.antigravity.tier.name` (`session/new`): сессия, уже прошедшая handshake, отдаёт его бесплатно,
   * иначе — короткий `agy acp`, закрываемый штатно по `stdin.end()`. Пустая сессия в историю agy не попадает.
   * Нет бинарника или сбой — `{}`.
   */
  async accountInfo(cwd: string): Promise<AccountInfo> {
    const cached = this.tier;
    if (cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return accountOf(cached.name);
    if (this.accountLoad) return this.accountLoad;
    const load = this.loadAccount(cwd).finally(() => {
      if (this.accountLoad === load) this.accountLoad = undefined;
    });
    this.accountLoad = load;
    return load;
  }

  private noteTier(name: string | undefined): void {
    if (name) this.tier = { name, at: Date.now() };
  }

  private noteSubagentMeta(childUuid: string, meta: AgySubagentMeta): void {
    if (!isValidAgyUuid(childUuid)) return;
    const key = childUuid.toLowerCase();
    const prev = this.subagentMeta.get(key);
    this.subagentMeta.set(key, {
      ...prev,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.agentType ? { agentType: meta.agentType } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.effort ? { effort: meta.effort } : {}),
    });
  }

  private knownMcpServers(): readonly string[] {
    return (this.mcpServers ??= readAgyMcpServers(this.config.dataDir));
  }

  private async loadAccount(cwd: string): Promise<AccountInfo> {
    let executable: string;
    try {
      executable = await this.executable();
    } catch {
      return {};
    }
    try {
      const result = await this.acp(executable, cwd, async (client) => {
        await client.request('initialize', initializeParams(this.config));
        return client.request('session/new', { cwd, mcpServers: [] });
      });
      const name = tierNameOf(result);
      this.noteTier(name);
      return accountOf(name);
    } catch (error) {
      this.config.log?.('warn', `agy: account info failed: ${errorText(error)}`);
      return {};
    }
  }

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(AGY_NOT_FOUND);
    return path;
  }

  /** Короткий `agy acp`: один сценарий, затем тот же штатный shutdown, что у сессии. */
  private async acp<T>(
    executable: string,
    cwd: string,
    fn: (client: AcpRpcClient, updates: unknown[]) => Promise<T>,
  ): Promise<T> {
    const proc = (this.config.spawn ?? defaultSpawn)(executable, agySpawnArgs(undefined, false), {
      cwd,
      env: this.config.env ?? process.env,
      shell: false,
    });
    let exited = false;
    proc.on('exit', () => (exited = true));
    const updates: unknown[] = [];
    const client: AcpRpcClient = new AcpRpcClient(proc, {
      engine: 'Antigravity',
      timeoutMs: this.config.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const update = record(params)?.update;
        if (update !== undefined) updates.push(update);
      },
      onServerRequest: (id: RpcId, method: string, params: unknown): boolean =>
        answerServerRequest(client, id, method, params),
      onStderr: (line) => this.config.log?.('debug', `agy: ${line}`),
    });
    try {
      return await fn(client, updates);
    } finally {
      client.dispose();
      shutdownAgy(proc, this.config.graceMs ?? DEFAULT_GRACE_MS, () => exited);
    }
  }
}

function accountOf(name: string | undefined): AccountInfo {
  return name ? { subscriptionType: name } : {};
}

function initializeParams(config: AntigravityAdapterConfig): Record<string, unknown> {
  return {
    protocolVersion: AGY_PROTOCOL_VERSION,
    clientCapabilities: AGY_CLIENT_CAPABILITIES,
    clientInfo: { name: 'agentura', version: config.clientVersion ?? '0.0.0' },
  };
}

/** Серверные запросы в кратковременных процессах (`loadAccount`, `listSessions`): безопасный отказ. */
function answerServerRequest(client: AcpRpcClient, id: RpcId, method: string, params: unknown): boolean {
  if (method === PERMISSION_METHOD) {
    client.respond(id, permissionRefusal(params));
    return true;
  }
  if (method === ELICITATION_METHOD) {
    client.respond(id, elicitationDecline());
    return true;
  }
  return false;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  readonly settled: boolean;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((r) => (resolve = r));
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolve();
    },
    get settled() {
      return settled;
    },
  };
}

/**
 * Сессия = один живой `agy acp` на вкладку: ходы — `session/prompt` по одному (очередь на нашей стороне), Stop —
 * уведомление `session/cancel` без убийства процесса, закрытие — `stdin.end()` (беседа сохраняется) и жёсткий выход
 * по таймауту. Разрешения — `session/request_permission` → `permission.request`; вопросы — `elicitation/create` → `question.request`.
 */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isSubstantiveTurnUpdate(kind: string | undefined, update: unknown): boolean {
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    return chunkText(update).length > 0;
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = record(update)?.toolCallId;
    return typeof id === 'string' && id.length > 0;
  }
  return false;
}

class AgySession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper: AgyAcpMapper;
  private readonly log: LogFn;
  private proc!: AgyAcpProcess;
  private client!: AcpRpcClient;
  private ready: Promise<void>;
  private procExitCheck: () => boolean = () => true;
  private readonly queue: { text: string; images: readonly PromptImage[] }[] = [];
  private readonly cwd: string;
  private permissionMode: PermissionMode;
  private explicitMode: boolean;
  private readonly allowBypass: boolean;
  private spawnedBypass = false;
  private pendingRespawn = false;
  private readonly graceMs: number;
  private readonly interruptWaitMs: number;
  private readonly wakeupIdleMs: number;
  private readonly subagentPollMs: number;
  private readonly subagentWaitingMs: number;
  /** Режим, который сейчас принял сервер (`current_mode_update` отстаёт от запросов — ему не верим). */
  private serverMode = 'default';
  private config: AgyConfig = { combinedIds: [] };
  private slashCommands: string[] = [];
  /** Желаемый уровень: шлём, только когда он есть среди актуальных `thought_level`; после смены модели — досылаем. */
  private effort: EffortLevel | undefined;
  private sessionId = '';
  private agentVersion: string | undefined;
  private closed = false;
  /** Пока handshake не кончился, `session/update` не живой ход. */
  private loading = true;
  private draining = false;
  private procExited = false;
  /** Растёт на каждый `interrupt()`: сообщение, взятое до него, в `session/prompt` не уходит. */
  private generation = 0;
  private usedTokens = 0;
  private lastStepIndex = -1;
  private transcriptCheckInProgress = false;
  private compacting: { done: Deferred; startedAt: number } | undefined;
  private turn: { done: Deferred; startedAt: number; prevStep: number; toolCalls: number } | undefined;
  private wakeupTurn:
    | { startedAt: number; prevStep: number; seq: number; timer: NodeJS.Timeout | undefined }
    | undefined;
  /** `session/set_*` идут строго по очереди: ответ на смену модели нужен для решения про `thought_level`. */
  private settings: Promise<unknown> = Promise.resolve();

  private readonly pendingPermissions = new Map<string, { id: RpcId; toolUseId: string }>();
  private readonly pendingQuestions = new Map<string, { id: RpcId; toolUseId: string; parsed: ParsedElicitation }>();
  private readonly subagentReaders = new Map<string, AgySubagentReader>();
  private parentToolSeq = 0;
  private readonly parentToolStarts = new Map<
    string,
    { name: string; input: Record<string, unknown>; seq: number; at?: number }
  >();
  private readonly pendingParentToolResolutions: {
    kind: 'agent' | 'manage';
    toolUseId: string;
    seq: number;
    input: Record<string, unknown>;
    at?: number;
    isError: boolean;
    queuedAt: number;
  }[] = [];
  private parentTailer: AgyParentTranscriptTailer | undefined;
  private parentToolReader: AgyParentToolOutputReader | undefined;
  private parentToolRetryTimer: NodeJS.Timeout | undefined;
  private transcriptModelFallback: { model: string; effort?: EffortLevel } | undefined;
  private subagentTimer: NodeJS.Timeout | undefined;
  private subagentPollInFlight = false;
  private subagentPollQueued = false;
  private silentWatchUntil = 0;

  constructor(
    private readonly config0: AntigravityAdapterConfig,
    private readonly executable: string,
    options: SessionOptions,
    private readonly onTier: (name: string | undefined) => void,
    private readonly index: AgySessionIndex,
    private readonly mcpServers: readonly string[],
    private readonly onSubagentMeta: (childUuid: string, meta: AgySubagentMeta) => void,
    private readonly resumeId?: string,
  ) {
    this.log = config0.log ?? (() => {});
    this.mapper = new AgyAcpMapper({
      ...(config0.lang ? { lang: config0.lang } : {}),
      mcpServers,
    });
    this.cwd = options.cwd;
    this.allowBypass = options.allowBypassPermissions === true;
    this.explicitMode = options.permissionMode !== undefined;
    const requested = options.permissionMode ?? 'default';
    this.permissionMode = requested === 'bypassPermissions' && !this.allowBypass ? 'default' : requested;
    this.effort = options.effort;
    this.graceMs = config0.graceMs ?? DEFAULT_GRACE_MS;
    this.interruptWaitMs = config0.interruptWaitMs ?? INTERRUPT_WAIT_MS;
    this.wakeupIdleMs = config0.wakeupIdleMs ?? DEFAULT_WAKEUP_IDLE_MS;
    this.subagentPollMs = config0.subagentPollMs ?? DEFAULT_SUBAGENT_POLL_MS;
    this.subagentWaitingMs = config0.subagentWaitingMs ?? DEFAULT_WAITING_THRESHOLD_MS;
    this.events = new EventHub<AgentEvent>((error) => this.log('error', `event subscriber failed: ${String(error)}`));
    this.spawnTransport(this.permissionMode);
    this.ready = this.handshake(options.model);
    this.ready.catch((error) => this.fatal(error));
  }

  get id(): string {
    return this.sessionId || this.resumeId || '';
  }

  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]): boolean {
    if (this.closed) return false;
    if (files?.length)
      this.log('warn', `agy: ${files.length} file attachment(s) are not supported and were dropped`);
    if (!text && !images?.length) return true;
    this.queue.push({ text, images: images ?? [] });
    this.drain().catch((error) => this.log('error', `agy queue failed: ${String(error)}`));
    return true;
  }

  respondPermission(toolUseId: string, decision: 'allow' | 'allow-always' | 'allow-edits' | 'deny'): boolean {
    const p = this.pendingPermissions.get(toolUseId);
    if (!p) return false;
    this.pendingPermissions.delete(toolUseId);
    if (decision === 'allow-edits') {
      void this.setMode('acceptEdits');
      this.client.respond(p.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
    } else if (decision === 'deny') {
      this.client.respond(p.id, { outcome: { outcome: 'selected', optionId: 'deny' } });
    } else {
      this.client.respond(p.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
    }
    this.emit({
      type: 'permission.resolved',
      toolUseId,
      decision: decision === 'deny' ? 'deny' : 'allow',
      by: 'user',
    });
    if (this.wakeupTurn && this.pendingPermissions.size === 0 && this.pendingQuestions.size === 0) {
      this.scheduleWakeupFinish();
    }
    return true;
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    const p = this.pendingQuestions.get(toolUseId);
    if (!p) return false;
    this.pendingQuestions.delete(toolUseId);
    const res = formatElicitationAnswer(p.parsed.properties, p.parsed.questions, answers);
    this.client.respond(p.id, res);
    if (this.wakeupTurn && this.pendingPermissions.size === 0 && this.pendingQuestions.size === 0) {
      this.scheduleWakeupFinish();
    }
    return true;
  }

  decidePlan(): boolean {
    return false;
  }
  compact(): boolean {
    if (
      this.closed ||
      this.loading ||
      !this.sessionId ||
      this.turn ||
      this.wakeupTurn ||
      this.parentTailer?.hasOpenTurn() ||
      this.draining ||
      this.queue.length > 0 ||
      this.compacting ||
      this.pendingPermissions.size > 0 ||
      this.pendingQuestions.size > 0
    ) {
      return false;
    }

    const done = deferred();
    const startedAt = Date.now();
    this.compacting = { done, startedAt };
    this.emit({ type: 'compaction.start' });
    const preTokens = this.usedTokens > 0 ? this.usedTokens : undefined;

    this.client
      .request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: '/compact' }] }, null)
      .then(
        (result) => {
          if (this.closed) return;
          if (stopReasonOf(result) === 'cancelled') {
            this.emit({
              type: 'compaction.end',
              ok: false,
              trigger: 'manual',
              durationMs: Date.now() - startedAt,
              error: 'cancelled',
            });
          } else {
            this.emit({
              type: 'compaction.end',
              ok: true,
              trigger: 'manual',
              durationMs: Date.now() - startedAt,
              ...(preTokens !== undefined ? { preTokens } : {}),
            });
          }
        },
        (error: unknown) => {
          if (this.closed) return;
          if (error instanceof AcpRpcError && typeof error.code === 'number') {
            this.emit({
              type: 'compaction.end',
              ok: false,
              trigger: 'manual',
              durationMs: Date.now() - startedAt,
              error: errorText(error),
            });
          } else {
            this.fatal(error);
          }
        },
      )
      .finally(async () => {
        await this.syncParentTailer();
        this.compacting = undefined;
        done.resolve();
        if (this.pendingRespawn && !this.closed) {
          await this.serial(async () => {
            if (this.pendingRespawn && !this.closed && !this.turn && !this.compacting) {
              await this.respawnTransport();
            }
          }).catch(() => undefined);
        }
        if (!this.closed && this.queue.length > 0) {
          void this.drain();
        }
      });

    return true;
  }
  async stopTask(): Promise<void> {}

  /**
   * `session/set_mode`: `default`→`default`, `acceptEdits`→`accept-edits`, `plan`→`plan`; `bypassPermissions`
   * при разрешении в настройках — перезапуск `agy acp --dangerously-skip-permissions` с прозрачным `session/resume`
   * (или отложенный перезапуск после активного хода) + `accept-edits`. Отказ сервера — нефатальный `error`.
   */
  async setMode(mode: PermissionMode): Promise<void> {
    const next = mode === 'bypassPermissions' && !this.allowBypass ? 'default' : mode;
    try {
      await this.ready;
    } catch {
      return;
    }
    await this.serial(async () => {
      if (this.closed || !this.sessionId) return;
      const wantBypass = next === 'bypassPermissions' && this.allowBypass;
      const needsRespawn = wantBypass !== this.spawnedBypass;
      if (needsRespawn && !this.turn && !this.compacting && !this.loading) {
        this.explicitMode = true;
        this.permissionMode = next;
        try {
          await this.respawnTransport();
        } catch {
          return;
        }
        if (this.closed) return;
        await this.saveSettings();
        this.emit({ type: 'mode.changed', mode: this.permissionMode });
        return;
      }

      const modeId = agyModeId(next, this.allowBypass);
      if (modeId !== this.serverMode) {
        try {
          await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId });
        } catch (error) {
          if (!this.closed)
            this.emit({ type: 'error', fatal: false, message: `session/set_mode failed: ${errorText(error)}` });
          return;
        }
        this.serverMode = modeId;
      }
      this.explicitMode = true;
      this.permissionMode = next;
      this.pendingRespawn = wantBypass !== this.spawnedBypass;
      if (wantBypass && this.pendingPermissions.size > 0) {
        for (const [toolUseId, p] of this.pendingPermissions) {
          this.client.respond(p.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
          this.emit({ type: 'permission.resolved', toolUseId, decision: 'allow', by: 'user' });
        }
        this.pendingPermissions.clear();
      }
      await this.saveSettings();
      this.emit({ type: 'mode.changed', mode: next });
    });
  }

  /** `session/set_config_option` `model`; затем, если у новой модели есть `thought_level`, — досылка желаемого уровня. */
  async setModel(model: string): Promise<void> {
    if (!model) return;
    try {
      await this.ready;
    } catch {
      return;
    }
    await this.serial(async () => {
      if (this.closed || !this.sessionId) return;
      const normalized = normalizeModel(model, this.config);
      try {
        await this.applyModel(normalized.model);
      } catch (error) {
        if (!this.closed) {
          this.emit({
            type: 'error',
            fatal: false,
            message: `session/set_config_option model failed: ${errorText(error)}`,
          });
          this.emit(this.buildSessionInit());
        }
        throw error;
      }
      if (normalized.effort) this.effort = normalized.effort;
      await this.syncEffort();
      await this.saveSettings();
      if (!this.closed) {
        this.emit(this.buildSessionInit());
        this.emit(buildAgyContextUsage(this.usedTokens, this.config.model?.current));
      }
    });
  }

  /**
   * Желаемый уровень запоминается всегда; `session/set_config_option` `thought_level` уходит, только если уровень
   * есть в актуальных `configOptions` (у `gpt-oss-120b-medium` селекта нет, сервер ответил бы `-32602`).
   */
  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    try {
      await this.ready;
    } catch {
      return;
    }
    await this.serial(async () => {
      if (this.closed || !this.sessionId) return;
      await this.syncEffort();
      await this.saveSettings();
    });
  }

  /**
   * Stop: сброс висящих запросов, `session/cancel` без id; процесс жив и принимает следующий ход.
   * Не дождались `stopReason` — закрываем зависший транспорт. До старта хода очередь снимается
   * синтетическим `turn.start` + `turn.result interrupted`.
   */
  async interrupt(): Promise<void> {
    this.generation++;
    this.abortPending();
    if (this.compacting && !this.compacting.done.settled && !this.closed) {
      try {
        this.client.notify('session/cancel', { sessionId: this.sessionId });
      } catch (error) {
        this.log('warn', `session/cancel failed: ${errorText(error)}`);
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.compacting.done.promise,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, this.interruptWaitMs))),
      ]);
      clearTimeout(timer);
      if (this.compacting && !this.compacting.done.settled && !this.closed) {
        this.log('warn', 'agy stopReason did not arrive after session/cancel');
        this.abandonTurn();
        this.fatal(new Error('Antigravity did not confirm cancellation; the connection was closed. Resume the session to continue.'));
      }
      return;
    }
    const turn = this.turn;
    if (!turn || turn.done.settled || this.closed) {
      if (this.wakeupTurn && !this.closed) {
        try {
          this.client.notify('session/cancel', { sessionId: this.sessionId });
        } catch (error) {
          this.log('warn', `session/cancel failed: ${errorText(error)}`);
        }
        const wt = this.wakeupTurn;
        if (wt.timer) clearTimeout(wt.timer);
        this.wakeupTurn = undefined;
        this.emitAll(this.mapper.abandon(wt.startedAt));
      } else if (this.parentTailer?.hasOpenTurn() && !this.closed) {
        try {
          this.client.notify('session/cancel', { sessionId: this.sessionId });
        } catch (error) {
          this.log('warn', `session/cancel failed: ${errorText(error)}`);
        }
        this.finishSilentTurn(true);
      }
      return;
    }
    try {
      this.client.notify('session/cancel', { sessionId: this.sessionId });
    } catch (error) {
      this.log('warn', `session/cancel failed: ${errorText(error)}`);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      turn.done.promise,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.interruptWaitMs))),
    ]);
    clearTimeout(timer);
    if (!turn.done.settled && !this.closed) {
      this.log('warn', 'agy stopReason did not arrive after session/cancel');
      this.abandonTurn();
      this.fatal(new Error('Antigravity did not confirm cancellation; the connection was closed. Resume the session to continue.'));
    }
  }

  capabilities(): Promise<SessionCapabilities> {
    return this.ready.then(
      () => ({ models: modelOptionsFrom(this.config), commands: [] }),
      () => ({ models: [], commands: [] }),
    );
  }

  async contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined> {
    try {
      await this.ready;
    } catch {
      return undefined;
    }
    if (this.closed || !this.sessionId) return undefined;
    const snap = await readLastTranscriptUsage(this.sessionId, this.config0.dataDir);
    if (snap && snap.stepIndex >= this.lastStepIndex) {
      this.lastStepIndex = snap.stepIndex;
      this.usedTokens = snap.usedTokens;
    }
    const model = this.config.model?.current;
    if (this.usedTokens > 0 || (model && agyContextWindow(model) !== undefined)) {
      return buildAgyContextUsage(this.usedTokens, model);
    }
    return undefined;
  }

  dispose(): void {
    if (this.closed) return;
    this.abortPending();
    this.abandonTurn();
    this.close('disposed');
    this.client.dispose();
    this.stopProcess();
  }

  // ---- внутреннее ------------------------------------------------------------------------------

  private spawnTransport(mode: PermissionMode): void {
    const bypass = mode === 'bypassPermissions' && this.allowBypass;
    const proc = (this.config0.spawn ?? defaultSpawn)(
      this.executable,
      agySpawnArgs(mode, this.allowBypass),
      {
        cwd: this.cwd,
        env: this.config0.env ?? process.env,
        shell: false,
      },
    );
    let exited = false;
    this.proc = proc;
    this.procExited = false;
    this.procExitCheck = () => exited;
    proc.on('exit', () => {
      exited = true;
      if (this.proc === proc) this.procExited = true;
    });
    const client: AcpRpcClient = new AcpRpcClient(proc, {
      engine: 'Antigravity',
      timeoutMs: this.config0.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => {
        if (this.client === client) this.onNotification(method, params);
      },
      onServerRequest: (id: RpcId, method: string, params: unknown): boolean =>
        this.client === client ? this.onServerRequest(id, method, params) : false,
      onStderr: (line) => this.log('debug', `agy: ${line}`),
      onClose: (error) => {
        if (this.client === client) this.onClientClose(client, error.message);
      },
    });
    this.client = client;
    this.spawnedBypass = bypass;
  }

  /**
   * Прозрачная ротация процесса `agy acp` при смене `--dangerously-skip-permissions`: закрывает старый процесс
   * без `session.closed`, поднимает новый и выполняет `session/resume` на том же `sessionId` с сохранением
   * `model`, `effort` и `modeId`.
   */
  private async respawnTransport(): Promise<void> {
    if (this.closed || !this.sessionId) return;
    this.finishWakeupTurn();
    this.finishSilentTurn(false);
    const targetMode = this.permissionMode;
    const desiredModel = this.config.model?.current;
    const currentThought = this.config.thoughtLevel?.current;
    if (!this.effort && currentThought && isEffort(currentThought)) {
      this.effort = currentThought;
    }

    const oldProc = this.proc;
    const oldClient = this.client;
    const oldExitCheck = this.procExitCheck;
    const readyDeferred = deferred();
    this.ready = readyDeferred.promise;
    this.loading = true;
    this.pendingRespawn = false;

    const waitOldExit = oldExitCheck()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.graceMs);
          timer.unref?.();
          oldProc.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
    oldClient.dispose();
    shutdownAgy(oldProc, this.graceMs, oldExitCheck);
    await waitOldExit;
    if (this.closed) {
      this.loading = false;
      readyDeferred.resolve();
      return;
    }

    try {
      this.spawnTransport(targetMode);
      const init = await this.client.request('initialize', initializeParams(this.config0));
      if (this.closed) return;
      this.agentVersion = agentVersionOf(init) ?? this.agentVersion;
      const result = await this.client.request('session/resume', {
        sessionId: this.sessionId,
        cwd: this.cwd,
        mcpServers: [],
      });
      if (this.closed) return;
      this.config = parseConfig(result);
      this.serverMode = currentModeId(result) ?? 'default';
      this.onTier(tierNameOf(result));
      if (desiredModel) {
        const normalized = normalizeModel(desiredModel, this.config);
        if (normalized.effort && !this.effort) this.effort = normalized.effort;
        try {
          await this.applyModel(normalized.model);
        } catch (error) {
          if (!this.closed) this.log('warn', `agy: respawn applyModel failed: ${errorText(error)}`);
        }
      }
      if (this.closed) return;
      await this.syncEffort();
      if (this.closed) return;
      try {
        await this.syncInitialMode();
      } catch (error) {
        if (this.closed) return;
        this.emit({ type: 'error', fatal: false, message: `session/set_mode failed: ${errorText(error)}` });
        this.permissionMode = permissionModeOf(this.serverMode);
      }
      await this.syncParentTailer();
      if (this.parentToolReader) {
        const toolSnap = await this.parentToolReader.syncToEnd();
        if (this.closed) return;
        if (toolSnap.modelSettings) this.transcriptModelFallback = toolSnap.modelSettings;
      }
      this.loading = false;
      readyDeferred.resolve();
    } catch (error) {
      this.loading = false;
      readyDeferred.resolve();
      this.fatal(error);
      throw error;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settings.then(fn, fn);
    this.settings = run.catch(() => undefined);
    return run;
  }

  private async handshake(requestedModel: string | undefined): Promise<void> {
    const init = await this.client.request('initialize', initializeParams(this.config0));
    this.agentVersion = agentVersionOf(init);
    const result = this.resumeId
      ? await this.client.request('session/resume', { sessionId: this.resumeId, cwd: this.cwd, mcpServers: [] })
      : await this.client.request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (this.closed) return;
    const sessionId = this.resumeId ?? sessionIdOf(result);
    if (!sessionId) throw new Error('Antigravity ACP session/new returned no sessionId.');
    this.sessionId = sessionId;
    this.config = parseConfig(result);
    this.serverMode = currentModeId(result) ?? 'default';
    if (!this.explicitMode) {
      this.permissionMode = permissionModeOf(this.serverMode);
    }
    this.onTier(tierNameOf(result));
    // `load` и `resume` не восстанавливают model / thought_level / mode: применяем явно то, что просили
    if (requestedModel) {
      const normalized = normalizeModel(requestedModel, this.config);
      if (normalized.effort && !this.effort) this.effort = normalized.effort;
      try {
        await this.applyModel(normalized.model);
      } catch (error) {
        if (!this.closed) this.log('warn', `agy: initial applyModel failed: ${errorText(error)}`);
      }
    }
    if (this.closed) return;
    await this.syncEffort();
    if (this.closed) return;
    try {
      await this.syncInitialMode();
    } catch (error) {
      if (this.closed) return;
      this.emit({ type: 'error', fatal: false, message: `session/set_mode failed: ${errorText(error)}` });
      this.permissionMode = permissionModeOf(this.serverMode);
    }
    if (this.closed) return;
    await this.saveSettings();
    if (this.closed) return;
    this.loading = false;
    this.emit(this.buildSessionInit());
    const snap = await readLastTranscriptUsage(sessionId, this.config0.dataDir);
    if (this.closed) return;
    if (snap) {
      this.lastStepIndex = snap.stepIndex;
      this.usedTokens = snap.usedTokens;
    }
    this.parentTailer = new AgyParentTranscriptTailer(
      sessionId,
      this.config0.dataDir,
      this.mcpServers,
    );
    const tailSnap = await this.parentTailer.syncToEnd();
    if (this.closed) return;
    if (tailSnap.maxStepIndex > this.lastStepIndex) {
      this.lastStepIndex = tailSnap.maxStepIndex;
      if (tailSnap.usedTokens !== undefined) this.usedTokens = tailSnap.usedTokens;
    }
    this.parentToolReader = new AgyParentToolOutputReader(sessionId, this.config0.dataDir);
    const toolSnap = await this.parentToolReader.syncToEnd();
    if (this.closed) return;
    if (toolSnap.modelSettings) {
      this.transcriptModelFallback = toolSnap.modelSettings;
    }
    const activeModel = this.config.model?.current ?? requestedModel;
    if (this.usedTokens > 0 || (activeModel && agyContextWindow(activeModel) !== undefined)) {
      this.emit(buildAgyContextUsage(this.usedTokens, activeModel));
    }
  }

  private buildSessionInit(): AgentEventOf<'session.init'> {
    const effort = this.config.thoughtLevel?.current;
    return {
      type: 'session.init',
      sessionId: this.sessionId,
      model: this.config.model?.current ?? '',
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      tools: [],
      slashCommands: [...this.slashCommands],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: this.engineVersion(),
      ...(effort && isEffort(effort) ? { effort } : {}),
    };
  }

  private async saveSettings(): Promise<void> {
    const model = this.config.model?.current;
    const effort = this.config.thoughtLevel?.current;
    const persistMode = this.explicitMode || this.serverMode !== 'auto';
    const settings: AgySessionSettings = {
      ...(persistMode ? { permissionMode: this.permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(effort && isEffort(effort) ? { effort } : {}),
    };
    try {
      await this.index.saveSettings(this.sessionId, settings);
    } catch (error) {
      this.log('warn', `agy: could not save session settings: ${errorText(error)}`);
    }
  }

  private engineVersion(): string {
    const setting = this.config0.engineVersion;
    const configured = typeof setting === 'function' ? setting() : setting;
    return configured ?? this.agentVersion ?? '';
  }

  /** Ответ `set_config_option` — полный `configOptions`: актуальные селекты и текущие значения. */
  private absorb(result: unknown): void {
    if (!Array.isArray(record(result)?.configOptions)) return;
    this.config = mergeConfig(this.config, parseConfig(result));
  }

  private async applyModel(model: string): Promise<void> {
    if (this.config.model?.current === model) return;
    try {
      this.absorb(
        await this.client.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: 'model',
          value: model,
        }),
      );
    } catch (error) {
      if (!this.closed) this.log('warn', `session/set_config_option model failed: ${errorText(error)}`);
      throw error;
    }
  }

  private async syncEffort(): Promise<void> {
    const want = this.effort;
    const select = this.config.thoughtLevel;
    if (!want || !select || !select.values.some((v) => v.value === want) || select.current === want) return;
    try {
      this.absorb(
        await this.client.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: 'thought_level',
          value: want,
        }),
      );
    } catch (error) {
      if (!this.closed) this.log('warn', `session/set_config_option thought_level failed: ${errorText(error)}`);
    }
  }

  /** Догнать сервер до запрошенного режима при старте (не сбивая серверный `'auto'` без явного выбора режима). */
  private async syncInitialMode(): Promise<void> {
    if (!this.explicitMode && this.serverMode === 'auto') return;
    const want = agyModeId(this.permissionMode, this.allowBypass);
    if (this.serverMode === want) return;
    await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId: want });
    this.serverMode = want;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        if (this.compacting) {
          await this.compacting.done.promise;
          if (this.closed) break;
        }
        const item = this.queue.shift();
        if (item === undefined) break;
        const generation = this.generation;
        try {
          await this.ready;
        } catch {
          // handshake уже закрыл сессию через fatal
          break;
        }
        if (this.closed) break;
        if (generation !== this.generation) {
          this.emitAll(this.mapper.interruptBeforeStart(item.text));
          continue;
        }
        this.finishWakeupTurn();
        this.finishSilentTurn(false);
        const startedAt = Date.now();
        const done = deferred();
        const prevStep = this.lastStepIndex;
        this.turn = { done, startedAt, prevStep, toolCalls: 0 };
        this.emitAll(this.mapper.startTurn(item.text, startedAt, item.images));
        try {
          // В `agy acp` при активном фоновом ожидании (`schedule`) сервер удерживает `session/prompt` открытым
          // (`HoldOwnedTurn`) до ответного шага родителя; внеходовой push также поддержан через `wakeupTurn`.
          const result = await this.client.request(
            'session/prompt',
            { sessionId: this.sessionId, prompt: promptBlocks(item.text, item.images) },
            null,
          );
          if (this.closed) break;
          if (this.turn === undefined || this.turn.done.settled) continue;

          const toolCallsCount = this.turn.toolCalls;
          let snap = await readLastTranscriptUsage(this.sessionId, this.config0.dataDir);
          if (!snap || snap.stepIndex <= prevStep) {
            for (let retry = 0; retry < 2 && !this.closed; retry++) {
              await new Promise((r) => setTimeout(r, 80));
              if (this.closed) break;
              snap = await readLastTranscriptUsage(this.sessionId, this.config0.dataDir);
              if (snap && snap.stepIndex > prevStep) break;
            }
          }
          if (this.closed) break;
          if (this.turn === undefined || this.turn.done.settled) continue;

          if (snap && snap.stepIndex > prevStep) {
            this.lastStepIndex = snap.stepIndex;
            this.usedTokens = snap.usedTokens;
            this.emit(buildAgyContextUsage(this.usedTokens, this.config.model?.current));
          } else if (toolCallsCount === 0) {
            const single = singleStepUsageTokens(usageOf(result));
            if (single !== undefined) {
              this.usedTokens = single;
              this.emit(buildAgyContextUsage(this.usedTokens, this.config.model?.current));
            }
          }

          await this.syncParentTailer();
          if (this.closed) break;
          if (this.turn === undefined || this.turn.done.settled) continue;

          this.emitAll(this.mapper.finish(result, startedAt));
          done.resolve();
        } catch (error) {
          if (this.closed || done.settled) break;
          // сервер ответил ошибкой на ход (квота, модель отказала): ход закрыт, процесс и очередь живы
          if (error instanceof AcpRpcError && typeof error.code === 'number') {
            await this.syncParentTailer();
            const message = errorText(error);
            this.emit({ type: 'error', fatal: false, message, code: String(error.code) });
            this.emitAll(this.mapper.failOpen(startedAt, Date.now(), message));
            done.resolve();
          } else {
            this.fatal(error);
            break;
          }
        } finally {
          if (this.turn?.done === done) this.turn = undefined;
          if (!this.closed) this.refreshSubagentPoller();
        }
        if (this.pendingRespawn && !this.closed) {
          try {
            await this.serial(async () => {
              if (this.pendingRespawn && !this.closed && !this.turn && !this.compacting) {
                await this.respawnTransport();
              }
            });
          } catch {
            break;
          }
        }
      }
    } finally {
      this.draining = false;
      if (!this.closed && this.queue.length) void this.drain();
    }
  }

  private checkTranscriptDuringTurn(): void {
    if (this.transcriptCheckInProgress || this.closed || !this.sessionId) return;
    this.transcriptCheckInProgress = true;
    readLastTranscriptUsage(this.sessionId, this.config0.dataDir)
      .then((snap) => {
        const activeTurn = (this.turn && !this.turn.done.settled) || Boolean(this.wakeupTurn);
        if (this.closed || !activeTurn) return;
        if (snap && snap.stepIndex > this.lastStepIndex) {
          this.lastStepIndex = snap.stepIndex;
          this.usedTokens = snap.usedTokens;
          this.emit(buildAgyContextUsage(this.usedTokens, this.config.model?.current));
        }
      })
      .catch(() => {})
      .finally(() => {
        this.transcriptCheckInProgress = false;
      });
  }

  private scheduleWakeupFinish(): void {
    const wt = this.wakeupTurn;
    if (!wt) return;
    if (wt.timer) clearTimeout(wt.timer);
    const seq = wt.seq;
    wt.timer = setTimeout(() => {
      void this.onWakeupIdle(wt, seq);
    }, this.wakeupIdleMs);
    wt.timer.unref?.();
  }

  private async onWakeupIdle(
    wt: NonNullable<AgySession['wakeupTurn']>,
    seq: number,
  ): Promise<void> {
    if (this.closed || this.wakeupTurn !== wt || wt.seq !== seq) return;
    if (this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0) {
      this.scheduleWakeupFinish();
      return;
    }
    const snap = await readLastTranscriptUsage(this.sessionId, this.config0.dataDir);
    if (this.closed || this.wakeupTurn !== wt || wt.seq !== seq) return;
    if (snap && snap.stepIndex > wt.prevStep) {
      this.lastStepIndex = snap.stepIndex;
      this.usedTokens = snap.usedTokens;
      this.emit(buildAgyContextUsage(this.usedTokens, this.config.model?.current));
    }
    await this.syncParentTailer();
    if (this.closed || this.wakeupTurn !== wt || wt.seq !== seq) return;
    this.finishWakeupTurn();
    this.refreshSubagentPoller();
  }

  private finishWakeupTurn(): void {
    const wt = this.wakeupTurn;
    if (!wt) return;
    if (wt.timer) clearTimeout(wt.timer);
    this.wakeupTurn = undefined;
    this.emitAll(this.mapper.finish({ stopReason: 'end_turn' }, wt.startedAt));
  }

  private onNotification(method: string, params: unknown): void {
    if (this.closed || method !== 'session/update') return;
    const row = record(params);
    const incomingSessionId = typeof row?.sessionId === 'string' ? row.sessionId : undefined;
    const knownSessionId = this.sessionId || this.resumeId;
    if (incomingSessionId && knownSessionId && incomingSessionId !== knownSessionId) return;

    const update = row?.update;
    const kind = sessionUpdateKind(update);
    if (kind === 'available_commands_update') {
      const next = availableCommandsOf(update);
      if (next && !sameStrings(this.slashCommands, next)) {
        this.slashCommands = next;
        if (!this.loading) this.emit(this.buildSessionInit());
      }
      return;
    }

    if (this.loading) return;

    if (kind === 'session_info_update') {
      const title = sessionTitleOf(update);
      if (title) this.emit({ type: 'session.title', title });
      return;
    }

    const turn = this.turn;
    if (turn && !turn.done.settled) {
      if (kind === 'tool_call') {
        turn.toolCalls++;
        this.checkTranscriptDuringTurn();
      }
      this.emitAll(this.mapper.applyUpdate(update));
      return;
    }

    if (this.compacting || !isSubstantiveTurnUpdate(kind, update)) return;

    if (!this.wakeupTurn) {
      this.finishSilentTurn(false);
      const startedAt = Date.now();
      this.mapper.startTurn('', startedAt);
      this.wakeupTurn = {
        startedAt,
        prevStep: this.lastStepIndex,
        seq: 0,
        timer: undefined,
      };
      this.emit({ type: 'turn.start', at: startedAt });
    }
    this.wakeupTurn.seq++;
    if (kind === 'tool_call') {
      this.checkTranscriptDuringTurn();
    }
    this.emitAll(this.mapper.applyUpdate(update));
    this.scheduleWakeupFinish();
  }

  private onClientClose(client: AcpRpcClient, message: string): void {
    if (this.closed || this.client !== client) return;
    if (message === client.disposedMessage) return;
    const exited = this.procExited || /stdout closed|ACP exited|ACP closed/.test(message);
    this.fatal(new Error(message), exited ? 'exit' : 'error');
  }

  private onServerRequest(id: RpcId, method: string, params: unknown): boolean {
    try {
      if (method === PERMISSION_METHOD) {
        return this.handlePermissionRequest(id, params);
      }
      if (method === ELICITATION_METHOD) {
        return this.handleElicitationRequest(id, params);
      }
      return false;
    } catch (error) {
      this.log('warn', `agy: ${method} failed: ${errorText(error)}`);
      return false;
    }
  }

  private handlePermissionRequest(id: RpcId, params: unknown): boolean {
    if (this.permissionMode === 'bypassPermissions' && this.allowBypass) {
      this.client.respond(id, { outcome: { outcome: 'selected', optionId: 'allow' } });
      return true;
    }
    const call = record(record(params)?.toolCall);
    const toolUseId = typeof call?.toolCallId === 'string' ? call.toolCallId : String(id);
    const rawName = toolName(call ?? {});
    const rawInput = toolInput(call ?? {});
    const mapped = mapAgyTool(rawName, rawInput, this.mcpServers);
    const title = typeof call?.title === 'string' ? call.title : undefined;

    let diff: DiffPreview | undefined;
    if (mapped.name === 'Edit') {
      const filePath = typeof mapped.input['file_path'] === 'string' ? mapped.input['file_path'] : '';
      const oldText = typeof mapped.input['old_string'] === 'string' ? mapped.input['old_string'] : '';
      const newText = typeof mapped.input['new_string'] === 'string' ? mapped.input['new_string'] : '';
      if (filePath) {
        diff = { kind: 'edit', filePath, oldText, newText, replaceAll: mapped.input['replaceAll'] === true };
      }
    } else if (mapped.name === 'Write') {
      const filePath = typeof mapped.input['file_path'] === 'string' ? mapped.input['file_path'] : '';
      const content = typeof mapped.input['content'] === 'string' ? mapped.input['content'] : '';
      if (filePath) {
        diff = { kind: 'write', filePath, content };
      }
    }

    this.pendingPermissions.set(toolUseId, { id, toolUseId });
    this.emit({
      type: 'permission.request',
      toolUseId,
      toolName: mapped.name,
      input: mapped.input,
      canAlwaysAllow: false,
      ...(title ? { title, description: title } : { description: mapped.name }),
      ...(diff ? { diff } : {}),
    });
    return true;
  }

  private handleElicitationRequest(id: RpcId, params: unknown): boolean {
    const row = record(params);
    const toolUseId = typeof row?.toolCallId === 'string' ? row.toolCallId : String(id);
    const parsed = parseElicitation(params);
    if (!parsed || parsed.questions.length === 0) {
      this.client.respond(id, elicitationDecline());
      return true;
    }
    this.pendingQuestions.set(toolUseId, { id, toolUseId, parsed });
    this.emit({
      type: 'question.request',
      toolUseId,
      questions: parsed.questions,
    });
    return true;
  }

  private abortPending(): void {
    for (const [toolUseId, p] of this.pendingPermissions) {
      try {
        this.client.respond(p.id, { outcome: { outcome: 'selected', optionId: 'deny' } });
      } catch {
        // client may be closed
      }
      this.emit({
        type: 'permission.resolved',
        toolUseId,
        decision: 'deny',
        by: 'abort',
      });
    }
    this.pendingPermissions.clear();

    for (const [, q] of this.pendingQuestions) {
      try {
        this.client.respond(q.id, { action: 'cancel' });
      } catch {
        // client may be closed
      }
    }
    this.pendingQuestions.clear();
  }

  /** Процесс умер посреди хода: `turn.result` (ok false), `error` fatal, `session.closed`. */
  private fatal(error: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    const message = errorText(error);
    this.log('error', `agy session failed: ${message}`);
    this.abortPending();
    if (this.compacting && !this.compacting.done.settled) {
      this.compacting.done.resolve();
      this.compacting = undefined;
    }
    const turn = this.turn;
    if (turn && !turn.done.settled) {
      this.emitAll(this.mapper.failOpen(turn.startedAt));
      turn.done.resolve();
      this.turn = undefined;
    } else if (this.wakeupTurn) {
      const wt = this.wakeupTurn;
      if (wt.timer) clearTimeout(wt.timer);
      this.wakeupTurn = undefined;
      this.emitAll(this.mapper.failOpen(wt.startedAt));
    } else if (this.parentTailer?.hasOpenTurn()) {
      this.finishSilentTurn(true);
    }
    this.emit({ type: 'error', fatal: true, message });
    this.close(reason, message);
    this.client.dispose();
    this.stopProcess();
  }

  private abandonTurn(): void {
    if (this.compacting) {
      this.compacting.done.resolve();
      this.compacting = undefined;
    }
    const turn = this.turn;
    if (turn && !turn.done.settled) {
      turn.done.resolve();
      this.emitAll(this.mapper.abandon(turn.startedAt));
      return;
    }
    if (this.wakeupTurn) {
      const wt = this.wakeupTurn;
      if (wt.timer) clearTimeout(wt.timer);
      this.wakeupTurn = undefined;
      this.emitAll(this.mapper.abandon(wt.startedAt));
      return;
    }
    if (this.parentTailer?.hasOpenTurn()) {
      this.finishSilentTurn(true);
    }
  }

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSubagentPoller();
    this.subagentReaders.clear();
    this.parentToolStarts.clear();
    this.pendingParentToolResolutions.length = 0;
    this.parentToolReader?.clearUnclaimed();
    this.parentTailer?.discardOpenTurn();
    this.queue.length = 0;
    this.turn?.done.resolve();
    if (this.wakeupTurn) {
      if (this.wakeupTurn.timer) clearTimeout(this.wakeupTurn.timer);
      this.wakeupTurn = undefined;
    }
    if (this.compacting) {
      this.compacting.done.resolve();
      this.compacting = undefined;
    }
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  private async syncParentTailer(): Promise<void> {
    if (!this.parentTailer || this.closed) return;
    const snap = await this.parentTailer.syncToEnd();
    if (this.closed) return;
    if (snap.maxStepIndex > this.lastStepIndex) {
      this.lastStepIndex = snap.maxStepIndex;
      if (snap.usedTokens !== undefined) {
        this.usedTokens = snap.usedTokens;
      }
    }
  }

  private finishSilentTurn(interrupted: boolean): void {
    if (!this.parentTailer?.hasOpenTurn()) return;
    this.emitAll(this.parentTailer.flushOpenTurn(interrupted));
  }

  private hasActiveSubagents(): boolean {
    for (const reader of this.subagentReaders.values()) {
      if (reader.isActive()) return true;
    }
    return false;
  }

  private shouldPollSubagents(): boolean {
    if (this.closed) return false;
    if (this.pendingParentToolResolutions.length > 0) return true;
    if (this.hasActiveSubagents()) return true;
    if (this.parentTailer?.hasOpenTurn()) return true;
    if (Date.now() < this.silentWatchUntil) return true;
    return false;
  }

  private ensureSubagentPoller(immediate = false): void {
    if (this.closed) return;
    if (!this.subagentTimer) {
      this.subagentTimer = setInterval(() => {
        void this.pollSubagentsOnce();
      }, this.subagentPollMs);
      this.subagentTimer.unref?.();
    }
    if (immediate) {
      void this.pollSubagentsOnce();
    }
  }

  private scheduleFastParentToolRetry(): void {
    if (this.closed || this.parentToolRetryTimer || this.pendingParentToolResolutions.length === 0) {
      return;
    }
    this.parentToolRetryTimer = setTimeout(() => {
      this.parentToolRetryTimer = undefined;
      if (!this.closed) void this.pollSubagentsOnce();
    }, PARENT_TOOL_FAST_RETRY_MS);
    this.parentToolRetryTimer.unref?.();
  }

  private refreshSubagentPoller(): void {
    if (this.shouldPollSubagents()) {
      this.ensureSubagentPoller(false);
      if (this.pendingParentToolResolutions.length > 0) {
        this.scheduleFastParentToolRetry();
      }
    } else {
      this.stopSubagentPoller();
    }
  }

  private stopSubagentPoller(): void {
    if (this.subagentTimer) {
      clearInterval(this.subagentTimer);
      this.subagentTimer = undefined;
    }
    if (this.parentToolRetryTimer) {
      clearTimeout(this.parentToolRetryTimer);
      this.parentToolRetryTimer = undefined;
    }
    this.subagentPollQueued = false;
  }

  private currentParentModel(): string | undefined {
    return this.config.model?.current || this.transcriptModelFallback?.model;
  }

  private currentParentEffort(): EffortLevel | undefined {
    const th = this.config.thoughtLevel?.current;
    if (th && isEffort(th)) return th;
    if (this.config.thoughtLevel && this.effort) return this.effort;
    return this.transcriptModelFallback?.effort;
  }

  private pickInputStr(input: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  }

  private launchSubagentReader(
    toolUseId: string,
    childUuid: string,
    input: Record<string, unknown>,
    startedAt: number | undefined,
  ): void {
    const normUuid = childUuid.toLowerCase();
    if (this.subagentReaders.has(normUuid)) return;

    const subagentType = this.pickInputStr(input, 'subagent_type', 'TypeName');
    const description =
      this.pickInputStr(input, 'description', 'Role') ?? subagentType ?? 'subagent';
    const prompt = this.pickInputStr(input, 'prompt', 'Prompt');
    const rawModel = this.pickInputStr(input, 'model', 'Model');
    const resolved = resolveAgySubagentModelEffort(
      rawModel,
      this.currentParentModel(),
      this.currentParentEffort(),
    );

    this.onSubagentMeta(normUuid, {
      description,
      ...(subagentType ? { agentType: subagentType } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.reasoningEffort ? { effort: resolved.reasoningEffort } : {}),
    });

    const reportSummary = this.parentToolReader?.reportOf(normUuid);
    const reader = new AgySubagentReader({
      agentId: toolUseId,
      childUuid: normUuid,
      ...(this.config0.dataDir ? { dataDir: this.config0.dataDir } : {}),
      mcpServers: this.mcpServers,
      ...(this.sessionId ? { parentSessionId: this.sessionId } : {}),
      description,
      ...(subagentType ? { subagentType } : {}),
      ...(prompt ? { prompt } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
      ...(reportSummary ? { reportSummary } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      waitingThresholdMs: this.subagentWaitingMs,
      onSubagentMeta: (uuid, meta) => this.onSubagentMeta(uuid, meta),
    });
    this.subagentReaders.set(normUuid, reader);
    this.emit(reader.buildStartEvent(startedAt));
    this.silentWatchUntil = Math.max(this.silentWatchUntil, Date.now() + SILENT_WAKEUP_WATCH_MS);
  }

  private applyManagedSubagents(managed: ManagedSubagentsResult, at: number | undefined): void {
    if (managed.action === 'list') {
      for (const id of managed.waitingIds) {
        for (const reader of this.subagentReaders.values()) {
          const evs = reader.markWaitingByUuid(id, at);
          if (evs.length > 0) this.emitAll(evs);
        }
      }
    } else if (managed.action === 'kill_all') {
      for (const reader of this.subagentReaders.values()) {
        if (!reader.isStopped()) {
          this.emitAll(reader.stopAll(at));
        }
      }
      this.refreshSubagentPoller();
    } else if (managed.action === 'kill') {
      for (const id of managed.killedIds) {
        for (const reader of this.subagentReaders.values()) {
          const evs = reader.stopByUuid(id, at);
          if (evs.length > 0) this.emitAll(evs);
        }
      }
      this.refreshSubagentPoller();
    }
  }

  private async pollParentToolOutputs(): Promise<void> {
    if (!this.parentToolReader || this.closed) return;
    if (this.pendingParentToolResolutions.length === 0 && this.subagentReaders.size === 0) {
      return;
    }

    const polled = await this.parentToolReader.poll();
    if (this.closed) return;
    if (polled.modelSettings) {
      this.transcriptModelFallback = polled.modelSettings;
    }
    for (const rep of polled.freshReports) {
      this.subagentReaders.get(rep.childUuid)?.noteParentReport(rep.summary);
    }

    if (this.pendingParentToolResolutions.length === 0) return;

    const now = Date.now();
    this.pendingParentToolResolutions.sort((a, b) => a.seq - b.seq);
    const remaining: typeof this.pendingParentToolResolutions = [];

    for (const item of this.pendingParentToolResolutions) {
      if (this.closed) return;
      if (item.kind === 'agent') {
        const query = {
          subagentType: this.pickInputStr(item.input, 'subagent_type', 'TypeName'),
          description: this.pickInputStr(item.input, 'description', 'Role'),
          prompt: this.pickInputStr(item.input, 'prompt', 'Prompt'),
        };
        const earlierAgentInputs = [
          ...[...this.parentToolStarts.values()]
            .filter((s) => s.name === 'Agent' && s.seq < item.seq)
            .map((s) => s.input),
          ...remaining
            .filter((p) => p.kind === 'agent' && p.seq < item.seq)
            .map((p) => p.input),
        ];
        const sameEarlier = earlierAgentInputs.some(
          (inp) =>
            this.pickInputStr(inp, 'subagent_type', 'TypeName') === query.subagentType &&
            this.pickInputStr(inp, 'description', 'Role') === query.description &&
            this.pickInputStr(inp, 'prompt', 'Prompt') === query.prompt,
        );
        const matched = sameEarlier
          ? undefined
          : this.parentToolReader.claimInvoke(query, earlierAgentInputs.length === 0);
        if (matched) {
          if (!item.isError && !matched.isError && matched.childUuid) {
            this.launchSubagentReader(
              item.toolUseId,
              matched.childUuid,
              item.input,
              item.at ?? matched.at,
            );
          }
          continue;
        }
      } else {
        const action = this.pickInputStr(item.input, 'Action', 'action')?.toLowerCase();
        const hasEarlierManage =
          [...this.parentToolStarts.values()].some(
            (s) => s.name === 'manage_subagents' && s.seq < item.seq,
          ) || remaining.some((p) => p.kind === 'manage' && p.seq < item.seq);
        const matched = this.parentToolReader.claimManage(action, !hasEarlierManage);
        if (matched) {
          if (!item.isError && !matched.isError) {
            const managed = parseManagedSubagents(item.input, matched.content, false);
            this.applyManagedSubagents(managed, item.at ?? matched.at);
          }
          continue;
        }
      }

      if (now - item.queuedAt < PARENT_TOOL_RESOLVE_TTL_MS) {
        remaining.push(item);
      }
    }

    this.pendingParentToolResolutions.length = 0;
    this.pendingParentToolResolutions.push(...remaining);
  }

  private async pollSubagentsOnce(): Promise<void> {
    if (this.closed) {
      this.stopSubagentPoller();
      return;
    }
    if (this.subagentPollInFlight) {
      this.subagentPollQueued = true;
      return;
    }
    this.subagentPollInFlight = true;
    try {
      await this.pollParentToolOutputs();
      if (this.closed) return;

      let sawAgentEnd = false;
      for (const reader of this.subagentReaders.values()) {
        if (this.closed) break;
        if (reader.isStopped()) continue;
        const evs = await reader.poll();
        if (this.closed) break;
        for (const ev of evs) {
          if (ev.type === 'agent.end' && !reader.isStopped()) {
            sawAgentEnd = true;
          }
          this.emit(ev);
        }
      }
      if (sawAgentEnd) {
        this.silentWatchUntil = Math.max(this.silentWatchUntil, Date.now() + SILENT_WAKEUP_WATCH_MS);
      }

      const anyActive = this.hasActiveSubagents();
      const shouldWatchParent =
        anyActive || Boolean(this.parentTailer?.hasOpenTurn()) || Date.now() < this.silentWatchUntil;
      const parentIdle =
        !this.closed &&
        !this.loading &&
        !this.turn &&
        !this.wakeupTurn &&
        !this.compacting &&
        this.queue.length === 0;

      if (shouldWatchParent && parentIdle && this.parentTailer) {
        const res = await this.parentTailer.pollSilentTurn(
          this.lastStepIndex,
          this.config.model?.current,
        );
        if (
          !this.closed &&
          !this.loading &&
          !this.turn &&
          !this.wakeupTurn &&
          !this.compacting &&
          this.queue.length === 0
        ) {
          if (res.lastStepIndex > this.lastStepIndex) {
            this.lastStepIndex = res.lastStepIndex;
          }
          if (res.usedTokens !== undefined) {
            this.usedTokens = res.usedTokens;
          }
          if (res.events.length > 0) {
            this.emitAll(res.events);
          }
          if (res.completedTurn && !this.hasActiveSubagents()) {
            this.silentWatchUntil = 0;
          }
        } else if (this.parentTailer.hasOpenTurn()) {
          this.parentTailer.discardOpenTurn();
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.log('debug', `agy: subagent poll failed: ${errorText(error)}`);
      }
    } finally {
      this.subagentPollInFlight = false;
      if (this.closed) {
        this.stopSubagentPoller();
      } else if (this.subagentPollQueued) {
        this.subagentPollQueued = false;
        void this.pollSubagentsOnce();
      } else {
        this.refreshSubagentPoller();
      }
    }
  }

  private handleParentToolEvent(event: AgentEvent): void {
    if (this.closed) return;
    if (event.type === 'tool.start' && !event.agentId) {
      this.parentToolStarts.set(event.toolUseId, {
        name: event.name,
        input: event.input,
        seq: ++this.parentToolSeq,
        ...(event.at !== undefined ? { at: event.at } : {}),
      });
      return;
    }
    if (event.type !== 'tool.result' || event.agentId) return;
    const started = this.parentToolStarts.get(event.toolUseId);
    this.parentToolStarts.delete(event.toolUseId);
    if (!started) return;

    const { name, input, seq } = started;
    const startedAt = started.at ?? event.at;
    if (name === 'Agent') {
      if (event.isError) {
        this.pendingParentToolResolutions.push({
          kind: 'agent',
          toolUseId: event.toolUseId,
          seq,
          input,
          ...(startedAt !== undefined ? { at: startedAt } : {}),
          isError: true,
          queuedAt: Date.now(),
        });
        this.ensureSubagentPoller(true);
        return;
      }
      const childUuid = parseCreatedSubagent(event.content);
      if (childUuid) {
        this.parentToolReader?.claimByChildUuid(childUuid);
        this.launchSubagentReader(event.toolUseId, childUuid, input, startedAt);
        this.ensureSubagentPoller(true);
        return;
      }
      // В реальном `agy acp` `tool_call_update` для `invoke_subagent` не содержит `rawOutput`:
      // `conversationId` дочитывается из родительского `transcript.jsonl` (`GENERIC`).
      this.pendingParentToolResolutions.push({
        kind: 'agent',
        toolUseId: event.toolUseId,
        seq,
        input,
        ...(startedAt !== undefined ? { at: startedAt } : {}),
        isError: false,
        queuedAt: Date.now(),
      });
      this.ensureSubagentPoller(true);
      return;
    }

    if (name === 'send_message' && !event.isError) {
      const recipient = this.pickInputStr(input, 'Recipient', 'recipient') ?? '';
      const msg = this.pickInputStr(input, 'Message', 'message');
      if (isValidAgyUuid(recipient)) {
        for (const reader of this.subagentReaders.values()) {
          const reopened = reader.reopenByUuid(recipient, event.at, msg);
          if (reopened.length > 0) {
            this.emitAll(reopened);
            this.silentWatchUntil = Math.max(
              this.silentWatchUntil,
              Date.now() + SILENT_WAKEUP_WATCH_MS,
            );
            this.ensureSubagentPoller(true);
            break;
          }
        }
      }
      return;
    }

    if (name === 'manage_subagents') {
      if (event.content.trim() !== '' || event.isError) {
        const managed = parseManagedSubagents(input, event.content, event.isError);
        this.applyManagedSubagents(managed, event.at);
        return;
      }
      const immediate = parseManagedSubagents(input, '', false);
      if (
        immediate.action === 'kill_all' ||
        (immediate.action === 'kill' && immediate.killedIds.length > 0)
      ) {
        this.applyManagedSubagents(immediate, event.at);
      }
      this.pendingParentToolResolutions.push({
        kind: 'manage',
        toolUseId: event.toolUseId,
        seq,
        input,
        ...(event.at !== undefined ? { at: event.at } : {}),
        isError: false,
        queuedAt: Date.now(),
      });
      this.ensureSubagentPoller(true);
    }
  }

  /** `stdin.end()`, grace, SIGTERM, ещё grace, SIGKILL. */
  private stopProcess(): void {
    shutdownAgy(this.proc, this.graceMs, this.procExitCheck);
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
    this.handleParentToolEvent(event);
  }

  private emitAll(events: AgentEvent[]): void {
    for (const event of events) this.emit(event);
  }
}

/** `stdin.end()` (1.5.3 сохраняет беседу при штатном закрытии), grace, SIGTERM, ещё grace, SIGKILL. Вышедший процесс не трогаем. */
function shutdownAgy(proc: AgyAcpProcess, graceMs: number, exited: () => boolean): void {
  if (exited()) return;
  try {
    proc.stdin.end();
  } catch {
    // процесс уже мёртв
  }
  let hard: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    if (exited()) return;
    proc.kill();
    hard = setTimeout(() => {
      if (!exited()) proc.kill('SIGKILL');
    }, graceMs);
    hard.unref?.();
  }, graceMs);
  timer.unref?.();
  proc.on('exit', () => {
    clearTimeout(timer);
    clearTimeout(hard);
  });
}
