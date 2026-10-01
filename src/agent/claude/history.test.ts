import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { buildHistory, modeFromTranscript, type HistoryMessage } from './history';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const ts = (s: number) => new Date(T0 + s * 1000).toISOString();

const user = (text: string, s: number): HistoryMessage => ({
  type: 'user',
  uuid: `u${s}`,
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  timestamp: ts(s),
});
const toolResult = (id: string, content: string, s: number, isError = false): HistoryMessage => ({
  type: 'user',
  uuid: `r${s}`,
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
    ],
  },
  parent_tool_use_id: null,
  timestamp: ts(s),
});
const assistant = (
  id: string,
  content: unknown[],
  s: number,
  usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 0,
  },
  model = 'claude-sonnet-5-5',
): HistoryMessage => ({
  type: 'assistant',
  uuid: `a${s}`,
  message: { id, model, role: 'assistant', content, usage },
  parent_tool_use_id: null,
  timestamp: ts(s),
});

const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('buildHistory', () => {
  const edit = {
    filePath: '/p/a.ts',
    originalFile: 'a\nb\n',
    structuredPatch: [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] },
    ],
  };
  const messages: HistoryMessage[] = [
    user('поправь a.ts', 0),
    assistant(
      'm1',
      [
        { type: 'text', text: 'Сейчас.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: { file_path: '/p/a.ts', old_string: 'b', new_string: 'c' },
        },
      ],
      2,
    ),
    toolResult('t1', 'ok', 4),
    assistant('m2', [{ type: 'text', text: 'Готово.' }], 5),
    user('спасибо', 10),
    assistant('m3', [{ type: 'text', text: 'Пожалуйста.' }], 11),
  ];

  it('ходы: turn.start → события → turn.result; тексты, инструменты, результаты', () => {
    const h = buildHistory(messages, { toolResults: new Map([['t1', edit]]) });
    expect(h.turns).toBe(2);
    expect(h.skippedTurns).toBe(0);
    expect(types(h.events)).toEqual([
      'turn.start',
      'usage.message',
      'context.usage',
      'text.delta',
      'tool.start',
      'tool.result',
      'usage.message',
      'context.usage',
      'text.delta',
      'turn.result',
      'turn.start',
      'usage.message',
      'context.usage',
      'text.delta',
      'turn.result',
    ]);
    const start = h.events.find((e) => e.type === 'turn.start');
    expect(start).toMatchObject({ prompt: 'поправь a.ts', at: T0 });
    const result = h.events.find((e) => e.type === 'tool.result');
    expect(result).toMatchObject({
      toolUseId: 't1',
      isError: false,
      content: 'ok',
      result: edit,
      durationMs: 2000,
    });
  });

  it('итог хода: usage по API-ответам (дедуп по id), стоимость по таблице, время хода', () => {
    const dup = [
      ...messages.slice(0, 2),
      // тот же ответ m1 записан вторым блоком — usage считается один раз, итоговый берётся последний
      assistant('m1', [{ type: 'text', text: '.' }], 3, {
        input_tokens: 10,
        output_tokens: 50,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      }),
      ...messages.slice(2),
    ];
    const h = buildHistory(dup);
    const r = h.events.filter((e) => e.type === 'turn.result') as Extract<
      AgentEvent,
      { type: 'turn.result' }
    >[];
    expect(r).toHaveLength(2);
    expect(r[0]!.usage).toMatchObject({ input: 20, output: 55, cacheRead: 200 });
    expect(r[0]!.durationMs).toBe(5000);
    expect(r[0]!.costUsd).toBeGreaterThan(0);
    expect(r[1]!.totalCostUsd).toBeCloseTo(r[0]!.costUsd! + r[1]!.costUsd!, 10);
    // у повторно записанного id usage.message один
    expect(h.events.filter((e) => e.type === 'usage.message' && e.messageId === 'm1')).toHaveLength(
      1,
    );
    expect(h.model).toBe('claude-sonnet-5-5');
  });

  it('модель без цены: стоимости хода нет (не $0)', () => {
    const h = buildHistory([
      user('q', 0),
      assistant('m', [{ type: 'text', text: 'a' }], 1, undefined, 'claude-unknown-9'),
    ]);
    const r = h.events.find((e) => e.type === 'turn.result') as Extract<
      AgentEvent,
      { type: 'turn.result' }
    >;
    expect(r.costUsd).toBeUndefined();
  });

  it('служебные записи: эхо команд, сводка компакции, прерывание, субагенты', () => {
    const h = buildHistory([
      user('<command-name>/model</command-name>', 0),
      user('привет', 1),
      assistant('m1', [{ type: 'text', text: 'ответ' }], 2),
      user('[Request interrupted by user]', 3),
      {
        ...assistant('sub', [{ type: 'text', text: 'изнутри субагента' }], 4),
        parent_tool_use_id: 'toolu_agent',
      },
      user(
        'This session is being continued from a previous conversation that ran out of context. Summary…',
        5,
      ),
      user('дальше', 6),
    ]);
    expect(h.turns).toBe(2);
    const prompts = h.events
      .filter((e) => e.type === 'turn.start')
      .map((e) => (e as { prompt?: string }).prompt);
    expect(prompts).toEqual(['привет', 'дальше']);
    expect(h.events.some((e) => e.type === 'text.delta' && e.text.includes('субагента'))).toBe(
      false,
    );
    expect(h.events.filter((e) => e.type === 'turn.result')[0]).toMatchObject({
      interrupted: true,
    });
    expect(types(h.events)).toContain('compaction.end');
  });

  it('thinking: непустой рисуем, пустой (summarized) пропускаем; синтетический ответ — ошибка', () => {
    const h = buildHistory([
      user('q', 0),
      assistant(
        'm1',
        [
          { type: 'thinking', thinking: '' },
          { type: 'thinking', thinking: 'размышляю' },
          { type: 'text', text: 'a' },
        ],
        1,
      ),
      assistant('syn', [{ type: 'text', text: 'Limit reached' }], 2, undefined, '<synthetic>'),
    ]);
    expect(types(h.events).filter((t) => t.startsWith('thinking'))).toEqual([
      'thinking.start',
      'thinking.delta',
      'thinking.stop',
    ]);
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({
      message: 'Limit reached',
      fatal: false,
    });
  });

  it('live: последний ход остаётся открытым; иначе закрыт', () => {
    const open = buildHistory(messages.slice(0, 3), { live: true });
    expect(types(open.events).at(-1)).toBe('tool.result');
    expect(types(open.events)).not.toContain('turn.result');
    const closed = buildHistory(messages.slice(0, 3));
    expect(types(closed.events).at(-1)).toBe('turn.result');
  });

  it('maxTurns: показываются последние ходы, skippedTurns считает отброшенные', () => {
    const many: HistoryMessage[] = [];
    for (let i = 0; i < 5; i++) {
      many.push(
        user(`вопрос ${i}`, i * 10),
        assistant(`m${i}`, [{ type: 'text', text: `ответ ${i}` }], i * 10 + 1),
      );
    }
    const h = buildHistory(many, { maxTurns: 2 });
    expect(h.turns).toBe(5);
    expect(h.skippedTurns).toBe(3);
    const prompts = h.events
      .filter((e) => e.type === 'turn.start')
      .map((e) => (e as { prompt?: string }).prompt);
    expect(prompts).toEqual(['вопрос 3', 'вопрос 4']);
  });

  it('пустая история', () => {
    expect(buildHistory([])).toEqual({ events: [], turns: 0, skippedTurns: 0 });
  });
});

describe('modeFromTranscript', () => {
  it('режимы расширения как есть, auto/dontAsk — default', () => {
    expect(modeFromTranscript('plan')).toBe('plan');
    expect(modeFromTranscript('acceptEdits')).toBe('acceptEdits');
    expect(modeFromTranscript('auto')).toBe('default');
    expect(modeFromTranscript('dontAsk')).toBe('default');
    expect(modeFromTranscript(undefined)).toBeUndefined();
  });
});
