import { isCodexAuthError, readCodexLimits, type CodexLimitWindow, type ReadCodexLimits } from '../agent/codex/limits';

export type CodexLimitsState = 'loading' | 'ok' | 'signedOut' | 'missing' | 'error';

export interface CodexLimitsSnapshot {
  state: CodexLimitsState;
  email?: string;
  plan?: string;
  windows: CodexLimitWindow[];
  /** Когда данные получены (мс); 0 — ещё не получали. */
  updatedAt: number;
  error?: string;
}

/** Не чаще раза в минуту: каждый запрос — короткий процесс app-server, а лимиты меняются медленно. */
export const CODEX_LIMITS_COOLDOWN_MS = 60_000;

/**
 * Лимиты Codex (roadmap 18): кэш последнего `account/rateLimits/read`, кулдаун между запусками (в том числе
 * неудачными), склейка параллельных запросов. Нет `codex` — `missing` (процесс не запускается); не вошли —
 * `signedOut`; прочая ошибка — `error` с текстом, прежние окна сохраняются.
 */
export class CodexLimitsService {
  private last: CodexLimitsSnapshot = { state: 'loading', windows: [], updatedAt: 0 };
  private lastAttempt = 0;
  private inflight: Promise<CodexLimitsSnapshot> | undefined;
  private readonly listeners = new Set<(snap: CodexLimitsSnapshot) => void>();

  constructor(
    private readonly executable: () => Promise<string | undefined>,
    private readonly run: ReadCodexLimits = (path) => readCodexLimits(path),
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = CODEX_LIMITS_COOLDOWN_MS,
  ) {}

  onUpdate(listener: (snap: CodexLimitsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get snapshot(): CodexLimitsSnapshot {
    return this.last;
  }

  refresh(): Promise<CodexLimitsSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.lastAttempt && this.now() - this.lastAttempt < this.cooldownMs) return Promise.resolve(this.last);
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<CodexLimitsSnapshot> {
    let path: string | undefined;
    try {
      path = await this.executable();
    } catch {
      path = undefined;
    }
    if (!path) {
      // не ставили — дёшево проверить снова, кулдаун не взводим
      this.set({ state: 'missing', windows: [], updatedAt: this.now() });
      return this.last;
    }
    this.lastAttempt = this.now();
    try {
      const res = await this.run(path);
      this.set(
        res.signedIn
          ? {
              state: 'ok',
              ...(res.email ? { email: res.email } : {}),
              ...(res.plan ? { plan: res.plan } : {}),
              windows: res.windows,
              updatedAt: this.now(),
            }
          : { state: 'signedOut', windows: [], updatedAt: this.now() },
      );
    } catch (e) {
      const { email, plan, windows, updatedAt } = this.last;
      const base = { windows, updatedAt, ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
      if (isCodexAuthError(e)) this.set({ state: 'signedOut', windows: [], updatedAt: this.now() });
      else this.set({ ...base, state: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    return this.last;
  }

  private set(snap: CodexLimitsSnapshot): void {
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
