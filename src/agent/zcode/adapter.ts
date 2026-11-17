import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
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
import { ZCodeRpcClient, ZCodeRpcError, type ZCodeRpcId, type ZCodeRpcProcess } from './client';
import { runZCodeDoctor, ZCODE_NOT_FOUND, type ZCodeDoctorInfo } from './executable';
import {
  isZCodeAuthFailure,
  parseZCodeModelSelection,
  parseZCodeModelsFromSettings,
  parseZCodeSessions,
  permissionModeFromZCode,
  zcodeModeOfPermission,
  zcodePermissionDecision,
  zcodeUsageOf,
} from './protocol';

export interface ZCodeProcess extends ZCodeRpcProcess {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ZCodeSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export type ZCodeSpawner = (
  command: string,
  args: string[],
  options: ZCodeSpawnOptions,
) => ZCodeProcess;

export interface ZCodeAdapterConfig {
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  clientVersion?: string;
  spawn?: ZCodeSpawner;
  doctor?: (executable: string, cwd?: string) => Promise<ZCodeDoctorInfo>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  graceMs?: number;
  interruptWaitMs?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

const DEFAULT_GRACE_MS = 500;
const INTERRUPT_WAIT_MS = 2_000;
export const ZCODE_INSPECT_TIMEOUT_MS = 12_000;

function defaultSpawn(command: string, args: string[], options: ZCodeSpawnOptions): ZCodeProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as unknown as ZCodeProcess;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function errorText(err: unknown): string {
  if (err instanceof ZCodeRpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function handleBuiltinZCodeRequest(client: ZCodeRpcClient, id: ZCodeRpcId, method: string): boolean {
  if (method === 'session/requestRuntimePreferences') {
    client.respond(id, { nativeSearchEnhancementsEnabled: false });
    return true;
  }
  if (method === 'interaction/requestOfficialMcpAuthHeaders') {
    client.respond(id, { ok: false, reason: 'official_auth_unavailable' });
    return true;
  }
  return false;
}

export interface ZCodeInspectResult {
  doctor?: ZCodeDoctorInfo;
  capabilities?: unknown;
  models: ModelOption[];
  authenticated: boolean;
  reason?: string;
}

export class ZCodeAdapter implements AgentAdapter {
  readonly id = 'zcode';

  constructor(private readonly config: ZCodeAdapterConfig = {}) {}

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(ZCODE_NOT_FOUND);
    return path;
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    if (options.hostMcpServers && options.hostMcpServers.length > 0) {
      this.config.log?.(
        'warn',
        'zcode app-server does not support per-session HTTP mcpServers injection without mutating ~/.zcode; host MCP servers were not attached.',
      );
    }
    return new ZCodeSession(this.config, await this.executable(), options);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    if (options.hostMcpServers && options.hostMcpServers.length > 0) {
      this.config.log?.(
        'warn',
        'zcode app-server does not support per-session HTTP mcpServers injection without mutating ~/.zcode; host MCP servers were not attached.',
      );
    }
    return new ZCodeSession(this.config, await this.executable(), options, sessionId);
  }

  /**
   * Читает `zcode doctor --json` и `zcode app-server --stdio` (`runtime/capabilities` + `session/create` probe)
   * без записи или изменения файлов в `~/.zcode`.
   */
  async inspectRuntime(cwd: string): Promise<ZCodeInspectResult> {
    const executable = await this.executable();
    const doctor = await (this.config.doctor ?? runZCodeDoctor)(executable, cwd).catch(() => undefined);
    const tempDb = join(tmpdir(), `agentura-zcode-inspect-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const baseEnv = this.config.env ?? process.env;
    const inspectEnv: NodeJS.ProcessEnv = { ...baseEnv, ZCODE_SESSION_DB_PATH: tempDb };

    try {
      return await this.withServer(
        executable,
        cwd,
        async (client) => {
          const capabilities = await client.request('runtime/capabilities', {}).catch(() => undefined);
          const created = await client
            .request('session/create', {
              workspace: { workspacePath: cwd, workspaceKey: cwd },
              mode: 'guarded',
            })
            .catch(() => undefined);
          const models = [
            ...parseZCodeModelsFromSettings(created),
            ...parseZCodeModelsFromSettings(capabilities),
          ];
          const uniqueModels = Array.from(new Map(models.map((m) => [m.value, m])).values());

          // Check authentication cleanly: desktop business tokens in ~/.zcode/v2/credentials.json fail standalone
          // with `project_token_login_failed` (or empty model list when isolated/logged out), and ZCode API keys require balance.
          const hasOfficialToken = Boolean(baseEnv['ZCODE_OFFICIAL_ENDPOINT_TOKEN']);
          if (hasOfficialToken) {
            return { doctor, capabilities, models: uniqueModels, authenticated: true };
          }
          if (uniqueModels.length === 0) {
            return {
              doctor,
              capabilities,
              models: [],
              authenticated: false,
              reason:
                'ZCode standalone authentication is not configured or cannot reuse desktop Z.ai OAuth tokens (`project_token_login_failed` / `model.available` empty). Do not mutate ~/.zcode.',
            };
          }
          const sessModel = record(record(record(created)?.session)?.model);
          const currentProvider = typeof sessModel?.providerId === 'string' ? sessModel.providerId : '';
          const currentModelId = typeof sessModel?.modelId === 'string' ? sessModel.modelId : '';
          const selected = currentModelId
            ? { providerId: currentProvider || 'default', modelId: currentModelId }
            : parseZCodeModelSelection(uniqueModels[0]!.value);
          try {
            await client.request('provider/testModelConnectivity', {
              workspace: { workspacePath: cwd, workspaceKey: cwd },
              selection: selected,
            });
          } catch (err) {
            return {
              doctor,
              capabilities,
              models: uniqueModels,
              authenticated: false,
              reason: errorText(err),
            };
          }
          return { doctor, capabilities, models: uniqueModels, authenticated: true };
        },
        inspectEnv,
      );
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${tempDb}${suffix}`, { force: true });
      }
    }
  }

  async listSessions(dir: string): Promise<SessionInfo[]> {
    let executable: string;
    try {
      executable = await this.executable();
    } catch {
      return [];
    }
    try {
      return await this.withServer(executable, dir, async (client) => {
        const res = await client.request('session/list', { workspace: dir });
        return parseZCodeSessions(res, dir).map((s) => ({
          id: s.sessionId,
          title: s.title,
          cwd: s.workspacePath ?? dir,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }));
      });
    } catch {
      return [];
    }
  }

  async loadHistory(sessionId: string, cwd: string): Promise<SessionHistory> {
    const executable = await this.executable();
    try {
      const res = await this.withServer(executable, cwd, (client) =>
        client.request('session/messages', { sessionId }),
      );
      const messages = Array.isArray(record(res)?.messages) ? (record(res)!.messages as unknown[]) : [];
      const events: AgentEvent[] = [];
      let turns = 0;
      for (const m of messages) {
        const msg = record(m);
        const info = record(msg?.info);
        const role = typeof info?.role === 'string' ? info.role : '';
        const parts = Array.isArray(msg?.parts) ? msg.parts : [];
        const text = parts
          .map((p) => record(p))
          .filter((p) => p?.type === 'text' && typeof p.text === 'string')
          .map((p) => p!.text as string)
          .join('');
        if (role === 'user' && text) {
          turns++;
          events.push({ type: 'turn.start', prompt: text, at: typeof info?.time === 'object' ? Number(record(info.time)?.created ?? Date.now()) : Date.now() });
        } else if (role === 'assistant' && text) {
          events.push({
            type: 'turn.result',
            ok: true,
            interrupted: false,
            subtype: 'success',
            text,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            durationMs: 0,
            apiDurationMs: 0,
            numTurns: 1,
            totalCostUsd: 0,
            permissionDenials: [],
          });
        }
      }
      return { events, turns, skippedTurns: 0 };
    } catch {
      return { events: [], turns: 0, skippedTurns: 0 };
    }
  }

  async renameSession(): Promise<void> {}

  async accountInfo(): Promise<AccountInfo> {
    return {};
  }

  private async withServer<T>(
    executable: string,
    cwd: string,
    fn: (client: ZCodeRpcClient) => Promise<T>,
    envOverride?: NodeJS.ProcessEnv,
  ): Promise<T> {
    const proc = (this.config.spawn ?? defaultSpawn)(executable, ['app-server', '--stdio'], {
      cwd,
      env: envOverride ?? this.config.env ?? process.env,
      shell: false,
    });
    let exited = false;
    proc.on('exit', () => (exited = true));
    const ref: { client?: ZCodeRpcClient } = {};
    const client = new ZCodeRpcClient(proc, {
      timeoutMs: this.config.timeoutMs ?? ZCODE_INSPECT_TIMEOUT_MS,
      onServerRequest: (id, method) => (ref.client ? handleBuiltinZCodeRequest(ref.client, id, method) : false),
      onStderr: (line) => this.config.log?.('debug', `zcode: ${line}`),
    });
    ref.client = client;
    try {
      return await fn(client);
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

class ZCodeSession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  private readonly proc: ZCodeProcess;
  private readonly client: ZCodeRpcClient;
  private readonly ready: Promise<void>;
  private readonly queue: string[] = [];
  private readonly cwd: string;
  private readonly allowBypass: boolean;
  private permissionMode: PermissionMode;
  private readonly pending = new Map<string, ZCodeRpcId>();
  private sessionId = '';
  private model = '';
  private models: ModelOption[] = [];
  private thoughtLevel: string | undefined;
  private seq = 0;
  private messageId = '';
  private text = '';
  private closed = false;
  private draining = false;
  private procExited = false;
  private turn: { done: Deferred; startedAt: number } | undefined;

  constructor(
    private readonly config: ZCodeAdapterConfig,
    executable: string,
    options: SessionOptions,
    private readonly resumeId?: string,
  ) {
    this.log = config.log ?? (() => {});
    this.cwd = options.cwd;
    this.allowBypass = options.allowBypassPermissions === true;
    const req = options.permissionMode ?? 'default';
    this.permissionMode = req === 'bypassPermissions' && !this.allowBypass ? 'default' : req;
    this.model = options.model ?? '';
    this.thoughtLevel = options.effort;
    this.events = new EventHub<AgentEvent>((e) => this.log('error', `zcode subscriber: ${String(e)}`));

    this.proc = (config.spawn ?? defaultSpawn)(executable, ['app-server', '--stdio'], {
      cwd: options.cwd,
      env: config.env ?? process.env,
      shell: false,
    });
    this.proc.on('exit', () => (this.procExited = true));
    this.client = new ZCodeRpcClient(this.proc, {
      timeoutMs: config.timeoutMs ?? 120_000,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
      onStderr: (line) => this.log('debug', `zcode: ${line}`),
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
    if (images?.length) this.log('warn', `zcode: dropped ${images.length} image(s)`);
    if (files?.length) this.log('warn', `zcode: dropped ${files.length} file(s)`);
    if (!text) return true;
    this.queue.push(text);
    this.drain().catch((err) => this.log('error', `zcode queue: ${String(err)}`));
    return true;
  }

  respondPermission(toolUseId: string, decision: PermissionDecision): boolean {
    const rpcId = this.pending.get(toolUseId);
    if (rpcId === undefined) return false;
    this.pending.delete(toolUseId);
    this.client.respond(rpcId, zcodePermissionDecision(decision));
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
      await this.client.request('session/setMode', {
        sessionId: this.sessionId,
        mode: zcodeModeOfPermission(next, this.allowBypass),
      });
      this.permissionMode = next;
      this.emit({ type: 'mode.changed', mode: next });
    } catch (err) {
      if (!this.closed) this.emit({ type: 'error', fatal: false, message: `session/setMode failed: ${errorText(err)}` });
    }
  }

  async setModel(model: string): Promise<void> {
    await this.ready.catch(() => undefined);
    if (this.closed || !this.sessionId || !model) return;
    try {
      await this.client.request('session/setModel', {
        sessionId: this.sessionId,
        model: parseZCodeModelSelection(model),
      });
      this.model = model;
    } catch (err) {
      if (!this.closed) this.emit({ type: 'error', fatal: false, message: `session/setModel failed: ${errorText(err)}` });
    }
  }

  async setEffort(): Promise<void> {}

  async interrupt(): Promise<void> {
    if (this.closed || !this.sessionId) return;
    try {
      await this.client.request('session/stop', { sessionId: this.sessionId });
    } catch {
      // ignore
    }
    const timer = new Promise<void>((r) =>
      setTimeout(r, this.config.interruptWaitMs ?? INTERRUPT_WAIT_MS),
    );
    if (this.turn && !this.turn.done.settled) {
      await Promise.race([this.turn.done.promise, timer]);
    }
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
    const mode = zcodeModeOfPermission(this.permissionMode, this.allowBypass);
    const created = await this.client.request('session/create', {
      workspace: { workspacePath: this.cwd, workspaceKey: this.cwd },
      mode,
      ...(this.resumeId ? { resumeSessionId: this.resumeId } : {}),
      ...(requestedModel ? { model: parseZCodeModelSelection(requestedModel) } : {}),
      ...(this.thoughtLevel ? { thoughtLevel: this.thoughtLevel } : {}),
    });
    if (this.closed) return;
    const sess = record(record(created)?.session);
    const sid = (typeof sess?.sessionId === 'string' && sess.sessionId) || this.resumeId || '';
    if (!sid) throw new Error('zcode session/create returned no sessionId.');
    this.sessionId = sid;
    this.models = parseZCodeModelsFromSettings(created);
    const actualMode = typeof sess?.mode === 'string' ? permissionModeFromZCode(sess.mode) : this.permissionMode;
    this.permissionMode = actualMode;
    this.model = requestedModel || this.models[0]?.value || '';

    await this.client.request('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous' });
    if (this.closed) return;

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
        try {
          await this.ready;
        } catch {
          break;
        }
        if (this.closed) break;

        const startedAt = Date.now();
        const done = deferred();
        this.turn = { done, startedAt };
        this.seq++;
        this.messageId = `z${this.seq}`;
        this.text = '';
        this.emit({ type: 'turn.start', prompt, at: startedAt });

        try {
          await this.client.request('session/send', {
            sessionId: this.sessionId,
            content: prompt,
            ...(this.model ? { modelSelection: parseZCodeModelSelection(this.model) } : {}),
            ...(this.thoughtLevel ? { thoughtLevel: this.thoughtLevel } : {}),
          });
          await done.promise;
        } catch (err) {
          if (this.closed || done.settled) break;
          const msg = errorText(err);
          this.emit({ type: 'error', fatal: false, message: msg });
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
        } finally {
          if (this.turn?.done === done) this.turn = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (this.closed) return;
    if (method === 'state.updated') {
      const models = parseZCodeModelsFromSettings(record(params)?.patch);
      if (models.length > 0) this.models = models;
      return;
    }
    if (method !== 'session/event') return;
    const ev = record(params);
    if (!ev) return;
    const sid = typeof ev.sessionId === 'string' ? ev.sessionId : '';
    if (sid && this.sessionId && sid !== this.sessionId) return;
    const type = typeof ev.type === 'string' ? ev.type : '';
    const payload = record(ev.payload) ?? {};

    switch (type) {
      case 'session.titleUpdated': {
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        if (title) this.emit({ type: 'session.title', title });
        break;
      }
      case 'model.streaming':
      case 'message.part.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        const field = typeof payload.field === 'string' ? payload.field : typeof payload.kind === 'string' ? payload.kind : 'text';
        if (!delta) break;
        if (field === 'reasoning') {
          this.emit({ type: 'thinking.delta', messageId: this.messageId || 'z1', text: delta });
        } else if (field === 'text') {
          this.text += delta;
          this.emit({ type: 'text.delta', messageId: this.messageId || 'z1', text: delta });
        }
        break;
      }
      case 'tool.updated': {
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
        const kind = typeof payload.kind === 'string' ? payload.kind : '';
        if (!toolCallId) break;
        if (kind === 'started') {
          this.emit({
            type: 'tool.start',
            toolUseId: toolCallId,
            name: toolName,
            input: record(payload.input) ?? {},
          });
        } else if (kind === 'result' || kind === 'error') {
          const content =
            typeof payload.output === 'string'
              ? payload.output
              : typeof payload.error === 'string'
                ? payload.error
                : '';
          this.emit({ type: 'tool.result', toolUseId: toolCallId, isError: kind === 'error', content });
        }
        break;
      }
      case 'turn.completed': {
        const resultType = typeof payload.resultType === 'string' ? payload.resultType : 'success';
        const response = typeof payload.response === 'string' && payload.response ? payload.response : this.text;
        const ok = resultType === 'success';
        const interrupted = resultType === 'cancelled';
        const startedAt = this.turn?.startedAt ?? Date.now();
        this.emit({
          type: 'turn.result',
          ok,
          interrupted,
          subtype: interrupted ? 'interrupted' : ok ? 'success' : 'error_during_execution',
          text: response,
          usage: zcodeUsageOf(payload.usage),
          durationMs: typeof payload.duration === 'number' ? payload.duration : Math.max(0, Date.now() - startedAt),
          apiDurationMs: 0,
          numTurns: 1,
          totalCostUsd: 0,
          permissionDenials: [],
        });
        this.turn?.done.resolve();
        break;
      }
      case 'turn.failed': {
        const errObj = record(payload.error);
        const msg =
          (typeof errObj?.message === 'string' && errObj.message) ||
          (typeof errObj?.detail === 'string' && errObj.detail) ||
          'ZCode turn failed';
        const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
        const suffix = isZCodeAuthFailure(msg) ? ' (standalone ZCode authentication required)' : '';
        const fullMsg = `${msg}${suffix}`;
        this.emit({ type: 'error', fatal: false, message: fullMsg, ...(code ? { code } : {}) });
        const startedAt = this.turn?.startedAt ?? Date.now();
        this.emit({
          type: 'turn.result',
          ok: false,
          interrupted: false,
          subtype: 'error_during_execution',
          errors: [fullMsg],
          text: this.text,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          durationMs: Math.max(0, Date.now() - startedAt),
          apiDurationMs: 0,
          numTurns: 1,
          totalCostUsd: 0,
          permissionDenials: [],
        });
        this.turn?.done.resolve();
        break;
      }
      default:
        break;
    }
  }

  private onServerRequest(id: ZCodeRpcId, method: string, params: unknown): boolean {
    if (handleBuiltinZCodeRequest(this.client, id, method)) return true;
    if (method !== 'interaction/requestPermission') return false;
    const req = record(params);
    const toolUseId = typeof req?.toolCallId === 'string' ? req.toolCallId : typeof req?.requestId === 'string' ? req.requestId : String(id);
    const toolName = typeof req?.toolName === 'string' ? req.toolName : 'tool';
    const reason = typeof req?.reason === 'string' ? req.reason : undefined;
    if (this.permissionMode === 'bypassPermissions' && this.allowBypass) {
      this.client.respond(id, { decision: 'allow' });
      return true;
    }
    this.pending.set(toolUseId, id);
    this.emit({
      type: 'permission.request',
      toolUseId,
      toolName,
      input: record(req?.input) ?? {},
      canAlwaysAllow: false,
      ...(reason ? { title: reason, description: reason } : {}),
    });
    return true;
  }

  private abortPending(): void {
    const items = [...this.pending];
    this.pending.clear();
    for (const [toolUseId, rpcId] of items) {
      try {
        this.client.respond(rpcId, { decision: 'deny' });
      } catch {
        // ignore
      }
      this.emit({ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'abort' });
    }
  }

  private onClientClose(message: string): void {
    if (this.closed || message === 'ZCode RPC client disposed.') return;
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
