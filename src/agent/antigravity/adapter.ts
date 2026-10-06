import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentEventOf,
  AgentSession,
  EffortLevel,
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
import { EventHub } from '../stream';
import type { LogFn } from '../claude/adapter';
import { AGY_NOT_FOUND } from './executable';
import { AgyEventMapper, type NotedPrompt } from './mapper';
import { DEFAULT_AGY_MODEL, listAgyModels } from './models';
import {
  AgyProcess,
  defaultAgySpawn,
  type AgyChild,
  type AgyExit,
  type AgyProcessOptions,
  type AgySpawn,
} from './process';
import { userInputLine, type AgyEvent } from './protocol';

export interface AntigravityAdapterConfig {
  /** Путь к `agy` (`antigravityEngine.path()`); нет пути — `createSession` бросает «не найден». */
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  log?: LogFn;
  /** База окружения процесса; по умолчанию `process.env` целиком (вход agy живёт в `~/.gemini`). */
  env?: NodeJS.ProcessEnv;
  /** Версия `agy` для `session.init.engineVersion` (из локатора). */
  engineVersion?: string;
  /** Сколько ждать выхода процесса после SIGINT/закрытия stdin, прежде чем убить, мс. */
  graceMs?: number;
  /** Лимит строки stdout, символов. */
  maxLineBytes?: number;
  /** Подмена запуска процесса в тестах. */
  spawn?: AgySpawn;
  /** Подмена `ps` и kill потомков в тестах. */
  listProcesses?: AgyProcessOptions['listProcesses'];
  killPid?: AgyProcessOptions['killPid'];
  /** Подмена `agy models` в тестах. */
  listModels?: (path: string) => Promise<ModelOption[]>;
  /** Сырые события agy (smoke, запись фикстур). */
  trace?: (event: AgyEvent) => void;
}

/** Режимы Agentura → флаги agy. `bypassPermissions` — только по явному разрешению (настройка), иначе как `default`. */
export function modeArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'plan':
      return ['--mode', 'plan'];
    case 'bypassPermissions':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  private modelsCache: Promise<ModelOption[]> | undefined;

  constructor(private readonly config: AntigravityAdapterConfig = {}) {}

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new AgySession(this.config, await this.executable(), options, () => this.models(), undefined);
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    return new AgySession(this.config, await this.executable(), options, () => this.models(), sessionId);
  }

  // История, список и переименование — этап 3 (хранилище agy читает `storage.ts`): пока пусто, а не выдумки.
  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }

  async loadHistory(): Promise<SessionHistory> {
    return { events: [], turns: 0, skippedTurns: 0 };
  }

  async renameSession(): Promise<void> {}

  async accountInfo(): Promise<AccountInfo> {
    return {};
  }

  private async executable(): Promise<string> {
    const setting = this.config.executablePath;
    const path = typeof setting === 'function' ? await setting() : setting;
    if (!path) throw new Error(AGY_NOT_FOUND);
    return path;
  }

  /** Модели из `agy models`: один запрос на процесс расширения; сбой или пустой ответ не кэшируем. */
  private models(): Promise<ModelOption[]> {
    if (!this.modelsCache) {
      const run = async (): Promise<ModelOption[]> => {
        try {
          const path = await this.executable();
          const models = await (this.config.listModels ?? listAgyModels)(path);
          if (models.length === 0) this.modelsCache = undefined;
          return models;
        } catch (error) {
          this.config.log?.('warn', `agy models failed: ${error instanceof Error ? error.message : String(error)}`);
          this.modelsCache = undefined;
          return [];
        }
      };
      this.modelsCache = run();
    }
    return this.modelsCache;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Сессия = долгоживущий `agy` на диалог: ходы — строки в stdin, по одной за раз (следующая уходит после
 * `result` предыдущей, очередь на нашей стороне). Stop, смена модели или режима — пересоздание процесса с
 * `--conversation <id>` лениво, к следующему `send`: у agy нет управляющих сообщений, прервать ход можно
 * только SIGINT, и он завершает процесс.
 */
class AgySession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper = new AgyEventMapper();
  private readonly log: LogFn;
  private readonly cwd: string;
  private readonly resumedId: string | undefined;
  private readonly allowBypass: boolean;
  private readonly queue: { prompt: NotedPrompt }[] = [];
  private model: string;
  private mode: PermissionMode;
  private effort: EffortLevel | undefined;
  private proc: AgyProcess | undefined;
  /** Процесс, который мы сами останавливаем (Stop, смена модели/режима, dispose): его выход не авария. */
  private stopping = new WeakSet<AgyProcess>();
  /** Модель или режим сменились: процесс пересоздаётся перед следующим ходом. */
  private stale = false;
  private closed = false;
  private initEmitted = false;
  private draining = false;
  /** Растёт на каждый `interrupt()`: сообщения, взятые из очереди до него, процессу не уходят. */
  private generation = 0;
  private turn: { done: Deferred } | undefined;
  /** Идёт остановка процесса по Stop: следующий ход ждёт её, а не пишет в умирающий agy. */
  private halting: Promise<void> | undefined;

  constructor(
    private readonly config: AntigravityAdapterConfig,
    private readonly executable: string,
    options: SessionOptions | ResumeOptions,
    private readonly loadModels: () => Promise<ModelOption[]>,
    resume: string | undefined,
  ) {
    this.log = config.log ?? (() => {});
    this.cwd = options.cwd;
    this.resumedId = resume;
    this.allowBypass = options.allowBypassPermissions === true;
    this.model = options.model || DEFAULT_AGY_MODEL;
    this.mode = this.effective(options.permissionMode ?? 'default');
    this.effort = options.effort;
    this.events = new EventHub<AgentEvent>((e) => this.log('error', `event subscriber failed: ${String(e)}`));
    this.mapper.setModel(this.model);
    // сразу поднимаем процесс: `init` приходит сам (~2 с) — id диалога и модель известны до первого сообщения
    try {
      this.proc = this.spawnProc();
    } catch (error) {
      this.fatal(error);
    }
  }

  get id(): string {
    return this.mapper.conversationId ?? this.resumedId ?? '';
  }

  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]): boolean {
    if (this.closed) return false;
    // image-блоки у agy в бинарнике есть, но не проверены; document-блоков нет: не отправляем и не показываем
    if (images?.length) this.log('warn', `agy: ${images.length} image(s) are not supported yet and were dropped`);
    if (files?.length) this.log('warn', `agy: ${files.length} file attachment(s) are not supported and were dropped`);
    this.queue.push({ prompt: { text } });
    this.drain().catch((error) => this.log('error', `agy queue failed: ${String(error)}`));
    return true;
  }

  // Подтверждений у agy нет (авто-отказ, этап 2), вопросов, плана, компакции и задач — тоже.
  respondPermission(): boolean {
    return false;
  }
  answerQuestion(): boolean {
    return false;
  }
  decidePlan(): boolean {
    return false;
  }
  compact(): boolean {
    return false;
  }
  async stopTask(): Promise<void> {}

  async setMode(mode: PermissionMode): Promise<void> {
    const next = this.effective(mode);
    if (next === this.mode) return;
    this.mode = next;
    this.stale = true;
    this.emit({ type: 'mode.changed', mode: next });
  }

  async setModel(model: string): Promise<void> {
    if (!model || model === this.model) return;
    this.model = model;
    this.mapper.setModel(model);
    this.stale = true;
  }

  /** Уровень — часть id модели (`-low`), а `--effort` с такими id конфликтует: только запоминаем. */
  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
  }

  /**
   * Stop: SIGINT agy (он отвечает `result` с `interrupted` и выходит), через grace — SIGKILL agy и его потомков
   * (`run_command` переживает agy). Очередь сбрасывается; процесс поднимется заново со следующим `send`.
   */
  async interrupt(): Promise<void> {
    this.generation++;
    this.queue.length = 0;
    const turn = this.turn;
    const proc = this.proc;
    if (!turn || turn.done.settled || !proc || this.closed) return;
    this.stopping.add(proc);
    const halting = proc.interrupt().catch((error) => this.log('warn', `agy interrupt failed: ${errorText(error)}`));
    this.halting = halting;
    await halting;
    if (this.halting === halting) this.halting = undefined;
    if (this.proc === proc) this.proc = undefined;
    // `result` не пришёл (убили по таймауту) — закрываем ход сами, иначе очередь и лента зависнут
    if (!turn.done.settled) {
      this.emitAll(this.mapper.abandonTurn({ interrupted: true }));
      turn.done.resolve();
    }
  }

  capabilities(): Promise<SessionCapabilities> {
    return this.loadModels().then((models) => ({ models, commands: [] }));
  }

  async contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined> {
    return undefined;
  }

  dispose(): void {
    if (this.closed) return;
    const proc = this.proc;
    const inFlight = this.turn && !this.turn.done.settled;
    this.close('disposed');
    this.proc = undefined;
    if (!proc) return;
    this.stopping.add(proc);
    (inFlight ? proc.interrupt() : proc.stop()).catch((error) =>
      this.log('warn', `agy stop failed: ${errorText(error)}`),
    );
  }

  // ---- внутреннее ------------------------------------------------------------------------------

  private effective(mode: PermissionMode): PermissionMode {
    if (mode === 'bypassPermissions' && !this.allowBypass) {
      this.log('warn', 'agy: bypassPermissions is not allowed by settings; using default mode');
      return 'default';
    }
    return mode;
  }

  private spawnProc(): AgyProcess {
    const conversation = this.id;
    const args = [
      '-p=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      this.model,
      ...(conversation ? ['--conversation', conversation] : []),
      ...modeArgs(this.mode),
    ];
    this.log('debug', `agy: spawn ${args.join(' ')}`);
    const child: AgyChild = (this.config.spawn ?? defaultAgySpawn)(this.executable, args, {
      cwd: this.cwd,
      env: this.config.env ?? process.env,
    });
    const proc: AgyProcess = new AgyProcess(
      child,
      {
        onEvent: (event) => this.onEvent(proc, event),
        onStderr: (line) => this.log('debug', `agy: ${line}`),
        onAgyError: (error) => {
          if (proc === this.proc && !this.closed)
            this.emit({ type: 'error', message: error.message, fatal: false, ...(error.code ? { code: error.code } : {}) });
        },
        onOverflow: () => {
          if (proc === this.proc) this.fatal(new Error('agy: stdout line is too long'));
        },
        onExit: (exit) => this.onExit(proc, exit),
      },
      {
        ...(this.config.maxLineBytes ? { maxLineBytes: this.config.maxLineBytes } : {}),
        ...(this.config.graceMs !== undefined ? { graceMs: this.config.graceMs } : {}),
        ...(this.config.log ? { log: this.config.log } : {}),
        ...(this.config.listProcesses ? { listProcesses: this.config.listProcesses } : {}),
        ...(this.config.killPid ? { killPid: this.config.killPid } : {}),
      },
    );
    return proc;
  }

  /** Процесс для следующего хода: устаревший (смена модели/режима) пересоздаётся, мёртвый — поднимается заново. */
  private async ensureProc(): Promise<AgyProcess> {
    // Stop ещё добивает agy (`result` уже пришёл, `close` — нет): новый ход — только в новый процесс
    while (this.halting) await this.halting;
    if (this.proc && this.stopping.has(this.proc)) this.proc = undefined;
    if (this.proc && this.stale) {
      const old = this.proc;
      this.stopping.add(old);
      await old.stop();
      if (this.proc === old) this.proc = undefined;
    }
    // dispose/авария, пока ждали остановки: новый процесс закрытой сессии остался бы сиротой
    if (this.closed) throw new Error('agy session is closed');
    if (this.proc && !this.proc.alive) this.proc = undefined;
    this.stale = false;
    this.proc ??= this.spawnProc();
    return this.proc;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        const generation = this.generation;
        let proc: AgyProcess;
        try {
          proc = await this.ensureProc();
        } catch (error) {
          if (this.closed) break;
          this.emitAll(this.mapper.syntheticTurn(item.prompt, { message: errorText(error) }));
          continue;
        }
        if (this.closed) break;
        if (generation !== this.generation) {
          this.emitAll(this.mapper.syntheticTurn(item.prompt, { interrupted: true }));
          continue;
        }
        const turn = { done: deferred() };
        this.turn = turn;
        this.mapper.notePrompt(item.prompt);
        if (!proc.write(userInputLine(item.prompt.text))) {
          this.mapper.dropPrompt(item.prompt);
          this.turn = undefined;
          this.proc = undefined;
          this.emitAll(this.mapper.syntheticTurn(item.prompt, { message: 'agy is not running' }));
          continue;
        }
        await turn.done.promise;
        if (this.turn === turn) this.turn = undefined;
      }
    } finally {
      this.draining = false;
    }
  }

  private onEvent(proc: AgyProcess, event: AgyEvent): void {
    if (proc !== this.proc || this.closed) return;
    try {
      this.config.trace?.(event);
      if (event.event === 'init') {
        const wasInit = this.initEmitted;
        const init = this.mapper.init(event, {
          permissionMode: this.mode,
          engineVersion: this.config.engineVersion ?? '',
          cwd: this.cwd,
          ...(this.effort ? { effort: this.effort } : {}),
        });
        // повторные `init` (процесс пересоздан) ленте не нужны: id и модель те же, что мы сами передали
        if (!wasInit) {
          this.initEmitted = true;
          this.emit(init);
        }
        return;
      }
      const events = this.mapper.map(event);
      this.emitAll(events);
      if (event.event === 'result') {
        // после ERROR agy часто выходит (неизвестная модель, ошибка разбора ввода): следующий ход — в новом процессе,
        // а не в stdin умирающего (его выход мы бы приняли за аварию посреди хода)
        if (event.result.status !== 'SUCCESS') this.stale = true;
        if (events.some((e) => e.type === 'turn.result')) this.turn?.done.resolve();
      }
    } catch (error) {
      this.log('error', `agy event ${event.event} failed: ${String(error)}`);
    }
  }

  private onExit(proc: AgyProcess, exit: AgyExit): void {
    if (proc !== this.proc) return;
    this.proc = undefined;
    if (this.closed || this.stopping.has(proc)) return;
    const turn = this.turn;
    if (exit.error) {
      this.fatal(new Error(`Failed to start agy: ${exit.error.message}`));
      return;
    }
    if (turn && !turn.done.settled) {
      const detail = exit.stderrTail ? `: ${exit.stderrTail}` : '';
      const message = `agy exited unexpectedly (${exit.signal ?? `code ${exit.code}`})${detail}`;
      this.emitAll(this.mapper.abandonTurn({ message }));
      turn.done.resolve();
      this.fatal(new Error(message), 'exit');
      return;
    }
    // простаивающий agy вышел (например, после ERROR-результата с кодом 1): ошибка уже в ленте, поднимем к следующему ходу
    this.log('warn', `agy exited while idle (${exit.signal ?? `code ${exit.code}`}); will restart on the next message`);
  }

  /** Процесс или протокол сломан: ошибка, `session.closed`, остановка процесса. */
  private fatal(error: unknown, reason: 'exit' | 'error' = 'error'): void {
    if (this.closed) return;
    const message = errorText(error);
    this.log('error', `agy session failed: ${message}`);
    this.emit({ type: 'error', fatal: true, message });
    this.close(reason, message);
    const proc = this.proc;
    this.proc = undefined;
    if (proc) {
      this.stopping.add(proc);
      proc.kill().catch(() => undefined);
    }
  }

  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.turn?.done.resolve();
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
  }

  private emitAll(events: AgentEvent[]): void {
    for (const event of events) this.emit(event);
  }
}
