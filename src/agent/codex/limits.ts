import { homedir } from 'node:os';
import { CodexRpcError } from './client';
import { queryAppServer, type CodexAdapterConfig } from './adapter';
import type { CodexAccountResponse, CodexRateLimitSnapshot, CodexRateLimitWindow, CodexRateLimitsResponse } from './protocol';

/** Окно лимита Codex в нашем виде: израсходовано 0…100, сброс — мс. */
export interface CodexLimitWindow {
  kind: 'fiveHour' | 'weekly' | 'model';
  /** У `model` — имя дополнительного лимита (`limitName ?? limitId` без префикса `codex_`). */
  name?: string;
  percent: number;
  resetsAt?: number;
}

export interface CodexLimits {
  /** `account: null` — не вошли. */
  signedIn: boolean;
  email?: string;
  /** `plus` → `Plus`. */
  plan?: string;
  windows: CodexLimitWindow[];
}

const FIVE_HOURS_MIN = 300;
const WEEK_MIN = 10_080;

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function clampPercent(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function windowOf(w: CodexRateLimitWindow, kind: CodexLimitWindow['kind'], name?: string): CodexLimitWindow {
  const out: CodexLimitWindow = { kind, percent: clampPercent(w.usedPercent) };
  if (name) out.name = name;
  if (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)) out.resetsAt = w.resetsAt * 1000;
  return out;
}

function durationLabel(mins: number | null | undefined): string {
  if (!mins) return '';
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
  if (mins >= 60) return `${Math.round(mins / 60)}h`;
  return `${mins}m`;
}

/** Основное окно по длительности: 300 мин → 5 ч, 10080 → неделя; нет длительности — по месту (primary/secondary). */
function classify(w: CodexRateLimitWindow, fallback: 'fiveHour' | 'weekly'): CodexLimitWindow {
  const mins = w.windowDurationMins;
  if (mins === FIVE_HOURS_MIN) return windowOf(w, 'fiveHour');
  if (mins === WEEK_MIN) return windowOf(w, 'weekly');
  return windowOf(w, fallback);
}

function extraName(key: string, snap: CodexRateLimitSnapshot): string {
  return (snap.limitName ?? snap.limitId ?? key).replace(/^codex_/, '');
}

/**
 * `account/rateLimits/read` + `account/read` → `CodexLimits`. `primary` (300 мин) — 5 ч, `secondary` (10080) — неделя,
 * доп. лимиты из `rateLimitsByLimitId` (кроме ключа `codex`) — окна `model`. Без процесса, чтобы тестировать на фикстуре.
 */
export function parseCodexLimits(rate: CodexRateLimitsResponse | undefined, account: CodexAccountResponse | undefined): CodexLimits {
  const acc = account?.account ?? null;
  const windows: CodexLimitWindow[] = [];
  const main = rate?.rateLimits;
  if (main?.primary) windows.push(classify(main.primary, 'fiveHour'));
  if (main?.secondary) windows.push(classify(main.secondary, 'weekly'));
  for (const [key, snap] of Object.entries(rate?.rateLimitsByLimitId ?? {})) {
    if (key === 'codex' || !snap) continue;
    const name = extraName(key, snap);
    const present = [snap.primary, snap.secondary].filter((w): w is CodexRateLimitWindow => !!w);
    for (const [i, w] of present.entries()) {
      const suffix = present.length > 1 && i > 0 ? durationLabel(w.windowDurationMins) : '';
      windows.push(windowOf(w, 'model', suffix ? `${name} ${suffix}` : name));
    }
  }
  const plan = acc?.planType ?? main?.planType ?? undefined;
  return {
    signedIn: acc !== null,
    ...(acc?.email ? { email: acc.email } : {}),
    ...(plan ? { plan: capitalize(plan) } : {}),
    windows,
  };
}

/** Ошибка авторизации RPC: «не вошли», а не поломка. */
export function isCodexAuthError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError) && !(error instanceof Error)) return false;
  return /auth|login|log in|sign in|401|unauthori[sz]ed/i.test(error.message);
}

export type ReadCodexLimits = (executable: string) => Promise<CodexLimits>;

const LIMITS_TIMEOUT_MS = 15_000;

/**
 * Короткий `codex app-server --listen stdio://`: оба запроса параллельно, cwd — домашняя папка (проект не нужен).
 * Ошибка авторизации у `rateLimits` при живом `account/read` — «не вошли» (`signedIn: false`).
 */
export async function readCodexLimits(
  executable: string,
  config: Pick<CodexAdapterConfig, 'spawn' | 'env' | 'log' | 'trace' | 'graceMs' | 'clientVersion'> & { timeoutMs?: number } = {},
): Promise<CodexLimits> {
  return queryAppServer(executable, homedir(), { timeoutMs: LIMITS_TIMEOUT_MS, ...config }, async (rpc) => {
    const [account, rate] = await Promise.allSettled([
      rpc('account/read', { refreshToken: false }),
      rpc('account/rateLimits/read', undefined),
    ]);
    if (account.status === 'fulfilled' && account.value.account === null) return parseCodexLimits(undefined, account.value);
    if (rate.status === 'rejected') {
      if (isCodexAuthError(rate.reason)) return { signedIn: false, windows: [] };
      throw rate.reason;
    }
    return parseCodexLimits(rate.value, account.status === 'fulfilled' ? account.value : undefined);
  });
}
