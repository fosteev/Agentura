import type { AgentEvent, SessionHistory } from '../types';
import { KimiMapper } from './mapper';
import { chunkText, currentModeId, parseConfig, permissionModeOf, sessionUpdateKind } from './protocol';

const MAX_TURNS = 200;

export interface KimiHistoryOptions {
  live?: boolean;
  maxTurns?: number;
  now?: () => number;
  allowBypass?: boolean;
}

interface Turn {
  prompt: string;
  updates: unknown[];
}

/** `session/load` реплеит консолидированные main user/message/tool кадры; synthetic turn prefix не используется. */
export function buildKimiHistory(
  updates: readonly unknown[],
  result: unknown,
  options: KimiHistoryOptions = {},
): SessionHistory {
  const all = turnsOf(updates);
  const max = Math.max(0, options.maxTurns ?? MAX_TURNS);
  const skippedTurns = Math.max(0, all.length - max);
  const shown = max === 0 ? [] : skippedTurns ? all.slice(-max) : all;
  const mapper = new KimiMapper();
  const now = options.now ?? Date.now;
  const events: AgentEvent[] = [];
  shown.forEach((turn, index) => {
    const at = now();
    events.push(...mapper.startTurn(turn.prompt, at));
    for (const update of turn.updates) events.push(...mapper.applyUpdate(update, at));
    if (options.live && index === shown.length - 1) return;
    events.push(...mapper.finish({ stopReason: 'end_turn' }, at, at));
  });
  const config = parseConfig(result);
  const model = config.model?.current;
  const modeId = currentModeId(result) ?? config.mode?.current;
  return {
    events,
    turns: all.length,
    skippedTurns,
    ...(model ? { model } : {}),
    ...(modeId ? { mode: permissionModeOf(modeId, options.allowBypass === true) } : {}),
  };
}

function turnsOf(updates: readonly unknown[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const update of updates) {
    if (sessionUpdateKind(update) === 'user_message_chunk') {
      current = { prompt: chunkText(update), updates: [] };
      turns.push(current);
      continue;
    }
    current?.updates.push(update);
  }
  return turns;
}
