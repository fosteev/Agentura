/**
 * Лимиты нескольких движков в боковой панели (roadmap 18): единая модель для Claude (прежние `limits.update` +
 * `account.info`) и Codex/Antigravity (`engines.limits`). Чистая логика без Preact.
 */
import type { AgentProvider } from '../agent/types';
import type { AccountSummary, EngineLimitsSummary, LimitWindowSummary } from '../protocol';
import { resetLabel } from './hudView';
import { limitRows } from './sessionsView';
import { ui } from './strings';

export type EngineId = AgentProvider;
export type EngineViewState = 'ok' | 'signedOut' | 'error' | 'loading';

export interface EngineWindowView {
  label: string;
  /** Короткая подпись для таблицы: `5 ч`, `нед`, имя модели. */
  short: string;
  percent: number;
  /** Сброс коротко (`17:00`, `сб 09:00`); нет — неизвестен. */
  reset?: string;
  /** Подсказка: подпись окна и когда сброс. */
  note: string;
}

export interface EngineView {
  engine: EngineId;
  state: EngineViewState;
  email?: string;
  plan?: string;
  version?: string;
  error?: string;
  windows: EngineWindowView[];
}

export const ENGINE_ORDER: readonly EngineId[] = ['claude', 'codex', 'antigravity'];
export const ENGINE_MARK: Record<EngineId, string> = { claude: 'C', codex: 'X', antigravity: 'G' };
export const ENGINE_MARK_CLASS: Record<EngineId, string> = {
  claude: 'claude',
  codex: 'codex',
  antigravity: 'agy',
};

export const engineName = (e: EngineId): string => ui.sidebar.providerNames[e];

function claudeView(
  windows: readonly LimitWindowSummary[],
  account: AccountSummary | undefined,
  now: number,
): EngineView {
  const wins = limitRows(windows, now).map((l): EngineWindowView => {
    const model = l.key.startsWith('weekly-model:') ? l.key.slice('weekly-model:'.length) : '';
    return {
      label: l.label,
      short: l.mini || model || l.label,
      percent: l.percent,
      ...(l.reset ? { reset: l.reset } : {}),
      note: [l.label, l.note].filter(Boolean).join(' · '),
    };
  });
  return {
    engine: 'claude',
    state: 'ok',
    ...(account?.email ? { email: account.email } : {}),
    ...(account?.plan ? { plan: account.plan } : {}),
    ...(account?.engine ? { version: `${ui.sidebar.agentName} ${account.engine}` } : {}),
    windows: wins,
  };
}

function hostView(e: EngineLimitsSummary, now: number): EngineView {
  const windows = e.windows.map((w): EngineWindowView => {
    const label =
      w.kind === 'fiveHour'
        ? ui.sidebar.limitFive
        : w.kind === 'weekly'
          ? ui.sidebar.limitWeek
          : (w.name ?? '?');
    const short =
      w.kind === 'fiveHour'
        ? ui.sidebar.miniFive
        : w.kind === 'weekly'
          ? ui.sidebar.miniWeek
          : (w.name ?? '?');
    const reset = w.resetsAt === undefined ? undefined : resetLabel(w.resetsAt, now);
    return {
      label,
      short,
      percent: Math.max(0, Math.min(100, Math.round(w.percent))),
      ...(reset ? { reset } : {}),
      note: reset ? `${label} · ${ui.sidebar.resetAt(reset)}` : label,
    };
  });
  return {
    engine: e.engine,
    state: e.state === 'missing' ? 'loading' : e.state,
    ...(e.email ? { email: e.email } : {}),
    ...(e.plan ? { plan: e.plan } : {}),
    ...(e.version ? { version: e.version } : {}),
    ...(e.error ? { error: e.error } : {}),
    windows,
  };
}

/**
 * Установленные движки по порядку Claude, Codex, Antigravity. Claude — всегда; остальные — по `engines.limits`
 * (`missing` не показывается). Один движок на выходе — боковая панель рисует прежнюю разметку.
 */
export function buildEngines(
  windows: readonly LimitWindowSummary[],
  account: AccountSummary | undefined,
  host: readonly EngineLimitsSummary[] | undefined,
  now: number,
): EngineView[] {
  const rest = (host ?? [])
    .filter((e) => e.state !== 'missing')
    .map((e) => hostView(e, now))
    .sort((a, b) => ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine));
  return [claudeView(windows, account, now), ...rest];
}

/** Худшее окно движка — с максимальным процентом. */
export function worstWindow(e: EngineView): EngineWindowView | undefined {
  return e.windows.reduce<EngineWindowView | undefined>(
    (a, w) => (!a || w.percent > a.percent ? w : a),
    undefined,
  );
}

/** Движок, который считается выбранным: ручной выбор живёт, пока не сменился движок вкладки. */
export function pickEngine(
  engines: readonly EngineView[],
  current: EngineId | undefined,
  manual: { engine: EngineId; base: EngineId | undefined } | undefined,
): EngineId {
  const has = (id: EngineId | undefined): id is EngineId =>
    !!id && engines.some((e) => e.engine === id);
  if (manual && manual.base === current && has(manual.engine)) return manual.engine;
  if (has(current)) return current;
  return engines[0]!.engine;
}
