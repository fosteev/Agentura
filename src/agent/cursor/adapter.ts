import { spawn } from 'node:child_process';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelOption,
  PermissionMode,
  PromptFile,
  PromptImage,
  ResumeOptions,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
} from '../types';
import { CursorRpcClient, MAX_LINE_BYTES, type RpcProcess } from './client';
import { CURSOR_NOT_FOUND } from './executable';
import { CursorMapper } from './mapper';
import { AUTH_METHOD, PROTOCOL_VERSION, currentModelId, modelsFrom, sessionIdOf } from './protocol';

export interface CursorProcess extends RpcProcess {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CursorSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface CursorAdapterConfig {
  /** Путь к `agent`. Нет пути — `createSession` бросает «не найден». */
  executablePath?: string | (() => Promise<string | undefined>);
  spawn?: (path: string, args: string[], options: CursorSpawnOptions) => CursorProcess;
  env?: NodeJS.ProcessEnv;
  /** Версия CLI для `session.init`; резолвер её уже знает. */
  engineVersion?: string;
  clientVersion?: string;
  log?: LogFn;
  timeoutMs?: number;
  /** stdin end → пауза → SIGTERM → ещё пауза → SIGKILL. */
  graceMs?: number;
  /** Сколько Stop ждёт `stopReason`, прежде чем закрыть ход самим. */
  interruptWaitMs?: number;
}

const DEFAULT_GRACE_MS = 2000;
const INTERRUPT_WAIT_MS = 10_000;

function defaultSpawn(path: string, args: string[], options: CursorSpawnOptions): CursorProcess {
  return spawn(path, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as unknown as CursorProcess;
}

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';

  constructor(private readonly config: CursorAdapterConfig = {}) {}

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new CursorSession(this.config, await this.executable(), options);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    return new CursorSession(this.config, await this.executable(), options, sessionId);
  }

  /** Список — этап 4 (`session/list`). Пока пусто, без чтения каталога Cursor. */
  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }

  /** История — этап 4. Пустая история не ошибка вкладки. */
  async loadHistory(): Promise<SessionHistory> {
    return { events: [], turns: 0, skippedTurns: 0 };
  }

  /** Метода переименования спайк не видел: тишина, без файла и без ошибки. */
  async renameSession(): Promise<void> {}

  async accountInfo(): Promise<AccountInfo> {
    return {};
  }

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(CURSOR_NOT_FOUND);
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

class CursorSession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper = new CursorMapper();
  private readonly log: LogFn;
  private readonly proc: CursorProcess;
  private readonly client: CursorRpcClient;
  private readonly ready: Promise<void>;
  private readonly queue: string[] = [];
  private readonly cwd: string;
  private readonly permissionMode: PermissionMode;
  private readonly graceMs: number;
  private readonly interruptWaitMs: number;
  private sessionId = '';
  private model = '';
  private models: ModelOption[] = [];
  private closed = false;
  /** Пока handshake не кончился, `session/update` — повтор истории, не живой ход. */
  private loading = true;
  private draining = false;
  private procExited = false;
  /** Растёт на каждый `interrupt()`: сообщение, взятое до него, в `session/prompt` не уходит. */
  private generation = 0;
  private turn: { done: Deferred; prompt: string; startedAt: number } | undefined;

  constructor(
    private readonly config: CursorAdapterConfig,
    executable: string,
    options: SessionOptions,
    private readonly resumeId?: string,
  ) {
    this.log = config.log ?? (() => {});
    this.cwd = options.cwd;
    this.permissionMode = options.permissionMode ?? 'default';
    this.model = options.model ?? '';
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
    this.interruptWaitMs = config.interruptWaitMs ?? INTERRUPT_WAIT_MS;
    this.events = new EventHub<AgentEvent>((error) =>
      this.log('error', `event subscriber failed: ${String(error)}`),
    );
    this.proc = (config.spawn ?? defaultSpawn)(executable, ['acp'], {
      cwd: options.cwd,
      env: config.env ?? process.env,
      shell: false,
    });
    this.proc.on('exit', () => (this.procExited = true));
    this.client = new CursorRpcClient(this.proc, {
      timeoutMs: config.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => this.onNotification(method, params),
      onStderr: (line) => this.log('debug', `cursor: ${line}`),
      onClose: (error) => this.onClientClose(error.message),
    });
    this.ready = this.handshake(options.model);
    this.ready.catch((error) => this.fatal(error));
  }

  get id(): string {
    return this.sessionId || this.resumeId || '';
  }

  send(
    text: string,
    images?: readonly PromptImage[],
    files?: readonly PromptFile[],
  ): boolean {
    if (this.closed) return false;
    if (images?.length)
      this.log('warn', `cursor: ${images.length} image attachment(s) are not supported and were dropped`);
    if (files?.length)
      this.log('warn', `cursor: ${files.length} file attachment(s) are not supported and were dropped`);
    if (!text) return true;
    this.queue.push(text);
    this.drain().catch((error) => this.log('error', `cursor queue failed: ${String(error)}`));
    return true;
  }

  respondPermission(): boolean {
    return false;
  }
  answerQuestion(): boolean {
    return false;
  }
  decidePlan(): boolean {
    return false;
  }
  /** Режим — этап 3 (`session/set_mode`). Здесь сервер остаётся на том, что прислал `session/new`. */
  async setMode(): Promise<void> {}

  async setModel(model: string): Promise<void> {
    try {
      await this.ready;
      if (this.closed || !this.sessionId) return;
      await this.client.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: 'model',
        value: model,
      });
      this.model = model;
    } catch (error) {
      if (!this.closed) this.log('warn', `session/set_config_option failed: ${errorText(error)}`);
    }
  }

  /** Спайк не записал метод effort. */
  async setEffort(): Promise<void> {}

  /**
   * Stop: `session/cancel` без id, процесс не убиваем.
   * До старта хода очередь снимается синтетическим `turn.start` + `turn.result interrupted`.
   */
  async interrupt(): Promise<void> {
    this.generation++;
    const turn = this.turn;
    if (!turn || turn.done.settled || this.closed) return;
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
      this.log('warn', 'cursor stopReason did not arrive after session/cancel');
      this.abandonTurn();
    }
  }

  capabilities(): Promise<SessionCapabilities> {
    return this.ready.then(
      () => ({ models: this.models, commands: [] }),
      () => ({ models: [], commands: [] }),
    );
  }

  async contextUsage(): Promise<undefined> {
    return undefined;
  }

  compact(): boolean {
    return false;
  }

  async stopTask(): Promise<void> {}

  dispose(): void {
    if (this.closed) return;
    this.finishTurnInterrupted();
    this.close('disposed');
    this.client.dispose();
    this.stopProcess();
  }

  private async handshake(requestedModel: string | undefined): Promise<void> {
    await this.client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'agentura', version: this.config.clientVersion ?? '0.0.0' },
    });
    await this.client.request('authenticate', { methodId: AUTH_METHOD });
    const result = this.resumeId
      ? await this.client.request('session/load', {
          sessionId: this.resumeId,
          cwd: this.cwd,
          mcpServers: [],
        })
      : await this.client.request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (this.closed) return;
    const sessionId = sessionIdOf(result);
    if (!sessionId) throw new Error('Cursor ACP session/new returned no sessionId.');
    this.sessionId = sessionId;
    this.models = modelsFrom(result);
    const reported = currentModelId(result);
    let model = reported ?? requestedModel ?? this.model;
    if (requestedModel && requestedModel !== reported) {
      try {
        await this.client.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: requestedModel,
        });
        model = requestedModel;
      } catch (error) {
        if (this.closed) return;
        this.log('warn', `session/set_config_option failed: ${errorText(error)}`);
      }
    }
    if (this.closed) return;
    this.model = model;
    this.loading = false;
    this.emit({
      type: 'session.init',
      sessionId,
      model,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: this.config.engineVersion ?? '',
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const prompt = this.queue.shift();
        if (prompt === undefined) break;
        const generation = this.generation;
        try {
          await this.ready;
        } catch {
          // handshake уже закрыл сессию через fatal
          break;
        }
        if (this.closed) break;
        if (generation !== this.generation) {
          this.emitAll(this.mapper.interruptBeforeStart(prompt));
          continue;
        }
        const startedAt = Date.now();
        const done = deferred();
        this.turn = { done, prompt, startedAt };
        this.emitAll(this.mapper.startTurn(prompt, startedAt));
        try {
          const result = await this.client.request('session/prompt', {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text: prompt }],
          });
          if (this.closed) break;
          if (this.turn === undefined || this.turn.done.settled) continue;
          this.emitAll(this.mapper.finish(result, startedAt));
          done.resolve();
        } catch (error) {
          if (this.closed || done.settled) break;
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
    if (this.closed || this.loading || method !== 'session/update') return;
    const turn = this.turn;
    if (!turn || turn.done.settled) return;
    const update = (params as { update?: unknown } | undefined)?.update;
    this.emitAll(this.mapper.applyUpdate(update));
  }

  private onClientClose(message: string): void {
    if (this.closed) return;
    if (message === 'Cursor RPC client disposed.') return;
    const exited = this.procExited || /stdout closed|ACP exited|ACP closed/.test(message);
    this.fatal(new Error(message), exited ? 'exit' : 'error');
  }

  /** Процесс умер посреди хода: `turn.result` (ok false), `error` fatal, `session.closed`. */
  private fatal(error: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    const message = errorText(error);
    this.log('error', `cursor session failed: ${message}`);
    const turn = this.turn;
    if (turn && !turn.done.settled) {
      this.emitAll(this.mapper.failOpen(turn.startedAt));
      turn.done.resolve();
      this.turn = undefined;
    }
    this.emit({ type: 'error', fatal: true, message });
    this.close(reason, message);
    this.client.dispose();
    this.stopProcess();
  }

  private abandonTurn(): void {
    const turn = this.turn;
    if (!turn || turn.done.settled) return;
    turn.done.resolve();
    this.emitAll(this.mapper.abandon(turn.startedAt));
  }

  private finishTurnInterrupted(): void {
    this.abandonTurn();
  }

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.turn?.done.resolve();
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  /** stdin end, grace, SIGTERM, ещё grace, SIGKILL. */
  private stopProcess(): void {
    if (this.procExited) return;
    try {
      this.proc.stdin.end();
    } catch {
      // процесс уже мёртв
    }
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (this.procExited) return;
      this.proc.kill();
      hard = setTimeout(() => {
        if (!this.procExited) this.proc.kill('SIGKILL');
      }, this.graceMs);
      hard.unref?.();
    }, this.graceMs);
    timer.unref?.();
    this.proc.on('exit', () => {
      clearTimeout(timer);
      clearTimeout(hard);
    });
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
  }

  private emitAll(events: AgentEvent[]): void {
    for (const event of events) this.emit(event);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
