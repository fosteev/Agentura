import type { LimitWindowSummary } from '../protocol';

export interface UsageSnapshot {
  windows: LimitWindowSummary[];
  updatedAt: number;
  error?: string;
}

export type UsageFetcher = () => Promise<LimitWindowSummary[]>;

/** Ручное обновление не чаще раза в минуту: `/api/oauth/usage` ограничен по частоте. */
export const MANUAL_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Лимиты подписки: кэш последнего ответа, кулдаун ручного обновления, склейка параллельных запросов.
 * Этап 1 — источник-заглушка; на этапе 2 сюда подставляется опрос `/api/oauth/usage` (`src/data/limits.ts`).
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
      .then((windows): UsageSnapshot => ({ windows, updatedAt: this.now() }))
      .catch((e: unknown): UsageSnapshot => ({
        windows: this.last?.windows ?? [],
        updatedAt: this.last?.updatedAt ?? 0,
        error: e instanceof Error ? e.message : String(e),
      }))
      .then((snap) => {
        if (!snap.error) this.last = snap;
        this.inflight = undefined;
        return snap;
      });
    return this.inflight;
  }
}

/** Этап 1: те же цифры, что в прототипе. */
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
