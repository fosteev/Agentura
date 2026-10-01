import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('картинки в реплике пользователя (этап 4 roadmap 0.2)', () => {
  const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude');
  const fixture = (): HistoryMessage[] =>
    JSON.parse(
      readFileSync(join(FIXTURES, 'image-basic.messages.json'), 'utf8'),
    ) as HistoryMessage[];
  const withImages = (images: unknown[], text: string, s: number): HistoryMessage => ({
    type: 'user',
    uuid: `i${s}`,
    message: { role: 'user', content: [...images, ...(text ? [{ type: 'text', text }] : [])] },
    parent_tool_use_id: null,
    timestamp: ts(s),
  });
  const png = (data: string) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  });

  it('живой транскрипт (image-smoke): base64 целиком → миниатюра с размером из заголовка png', () => {
    const messages = fixture();
    const sent = (messages[0]!.message as { content: { source?: { data?: string } }[] }).content[0]!
      .source!.data!;
    const h = buildHistory(messages);
    const starts = h.events.filter((e) => e.type === 'turn.start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      prompt: expect.stringContaining('two halves'),
      images: [{ mediaType: 'image/png', data: sent, width: 48, height: 32 }],
    });
    // картинка в результате Read (модель перечитала файл CLI) — не реплика пользователя
    expect(h.events.filter((e) => e.type === 'tool.result')).toHaveLength(1);
    expect(h.turns).toBe(1);
  });

  it('только картинка без текста — тоже ход; блок без base64 (ссылка) — плашка без данных', () => {
    const h = buildHistory([
      withImages([png('AAAA')], '', 1),
      withImages([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }], 'и это', 5),
    ]);
    const starts = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'turn.start' }> => e.type === 'turn.start',
    );
    expect(starts.map((e) => e.prompt)).toEqual(['', 'и это']);
    expect(starts[0]!.images).toEqual([{ mediaType: 'image/png', data: 'AAAA' }]);
    expect(starts[1]!.images).toEqual([{}]);
  });

  it('данные — только у последних maxImages картинок, ранние — плашкой', () => {
    const h = buildHistory(
      [withImages([png('AAAA'), png('BBBB')], 'раз', 1), withImages([png('CCCC')], 'два', 5)],
      { maxImages: 2 },
    );
    const images = h.events.flatMap((e) => (e.type === 'turn.start' ? (e.images ?? []) : []));
    expect(images.map((i) => i.data)).toEqual([undefined, 'BBBB', 'CCCC']);
    expect(images[0]).toEqual({ mediaType: 'image/png' });
  });
});

describe('файлы в реплике пользователя (этап 8 roadmap 0.2)', () => {
  const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'claude');
  const withDocs = (docs: unknown[], text: string, s: number): HistoryMessage => ({
    type: 'user',
    uuid: `d${s}`,
    message: { role: 'user', content: [...docs, ...(text ? [{ type: 'text', text }] : [])] },
    parent_tool_use_id: null,
    timestamp: ts(s),
  });
  const txt = (data: string, title?: string) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data },
    ...(title ? { title } : {}),
  });

  it('живой транскрипт (attach-smoke): документы целиком → чипы с путём, размером и содержимым', () => {
    const messages = JSON.parse(
      readFileSync(join(FIXTURES, 'attach-basic.messages.json'), 'utf8'),
    ) as HistoryMessage[];
    const h = buildHistory(messages);
    const starts = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'turn.start' }> => e.type === 'turn.start',
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]!.prompt).toContain('Two files are attached');
    expect(starts[0]!.files).toMatchObject([
      {
        kind: 'text',
        path: 'notes/secret.txt',
        size: 48,
        data: expect.stringContaining('PELICAN-7342'),
      },
      { kind: 'pdf', path: '/tmp/outside/probe.pdf', size: 599, pages: 1 },
    ]);
    expect(starts[0]!.files![1]!.data).toMatch(/^JVBERi0/);
    expect(h.turns).toBe(1);
  });

  it('только файл без текста — ход; документ по url и без title — пропуск и имя по умолчанию', () => {
    const h = buildHistory([
      withDocs([txt('привет')], '', 1),
      withDocs([{ type: 'document', source: { type: 'url', url: 'https://x/y.pdf' } }], 'и это', 5),
    ]);
    const starts = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'turn.start' }> => e.type === 'turn.start',
    );
    expect(starts.map((e) => e.prompt)).toEqual(['', 'и это']);
    expect(starts[0]!.files).toEqual([
      { kind: 'text', path: 'документ.txt', size: 12, data: 'привет' },
    ]);
    expect(starts[1]).not.toHaveProperty('files');
  });

  it('содержимое — только у последних maxFiles файлов, ранние — чип без копии', () => {
    const h = buildHistory(
      [
        withDocs([txt('AAAA', 'a.txt'), txt('BBBB', 'b.txt')], 'раз', 1),
        withDocs([txt('CCCC', 'c.txt')], 'два', 5),
      ],
      { maxFiles: 2 },
    );
    const files = h.events.flatMap((e) => (e.type === 'turn.start' ? (e.files ?? []) : []));
    expect(files.map((f) => f.data)).toEqual([undefined, 'BBBB', 'CCCC']);
    expect(files[0]).toEqual({ kind: 'text', path: 'a.txt', size: 4 });
  });
});

describe('итог хода в истории: ошибка API и цена (этап 5 roadmap 0.2)', () => {
  const results = (events: AgentEvent[]) =>
    events.filter(
      (e): e is Extract<AgentEvent, { type: 'turn.result' }> => e.type === 'turn.result',
    );
  const apiError = (s: number) =>
    assistant(
      'syn',
      [{ type: 'text', text: 'API Error: Overloaded' }],
      s,
      undefined,
      '<synthetic>',
    );

  it('ход, закончившийся ошибкой API, — ok: false; ошибка с ответом после неё (повтор) — ok: true', () => {
    const messages = [
      user('первый', 0),
      apiError(1),
      user('второй', 2),
      apiError(3),
      assistant('m2', [{ type: 'text', text: 'всё же ответил' }], 4),
      user('третий', 5),
      assistant('m3', [{ type: 'text', text: 'ok' }], 6),
    ];
    const h = buildHistory(messages, { apiErrors: new Set(['a1', 'a3']) });
    expect(results(h.events).map((r) => r.ok)).toEqual([false, true, true]);
    // карточка ошибки — по-прежнему событием `error`, итог её не дублирует
    expect(results(h.events)[0]!.errors).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'error')).toHaveLength(2);
  });

  it('служебный <synthetic> без флага ошибки («No response requested.») ход не роняет', () => {
    const messages = [
      user('первый', 0),
      assistant('m1', [{ type: 'text', text: 'ok' }], 1),
      assistant(
        'syn',
        [{ type: 'text', text: 'No response requested.' }],
        2,
        undefined,
        '<synthetic>',
      ),
    ];
    expect(results(buildHistory(messages, { apiErrors: new Set() }).events)[0]!.ok).toBe(true);
    // без сведений из транскрипта — как раньше: любой <synthetic> — ошибка
    expect(results(buildHistory(messages).events)[0]!.ok).toBe(false);
  });

  it('ход с моделью без цены: итог сессии с пометкой costPartial с этого хода и дальше', () => {
    const messages = [
      user('первый', 0),
      assistant('m1', [{ type: 'text', text: 'a' }], 1),
      user('второй', 2),
      assistant('m2', [{ type: 'text', text: 'b' }], 3, undefined, 'unknown-model-x'),
      user('третий', 4),
      assistant('m3', [{ type: 'text', text: 'c' }], 5),
    ];
    const r = results(buildHistory(messages).events);
    expect(r.map((x) => x.costPartial)).toEqual([undefined, true, true]);
    expect(r[1]!.costUsd).toBeUndefined();
    expect(r[2]!.totalCostUsd).toBeCloseTo(r[0]!.totalCostUsd + r[2]!.costUsd!, 12);
  });
});
