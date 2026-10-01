import type { PermissionMode } from '../agent/types';
import { modeFromTranscript } from '../agent/claude/history';
import { isJsonLine, streamLines } from './jsonlStream';

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
  /**
   * `uuid` ответов-ошибок API (`isApiErrorMessage: true`) основной ветки — ход закончился ошибкой. Есть, если
   * транскрипт прочитан (пустой набор — ошибок нет); нет файла — нет и набора.
   */
  apiErrors?: Set<string>;
}

/**
 * Результат, нужный ленте: правка (диф), счётчик поиска, итог субагента (`agentId`, токены, время —
 * карта агентов) или id фоновой задачи `Bash` (`backgroundTaskId`). Остальное (Read…) не храним.
 */
function interesting(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;
  return (
    'structuredPatch' in r ||
    'originalFile' in r ||
    typeof r['numFiles'] === 'number' ||
    Array.isArray(r['filenames']) ||
    typeof r['agentId'] === 'string' ||
    typeof r['backgroundTaskId'] === 'string'
  );
}

/**
 * Читает транскрипт потоком (этап 5 roadmap 0.2): кусками по 1 МБ с `await` между ними — 50 МБ с base64
 * картинок и pdf не грузятся в память строкой и не держат поток хоста при resume и пересеве. Нет файла — пусто.
 */
export async function readTranscriptExtras(path: string): Promise<TranscriptExtras> {
  const out: TranscriptExtras = { toolResults: new Map() };
  const apiErrors = new Set<string>();
  try {
    await streamLines(path, (line) => consume(out, apiErrors, line), { acceptTail: isJsonLine });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw e;
  }
  return { ...out, apiErrors };
}

function consume(out: TranscriptExtras, apiErrors: Set<string>, line: string): void {
  const hasResult = line.includes('"toolUseResult"');
  const hasMode = line.includes('"permissionMode"');
  const hasCost = line.includes('"cost-state"');
  const hasError = line.includes('"isApiErrorMessage":true');
  if (!hasResult && !hasMode && !hasCost && !hasError) return;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof rec !== 'object' || rec === null) return;
  if (hasCost && rec['type'] === 'cost-state') {
    const total = rec['totalCostUSD'];
    if (typeof total === 'number' && Number.isFinite(total)) out.totalCostUsd = total;
    return;
  }
  if (hasError && rec['type'] === 'assistant' && rec['isApiErrorMessage'] === true) {
    if (rec['isSidechain'] !== true && typeof rec['uuid'] === 'string') {
      apiErrors.add(rec['uuid']);
    }
    return;
  }
  if (rec['type'] !== 'user' || rec['isSidechain'] === true) return;
  if (hasMode) {
    const mode = modeFromTranscript(rec['permissionMode']);
    if (mode) out.mode = mode;
  }
  if (!hasResult || !interesting(rec['toolUseResult'])) return;
  const content = (rec['message'] as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return;
  const blocks = content.filter(
    (b): b is { type: string; tool_use_id?: string } =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result',
  );
  // результат записи однозначен, только если в ней один `tool_result` (как в маппере живых событий)
  const id = blocks.length === 1 ? blocks[0]!.tool_use_id : undefined;
  if (id) out.toolResults.set(id, rec['toolUseResult']);
}
