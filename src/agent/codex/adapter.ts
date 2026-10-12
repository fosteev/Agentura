import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  EffortLevel,
  ModelOption,
  PromptFile,
  PermissionDecision,
  PromptImage,
  ResumeOptions,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
  AgentEventOf,
} from '../types';
import { EventHub } from '../stream';
import type { LogFn } from '../claude/adapter';
import { CodexRpcClient, type RpcId, type RpcProcess } from './client';
import { CodexEventMapper, type NotedPrompt } from './mapper';
import { CodexApprovals } from './approvals';
import { buildCodexHistory } from './history';
import type {
  AskForApproval,
  CodexRequestMethod,
  CodexRequests,
  ListMcpServerStatusResponse,
  Model,
  SandboxMode,
  Thread,
  ThreadListResponse,
  UserInput,
} from './protocol';

/** Процесс app-server: то, что нужно клиенту, плюс остановка. */
export interface CodexProcess extends RpcProcess {
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Что видит диагностика (smoke, фикстуры): сырое сообщение app-server и результаты наших запросов. */
export type CodexTrace = (
  kind: 'notification' | 'response' | 'request',
  method: string,
  payload: unknown,
) => void;

export interface CodexAdapterConfig {
  /** Путь к `codex` (`services.codexEngine.path()`); нет пути — `createSession` бросает «не найден». */
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  log?: LogFn;
  /** База окружения процесса; по умолчанию `process.env` целиком (ключи и вход Codex не вырезаем). */
  env?: NodeJS.ProcessEnv;
  /** Версия клиента для `initialize.clientInfo`. */
  clientVersion?: string;
  /**
   * Явные approval/sandbox для `thread/start|resume` (smoke и тесты). Не заданы — не передаём, и app-server
   * берёт `~/.codex/config.toml` пользователя (ТЗ §4); отдельные настройки расширения — не этот этап.
   */
  thread?: { approvalPolicy?: AskForApproval; sandbox?: SandboxMode };
  /** Таймаут `initialize`, мс (запросы с долгим стартом — `startTimeoutMs`). */
  timeoutMs?: number;
  /** Таймаут `thread/start|resume` и `turn/start` (ждут MCP/хуки пользователя), мс; истёк — сессия закрывается. */
  startTimeoutMs?: number;
  /** Пауза между повторами `thread/resume` при «already has an active writer», мс (по умолчанию 3000). */
  resumeRetryMs?: number;
  /** Сколько ждать выхода процесса после закрытия stdin, прежде чем убить; мс. */
  graceMs?: number;
  /** Подмена запуска процесса в тестах. */
  spawn?: (path: string, args: string[], options: CodexSpawnOptions) => CodexProcess;
  trace?: CodexTrace;
}

/** `thread/start` и `turn/start` ждут MCP-серверы/хуки пользователя: даём больше, чем обычным запросам. */
const START_TIMEOUT_MS = 60_000;
/** `thread/read` длинного треда и вывод команды больше мегабайта — лимит клиента по умолчанию мал. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_GRACE_MS = 2000;
/** Список тредов: страница и потолок страниц (500 тредов проекта — дальше не листаем). */
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 5;
/** `mcpServerStatus/list`: страниц не больше (roadmap 21) — сервер с вечным `nextCursor` не зациклит запрос. */
const MCP_PAGES = 10;
/** Один запрос короткого сервера (`thread/read` длинного треда читает rollout целиком). */
const QUERY_TIMEOUT_MS = 30_000;
/** `thread/resume` сразу после выхода процесса того же треда: писатель ещё не освобождён — ждём и повторяем. */
const RESUME_RETRY_MS = 3000;
const RESUME_RETRIES = 3;
/** Сколько `interrupt()` ждёт `turn/completed`, прежде чем вернуть управление. */
const INTERRUPT_WAIT_MS = 10_000;
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Счётчик сессий для префикса `toolUseId` карточек подтверждения (id запросов у каждого процесса с 0). */
let approvalScopes = 0;
function defaultSpawn(path: string, args: string[], options: CodexSpawnOptions): CodexProcess {
  return spawn(path, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as unknown as CodexProcess;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';

  constructor(private readonly config: CodexAdapterConfig = {}) {}

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new CodexSession(this.config, await this.executable(), options);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    return new CodexSession(this.config, await this.executable(), options, sessionId);
  }

  /**
   * Треды проекта: `thread/list` с фильтром `cwd` (и реальным путём, если папка — симлинк). Это и треды, начатые
   * в Codex CLI: так же, как у Claude видны все сессии проекта. Субагентские и эфемерные не берём; архивные сервер
   * не отдаёт сам. Сервер — короткоживущий процесс на запрос (запуск ~0,3 с, общий процесс держал бы writer-блокировки).
   */
  async listSessions(dir: string): Promise<SessionInfo[]> {
    const cwds = [dir];
    try {
      const real = realpathSync(dir);
      if (real !== dir) cwds.push(real);
    } catch {
      // папки нет — фильтр по заданному пути
    }
    const threads = await this.query(dir, async (rpc) => {
      const out: Thread[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const res: ThreadListResponse = await rpc('thread/list', {
          cwd: cwds.length === 1 ? dir : cwds,
          limit: LIST_PAGE,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          ...(cursor ? { cursor } : {}),
        });
        out.push(...res.data);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return out;
    });
    return threads.filter((t) => !t.parentThreadId && !t.ephemeral).map(sessionInfo);
  }

  /** `thread/read` с ходами → события ленты (`buildCodexHistory`). */
  async loadHistory(
    sessionId: string,
    cwd: string,
    options?: { live?: boolean; tasksAlive?: boolean; maxTurns?: number; stopBefore?: string },
  ): Promise<SessionHistory> {
    const res = await this.query(cwd, (rpc) => rpc('thread/read', { threadId: sessionId, includeTurns: true }));
    return buildCodexHistory(res.thread, {
      ...(options?.live ? { live: true } : {}),
      ...(options?.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    });
  }

  /** `thread/name/set`: имя хранит сам Codex (его видят и CLI, и список); файлы `~/.codex` не трогаем. */
  async renameSession(sessionId: string, title: string, cwd: string): Promise<void> {
    await this.query(cwd, (rpc) => rpc('thread/name/set', { threadId: sessionId, name: title }));
  }

  async accountInfo(): Promise<AccountInfo> {
    return {};
  }

  /**
   * Один короткий app-server: handshake → `fn` → закрытие stdin (штатный выход), через `graceMs` — убить.
   * Для запросов вне сессии (список, история, имя); notifications и запросы сервера тут не нужны — на
   * запросы сервера клиент сам отвечает отказом.
   */
  private async query<T>(
    cwd: string,
    fn: (rpc: AppServerRpc) => Promise<T>,
  ): Promise<T> {
    return queryAppServer(await this.executable(), cwd, this.config, fn);
  }

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error('Codex CLI (codex) was not found.');
    return path;
  }
}

/** `rpc` короткого app-server: типизированный запрос с таймаутом одного запроса. */
export type AppServerRpc = <M extends CodexRequestMethod>(method: M, params: CodexRequests[M][0]) => Promise<CodexRequests[M][1]>;

/**
 * Один короткий app-server: handshake → `fn` → закрытие stdin (штатный выход), через `graceMs` — убить.
 * Для запросов вне сессии (список, история, имя, лимиты); notifications и запросы сервера тут не нужны — на
 * запросы сервера клиент сам отвечает отказом.
 */
export async function queryAppServer<T>(
  executable: string,
  cwd: string,
  config: Pick<CodexAdapterConfig, 'spawn' | 'env' | 'log' | 'trace' | 'timeoutMs' | 'graceMs' | 'clientVersion'>,
  fn: (rpc: AppServerRpc) => Promise<T>,
): Promise<T> {
  const proc = (config.spawn ?? defaultSpawn)(executable, ['app-server', '--listen', 'stdio://'], {
    cwd,
    env: config.env ?? process.env,
  });
  let exited = false;
  proc.on('exit', () => (exited = true));
  const log = config.log ?? (() => {});
  const client = new CodexRpcClient(proc, {
    timeoutMs: config.timeoutMs ?? 15_000,
    maxLineBytes: MAX_LINE_BYTES,
    onStderr: (line) => log('debug', `codex: ${line}`),
  });
  const rpc = <M extends CodexRequestMethod>(method: M, params: CodexRequests[M][0]): Promise<CodexRequests[M][1]> => {
    config.trace?.('request', method, params);
    return client.request<CodexRequests[M][1]>(method, params, QUERY_TIMEOUT_MS).then((result) => {
      config.trace?.('response', method, result);
      return result;
    });
  };
  try {
    await client.request('initialize', {
      clientInfo: { name: 'agentura', title: 'Agentura', version: config.clientVersion ?? '0.0.0' },
      capabilities: null,
    });
    client.notify('initialized');
    return await fn(rpc);
  } finally {
    client.dispose();
    try {
      proc.stdin.end();
    } catch {
      // процесс уже мёртв
    }
    if (!exited) {
      const timer = setTimeout(() => {
        if (!exited) proc.kill();
      }, config.graceMs ?? DEFAULT_GRACE_MS);
      timer.unref?.();
      proc.on('exit', () => clearTimeout(timer));
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
      settled = true;
      resolve();
    },
    get settled() {
      return settled;
    },
  };
}

/** Таймаут нашего запроса: ответ мог прийти позже, и сервер уже действует — состояние сессии неизвестно. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out after/.test(error.message);
}

class CodexSession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper = new CodexEventMapper();
  private readonly approvals: CodexApprovals;
  private readonly log: LogFn;
  private readonly proc: CodexProcess;
  private readonly client: CodexRpcClient;
  private readonly ready: Promise<void>;
  private readonly queue: { prompt: NotedPrompt; text: string }[] = [];
  private readonly cwd: string;
  private readonly resumedId: string | undefined;
  private readonly graceMs: number;
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private closed = false;
  private procExited = false;
  private threadReady = false;
  private draining = false;
  /** Растёт на каждый `interrupt()`: сообщения, взятые из очереди до него, до `turn/start` не доходят. */
  private generation = 0;
  /** Ход идёт: от отправки `turn/start` до `turn/completed` (или смерти процесса). */
  private turn:
    | { done: Deferred; prompt: NotedPrompt; id?: string; started?: Promise<string | undefined> }
    | undefined;
  private modelsCache: Promise<ModelOption[]> | undefined;
  /** Статус MCP запрашивается сам после открытия треда (`SessionOptions.mcpWatch`, roadmap 21). */
  private mcpWatch: boolean;

  constructor(
    private readonly config: CodexAdapterConfig,
    executable: string,
    options: SessionOptions | ResumeOptions,
    resume?: string,
  ) {
    this.log = config.log ?? (() => {});
    this.cwd = options.cwd;
    this.resumedId = resume;
    this.model = options.model;
    this.effort = options.effort;
    this.mcpWatch = options.mcpWatch === true;
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
    this.events = new EventHub<AgentEvent>((e) =>
      this.log('error', `event subscriber failed: ${String(e)}`),
    );
    if (options.model) this.mapper.setModel(options.model);

    this.proc = (config.spawn ?? defaultSpawn)(
      executable,
      ['app-server', '--listen', 'stdio://'],
      { cwd: options.cwd, env: config.env ?? process.env },
    );
    this.proc.on('exit', () => (this.procExited = true));
    this.approvals = new CodexApprovals({
      emit: (event) => this.emit(event),
      respond: (id, result) => this.client.respond(id, result),
      respondError: (id, message, code) => this.client.respondError(id, message, code),
      log: this.log,
      changesOf: (itemId) => this.mapper.changesOf(itemId),
    }, `codex-${++approvalScopes}:`);
    this.client = new CodexRpcClient(this.proc, {
      timeoutMs: config.timeoutMs ?? 15_000,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => this.onNotification(method, params),
      // approval, вопросы и неизвестные запросы — брокер: каждый получает ответ (в том числе отказ)
      onServerRequest: (id, method, params) => this.approvals.handle(id, method, params),
      onStderr: (line) => this.log('debug', `codex: ${line}`),
      onClose: (error) => this.onClientClose(error.message),
    });
    // handshake: initialize → initialized; у возобновляемого треда сразу `thread/resume`, у нового
    // `thread/start` ждёт первого сообщения (пустой тред в истории Codex не нужен)
    this.ready = this.handshake().then(() => (resume ? this.openThread() : undefined));
    this.ready.catch((error) => this.fatal(error));
  }

  get id(): string {
    return this.mapper.threadId ?? this.resumedId ?? '';
  }

  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]): boolean {
    if (this.closed) return false;
    // У Codex нет document-блоков: файлы и pdf не отправляем, а не подменяем чем-то похожим.
    if (files?.length) this.log('warn', `codex: ${files.length} file attachment(s) are not supported and were dropped`);
    this.queue.push({ text, prompt: { text, ...(images?.length ? { images } : {}) } });
    this.drain().catch((error) => this.log('error', `codex queue failed: ${String(error)}`));
    return true;
  }

  /**
   * Решение по карточке подтверждения: `allow` → accept, `allow-always`/`allow-edits` → сессионное или
   * постоянное решение, если запрос его допускает, `deny` → decline (текст отказа Codex не принимает).
   */
  respondPermission(toolUseId: string, decision: PermissionDecision): boolean {
    if (this.closed) return false;
    return this.approvals.respondPermission(toolUseId, decision);
  }
  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    if (this.closed) return false;
    return this.approvals.answerQuestion(toolUseId, answers);
  }
  // Режимы разрешений, план, компакция, задачи — Claude-специфика: no-op (UI прячет флагами, этап 3).
  decidePlan(): boolean {
    return false;
  }
  async setMode(): Promise<void> {}
  compact(): boolean {
    return false;
  }
  async stopTask(): Promise<void> {}

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.mapper.setModel(model);
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
  }

  /** `turn/interrupt`, потом ждём `turn/completed` (процесс не убиваем); очередь сообщений Stop не сбрасывает (как у Claude). */
  async interrupt(): Promise<void> {
    this.generation++;
    // открытые подтверждения хода закрываем отменой: иначе сервер ждёт ответа, а карточка висит
    this.approvals.cancelAll();
    const turn = this.turn;
    if (!turn || turn.done.settled || this.closed) return;
    try {
      const turnId = turn.id ?? (await turn.started);
      if (!turnId) return;
      await this.rpc('turn/interrupt', { threadId: this.id, turnId });
    } catch (error) {
      this.log('warn', `turn/interrupt failed: ${String(error)}`);
      this.abandon(turn);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      turn.done.promise,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, INTERRUPT_WAIT_MS))),
    ]);
    clearTimeout(timer);
    if (!turn.done.settled) this.log('warn', 'codex turn/completed did not arrive after turn/interrupt');
    this.abandon(turn);
  }

  /**
   * Страховка Stop: `turn/completed` не пришёл (потерян, сервер считает, что хода нет) — закрыть ход сами
   * (`turn.result{interrupted}`) и отпустить очередь, иначе следующие сообщения ждали бы вечно.
   */
  private abandon(turn: NonNullable<CodexSession['turn']>): void {
    if (turn.done.settled || this.closed) return;
    this.approvals.cancelAll();
    this.emitAll(this.mapper.abandonTurn(turn.id, turn.prompt));
    turn.done.resolve();
  }

  capabilities(): Promise<SessionCapabilities> {
    this.modelsCache ??= this.loadModels();
    return this.modelsCache.then((models) => ({ models, commands: [] }));
  }

  async contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined> {
    return this.mapper.contextEvent();
  }

  /**
   * `mcpServerStatus/list` треда по всем страницам (не больше `MCP_PAGES`) → `mcp.status`. Ошибка — в лог. До
   * открытия треда — ничего: без `threadId` `runtimeStatus` пуст, а Codex ради списка поднимает все серверы.
   */
  async mcpStatus(): Promise<void> {
    if (this.closed || !this.threadReady) return;
    const listing = this.mapper.mcpListStart();
    try {
      await this.ready;
      const servers: ListMcpServerStatusResponse['data'] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MCP_PAGES; page++) {
        const res: ListMcpServerStatusResponse = await this.rpc('mcpServerStatus/list', {
          detail: 'toolsAndAuthOnly',
          ...(this.mapper.threadId ? { threadId: this.mapper.threadId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        servers.push(...(Array.isArray(res?.data) ? res.data : []));
        const next: string | null = res?.nextCursor ?? null;
        // тот же cursor ещё раз — сервер зациклился: страница повторилась бы в списке
        if (!next || next === cursor) break;
        cursor = next;
      }
      if (this.closed) return;
      this.emit(this.mapper.mcpList(servers, listing));
    } catch (error) {
      this.mapper.mcpListFailed(listing);
      if (!this.closed) this.log('warn', `mcpServerStatus/list failed: ${String(error)}`);
    }
  }

  /** «перезапустить все»: `config/mcpServer/reload` (по одному серверу Codex не умеет), затем свежий список. */
  async mcpReloadAll(): Promise<void> {
    if (this.closed || !this.threadReady) return;
    try {
      await this.ready;
      await this.rpc('config/mcpServer/reload', undefined);
    } catch (error) {
      this.log('warn', `config/mcpServer/reload failed: ${String(error)}`);
    }
    await this.mcpStatus();
  }

  setMcpWatch(on: boolean): void {
    const was = this.mcpWatch;
    this.mcpWatch = on;
    if (on && !was && this.threadReady) void this.mcpStatus();
  }

  dispose(): void {
    if (this.closed) return;
    this.close('disposed');
    this.client.dispose();
    this.stopProcess();
  }

  // ---- внутреннее ------------------------------------------------------------------------------

  private async handshake(): Promise<void> {
    await this.rpc('initialize', {
      clientInfo: { name: 'agentura', title: 'Agentura', version: this.config.clientVersion ?? '0.0.0' },
      capabilities: null,
    });
    this.client.notify('initialized');
  }

  private rpc<M extends CodexRequestMethod>(
    method: M,
    params: CodexRequests[M][0],
    timeoutMs?: number,
  ): Promise<CodexRequests[M][1]> {
    this.config.trace?.('request', method, params);
    return this.client.request<CodexRequests[M][1]>(method, params, timeoutMs).then((result) => {
      this.config.trace?.('response', method, result);
      return result;
    });
  }

  /** `thread/start` (нет треда) или `thread/resume`; после него разрешён `turn/start`. */
  private async openThread(): Promise<void> {
    if (this.threadReady) return;
    const settings = {
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
      ...(this.config.thread?.approvalPolicy ? { approvalPolicy: this.config.thread.approvalPolicy } : {}),
      ...(this.config.thread?.sandbox ? { sandbox: this.config.thread.sandbox } : {}),
    };
    const session = this.resumedId
      ? await this.resumeThread(this.resumedId, settings)
      : await this.rpc('thread/start', settings, this.config.startTimeoutMs ?? START_TIMEOUT_MS);
    this.threadReady = true;
    this.emit(this.mapper.init(session, this.effort));
    if (this.mcpWatch) void this.mcpStatus();
  }

  /**
   * `thread/resume` с повтором: сразу после выхода предыдущего процесса того же треда сервер отвечает «already has
   * an active writer» (блокировка отпускается с задержкой — живой прогон). Другая ошибка или исчерпанные
   * повторы — как есть (тред ведёт, например, открытый Codex CLI — тогда карточка ошибки честная).
   */
  private async resumeThread(
    threadId: string,
    settings: Record<string, unknown>,
  ): Promise<CodexRequests['thread/resume'][1]> {
    const pause = this.config.resumeRetryMs ?? RESUME_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rpc(
          'thread/resume',
          { threadId, excludeTurns: true, ...settings },
          this.config.startTimeoutMs ?? START_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isWriterBusy(error) || attempt >= RESUME_RETRIES || this.closed) throw error;
        this.log('info', `codex thread/resume: writer busy, retry ${attempt + 1} in ${pause} ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, pause));
        if (this.closed) throw error;
      }
    }
  }

  /** Очередь сообщений: следующий `turn/start` — только после `turn/completed` предыдущего. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        const generation = this.generation;
        const turn: NonNullable<CodexSession['turn']> = { done: deferred(), prompt: item.prompt };
        try {
          await this.ready;
          await this.openThread();
        } catch (error) {
          if (this.closed) break;
          // поздний ответ `thread/start` после таймаута — уже созданный тред; повтор создал бы второй
          if (isTimeout(error)) {
            this.fatal(error);
            break;
          }
          this.emitAll(this.mapper.syntheticTurn(item.prompt, { message: errorText(error) }));
          continue;
        }
        if (generation !== this.generation) {
          this.emitAll(this.mapper.syntheticTurn(item.prompt, { interrupted: true }));
          continue;
        }
        this.turn = turn;
        this.mapper.notePrompt(item.prompt);
        const started = this.rpc('turn/start', this.turnParams(item), this.config.startTimeoutMs ?? START_TIMEOUT_MS);
        // id из ответа `turn/start` главнее `turn/started`: тот мог прийти раньше ответа
        turn.started = started.then(
          (r) => {
            const id = r?.turn?.id;
            if (id) turn.id = id;
            return turn.id;
          },
          () => undefined,
        );
        try {
          await started;
        } catch (error) {
          this.mapper.dropPrompt(item.prompt);
          this.turn = undefined;
          if (this.closed) break;
          // таймаут: сервер мог начать ход — следующий `turn/start` поверх активного хода сломал бы ленту
          if (isTimeout(error)) {
            this.fatal(error);
            break;
          }
          this.emitAll(this.mapper.syntheticTurn(item.prompt, { message: errorText(error) }));
          continue;
        }
        await turn.done.promise;
        if (this.turn === turn) this.turn = undefined;
      }
    } finally {
      this.draining = false;
    }
  }

  private turnParams(item: { text: string; prompt: NotedPrompt }): CodexRequests['turn/start'][0] {
    const input: UserInput[] = [];
    // картинки перед текстом, как у Claude; `image.url` принимает data-URL
    for (const image of item.prompt.images ?? [])
      input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    input.push({ type: 'text', text: item.text, text_elements: [] });
    return {
      threadId: this.id,
      input,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort && EFFORTS.includes(this.effort) ? { effort: this.effort } : {}),
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (this.closed) return;
    try {
      this.config.trace?.('notification', method, params);
      const p = params as { threadId?: string; turn?: { id?: string } } | undefined;
      // ход чужого треда (субагент, review) не трогает наш: ни id, ни очередь
      const ours = !p?.threadId || !this.id || p.threadId === this.id;
      const turnId = p?.turn?.id;
      if (method === 'turn/started' && ours && this.turn && turnId) this.turn.id ??= turnId;
      if (method === 'serverRequest/resolved' && ours) {
        this.approvals.resolved((params as { requestId: RpcId }).requestId);
        return;
      }
      // `turn/completed` карточки НЕ снимает: сервер доделывает элементы и после конца хода (живой прогон —
      // approval пришёл после `turn/completed`), открытый запрос он закрывает сам `serverRequest/resolved`.
      const events = this.mapper.map(method, params);
      this.emitAll(events);
      if (method === 'turn/completed' && events.some((e) => e.type === 'turn.result')) {
        const context = this.mapper.contextEvent();
        if (context) this.emit(context);
        // чужой ход (id известен и не совпал) не освобождает очередь
        const turn = this.turn;
        if (turn && ours && (!turn.id || !turnId || turn.id === turnId)) turn.done.resolve();
      }
    } catch (error) {
      this.log('error', `codex notification ${method} failed: ${String(error)}`);
    }
  }

  private async loadModels(): Promise<ModelOption[]> {
    try {
      await this.ready;
      const models: Model[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: CodexRequests['model/list'][1] = await this.rpc('model/list', cursor ? { cursor } : {});
        models.push(...res.data);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return models.filter((m) => !m.hidden).map(modelOption);
    } catch (error) {
      this.log('warn', `model/list failed: ${String(error)}`);
      // сбой не кэшируем навсегда: следующий `capabilities()` спросит снова
      this.modelsCache = undefined;
      return [];
    }
  }

  private onClientClose(message: string): void {
    if (this.closed) return;
    // stdout закрывается раньше `exit`: это тоже выход процесса, а не сбой протокола
    const exited = this.procExited || /app-server (exited|stdout closed|closed\.)/.test(message);
    this.fatal(new Error(message), exited ? 'exit' : 'error');
  }

  /** Процесс или протокол сломан: ошибка, `session.closed`, остановка процесса. */
  private fatal(error: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    const message = errorText(error);
    this.log('error', `codex session failed: ${message}`);
    this.emit({ type: 'error', fatal: true, message });
    this.close(reason, message);
    this.client.dispose();
    this.stopProcess();
  }

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    // отвечать некому (процесс ушёл или закрываем): карточки снимаем до `session.closed`
    this.approvals.dropAll();
    this.closed = true;
    this.queue.length = 0;
    this.turn?.done.resolve();
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  /** Закрыть stdin (штатный выход app-server), через `graceMs` — убить, если не вышел. */
  private stopProcess(): void {
    if (this.procExited) return;
    try {
      this.proc.stdin.end();
    } catch {
      // процесс уже мёртв
    }
    // stdin закрыт → ждём grace → SIGTERM → ещё grace → SIGKILL (app-server, игнорирующий TERM, не остаётся)
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

/** Строка списка: имя от пользователя, иначе начало первого сообщения; секунды Unix → мс. */
function sessionInfo(t: Thread): SessionInfo {
  const preview = t.preview.replace(/\s+/g, ' ').trim();
  const title = t.name?.replace(/\s+/g, ' ').trim() || preview.slice(0, 120) || `Codex ${t.id.slice(0, 8)}`;
  return {
    id: t.id,
    title,
    ...(preview ? { firstPrompt: preview } : {}),
    cwd: t.cwd,
    createdAt: t.createdAt * 1000,
    updatedAt: t.updatedAt * 1000,
    provider: 'codex',
  };
}

/** `thread/resume`: писатель треда — процесс, который ещё не вышел (наш прошлый или CLI). */
function isWriterBusy(error: unknown): boolean {
  return error instanceof Error && /already has an active writer/i.test(error.message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelOption(m: Model): ModelOption {
  const option: ModelOption = { value: m.model, displayName: m.displayName || m.model };
  if (m.description) option.description = m.description;
  // уровни, которых нет в `EffortLevel` (`ultra`, `minimal`), в меню не попадают
  const levels = m.supportedReasoningEfforts
    .map((e) => e.reasoningEffort)
    .filter((e): e is EffortLevel => EFFORTS.includes(e));
  option.supportsEffort = levels.length > 0;
  if (levels.length > 0) option.effortLevels = levels;
  return option;
}
