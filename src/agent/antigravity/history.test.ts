import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { buildAgyHistory, userRequestText } from './history';
import type { TranscriptStep } from './storage';

const fixture = (name: string): TranscriptStep[] =>
  readFileSync(new URL(`../../../test/fixtures/antigravity/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TranscriptStep);
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

describe('userRequestText', () => {
  it('достаёт запрос из <USER_REQUEST>, остальные обёртки отбрасывает', () => {
    const raw = fixture('transcript_full.jsonl')[0]?.content ?? '';
    expect(userRequestText(raw)).toMatch(/^Create a file hello\.txt.*echo done` in shell\.$/);
    expect(userRequestText('<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>\nпросто текст\n<USER_SETTINGS_CHANGE>y</USER_SETTINGS_CHANGE>')).toBe('просто текст');
    expect(userRequestText('<USER_REQUEST>\n  a\n  b\n</USER_REQUEST>')).toBe('a\n  b');
  });
});

describe('buildAgyHistory: транскрипт → лента', () => {
  it('правка, команда и финальный ответ: порядок событий, id как у живой ленты, дифф в результате правки', () => {
    const history = buildAgyHistory(fixture('transcript_full.jsonl'));
    expect(history).toMatchObject({ turns: 1, skippedTurns: 0 });
    const events = history.events;
    expect(types(events)[0]).toBe('turn.start');
    expect(types(events).at(-1)).toBe('turn.result');
    expect(of(events, 'turn.start')[0]?.prompt).toMatch(/^Create a file hello\.txt/);
    const starts = of(events, 'tool.start');
    expect(starts.map((t) => [t.toolUseId, t.name])).toEqual([
      ['agy-2', 'Write'],
      ['agy-4', 'Edit'],
      ['agy-6', 'Bash'],
    ]);
    expect(starts[2]?.input).toMatchObject({ command: 'echo done' });
    const res = of(events, 'tool.result');
    expect(res.map((r) => [r.toolUseId, r.isError])).toEqual([
      ['agy-2', false],
      ['agy-4', false],
      ['agy-6', false],
    ]);
    expect(res[0]?.content).toMatch(/^Created file/);
    expect(res[0]?.content).not.toMatch(/Created At/);
    expect(res[0]?.result).toMatchObject({ type: 'create', content: 'hi' });
    expect(res[1]?.result).toMatchObject({ oldString: 'hi', newString: 'hello world' });
    expect((res[1]?.result as { structuredPatch?: unknown[] }).structuredPatch?.length).toBeGreaterThan(0);
    expect(res[2]?.content).toContain('done');
    const final = of(events, 'turn.result')[0];
    expect(final).toMatchObject({ ok: true, interrupted: false, numTurns: 4, subtype: 'success' });
    expect(final?.text).toMatch(/^All steps completed/);
    expect(final?.usage.output).toBe(258 + 183 + 130 + 199);
    expect(of(events, 'usage.message')).toHaveLength(4);
    expect(of(events, 'text.delta').map((t) => t.messageId)).toEqual(['agy-7']);
  });

  it('thinking в ленту не идёт, view_file/прочие инструменты маппятся тем же mapAgyTool', () => {
    const events = buildAgyHistory(fixture('transcript_full_multiline.jsonl')).events;
    expect(types(events).some((t) => t.startsWith('thinking'))).toBe(false);
    expect(of(events, 'tool.start').map((t) => t.name)).toEqual(['Read', 'Edit']);
  });

  const user = (i: number, text: string): TranscriptStep => ({ step_index: i, type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`, created_at: '2026-10-06T10:00:00Z' });
  const planner = (i: number, extra: Partial<TranscriptStep> = {}): TranscriptStep => ({ step_index: i, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-06T10:00:02Z', ...extra });
  const generic = (i: number, extra: Partial<TranscriptStep> = {}): TranscriptStep => ({ step_index: i, type: 'GENERIC', status: 'DONE', content: 'Created At: x\nCompleted At: y\nok', created_at: '2026-10-06T10:00:03Z', ...extra });
  const run = (cmd: string) => ({ name: 'run_command', args: { CommandLine: cmd } });

  it('отказ по разрешениям: tool.result isError и permissionDenials с именем карточки', () => {
    const steps = [
      user(0, 'go'),
      planner(1, { tool_calls: [run('rm x')] }),
      generic(2, { status: 'ERROR', content: undefined, error: 'permission check failed for unsandboxed "rm x": user denied' }),
      planner(3, { content: 'не вышло' }),
    ];
    const events = buildAgyHistory(steps).events;
    expect(of(events, 'tool.result')[0]).toMatchObject({ toolUseId: 'agy-2', isError: true });
    expect(of(events, 'turn.result')[0]?.permissionDenials).toEqual([{ toolName: 'Bash', toolUseId: 'agy-2' }]);
  });

  it('оборванный ход: незакрытый инструмент — ошибка, turn.result interrupted; live — ход остаётся открытым', () => {
    const steps = [user(0, 'go'), planner(1, { tool_calls: [run('sleep 9')] })];
    const done = buildAgyHistory(steps).events;
    expect(of(done, 'tool.result')[0]).toMatchObject({ isError: true, content: 'interrupted' });
    expect(of(done, 'turn.result')[0]).toMatchObject({ ok: false, interrupted: true, subtype: 'interrupted' });
    const live = buildAgyHistory(steps, { live: true }).events;
    expect(types(live)).toEqual(['turn.start', 'tool.start']);
  });

  it('фоновая команда (RUNNING) — результат «запущено», не ошибка; SYSTEM_MESSAGE пропускается', () => {
    const steps = [
      user(0, 'go'),
      planner(1, { tool_calls: [run('sleep 90')] }),
      generic(2, { status: 'RUNNING', content: 'Created At: x\nTool is running as a background task' }),
      { step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'sys' },
      planner(4, { content: 'ok' }),
    ];
    const events = buildAgyHistory(steps).events;
    expect(of(events, 'tool.result')[0]).toMatchObject({ isError: false, content: 'Tool is running as a background task' });
    expect(of(events, 'turn.result')[0]?.ok).toBe(true);
  });

  it('повтор после отказа (silentPrompts) — ход без пузыря; maxTurns берёт последние ходы', () => {
    const steps = [user(0, 'one'), planner(1, { content: 'a' }), user(2, 'RETRY'), planner(3, { content: 'b' }), user(4, 'three'), planner(5, { content: 'c' })];
    const all = buildAgyHistory(steps, { silentPrompts: ['RETRY'] });
    expect(of(all.events, 'turn.start').map((t) => t.prompt)).toEqual(['one', undefined, 'three']);
    const tail = buildAgyHistory(steps, { maxTurns: 1 });
    expect(tail).toMatchObject({ turns: 3, skippedTurns: 2 });
    expect(of(tail.events, 'turn.start').map((t) => t.prompt)).toEqual(['three']);
  });

  it('live: вызов без результата получает id будущего шага tool (склейка с живым продолжением)', () => {
    const steps = [user(0, 'go'), planner(1, { tool_calls: [run('a'), run('b')] }), generic(2)];
    const live = buildAgyHistory(steps, { live: true }).events;
    expect(of(live, 'tool.start').map((t) => t.toolUseId)).toEqual(['agy-2', 'agy-3']);
    expect(of(live, 'tool.result').map((t) => t.toolUseId)).toEqual(['agy-2']);
    const done = buildAgyHistory(steps).events;
    expect(of(done, 'tool.start').map((t) => t.toolUseId)).toEqual(['agy-2', 'agy-1-1']);
  });

  it('сбой ответа агента (planner ERROR) — ход с ошибкой, не успех', () => {
    const events = buildAgyHistory([user(0, 'go'), planner(1, { status: 'ERROR', error: 'quota exhausted' })]).events;
    expect(of(events, 'turn.result')[0]).toMatchObject({ ok: false, subtype: 'error', interrupted: false, errors: ['quota exhausted'] });
  });

  it('хвост без USER_INPUT: с ответом агента — ход без промпта, одни служебные шаги — без хода; skippedBefore', () => {
    const sys = { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'sys' };
    expect(buildAgyHistory([sys, user(1, 'go'), planner(2, { content: 'a' })]).turns).toBe(1);
    const tail = buildAgyHistory([generic(5), planner(6, { content: 'end' }), user(7, 'next'), planner(8, { content: 'b' })], { skippedBefore: 4 });
    expect(tail).toMatchObject({ turns: 6, skippedTurns: 4 });
    expect(of(tail.events, 'turn.start').map((t) => t.prompt)).toEqual([undefined, 'next']);
  });

  it('пустой транскрипт — пустая история', () => {
    expect(buildAgyHistory([])).toEqual({ events: [], turns: 0, skippedTurns: 0 });
  });
});
