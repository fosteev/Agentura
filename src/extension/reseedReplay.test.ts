import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { mergeReplay, StreamTail } from './reseedReplay';

const result = (extra: Partial<Extract<AgentEvent, { type: 'turn.result' }>> = {}): AgentEvent => ({
  type: 'turn.result',
  ok: true,
  subtype: 'success',
  interrupted: false,
  durationMs: 1,
  apiDurationMs: 0,
  numTurns: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  totalCostUsd: 0.1,
  permissionDenials: [],
  ...extra,
});
const start = (prompt?: string): AgentEvent => ({
  type: 'turn.start',
  at: 1,
  ...(prompt ? { prompt } : {}),
});
const tool = (id: string): AgentEvent => ({
  type: 'tool.start',
  toolUseId: id,
  name: 'Bash',
  input: {},
});
const toolResult = (id: string): AgentEvent => ({
  type: 'tool.result',
  toolUseId: id,
  isError: false,
  content: 'ok',
});
const text = (messageId: string, t: string): AgentEvent => ({
  type: 'text.delta',
  messageId,
  text: t,
});
const kinds = (events: AgentEvent[]) =>
  events.map(
    (e) =>
      `${e.type}${'toolUseId' in e ? `:${e.toolUseId}` : ''}${'messageId' in e ? `:${e.messageId}` : ''}`,
  );

describe('mergeReplay: события, пришедшие во время чтения транскрипта', () => {
  it('то, что транскрипт уже содержит, отбрасывается; новое доигрывается по порядку', () => {
    // история (live — ход открыт): вызов t1 с результатом и текст m1
    const history = [start('сделай'), text('m1', 'Смотрю.'), tool('t1'), toolResult('t1')];
    const pending = [
      text('m1', 'Смо'), // хвост ответа m1 — уже в истории целиком
      tool('t1'),
      toolResult('t1'),
      text('m2', 'Гото'),
      text('m2', 'во'),
      tool('t2'),
      toolResult('t2'),
      result(),
    ];
    const merged = mergeReplay(history, pending);
    expect(merged.history).toEqual(history);
    expect(kinds(merged.replay)).toEqual([
      'text.delta:m2',
      'text.delta:m2',
      'tool.start:t2',
      'tool.result:t2',
      'turn.result',
    ]);
  });

  it('ход закрыт в истории (итог синтезирован) — итог из накопленного не дублируется', () => {
    const history = [start('сделай'), text('m1', 'ok'), result()];
    const merged = mergeReplay(history, [text('m1', 'ok'), result()]);
    expect(merged.replay).toEqual([]);
  });

  it('новый ход во время чтения, промпт уже в транскрипте: итог из истории снят, turn.start не дублируется', () => {
    const history = [start('первый'), result(), start('второй'), text('m2', 'ответ'), result()];
    const pending = [
      start('второй'),
      text('m2', 'ответ'),
      text('m3', 'ещё'),
      result({ totalCostUsd: 0.3 }),
    ];
    const merged = mergeReplay(history, pending);
    expect(kinds(merged.history)).toEqual([
      'turn.start',
      'turn.result',
      'turn.start',
      'text.delta:m2',
    ]);
    expect(kinds(merged.replay)).toEqual(['text.delta:m3', 'turn.result']);
  });

  it('ход закончился и начался следующий (его промпт уже записан) — итог прошлого не закрывает новый', () => {
    // пересев посреди T1 (live): T1 в истории закрыт синтезированным итогом, T2 открыт
    const history = [start('первый'), text('m1', 'a'), result(), start('второй')];
    const pending = [result({ totalCostUsd: 0.2 }), start('второй'), text('m2', 'b')];
    const merged = mergeReplay(history, pending);
    expect(kinds(merged.history)).toEqual(['turn.start', 'text.delta:m1', 'turn.result', 'turn.start']);
    expect(kinds(merged.replay)).toEqual(['text.delta:m2']);
  });

  it('сообщение, влитое в ход и уже записанное репликой, не рисуется второй раз', () => {
    const history = [start('первый'), text('m1', 'a'), start('ещё вопрос')];
    const input: AgentEvent = { type: 'turn.input', prompt: 'ещё вопрос', at: 2 };
    const other: AgentEvent = { type: 'turn.input', prompt: 'другое', at: 3 };
    expect(mergeReplay(history, [input, other]).replay).toEqual([other]);
  });

  it('рассуждение сообщения, чей текст уже в истории, не доигрывается после ответа', () => {
    const history = [start('первый'), text('m1', 'ответ'), tool('t1')];
    const pending: AgentEvent[] = [
      { type: 'thinking.start', messageId: 'm1', at: 1 },
      { type: 'thinking.delta', messageId: 'm1', text: 'думаю' },
      text('m2', 'дальше'),
    ];
    expect(kinds(mergeReplay(history, pending).replay)).toEqual(['text.delta:m2']);
  });

  it('новый ход, которого в транскрипте ещё нет, доигрывается целиком', () => {
    const history = [start('первый'), result()];
    const pending = [start('второй'), text('m2', 'ответ'), result()];
    expect(mergeReplay(history, pending).replay).toEqual(pending);
  });

  it('субагенты: начало и конец агента и их вызовы — по ключам', () => {
    const agentStart: AgentEvent = {
      type: 'agent.start',
      agentId: 'A',
      taskId: 'task1',
      description: 'd',
      taskType: 'local_agent',
      background: false,
    };
    const agentEnd: AgentEvent = {
      type: 'agent.end',
      agentId: 'A',
      taskId: 'task1',
      status: 'completed',
    };
    const sub: AgentEvent = { ...tool('s1'), agentId: 'A' } as AgentEvent;
    const history = [start('x'), agentStart, sub];
    const merged = mergeReplay(history, [agentStart, sub, agentEnd]);
    expect(merged.replay).toEqual([agentEnd]);
  });
});

describe('StreamTail', () => {
  it('держит дельты только текущего ответа основного агента и сбрасывается концом хода', () => {
    const t = new StreamTail();
    t.note(text('m1', 'a'));
    t.note(text('m2', 'b'));
    t.note({ type: 'thinking.delta', messageId: 'm2', text: 'хм' });
    t.note({ ...text('m9', 'субагент'), agentId: 'A' } as AgentEvent);
    expect(kinds(t.snapshot())).toEqual(['text.delta:m2', 'thinking.delta:m2']);
    t.note(result());
    expect(t.snapshot()).toEqual([]);
  });
});
