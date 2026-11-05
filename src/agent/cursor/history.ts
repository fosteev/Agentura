/**
 * История Cursor: кадры `session/load` → `SessionHistory`.
 * Список — `session/list {cwd}` → строки без title. Чистая функция, без процесса.
 */
import type { AgentEvent, SessionHistory, SessionInfo } from '../types';
import { CursorMapper } from './mapper';
import { chunkText, currentModeId, currentModelId, sessionUpdateKind } from './protocol';

/** Сколько последних ходов отдавать, если вызывающий не задал `maxTurns`. Как у Claude. */
const MAX_TURNS = 200;

export interface CursorHistoryOptions {
  /** Сессия идёт сейчас: последний ход без `turn.result`. */
  live?: boolean;
  maxTurns?: number;
  /** Подмена часов в тестах. */
  now?: () => number;
}

interface Turn {
  prompt: string;
  updates: unknown[];
}

/**
 * `session/update` до result `session/load` → лента.
 * Граница хода — `user_message_chunk` (подряд идущие склеиваются). Текст и tool — `CursorMapper`.
 * Преамбула до первого промпта (команды, `session_info_update`) в ленту не идёт.
 * У повтора нет `stopReason` на ход: закрытый ход — `end_turn`. `live` не закрывает последний.
 */
export function buildCursorHistory(
  updates: readonly unknown[],
  result: unknown,
  options: CursorHistoryOptions = {},
): SessionHistory {
  const all = turnsOf(updates);
  const max = options.maxTurns ?? MAX_TURNS;
  const skipped = Math.max(0, all.length - max);
  const shown = skipped > 0 ? all.slice(all.length - max) : all;
  const mapper = new CursorMapper();
  const now = options.now ?? Date.now;
  const events: AgentEvent[] = [];
  shown.forEach((turn, index) => {
    const at = now();
    events.push(...mapper.startTurn(turn.prompt, at));
    for (const update of turn.updates) events.push(...mapper.applyUpdate(update));
    const last = index === shown.length - 1;
    if (options.live && last) return;
    events.push(...mapper.finish({ stopReason: 'end_turn' }, at, at));
  });
  const history: SessionHistory = { events, turns: all.length, skippedTurns: skipped };
  const model = currentModelId(result);
  if (model) history.model = model;
  if (currentModeId(result) === 'plan') history.mode = 'plan';
  return history;
}

/**
 * Ответ `session/list`. В выдаче только тот же `cwd` (как эхо спайка, без realpath).
 * Title в кадре нет: заголовок строки — `sessionId`. `updatedAt` — ISO в мс; не разобрать — 0.
 */
export function sessionsFrom(result: unknown, dir: string): SessionInfo[] {
  const list = record(result)?.sessions;
  if (!Array.isArray(list)) return [];
  const out: SessionInfo[] = [];
  for (const item of list) {
    const row = record(item);
    const id = row?.sessionId;
    if (typeof id !== 'string' || !id || row?.cwd !== dir) continue;
    out.push({
      id,
      title: id,
      cwd: dir,
      updatedAt: isoMs(row?.updatedAt),
      provider: 'cursor',
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function turnsOf(updates: readonly unknown[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let promptOpen = false;
  for (const update of updates) {
    if (sessionUpdateKind(update) === 'user_message_chunk') {
      const text = chunkText(update);
      if (!current || !promptOpen) {
        current = { prompt: text, updates: [] };
        turns.push(current);
        promptOpen = true;
      } else current.prompt += text;
      continue;
    }
    if (!current) continue;
    promptOpen = false;
    current.updates.push(update);
  }
  return turns;
}

function isoMs(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
