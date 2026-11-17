import { spawn } from 'node:child_process';
import { acpHttpMcpServers, AcpRpcClient, AcpRpcError, MAX_LINE_BYTES, PERMISSION_METHOD, type RpcId, type RpcProcess } from '../acp/client';
import { isAgenturaAgentsTool } from '../children/policy';
import { CHILD_MCP_SERVER } from '../children/types';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  HostMcpServer,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PromptFile,
  PromptImage,
  ResumeOptions,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
} from '../types';
import { GEMINI_NOT_FOUND } from './executable';

export interface GeminiAcpProcess extends RpcProcess {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface GeminiSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export type GeminiSpawner = (
  command: string,
  args: string[],
  options: GeminiSpawnOptions,
) => GeminiAcpProcess;

export interface GeminiAdapterConfig {
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  clientVersion?: string;
  spawn?: GeminiSpawner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  graceMs?: number;
  interruptWaitMs?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export const GEMINI_LIST_SESSIONS_TIMEOUT_MS = 15_000;
export const GEMINI_PROBE_TIMEOUT_MS = 12_000;
const DEFAULT_GRACE_MS = 500;
const INTERRUPT_WAIT_MS = 2_000;

function defaultSpawn(command: string, args: string[], options: GeminiSpawnOptions): GeminiAcpProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as unknown as GeminiAcpProcess;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof AcpRpcError) {
    const data = record(error.data);
    const details = typeof data?.details === 'string' ? data.details : undefined;
    return details ? `${error.message} (${details})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function isGeminiAuthError(error: unknown): boolean {
  const msg = errorText(error);
  const code = error instanceof AcpRpcError ? error.code : undefined;
  return (
    code === -32000 ||
    /IneligibleTierError|no longer supported for Gemini Code Assist|Authentication required|LOGIN_REQUIRED|UNAUTHENTICATED|API[ _]KEY|not authenticated|not logged in|empty response/i.test(
      msg,
    )
  );
}

export function geminiApprovalMode(
  mode: PermissionMode | undefined,
  allowBypass: boolean,
): 'default' | 'auto_edit' | 'yolo' | 'plan' {
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits') return 'auto_edit';
  if (mode === 'bypassPermissions' && allowBypass) return 'yolo';
  return 'default';
}

function geminiAcpModeId(mode: PermissionMode, allowBypass: boolean): string {
  return geminiApprovalMode(mode, allowBypass);
}

function allowOptionId(options: unknown): string {
  if (Array.isArray(options)) {
    for (const item of options) {
      const row = record(item);
      const kind = typeof row?.kind === 'string' ? row.kind : '';
      const id = typeof row?.optionId === 'string' ? row.optionId : '';
      if (id && (kind === 'allow_once' || kind === 'allow_always')) return id;
    }
    const first = record(options[0]);
    if (typeof first?.optionId === 'string' && first.optionId) return first.optionId;
  }
  return 'allow';
}

function denyOptionId(options: unknown): string {
  if (Array.isArray(options)) {
    for (const item of options) {
      const row = record(item);
      const kind = typeof row?.kind === 'string' ? row.kind : '';
      const id = typeof row?.optionId === 'string' ? row.optionId : '';
      if (id && (kind === 'reject_once' || kind === 'reject_always')) return id;
    }
  }
  return 'deny';
}

function extractModels(result: unknown): { models: ModelOption[]; current?: string } {
  const m = record(record(result)?.models);
  const current = typeof m?.currentModelId === 'string' && m.currentModelId ? m.currentModelId : undefined;
  const list = Array.isArray(m?.availableModels) ? m.availableModels : [];
  const models: ModelOption[] = [];
  for (const entry of list) {
    const row = record(entry);
    const id = typeof row?.modelId === 'string' ? row.modelId : typeof row?.id === 'string' ? row.id : '';
    if (!id) continue;
    const name = typeof row?.name === 'string' && row.name ? row.name : id;
    models.push({ value: id, displayName: name, supportsEffort: false });
  }
  return { models, ...(current ? { current } : {}) };
}

function chunkText(update: unknown): string {
  const content = record(update)?.content;
  const row = record(content);
  if (row?.type === 'text' && typeof row.text === 'string') return row.text;
  return '';
}

export class GeminiAdapter implements AgentAdapter {
  readonly id = 'gemini';

  constructor(private readonly config: GeminiAdapterConfig = {}) {}

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(GEMINI_NOT_FOUND);
    return path;
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new GeminiSession(this.config, await this.executable(), options);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    return new GeminiSession(this.config, await this.executable(), options, sessionId);
  }

  /** Честная проверка живой авторизации `gemini --acp` через `initialize` + `session/new`. */
  async probeAuth(
    cwd: string,
    timeoutMs = GEMINI_PROBE_TIMEOUT_MS,
  ): Promise<{ ok: boolean; needsAuth: boolean; models: ModelOption[]; reason?: string }> {
    const executable = await this.executable();
    const proc = (this.config.spawn ?? defaultSpawn)(executable, ['--acp', '--skip-trust'], {
      cwd,
      env: this.config.env ?? process.env,
      shell: false,
    });
    let exited = false;
    proc.on('exit', () => (exited = true));
    const client = new AcpRpcClient(proc, {
      timeoutMs: this.config.timeoutMs ?? timeoutMs,
      maxLineBytes: MAX_LINE_BYTES,
      onStderr: (line) => this.config.log?.('debug', `gemini probe: ${line}`),
    });
    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'agentura', version: this.config.clientVersion ?? '0.0.0' },
      });
      const res = await client.request('session/new', { cwd, mcpServers: [] });
      const { models } = extractModels(res);
      return { ok: true, needsAuth: false, models };
    } catch (err) {
      return {
        ok: false,
        needsAuth: isGeminiAuthError(err),
        models: [],
        reason: errorText(err),
      };
    } finally {
      client.dispose();
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      if (!exited) proc.kill('SIGTERM');
    }
  }

  async listSessions(dir: string): Promise<SessionInfo[]> {
    let executable: string;
    try {
      executable = await this.executable();
    } catch {
      return [];
    }
    const proc = (this.config.spawn ?? defaultSpawn)(executable, ['--acp', '--skip-trust'], {
      cwd: dir,
      env: this.config.env ?? process.env,
      shell: false,
    });
    let exited = false;
    proc.on('exit', () => (exited = true));
    const client = new AcpRpcClient(proc, {
      timeoutMs: GEMINI_LIST_SESSIONS_TIMEOUT_MS,
      maxLineBytes: MAX_LINE_BYTES,
    });
    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'agentura', version: this.config.clientVersion ?? '0.0.0' },
      });
      const res = await client.request('session/list', { cwd: dir });
      const list = Array.isArray(record(res)?.sessions) ? (record(res)!.sessions as unknown[]) : [];
      const out: SessionInfo[] = [];
      for (const item of list) {
        const row = record(item);
        const id = typeof row?.sessionId === 'string' ? row.sessionId : '';
        if (!id) continue;
        const cwd = typeof row?.cwd === 'string' ? row.cwd : dir;
        const updatedAt = typeof row?.updatedAt === 'number' ? row.updatedAt : Date.now();
        out.push({
          id,
          title: (typeof row?.title === 'string' && row.title) || id,
          cwd,
          updatedAt,
        });
      }
      return out;
    } catch {
      return [];
    } finally {
      client.dispose();
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      if (!exited) proc.kill('SIGTERM');
    }
  }

  async loadHistory(): Promise<SessionHistory> {
    return { events: [], turns: 0, skippedTurns: 0 };
  }

  async renameSession(): Promise<void> {}

  async accountInfo(): Promise<AccountInfo> {
    return {};
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

class GeminiSession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  private readonly proc: GeminiAcpProcess;
  private readonly client: AcpRpcClient;
  private readonly ready: Promise<void>;
  private readonly queue: string[] = [];
  private readonly cwd: string;
  private readonly hostMcpServers: readonly HostMcpServer[];
  private readonly allowBypass: boolean;
  private permissionMode: PermissionMode;
  private readonly pending = new Map<string, { rpcId: RpcId; options: unknown }>();
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown>; started: boolean }>();
  private sessionId = '';
  private model = '';
  private models: ModelOption[] = [];
  private seq = 0;
  private messageId = '';
  private text = '';
  private closed = false;
  private loading = true;
  private draining = false;
  private procExited = false;
  private generation = 0;
  private turnGeneration = 0;
  private turn: { done: Deferred; startedAt: number } | undefined;

  constructor(
    private readonly config: GeminiAdapterConfig,
    executable: string,
    options: SessionOptions,
    private readonly resumeId?: string,
  ) {
    this.log = config.log ?? (() => {});
    this.cwd = options.cwd;
    this.hostMcpServers = options.hostMcpServers ?? [];
    this.allowBypass = options.allowBypassPermissions === true;
    const reqMode = options.permissionMode ?? 'default';
    this.permissionMode = reqMode === 'bypassPermissions' && !this.allowBypass ? 'default' : reqMode;
    this.model = options.model ?? '';
    this.events = new EventHub<AgentEvent>((e) => this.log('error', `gemini subscriber: ${String(e)}`));

    const args = [
      '--acp',
      '--skip-trust',
      '--approval-mode',
      geminiApprovalMode(this.permissionMode, this.allowBypass),
      ...(options.model ? ['--model', options.model] : []),
    ];
    this.proc = (config.spawn ?? defaultSpawn)(executable, args, {
      cwd: options.cwd,
      env: config.env ?? process.env,
      shell: false,
    });
    this.proc.on('exit', () => (this.procExited = true));
    this.client = new AcpRpcClient(this.proc, {
      timeoutMs: config.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
      onStderr: (line) => this.log('debug', `gemini: ${line}`),
      onClose: (err) => this.onClientClose(err.message),
    });
    this.ready = this.handshake(options.model);
    this.ready.catch((err) => this.fatal(err));
  }

  get id(): string {
    return this.sessionId || this.resumeId || '';
  }

  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]): boolean {
    if (this.closed) return false;
    if (images?.length) this.log('warn', `gemini: dropped ${images.length} image(s)`);
    if (files?.length) this.log('warn', `gemini: dropped ${files.length} file(s)`);
    if (!text) return true;
    this.queue.push(text);
    this.drain().catch((err) => this.log('error', `gemini queue: ${String(err)}`));
    return true;
  }

  respondPermission(toolUseId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(toolUseId);
    if (!p) return false;
    this.pending.delete(toolUseId);
    const optionId = decision === 'deny' ? denyOptionId(p.options) : allowOptionId(p.options);
    this.client.respond(p.rpcId, { outcome: { outcome: 'selected', optionId } });
    this.emit({
      type: 'permission.resolved',
      toolUseId,
      decision: decision === 'deny' ? 'deny' : 'allow',
      by: 'user',
    });
    return true;
  }

  answerQuestion(): boolean {
    return false;
  }

  decidePlan(): boolean {
    return false;
  }

  async setMode(mode: PermissionMode): Promise<void> {
    const next = mode === 'bypassPermissions' && !this.allowBypass ? 'default' : mode;
    await this.ready.catch(() => undefined);
    if (this.closed || !this.sessionId) return;
    try {
      await this.client.request('session/set_mode', {
        sessionId: this.sessionId,
        modeId: geminiAcpModeId(next, this.allowBypass),
      });
      this.permissionMode = next;
      this.emit({ type: 'mode.changed', mode: next });
    } catch (err) {
      if (!this.closed) this.emit({ type: 'error', fatal: false, message: `session/set_mode failed: ${errorText(err)}` });
    }
  }

  async setModel(model: string): Promise<void> {
    await this.ready.catch(() => undefined);
    if (this.closed || !this.sessionId || !model) return;
    try {
      await this.client.request('session/set_model', { sessionId: this.sessionId, modelId: model });
      this.model = model;
    } catch (err) {
      if (!this.closed) this.emit({ type: 'error', fatal: false, message: `session/set_model failed: ${errorText(err)}` });
    }
  }

  async setEffort(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.generation++;
    this.abortPending();
    if (!this.turn || this.turn.done.settled || this.closed || !this.sessionId) return;
    try {
      this.client.notify('session/cancel', { sessionId: this.sessionId });
    } catch {
      // ignore
    }
    const timerWait = new Promise<void>((resolve) =>
      setTimeout(resolve, this.config.interruptWaitMs ?? INTERRUPT_WAIT_MS),
    );
    await Promise.race([this.turn.done.promise, timerWait]);
    if (this.turn && !this.turn.done.settled && !this.closed) {
      const t = this.turn;
      this.turn = undefined;
      t.done.resolve();
      this.emit({
        type: 'turn.result',
        ok: false,
        interrupted: true,
        subtype: 'interrupted',
        text: this.text,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        durationMs: Math.max(0, Date.now() - t.startedAt),
        apiDurationMs: 0,
        numTurns: 1,
        totalCostUsd: 0,
        permissionDenials: [],
      });
    }
  }

  compact(): boolean {
    return false;
  }

  async stopTask(): Promise<void> {}

  async contextUsage(): Promise<undefined> {
    return undefined;
  }

  capabilities(): Promise<SessionCapabilities> {
    return this.ready.then(
      () => ({ models: this.models, commands: [] }),
      () => ({ models: [], commands: [] }),
    );
  }

  dispose(): void {
    if (this.closed) return;
    this.abortPending();
    this.close('disposed');
    this.client.dispose();
    this.stopProcess();
  }

  private async handshake(requestedModel: string | undefined): Promise<void> {
    await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'agentura', version: this.config.clientVersion ?? '0.0.0' },
    });
    const mcpServers = acpHttpMcpServers(this.hostMcpServers);
    const result = this.resumeId
      ? await this.client.request('session/load', { sessionId: this.resumeId, cwd: this.cwd, mcpServers })
      : await this.client.request('session/new', { cwd: this.cwd, mcpServers });
    if (this.closed) return;
    const sid = this.resumeId ?? (typeof record(result)?.sessionId === 'string' ? (record(result)!.sessionId as string) : '');
    if (!sid) throw new Error('Gemini ACP session/new returned no sessionId.');
    this.sessionId = sid;
    const { models, current } = extractModels(result);
    this.models = models;
    this.model = requestedModel || current || this.model || 'auto';
    if (requestedModel && current && requestedModel !== current) {
      try {
        await this.client.request('session/set_model', { sessionId: sid, modelId: requestedModel });
      } catch {
        // cli flag --model may already handle it
      }
    }
    this.loading = false;
    this.emit({
      type: 'session.init',
      sessionId: sid,
      model: this.model,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: '',
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const prompt = this.queue.shift();
        if (prompt === undefined) break;
        const gen = this.generation;
        try {
          await this.ready;
        } catch {
          break;
        }
        if (this.closed) break;
        if (gen !== this.generation) continue;

        const startedAt = Date.now();
        const done = deferred();
        this.turn = { done, startedAt };
        this.turnGeneration = gen;
        this.seq++;
        this.messageId = `g${this.seq}`;
        this.text = '';
        this.tools.clear();
        this.emit({ type: 'turn.start', prompt, at: startedAt });

        try {
          const res = await this.client.request(
            'session/prompt',
            { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] },
            null,
          );
          if (this.closed || done.settled) continue;
          const stopReason = typeof record(res)?.stopReason === 'string' ? (record(res)!.stopReason as string) : 'end_turn';
          const interrupted = stopReason === 'cancelled';
          this.emit({
            type: 'turn.result',
            ok: !interrupted,
            interrupted,
            subtype: interrupted ? 'interrupted' : 'success',
            text: this.text,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            durationMs: Math.max(0, Date.now() - startedAt),
            apiDurationMs: 0,
            numTurns: 1,
            totalCostUsd: 0,
            permissionDenials: [],
          });
          done.resolve();
        } catch (err) {
          if (this.closed || done.settled) break;
          if (err instanceof AcpRpcError) {
            const msg = errorText(err);
            this.emit({ type: 'error', fatal: false, message: msg, code: String(err.code) });
            this.emit({
              type: 'turn.result',
              ok: false,
              interrupted: false,
              subtype: 'error_during_execution',
              errors: [msg],
              text: this.text,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              durationMs: Math.max(0, Date.now() - startedAt),
              apiDurationMs: 0,
              numTurns: 1,
              totalCostUsd: 0,
              permissionDenials: [],
            });
            done.resolve();
          } else {
            this.fatal(err);
            break;
          }
        } finally {
          if (this.turn?.done === done) this.turn = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (this.closed || method !== 'session/update') return;
    if (this.loading) return;
    const row = record(params);
    const update = row?.update;
    const kind = typeof record(update)?.sessionUpdate === 'string' ? (record(update)!.sessionUpdate as string) : undefined;
    if (kind === 'agent_message_chunk') {
      const txt = chunkText(update);
      if (txt) {
        this.text += txt;
        this.emit({ type: 'text.delta', messageId: this.messageId || 'g1', text: txt });
      }
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const txt = chunkText(update);
      if (txt) this.emit({ type: 'thinking.delta', messageId: this.messageId || 'g1', text: txt });
      return;
    }
    if (kind === 'session_info_update') {
      const title = typeof record(update)?.title === 'string' ? (record(update)!.title as string).trim() : '';
      if (title) this.emit({ type: 'session.title', title });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const u = record(update);
      const id = typeof u?.toolCallId === 'string' ? u.toolCallId : '';
      if (!id) return;
      const name = typeof u?.title === 'string' && u.title ? u.title : typeof u?.kind === 'string' ? u.kind : 'tool';
      const input = record(u?.rawInput) ?? {};
      const status = typeof u?.status === 'string' ? u.status : '';
      let prev = this.tools.get(id);
      if (!prev) {
        prev = { name, input, started: false };
        this.tools.set(id, prev);
      }
      if (!prev.started) {
        prev.started = true;
        this.emit({ type: 'tool.start', toolUseId: id, name: prev.name, input: { ...prev.input } });
      }
      if (status === 'completed' || status === 'failed') {
        const rawOut = record(u?.rawOutput);
        const content = typeof rawOut?.content === 'string' ? rawOut.content : rawOut ? JSON.stringify(rawOut) : '';
        this.emit({ type: 'tool.result', toolUseId: id, isError: status === 'failed', content });
        this.tools.delete(id);
      }
    }
  }

  private onServerRequest(id: RpcId, method: string, params: unknown): boolean {
    if (method !== PERMISSION_METHOD) return false;
    const call = record(record(params)?.toolCall);
    const toolUseId = typeof call?.toolCallId === 'string' ? call.toolCallId : String(id);
    const title = typeof call?.title === 'string' ? call.title : '';
    const name = title || (typeof call?.kind === 'string' ? call.kind : 'tool');
    const options = record(params)?.options;
    if (this.loading || this.generation !== this.turnGeneration) {
      this.client.respond(id, { outcome: { outcome: 'selected', optionId: denyOptionId(options) } });
      return true;
    }
    if (
      this.hostMcpServers.some((s) => s.name === CHILD_MCP_SERVER && s.builtin !== false) &&
      isAgenturaAgentsTool(name, title)
    ) {
      this.client.respond(id, { outcome: { outcome: 'selected', optionId: allowOptionId(options) } });
      return true;
    }
    if (this.permissionMode === 'bypassPermissions' && this.allowBypass) {
      this.client.respond(id, { outcome: { outcome: 'selected', optionId: allowOptionId(options) } });
      return true;
    }
    this.pending.set(toolUseId, { rpcId: id, options });
    this.emit({
      type: 'permission.request',
      toolUseId,
      toolName: name,
      input: record(call?.rawInput) ?? {},
      canAlwaysAllow: false,
      ...(title ? { title, description: title } : {}),
    });
    return true;
  }

  private abortPending(): void {
    const items = [...this.pending];
    this.pending.clear();
    for (const [toolUseId, p] of items) {
      try {
        this.client.respond(p.rpcId, { outcome: { outcome: 'selected', optionId: denyOptionId(p.options) } });
      } catch {
        // ignore
      }
      this.emit({ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'abort' });
    }
  }

  private onClientClose(message: string): void {
    if (this.closed || message === 'ACP RPC client disposed.') return;
    this.fatal(new Error(message), this.procExited ? 'exit' : 'error');
  }

  private fatal(err: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    this.abortPending();
    const message = errorText(err);
    if (this.turn && !this.turn.done.settled) {
      const startedAt = this.turn.startedAt;
      this.turn.done.resolve();
      this.turn = undefined;
      this.emit({
        type: 'turn.result',
        ok: false,
        interrupted: false,
        subtype: 'error_during_execution',
        errors: [message],
        text: this.text,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        durationMs: Math.max(0, Date.now() - startedAt),
        apiDurationMs: 0,
        numTurns: 1,
        totalCostUsd: 0,
        permissionDenials: [],
      });
    }
    this.emit({ type: 'error', fatal: true, message });
    this.close(reason, message);
    this.client.dispose();
    this.stopProcess();
  }

  private stopProcess(): void {
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    if (this.procExited) return;
    const grace = this.config.graceMs ?? DEFAULT_GRACE_MS;
    const timer = setTimeout(() => {
      if (!this.procExited) this.proc.kill('SIGKILL');
    }, grace);
    timer.unref?.();
    this.proc.on('exit', () => clearTimeout(timer));
    this.proc.kill('SIGTERM');
  }

  private emit(event: AgentEvent): void {
    if (!this.closed) this.events.emit(event);
  }

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }
}
