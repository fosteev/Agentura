import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { withoutImageData } from './json';
import { ClaudeEventMapper } from './mapper';

/** Минимальные сообщения SDK в форме живых логов пробы. */
const init = (model = 'claude-sonnet-5-5') => ({
  type: 'system',
  subtype: 'init',
  session_id: 's',
  model,
  permissionMode: 'default',
});
const requesting = { type: 'system', subtype: 'status', status: 'requesting' };
const start = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  ...extra,
  event: {
    type: 'message_start',
    message: {
      id,
      model: 'claude-sonnet-5-5',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    },
  },
});
const block = (index: number, type: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_start', index, content_block: { type } },
});
const result = (total: number, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: total,
  usage: { input_tokens: 2, output_tokens: 3 },
  modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000, costUSD: total } },
  ...extra,
});
const notification = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 't1',
  status: 'completed',
  summary: 'ok',
};

function run(m: ClaudeEventMapper, messages: unknown[]): AgentEvent[] {
  return messages.flatMap((msg) => m.map(msg));
}
function ofType<T extends AgentEvent['type']>(events: AgentEvent[], type: T): AgentEventOf<T>[] {
  return events.filter((e): e is AgentEventOf<T> => e.type === type);
}

describe('привязка промпта к ходу', () => {
  it('по эху user_message_uuids: два склеенных сообщения — один ход с обоими текстами', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0 });
    m.notePrompt('первое', 'u1');
    m.notePrompt('второе', 'u2');
    m.notePrompt('третье', 'u3');
    const events = run(m, [
      init(),
      requesting,
      start('m1', { user_message_uuid: 'u2', user_message_uuids: ['u1', 'u2'] }),
      result(0.01),
      init(),
      start('m2', { user_message_uuid: 'u3' }),
      result(0.02),
    ]);
    expect(ofType(events, 'turn.start').map((t) => t.prompt)).toEqual([
      'первое\n\nвторое',
      'третье',
    ]);
    expect(ofType(events, 'turn.start').map((t) => t.prompts)).toEqual([
      ['первое', 'второе'],
      undefined,
    ]);
  });

  it('эхо посреди хода (сообщение влито в ход) снимает промпт с очереди', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0 });
    m.notePrompt('первое', 'u1');
    m.notePrompt('влитое', 'u2');
    m.notePrompt('следующее', 'u3');
    const events = run(m, [
      init(),
      start('m1', { user_message_uuid: 'u1' }),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        user_message_uuid: 'u2',
        message: { id: 'm2', model: 'claude-sonnet-5-5', content: [] },
      },
      result(0.01),
      init(),
      start('m3'), // старый CLI без эха — по очереди
      result(0.02),
    ]);
    expect(ofType(events, 'turn.start').map((t) => t.prompt)).toEqual(['первое', 'следующее']);
    expect(ofType(events, 'turn.input').map((t) => t.prompt)).toEqual(['влитое']);
  });

  it('без эха ход после фоновой задачи — пробуждение: промпт из очереди ему не приписывается', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0 });
    m.notePrompt('запусти агента');
    const events = run(m, [init(), start('m1'), result(0.01), notification]);
    m.notePrompt('вопрос во время пробуждения');
    events.push(
      ...run(m, [
        init(),
        start('m2'),
        result(0.02, { origin: { kind: 'task-notification' } }),
        init(),
        start('m3'),
        result(0.03),
      ]),
    );
    expect(ofType(events, 'turn.start').map((t) => t.prompt)).toEqual([
      'запусти агента',
      undefined,
      'вопрос во время пробуждения',
    ]);
  });

  it('если промпт всё же ушёл пробуждению по очереди — возвращается следующему ходу', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0 });
    m.notePrompt('текст');
    const events = run(m, [
      init(),
      start('m1'),
      result(0.01, { origin: { kind: 'task-notification' } }), // пробуждение без уведомления в потоке
      init(),
      start('m2'),
      result(0.02),
    ]);
    expect(ofType(events, 'turn.start').map((t) => t.prompt)).toEqual(['текст', 'текст']);
  });
});

describe('синтетические сообщения движка', () => {
  it('ошибка API: error, без usage и context.usage, модель и окно не меняются', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0 });
    const events = run(m, [
      init(),
      result(0.01),
      init(),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'syn1',
          model: '<synthetic>',
          content: [{ type: 'text', text: "You've hit your usage limit · resets 5pm" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      result(0.01, { is_error: true, modelUsage: { '<synthetic>': { contextWindow: 0 } } }),
    ]);
    expect(ofType(events, 'usage.message')).toEqual([]);
    expect(ofType(events, 'context.usage')).toEqual([]);
    expect(ofType(events, 'error')).toEqual([
      {
        type: 'error',
        fatal: false,
        code: 'limit',
        message: "You've hit your usage limit · resets 5pm",
      },
    ]);
    expect(m.currentModel).toBe('claude-sonnet-5-5');
    expect(m.contextWindow()).toBe(1_000_000);
  });

  it('синтетика без ошибки (вывод команды) — текст без usage', () => {
    const m = new ClaudeEventMapper();
    const events = run(m, [
      init(),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 's2',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      },
    ]);
    expect(events.map((e) => e.type)).toEqual(['session.init', 'turn.start', 'text.delta']);
  });
});

describe('прерывание', () => {
  it('посреди рассуждения: thinking.stop до turn.result', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0, now: () => 5 });
    const events = run(m, [
      init(),
      start('m1'),
      block(0, 'thinking'),
      result(0, {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        usage: {},
      }),
    ]);
    const stop = events.findIndex((e) => e.type === 'thinking.stop');
    const end = events.findIndex((e) => e.type === 'turn.result');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(end);
    expect(events[stop]).toMatchObject({ messageId: 'm1', at: 5 });
  });
});

describe('Read картинки моделью', () => {
  const B64 = 'iVBORw0KGgo'.repeat(1000);
  const imageResult = {
    type: 'image',
    file: { base64: B64, type: 'image/png', originalSize: 8000, dimensions: { originalWidth: 10 } },
  };

  it('tool.result: плашка [image] в тексте, структурный результат без base64', () => {
    const m = new ClaudeEventMapper({ baselineCostUsd: 0, now: () => 5 });
    const events = run(m, [
      init(),
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'r1',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
              ],
            },
          ],
        },
        tool_use_result: imageResult,
      },
    ]);
    const [e] = ofType(events, 'tool.result');
    expect(e?.content).toBe('[image]');
    expect(JSON.stringify(e)).not.toContain('iVBORw0KGgo');
    expect(e?.result).toEqual({
      type: 'image',
      file: {
        type: 'image/png',
        originalSize: 8000,
        dimensions: { originalWidth: 10 },
        dataOmitted: true,
      },
    });
  });

  it('Read pdf моделью: копия base64 тоже убрана', () => {
    expect(
      withoutImageData({
        type: 'pdf',
        file: { filePath: '/a.pdf', base64: 'JVBERi0x', originalSize: 8 },
      }),
    ).toEqual({ type: 'pdf', file: { filePath: '/a.pdf', originalSize: 8, dataOmitted: true } });
  });

  it('результат без base64 и не-картинки не трогаются', () => {
    const text = { type: 'text', file: { filePath: '/a', content: 'x' } };
    expect(withoutImageData(text)).toBe(text);
    expect(withoutImageData(undefined)).toBeUndefined();
    const noData = { type: 'image', file: { type: 'image/png' } };
    expect(withoutImageData(noData)).toBe(noData);
  });
});

describe('статус MCP из init (roadmap 21)', () => {
  const mcpOf = (events: AgentEvent[]) =>
    events.filter((e): e is AgentEventOf<'mcp.status'> => e.type === 'mcp.status');

  it('mcp_servers → mcp.status после session.init; неизвестный статус — pending, source sdk — builtin', () => {
    const m = new ClaudeEventMapper({ now: () => 42 });
    const events = m.map({
      ...init(),
      mcp_servers: [
        { name: 'github', status: 'connected', source: 'user' },
        { name: 'agentura_jira', status: 'connected', source: 'sdk' },
        { name: 'slack', status: 'needs-auth' },
        { name: 'linear', status: 'warming-up' },
        { name: 'off', status: 'disabled' },
        { status: 'connected' },
      ],
    });
    expect(events.map((e) => e.type)).toEqual(['session.init', 'mcp.status']);
    expect(mcpOf(events)[0]).toEqual({
      type: 'mcp.status',
      at: 42,
      servers: [
        { name: 'github', status: 'connected' },
        { name: 'agentura_jira', status: 'connected', builtin: true },
        { name: 'slack', status: 'needs-auth' },
        { name: 'linear', status: 'pending' },
        { name: 'off', status: 'disabled' },
      ],
    });
  });

  it('init без mcp_servers (старый CLI) — события нет; пустой список — событие с пустым списком', () => {
    expect(mcpOf(new ClaudeEventMapper().map(init()))).toEqual([]);
    expect(mcpOf(new ClaudeEventMapper().map({ ...init(), mcp_servers: [] }))[0]?.servers).toEqual([]);
  });

  it('тот же init — без повторов; список изменился при том же lastInitKey — только mcp.status', () => {
    const m = new ClaudeEventMapper();
    const a = { ...init(), mcp_servers: [{ name: 'github', status: 'pending' }] };
    m.map(a);
    expect(m.map(a)).toEqual([]);
    const b = m.map({ ...init(), mcp_servers: [{ name: 'github', status: 'connected' }] });
    expect(b.map((e) => e.type)).toEqual(['mcp.status']);
    expect(mcpOf(b)[0]!.servers).toEqual([{ name: 'github', status: 'connected' }]);
  });

  it('подробности mcpServerStatus() переживают init с тем же статусом, со сменой статуса — сбрасываются', () => {
    const m = new ClaudeEventMapper();
    m.map({ ...init(), mcp_servers: [{ name: 'github', status: 'connected' }] });
    const full = m.mcpFromEngine([
      { name: 'github', status: 'connected', serverInfo: { name: 'gh', version: '2.0' }, tools: [{}, {}, {}], scope: 'user' },
    ]);
    expect(full?.servers).toEqual([{ name: 'github', status: 'connected', version: '2.0', tools: 3, scope: 'user' }]);
    expect(m.map({ ...init(), mcp_servers: [{ name: 'github', status: 'connected' }] })).toEqual([]);
    const failed = mcpOf(m.map({ ...init(), mcp_servers: [{ name: 'github', status: 'failed' }] }));
    expect(failed[0]!.servers).toEqual([{ name: 'github', status: 'failed', scope: 'user' }]);
  });

  it('mcpFromEngine: без изменений — undefined, с force — событие; не массив — undefined', () => {
    const m = new ClaudeEventMapper();
    const list = [{ name: 'x', status: 'failed', error: 'boom' }];
    expect(m.mcpFromEngine(list)?.servers).toEqual([{ name: 'x', status: 'failed', error: 'boom' }]);
    expect(m.mcpFromEngine(list)).toBeUndefined();
    expect(m.mcpFromEngine(list, true)?.servers).toHaveLength(1);
    expect(m.mcpFromEngine({ nope: 1 }, true)).toBeUndefined();
  });

  it('тот же список в другом порядке — не изменение', () => {
    const m = new ClaudeEventMapper();
    const a = { name: 'a', status: 'connected' };
    const b = { name: 'b', status: 'failed' };
    expect(m.mcpFromEngine([a, b])).toBeDefined();
    expect(m.mcpFromEngine([b, a])).toBeUndefined();
  });
});
