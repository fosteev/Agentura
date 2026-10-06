import { resolveExecutable, type ResolvedExecutable } from '../agent/claude/executable';
import { hostStrings, type Lang } from '../shared/l10n';

export interface EngineLocatorDeps {
  /** Значение `agentura.claudeExecutable` на сейчас. */
  setting(): string;
  /** Свой резолвер (Codex, тесты); по умолчанию — поиск `claude`. */
  resolve?: (setting: string) => Promise<ResolvedExecutable>;
  /** Имя бинарника для журнала; по умолчанию `claude`. Ошибки разных движков не смешиваются. */
  name?: string;
  /** Короткий текст «не найден», если резолвер не дал `problem`; по умолчанию — про Claude Code. */
  notFound?: string;
  info(m: string): void;
  warn(m: string): void;
  /** Предупреждение пользователю (путь есть, но версия старая или не запускается). Один раз на значение настройки. */
  notify?(m: string): void;
  /** Язык текстов проблем; по умолчанию русский. */
  lang?(): Lang;
}

/**
 * Поиск бинарника движка (`claude` или `codex`: резолвер и имя — зависимости) без блокировки потока хоста: прогрев при активации, первый запуск движка ждёт тот же
 * промис. Найденный путь кэшируется по значению настройки; «не нашли» не кэшируется (поставил claude —
 * следующая вкладка его подхватит без перезагрузки окна), но параллельные запросы делят один поиск.
 */
export class EngineLocator {
  private cached: { setting: string; result: ResolvedExecutable } | undefined;
  /** `loud` — кто-то из ждущих не тихий: тогда «не найден» пишется в журнал, даже если поиск начала тихая проба. */
  private inflight: { setting: string; promise: Promise<ResolvedExecutable>; loud: boolean } | undefined;
  private warnedFor: string | undefined;

  constructor(private readonly deps: EngineLocatorDeps) {}

  /** Запустить поиск заранее (активация расширения); ошибок не бросает. */
  warm(): void {
    void this.locate().catch(() => undefined);
  }

  /**
   * `quiet` — фоновая проба (списки сессий сайдбара): «не найден» не пишется в журнал, иначе каждый пользователь без
   * движка получал бы предупреждение, а журнал — строку на каждое перечитывание списка. Найденный путь и «старая
   * версия» пишутся как обычно (они кэшируются, второго шанса сказать о них не будет).
   */
  locate(quiet = false): Promise<ResolvedExecutable> {
    const setting = this.deps.setting();
    if (this.cached?.setting === setting) return Promise.resolve(this.cached.result);
    if (this.inflight?.setting === setting) {
      if (!quiet) this.inflight.loud = true;
      return this.inflight.promise;
    }
    const run = this.deps.resolve ?? ((s: string) => resolveExecutable(s, { lang: this.deps.lang?.() ?? 'ru' }));
    const name = this.deps.name ?? 'claude';
    const job = { setting, loud: !quiet } as { setting: string; promise: Promise<ResolvedExecutable>; loud: boolean };
    const promise = run(setting).then((r) => {
      if (this.inflight === job) this.inflight = undefined;
      // настройку сменили, пока шёл поиск: результат старого значения не кэшируем и не предупреждаем о нём
      if (setting !== this.deps.setting()) return r;
      if (!job.loud && !usable(r)) return r;
      if (usable(r)) {
        this.deps.info(`${name}: ${r.path} ${r.version} (${r.source})`);
        this.cached = { setting, result: r };
      } else {
        // путь из настройки, который не отвечает на `--version`, — тоже «не найден»: не кэшируем и движок не
        // запускаем (иначе SDK упал бы невнятной ошибкой spawn вместо карточки с «Открыть настройки»)
        this.deps.info(
          r.path
            ? `${name}: ${r.path} не запускается, движок не запускается`
            : `${name}: системный не найден, движок не запускается`,
        );
      }
      if (r.problem && this.warnedFor !== setting) {
        this.warnedFor = setting;
        this.deps.warn(r.problem);
        // «не найден» показывает карточка в ленте, всплывашка — только про запускающийся, но старый
        if (usable(r)) this.deps.notify?.(r.problem);
      }
      return r;
    });
    promise.catch(() => {
      if (this.inflight === job) this.inflight = undefined;
    });
    job.promise = promise;
    this.inflight = job;
    return promise;
  }

  /** Путь для SDK; `undefined` — не нашли или не запускается. */
  async path(): Promise<string | undefined> {
    const r = await this.locate();
    return usable(r) ? r.path : undefined;
  }

  /** Движок установлен и запускается — тихая проба для фоновых списков (см. `locate`). */
  async available(): Promise<boolean> {
    return usable(await this.locate(true));
  }

  /** Можно ли запускать движок; иначе — что показать в карточке. */
  async ready(): Promise<{ ok: true } | { ok: false; problem: string }> {
    const r = await this.locate();
    return usable(r)
      ? { ok: true }
      : { ok: false, problem: r.problem ?? this.deps.notFound ?? hostStrings(this.deps.lang?.() ?? 'ru').engineNotFoundShort };
  }
}

/** `claude` запускается (`--version` ответил); старая версия — запускаем с предупреждением. */
function usable(r: ResolvedExecutable): boolean {
  return r.path !== undefined && r.version !== undefined;
}
