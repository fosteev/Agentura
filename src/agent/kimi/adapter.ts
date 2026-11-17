import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { acpHttpMcpServers, AcpRpcClient, AcpRpcError, MAX_LINE_BYTES, PERMISSION_METHOD, type RpcId, type RpcProcess } from '../acp/client';
import { isAgenturaAgentsTool } from '../children/policy';
import { CHILD_MCP_SERVER } from '../children/types';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentEventOf,
  AgentSession,
  CommandOption,
  EffortLevel,
  HostMcpServer,
  PermissionDecision,
  PermissionMode,
  PlanDecision,
  PromptFile,
  PromptImage,
  ResumeOptions,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
} from '../types';
import { KIMI_NOT_FOUND } from './executable';
import { buildKimiHistory } from './history';
import { KimiMapper, mapToolInput, toolName } from './mapper';
import {
  ELICITATION_METHOD,
  KIMI_CLIENT_CAPABILITIES,
  KIMI_PROTOCOL_VERSION,
  agentVersionOf,
  commandsOf,
  contentTexts,
  currentModeId,
  elicitationCancel,
  elicitationDecline,
  formatElicitationAnswer,
  hasConfigOptions,
  isEffort,
  kimiModeId,
  modelOptionsFrom,
  parseConfig,
  parseElicitation,
  permissionCancelled,
  permissionModeOf,
  permissionOption,
  permissionOptions,
  permissionOutcome,
  permissionRefusal,
  promptBlocks,
  record,
  sessionIdOf,
  sessionUpdateKind,
  stopReasonOf,
  usageOf,
  type KimiConfig,
  type KimiPermissionOption,
  type ParsedKimiElicitation,
} from './protocol';
import { KimiSessionIndex, type KimiSessionSettings, type KimiStateStore } from './sessionIndex';
import {
  appendKimiSubagentHistory,
  findKimiSessionRoot,
  hasKimiSessionActivity,
  kimiHome,
  KimiSubagentTracker,
  kimiSubagentTranscript,
} from './subagents';

export interface KimiAcpProcess extends RpcProcess {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface KimiSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export type KimiLogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface KimiAdapterConfig {
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  engineVersion?: string | (() => string | undefined);
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
  log?: KimiLogFn;
  /** globalState-совместимое хранилище пользовательских имён и подтверждённых настроек. */
  state?: KimiStateStore;
  spawn?: (path: string, args: string[], options: KimiSpawnOptions) => KimiAcpProcess;
  timeoutMs?: number;
  /** Каждый этап shutdown: ожидание close/stdin, затем SIGTERM, затем SIGKILL. */
  graceMs?: number;
  interruptWaitMs?: number;
  /** Test/live tuning for the read-only persistence watcher. */
  subagentPollMs?: number;
}

const DEFAULT_GRACE_MS = 2000;
const INTERRUPT_WAIT_MS = 10_000;

function defaultSpawn(path: string, args: string[], options: KimiSpawnOptions): KimiAcpProcess {
  return spawn(path, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as unknown as KimiAcpProcess;
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
      return realItem === realTarget || realItem === targetDir;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function initializeParams(config: KimiAdapterConfig): Record<string, unknown> {
  return {
    protocolVersion: KIMI_PROTOCOL_VERSION,
    clientCapabilities: KIMI_CLIENT_CAPABILITIES,
    clientInfo: { name: 'agentura', version: config.clientVersion ?? '0.0.0' },
  };
}

export class KimiAdapter implements AgentAdapter {
  readonly id = 'kimi';
  private readonly index: KimiSessionIndex;

  constructor(private readonly config: KimiAdapterConfig = {}) {
    this.index = new KimiSessionIndex(config.state);
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new KimiSession(this.config, await this.executable(), options, this.index);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    // Resume — источник истины сервера; defaults новой вкладки и index поверх него не применяются.
    return new KimiSession(this.config, await this.executable(), options, this.index, sessionId);
  }

  async listSessions(dir: string): Promise<SessionInfo[]> {
    let executable: string;
    try {
      executable = await this.executable();
      const result = await this.acp(executable, dir, async (client) => {
        await client.request('initialize', initializeParams(this.config));
        return client.request('session/list', { cwd: dir });
      });
      const sessions = record(result)?.sessions;
      if (!Array.isArray(sessions)) return [];
      const out: SessionInfo[] = [];
      for (const item of sessions) {
        const row = record(item);
        const id = typeof row?.sessionId === 'string' ? row.sessionId : '';
        const cwd = typeof row?.cwd === 'string' ? row.cwd : '';
        if (!id || !cwd || !matchesCwd(cwd, dir)) continue;
        const customTitle = this.index.nameOf(id);
        const nativeTitle = typeof row?.title === 'string' ? row.title.trim() : '';
        const hasNativeTitle = Boolean(nativeTitle) && nativeTitle !== id && !/^session_[0-9a-f-]+$/i.test(nativeTitle);
        if (!customTitle && !hasNativeTitle) {
          const active = await hasKimiSessionActivity(id, this.config.env);
          if (!active) continue;
        }
        const parsed = typeof row?.updatedAt === 'string' ? Date.parse(row.updatedAt) : 0;
        out.push({
          id,
          title: customTitle ?? (nativeTitle || id),
          cwd: dir,
          updatedAt: Number.isFinite(parsed) ? parsed : 0,
          provider: 'kimi',
        });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      this.config.log?.('warn', `kimi: listSessions failed: ${errorText(error)}`);
      return [];
    }
  }

  async loadHistory(
    sessionId: string,
    cwd: string,
    options: { live?: boolean; tasksAlive?: boolean; maxTurns?: number; stopBefore?: string } = {},
  ): Promise<SessionHistory> {
    try {
      const executable = await this.executable();
      const loaded = await this.acp(executable, cwd, async (client, updates) => {
        await client.request('initialize', initializeParams(this.config));
        const result = await client.request('session/load', { sessionId, cwd, mcpServers: [] });
        try {
          await client.request('session/close', { sessionId }, this.config.graceMs ?? DEFAULT_GRACE_MS);
        } catch (error) {
          this.config.log?.('debug', `kimi: session/close after load failed: ${errorText(error)}`);
        }
        return { updates: [...updates], result };
      });
      const history = buildKimiHistory(loaded.updates, loaded.result, {
        ...(options.live ? { live: true } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      });
      const root = await findKimiSessionRoot(sessionId, kimiHome(this.config.env));
      if (!root) return history;
      return {
        ...history,
        events: await appendKimiSubagentHistory(history.events, root, {
          tasksAlive: options.tasksAlive === true,
          log: (message) => this.config.log?.('debug', message),
        }),
      };
    } catch (error) {
      this.config.log?.('warn', `kimi: session/load failed: ${errorText(error)}`);
      return { events: [], turns: 0, skippedTurns: 0 };
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.index.rename(sessionId, title);
  }

  async agentTranscript(sessionId: string, cwd: string, taskId: string, title: string): Promise<string | undefined> {
    void cwd;
    const root = await findKimiSessionRoot(sessionId, kimiHome(this.config.env));
    return root ? kimiSubagentTranscript(root, taskId, title) : undefined;
  }

  async accountInfo(cwd?: string): Promise<AccountInfo> {
    void cwd;
    // ACP 2.6.0 не сообщает email/plan/quota или иной проверенный account field.
    return {};
  }

  private async acp<T>(
    executable: string,
    cwd: string,
    fn: (client: AcpRpcClient, updates: unknown[]) => Promise<T>,
  ): Promise<T> {
    const proc = (this.config.spawn ?? defaultSpawn)(executable, ['acp'], {
      cwd, env: this.config.env ?? process.env, shell: false,
    });
    let exited = false;
    proc.on('exit', () => (exited = true));
    const updates: unknown[] = [];
    const client = new AcpRpcClient(proc, {
      engine: 'Kimi',
      timeoutMs: this.config.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const update = record(params)?.update;
        if (update !== undefined) updates.push(update);
      },
      onServerRequest: (id, method, params) => {
        if (method === PERMISSION_METHOD) {
          client.respond(id, permissionRefusal(params));
          return true;
        }
        if (method === ELICITATION_METHOD) {
          client.respond(id, elicitationDecline());
          return true;
        }
        return false;
      },
      onStderr: (line) => this.config.log?.('debug', `kimi: ${line}`),
    });
    try {
      return await fn(client, updates);
    } finally {
      client.dispose();
      shutdownKimi(proc, this.config.graceMs ?? DEFAULT_GRACE_MS, () => exited);
    }
  }

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(KIMI_NOT_FOUND);
    return path;
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  readonly settled: boolean;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((done) => (resolve = done));
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

interface QueueItem {
  text: string;
  images: readonly PromptImage[];
  files: readonly PromptFile[];
}

type PendingRequest =
  | { kind: 'permission'; rpcId: RpcId; options: KimiPermissionOption[] }
  | { kind: 'plan'; rpcId: RpcId; options: KimiPermissionOption[] }
  | { kind: 'question'; rpcId: RpcId; parsed: ParsedKimiElicitation }
  | { kind: 'questionFallback'; rpcId: RpcId; options: KimiPermissionOption[]; question: string };

/** Один `kimi acp` на вкладку; reverse requests обслуживаются существующими AgentSession методами. */
class KimiSession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper = new KimiMapper();
  private readonly log: KimiLogFn;
  private readonly proc: KimiAcpProcess;
  private readonly client: AcpRpcClient;
  private readonly ready: Promise<void>;
  private readonly queue: QueueItem[] = [];
  private readonly cwd: string;
  private readonly allowBypass: boolean;
  private readonly graceMs: number;
  private readonly interruptWaitMs: number;
  private readonly hostMcpServers: readonly HostMcpServer[];
  private permissionMode: PermissionMode = 'default';
  private config: KimiConfig = {};
  private commands: CommandOption[] = [];
  private sessionId = '';
  private agentVersion: string | undefined;
  private closed = false;
  private loading = true;
  private draining = false;
  private procExited = false;
  private generation = 0;
  private turn: { done: Deferred; startedAt: number; service: boolean } | undefined;
  private compacting: { done: Deferred; startedAt: number } | undefined;
  private settings: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, PendingRequest>();
  private lastContext: AgentEventOf<'context.usage'> | undefined;
  private graph: KimiSubagentTracker | undefined;

  constructor(
    private readonly config0: KimiAdapterConfig,
    executable: string,
    options: SessionOptions,
    private readonly index: KimiSessionIndex,
    private readonly resumeId?: string,
  ) {
    this.log = config0.log ?? (() => {});
    this.cwd = options.cwd;
    this.allowBypass = options.allowBypassPermissions === true;
    this.graceMs = config0.graceMs ?? DEFAULT_GRACE_MS;
    this.interruptWaitMs = config0.interruptWaitMs ?? INTERRUPT_WAIT_MS;
    this.hostMcpServers = options.hostMcpServers ?? [];
    this.events = new EventHub<AgentEvent>((error) => this.log('error', `event subscriber failed: ${String(error)}`));
    this.proc = (config0.spawn ?? defaultSpawn)(executable, ['acp'], {
      cwd: options.cwd,
      env: config0.env ?? process.env,
      shell: false,
    });
    this.proc.on('exit', () => (this.procExited = true));
    this.client = new AcpRpcClient(this.proc, {
      engine: 'Kimi',
      timeoutMs: config0.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
      onStderr: (line) => this.log('debug', `kimi: ${line}`),
      onClose: (error) => this.onClientClose(error.message),
    });
    this.ready = this.handshake(options);
    this.ready.catch((error) => this.fatal(error));
  }

  get id(): string {
    return this.sessionId || this.resumeId || '';
  }

  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[], skill?: { name: string; path: string }): boolean {
    void skill;
    if (this.closed) return false;
    const pdfCount = files?.filter((file) => file.kind === 'pdf').length ?? 0;
    if (pdfCount) {
      const message = `Kimi does not support PDF attachments; ${pdfCount} PDF file(s) were not sent.`;
      this.log('warn', `kimi: ${message}`);
      this.emit({ type: 'error', fatal: false, message });
    }
    if (text.trim() === '/compact' && !images?.length && !files?.some((file) => file.kind === 'text')) {
      return this.compact();
    }
    if (!text && !images?.length && !files?.some((file) => file.kind === 'text')) return true;
    this.queue.push({ text, images: images ?? [], files: files ?? [] });
    this.drain().catch((error) => this.log('error', `kimi queue failed: ${String(error)}`));
    return true;
  }

  respondPermission(toolUseId: string, decision: PermissionDecision, message?: string): boolean {
    void message;
    const pending = this.pending.get(toolUseId);
    if (!pending) return false;
    if (pending.kind === 'question') {
      if (decision !== 'deny') return false;
      this.pending.delete(toolUseId);
      this.client.respond(pending.rpcId, elicitationDecline());
      this.emit({ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'user' });
      return true;
    }
    if (pending.kind === 'questionFallback') {
      if (decision !== 'deny') return false;
      const optionId =
        pending.options.find((o) => o.optionId === 'q0_skip')?.optionId ??
        permissionOption(pending.options, 'reject_once');
      if (!optionId) return false;
      this.pending.delete(toolUseId);
      this.client.respond(pending.rpcId, permissionOutcome(optionId));
      this.emit({ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'user' });
      return true;
    }
    if (pending.kind !== 'permission') return false;
    const kind = decision === 'deny' ? 'reject_once' : decision === 'allow-always' ? 'allow_always' : 'allow_once';
    const optionId = permissionOption(pending.options, kind);
    if (!optionId) return false;
    this.pending.delete(toolUseId);
    this.client.respond(pending.rpcId, permissionOutcome(optionId));
    if (decision === 'allow-edits') void this.setMode('acceptEdits').catch((error) => this.log('warn', errorText(error)));
    this.emit({ type: 'permission.resolved', toolUseId, decision: decision === 'deny' ? 'deny' : 'allow', by: 'user' });
    return true;
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    const pending = this.pending.get(toolUseId);
    if (!pending || (pending.kind !== 'question' && pending.kind !== 'questionFallback')) return false;
    if (pending.kind === 'question') {
      this.pending.delete(toolUseId);
      this.client.respond(pending.rpcId, formatElicitationAnswer(pending.parsed, answers));
      this.emit({ type: 'permission.resolved', toolUseId, decision: 'allow', by: 'user' });
      return true;
    }
    const answer = answers.q0 ?? answers[pending.question];
    const selected = pending.options.find((option) => option.optionId.startsWith('q0_opt_') && option.name === answer);
    const fallback = selected ?? pending.options.find((option) => option.optionId === 'q0_skip');
    if (!fallback) return false;
    this.pending.delete(toolUseId);
    this.client.respond(pending.rpcId, permissionOutcome(fallback.optionId));
    this.emit({ type: 'permission.resolved', toolUseId, decision: 'allow', by: 'user' });
    return true;
  }

  decidePlan(toolUseId: string, decision: PlanDecision): boolean {
    const pending = this.pending.get(toolUseId);
    if (!pending || pending.kind !== 'plan') return false;
    let optionId: string | undefined;
    if (decision.approve) {
      optionId = decision.optionId && pending.options.some((option) => option.optionId === decision.optionId)
        ? decision.optionId
        : decision.optionId ? undefined : permissionOption(pending.options, 'allow_once');
    } else {
      optionId = pending.options.find((option) => option.optionId === (decision.interrupt ? 'plan_reject_and_exit' : 'plan_revise'))?.optionId;
    }
    if (!optionId) return false;
    this.pending.delete(toolUseId);
    this.client.respond(pending.rpcId, permissionOutcome(optionId));
    this.emit({ type: 'permission.resolved', toolUseId, decision: decision.approve ? 'allow' : 'deny', by: 'user' });
    if (!decision.approve && decision.interrupt) void this.interrupt();
    else if (!decision.approve) this.send(decision.feedback);
    return true;
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.ready;
    await this.serial(() => this.changeMode(mode));
  }

  async setModel(model: string): Promise<void> {
    if (!model) return;
    await this.ready;
    await this.serial(() => this.changeModel(model));
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.ready;
    await this.serial(() => this.changeEffort(effort));
  }

  compact(): boolean {
    if (this.closed || this.loading || !this.sessionId || this.turn || this.draining || this.queue.length ||
        this.compacting || this.pending.size) return false;
    const done = deferred();
    const startedAt = Date.now();
    this.compacting = { done, startedAt };
    this.emit({ type: 'compaction.start' });
    this.client.request('session/prompt', {
      sessionId: this.sessionId, prompt: [{ type: 'text', text: '/compact' }],
    }, null).then((result) => {
      if (this.closed) return;
      if (stopReasonOf(result) === 'cancelled') {
        this.emit({ type: 'compaction.end', ok: false, trigger: 'manual', durationMs: Date.now() - startedAt, error: 'cancelled' });
      } else {
        // Kimi подтверждает лишь запуск background compaction; ACP completion event отсутствует.
        this.emit({
          type: 'compaction.end', ok: false, trigger: 'manual', durationMs: Date.now() - startedAt,
          error: 'Kimi confirmed only that background compaction started; completion is not reported by ACP.',
        });
      }
    }, (error: unknown) => {
      if (this.closed) return;
      const message = errorText(error);
      this.emit({ type: 'error', fatal: false, message });
      this.emit({ type: 'compaction.end', ok: false, trigger: 'manual', durationMs: Date.now() - startedAt, error: message });
    }).finally(() => {
      this.compacting?.done.resolve();
      this.compacting = undefined;
      if (!this.closed && this.queue.length) void this.drain();
    });
    return true;
  }

  async stopTask(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.generation++;
    this.abortPending();
    const active = this.compacting ?? this.turn;
    if (!active || active.done.settled || this.closed) return;
    try {
      this.client.notify('session/cancel', { sessionId: this.sessionId });
    } catch (error) {
      this.log('warn', `session/cancel failed: ${errorText(error)}`);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      active.done.promise,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.interruptWaitMs))),
    ]);
    clearTimeout(timer);
    if (!active.done.settled && !this.closed) {
      this.abandonTurn();
      this.fatal(new Error('Kimi did not confirm cancellation; the connection was closed. Resume the session to continue.'));
    }
  }

  capabilities(): Promise<SessionCapabilities> {
    return this.ready.then(
      () => ({ models: modelOptionsFrom(this.config), commands: [...this.commands] }),
      () => ({ models: [], commands: [] }),
    );
  }

  async contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined> {
    try {
      await this.ready;
    } catch {
      return undefined;
    }
    return this.lastContext ? { ...this.lastContext } : undefined;
  }

  dispose(): void {
    if (this.closed) return;
    this.abortPending();
    this.abandonTurn();
    this.close('disposed');
    const shutdown = () => {
      this.client.dispose();
      this.stopProcess();
    };
    if (!this.sessionId) {
      shutdown();
      return;
    }
    void this.client.request('session/close', { sessionId: this.sessionId }, this.graceMs).then(
      () => shutdown(),
      (error: unknown) => {
        this.log('debug', `kimi: session/close during dispose failed: ${errorText(error)}`);
        shutdown();
      },
    );
  }

  private async handshake(options: SessionOptions): Promise<void> {
    const init = await this.client.request('initialize', initializeParams(this.config0));
    this.agentVersion = agentVersionOf(init);
    const mcpServers = acpHttpMcpServers(this.hostMcpServers);
    const result = this.resumeId
      ? await this.client.request('session/resume', { sessionId: this.resumeId, cwd: this.cwd, mcpServers })
      : await this.client.request('session/new', { cwd: this.cwd, mcpServers });
    if (this.closed) return;
    const sessionId = this.resumeId ?? sessionIdOf(result);
    if (!sessionId) throw new Error('Kimi ACP session/new returned no sessionId.');
    this.sessionId = sessionId;
    this.graph = new KimiSubagentTracker(
      findKimiSessionRoot(sessionId, kimiHome(this.config0.env)),
      (event) => this.emit(event),
      {
        ...(this.config0.subagentPollMs !== undefined ? { pollMs: this.config0.subagentPollMs } : {}),
        log: (message) => this.log('debug', message),
      },
    );
    this.graph.start();
    this.config = parseConfig(result);
    this.permissionMode = permissionModeOf(currentModeId(result) ?? this.config.mode?.current, this.allowBypass);
    if (!this.resumeId) {
      // Настройки новой сессии применяются явно; resume никогда не догоняет defaults/index.
      if (options.model) await this.changeModel(options.model).catch(() => {});
      if (options.effort) await this.changeEffort(options.effort).catch(() => {});
      if (options.permissionMode) await this.changeMode(options.permissionMode).catch(() => {});
    }
    await this.saveSettings();
    this.loading = false;
    if (!this.closed) this.emit(this.buildSessionInit());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settings.then(fn, fn);
    this.settings = run.catch(() => undefined);
    return run;
  }

  private async changeModel(model: string): Promise<void> {
    if (this.closed || !this.sessionId) return;
    try {
      const result = await this.client.request('session/set_model', { sessionId: this.sessionId, modelId: model });
      this.absorb(result);
    } catch (error) {
      this.settingFailed('session/set_model', error);
      throw error;
    }
    if (this.loading) return;
    await this.saveSettings();
    if (!this.closed) this.emit(this.buildSessionInit());
  }

  private async changeEffort(effort: EffortLevel): Promise<void> {
    if (this.closed || !this.sessionId) return;
    try {
      const result = await this.client.request('session/set_config_option', {
        sessionId: this.sessionId, configId: 'thinking', value: effort,
      });
      this.absorb(result);
    } catch (error) {
      this.settingFailed('session/set_config_option thinking', error);
      throw error;
    }
    if (this.loading) return;
    await this.saveSettings();
    if (!this.closed) this.emit(this.buildSessionInit());
  }

  private async changeMode(mode: PermissionMode): Promise<void> {
    if (this.closed || !this.sessionId) return;
    const modeId = kimiModeId(mode, this.allowBypass);
    if (this.config.mode?.current !== modeId) {
      try {
        await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId });
      } catch (error) {
        this.settingFailed('session/set_mode', error);
        throw error;
      }
    }
    this.permissionMode = permissionModeOf(this.config.mode?.current, this.allowBypass);
    if (this.loading) return;
    await this.saveSettings();
    if (!this.closed) {
      this.emit({ type: 'mode.changed', mode: this.permissionMode });
      this.emit(this.buildSessionInit());
    }
  }

  private absorb(result: unknown): void {
    if (hasConfigOptions(result)) {
      this.config = parseConfig(result);
      this.permissionMode = permissionModeOf(this.config.mode?.current, this.allowBypass);
    }
  }

  private settingFailed(method: string, error: unknown): void {
    if (this.closed) return;
    this.emit({ type: 'error', fatal: false, message: `${method} failed: ${errorText(error)}` });
    // После optimistic UI выбора перевыпускаем только последнее подтверждённое сервером состояние.
    if (!this.loading) this.emit(this.buildSessionInit());
  }

  private async saveSettings(): Promise<void> {
    if (!this.sessionId) return;
    const model = this.config.model?.current;
    const effort = this.config.thinking?.current;
    const settings: KimiSessionSettings = {
      permissionMode: this.permissionMode,
      ...(model ? { model } : {}),
      ...(effort && isEffort(effort) ? { effort } : {}),
    };
    try {
      await this.index.saveSettings(this.sessionId, settings);
    } catch (error) {
      this.log('warn', `kimi: could not save session settings: ${errorText(error)}`);
    }
  }

  private buildSessionInit(): AgentEventOf<'session.init'> {
    const effort = this.config.thinking?.current;
    return {
      type: 'session.init',
      sessionId: this.sessionId,
      model: this.config.model?.current ?? '',
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      tools: [],
      slashCommands: this.commands.map((command) => command.name),
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: this.engineVersion(),
      ...(effort && isEffort(effort) ? { effort } : {}),
    };
  }

  private engineVersion(): string {
    const configured = typeof this.config0.engineVersion === 'function'
      ? this.config0.engineVersion()
      : this.config0.engineVersion;
    return configured ?? this.agentVersion ?? '';
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
        if (!item) break;
        const generation = this.generation;
        try {
          await this.ready;
        } catch {
          break;
        }
        if (this.closed) break;
        if (generation !== this.generation) {
          this.emitAll(this.mapper.interruptBeforeStart(item.text));
          continue;
        }
        const startedAt = Date.now();
        const done = deferred();
        const service = item.text.trimStart().startsWith('/');
        this.turn = { done, startedAt, service };
        this.emitAll(this.mapper.startTurn(item.text, startedAt, item.images, item.files, service));
        try {
          const result = await this.client.request('session/prompt', {
            sessionId: this.sessionId,
            prompt: promptBlocks(this.cwd, item.text, item.images, item.files),
          }, null);
          if (this.closed) break;
          if (!this.turn || this.turn.done.settled) continue;
          this.abortPending();
          this.emitAll(this.mapper.finish(result, startedAt));
          done.resolve();
        } catch (error) {
          if (this.closed || done.settled) break;
          if (error instanceof AcpRpcError && typeof error.code === 'number') {
            this.abortPending();
            const message = errorText(error);
            this.emit({ type: 'error', fatal: false, message, code: String(error.code) });
            this.emitAll(this.mapper.failOpen(startedAt, Date.now(), message));
            done.resolve();
            continue;
          }
          this.fatal(error);
          break;
        } finally {
          if (this.turn?.done === done) this.turn = undefined;
        }
      }
    } finally {
      this.draining = false;
      if (!this.closed && this.queue.length) void this.drain();
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (this.closed || method !== 'session/update') return;
    const update = record(params)?.update;
    const kind = sessionUpdateKind(update);
    if (kind === 'usage_update') {
      const usage = usageOf(update);
      if (usage) {
        this.lastContext = {
          type: 'context.usage', usedTokens: usage.used, maxTokens: usage.size,
          percentage: Math.min(100, usage.used / usage.size * 100), source: 'engine',
        };
      }
      if (!this.loading) {
        this.emitAll(this.mapper.applyUpdate(update));
      }
      return;
    }
    if (kind === 'available_commands_update') {
      this.commands = commandsOf(update);
      if (!this.loading) {
        this.emit(this.buildSessionInit());
      }
      return;
    }
    if (kind === 'config_option_update') {
      if (!hasConfigOptions(update)) return;
      this.config = parseConfig(update);
      this.permissionMode = permissionModeOf(this.config.mode?.current, this.allowBypass);
      if (!this.loading) {
        void this.saveSettings();
        this.emit(this.buildSessionInit());
      }
      return;
    }
    if (kind === 'current_mode_update') {
      const modeId = record(update)?.currentModeId;
      if (typeof modeId !== 'string') return;
      if (this.config.mode) this.config.mode.current = modeId;
      else this.config.mode = { current: modeId, values: [] };
      const next = permissionModeOf(modeId, this.allowBypass);
      const changed = next !== this.permissionMode;
      this.permissionMode = next;
      if (!this.loading) {
        if (changed) {
          this.emit({ type: 'mode.changed', mode: next });
        }
        void this.saveSettings();
        this.emit(this.buildSessionInit());
      }
      return;
    }
    if (this.loading) return;
    if (kind === 'session_info_update') {
      const custom = this.index.nameOf(this.sessionId);
      const events = this.mapper.applyUpdate(update);
      if (custom) this.emit({ type: 'session.title', title: custom });
      else this.emitAll(events);
      return;
    }
    const turn = this.turn;
    if (!turn || turn.done.settled) return;
    for (const event of this.mapper.applyUpdate(update)) {
      if (event.type === 'tool.result') {
        const pending = this.pending.get(event.toolUseId);
        if (pending && (pending.kind === 'question' || pending.kind === 'questionFallback')) {
          this.pending.delete(event.toolUseId);
          this.emit({ type: 'permission.resolved', toolUseId: event.toolUseId, decision: 'deny', by: 'abort' });
        }
      }
      this.emit(event);
      this.graph?.observeEvent(event);
    }
  }

  private onClientClose(message: string): void {
    if (this.closed || message === this.client.disposedMessage) return;
    const exited = this.procExited || /stdout closed|ACP exited|ACP closed/.test(message);
    this.fatal(new Error(message), exited ? 'exit' : 'error');
  }

  private onServerRequest(id: RpcId, method: string, params: unknown): boolean {
    try {
      if (method === PERMISSION_METHOD) return this.handlePermission(id, params);
      if (method === ELICITATION_METHOD) return this.handleElicitation(id, params);
      return false;
    } catch (error) {
      this.log('warn', `kimi: ${method} failed: ${errorText(error)}`);
      return false;
    }
  }

  private handlePermission(id: RpcId, params: unknown): boolean {
    const options = permissionOptions(params);
    const call = record(record(params)?.toolCall);
    const toolUseId = typeof call?.toolCallId === 'string' ? call.toolCallId : '';
    if (!toolUseId) {
      this.client.respond(id, permissionRefusal(params));
      return true;
    }
    const name = toolName(call ?? {});
    if (name === 'ExitPlanMode' || options.some((option) => option.optionId.startsWith('plan_'))) {
      const details = planDetails(call ?? {}, options);
      if (!details.plan) {
        this.client.respond(id, permissionCancelled());
        return true;
      }
      this.track(toolUseId, { kind: 'plan', rpcId: id, options });
      this.emit({
        type: 'plan.request', toolUseId, plan: details.plan,
        ...(details.planFilePath ? { planFilePath: details.planFilePath } : {}),
        ...(details.options.length ? { options: details.options } : {}),
      });
      return true;
    }
    if (name === 'AskUserQuestion' && options.some((option) => option.optionId.startsWith('q0_'))) {
      const question = contentTexts(call?.content)[0] ?? name;
      this.track(toolUseId, { kind: 'questionFallback', rpcId: id, options, question });
      this.emit({
        type: 'question.request', toolUseId,
        questions: [{
          question,
          options: options.filter((option) => option.optionId.startsWith('q0_opt_')).map((option) => ({ label: option.name })),
          multiSelect: false,
        }],
      });
      return true;
    }
    const title = typeof call?.title === 'string' ? call.title : undefined;
    if (
      this.hostMcpServers.some((s) => s.name === CHILD_MCP_SERVER && s.builtin !== false) &&
      isAgenturaAgentsTool(name, title)
    ) {
      const allow = permissionOption(options, 'allow_once');
      this.client.respond(id, allow ? permissionOutcome(allow) : permissionRefusal(params));
      return true;
    }
    if (this.permissionMode === 'bypassPermissions' && this.allowBypass) {
      const allow = permissionOption(options, 'allow_once');
      this.client.respond(id, allow ? permissionOutcome(allow) : permissionRefusal(params));
      return true;
    }
    const input = mapToolInput(name, record(call?.rawInput) ?? record(call?.args) ?? {});
    const reason = contentTexts(call?.content).join('\n');
    const canAlwaysAllow = options.some((option) => option.kind === 'allow_always');
    this.track(toolUseId, { kind: 'permission', rpcId: id, options });
    this.emit({
      type: 'permission.request', toolUseId, toolName: name, input, canAlwaysAllow,
      ...(canAlwaysAllow ? { always: { rules: [name], destination: 'session' as const, directories: [] } } : {}),
      ...(title ? { title, description: title } : {}),
      ...(reason ? { reason } : {}),
    });
    return true;
  }

  private handleElicitation(id: RpcId, params: unknown): boolean {
    const parsed = parseElicitation(params);
    if (!parsed) {
      this.client.respond(id, elicitationDecline());
      return true;
    }
    const rawId = record(params)?.toolCallId;
    const toolUseId = typeof rawId === 'string' && rawId ? rawId : String(id);
    this.track(toolUseId, { kind: 'question', rpcId: id, parsed });
    this.emit({ type: 'question.request', toolUseId, questions: parsed.questions });
    return true;
  }

  private track(toolUseId: string, pending: PendingRequest): void {
    const previous = this.pending.get(toolUseId);
    if (previous) this.settlePending(toolUseId, previous);
    this.pending.set(toolUseId, pending);
  }

  private abortPending(): void {
    const open = [...this.pending];
    this.pending.clear();
    for (const [toolUseId, pending] of open) this.settlePending(toolUseId, pending);
  }

  private settlePending(toolUseId: string, pending: PendingRequest): void {
    this.pending.delete(toolUseId);
    try {
      if (pending.kind === 'question') this.client.respond(pending.rpcId, elicitationCancel());
      else this.client.respond(pending.rpcId, permissionCancelled());
    } catch (error) {
      this.log('debug', `kimi: pending ${pending.kind} cancellation failed: ${errorText(error)}`);
    }
    this.emit({ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'abort' });
  }

  private fatal(error: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    const message = errorText(error);
    this.log('error', `kimi session failed: ${message}`);
    this.abortPending();
    this.compacting?.done.resolve();
    this.compacting = undefined;
    const turn = this.turn;
    if (turn && !turn.done.settled) {
      this.emitAll(this.mapper.failOpen(turn.startedAt, Date.now(), message));
      turn.done.resolve();
      this.turn = undefined;
    }
    this.emit({ type: 'error', fatal: true, message });
    this.close(reason, message);
    this.client.dispose();
    this.stopProcess();
  }

  private abandonTurn(): void {
    this.compacting?.done.resolve();
    this.compacting = undefined;
    const turn = this.turn;
    if (!turn || turn.done.settled) return;
    turn.done.resolve();
    this.emitAll(this.mapper.abandon(turn.startedAt, Date.now()));
  }

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.graph?.dispose();
    this.graph = undefined;
    this.queue.length = 0;
    this.turn?.done.resolve();
    this.compacting?.done.resolve();
    this.compacting = undefined;
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  private stopProcess(): void {
    shutdownKimi(this.proc, this.graceMs, () => this.procExited);
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
  }

  private emitAll(events: AgentEvent[]): void {
    for (const event of events) this.emit(event);
  }
}

function planDetails(
  call: Record<string, unknown>,
  permissionOptions: readonly KimiPermissionOption[],
): { plan: string; planFilePath?: string; options: { id: string; label: string }[] } {
  const first = contentTexts(call.content)[0] ?? '';
  const match = /^Plan saved to:\s*([^\n]+)\n\n/.exec(first);
  return {
    plan: match ? first.slice(match[0].length) : first,
    ...(match ? { planFilePath: match[1] } : {}),
    options: permissionOptions
      .filter((option) => /^plan_opt_\d+$/.test(option.optionId))
      .map((option) => ({ id: option.optionId, label: option.name })),
  };
}

/** Только после session/close (или его timeout) вызывается этот stdin end → SIGTERM → SIGKILL. */
function shutdownKimi(proc: KimiAcpProcess, graceMs: number, exited: () => boolean): void {
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
