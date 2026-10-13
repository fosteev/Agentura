/**
 * Вид MCP для кнопки у поля, всплывашки и вкладки панели (roadmap 21, этап 3): чистые функции над списком серверов
 * из `mcp.status`. Счётчики вызовов — из `mcpFeed.mcpUsage` по `rows`, со статусом сопоставляются через `serverByPrefix`.
 */
import type { McpServerInfo } from '../agent/types';
import type { FeedRow } from './chatState';
import { isBadServer, mcpUsage, serverByPrefix, type McpUsage } from './mcpFeed';

export interface McpCounts {
  /** Подключено. */
  n: number;
  /** Все, кроме выключенных. */
  m: number;
  /** Есть сбой (`failed` / `needs-auth`) — жёлтая точка и бейдж. */
  bad: number;
}

/** «N/M» кнопки (решение 9): N — `connected`, M — все, кроме `disabled`; `bad` — сколько в сбое. */
export function mcpCounts(servers: readonly McpServerInfo[]): McpCounts {
  return {
    n: servers.filter((s) => s.status === 'connected').length,
    m: servers.filter((s) => s.status !== 'disabled').length,
    bad: servers.filter(isBadServer).length,
  };
}

/**
 * Вызовы по серверам из статуса: ключ — `name` сервера (а не префикс инструмента). Вызов к серверу, которого нет в
 * списке, пропускается — его строки нет.
 */
export function usageByServer(
  servers: readonly McpServerInfo[],
  rows: readonly FeedRow[],
): Map<string, McpUsage> {
  const out = new Map<string, McpUsage>();
  for (const [prefix, u] of mcpUsage(rows)) {
    const s = serverByPrefix(servers, prefix);
    if (!s) continue;
    const cur = out.get(s.name);
    if (!cur) {
      out.set(s.name, { total: u.total, tools: new Map(u.tools) });
      continue;
    }
    // два префикса одного сервера (Codex с сырым и нормализованным именем) — складываем
    cur.total += u.total;
    for (const [t, c] of u.tools) cur.tools.set(t, (cur.tools.get(t) ?? 0) + c);
  }
  return out;
}

/** Метка источника сервера (`McpServerInfo.scope`): `claudeai` → `claude.ai`, остальное как есть; нет scope — нет метки. */
export function sourceLabel(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  return scope === 'claudeai' ? 'claude.ai' : scope;
}

/** Команда входа для сервера в `needs-auth`: Codex — `codex mcp login <имя>`, Claude — `/mcp` (в SDK авторизации нет). */
export function loginCommand(engine: string | undefined, name: string): string {
  return engine === 'codex' ? `codex mcp login ${name}` : '/mcp';
}

/**
 * Показывать ли кнопку у поля / вкладку панели: движок умеет MCP-статус (`features.mcp`), настройка включена и статус
 * уже пришёл. Пустой список серверов — прятать: «mcp 0/0» ничего не говорит (решение этапа 3).
 */
export function mcpSurfaceShown(
  mcpFeature: boolean,
  setting: boolean,
  servers: readonly McpServerInfo[] | undefined,
): boolean {
  return mcpFeature && setting && !!servers && servers.length > 0;
}
