/**
 * История Antigravity ACP: кадры `session/load` → `SessionHistory`.
 */
import type { Lang } from '../../shared/l10n';
import type { AgentEvent, SessionHistory } from '../types';
import { AgyAcpMapper } from './acpMapper';
import { chunkText, sessionUpdateKind } from './acpProtocol';
export { withAgySubagentTimelines, type AgyTimelineOptions } from './subagents';

/** Сколько последних ходов отдавать, если вызывающий не задал `maxTurns`. */
const MAX_TURNS = 200;

export interface AgyHistoryOptions {
  /** Сессия идёт сейчас: последний ход без `turn.result`. */
  live?: boolean;
  maxTurns?: number;
  /** Подмена часов в тестах. */
  now?: () => number;
  /** Язык локализованных плашек (`api_retry`). */
  lang?: () => Lang;
  /** Известные MCP-серверы из `<dataDir>/mcp` для точного разреза `mcp_<server>_<tool>`. */
  mcpServers?: readonly string[];
}

interface Turn {
  prompt: string;
  updates: unknown[];
}

/**
 * `session/update` до result `session/load` → лента.
 * Граница хода — `user_message_chunk` (подряд идущие склеиваются). Текст и tool — `AgyAcpMapper`.
 * Преамбула до первого промпта (команды, `session_info_update`) в ленту не идёт.
 * У повтора нет `stopReason` на ход: закрытый ход — `end_turn`. `live` не закрывает последний.
 */
export function buildAgyHistory(
  updates: readonly unknown[],
  _result: unknown,
  options: AgyHistoryOptions = {},
): SessionHistory {
  const all = turnsOf(updates);
  const max = options.maxTurns ?? MAX_TURNS;
  const skipped = Math.max(0, all.length - max);
  const shown = skipped > 0 ? all.slice(all.length - max) : all;
  const mapper = new AgyAcpMapper({
    ...(options.lang ? { lang: options.lang } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
  });
  const now = options.now ?? Date.now;
  const events: AgentEvent[] = [];
  shown.forEach((turn, index) => {
    const at = now();
    events.push(...mapper.startTurn(turn.prompt, at));
    for (const update of turn.updates) events.push(...mapper.applyUpdate(update, at));
    const last = index === shown.length - 1;
    if (options.live && last) return;
    events.push(...mapper.finish({ stopReason: 'end_turn' }, at, at));
  });
  const history: SessionHistory = { events, turns: all.length, skippedTurns: skipped };
  // session/load returns fresh process defaults, not the saved conversation settings.
  return history;
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
