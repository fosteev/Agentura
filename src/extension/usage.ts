import type { LimitWindowSummary } from '../protocol';

export interface UsageSnapshot {
  windows: LimitWindowSummary[];
  updatedAt: number;
  error?: string;
}

/**
 * Источник окон. Может вернуть и время данных (`updatedAt`) — у запасных окон движка оно своё,
 * а не момент запроса; без него время данных = момент ответа.
 */
export type UsageFetcher = () => Promise<
  LimitWindowSummary[] | { windows: LimitWindowSummary[]; updatedAt: number }
>;

/** Ручное обновление не чаще раза в минуту: `/api/oauth/usage` ограничен по частоте. */
export const MANUAL_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Лимиты подписки: кэш последнего ответа, кулдаун ручного обновления, склейка параллельных запросов.
 * Источник — `LimitsSource.fetch` из `src/data/limits.ts` (`/api/oauth/usage`, запас — окна движка);
 * автоматический опрос — `startLimitsPolling` по настройке `agentura.usagePollMinutes`.
 */
export class UsageService {
  private last: UsageSnapshot | undefined;
  private inflight: Promise<UsageSnapshot> | undefined;

  constructor(
    private readonly fetchWindows: UsageFetcher,
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = MANUAL_REFRESH_COOLDOWN_MS,
  ) {}

  refresh(): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.last && this.now() - this.last.updatedAt < this.cooldownMs) {
      return Promise.resolve(this.last);
    }
    this.inflight = this.fetchWindows()
      .then((r): UsageSnapshot =>
        Array.isArray(r)
          ? { windows: r, updatedAt: this.now() }
          : { windows: r.windows, updatedAt: r.updatedAt },
      )
      .catch((e: unknown): UsageSnapshot => ({
        windows: this.last?.windows ?? [],
        updatedAt: this.last?.updatedAt ?? 0,
        error: e instanceof Error ? e.message : String(e),
      }))
      .then((snap) => {
        this.inflight = undefined;
        // Данные старше уже показанных не затирают их.
        if (!snap.error && this.last && snap.updatedAt < this.last.updatedAt) return this.last;
        if (!snap.error) this.last = snap;
        return snap;
      });
    return this.inflight;
  }
}

/** Цифры прототипа — для отладки webview без сети. В расширении не подключена с этапа 2. */
export const stubUsageFetcher: UsageFetcher = async () => {
  const at = (h: number, dayShift = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayShift);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  return [
    { kind: 'five-hour', percent: 62, resetsAt: at(17) },
    { kind: 'weekly', percent: 34, resetsAt: at(9, (4 - new Date().getDay() + 7) % 7 || 7) },
  ];
};
