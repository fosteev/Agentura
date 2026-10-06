import { parseAgyUsage, runAgyUsage, type AgyQuotaRow, type RunAgyUsage } from '../agent/antigravity/quota';

export interface AgyQuotaSnapshot {
  rows: AgyQuotaRow[];
  /** Когда данные получены (мс); 0 — ещё не получали. */
  updatedAt: number;
}

/** Не чаще раза в 10 минут: каждый запрос — процесс agy на ~7 с, а квота меняется медленно (недельное окно). */
export const AGY_QUOTA_INTERVAL_MS = 10 * 60_000;

/**
 * Квота Antigravity: кэш последнего `agy -p "/usage"`, интервал между запусками (в том числе неудачными), склейка
 * параллельных запросов. Не разобрали вывод — пустой список (UI ничего не рисует); процесс упал — остаётся прежний.
 */
export class AgyQuotaService {
  private last: AgyQuotaSnapshot = { rows: [], updatedAt: 0 };
  private lastAttempt = 0;
  private inflight: Promise<AgyQuotaSnapshot> | undefined;
  private readonly listeners = new Set<(snap: AgyQuotaSnapshot) => void>();

  constructor(
    private readonly executable: () => Promise<string | undefined>,
    private readonly run: RunAgyUsage = runAgyUsage,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = AGY_QUOTA_INTERVAL_MS,
  ) {}

  onUpdate(listener: (snap: AgyQuotaSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get snapshot(): AgyQuotaSnapshot {
    return this.last;
  }

  refresh(): Promise<AgyQuotaSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.lastAttempt && this.now() - this.lastAttempt < this.intervalMs) return Promise.resolve(this.last);
    this.lastAttempt = this.now();
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<AgyQuotaSnapshot> {
    try {
      const path = await this.executable();
      if (!path) return this.last;
      const rows = parseAgyUsage(await this.run(path));
      this.last = { rows, updatedAt: this.now() };
      for (const l of this.listeners) {
        try {
          l(this.last);
        } catch {
          /* подписчик отвечает за свои ошибки */
        }
      }
    } catch {
      /* agy не запустился или завис: прежние цифры остаются */
    }
    return this.last;
  }
}
