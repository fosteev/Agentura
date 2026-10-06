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
import { editResultOf } from './edits';
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
import { defaultAgyRoot } from './storage';

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
  /** Корень хранилища agy (диффы правок из `transcript_full.jsonl`); по умолчанию `~/.gemini/antigravity-cli`. Только чтение. */
  agyRoot?: string;
  /** Повторы чтения транскрипта правки (agy может дописать его позже DONE шага) и пауза между ними, мс. */
  transcriptRetries?: number;
  transcriptDelayMs?: number;
  /** Общий предел подгрузки диффа одной правки, мс (по умолчанию 2000): не успели — карточка без диффа, лента не стоит. */
  editTimeoutMs?: number;
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

/** Служебный текст повтора после отказа: уходит агенту без пузыря пользователя в ленте. */
export const AGY_RETRY_PROMPT =
  'The permission you were missing is now granted. Retry the action(s) that were just denied, then continue the task.';

/** Режимы, в которых можно повторить отказ: правки или всё (`bypassPermissions` — только если разрешён настройкой). */
export type AgyRetryMode = Extract<PermissionMode, 'acceptEdits' | 'bypassPermissions'>;

/**
 * Что сверх `AgentSession` умеет сессия agy (карточка отказа, этап 4): повторить с другим режимом. Не часть
 * общего интерфейса — проверять `isAgySession`.
 */
export interface AgyRetrySession extends AgentSession {
  /** `setMode(mode)` (процесс пересоздастся с `--conversation`) и служебное сообщение-повтор; `false` — режим не разрешён или сессия закрыта. */
  retryWithMode(mode: AgyRetryMode): Promise<boolean>;
}

export function isAgySession(session: AgentSession): session is AgyRetrySession {
  return typeof (session as Partial<AgyRetrySession>).retryWithMode === 'function';
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
class AgySession implements AgyRetrySession {
  readonly events: EventHub<AgentEvent>;
  private readonly mapper = new AgyEventMapper();
  private readonly log: LogFn;
  private readonly cwd: string;
  private readonly resumedId: string | undefined;
  private readonly allowBypass: boolean;
  private readonly queue: { prompt: NotedPrompt }[] = [];
  /** События agy, ждущие асинхронной подгрузки диффа: порядок ленты не нарушаем (`inflight` > 0 — всё идёт через `tail`). */
  private inflight = 0;
  private tail: Promise<void> = Promise.resolve();
  /** Закрытие сессии обрывает повторы чтения транскрипта. */
  private readonly aborter = new AbortController();
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
    return this.enqueue({ text });
  }

  async retryWithMode(mode: AgyRetryMode): Promise<boolean> {
    if (this.closed) return false;
    // режим приходит из webview: только два «повышающих», и не ниже/не равен текущему (повтор без новых прав бессмыслен)
    if (mode !== 'acceptEdits' && mode !== 'bypassPermissions') return false;
    if (this.mode === mode || this.mode === 'bypassPermissions') return false;
    // `bypassPermissions` без разрешения в настройках молча понижается до default — это не «разрешили», повтор бессмыслен
    if (this.effective(mode) !== mode) return false;
    await this.setMode(mode);
    return this.enqueue({ text: AGY_RETRY_PROMPT, silent: true });
  }

  private enqueue(prompt: NotedPrompt): boolean {
    if (this.closed) return false;
    this.queue.push({ prompt });
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
    await this.tail; // `result`, ждущий подгрузки диффа, закроет ход сам
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
        // через гейт: ошибка не обгоняет `tool.result`, ждущий диффа, а авария — `turn.result` из очереди
        onAgyError: (error) =>
          this.gated(() => {
            if (proc === this.proc && !this.closed)
              this.emit({ type: 'error', message: error.message, fatal: false, ...(error.code ? { code: error.code } : {}) });
          }),
        onOverflow: () =>
          this.gated(() => {
            if (proc === this.proc) this.fatal(new Error('agy: stdout line is too long'));
          }),
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
    this.gated(() => this.handleEvent(proc, event));
  }

  /**
   * Пока подгружается дифф правки (чтение транскрипта), следующие события agy и выход процесса ждут в хвосте:
   * порядок ленты сохраняется. Без правок — всё синхронно, как раньше.
   */
  private gated(work: () => void | Promise<void>): void {
    const run = (): void | Promise<void> => {
      try {
        return work();
      } catch (error) {
        this.log('error', `agy event failed: ${String(error)}`);
      }
    };
    const track = (p: Promise<void>): void => {
      this.inflight++;
      this.tail = p
        .catch((error) => this.log('error', `agy event failed: ${String(error)}`))
        .finally(() => {
          this.inflight--;
        });
    };
    if (this.inflight > 0) {
      track(this.tail.then(run));
      return;
    }
    const r = run();
    if (r) track(r);
  }

  private handleEvent(proc: AgyProcess, event: AgyEvent): void | Promise<void> {
    if (proc !== this.proc || this.closed) return;
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
    const pending = this.editResults(events);
    const finish = (): void => {
      if (this.closed) return;
      this.emitAll(events);
      if (event.event === 'result') {
        // после ERROR agy часто выходит (неизвестная модель, ошибка разбора ввода): следующий ход — в новом процессе,
        // а не в stdin умирающего (его выход мы бы приняли за аварию посреди хода)
        if (event.result.status !== 'SUCCESS') this.stale = true;
        if (events.some((e) => e.type === 'turn.result')) this.turn?.done.resolve();
      }
    };
    if (pending.length === 0) return finish();
    return Promise.all(pending).then(finish);
  }

  /** Правки без ошибки: дифф и аргументы из `transcript_full.jsonl` в `tool.result.result` (нет данных — карточка без диффа). */
  private editResults(events: AgentEvent[]): Promise<void>[] {
    const conversationId = this.mapper.conversationId;
    const pending: Promise<void>[] = [];
    if (!conversationId) return pending;
    const timeoutMs = this.config.editTimeoutMs ?? 2000;
    for (const e of events) {
      if (e.type !== 'tool.result' || e.isError) continue;
      const lookup = this.mapper.editLookup(e.toolUseId);
      if (!lookup) continue;
      const load = editResultOf(
        { root: this.config.agyRoot ?? defaultAgyRoot(), conversationId, ...lookup },
        {
          ...(this.config.transcriptRetries !== undefined ? { retries: this.config.transcriptRetries } : {}),
          ...(this.config.transcriptDelayMs !== undefined ? { delayMs: this.config.transcriptDelayMs } : {}),
          log: (level, message) => this.log(level, message),
          signal: this.aborter.signal,
        },
      );
      // чтение может зависнуть (сетевой home, FUSE): гейт и Stop не должны ждать его вечно
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          this.log('warn', `agy edit diff timed out after ${timeoutMs} ms`);
          resolve(undefined);
        }, timeoutMs);
      });
      pending.push(
        Promise.race([load, timeout])
          .then(
            (result) => {
              if (result) e.result = result;
            },
            (error) => this.log('warn', `agy edit diff failed: ${errorText(error)}`),
          )
          .finally(() => clearTimeout(timer)),
      );
    }
    return pending;
  }

  private onExit(proc: AgyProcess, exit: AgyExit): void {
    // выход после `result` с дожидающимся диффом разбираем после него, а не поперёк
    this.gated(() => this.handleExit(proc, exit));
  }

  private handleExit(proc: AgyProcess, exit: AgyExit): void {
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
    this.aborter.abort();
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
