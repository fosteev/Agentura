import { resolveExecutable, type ResolvedExecutable } from '../agent/claude/executable';
import { hostStrings, type Lang } from '../shared/l10n';

export interface EngineLocatorDeps {
  /** Значение `agentura.claudeExecutable` на сейчас. */
  setting(): string;
  resolve?: (setting: string) => Promise<ResolvedExecutable>;
  info(m: string): void;
  warn(m: string): void;
  /** Предупреждение пользователю (путь есть, но версия старая или не запускается). Один раз на значение настройки. */
  notify?(m: string): void;
  /** Язык текстов проблем; по умолчанию русский. */
  lang?(): Lang;
}

/**
 * Поиск `claude` без блокировки потока хоста: прогрев при активации, первый запуск движка ждёт тот же
 * промис. Найденный путь кэшируется по значению настройки; «не нашли» не кэшируется (поставил claude —
 * следующая вкладка его подхватит без перезагрузки окна), но параллельные запросы делят один поиск.
 */
export class EngineLocator {
  private cached: { setting: string; result: ResolvedExecutable } | undefined;
  private inflight: { setting: string; promise: Promise<ResolvedExecutable> } | undefined;
  private warnedFor: string | undefined;

  constructor(private readonly deps: EngineLocatorDeps) {}

  /** Запустить поиск заранее (активация расширения); ошибок не бросает. */
  warm(): void {
    void this.locate().catch(() => undefined);
  }

  locate(): Promise<ResolvedExecutable> {
    const setting = this.deps.setting();
    if (this.cached?.setting === setting) return Promise.resolve(this.cached.result);
    if (this.inflight?.setting === setting) return this.inflight.promise;
    const run = this.deps.resolve ?? ((s: string) => resolveExecutable(s, { lang: this.deps.lang?.() ?? 'ru' }));
    const promise = run(setting).then((r) => {
      if (this.inflight?.promise === promise) this.inflight = undefined;
      // настройку сменили, пока шёл поиск: результат старого значения не кэшируем и не предупреждаем о нём
      if (setting !== this.deps.setting()) return r;
      if (usable(r)) {
        this.deps.info(`claude: ${r.path} ${r.version} (${r.source})`);
        this.cached = { setting, result: r };
      } else {
        // путь из настройки, который не отвечает на `--version`, — тоже «не найден»: не кэшируем и движок не
        // запускаем (иначе SDK упал бы невнятной ошибкой spawn вместо карточки с «Открыть настройки»)
        this.deps.info(
          r.path
            ? `claude: ${r.path} не запускается, движок не запускается`
            : 'claude: системный не найден, движок не запускается',
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
      if (this.inflight?.promise === promise) this.inflight = undefined;
    });
    this.inflight = { setting, promise };
    return promise;
  }

  /** Путь для SDK; `undefined` — не нашли или не запускается. */
  async path(): Promise<string | undefined> {
    const r = await this.locate();
    return usable(r) ? r.path : undefined;
  }

  /** Можно ли запускать движок; иначе — что показать в карточке. */
  async ready(): Promise<{ ok: true } | { ok: false; problem: string }> {
    const r = await this.locate();
    return usable(r)
      ? { ok: true }
      : { ok: false, problem: r.problem ?? hostStrings(this.deps.lang?.() ?? 'ru').engineNotFoundShort };
  }
}

/** `claude` запускается (`--version` ответил); старая версия — запускаем с предупреждением. */
function usable(r: ResolvedExecutable): boolean {
  return r.path !== undefined && r.version !== undefined;
}
