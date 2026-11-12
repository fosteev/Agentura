import {
  cleanAgyCliText,
  isAgyAuthError,
  parseAgyUsage,
  runAgyUsage,
  type AgyQuotaRow,
  type RunAgyUsage,
} from '../agent/antigravity/quota';

export type AgyQuotaState = 'loading' | 'ok' | 'signedOut' | 'missing' | 'error';

export interface AgyQuotaSnapshot {
  state: AgyQuotaState;
  rows: AgyQuotaRow[];
  /** Когда данные получены (мс); 0 — ещё не получали. */
  updatedAt: number;
  error?: string;
}

/** Не чаще раза в 10 минут: каждый запрос — процесс agy на ~7 с, а квота меняется медленно (недельное окно). */
export const AGY_QUOTA_INTERVAL_MS = 10 * 60_000;
/** При сбое `/usage` (`aicode.googleapis.com`, сеть) повторяем через минуту, а не через 10 минут. */
export const AGY_QUOTA_ERROR_COOLDOWN_MS = 60_000;

function looksLikeExplicitError(cleaned: string): boolean {
  return /\bfailed\b|\berror\b|\bexception\b|\btimeout\b|\beconn|not eligible|not currently available/i.test(cleaned);
}

/**
 * Квота Antigravity: кэш последнего `agy -p "/usage"`, кулдаун между запусками (короткий при ошибке), склейка
 * параллельных запросов. Нет `agy` — `missing` без кулдауна; не вошли — `signedOut`; прочая ошибка — `error` с
 * текстом, прежние строки и `updatedAt` сохраняются.
 */
export class AgyQuotaService {
  private last: AgyQuotaSnapshot = { state: 'loading', rows: [], updatedAt: 0 };
  private lastAttempt = 0;
  private inflight: Promise<AgyQuotaSnapshot> | undefined;
  private readonly listeners = new Set<(snap: AgyQuotaSnapshot) => void>();

  constructor(
    private readonly executable: () => Promise<string | undefined>,
    private readonly run: RunAgyUsage = runAgyUsage,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = AGY_QUOTA_INTERVAL_MS,
    private readonly warn?: (message: string) => void,
  ) {}

  onUpdate(listener: (snap: AgyQuotaSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get snapshot(): AgyQuotaSnapshot {
    return this.last;
  }

  refresh(force = false): Promise<AgyQuotaSnapshot> {
    if (this.inflight) return this.inflight;
    if (!force && this.lastAttempt) {
      const cooldown =
        this.last.state === 'error'
          ? Math.min(this.intervalMs, AGY_QUOTA_ERROR_COOLDOWN_MS)
          : this.intervalMs;
      if (this.now() - this.lastAttempt < cooldown) return Promise.resolve(this.last);
    }
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<AgyQuotaSnapshot> {
    let path: string | undefined;
    try {
      path = await this.executable();
    } catch {
      path = undefined;
    }
    if (!path) {
      this.set({ state: 'missing', rows: [], updatedAt: this.now() });
      return this.last;
    }
    this.lastAttempt = this.now();
    try {
      const output = await this.run(path);
      const rows = parseAgyUsage(output);
      if (rows.length > 0) {
        this.set({ state: 'ok', rows, updatedAt: this.now() });
      } else if (isAgyAuthError(output)) {
        this.set({ state: 'signedOut', rows: [], updatedAt: this.now() });
      } else {
        const cleaned = cleanAgyCliText(output);
        if (this.last.rows.length > 0 || looksLikeExplicitError(cleaned)) {
          const error = cleaned || 'agy -p /usage: empty output';
          this.warn?.(error);
          this.set({ state: 'error', rows: this.last.rows, updatedAt: this.last.updatedAt, error });
        } else {
          this.set({ state: 'signedOut', rows: [], updatedAt: this.now() });
        }
      }
    } catch (e) {
      if (isAgyAuthError(e)) {
        this.set({ state: 'signedOut', rows: [], updatedAt: this.now() });
      } else {
        const error = e instanceof Error ? e.message : String(e);
        this.warn?.(error);
        this.set({ state: 'error', rows: this.last.rows, updatedAt: this.last.updatedAt, error });
      }
    }
    return this.last;
  }

  private set(snap: AgyQuotaSnapshot): void {
    this.last = snap;
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* подписчик отвечает за свои ошибки */
      }
    }
  }
}
