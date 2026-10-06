import { watch as fsWatch, existsSync, realpathSync, type FSWatcher } from 'node:fs';
import type { AgentAdapter, AgentProvider } from '../agent/types';
import type { SessionSummary } from '../protocol';
import {
  listSessionRows,
  projectDir,
  toSummary,
  type LiveSessions,
  type SessionRow,
  type TranscriptCache,
} from '../data/sessions';

/** Второй источник сессий — Codex: `thread/list` по папке проекта (свой индекс не ведём). */
export interface CodexSessionsSource {
  /** Адаптер Codex; создаётся лениво, пока Codex не нужен — не вызывается. */
  adapter(): AgentAdapter;
  /** Codex установлен и запускается; нет — его строк в списке нет и процесс не запускается. */
  available(): Promise<boolean>;
}

export interface SessionsServiceDeps {
  adapter: AgentAdapter;
  /** Нет — только Claude (тесты, окно без Codex). */
  codex?: CodexSessionsSource;
  cwd: string;
  live: LiveSessions;
  cache: TranscriptCache;
  log: { debug(m: string): void; warn(m: string): void };
  /** Каталог транскриптов; по умолчанию — `~/.claude/projects/<cwd>`. */
  dir?: string;
  /** Тишина после последней записи, мс, перед пересчётом списка. */
  debounceMs?: number;
  /** Но не реже, чем раз в столько мс, пока файлы пишутся (идущий ход пишет транскрипт постоянно). */
  maxWaitMs?: number;
  /** Подмена `fs.watch` в тестах. */
  watch?: (dir: string, onChange: () => void, onError: () => void) => { close(): void };
  /** Как часто проверять появление каталога, если его ещё нет (первая сессия проекта), мс. */
  retryMs?: number;
}

export const DEFAULT_DEBOUNCE_MS = 800;
export const DEFAULT_MAX_WAIT_MS = 4000;
/**
 * Список Codex-тредов — короткоживущий процесс на каждое чтение, поэтому его не перечитывают на каждый
 * тик Claude-списка: только когда сменилась живая Codex-сессия, переименовали или истёк срок. Своего таймера
 * нет: тред, начатый в Codex CLI, появится при следующей пересборке списка (событие Claude-транскриптов,
 * живая сессия, открытие боковой панели) не раньше чем через срок.
 */
export const CODEX_TTL_MS = 30_000;
/** Codex не найден или список не ответил: до следующей попытки столько мс. */
const CODEX_BACKOFF_MS = 60_000;
/** Первый показ: сколько Claude-список ждёт строк Codex, прежде чем выйти без них (они придут следующим проходом). */
const CODEX_FIRST_WAIT_MS = 3000;
/** Сколько раз подряд возвращать своё название сессии, которое перебивает движок. */
const MAX_TITLE_REAPPLY = 5;

function defaultWatch(dir: string, onChange: () => void, onError: () => void): { close(): void } {
  const w: FSWatcher = fsWatch(dir, { persistent: false }, () => onChange());
  w.on('error', () => onError());
  return w;
}

/** Каталог транскриптов: CLI называет его по реальному пути папки (симлинк в пути воркспейса). */
function watchDir(cwd: string): string {
  const direct = projectDir(cwd);
  if (existsSync(direct)) return direct;
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) return projectDir(real);
  } catch {
    // папки нет — прямой путь
  }
  return direct;
}

/**
 * Список сессий проекта (этап 6): `listSessions()` + итоги транскриптов + статус живых сессий.
 * Обновляется по `fs.watch` каталога транскриптов (с дебаунсом — идущий ход пишет файл на каждое
 * сообщение) и по смене статуса живой сессии в реестре. Подписчики получают готовые строки.
 */
export class SessionsService {
  private rows: SessionRow[] = [];
  private loaded = false;
  private readonly listeners = new Set<(rows: SessionSummary[]) => void>();
  private watcher: { close(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private firstPendingAt: number | undefined;
  private inflight: Promise<SessionRow[]> | undefined;
  /** Повторный проход после текущего: пока читали, что-то поменялось (запись хода, переименование). */
  private rerun: Promise<SessionRow[]> | undefined;
  private disposed = false;
  /**
   * Названия, данные сессиям с живым процессом движка в этом окне (этап 5 roadmap 0.2). Живой прогон: CLI в конце
   * хода дописывает в транскрипт своё название из памяти процесса и перебивает переименование, сделанное во время
   * хода. Пока процесс жив, список показывает наше название и, увидев чужое, переименовывает снова.
   */
  private readonly pinned = new Map<string, { title: string; attempts: number }>();
  private readonly reapplying = new Set<string>();
  /** Последние строки Codex и на какой момент они сняты (срок, эпоха живых Codex-сессий). */
  private codexCache: { rows: SessionRow[]; at: number; epoch: number; rev: number } | undefined;
  /** Растёт, когда строки точно устарели (переименование): кэш, снятый до этого, не годится. */
  private codexRev = 0;
  private codexFailed: { at: number; rev: number; epoch: number } | undefined;
  private codexWarned = false;
  /** Идущее чтение списка Codex (процесс) и просьба повторить его после. */
  private codexJob: Promise<void> | undefined;
  private codexAgain = false;
  private codexLoading: { rev: number; epoch: number } | undefined;
  /** Все id, когда-либо пришедшие из `thread/list`: маршрут rename, даже если строки в списке сейчас нет. */
  private readonly codexKnown = new Set<string>();

  constructor(private readonly deps: SessionsServiceDeps) {}

  /** Запустить слежение за каталогом транскриптов. */
  start(): void {
    const attach = (): boolean => {
      if (this.disposed || this.watcher) return true;
      const dir = this.deps.dir ?? watchDir(this.deps.cwd);
      if (!existsSync(dir)) return false;
      try {
        this.watcher = (this.deps.watch ?? defaultWatch)(
          dir,
          () => this.schedule(),
          () => {
            // каталог удалили или слежение отвалилось: закрыть и ждать его снова, как в начале
            this.watcher?.close();
            this.watcher = undefined;
            if (!this.disposed) {
              this.schedule();
              this.retry = setTimeout(poll, this.deps.retryMs ?? 30_000);
            }
          },
        );
        return true;
      } catch (e) {
        this.deps.log.warn(`слежение за ${dir}: ${String(e)}`);
        return false;
      }
    };
    // проект без сессий: каталог появится с первой — ждём без шума
    const poll = (): void => {
      if (this.disposed) return;
      if (attach()) this.schedule();
      else this.retry = setTimeout(poll, this.deps.retryMs ?? 30_000);
    };
    if (!attach()) this.retry = setTimeout(poll, this.deps.retryMs ?? 30_000);
  }

  onChange(listener: (rows: SessionSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Перечитать сейчас (первый показ, смена статуса живой сессии — через `schedule`). */
  refresh(): Promise<SessionRow[]> {
    // окно без папки: `listSessions({dir: ''})` SDK отдал бы сессии всех проектов (и разбор всех транскриптов)
    if (!this.deps.cwd) return Promise.resolve([]);
    if (this.inflight) {
      // текущий проход мог прочитать каталог до изменения — иначе последняя запись хода или
      // переименование не попали бы в список до следующего события fs.watch
      this.rerun ??= this.inflight
        .catch(() => undefined)
        .then(() => {
          this.rerun = undefined;
          return this.refresh();
        });
      return this.rerun;
    }
    const run = Promise.all([
      listSessionRows(this.deps.adapter, {
        cwd: this.deps.cwd,
        live: this.deps.live,
        cache: this.deps.cache,
        onError: (id, e) => this.deps.log.debug(`транскрипт ${id}: ${String(e)}`),
      }),
      this.codexRows(),
    ])
      .then(([claude, codex]) => {
        // Claude-строки как были; Codex — рядом, общий порядок по времени
        const rows = codex.length ? [...claude, ...codex] : claude;
        this.applyPins(claude);
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        this.rows = rows;
        this.loaded = true;
        const summaries = rows.map(toSummary);
        for (const l of this.listeners) {
          try {
            l(summaries);
          } catch {
            /* подписчик отвечает за свои ошибки */
          }
        }
        return rows;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    this.inflight = run;
    return run;
  }

  /**
   * Строки Codex: `thread/list` по папке проекта. Claude-список Codex не ждёт: есть кэш — он отдаётся сразу, а
   * перечитывание идёт в фоне и по готовности пересобирает список (`schedule`); кэша нет (первый показ) — ждём не
   * дольше `CODEX_FIRST_WAIT_MS`. Процесс один на раз (`runCodex`). Сбой или отсутствие Codex список не ломают —
   * остаются прошлые строки (или пусто), в журнал одно предупреждение; повтор не чаще раза в `CODEX_BACKOFF_MS`.
   */
  private async codexRows(): Promise<SessionRow[]> {
    if (!this.deps.codex) return [];
    const now = Date.now();
    const cache = this.codexCache;
    const epoch = this.deps.live.codexEpoch;
    const rev = this.codexRev;
    const fresh = cache && cache.rev === rev && cache.epoch === epoch && now - cache.at < CODEX_TTL_MS;
    if (fresh) return this.withLive(cache.rows);
    const failed = this.codexFailed;
    if (failed && failed.rev === rev && failed.epoch === epoch && now - failed.at < CODEX_BACKOFF_MS) {
      return this.withLive(cache?.rows ?? []);
    }
    const job = this.runCodex();
    let done = false;
    if (!cache) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      done = await Promise.race([
        job.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), CODEX_FIRST_WAIT_MS))),
      ]);
      clearTimeout(timer);
    }
    if (!done) void job.then(() => this.schedule());
    return this.withLive(this.codexCache?.rows ?? []);
  }

  /**
   * Перечитать список Codex: не больше одного процесса за раз; просьба во время чтения — ещё один проход после
   * него (ключ кэша — эпоха живых сессий и переименования — мог смениться). Не бросает.
   */
  private runCodex(): Promise<void> {
    if (this.codexJob) {
      // идущее чтение снято по старому ключу — после него ещё одно; по тому же — просто дождаться его
      const key = this.codexLoading;
      if (key && (key.rev !== this.codexRev || key.epoch !== this.deps.live.codexEpoch)) this.codexAgain = true;
      return this.codexJob;
    }
    const job = (async () => {
      do {
        this.codexAgain = false;
        await this.loadCodex();
      } while (this.codexAgain && !this.disposed);
    })().finally(() => {
      this.codexJob = undefined;
    });
    this.codexJob = job;
    return job;
  }

  private async loadCodex(): Promise<void> {
    const source = this.deps.codex;
    if (!source || this.disposed) return;
    const epoch = this.deps.live.codexEpoch;
    const rev = this.codexRev;
    this.codexLoading = { rev, epoch };
    try {
      if (!(await source.available())) {
        this.codexFailed = { at: Date.now(), rev, epoch };
        this.codexCache = undefined;
        return;
      }
      const infos = await source.adapter().listSessions(this.deps.cwd);
      const rows = infos.map(
        (i): SessionRow => ({
          ...i,
          provider: 'codex',
          state: 'idle',
          turns: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      );
      for (const r of rows) this.codexKnown.add(r.id);
      this.codexCache = { rows, at: Date.now(), epoch, rev };
      this.codexFailed = undefined;
      this.codexWarned = false;
    } catch (e) {
      this.codexFailed = { at: Date.now(), rev, epoch };
      if (!this.codexWarned) {
        this.codexWarned = true;
        this.deps.log.warn(`список тредов Codex: ${String(e)}`);
      } else this.deps.log.debug(`список тредов Codex: ${String(e)}`);
    }
  }

  /** Состояние живых сессий — поверх закэшированных строк (оно меняется чаще, чем список). */
  private withLive(rows: readonly SessionRow[]): SessionRow[] {
    return rows.map((r) => ({ ...r, state: this.deps.live.get(r.id)?.state ?? 'idle' }));
  }

  /** Последний известный список (или свежий, если ещё не читали). */
  async list(): Promise<SessionRow[]> {
    return this.loaded ? this.rows : this.refresh();
  }

  async summaries(): Promise<SessionSummary[]> {
    return (await this.list()).map(toSummary);
  }

  /** Отложенный пересчёт: дебаунс с потолком ожидания. */
  schedule(): void {
    if (this.disposed) return;
    const now = Date.now();
    this.firstPendingAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const debounce = this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const maxWait = this.deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const wait = Math.max(0, Math.min(debounce, this.firstPendingAt + maxWait - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.firstPendingAt = undefined;
      void this.refresh().catch((e) => this.deps.log.warn(`список сессий: ${String(e)}`));
    }, wait);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const provider = this.providerOf(sessionId);
    if (provider === 'codex') {
      // имя хранит сам Codex (`thread/name/set`): закрепление поверх перебивающего движка — только у Claude
      await this.deps.codex!.adapter().renameSession(sessionId, title, this.cwdOf(sessionId));
      this.codexRev++;
      // новое имя — до пересборки списка (иначе строка мигнёт старым, пока фон перечитывает)
      await this.runCodex();
      await this.refresh();
      return;
    }
    await this.deps.adapter.renameSession(sessionId, title, this.cwdOf(sessionId));
    if (this.deps.live.get(sessionId)) this.pinned.set(sessionId, { title, attempts: 0 });
    else this.pinned.delete(sessionId);
    await this.refresh();
  }

  /** Своё название поверх перебитого движком; процесс сессии ушёл и название на месте — больше не следим. */
  private applyPins(rows: SessionRow[]): void {
    for (const [id, pin] of this.pinned) {
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      if (row.title === pin.title) {
        pin.attempts = 0;
        if (!this.deps.live.get(id)) this.pinned.delete(id);
        continue;
      }
      row.title = pin.title;
      if (this.reapplying.has(id)) continue;
      // на случай, если запись названия не действует (формат CLI сменился), — не крутиться вечно
      if (++pin.attempts > MAX_TITLE_REAPPLY) {
        this.deps.log.warn(`название сессии ${id} перебивается движком — оставляю как есть`);
        this.pinned.delete(id);
        continue;
      }
      this.reapplying.add(id);
      this.deps.log.debug(`движок перебил название сессии ${id} — переименовываю снова`);
      void this.deps.adapter
        .renameSession(id, pin.title, row.cwd ?? this.deps.cwd)
        .catch((e) => this.deps.log.warn(`повтор переименования ${id}: ${String(e)}`))
        .finally(() => {
          this.reapplying.delete(id);
          // запись в транскрипт поймает fs.watch, но список мог уйти без неё — перепроверить
          this.schedule();
        });
    }
  }

  providerOf(sessionId: string): AgentProvider {
    if (!this.deps.codex) return 'claude';
    const row = this.rows.find((r) => r.id === sessionId);
    // строки уже нет (Codex-список сбросили между кликом и переименованием) — id, однажды пришедший от Codex,
    // всё равно не уходит Claude-адаптеру
    return row?.provider === 'codex' || (!row && this.codexKnown.has(sessionId)) ? 'codex' : 'claude';
  }

  /** `cwd` сессии (у сессий worktree он свой), иначе папка проекта. */
  private cwdOf(sessionId: string): string {
    return this.rows.find((r) => r.id === sessionId)?.cwd ?? this.deps.cwd;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.watcher?.close();
    this.listeners.clear();
  }
}
