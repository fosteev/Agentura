import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { CodexEventMapper, tokenUsageOf } from './mapper';
import type { ThreadSession } from './protocol';

interface Fixture {
  cliVersion: string;
  threadStart: ThreadSession;
  notifications: { method: string; params: unknown }[];
}
const fixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/codex/ok-turn.json', import.meta.url), 'utf8'),
) as Fixture;

function replay(mapper: CodexEventMapper, notifications = fixture.notifications): AgentEvent[] {
  return notifications.flatMap((n) => mapper.map(n.method, n.params));
}
const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

const breakdown = (inputTokens: number, cached: number, output: number, reasoning = 0) => ({
  totalTokens: inputTokens + output,
  inputTokens,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});
const turn = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 't1',
  items: [],
  status,
  error: null,
  startedAt: 100,
  completedAt: 101,
  durationMs: 1000,
  ...extra,
});

describe('CodexEventMapper: живая запись хода (fixtures/codex/ok-turn.json)', () => {
  it('session.init из ответа thread/start', () => {
    const init = new CodexEventMapper().init(fixture.threadStart);
    expect(init).toMatchObject({
      type: 'session.init',
      sessionId: fixture.threadStart.thread.id,
      model: fixture.threadStart.model,
      permissionMode: 'default',
      engineVersion: fixture.cliVersion,
    });
    expect(init.cwd).toBe('/tmp/agentura-codex');
  });

  it('ход: turn.start с промптом → text.delta → turn.result ok → context.usage', () => {
    const mapper = new CodexEventMapper();
    mapper.init(fixture.threadStart);
    mapper.notePrompt({ text: 'ответь одним словом OK' });
    const events = replay(mapper);
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'text.delta', 'turn.result']);
    expect(ofType(events, 'turn.start')[0]).toMatchObject({ prompt: 'ответь одним словом OK' });
    const delta = ofType(events, 'text.delta')[0]!;
    expect(delta.text).toBe('OK');
    expect(delta.messageId).toMatch(/^msg_/);
    const result = ofType(events, 'turn.result')[0]!;
    expect(result).toMatchObject({ ok: true, subtype: 'success', interrupted: false, text: 'OK', numTurns: 1 });
    expect(result.usage.output).toBe(5);
    expect(result.usage.cacheRead).toBe(11008);
    // input без кэша: у Codex inputTokens включает cachedInputTokens
    expect(result.usage.input).toBe(20030 - 11008);
    expect(result.contextWindow).toBeGreaterThan(0);
    expect(mapper.contextEvent()).toMatchObject({ type: 'context.usage', source: 'usage', usedTokens: 20035 });
    expect(mapper.activeTurnId).toBeUndefined();
  });

  it('текст берётся из item/completed, если дельт не было', () => {
    const mapper = new CodexEventMapper();
    const noDelta = fixture.notifications.filter((n) => n.method !== 'item/agentMessage/delta');
    const events = replay(mapper, noDelta);
    expect(ofType(events, 'text.delta')).toMatchObject([{ text: 'OK' }]);
  });
});

describe('CodexEventMapper: статусы и ошибки', () => {
  const started = { threadId: 'th', turn: turn('inProgress') };

  it('failed и interrupted — не ok; ошибка уходит событием и не двоится в errors', () => {
    const m = new CodexEventMapper();
    m.threadId = 'th';
    m.map('turn/started', started);
    const err = m.map('error', {
      threadId: 'th',
      turnId: 't1',
      willRetry: false,
      error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
    });
    expect(err).toEqual([{ type: 'error', message: 'usage limit', fatal: false, code: 'usageLimitExceeded' }]);
    const done = m.map('turn/completed', {
      threadId: 'th',
      turn: turn('failed', { error: { message: 'usage limit', codexErrorInfo: null, additionalDetails: null } }),
    });
    expect(done[0]).toMatchObject({ type: 'turn.result', ok: false, subtype: 'error', interrupted: false });
    expect((done[0] as AgentEventOf<'turn.result'>).errors).toBeUndefined();

    m.map('turn/started', started);
    const stopped = m.map('turn/completed', { threadId: 'th', turn: turn('interrupted') });
    expect(stopped[0]).toMatchObject({ ok: false, subtype: 'interrupted', interrupted: true });
  });

  it('ошибка хода без отдельного error попадает в turn.result.errors; willRetry молчит', () => {
    const m = new CodexEventMapper();
    m.map('turn/started', started);
    expect(m.map('error', { threadId: 'th', willRetry: true, error: { message: 'x', codexErrorInfo: null, additionalDetails: null } })).toEqual([]);
    const done = m.map('turn/completed', {
      threadId: 'th',
      turn: turn('failed', { error: { message: 'model not available', codexErrorInfo: { httpConnectionFailed: {} }, additionalDetails: null } }),
    });
    expect((done[0] as AgentEventOf<'turn.result'>).errors).toEqual(['model not available']);
  });

  it('чужой thread и неизвестные методы игнорируются', () => {
    const m = new CodexEventMapper();
    m.threadId = 'mine';
    expect(m.map('turn/started', { threadId: 'other', turn: turn('inProgress') })).toEqual([]);
    expect(m.map('hook/started', { threadId: 'mine' })).toEqual([]);
    expect(m.map('item/commandExecution/outputDelta', { threadId: 'mine', itemId: 'i', delta: 'x' })).toEqual([]);
  });
});

describe('CodexEventMapper: рассуждение и токены', () => {
  it('thinking только при наличии текста; части сводки — абзацы; stop на item/completed', () => {
    const m = new CodexEventMapper(() => 5);
    m.map('turn/started', { threadId: 't', turn: turn('inProgress') });
    expect(m.map('item/reasoning/summaryTextDelta', { itemId: 'r', delta: '', summaryIndex: 0 })).toEqual([]);
    const a = m.map('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'one', summaryIndex: 0 });
    expect(a).toEqual([
      { type: 'thinking.start', messageId: 'r', at: 5 },
      { type: 'thinking.delta', messageId: 'r', text: 'one' },
    ]);
    expect(m.map('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'two', summaryIndex: 1 })).toEqual([
      { type: 'thinking.delta', messageId: 'r', text: '\n\ntwo' },
    ]);
    expect(m.map('item/completed', { item: { type: 'reasoning', id: 'r', summary: [], content: [] } })).toEqual([
      { type: 'thinking.stop', messageId: 'r', at: 5 },
    ]);
    // незакрытое рассуждение закрывается на конце хода
    m.map('item/reasoning/textDelta', { itemId: 'r2', delta: 'x', contentIndex: 0 });
    const done = m.map('turn/completed', { threadId: 't', turn: turn('completed') });
    expect(done.map((e) => e.type)).toEqual(['thinking.stop', 'turn.result']);
  });

  it('usage хода — разность total между обновлениями, а не сумма last', () => {
    const m = new CodexEventMapper();
    m.map('turn/started', { threadId: 't', turn: turn('inProgress') });
    const upd = (total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) =>
      m.map('thread/tokenUsage/updated', { threadId: 't', turnId: 't1', tokenUsage: { total, last, modelContextWindow: 1000 } });
    upd(breakdown(100, 40, 10), breakdown(100, 40, 10));
    upd(breakdown(100, 40, 10), breakdown(100, 40, 10)); // повтор того же обновления
    upd(breakdown(250, 140, 30, 5), breakdown(150, 100, 20, 5));
    const result = m.map('turn/completed', { threadId: 't', turn: turn('completed') })[0] as AgentEventOf<'turn.result'>;
    expect(result.usage).toEqual({ input: 110, output: 30, cacheRead: 140, cacheWrite: 0, thinking: 5 });
    expect(m.contextEvent()).toMatchObject({ usedTokens: 170, maxTokens: 1000, percentage: 17 });

    // следующий ход считается от прежнего total
    m.map('turn/started', { threadId: 't', turn: turn('inProgress') });
    upd(breakdown(300, 190, 40, 5), breakdown(50, 50, 10));
    const next = m.map('turn/completed', { threadId: 't', turn: turn('completed') })[0] as AgentEventOf<'turn.result'>;
    expect(next.usage).toMatchObject({ input: 0, output: 10, cacheRead: 50 });
  });

  it('первое обновление после resume: база — total минус last', () => {
    const m = new CodexEventMapper();
    m.map('turn/started', { threadId: 't', turn: turn('inProgress') });
    m.map('thread/tokenUsage/updated', {
      threadId: 't',
      turnId: 't1',
      tokenUsage: { total: breakdown(5000, 4000, 300), last: breakdown(200, 100, 20), modelContextWindow: null },
    });
    const result = m.map('turn/completed', { threadId: 't', turn: turn('completed') })[0] as AgentEventOf<'turn.result'>;
    expect(result.usage).toMatchObject({ input: 100, output: 20, cacheRead: 100 });
    expect(m.contextEvent()?.maxTokens).toBeUndefined();
  });

  it('total сервера уменьшился (сброс) — usage хода не отрицательный', () => {
    const m = new CodexEventMapper();
    m.map('turn/started', { threadId: 't', turn: turn('inProgress') });
    const upd = (total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) =>
      m.map('thread/tokenUsage/updated', { threadId: 't', turnId: 't1', tokenUsage: { total, last, modelContextWindow: 1000 } });
    upd(breakdown(1000, 400, 100), breakdown(1000, 400, 100));
    upd(breakdown(300, 100, 20), breakdown(300, 100, 20));
    const result = m.map('turn/completed', { threadId: 't', turn: turn('completed') })[0] as AgentEventOf<'turn.result'>;
    for (const v of Object.values(result.usage)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('turn/completed чужого хода не закрывает текущий', () => {
    const m = new CodexEventMapper();
    m.map('turn/started', { threadId: 't', turn: turn('inProgress') });
    expect(m.map('turn/completed', { threadId: 't', turn: { ...turn('completed'), id: 'other' } })).toEqual([]);
    expect(ofType(m.map('turn/completed', { threadId: 't', turn: turn('completed') }), 'turn.result')).toHaveLength(1);
  });

  it('tokenUsageOf не уходит в минус', () => {
    expect(tokenUsageOf(breakdown(10, 20, 1)).input).toBe(0);
  });
});

describe('CodexEventMapper: субагенты', () => {
  it('spawnAgent связывает дочерний тред с prompt, моделью и итоговым состоянием', () => {
    const m = new CodexEventMapper();
    m.threadId = 'root';
    const started = m.map('item/started', {
      threadId: 'root',
      item: {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'root',
        receiverThreadIds: ['child'],
        prompt: 'Find test gaps',
        model: 'gpt-6-luna',
        reasoningEffort: 'high',
        agentsStates: { child: { status: 'running', message: null } },
      },
    });
    expect(started).toEqual([
      {
        type: 'agent.start',
        agentId: 'child',
        taskId: 'child',
        description: 'Find test gaps',
        taskType: 'subagent',
        subagentType: 'gpt-6-luna',
        background: false,
      },
      { type: 'agent.progress', agentId: 'child', taskId: 'child', status: 'running' },
    ]);
    const done = m.map('item/completed', {
      threadId: 'root',
      item: {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'root',
        receiverThreadIds: ['child'],
        prompt: 'Find test gaps',
        model: 'gpt-6-luna',
        reasoningEffort: 'high',
        agentsStates: { child: { status: 'completed', message: 'No gaps found' } },
      },
    });
    expect(done).toEqual([
      { type: 'agent.end', agentId: 'child', taskId: 'child', status: 'completed', summary: 'No gaps found' },
    ]);
  });

  it('subAgentActivity closes a known nested agent once', () => {
    const m = new CodexEventMapper();
    m.threadId = 'root';
    const spawned = {
      type: 'collabAgentToolCall',
      id: 'call-2',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    };
    m.map('item/started', { threadId: 'root', item: spawned });
    expect(m.map('item/started', { threadId: 'root', item: { type: 'subAgentActivity', id: 'a', kind: 'interacted', agentThreadId: 'child', agentPath: '/root/parent/child' } })).toEqual([
      { type: 'agent.progress', agentId: 'child', taskId: 'child', status: 'working' },
    ]);
    expect(m.map('item/completed', { threadId: 'root', item: { type: 'subAgentActivity', id: 'a', kind: 'completed', agentThreadId: 'child', agentPath: '/root/parent/child' } })).toEqual([
      { type: 'agent.end', agentId: 'child', taskId: 'child', status: 'completed' },
    ]);
    expect(m.map('item/completed', { threadId: 'root', item: spawned })).toEqual([]);
  });

  it('interruptAgent завершает уже известного субагента по agentsStates', () => {
    const m = new CodexEventMapper();
    m.threadId = 'root';
    m.map('item/started', {
      threadId: 'root',
      item: {
        type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed', senderThreadId: 'root',
        receiverThreadIds: ['child'], prompt: null, model: null, reasoningEffort: null,
        agentsStates: { child: { status: 'running', message: null } },
      },
    });
    expect(m.map('item/completed', {
      threadId: 'root',
      item: {
        type: 'collabAgentToolCall', id: 'stop', tool: 'interruptAgent', status: 'completed', senderThreadId: 'root',
        receiverThreadIds: ['child'], prompt: null, model: null, reasoningEffort: null,
        agentsStates: { child: { status: 'interrupted', message: 'Stopped by parent' } },
      },
    })).toEqual([
      { type: 'agent.end', agentId: 'child', taskId: 'child', status: 'stopped', summary: 'Stopped by parent' },
    ]);
  });
});

describe('CodexEventMapper: синтетический ход', () => {
  it('turn.start → error → turn.result для отклонённого turn/start', () => {
    const m = new CodexEventMapper();
    const events = m.syntheticTurn({ text: 'hi' }, { message: 'boom' });
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'error', 'turn.result']);
    expect(events[2]).toMatchObject({ ok: false, interrupted: false });
    expect(m.syntheticTurn({ text: 'hi' }, { interrupted: true }).map((e) => e.type)).toEqual(['turn.start', 'turn.result']);
  });

  it('картинки промпта идут в turn.start как ImageRef', () => {
    const m = new CodexEventMapper();
    m.notePrompt({ text: 'look', images: [{ mediaType: 'image/png', data: 'AAAA', name: 'shot' }] });
    const start = m.map('turn/started', { threadId: 't', turn: turn('inProgress') })[0] as AgentEventOf<'turn.start'>;
    expect(start.images).toEqual([{ mediaType: 'image/png', data: 'AAAA', name: 'shot' }]);
  });
});
