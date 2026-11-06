import { spawn } from 'node:child_process';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelOption,
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
import { accountFromAbout, emailFromStatus, runCursorCommand } from './account';
import { CursorRpcClient, CursorRpcError, MAX_LINE_BYTES, type RpcId, type RpcProcess } from './client';
import { CURSOR_NOT_FOUND } from './executable';
import { buildCursorHistory, sessionsFrom } from './history';
import { CursorMapper, permissionRequestFrom, planRequestFrom } from './mapper';
import {
  AUTH_METHOD,
  CURSOR_DEBUG_METHODS,
  PERMISSION_METHOD,
  PLAN_METHOD,
  PROTOCOL_VERSION,
  QUESTION_METHOD,
  currentModeId,
  currentModelId,
  cursorModeId,
  modelsFrom,
  permissionOutcome,
  permissionRefusal,
  planOutcome,
  questionSkipped,
  sessionIdOf,
} from './protocol';

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
  /**
   * `agent about` / `agent status` для `accountInfo`. Нет — `execFile`, `shell: false`.
   * Не `acp`: эти команды печатают текст, не JSON-RPC.
   */
  run?: (path: string, args: readonly string[], cwd: string) => Promise<string>;
  timeoutMs?: number;
  /** stdin end → пауза → SIGTERM → ещё пауза → SIGKILL. */
  graceMs?: number;
  /** Сколько Stop ждёт `stopReason`, прежде чем закрыть зависший транспорт. */
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
  /** `-32601` на `session/list` — один warn на адаптер, не на каждый опрос сайдбара. */
  private listWarned = false;

  constructor(private readonly config: CursorAdapterConfig = {}) {}

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new CursorSession(this.config, await this.executable(), options);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    return new CursorSession(this.config, await this.executable(), options, sessionId);
  }

  /**
   * `session/list {cwd}`. Чужой cwd отбрасывается. `-32601` — пустой список и один warn.
   * Падение процесса — отказ промиса: extra-провайдер его уже ловит и не стирает чужие списки.
   */
  async listSessions(dir: string): Promise<SessionInfo[]> {
    try {
      const result = await this.withAcp(dir, (client) => client.request('session/list', { cwd: dir }));
      return sessionsFrom(result, dir);
    } catch (error) {
      if (error instanceof CursorRpcError && error.code === -32601) {
        if (!this.listWarned) {
          this.listWarned = true;
          this.config.log?.('warn', `cursor: session/list is not available: ${errorText(error)}`);
        }
        return [];
      }
      throw error;
    }
  }

  /**
   * Кадры `session/load` сами, не через живой `resumeSession` (тот глушит `session/update`, пока `loading`).
   * Нет данных или ошибка load — пустая история. Нет бинарника — отказ, как у `createSession`.
   */
  async loadHistory(
    sessionId: string,
    cwd: string,
    options: { live?: boolean; tasksAlive?: boolean; maxTurns?: number; stopBefore?: string } = {},
  ): Promise<SessionHistory> {
    const executable = await this.executable();
    try {
      const loaded = await this.acp(executable, cwd, async (client, updates) => {
        const result = await client.request('session/load', { sessionId, cwd, mcpServers: [] });
        return { updates: [...updates], result };
      });
      return buildCursorHistory(loaded.updates, loaded.result, {
        ...(options.live ? { live: true } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      });
    } catch (error) {
      this.config.log?.('warn', `cursor: session/load failed: ${errorText(error)}`);
      return { events: [], turns: 0, skippedTurns: 0 };
    }
  }

  /** Метода переименования спайк не видел: тишина, без файла, без `globalState` и без ошибки. */
  async renameSession(sessionId: string, title: string, cwd: string): Promise<void> {
    void sessionId;
    void title;
    void cwd;
  }

  /**
   * `agent about`: почта и тариф. Нет почты — `agent status`. Нет строк или сбой — `{}`.
   * Процесс `acp` не поднимается.
   */
  async accountInfo(cwd: string): Promise<AccountInfo> {
    let executable: string;
    try {
      executable = await this.executable();
    } catch {
      return {};
    }
    const run = this.config.run ?? runCursorCommand;
    let info: AccountInfo = {};
    try {
      info = accountFromAbout(await run(executable, ['about'], cwd));
    } catch (error) {
      this.config.log?.('warn', `cursor: agent about failed: ${errorText(error)}`);
    }
    if (!info.email) {
      try {
        const email = emailFromStatus(await run(executable, ['status'], cwd));
        if (email) info.email = email;
      } catch (error) {
        this.config.log?.('warn', `cursor: agent status failed: ${errorText(error)}`);
      }
    }
    return info;
  }

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(CURSOR_NOT_FOUND);
    return path;
  }

  /** Короткий `agent acp`: initialize, authenticate, один запрос, затем тот же shutdown, что у сессии. */
  private withAcp<T>(
    cwd: string,
    fn: (client: CursorRpcClient, updates: unknown[]) => Promise<T>,
  ): Promise<T> {
    return this.executable().then((executable) => this.acp(executable, cwd, fn));
  }

  private async acp<T>(
    executable: string,
    cwd: string,
    fn: (client: CursorRpcClient, updates: unknown[]) => Promise<T>,
  ): Promise<T> {
    const proc = (this.config.spawn ?? defaultSpawn)(executable, ['acp'], {
      cwd,
      env: this.config.env ?? process.env,
      shell: false,
    });
    let exited = false;
    proc.on('exit', () => (exited = true));
    const updates: unknown[] = [];
    const client = new CursorRpcClient(proc, {
      timeoutMs: this.config.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const update = updateOf(params);
        if (update !== undefined) updates.push(update);
      },
      onStderr: (line) => this.config.log?.('debug', `cursor: ${line}`),
    });
    try {
      await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'agentura', version: this.config.clientVersion ?? '0.0.0' },
      });
      await client.request('authenticate', { methodId: AUTH_METHOD });
      return await fn(client, updates);
    } finally {
      client.dispose();
      shutdownCursor(proc, this.config.graceMs ?? DEFAULT_GRACE_MS, () => exited);
    }
  }
}

type Pending =
  | { kind: 'permission'; rpcId: RpcId; options: unknown }
  | { kind: 'plan'; rpcId: RpcId };

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
  private permissionMode: PermissionMode;
  private readonly allowBypass: boolean;
  /** Режим, который сейчас принял сервер. `session/new` без поля — `agent`. */
  private serverMode: 'agent' | 'plan' = 'agent';
  private readonly pending = new Map<string, Pending>();
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
  /** Поколение хода, который уже ушёл в `session/prompt`. После Stop они расходятся, и поздний запрос — не карточка. */
  private turnGeneration = 0;
  private turn: { done: Deferred; prompt: string; startedAt: number } | undefined;

  constructor(
    private readonly config: CursorAdapterConfig,
    executable: string,
    options: SessionOptions,
    private readonly resumeId?: string,
  ) {
    this.log = config.log ?? (() => {});
    this.cwd = options.cwd;
    this.allowBypass = options.allowBypassPermissions === true;
    const requested = options.permissionMode ?? 'default';
    this.permissionMode = requested === 'bypassPermissions' && !this.allowBypass ? 'default' : requested;
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
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
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

  respondPermission(toolUseId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(toolUseId);
    if (!pending || pending.kind !== 'permission') return false;
    this.pending.delete(toolUseId);
    this.client.respond(pending.rpcId, permissionOutcome(pending.options, decision));
    this.emit({
      type: 'permission.resolved',
      toolUseId,
      decision: decision === 'deny' ? 'deny' : 'allow',
      by: 'user',
    });
    return true;
  }

  /** `cursor/ask_question` спайк не видел: ответа с карточки нет. */
  answerQuestion(): boolean {
    return false;
  }

  decidePlan(toolUseId: string, decision: PlanDecision): boolean {
    const pending = this.pending.get(toolUseId);
    if (!pending || pending.kind !== 'plan') return false;
    this.pending.delete(toolUseId);
    this.client.respond(
      pending.rpcId,
      decision.approve ? planOutcome({ approve: true }) : planOutcome({ approve: false, feedback: decision.feedback }),
    );
    if (!decision.approve && decision.interrupt) void this.interrupt();
    return true;
  }

  /**
   * `session/set_mode`. `plan` → `plan`; `default` и `acceptEdits` → `agent`.
   * `acceptEdits` не включает автопринятие. `bypassPermissions` без флага молча становится `default`.
   * Отказ сервера — нефатальный `error`, сессия остаётся.
   */
  async setMode(mode: PermissionMode): Promise<void> {
    const next = mode === 'bypassPermissions' && !this.allowBypass ? 'default' : mode;
    try {
      await this.ready;
    } catch {
      return;
    }
    if (this.closed || !this.sessionId) return;
    const modeId = cursorModeId(next);
    try {
      await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId });
    } catch (error) {
      if (!this.closed)
        this.emit({ type: 'error', fatal: false, message: `session/set_mode failed: ${errorText(error)}` });
      return;
    }
    this.serverMode = modeId;
    this.permissionMode = next;
    this.emit({ type: 'mode.changed', mode: next });
  }

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
   * Stop: `session/cancel` без id; при отсутствии ответа закрываем зависший процесс.
   * До старта хода очередь снимается синтетическим `turn.start` + `turn.result interrupted`.
   */
  async interrupt(): Promise<void> {
    this.generation++;
    this.abortPending();
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
      this.fatal(new Error('Cursor did not confirm cancellation; the connection was closed. Resume the session to continue.'));
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
    this.abortPending();
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
    const sessionId = this.resumeId ?? sessionIdOf(result);
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
    const reportedMode = currentModeId(result);
    if (reportedMode === 'plan' || reportedMode === 'agent') this.serverMode = reportedMode;
    try {
      await this.syncInitialMode();
    } catch (error) {
      if (this.closed) return;
      this.emit({ type: 'error', fatal: false, message: `session/set_mode failed: ${errorText(error)}` });
      this.permissionMode = this.serverMode === 'plan' ? 'plan' : 'default';
    }
    if (this.closed) return;
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
        this.turnGeneration = generation;
        this.emitAll(this.mapper.startTurn(prompt, startedAt));
        try {
          // Ответ приходит после всего хода, включая ожидание разрешений пользователя.
          const result = await this.client.request('session/prompt', {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text: prompt }],
          }, null);
          if (this.closed) break;
          if (generation !== this.generation) this.abortPending();
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
    if ((CURSOR_DEBUG_METHODS as readonly string[]).includes(method)) {
      this.log('debug', `cursor: ${method}`);
      return;
    }
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

  /**
   * Запрос сервера. `true` — ответ ушёл отсюда (или уйдёт из `respondPermission` / `decidePlan`).
   * `false` — клиент отвечает сам: разрешение отказом, прочее `-32601`, и только один кадр.
   */
  private onServerRequest(id: RpcId, method: string, params: unknown): boolean {
    if ((CURSOR_DEBUG_METHODS as readonly string[]).includes(method)) {
      this.log('debug', `cursor: ${method}`);
      return false;
    }
    try {
      if (method === PERMISSION_METHOD) return this.onPermission(id, params);
      if (method === PLAN_METHOD) return this.onPlan(id, params);
      if (method === QUESTION_METHOD) {
        this.client.respond(id, questionSkipped());
        return true;
      }
    } catch (error) {
      this.log('warn', `cursor: ${method} failed: ${errorText(error)}`);
      if (method === PERMISSION_METHOD) this.client.respond(id, permissionRefusal());
      else if (method === PLAN_METHOD) this.client.respond(id, planOutcome({ approve: false, feedback: 'rejected' }));
      else this.client.respond(id, questionSkipped());
      return true;
    }
    return false;
  }

  private onPermission(id: RpcId, params: unknown): boolean {
    const built = permissionRequestFrom(params);
    if (!built || this.loading || this.generation !== this.turnGeneration) {
      this.log('warn', 'cursor: session/request_permission had no card; refusing');
      this.client.respond(id, built ? permissionOutcome(built.options, 'deny') : permissionRefusal());
      return true;
    }
    if (this.permissionMode === 'bypassPermissions' && this.allowBypass) {
      this.client.respond(id, permissionOutcome(built.options, 'allow'));
      return true;
    }
    this.track(built.toolUseId, { kind: 'permission', rpcId: id, options: built.options });
    this.emit(built.event);
    return true;
  }

  private onPlan(id: RpcId, params: unknown): boolean {
    const built = planRequestFrom(params);
    if (!built || this.loading || this.generation !== this.turnGeneration) {
      this.log('warn', 'cursor: cursor/create_plan had no card; rejecting');
      this.client.respond(id, planOutcome({ approve: false, feedback: 'rejected' }));
      return true;
    }
    this.track(built.toolUseId, { kind: 'plan', rpcId: id });
    this.emit(built.event);
    return true;
  }

  private track(toolUseId: string, next: Pending): void {
    const prev = this.pending.get(toolUseId);
    if (prev) this.settle(toolUseId, prev);
    this.pending.set(toolUseId, next);
  }

  /** Висящий запрос не остаётся: отказ серверу, карточка разрешения закрывается как abort. */
  private abortPending(): void {
    const open = [...this.pending];
    this.pending.clear();
    for (const [toolUseId, pending] of open) this.settle(toolUseId, pending);
  }

  private settle(toolUseId: string, pending: Pending): void {
    this.pending.delete(toolUseId);
    try {
      if (pending.kind === 'permission') {
        this.client.respond(pending.rpcId, permissionOutcome(pending.options, 'deny'));
        this.emit({ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'abort' });
      } else {
        this.client.respond(pending.rpcId, planOutcome({ approve: false, feedback: 'cancelled' }));
      }
    } catch (error) {
      this.log('warn', `cursor: pending ${pending.kind} failed: ${errorText(error)}`);
    }
  }

  /** Догнать сервер до запрошенного режима. `acceptEdits` и `default` оба ждут `agent` и вызов не делают, если он уже agent. */
  private async syncInitialMode(): Promise<void> {
    const want = cursorModeId(this.permissionMode);
    if (this.serverMode === want) return;
    await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId: want });
    this.serverMode = want;
  }

  /** Процесс умер посреди хода: `turn.result` (ok false), `error` fatal, `session.closed`. */
  private fatal(error: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    this.abortPending();
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
    this.abortPending();
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
    shutdownCursor(this.proc, this.graceMs, () => this.procExited);
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

/** `session/update.params.update`. Нет объекта — кадра истории нет. */
function updateOf(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  return (params as { update?: unknown }).update;
}

/** stdin end, grace, SIGTERM, ещё grace, SIGKILL. Уже вышедший процесс не трогаем. */
function shutdownCursor(proc: CursorProcess, graceMs: number, exited: () => boolean): void {
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
