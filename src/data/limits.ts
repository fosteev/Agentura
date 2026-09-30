import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LimitWindow } from '../agent/types';
import { readToken } from './agentmeter/desktop/token.ts';
import {
  OAUTH_BETA_HEADER,
  OAUTH_USAGE_URL,
  parseOauthUsage,
  throttleFrom,
  throttled,
  type Throttle,
} from './agentmeter/limits/oauth.ts';
import type { UsageSnapshot } from './agentmeter/limits/usage.ts';

/**
 * Лимиты подписки: `GET /api/oauth/usage` с токеном Claude Code (разбор ответа и чтение токена —
 * vendored Agentmeter) и запасной источник — последний `rate_limit_event` движка
 * (`limit.update` адаптера). Подставляется в `UsageService` как `UsageFetcher`; частоту опроса
 * задаёт `startLimitsPolling` по настройке `agentura.usagePollMinutes`, ручное ↻ ограничено
 * кулдауном `UsageService`.
 */

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface LimitsSourceOptions {
  claudeHome?: string;
  platform?: NodeJS.Platform;
  fetch?: HttpFetch;
  /** Чтение Keychain; по умолчанию — `security` асинхронно, чтобы не блокировать extension host. */
  keychain?: () => Promise<string | undefined>;
  /**
   * Можно ли читать Keychain (настройка `agentura.limits.readKeychain`). Функция — значение
   * перечитывается на каждом запросе, смена настройки действует без перезапуска.
   */
  readKeychain?: () => boolean;
  now?: () => number;
  userAgent?: string;
}

/** Что отдаёт источник: окна и когда эти данные получены (у окон движка — время события). */
export interface LimitsReading {
  windows: LimitWindow[];
  updatedAt: number;
  source: 'oauth' | 'engine';
}

/** Снимок OAuth → окна: 5 ч, неделя и недельные окна по модели (`weekly_scoped`). */
export function windowsFromSnapshot(snapshot: UsageSnapshot): LimitWindow[] {
  const windows: LimitWindow[] = [];
  if (snapshot.fiveHour) {
    windows.push({
      kind: 'five-hour',
      percent: snapshot.fiveHour.pct,
      resetsAt: snapshot.fiveHour.resetsAt,
    });
  }
  if (snapshot.weekly) {
    windows.push({
      kind: 'weekly',
      percent: snapshot.weekly.pct,
      resetsAt: snapshot.weekly.resetsAt,
    });
  }
  for (const m of snapshot.models ?? []) {
    windows.push({ kind: 'weekly-model', model: m.model, percent: m.pct, resetsAt: m.resetsAt });
  }
  return windows;
}

/**
 * Окна без границы (`resets_at: null`): Agentmeter их отбрасывает (для его калибровки окно без
 * интервала бесполезно), а интерфейсу нужна строка «0 %» — неактивное 5-часовое окно тоже окно.
 * Разбираем сами, vendored код не трогаем.
 */
function inactiveWindows(raw: unknown, known: LimitWindow[]): LimitWindow[] {
  const limits = (raw as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(limits)) return [];
  const out: LimitWindow[] = [];
  for (const entry of limits) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const kind =
      e['kind'] === 'session' ? 'five-hour' : e['kind'] === 'weekly_all' ? 'weekly' : undefined;
    if (!kind || e['resets_at'] != null) continue;
    if (known.some((w) => w.kind === kind) || out.some((w) => w.kind === kind)) continue;
    const pct =
      typeof e['percent'] === 'number' && Number.isFinite(e['percent']) ? e['percent'] : 0;
    out.push({ kind, percent: pct });
  }
  return out;
}

export class LimitsSource {
  private throttle: Throttle | undefined;
  private engine: { windows: LimitWindow[]; at: number } | undefined;
  /** Когда OAuth последний раз отдал окна. */
  private lastGoodAt: number | undefined;
  private readonly now: () => number;

  constructor(private readonly options: LimitsSourceOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Окна из `rate_limit_event` (событие `limit.update` адаптера) — запас на случай отказа OAuth. */
  observeEngine(windows: LimitWindow[], at = this.now()): void {
    if (windows.length > 0) this.engine = { windows, at };
  }

  /**
   * `UsageFetcher`: OAuth; при ошибке — окна движка, но только если они новее последних удачных
   * данных OAuth и со своим временем. Иначе ошибка — `UsageService` оставит прежний снимок.
   */
  readonly fetch = async (): Promise<LimitsReading> => {
    try {
      const windows = await this.fetchOauth();
      const at = this.now();
      this.lastGoodAt = at;
      return { windows, updatedAt: at, source: 'oauth' };
    } catch (error) {
      const engine = this.engine;
      if (engine && (this.lastGoodAt === undefined || engine.at > this.lastGoodAt)) {
        return { windows: engine.windows, updatedAt: engine.at, source: 'engine' };
      }
      throw error;
    }
  };

  async fetchOauth(): Promise<LimitWindow[]> {
    const now = this.now();
    if (throttled(this.throttle, now)) {
      throw new Error(
        `лимит запросов к /api/oauth/usage, повтор после ${timeOf(this.throttle?.retryAt ?? now)}`,
      );
    }
    const token = await this.token();

    const doFetch = this.options.fetch ?? (globalThis.fetch as unknown as HttpFetch);
    let response: Awaited<ReturnType<HttpFetch>>;
    try {
      response = await doFetch(OAUTH_USAGE_URL, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'anthropic-beta': OAUTH_BETA_HEADER,
          'user-agent': this.options.userAgent ?? 'Agentura',
        },
      });
    } catch {
      throw new Error('нет сети');
    }
    if (response.status === 401) {
      throw new Error('вход отклонён (HTTP 401) — войдите в claude заново');
    }
    if (response.status === 403) {
      // Не повод перелогиниваться: так отвечает Cloudflare на Node по отпечатку TLS (замер
      // Agentmeter 11.08, `apps/desktop/src/main/oauth.ts`), токен при этом рабочий.
      throw new Error('сервер отклонил запрос (HTTP 403)');
    }
    if (response.status === 429) {
      this.throttle = throttleFrom(response.headers.get('retry-after'), now);
      throw new Error(
        `лимит запросов к /api/oauth/usage, повтор после ${timeOf(this.throttle.retryAt)}`,
      );
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('ответ не JSON');
    }
    this.throttle = undefined;
    const snapshot = parseOauthUsage(body, now);
    const windows = snapshot ? windowsFromSnapshot(snapshot) : [];
    windows.push(...inactiveWindows(body, windows));
    // Пустой разбор — формат ответа поменялся или аккаунт без лимитов: не затираем прежние окна.
    if (windows.length === 0) throw new Error('в ответе /api/oauth/usage нет окон лимитов');
    return windows;
  }

  /** Токен: `.credentials.json` всегда, Keychain — если разрешено настройкой. Нет токена — ошибка с причиной. */
  private async token(): Promise<string> {
    const claudeHome = this.options.claudeHome ?? join(homedir(), '.claude');
    const platform = this.options.platform ?? process.platform;
    const fromFile = readToken({ claudeHome, platform, keychain: () => undefined });
    if (fromFile.token) return fromFile.token;
    if (this.options.readKeychain && !this.options.readKeychain()) {
      throw new Error(
        'нет ~/.claude/.credentials.json, а чтение токена из Keychain выключено — включите чтение токена (agentura.limits.readKeychain)',
      );
    }
    const raw = await (this.options.keychain ?? defaultKeychainAsync(platform))();
    const token = readToken({ claudeHome, platform, keychain: () => raw }).token;
    if (!token) throw new Error('нет токена Claude Code (войдите в claude)');
    return token;
  }
}

/** Как `defaultKeychain` Agentmeter, но через асинхронный `execFile`: extension host не ждёт `security`. */
function defaultKeychainAsync(platform: NodeJS.Platform): () => Promise<string | undefined> {
  if (platform !== 'darwin') return async () => undefined;
  return () =>
    new Promise((resolve) => {
      execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 10_000 },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
}

function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const MIN_POLL_MINUTES = 5;

/**
 * Автоматический опрос лимитов: сразу и потом раз в `minutes()` минут (не чаще 5).
 * Интервал перечитывается перед каждым запуском — смена настройки действует со следующего раза.
 */
export function startLimitsPolling(
  refresh: () => Promise<void>,
  minutes: () => number,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
    setTimeout,
    clearTimeout,
  },
): { dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const tick = async () => {
    try {
      await refresh();
    } finally {
      if (!disposed) {
        const m = Math.max(MIN_POLL_MINUTES, Number.isFinite(minutes()) ? minutes() : 15);
        timer = timers.setTimeout(() => void tick(), m * 60_000);
      }
    }
  };
  void tick();
  return {
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
    },
  };
}
