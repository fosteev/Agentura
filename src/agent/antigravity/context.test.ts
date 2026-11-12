import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenUsage } from '../types';
import {
  buildAgyContextUsage,
  readLastTranscriptUsage,
  singleStepUsageTokens,
} from './context';

describe('antigravity context', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agentura-agy-context-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writeTranscript(sessionId: string, lines: string[] | string): Promise<string> {
    const dir = path.join(tempDir, 'brain', sessionId, '.system_generated', 'logs');
    await mkdir(dir, { recursive: true });
    const content = Array.isArray(lines) ? lines.join('\n') + '\n' : lines;
    const filePath = path.join(dir, 'transcript.jsonl');
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  describe('readLastTranscriptUsage', () => {
    it('читает последний завершённый PLANNER_RESPONSE в многошаговом транскрипте', async () => {
      const sessionId = '11111111-2222-3333-4444-555555555555';
      const lines = [
        JSON.stringify({ type: 'USER_INPUT', content: 'hello' }),
        // status !== 'DONE' — игнорируется
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          status: 'RUNNING',
          step_index: 0,
          input_tokens: 100,
        }),
        // Завершённый шаг 1 без cache_write_tokens
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          step_index: 1,
          input_tokens: 1000,
          cache_read_tokens: 500,
          output_tokens: 200,
        }),
        // Другой тип события — игнорируется
        JSON.stringify({ type: 'MODEL', step_index: 1 }),
        // Завершённый шаг 2 с cache_write_tokens
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          step_index: 2,
          input_tokens: 2000,
          cache_read_tokens: 1000,
          cache_write_tokens: 300,
          output_tokens: 400,
        }),
      ];

      await writeTranscript(sessionId, lines);
      const usage = await readLastTranscriptUsage(sessionId, tempDir);

      expect(usage).toEqual({
        stepIndex: 2,
        usedTokens: 2000 + 1000 + 300 + 400,
      });
    });

    it('корректно обрабатывает файл более 64 КБ с пропуском оборванной первой строки чанка', async () => {
      const sessionId = '22222222-3333-4444-5555-666666666666';

      // Генерируем объемный мусор более 70 КБ
      const paddingLine = JSON.stringify({ type: 'OTHER', data: 'x'.repeat(200) });
      const paddingLines: string[] = [];
      for (let i = 0; i < 400; i++) {
        paddingLines.push(paddingLine);
      }

      const targetLine = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        step_index: 42,
        input_tokens: 5000,
        cache_read_tokens: 2000,
        output_tokens: 500,
      });

      paddingLines.push(targetLine);
      await writeTranscript(sessionId, paddingLines);

      const usage = await readLastTranscriptUsage(sessionId, tempDir);
      expect(usage).toEqual({
        stepIndex: 42,
        usedTokens: 7500,
      });
    });

    it('пропускает оборванную/битую последнюю JSON-строку и возвращает предыдущий шаг', async () => {
      const sessionId = '33333333-4444-5555-6666-777777777777';
      const validStep = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        step_index: 5,
        input_tokens: 800,
        output_tokens: 200,
      });
      // Оборванная строка в процессе записи без завершающих скобок
      const brokenLine = '{"type":"PLANNER_RESPONSE","status":"DONE","step_index":6,"input_to';

      const content = `${validStep}\n${brokenLine}`;
      await writeTranscript(sessionId, content);

      const usage = await readLastTranscriptUsage(sessionId, tempDir);
      expect(usage).toEqual({
        stepIndex: 5,
        usedTokens: 1000,
      });
    });

    it('возвращает undefined для невалидных sessionId без обращения к ФС', async () => {
      expect(await readLastTranscriptUsage('../etc/passwd', tempDir)).toBeUndefined();
      expect(await readLastTranscriptUsage('invalid-id', tempDir)).toBeUndefined();
      expect(await readLastTranscriptUsage('', tempDir)).toBeUndefined();
      expect(await readLastTranscriptUsage('12345', tempDir)).toBeUndefined();
    });

    it('возвращает undefined при отсутствии файла или пустом файле', async () => {
      const sessionId = '44444444-5555-6666-7777-888888888888';
      // Файла нет
      expect(await readLastTranscriptUsage(sessionId, tempDir)).toBeUndefined();

      // Пустой файл (0 байт)
      await writeTranscript(sessionId, '');
      expect(await readLastTranscriptUsage(sessionId, tempDir)).toBeUndefined();

      // Файл только с пробелами / переводами строк
      await writeTranscript(sessionId, '   \n\n\t\n');
      expect(await readLastTranscriptUsage(sessionId, tempDir)).toBeUndefined();
    });
  });

  describe('buildAgyContextUsage', () => {
    it('рассчитывает процент для известных моделей с зажимом <= 100', () => {
      const normal = buildAgyContextUsage(500_000, 'gemini-4-carbon');
      expect(normal).toEqual({
        type: 'context.usage',
        usedTokens: 500_000,
        maxTokens: 1_000_000,
        percentage: 50,
        source: 'usage',
      });

      const clamped = buildAgyContextUsage(1_500_000, 'gemini-4-carbon');
      expect(clamped).toEqual({
        type: 'context.usage',
        usedTokens: 1_500_000,
        maxTokens: 1_000_000,
        percentage: 100,
        source: 'usage',
      });

      const claude = buildAgyContextUsage(100_000, 'claude-sonnet-5-5-medium');
      expect(claude).toEqual({
        type: 'context.usage',
        usedTokens: 100_000,
        maxTokens: 200_000,
        percentage: 50,
        source: 'usage',
      });
    });

    it('возвращает maxTokens: 0 и percentage: undefined для неизвестной или пустой модели', () => {
      const unknown = buildAgyContextUsage(1000, 'unknown-model');
      expect(unknown).toEqual({
        type: 'context.usage',
        usedTokens: 1000,
        maxTokens: 0,
        source: 'usage',
      });
      expect(unknown.percentage).toBeUndefined();

      const noModel = buildAgyContextUsage(1000, undefined);
      expect(noModel).toEqual({
        type: 'context.usage',
        usedTokens: 1000,
        maxTokens: 0,
        source: 'usage',
      });
      expect(noModel.percentage).toBeUndefined();
    });
  });

  describe('singleStepUsageTokens', () => {
    it('суммирует токены TokenUsage и возвращает undefined при отсутствии usage', () => {
      const usage: TokenUsage = {
        input: 100,
        cacheRead: 50,
        cacheWrite: 25,
        output: 10,
      };
      expect(singleStepUsageTokens(usage)).toBe(185);
      expect(singleStepUsageTokens(undefined)).toBeUndefined();
    });
  });
});
