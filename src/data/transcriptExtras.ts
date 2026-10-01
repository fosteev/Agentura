import { existsSync } from 'node:fs';
import type { PermissionMode } from '../agent/types';
import { modeFromTranscript } from '../agent/claude/history';
import { readJsonlLines } from './agentmeter/sources/jsonl.ts';

/**
 * То, чего нет в `getSessionMessages()`, но есть в транскрипте (этап 6): структурные результаты
 * инструментов (`toolUseResult` — патч правки, счётчики Grep/Glob) и режим разрешений на конец
 * сессии (`permissionMode` у записей пользователя). Формат транскрипта «внутренний, меняется между
 * версиями» — разбор терпимый: чего нет, того нет, история от этого не падает.
 */
export interface TranscriptExtras {
  toolResults: Map<string, unknown>;
  mode?: PermissionMode;
  /** Последний `totalCostUSD` записи `cost-state` — точный `total_cost_usd` движка (с побочными вызовами). */
  totalCostUsd?: number;
}

/** Результат, нужный ленте: правка (диф) или счётчик поиска. Остальное (Bash, Read…) не храним. */
function interesting(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;
  return (
    'structuredPatch' in r ||
    'originalFile' in r ||
    typeof r['numFiles'] === 'number' ||
    Array.isArray(r['filenames'])
  );
}

export function readTranscriptExtras(path: string): TranscriptExtras {
  const out: TranscriptExtras = { toolResults: new Map() };
  if (!existsSync(path)) return out;
  for (const line of readJsonlLines(path, true).lines) {
    const hasResult = line.includes('"toolUseResult"');
    const hasMode = line.includes('"permissionMode"');
    const hasCost = line.includes('"cost-state"');
    if (!hasResult && !hasMode && !hasCost) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (hasCost && rec['type'] === 'cost-state') {
      const total = rec['totalCostUSD'];
      if (typeof total === 'number' && Number.isFinite(total)) out.totalCostUsd = total;
      continue;
    }
    if (rec['type'] !== 'user' || rec['isSidechain'] === true) continue;
    if (hasMode) {
      const mode = modeFromTranscript(rec['permissionMode']);
      if (mode) out.mode = mode;
    }
    if (!hasResult || !interesting(rec['toolUseResult'])) continue;
    const content = (rec['message'] as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const blocks = content.filter(
      (b): b is { type: string; tool_use_id?: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result',
    );
    // результат записи однозначен, только если в ней один `tool_result` (как в маппере живых событий)
    const id = blocks.length === 1 ? blocks[0]!.tool_use_id : undefined;
    if (id) out.toolResults.set(id, rec['toolUseResult']);
  }
  return out;
}
