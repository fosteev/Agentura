import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
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
import { AgyAcpMapper, toolInput, toolName } from './acpMapper';
import {
  AGY_CLIENT_CAPABILITIES,
  AGY_PROTOCOL_VERSION,
  ELICITATION_METHOD,
  agentVersionOf,
  agyModeId,
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
  tierNameOf,
  type AgyConfig,
  type ParsedElicitation,
} from './acpProtocol';
import { AGY_NOT_FOUND } from './executable';
import { buildAgyHistory } from './history';
import { AgySessionIndex, type AgySessionSettings, type AgyStateStore } from './sessionIndex';
import { mapAgyTool } from './tools';

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
  /** Путь к `agy` (`antigravityEngine.path()`); нет пути — `createSession` бросает «не найден». */
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  log?: LogFn;
  /** База окружения процесса; по умолчанию `process.env` целиком (вход agy живёт в `~/.gemini`). */
  env?: NodeJS.ProcessEnv;
  /** Версия `agy` для `session.init.engineVersion` (из локатора); нет — `agentInfo.version` из `initialize`. */
  engineVersion?: string | (() => string | undefined);
  clientVersion?: string;
  /** Хранилище Agentura (`globalState`): пользовательские имена сессий (`renameSession`). */
  state?: AgyStateStore;
  /** Подмена запуска процесса в тестах. */
  spawn?: (path: string, args: string[], options: AgySpawnOptions) => AgyAcpProcess;
  timeoutMs?: number;
  /** `stdin.end()` → пауза (беседа сохраняется при штатном закрытии) → SIGTERM → ещё пауза → SIGKILL. */
  graceMs?: number;
  /** Сколько Stop ждёт `stopReason`, прежде чем закрыть зависший транспорт. */
  interruptWaitMs?: number;
}

const DEFAULT_GRACE_MS = 2000;
const INTERRUPT_WAIT_MS = 10_000;
/** Тариф аккаунта меняется редко; `session/new` ради него — отдельный процесс `agy acp`. */
const ACCOUNT_TTL_MS = 10 * 60_000;

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

  constructor(private readonly config: AntigravityAdapterConfig = {}) {
    this.index = new AgySessionIndex(config.state);
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new AgySession(this.config, await this.executable(), options, (name) => this.noteTier(name), this.index);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    return new AgySession(this.config, await this.executable(), { ...options, ...this.index.settingsOf(sessionId) }, (name) => this.noteTier(name), this.index, sessionId);
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
      });
      const saved = this.index.settingsOf(sessionId);
      if (saved?.model) history.model = saved.model;
      if (saved) history.mode = saved.permissionMode;
      return history;
    } catch (error) {
      this.config.log?.('warn', `agy: session/load failed: ${errorText(error)}`);
      return { events: [], turns: 0, skippedTurns: 0 };
    }
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
    const proc = (this.config.spawn ?? defaultSpawn)(executable, ['acp'], {
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
class AgySession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper = new AgyAcpMapper();
  private readonly log: LogFn;
  private readonly proc: AgyAcpProcess;
  private readonly client: AcpRpcClient;
  private readonly ready: Promise<void>;
  private readonly queue: { text: string; images: readonly PromptImage[] }[] = [];
  private readonly cwd: string;
  private permissionMode: PermissionMode;
  private readonly allowBypass: boolean;
  private readonly graceMs: number;
  private readonly interruptWaitMs: number;
  /** Режим, который сейчас принял сервер (`current_mode_update` отстаёт от запросов — ему не верим). */
  private serverMode = 'default';
  private config: AgyConfig = { combinedIds: [] };
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
  private turn: { done: Deferred; startedAt: number } | undefined;
  /** `session/set_*` идут строго по очереди: ответ на смену модели нужен для решения про `thought_level`. */
  private settings: Promise<unknown> = Promise.resolve();

  private readonly pendingPermissions = new Map<string, { id: RpcId; toolUseId: string }>();
  private readonly pendingQuestions = new Map<string, { id: RpcId; toolUseId: string; parsed: ParsedElicitation }>();

  constructor(
    private readonly config0: AntigravityAdapterConfig,
    executable: string,
    options: SessionOptions,
    private readonly onTier: (name: string | undefined) => void,
    private readonly index: AgySessionIndex,
    private readonly resumeId?: string,
  ) {
    this.log = config0.log ?? (() => {});
    this.cwd = options.cwd;
    this.allowBypass = options.allowBypassPermissions === true;
    const requested = options.permissionMode ?? 'default';
    this.permissionMode = requested === 'bypassPermissions' && !this.allowBypass ? 'default' : requested;
    this.effort = options.effort;
    this.graceMs = config0.graceMs ?? DEFAULT_GRACE_MS;
    this.interruptWaitMs = config0.interruptWaitMs ?? INTERRUPT_WAIT_MS;
    this.events = new EventHub<AgentEvent>((error) => this.log('error', `event subscriber failed: ${String(error)}`));
    this.proc = (config0.spawn ?? defaultSpawn)(executable, ['acp'], {
      cwd: options.cwd,
      env: config0.env ?? process.env,
      shell: false,
    });
    this.proc.on('exit', () => (this.procExited = true));
    this.client = new AcpRpcClient(this.proc, {
      engine: 'Antigravity',
      timeoutMs: config0.timeoutMs ?? 120_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
      onStderr: (line) => this.log('debug', `agy: ${line}`),
      onClose: (error) => this.onClientClose(error.message),
    });
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
    return true;
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    const p = this.pendingQuestions.get(toolUseId);
    if (!p) return false;
    this.pendingQuestions.delete(toolUseId);
    const res = formatElicitationAnswer(p.parsed.properties, p.parsed.questions, answers);
    this.client.respond(p.id, res);
    return true;
  }

  decidePlan(): boolean {
    return false;
  }
  compact(): boolean {
    return false;
  }
  async stopTask(): Promise<void> {}

  /**
   * `session/set_mode`: `default`→`default`, `acceptEdits`→`accept-edits`, `plan`→`plan`; `bypassPermissions`
   * при разрешении в настройках — `accept-edits`, иначе `default`. Отказ сервера — нефатальный `error`.
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
      this.permissionMode = next;
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
      if (normalized.effort) this.effort = normalized.effort;
      await this.applyModel(normalized.model);
      await this.syncEffort();
      await this.saveSettings();
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
    this.onTier(tierNameOf(result));
    // `load` и `resume` не восстанавливают model / thought_level / mode: применяем явно то, что просили
    if (requestedModel) {
      const normalized = normalizeModel(requestedModel, this.config);
      if (normalized.effort && !this.effort) this.effort = normalized.effort;
      await this.applyModel(normalized.model);
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
    const effort = this.config.thoughtLevel?.current;
    this.emit({
      type: 'session.init',
      sessionId,
      model: this.config.model?.current ?? requestedModel ?? '',
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: this.engineVersion(),
      ...(effort && isEffort(effort) ? { effort } : {}),
    });
  }

  private async saveSettings(): Promise<void> {
    const model = this.config.model?.current;
    const effort = this.config.thoughtLevel?.current;
    const settings: AgySessionSettings = {
      permissionMode: this.permissionMode,
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

  /** Догнать сервер до запрошенного режима при старте (resume начинает с `default`). */
  private async syncInitialMode(): Promise<void> {
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
        const startedAt = Date.now();
        const done = deferred();
        this.turn = { done, startedAt };
        this.emitAll(this.mapper.startTurn(item.text, startedAt, item.images));
        try {
          // Ответ приходит после всего хода, включая ожидание разрешений на стороне сервера.
          const result = await this.client.request(
            'session/prompt',
            { sessionId: this.sessionId, prompt: promptBlocks(item.text, item.images) },
            null,
          );
          if (this.closed) break;
          if (this.turn === undefined || this.turn.done.settled) continue;
          this.emitAll(this.mapper.finish(result, startedAt));
          done.resolve();
        } catch (error) {
          if (this.closed || done.settled) break;
          // сервер ответил ошибкой на ход (квота, модель отказала): ход закрыт, процесс и очередь живы
          if (error instanceof AcpRpcError && typeof error.code === 'number') {
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
    if (this.closed || this.loading || method !== 'session/update') return;
    const turn = this.turn;
    if (!turn || turn.done.settled) return;
    const update = record(params)?.update;
    this.emitAll(this.mapper.applyUpdate(update));
  }

  private onClientClose(message: string): void {
    if (this.closed) return;
    if (message === this.client.disposedMessage) return;
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
    const mapped = mapAgyTool(rawName, rawInput);
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

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.turn?.done.resolve();
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  /** `stdin.end()`, grace, SIGTERM, ещё grace, SIGKILL. */
  private stopProcess(): void {
    shutdownAgy(this.proc, this.graceMs, () => this.procExited);
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
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
