/**
 * Фикстура живого прогона `scripts/agents-smoke.mjs --record agents-parallel` (этап 2 roadmap 0.2):
 * один ход — фоновый `Bash sleep 20`, два `Explore` на переднем плане параллельно и фоновый
 * `general-purpose`, затем два хода-пробуждения. Файлы — `test/fixtures/claude/agents-parallel.*`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../../types';
import { replayProbeLog } from '../replay';
import type { HistoryMessage } from '../history';

export const AGENTS_FIXTURE_DIR = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'claude');

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(join(AGENTS_FIXTURE_DIR, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Сырые сообщения SDK и строки `probe/send` — через тот же маппер, что у живой сессии. */
export async function agentsParallelEvents(): Promise<AgentEvent[]> {
  return (await replayProbeLog(lines('agents-parallel.sdk.ndjson'))).events;
}

/** `getSessionMessages()` той же сессии. */
export function agentsParallelMessages(): HistoryMessage[] {
  return JSON.parse(
    readFileSync(join(AGENTS_FIXTURE_DIR, 'agents-parallel.messages.json'), 'utf8'),
  ) as HistoryMessage[];
}

/** Файл транскрипта основной сессии и каталог транскриптов субагентов. */
export const AGENTS_TRANSCRIPT = join(AGENTS_FIXTURE_DIR, 'agents-parallel.transcript.ndjson');
export const AGENTS_SUBAGENTS_DIR = join(AGENTS_FIXTURE_DIR, 'agents-parallel.subagents');
