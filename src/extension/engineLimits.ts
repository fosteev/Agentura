import type { EngineLimitsSummary } from '../protocol';
import type { AgyQuotaSnapshot } from './agyQuota';
import type { CodexLimitsSnapshot } from './codexLimits';

/** Снимок `CodexLimitsService` → сводка для боковой панели. */
export function summarizeCodex(snap: CodexLimitsSnapshot, version?: string): EngineLimitsSummary {
  return {
    engine: 'codex',
    state: snap.state,
    ...(snap.email ? { email: snap.email } : {}),
    ...(snap.plan ? { plan: snap.plan } : {}),
    ...(version ? { version } : {}),
    windows: snap.windows.map((w) => ({
      kind: w.kind,
      ...(w.name ? { name: w.name } : {}),
      percent: w.percent,
      ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
    })),
    updatedAt: snap.updatedAt,
    ...(snap.error ? { error: snap.error } : {}),
  };
}

/**
 * Квота agy → сводка. Остаток превращаем в «израсходовано» (`100 − remaining`). Нет исполняемого файла — `missing`;
 * состояние и текст ошибки идут из `AgyQuotaService`, при `error` прежние окна сохраняются. Email у `/usage` нет.
 */
export function summarizeAgy(snap: AgyQuotaSnapshot, installed: boolean, version?: string): EngineLimitsSummary {
  const state = !installed ? 'missing' : snap.state;
  const showWindows = state === 'ok' || state === 'error';
  return {
    engine: 'antigravity',
    state,
    ...(version ? { version } : {}),
    windows: showWindows
      ? snap.rows.map((r) => ({
          kind: 'model' as const,
          name: r.label,
          percent: Math.max(0, Math.min(100, 100 - r.remaining)),
          ...(r.resetsAt !== undefined ? { resetsAt: r.resetsAt } : {}),
        }))
      : [],
    updatedAt: snap.updatedAt,
    ...(state === 'error' && snap.error ? { error: snap.error } : {}),
  };
}
