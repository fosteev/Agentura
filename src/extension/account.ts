import type { AccountInfo } from '../agent/types';
import type { AccountSummary } from '../protocol';

export interface PlanInfo {
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** `Max 5×` / `Pro` — из `subscriptionType` и множителя в `rateLimitTier` (`default_claude_max_5x`). */
export function planLabel(plan: PlanInfo): string | undefined {
  // `accountInfo()` отдаёт «Claude Max», учётные данные — «max»: берём одно слово плана
  const type = plan.subscriptionType?.trim().replace(/^claude\s+/i, '');
  if (!type) return undefined;
  const name = type.charAt(0).toUpperCase() + type.slice(1);
  if (/\d/.test(name)) return name; // множитель уже в названии
  const mult = /(\d+)x\b/i.exec(plan.rateLimitTier ?? '');
  return mult ? `${name} ${mult[1]}×` : name;
}

/** Строка «Вход»: откуда движок взял авторизацию. */
export function loginLabel(info: AccountInfo): string {
  const source = info.tokenSource;
  if (!source || source === 'none') return 'через CLI · ок';
  if (/api.?key/i.test(source)) return 'ключ API';
  return `${source} · ок`;
}

export interface AccountDeps {
  accountInfo(): Promise<AccountInfo>;
  readPlan(): Promise<PlanInfo>;
  /** Версия движка, известная с прошлого запуска (`workspaceState`). */
  savedEngine?: string;
  now?: () => number;
  ttlMs?: number;
}

export const ACCOUNT_TTL_MS = 10 * 60_000;

/**
 * Секция «Аккаунт» боковой панели: `accountInfo()` (временный процесс CLI — не чаще раза в 10 минут),
 * план из учётных данных и версия движка из `session.init` ближайшей сессии.
 */
export class AccountService {
  private cached: { at: number; value: AccountSummary } | undefined;
  private inflight: Promise<AccountSummary> | undefined;
  private engine: string | undefined;
  private readonly listeners = new Set<(a: AccountSummary) => void>();

  constructor(private readonly deps: AccountDeps) {
    this.engine = deps.savedEngine;
  }

  onUpdate(l: (a: AccountSummary) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Версия движка из `session.init.claude_code_version`. */
  noteEngine(version: string): void {
    const label = `claude ${version}`;
    if (this.engine === label) return;
    this.engine = label;
    if (this.cached) this.emit({ ...this.cached.value, engine: label });
  }

  get(force = false): Promise<AccountSummary> {
    const now = (this.deps.now ?? Date.now)();
    if (!force && this.cached && now - this.cached.at < (this.deps.ttlMs ?? ACCOUNT_TTL_MS)) {
      return Promise.resolve({
        ...this.cached.value,
        ...(this.engine ? { engine: this.engine } : {}),
      });
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async (): Promise<AccountSummary> => {
      const [info, plan] = await Promise.allSettled([
        this.deps.accountInfo(),
        this.deps.readPlan(),
      ]);
      const out: AccountSummary = {};
      if (info.status === 'fulfilled') {
        if (info.value.email) out.email = info.value.email;
        out.login = loginLabel(info.value);
        const fromPlan = plan.status === 'fulfilled' ? plan.value : {};
        const label = planLabel({
          ...fromPlan,
          ...(info.value.subscriptionType ? { subscriptionType: info.value.subscriptionType } : {}),
        });
        if (label) out.plan = label;
      } else {
        out.error = info.reason instanceof Error ? info.reason.message : String(info.reason);
        const label = plan.status === 'fulfilled' ? planLabel(plan.value) : undefined;
        if (label) out.plan = label;
      }
      if (this.engine) out.engine = this.engine;
      // ошибка не затирает прежние данные и не кэшируется надолго
      this.cached = {
        at: info.status === 'fulfilled' ? (this.deps.now ?? Date.now)() : 0,
        value: out,
      };
      this.emit(out);
      return out;
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private emit(a: AccountSummary): void {
    for (const l of this.listeners) {
      try {
        l(a);
      } catch {
        /* подписчик отвечает за свои ошибки */
      }
    }
  }
}
