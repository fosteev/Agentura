import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildHistory, type HistoryMessage } from '../agent/claude/history';
import { appliedSides } from '../extension/editDiff';
import { readTranscriptExtras } from './transcriptExtras';

const fixture = (name: string) => join(__dirname, '..', '..', 'test', 'fixtures', 'sessions', name);

describe('readTranscriptExtras', () => {
  it('реальный транскрипт Haiku: результат Write, режим на конец сессии, total_cost_usd движка', async () => {
    const x = await readTranscriptExtras(fixture('smoke-haiku.transcript.jsonl'));
    // первый промпт шёл в plan, второй — после resume в default: «на конец» — последний
    expect(x.mode).toBe('default');
    expect(x.totalCostUsd).toBeCloseTo(0.0456766, 7);
    expect(x.toolResults.size).toBe(1);
    const [id, result] = [...x.toolResults][0]!;
    expect(id).toMatch(/^toolu_/);
    expect(result).toMatchObject({ type: 'create' });
  });

  it('нет файла — пусто, без ошибки', async () => {
    expect(await readTranscriptExtras('/nonexistent/x.jsonl')).toEqual({ toolResults: new Map() });
  });

  it('битые строки и чужие записи пропускаются; неинтересные результаты не копятся', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentura-extras-'));
    const file = join(dir, 's.jsonl');
    const user = (extra: Record<string, unknown>) =>
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
        },
        ...extra,
      });
    writeFileSync(
      file,
      [
        'не json "toolUseResult"',
        user({ toolUseResult: { stdout: 'hi' } }),
        user({ isSidechain: true, toolUseResult: { structuredPatch: [] } }),
        user({ toolUseResult: { structuredPatch: [], originalFile: 'a' }, permissionMode: 'plan' }),
        JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5 }),
        JSON.stringify({ type: 'assistant', uuid: 'e1', isApiErrorMessage: true, message: {} }),
        JSON.stringify({ type: 'assistant', uuid: 'e2', isApiErrorMessage: false, message: {} }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'e3',
          isSidechain: true,
          isApiErrorMessage: true,
          message: {},
        }),
      ].join('\n'),
    );
    const x = await readTranscriptExtras(file);
    expect(x.toolResults.get('t1')).toMatchObject({ originalFile: 'a' });
    expect(x.mode).toBe('plan');
    expect(x.totalCostUsd).toBe(1.5);
    expect([...(x.apiErrors ?? [])]).toEqual(['e1']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('история реальной сессии (getSessionMessages + транскрипт)', () => {
  const messages = JSON.parse(
    readFileSync(fixture('smoke-haiku.messages.json'), 'utf8'),
  ) as HistoryMessage[];
  let h: ReturnType<typeof buildHistory>;
  beforeAll(async () => {
    const extras = await readTranscriptExtras(fixture('smoke-haiku.transcript.jsonl'));
    h = buildHistory(messages, { toolResults: extras.toolResults });
  });

  it('два хода, ответ и запись файла агентом доходят до ленты', async () => {
    expect(h.turns).toBe(2);
    const prompts = h.events
      .filter((e) => e.type === 'turn.start')
      .map((e) => (e as { prompt?: string }).prompt);
    expect(prompts[0]).toContain('ананас');
    expect(h.events.filter((e) => e.type === 'turn.result')).toHaveLength(2);
    expect(h.events.some((e) => e.type === 'text.delta' && e.text.length > 0)).toBe(true);
    expect(h.model).toMatch(/^claude-haiku-4-5/);
  });

  it('у правки есть tool.start и tool.result с результатом — «diff» в восстановленной истории находит её', async () => {
    const start = h.events.find((e) => e.type === 'tool.start' && e.name === 'Write');
    expect(start).toBeDefined();
    const result = h.events.find(
      (e) => e.type === 'tool.result' && e.toolUseId === (start as { toolUseId: string }).toolUseId,
    );
    expect(result).toBeDefined();
    const sides = appliedSides(
      'Write',
      (start as { input: Record<string, unknown> }).input,
      (result as { result?: unknown }).result,
    );
    expect(sides).toMatchObject({ isNew: true, before: '' });
    expect(sides!.after.length).toBeGreaterThan(0);
  });
});
