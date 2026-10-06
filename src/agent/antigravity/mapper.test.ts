import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { AgyEventMapper, tokenUsageOf } from './mapper';
import type { AgyEvent, AgyInit } from './protocol';

function fixture(name: string): AgyEvent[] {
  return (
    JSON.parse(readFileSync(new URL(`../../../test/fixtures/antigravity/${name}.json`, import.meta.url), 'utf8')) as {
      events: AgyEvent[];
    }
  ).events;
}

const CTX = { permissionMode: 'default' as const, engineVersion: '1.2.17', cwd: '/tmp/x' };

/** Прогнать события через маппер; `prompts` — тексты, объявленные перед каждым `user_input`/результатом хода. */
function run(events: AgyEvent[], prompts: string[]): AgentEvent[] {
  const mapper = new AgyEventMapper(() => 1000);
  const out: AgentEvent[] = [];
  const queue = [...prompts];
  for (const event of events) {
    if (event.event === 'init') out.push(mapper.init(event, CTX));
    else {
      if (!mapper.turnOpen && queue.length > 0) mapper.notePrompt({ text: queue.shift() as string });
      out.push(...mapper.map(event));
    }
  }
  return out;
}
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

describe('AgyEventMapper: живые фикстуры', () => {
  it('два хода в одном процессе: usage хода — сумма шагов, а не накопительный result', () => {
    const events = run(fixture('multi-turn'), ['Reply with just the word pong', 'What word did you reply before?']);
    expect(events.map((e) => e.type)).toEqual([
      'session.init',
      'turn.start',
      'text.delta',
      'usage.message',
      'turn.result',
      'turn.start',
      'text.delta',
      'usage.message',
      'turn.result',
    ]);
    const init = events[0] as AgentEventOf<'session.init'>;
    expect(init.sessionId).toMatch(/^00000000-0000-4000-8000-/);
    expect(init.model).toBe('gemini-3.8-flash-low');
    expect(init.tools.length).toBeGreaterThan(10);
    const results = of(events, 'turn.result');
    expect(results.map((r) => r.usage.input)).toEqual([14984, 15083]);
    expect(results.map((r) => r.usage.output)).toEqual([24, 30]);
    expect(results.map((r) => r.usage.thinking)).toEqual([23, 29]);
    expect(results.map((r) => r.text)).toEqual(['pong', 'pong']);
    expect(results.every((r) => r.ok && r.subtype === 'success' && !r.interrupted)).toBe(true);
    expect(of(events, 'turn.start').map((s) => s.prompt)).toEqual([
      'Reply with just the word pong',
      'What word did you reply before?',
    ]);
  });

  it('живая запись smoke (ход и resume в новом процессе): pong и ok', () => {
    const events = run(fixture('ok-turn'), ['Reply with just the word pong', 'Reply with just the word ok']);
    const results = of(events, 'turn.result');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && r.usage.input > 10_000 && r.usage.output > 0)).toBe(true);
    expect(results[0]?.text).toBe('pong');
    expect(of(events, 'turn.start').map((s) => s.prompt)).toEqual(['Reply with just the word pong', 'Reply with just the word ok']);
    expect(of(events, 'session.init')[0]).toMatchObject({ model: 'gemini-3.8-flash-low', cwd: '/tmp/agentura-agy' });
  });

  it('хвостовой "\\n" не даёт пустого сообщения: во втором ходе «pong» и больше ничего', () => {
    const deltas = of(run(fixture('multi-turn'), ['a', 'b']), 'text.delta');
    expect(deltas.map((d) => d.text)).toEqual(['pong', 'pong']);
    expect(deltas[1]?.messageId).toBe('agy-3');
  });

  it('отказ по разрешениям: tool ERROR → isError, denied_actions → permissionDenials с id шага', () => {
    const events = run(fixture('denied'), ['Create a file hello.txt']);
    const start = of(events, 'tool.start')[0];
    expect(start).toMatchObject({ name: 'Write', toolUseId: 'agy-2' });
    expect(start?.input).toEqual({ file_path: '/tmp/agentura-agy/hello.txt' });
    const res = of(events, 'tool.result')[0];
    expect(res?.isError).toBe(true);
    expect(res?.content).toMatch(/permission check failed/);
    const result = of(events, 'turn.result')[0];
    expect(result?.ok).toBe(true);
    expect(result?.permissionDenials).toEqual([{ toolName: 'Write', toolUseId: 'agy-2' }]);
  });

  it('SIGINT: незакрытый tool закрывается ошибкой, turn.result interrupted', () => {
    const events = run(fixture('interrupted'), ['Run sleep 90']);
    expect(of(events, 'tool.start')[0]?.name).toBe('Bash');
    expect(of(events, 'tool.result')[0]).toMatchObject({ isError: true, content: 'interrupted' });
    const result = of(events, 'turn.result')[0];
    expect(result).toMatchObject({ ok: false, interrupted: true, subtype: 'interrupted' });
    expect(result?.errors).toBeUndefined();
    // порядок: tool.result раньше turn.result
    expect(events.findIndex((e) => e.type === 'tool.result')).toBeLessThan(events.findIndex((e) => e.type === 'turn.result'));
  });

  it('resume: шаги продолжают нумерацию, system_message молчит, init с тем же id', () => {
    const events = run(fixture('resume'), ['What word?']);
    expect(events.map((e) => e.type)).toEqual(['session.init', 'turn.start', 'text.delta', 'usage.message', 'turn.result']);
    expect(of(events, 'text.delta')[0]?.messageId).toBe('agy-6');
  });

  it('неизвестная модель: result ERROR без init и шагов — ход открывается по результату, ошибка в errors', () => {
    const events = run(fixture('bad-model'), ['hi']);
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'turn.result']);
    const result = of(events, 'turn.result')[0];
    expect(result?.ok).toBe(false);
    expect(result?.interrupted).toBe(false);
    expect(result?.errors?.[0]).toMatch(/invalid model selection/);
  });
});

describe('AgyEventMapper: детали', () => {
  const step = (over: Record<string, unknown>): AgyEvent =>
    ({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', ...over } }) as AgyEvent;

  it('пустые дельты и пробельный хвост не плодят сообщений; внутренний перевод строки сохраняется', () => {
    const mapper = new AgyEventMapper();
    mapper.notePrompt({ text: 'x' });
    const out = [
      ...mapper.map(step({ text_delta: '' })),
      ...mapper.map(step({ text_delta: '\n' })),
      ...mapper.map(step({ text_delta: 'a\n' })),
      ...mapper.map(step({ text_delta: 'b' })),
      ...mapper.map(step({ state: 'DONE', text_delta: '\n' })),
    ];
    expect(of(out, 'text.delta').map((d) => d.text)).toEqual(['a', '\nb']);
  });

  it('tool сразу в DONE (без ACTIVE) даёт start и result; повтор DONE не дублирует', () => {
    const mapper = new AgyEventMapper();
    const tool = (state: string) =>
      ({
        event: 'step_update',
        step_update: { step_index: 3, state, step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'x\r\n' } },
      }) as AgyEvent;
    const out = [...mapper.map(tool('DONE')), ...mapper.map(tool('DONE'))];
    expect(out.map((e) => e.type)).toEqual(['turn.start', 'tool.start', 'tool.result']);
    expect(of(out, 'tool.result')[0]).toMatchObject({ isError: false, content: 'x\r\n' });
  });

  it('abandonTurn: идущий ход закрывается interrupted, без хода и промпта — пусто', () => {
    const mapper = new AgyEventMapper();
    expect(mapper.abandonTurn({ interrupted: true })).toEqual([]);
    mapper.notePrompt({ text: 'p' });
    mapper.map(step({ text_delta: 'abc' }));
    const out = mapper.abandonTurn({ message: 'agy exited' });
    const result = of(out, 'turn.result')[0];
    expect(result).toMatchObject({ ok: false, interrupted: false, text: 'abc' });
    expect(result?.errors).toEqual(['agy exited']);
    expect(mapper.turnOpen).toBe(false);
  });

  it('tokenUsageOf: кэш вычитается из ввода, thinking только если есть', () => {
    expect(tokenUsageOf({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 40 })).toEqual({
      input: 60,
      output: 10,
      cacheRead: 40,
      cacheWrite: 0,
    });
    expect(tokenUsageOf(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('id беседы берётся из шагов, если init не пришёл (Stop в первые секунды)', () => {
    const mapper = new AgyEventMapper(() => 1000);
    mapper.map({ event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 0, state: 'DONE', step_type: 'user_input' } });
    expect(mapper.conversationId).toBe('c-1');
    mapper.map({ event: 'result', result: { conversation_id: 'c-2', status: 'ERROR', error: 'interrupted' } });
    expect(mapper.conversationId).toBe('c-1');
  });
  it('init берёт cwd контекста, если agy его не прислал', () => {
    const init = new AgyEventMapper().init({ event: 'init', conversation_id: 'c', init: {} } as AgyInit, CTX);
    expect(init).toMatchObject({ sessionId: 'c', cwd: '/tmp/x', model: '', apiKeySource: 'none' });
  });
});
