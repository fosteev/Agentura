import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf, AgentSession } from '../types';
import { nextStatus, updatePending, type ChatStatus } from '../status';
import { KimiAdapter } from './adapter';
import { FakeKimiAcp, createFakeKimiServer, DEFAULT_KIMI_SESSION_ID } from './fakeServer';

interface FixtureFrame {
  dir: string;
  scenario: string;
  msg: { method?: string; params?: Record<string, unknown> };
}

function fixtureRequest(file: string, scenario: string, method: string): Record<string, unknown> {
  const frames = readFileSync(join(__dirname, '../../../test/fixtures/kimi', file), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as FixtureFrame);
  const frame = frames.find((item) => item.dir === 'out' && item.scenario === scenario && item.msg.method === method);
  if (!frame?.msg.params) throw new Error(`Missing ${file}/${scenario}/${method}`);
  return frame.msg.params;
}

function setup(server: FakeKimiAcp) {
  const adapter = new KimiAdapter({
    executablePath: '/bin/kimi',
    spawn: () => server,
    graceMs: 20,
    interruptWaitMs: 100,
  });
  return adapter;
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((event) => events.push(event));
  return events;
}

async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout: ${what}`);
}

async function ready(server: FakeKimiAcp, options: { allowBypassPermissions?: boolean } = {}) {
  const session = await setup(server).createSession({ cwd: '/work', ...options });
  const events = collect(session);
  await session.capabilities();
  return { session, events };
}

describe('Kimi interactive ACP contracts on live fixtures', () => {
  it.each([
    ['permission-allow-once', 'allow', 'approve_once'],
    ['permission-allow-session', 'allow-always', 'approve_always'],
    ['permission-deny', 'deny', 'reject'],
  ] as const)('%s maps the user decision to the native option', async (scenario, decision, optionId) => {
    const server = createFakeKimiServer();
    const params = fixtureRequest('acp-basic.ndjson', scenario, 'session/request_permission');
    let finish!: (result: unknown) => void;
    server.handle('session/prompt', () => {
      server.request('permission', 'session/request_permission', params);
      return new Promise((resolve) => (finish = resolve));
    });
    const { session, events } = await ready(server);
    session.send(scenario);
    await until(() => events.some((event) => event.type === 'permission.request'), 'permission.request');
    const request = events.find((event) => event.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(request.toolUseId).toBe(params.toolCall && (params.toolCall as { toolCallId: string }).toolCallId);
    expect(request.canAlwaysAllow).toBe(true);
    expect(request.always).toMatchObject({ destination: 'session' });

    expect(session.respondPermission(request.toolUseId, decision)).toBe(true);
    expect(server.replies().find((reply) => reply.id === 'permission')?.result).toEqual({
      outcome: { outcome: 'selected', optionId },
    });
    expect(events.find((event) => event.type === 'permission.resolved')).toMatchObject({
      toolUseId: request.toolUseId, decision: decision === 'deny' ? 'deny' : 'allow', by: 'user',
    });
    finish({ stopReason: 'end_turn' });
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');
    session.dispose();
  });

  it('deny never falls back to allow when the request has no reject option', async () => {
    const server = createFakeKimiServer();
    const params = fixtureRequest('acp-basic.ndjson', 'permission-allow-once', 'session/request_permission');
    params.options = [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' }];
    server.handle('session/prompt', () => {
      server.request('no-reject', 'session/request_permission', params);
      return new Promise(() => {});
    });
    const { session, events } = await ready(server);
    session.send('deny safely');
    await until(() => events.some((event) => event.type === 'permission.request'), 'permission without reject');
    const request = events.find((event) => event.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(session.respondPermission(request.toolUseId, 'deny')).toBe(false);
    expect(server.replies()).toHaveLength(0);
    session.dispose();
    expect(server.replies().some((reply) => JSON.stringify(reply.result).includes('approve_once'))).toBe(false);
  });

  it('bypass auto-answers only ordinary permission, never a plan review', async () => {
    const server = createFakeKimiServer();
    const permission = fixtureRequest('acp-basic.ndjson', 'permission-allow-once', 'session/request_permission');
    server.handle('session/prompt', () => {
      server.request('bypass', 'session/request_permission', permission);
      return { stopReason: 'end_turn' };
    });
    const { session, events } = await ready(server, { allowBypassPermissions: true });
    await session.setMode('bypassPermissions');
    session.send('run');
    await until(() => server.replies().some((reply) => reply.id === 'bypass'), 'bypass reply');
    expect(server.replies().find((reply) => reply.id === 'bypass')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    });
    expect(events.some((event) => event.type === 'permission.request')).toBe(false);
    session.dispose();
  });

  it('Stop and dispose settle pending permission/form/plan reverse requests', async () => {
    for (const action of ['stop', 'dispose'] as const) {
      const server = createFakeKimiServer();
      const permission = fixtureRequest('acp-basic.ndjson', 'permission-cancel', 'session/request_permission');
      const question = fixtureRequest('acp-plan-questions.ndjson', 'question-single', 'elicitation/create');
      const plan = fixtureRequest('acp-plan-questions.ndjson', 'plan-initial', 'session/request_permission');
      let finish!: (result: unknown) => void;
      server.handle('session/prompt', () => {
        server.request('p', 'session/request_permission', permission);
        server.request('q', 'elicitation/create', question);
        server.request('r', 'session/request_permission', plan);
        return new Promise((resolve) => (finish = resolve));
      });
      const { session, events } = await ready(server);
      session.send('wait');
      await until(() => events.some((event) => event.type === 'plan.request'), 'all cards');
      if (action === 'stop') {
        const stopping = session.interrupt();
        finish({ stopReason: 'cancelled' });
        await stopping;
      } else session.dispose();
      const replies = server.replies();
      expect(replies.find((reply) => reply.id === 'p')?.result).toEqual({ outcome: { outcome: 'cancelled' } });
      expect(replies.find((reply) => reply.id === 'q')?.result).toEqual({ action: 'cancel' });
      expect(replies.find((reply) => reply.id === 'r')?.result).toEqual({ outcome: { outcome: 'cancelled' } });
      const abortEvents = events.filter(
        (event): event is AgentEventOf<'permission.resolved'> =>
          event.type === 'permission.resolved' && event.by === 'abort',
      );
      expect(abortEvents.length).toBe(3);
      expect(abortEvents.every((e) => e.decision === 'deny')).toBe(true);
    }
  });

  it('plan revise sends feedback as the next live prompt, then approves without a hanging turn', async () => {
    const server = createFakeKimiServer();
    const initial = fixtureRequest('acp-plan-questions.ndjson', 'plan-initial', 'session/request_permission');
    const revised = fixtureRequest('acp-plan-questions.ndjson', 'plan-revised', 'session/request_permission');
    const finishes: ((result: unknown) => void)[] = [];
    const prompts: string[] = [];
    server.handle('session/prompt', (params) => {
      const blocks = params.prompt as { type: string; text?: string }[];
      prompts.push(blocks.find((block) => block.type === 'text')?.text ?? '');
      server.request(`plan-${prompts.length}`, 'session/request_permission', prompts.length === 1 ? initial : revised);
      return new Promise((resolve) => finishes.push(resolve));
    });
    const { session, events } = await ready(server);
    session.send('plan');
    await until(() => events.some((event) => event.type === 'plan.request'), 'initial plan');
    const first = events.find((event) => event.type === 'plan.request') as AgentEventOf<'plan.request'>;
    expect(first.plan).toContain('# Synthetic plan for PLAN_MARKER_1201');
    expect(first.plan).not.toContain('Plan saved to:');
    expect(first.planFilePath).toBe('<SESSION>/agents/main/plans/jade-orphan-bobbi-morse.md');

    expect(session.decidePlan(first.toolUseId, { approve: false, feedback: 'REVISION_MARKER_1202' })).toBe(true);
    expect(server.replies().find((reply) => reply.id === 'plan-1')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'plan_revise' },
    });
    finishes[0]!({ stopReason: 'end_turn' });
    await until(() => prompts.length === 2, 'feedback prompt');
    expect(prompts[1]).toBe('REVISION_MARKER_1202');
    await until(() => events.filter((event) => event.type === 'plan.request').length === 2, 'revised plan');
    const second = events.filter((event) => event.type === 'plan.request').at(-1)!;
    expect(second.plan).toContain('REVISION_MARKER_1202');
    expect(session.decidePlan(second.toolUseId, { approve: true })).toBe(true);
    expect(server.replies().find((reply) => reply.id === 'plan-2')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'plan_approve' },
    });
    finishes[1]!({ stopReason: 'end_turn' });
    await until(() => events.filter((event) => event.type === 'turn.result').length === 2, 'two completed turns');
    session.dispose();
  });

  it('preserves native plan_opt_N and supports plan_reject_and_exit', async () => {
    const server = createFakeKimiServer();
    const options = fixtureRequest('acp-plan-questions.ndjson', 'plan-options', 'session/request_permission');
    let finish!: (result: unknown) => void;
    server.handle('session/prompt', () => {
      server.request('options', 'session/request_permission', options);
      return new Promise((resolve) => (finish = resolve));
    });
    const { session, events } = await ready(server);
    session.send('options');
    await until(() => events.some((event) => event.type === 'plan.request'), 'options plan');
    const plan = events.find((event) => event.type === 'plan.request') as AgentEventOf<'plan.request'>;
    expect(plan.options).toEqual([
      { id: 'plan_opt_0', label: 'OPTION_ALPHA_1301' },
      { id: 'plan_opt_1', label: 'OPTION_BETA_1301' },
    ]);
    expect(session.decidePlan(plan.toolUseId, { approve: true, optionId: 'plan_opt_1' })).toBe(true);
    expect(server.replies().find((reply) => reply.id === 'options')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'plan_opt_1' },
    });
    finish({ stopReason: 'end_turn' });
    session.dispose();

    const rejecting = createFakeKimiServer();
    const initial = fixtureRequest('acp-plan-questions.ndjson', 'plan-initial', 'session/request_permission');
    let cancel!: (result: unknown) => void;
    rejecting.handle('session/prompt', () => {
      rejecting.request('reject', 'session/request_permission', initial);
      return new Promise((resolve) => (cancel = resolve));
    });
    const next = await ready(rejecting);
    next.session.send('plan');
    await until(() => next.events.some((event) => event.type === 'plan.request'), 'reject plan');
    const request = next.events.find((event) => event.type === 'plan.request')!;
    expect(next.session.decidePlan(request.toolUseId, { approve: false, feedback: '', interrupt: true })).toBe(true);
    expect(rejecting.replies().find((reply) => reply.id === 'reject')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'plan_reject_and_exit' },
    });
    cancel({ stopReason: 'cancelled' });
    await until(() => next.events.some((event) => event.type === 'turn.result'), 'cancelled plan turn');
    next.session.dispose();
  });

  it.each([
    ['question-single', { q0: 'BETA' }, { q0: 'BETA' }],
    ['question-multi', { q0: 'ONE', q1: 'RED, BLUE' }, { q0: 'ONE', q1: ['RED', 'BLUE'] }],
  ] as const)('%s uses q0-based declared form order and exact const values', async (scenario, answers, content) => {
    const server = createFakeKimiServer();
    const params = fixtureRequest('acp-plan-questions.ndjson', scenario, 'elicitation/create');
    server.handle('session/prompt', () => {
      server.request('question', 'elicitation/create', params);
      return new Promise(() => {});
    });
    const { session, events } = await ready(server);
    session.send('question');
    await until(() => events.some((event) => event.type === 'question.request'), 'question.request');
    const request = events.find((event) => event.type === 'question.request') as AgentEventOf<'question.request'>;
    expect(request.questions.map((question) => question.multiSelect)).toEqual(
      scenario === 'question-multi' ? [false, true] : [false],
    );
    expect(session.answerQuestion(request.toolUseId, answers)).toBe(true);
    expect(server.replies().find((reply) => reply.id === 'question')?.result).toEqual({ action: 'accept', content });
    const resolved = events.find((event) => event.type === 'permission.resolved' && event.toolUseId === request.toolUseId);
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: request.toolUseId,
      decision: 'allow',
      by: 'user',
    });
    session.dispose();
  });

  it('declines Other/dismissal instead of inventing q0_other and maps fallback permission single-select', async () => {
    const server = createFakeKimiServer();
    const other = fixtureRequest('acp-plan-questions.ndjson', 'question-other', 'elicitation/create');
    server.handle('session/prompt', () => {
      server.request('other', 'elicitation/create', other);
      return new Promise(() => {});
    });
    const { session, events } = await ready(server);
    session.send('other');
    await until(() => events.some((event) => event.type === 'question.request'), 'Other question');
    const request = events.find((event) => event.type === 'question.request') as AgentEventOf<'question.request'>;
    expect(session.answerQuestion(request.toolUseId, { q0: 'CUSTOM_OTHER' })).toBe(true);
    expect(server.replies().find((reply) => reply.id === 'other')?.result).toEqual({ action: 'decline' });
    session.dispose();

    const fallbackServer = createFakeKimiServer();
    const fallback = fixtureRequest('acp-question-fallback.ndjson', 'question-no-elicit', 'session/request_permission');
    fallbackServer.handle('session/prompt', () => {
      fallbackServer.request('fallback', 'session/request_permission', fallback);
      return new Promise(() => {});
    });
    const next = await ready(fallbackServer);
    next.session.send('fallback');
    await until(() => next.events.some((event) => event.type === 'question.request'), 'fallback question');
    const card = next.events.find((event) => event.type === 'question.request') as AgentEventOf<'question.request'>;
    expect(card.questions).toEqual([{
      question: 'NO_ELICIT_MARKER_904?', options: [{ label: 'ALPHA' }, { label: 'BETA' }], multiSelect: false,
    }]);
    expect(next.session.answerQuestion(card.toolUseId, { q0: 'BETA' })).toBe(true);
    expect(fallbackServer.replies().find((reply) => reply.id === 'fallback')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
    });
    const fallbackResolved = next.events.find(
      (event) => event.type === 'permission.resolved' && event.toolUseId === card.toolUseId,
    );
    expect(fallbackResolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: card.toolUseId,
      decision: 'allow',
      by: 'user',
    });
    next.session.dispose();
  });

  it('declines question via respondPermission deny with elicitationDecline and permission.resolved deny/user', async () => {
    const server = createFakeKimiServer();
    const params = fixtureRequest('acp-plan-questions.ndjson', 'question-single', 'elicitation/create');
    let promptResolve!: (val: unknown) => void;
    server.handle('session/prompt', () => {
      server.request('question', 'elicitation/create', params);
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    });
    const { session, events } = await ready(server);
    session.send('ask me');
    await until(() => events.some((event) => event.type === 'question.request'), 'question.request');
    const request = events.find((event) => event.type === 'question.request') as AgentEventOf<'question.request'>;

    let pending: string[] = [];
    let status: ChatStatus = 'idle';
    for (const e of events) {
      pending = updatePending(pending, e);
      status = nextStatus(status, e, pending.length);
    }
    expect(status).toBe('waiting');
    expect(pending).toEqual([request.toolUseId]);

    // allow is rejected for questions
    expect(session.respondPermission(request.toolUseId, 'allow')).toBe(false);

    // deny declines question
    expect(session.respondPermission(request.toolUseId, 'deny')).toBe(true);

    await until(() => server.replies().some((reply) => reply.id === 'question'), 'reply question');
    expect(server.replies().find((reply) => reply.id === 'question')?.result).toEqual({ action: 'decline' });

    const resolved = events.find((event) => event.type === 'permission.resolved' && event.toolUseId === request.toolUseId);
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: request.toolUseId,
      decision: 'deny',
      by: 'user',
    });

    promptResolve({ stopReason: 'end_turn' });
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');

    pending = [];
    status = 'idle';
    for (const e of events) {
      pending = updatePending(pending, e);
      status = nextStatus(status, e, pending.length);
    }
    expect(status).toBe('idle');
    expect(pending).toEqual([]);

    session.dispose();
  });

  it('declines questionFallback via respondPermission deny using q0_skip', async () => {
    const server = createFakeKimiServer();
    const fallback = fixtureRequest('acp-question-fallback.ndjson', 'question-no-elicit', 'session/request_permission');
    let promptResolve!: (val: unknown) => void;
    server.handle('session/prompt', () => {
      server.request('fallback_req', 'session/request_permission', fallback);
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    });
    const { session, events } = await ready(server);
    session.send('fallback');
    await until(() => events.some((event) => event.type === 'question.request'), 'fallback question');
    const card = events.find((event) => event.type === 'question.request') as AgentEventOf<'question.request'>;

    expect(session.respondPermission(card.toolUseId, 'allow')).toBe(false);
    expect(session.respondPermission(card.toolUseId, 'deny')).toBe(true);

    await until(() => server.replies().some((reply) => reply.id === 'fallback_req'), 'reply fallback_req');
    expect(server.replies().find((reply) => reply.id === 'fallback_req')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'q0_skip' },
    });

    const resolved = events.find((event) => event.type === 'permission.resolved' && event.toolUseId === card.toolUseId);
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: card.toolUseId,
      decision: 'deny',
      by: 'user',
    });

    promptResolve({ stopReason: 'end_turn' });
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');

    session.dispose();
  });

  it('server timeout on question (tool.result update) auto-resolves card as deny/abort without extra respond', async () => {
    const server = createFakeKimiServer();
    const params = fixtureRequest('acp-plan-questions.ndjson', 'question-single', 'elicitation/create');
    let promptResolve!: (val: unknown) => void;
    server.handle('session/prompt', () => {
      server.request('timeout_q', 'elicitation/create', params);
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    });
    const { session, events } = await ready(server);
    session.send('ask me');
    await until(() => events.some((event) => event.type === 'question.request'), 'question.request');
    const request = events.find((event) => event.type === 'question.request') as AgentEventOf<'question.request'>;

    // Server sends tool_call completed update without waiting for client answer
    server.notify('session/update', {
      sessionId: DEFAULT_KIMI_SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: request.toolUseId,
        status: 'completed',
        rawOutput: { action: 'accept', content: { q0: 'BETA' } },
      },
    });

    await until(
      () => events.some((event) => event.type === 'permission.resolved' && event.toolUseId === request.toolUseId),
      'permission.resolved on timeout',
    );
    const resolved = events.find((event) => event.type === 'permission.resolved' && event.toolUseId === request.toolUseId);
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: request.toolUseId,
      decision: 'deny',
      by: 'abort',
    });

    // Verify no client.respond was sent to the server for timeout_q
    expect(server.replies().some((r) => r.id === 'timeout_q')).toBe(false);

    promptResolve({ stopReason: 'end_turn' });
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');

    let pending: string[] = [];
    let status: ChatStatus = 'idle';
    for (const e of events) {
      pending = updatePending(pending, e);
      status = nextStatus(status, e, pending.length);
    }
    expect(status).toBe('idle');
    expect(pending).toEqual([]);

    session.dispose();
  });

  it('decidePlan emits permission.resolved for approve and refine/reject', async () => {
    const server = createFakeKimiServer();
    const planFixture = fixtureRequest('acp-plan-questions.ndjson', 'plan-initial', 'session/request_permission');
    let promptResolve!: (val: unknown) => void;
    server.handle('session/prompt', () => {
      server.request('plan_req_1', 'session/request_permission', planFixture);
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    });
    const { session, events } = await ready(server);
    session.send('plan');
    await until(() => events.some((event) => event.type === 'plan.request'), 'plan.request');
    const planReq = events.find((event) => event.type === 'plan.request') as AgentEventOf<'plan.request'>;

    let pending: string[] = [];
    let status: ChatStatus = 'idle';
    for (const e of events) {
      pending = updatePending(pending, e);
      status = nextStatus(status, e, pending.length);
    }
    expect(status).toBe('waiting');
    expect(pending).toEqual([planReq.toolUseId]);

    // Approve plan
    expect(session.decidePlan(planReq.toolUseId, { approve: true })).toBe(true);

    await until(
      () => events.some((event) => event.type === 'permission.resolved' && event.toolUseId === planReq.toolUseId),
      'plan permission.resolved',
    );
    const resolved = events.find((event) => event.type === 'permission.resolved' && event.toolUseId === planReq.toolUseId);
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: planReq.toolUseId,
      decision: 'allow',
      by: 'user',
    });

    pending = [];
    status = 'idle';
    for (const e of events) {
      pending = updatePending(pending, e);
      status = nextStatus(status, e, pending.length);
    }
    expect(status).toBe('working');
    expect(pending).toEqual([]);

    promptResolve({ stopReason: 'end_turn' });
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');

    pending = [];
    status = 'idle';
    for (const e of events) {
      pending = updatePending(pending, e);
      status = nextStatus(status, e, pending.length);
    }
    expect(status).toBe('idle');
    expect(pending).toEqual([]);

    session.dispose();
  });
});
