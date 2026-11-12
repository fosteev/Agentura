import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentEventOf, TokenUsage } from '../types';
import { agyContextWindow } from './models';

export const DEFAULT_AGY_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAIL_BYTES = 64 * 1024;

export interface TranscriptContextUsage {
  stepIndex: number;
  usedTokens: number;
}

/**
 * Читает фактический расход контекста из последнего завершённого шага transcript.jsonl.
 * Читает с конца файла не более 64 КБ без блокировки и без записи в ФС.
 */
export async function readLastTranscriptUsage(
  sessionId: string,
  dataDir: string = DEFAULT_AGY_DATA_DIR,
): Promise<TranscriptContextUsage | undefined> {
  if (!UUID_RE.test(sessionId)) {
    return undefined;
  }

  const filePath = path.join(dataDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  let fh: fs.FileHandle | undefined;

  try {
    fh = await fs.open(filePath, 'r');
    const { size } = await fh.stat();
    if (size === 0) {
      return undefined;
    }

    const offset = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, offset);

    let text = buffer.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline === -1) {
        return undefined;
      }
      text = text.slice(firstNewline + 1);
    }

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        record &&
        typeof record === 'object' &&
        record.type === 'PLANNER_RESPONSE' &&
        record.status === 'DONE' &&
        typeof record.step_index === 'number' &&
        Number.isFinite(record.step_index)
      ) {
        const { input_tokens, cache_read_tokens, cache_write_tokens, output_tokens } = record;
        const isValid = (v: unknown): v is number =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0;

        if (
          !isValid(input_tokens) &&
          !isValid(cache_read_tokens) &&
          !isValid(cache_write_tokens) &&
          !isValid(output_tokens)
        ) {
          continue;
        }

        const input = isValid(input_tokens) ? input_tokens : 0;
        const cacheRead = isValid(cache_read_tokens) ? cache_read_tokens : 0;
        const cacheWrite = isValid(cache_write_tokens) ? cache_write_tokens : 0;
        const output = isValid(output_tokens) ? output_tokens : 0;

        return {
          stepIndex: record.step_index,
          usedTokens: input + cacheRead + cacheWrite + output,
        };
      }
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Фолбэк для одношагового хода из ACP TokenUsage.
 */
export function singleStepUsageTokens(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * Формирует событие context.usage для Antigravity.
 */
export function buildAgyContextUsage(
  usedTokens: number,
  model: string | undefined,
): AgentEventOf<'context.usage'> {
  const max = model ? agyContextWindow(model) : undefined;
  if (max !== undefined) {
    return {
      type: 'context.usage',
      usedTokens,
      maxTokens: max,
      percentage: Math.min(100, (usedTokens / max) * 100),
      source: 'usage',
    };
  }
  return {
    type: 'context.usage',
    usedTokens,
    maxTokens: 0,
    source: 'usage',
  };
}
