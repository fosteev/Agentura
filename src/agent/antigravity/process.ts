import { execFile, spawn } from 'node:child_process';
import type { LogFn } from '../claude/adapter';
import { parseAgyError, parseAgyLine, type AgyEvent } from './protocol';

/** Что нужно от процесса agy: его реализует `ChildProcess`, в тестах — фейк (`fakeAgy.ts`). */
export interface AgyChild {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface AgySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type AgySpawn = (path: string, args: string[], options: AgySpawnOptions) => AgyChild;

export function defaultAgySpawn(path: string, args: string[], options: AgySpawnOptions): AgyChild {
  return spawn(path, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}

/** Строка процесса (`ps -A -o pid=,ppid=`). */
export interface ProcRow {
  pid: number;
  ppid: number;
}

export function parsePs(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/** Все потомки `root` (дети, внуки…) без самого `root`. */
export function descendantsOf(rows: readonly ProcRow[], root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of kids.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Таблица процессов системы; на Windows `ps` нет — пусто (там дерево убивает `taskkill /T`). */
export function listProcessesPs(): Promise<ProcRow[]> {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parsePs(stdout));
    });
  });
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // уже вышел
  }
}

export interface AgyExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Ошибка запуска (`ENOENT`) — процесс не стартовал. */
  error?: Error;
  /** Последние строки stderr: что сказал agy перед смертью. */
  stderrTail: string;
}

export interface AgyProcessHandlers {
  onEvent(event: AgyEvent): void;
  /** Строка stderr (журнал `debug`). */
  onStderr(line: string): void;
  /** `AGY_ERROR: {…}` в stderr. */
  onAgyError(error: { message: string; code?: string }): void;
  /** Строка длиннее лимита без перевода строки: поток дальше разбирать нельзя. */
  onOverflow(): void;
  /** Процесс закончил (после `close`: stdout дочитан) или не запустился. Один раз. */
  onExit(exit: AgyExit): void;
}

export interface AgyProcessOptions {
  /** Лимит одной строки stdout, символов. */
  maxLineBytes?: number;
  /** Сколько ждать выхода после SIGINT/закрытия stdin, прежде чем убить, мс. */
  graceMs?: number;
  log?: LogFn;
  listProcesses?: () => Promise<ProcRow[]>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
}

const DEFAULT_MAX_LINE = 64 * 1024 * 1024;
const DEFAULT_GRACE_MS = 2000;
const TAIL_LINES = 6;
/** После SIGKILL ждём `close` недолго: stdout уже не важен, главное — не зависнуть. */
const KILL_WAIT_MS = 500;

/**
 * Один запущенный `agy`: NDJSON stdout → события, stderr → журнал (`AGY_ERROR:` разбирается), запись строк
 * в stdin и остановка. Остановка — SIGINT (единственный способ прервать ход), через `graceMs` SIGKILL;
 * потомков (`run_command` переживает смерть agy: переподвешен к pid 1) собираем до сигнала и добиваем явно.
 */
export class AgyProcess {
  private buffer = '';
  private errBuffer = '';
  private overflowed = false;
  private readonly tail: string[] = [];
  private closed = false;
  private stdinEnded = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private readonly maxLine: number;
  private readonly graceMs: number;
  private readonly listProcesses: () => Promise<ProcRow[]>;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  /** Потомки, собранные заранее: после выхода agy они уже не его дети. */
  private known = new Set<number>();

  constructor(
    private readonly child: AgyChild,
    private readonly handlers: AgyProcessHandlers,
    options: AgyProcessOptions = {},
  ) {
    this.maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.listProcesses = options.listProcesses ?? listProcessesPs;
    this.killPid = options.killPid ?? defaultKillPid;
    this.closedPromise = new Promise<void>((resolve) => (this.resolveClosed = resolve));
    const log = options.log;

    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => this.onStdout(String(chunk)));
    child.stderr.on('data', (chunk: string | Buffer) => this.onStderr(String(chunk)));
    child.stdin.on('error', (error: Error) => log?.('debug', `agy stdin: ${error.message}`));
    // `error` бывает и у живого процесса (не удался kill): закрытием считаем только незапуск (pid нет)
    child.on('error', (error) => {
      if (child.pid === undefined) this.finish({ code: null, signal: null, error });
      else log?.('warn', `agy process error: ${error.message}`);
    });
    child.on('close', (code, signal) => this.finish({ code, signal }));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Процесс ещё не закончился. */
  get alive(): boolean {
    return !this.closed;
  }

  /** Строка в stdin (NDJSON уже с `\n`). `false` — писать некуда. */
  write(line: string): boolean {
    if (this.closed || this.stdinEnded) return false;
    try {
      this.child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Прервать ход: SIGINT → agy отвечает `result` (`interrupted`) и выходит с 1. Не вышел за `graceMs` или
   * остались потомки — SIGKILL. Возвращается, когда процесс закончил (stdout дочитан).
   */
  async interrupt(): Promise<void> {
    if (this.closed) {
      await this.killKnown();
      return;
    }
    await this.collect();
    this.child.kill('SIGINT');
    await this.waitClosed(this.graceMs);
    await this.force();
  }

  /** Тихая остановка простаивающего процесса: закрыть stdin (agy доигрывает и выходит с 0), потом force. */
  async stop(): Promise<void> {
    if (this.closed) return;
    await this.collect();
    this.endStdin();
    await this.waitClosed(this.graceMs);
    await this.force();
  }

  /** Сразу убить agy и потомков (мёртвый протокол, переполнение). */
  async kill(): Promise<void> {
    await this.collect();
    await this.force();
  }

  private endStdin(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    try {
      this.child.stdin.end();
    } catch {
      // уже закрыт
    }
  }

  /**
   * До сигнала: потомки agy переживут его смерть. Только по дереву `ppid` от pid нашего agy, никогда по имени.
   * После выхода agy не собираем: его pid может достаться чужому процессу, а «потомки» — оказаться чужими.
   */
  private async collect(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || this.closed) return;
    try {
      const rows = await this.listProcesses();
      // agy вышел, пока шёл `ps`: таблица могла застать уже чужой процесс с его pid
      if (this.closed) return;
      for (const k of descendantsOf(rows, pid)) this.known.add(k);
    } catch {
      // без списка убьём хотя бы agy
    }
  }

  private async force(): Promise<void> {
    if (!this.closed) {
      this.child.kill('SIGKILL');
      if (process.platform === 'win32' && this.child.pid !== undefined) this.killPid(this.child.pid, 'SIGKILL');
      await this.waitClosed(KILL_WAIT_MS);
    }
    await this.killKnown();
  }

  /**
   * Добить снятых потомков. Перед этим — второй снимок: внуки, которых `run_command` успел породить за grace
   * (воркеры сборки), — потомки уже известных pid (корень — только они, не agy: его pid после выхода чужой).
   */
  private async killKnown(): Promise<void> {
    if (this.known.size === 0) return;
    try {
      const rows = await this.listProcesses();
      for (const root of [...this.known]) for (const k of descendantsOf(rows, root)) this.known.add(k);
    } catch {
      // добьём хотя бы снятых
    }
    for (const pid of this.known) this.killPid(pid, 'SIGKILL');
    this.known.clear();
  }

  private waitClosed(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.closedPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private onStdout(chunk: string): void {
    if (this.overflowed) return;
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      this.handleLine(line);
    }
    if (this.buffer.length > this.maxLine) {
      this.overflowed = true;
      this.buffer = '';
      this.handlers.onOverflow();
    }
  }

  private handleLine(line: string): void {
    const event = parseAgyLine(line);
    if (event) this.handlers.onEvent(event);
  }

  private onStderr(chunk: string): void {
    this.errBuffer += chunk;
    for (let i = this.errBuffer.indexOf('\n'); i >= 0; i = this.errBuffer.indexOf('\n')) {
      const line = this.errBuffer.slice(0, i).replace(/\r$/, '');
      this.errBuffer = this.errBuffer.slice(i + 1);
      this.handleErrLine(line);
    }
    if (this.errBuffer.length > 64 * 1024) this.errBuffer = '';
  }

  private handleErrLine(line: string): void {
    if (!line.trim()) return;
    this.tail.push(line.trim().slice(0, 500));
    if (this.tail.length > TAIL_LINES) this.tail.shift();
    const error = parseAgyError(line);
    this.handlers.onStderr(line);
    if (error) this.handlers.onAgyError(error);
  }

  private finish(exit: Omit<AgyExit, 'stderrTail'>): void {
    if (this.closed) return;
    this.closed = true;
    // хвост без перевода строки на конце stdout/stderr — тоже строка
    if (!this.overflowed && this.buffer.trim()) this.handleLine(this.buffer);
    this.buffer = '';
    if (this.errBuffer.trim()) this.handleErrLine(this.errBuffer);
    this.errBuffer = '';
    this.resolveClosed();
    this.handlers.onExit({ ...exit, stderrTail: this.tail.join('\n') });
  }

}
