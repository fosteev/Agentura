import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { buildCodexHistory } from './history';
import type { Thread, ThreadItem, Turn } from './protocol';

const user = (text: string, id = 'u'): ThreadItem => ({
  type: 'userMessage',
  id,
  clientId: null,
  content: [{ type: 'text', text, text_elements: [] }],
});
const agent = (text: string, id = 'm', phase: string | null = 'final_answer'): ThreadItem => ({
  type: 'agentMessage',
  id,
  text,
  phase,
});
const turn = (id: string, items: ThreadItem[], extra: Partial<Turn> = {}): Turn => ({
  id,
  items,
  status: 'completed',
  error: null,
  startedAt: 100,
  completedAt: 130,
  durationMs: 30_000,
  ...extra,
});
const thread = (turns: Turn[], extra: Partial<Thread> = {}): Thread =>
  ({ id: 't', model: 'gpt-x', turns, ...extra }) as unknown as Thread;
const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('buildCodexHistory', () => {
  it('ход: turn.start с промптом и временем, ответ, итог с моделью и текстом', () => {
    const h = buildCodexHistory(thread([turn('a', [user('привет'), agent('здравствуйте')])]));
    expect(types(h.events)).toEqual(['turn.start', 'text.delta', 'turn.result']);
    expect(h.events[0]).toMatchObject({ prompt: 'привет', at: 100_000 });
    expect(h.events[1]).toMatchObject({ messageId: 'm', text: 'здравствуйте' });
    expect(h.events[2]).toMatchObject({
      ok: true,
      subtype: 'success',
      durationMs: 30_000,
      model: 'gpt-x',
      text: 'здравствуйте',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(h).toMatchObject({ turns: 1, skippedTurns: 0, model: 'gpt-x' });
  });

  it('команды и правки — как у живой ленты: имена Claude, один вызов на файл', () => {
    const h = buildCodexHistory(
      thread([
        turn('a', [
          user('сделай'),
          {
            type: 'commandExecution',
            id: 'c1',
            command: "/bin/zsh -lc 'ls'",
            cwd: '/w',
            status: 'completed',
            source: 'x',
            aggregatedOutput: null,
            exitCode: 0,
            durationMs: 5,
          },
          {
            type: 'fileChange',
            id: 'f1',
            status: 'completed',
            changes: [
              { path: '/w/a.txt', kind: { type: 'add' }, diff: 'hi' },
              { path: '/w/b.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
            ],
          },
          agent('готово'),
        ]),
      ]),
    );
    const starts = h.events.filter((e) => e.type === 'tool.start');
    expect(starts.map((e) => [e.toolUseId, e.name])).toEqual([
      ['c1', 'Bash'],
      ['f1', 'Write'],
      ['f1#1', 'Edit'],
    ]);
    expect(starts[0]).toMatchObject({ input: { command: 'ls' } });
    expect(h.events.filter((e) => e.type === 'tool.result')).toHaveLength(3);
    // время — по ходу (сервер не отдаёт время элементов), а не «сейчас»
    expect(starts[0]!.at).toBe(130_000);
  });

  it('второе сообщение внутри хода — turn.input, рассуждение — thinking.*', () => {
    const h = buildCodexHistory(
      thread([
        turn('a', [
          user('раз', 'u1'),
          { type: 'reasoning', id: 'r1', summary: ['думаю', 'ещё'], content: [] },
          user('два', 'u2'),
          { type: 'reasoning', id: 'r2', summary: [], content: [] },
          agent('ок'),
        ]),
      ]),
    );
    expect(types(h.events)).toEqual([
      'turn.start',
      'thinking.start',
      'thinking.delta',
      'thinking.stop',
      'turn.input',
      'text.delta',
      'turn.result',
    ]);
    expect(h.events[2]).toMatchObject({ text: 'думаю\n\nещё' });
    expect(h.events[4]).toMatchObject({ prompt: 'два' });
  });

  it('картинки: data-URL с данными, прочее — только метка', () => {
    const h = buildCodexHistory(
      thread([
        turn('a', [
          {
            type: 'userMessage',
            id: 'u',
            clientId: null,
            content: [
              { type: 'image', url: 'data:image/png;base64,AAAA' },
              { type: 'localImage', path: '/tmp/shot.png' },
              { type: 'text', text: 'что тут', text_elements: [] },
            ],
          },
        ]),
      ]),
    );
    expect(h.events[0]).toMatchObject({
      prompt: 'что тут',
      images: [{ mediaType: 'image/png', data: 'AAAA' }, { name: 'shot.png' }],
    });
  });

  it('ход без сообщения пользователя (начал сам движок) — turn.start без промпта', () => {
    const h = buildCodexHistory(thread([turn('a', [agent('сам')])]));
    expect(h.events[0]).toMatchObject({ type: 'turn.start' });
    expect(h.events[0]).not.toHaveProperty('prompt');
  });

  it('ошибка и прерывание: итог не ok, текст ошибки, terminalReason', () => {
    const failed = buildCodexHistory(
      thread([
        turn('a', [user('x')], {
          status: 'failed',
          error: { message: 'упало', codexErrorInfo: null, additionalDetails: null },
        }),
      ]),
    );
    expect(failed.events.at(-1)).toMatchObject({
      ok: false,
      subtype: 'error',
      terminalReason: 'failed',
      errors: ['упало'],
    });
    const stopped = buildCodexHistory(thread([turn('a', [user('x')], { status: 'interrupted' })]));
    expect(stopped.events.at(-1)).toMatchObject({ ok: false, interrupted: true, subtype: 'interrupted' });
  });

  it('inProgress: у живой сессии ход остаётся открытым, иначе закрывается прерыванием', () => {
    const t = thread([turn('a', [user('x')]), turn('b', [user('y')], { status: 'inProgress', completedAt: null })]);
    const live = buildCodexHistory(t, { live: true });
    expect(types(live.events)).toEqual(['turn.start', 'turn.result', 'turn.start']);
    const idle = buildCodexHistory(t);
    expect(types(idle.events)).toEqual(['turn.start', 'turn.result', 'turn.start', 'turn.result']);
    expect(idle.events.at(-1)).toMatchObject({ interrupted: true, ok: false });
  });

  it('maxTurns: последние ходы, остальные — skippedTurns', () => {
    const turns = ['a', 'b', 'c'].map((id) => turn(id, [user(id)]));
    const h = buildCodexHistory(thread(turns), { maxTurns: 2 });
    expect(h).toMatchObject({ turns: 3, skippedTurns: 1 });
    expect(h.events.filter((e) => e.type === 'turn.start').map((e) => (e as { prompt?: string }).prompt)).toEqual(['b', 'c']);
  });

  it('пустой тред — пустая история', () => {
    expect(buildCodexHistory(thread([], { model: null }))).toEqual({ events: [], turns: 0, skippedTurns: 0 });
  });
});
