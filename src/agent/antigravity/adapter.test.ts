import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseElicitation, formatElicitationAnswer } from './acpProtocol';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf, AgentSession, PromptImage } from '../types';
import {
  AntigravityAdapter,
  type AntigravityAdapterConfig,
  type AgySpawnOptions,
} from './adapter';
import { AGY_NOT_FOUND } from './executable';
import { createFakeAgyServer, FakeAgyAcp, DEFAULT_SESSION_ID, FAKE_MODELS, FAKE_MODES, makeConfigOptions } from './fakeServer';
import { memoryStore } from './sessionIndex';

function setup(s: FakeAgyAcp = createFakeAgyServer(), config: Partial<AntigravityAdapterConfig> = {}) {
  const logs: string[] = [];
  const spawned: { path: string; args: string[]; options: AgySpawnOptions }[] = [];
  const adapter = new AntigravityAdapter({
    executablePath: '/bin/agy',
    engineVersion: '1.5.3',
    spawn: (path, args, options) => {
      spawned.push({ path, args, options });
      return s;
    },
    graceMs: 20,
    interruptWaitMs: 50,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...config,
  });
  return { adapter, logs, spawned, server: s };
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((e) => events.push(e));
  return events;
}

async function until(cond: () => boolean, what = 'condition', max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout: ${what}`);
}

describe('AntigravityAdapter (ACP)', () => {
  it('uses real elicitation titles and round-trips selected answers', () => {
    const frames = readFileSync(join(__dirname, '../../../test/fixtures/antigravity/acp-pong.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const params = frames.find((frame) => frame.msg.method === 'elicitation/create').msg.params;
    const parsed = parseElicitation(params)!;
    expect(parsed.questions.map((q) => q.question)).toEqual(['Env?', 'Checks?']);
    expect(formatElicitationAnswer(parsed.properties, parsed.questions, {
      'Env?': 'prod', 'Checks?': 'test, typecheck',
    })).toEqual({ action: 'accept', content: { q1: '2', q2: ['2', '3'] } });
  });

  it('restores accepted settings across adapters instead of ACP process defaults', async () => {
    const state = memoryStore();
    const first = setup(createFakeAgyServer(), { state });
    const session = await first.adapter.createSession({ cwd: '/work', model: 'gemini-3.8-flash', effort: 'low' });
    await session.capabilities();
    await session.setModel('claude-sonnet-5-5');
    await session.setEffort('high');
    await session.setMode('plan');
    const id = session.id;
    session.dispose();

    const loader = createFakeAgyServer();
    loader.handle('session/load', () => ({ configOptions: makeConfigOptions('gemini-4-argon', 'medium', 'default') }));
    const history = await setup(loader, { state }).adapter.loadHistory(id, '/work');
    expect(history).toMatchObject({ model: 'claude-sonnet-5-5', mode: 'plan' });

    const next = setup(createFakeAgyServer(), { state });
    const resumed = await next.adapter.resumeSession(id, { cwd: '/work', model: history.model, permissionMode: history.mode });
    const events = collect(resumed);
    await resumed.capabilities();
    expect(events.find((e) => e.type === 'session.init')).toMatchObject({
      model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'plan',
    });
    resumed.dispose();
  });

  it('does not persist a rejected model and gates saved bypass permissions on resume', async () => {
    const state = memoryStore();
    const s = createFakeAgyServer();
    const first = setup(s, { state });
    const session = await first.adapter.createSession({ cwd: '/work', model: 'gemini-3.8-flash',
      permissionMode: 'bypassPermissions', allowBypassPermissions: true });
    await session.capabilities();
    s.handle('session/set_config_option', () => { throw new Error('model rejected'); });
    await session.setModel('invalid');
    const id = session.id;
    session.dispose();
    const resumed = await setup(createFakeAgyServer(), { state }).adapter.resumeSession(id, { cwd: '/work' });
    const events = collect(resumed);
    await resumed.capabilities();
    expect(events.find((e) => e.type === 'session.init')).toMatchObject({ model: 'gemini-3.8-flash', permissionMode: 'default' });
    resumed.dispose();
  });

  it('pong: initialize -> session/new -> prompt -> text chunk -> turn.result', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', (params) => {
      s.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'session_info_update', title: 'Pong Chat' },
      });
      s.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
      });
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 15 },
      };
    });

    const { adapter, spawned } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    const init = events.find((e) => e.type === 'session.init');
    expect(init).toMatchObject({
      type: 'session.init',
      sessionId: DEFAULT_SESSION_ID,
      cwd: '/work',
      permissionMode: 'default',
    });

    session.send('ping');
    await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

    const result = events.find((e) => e.type === 'turn.result');
    expect(result).toMatchObject({
      type: 'turn.result',
      ok: true,
      subtype: 'end_turn',
      text: 'pong',
      usageKnown: true,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });

    expect(spawned[0]?.args).toEqual(['acp']);
    session.dispose();
  });

  it('thinking chunks: agent_thought_chunk produces thinking.start and thinking.delta, closed by text', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', (params) => {
      s.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } },
      });
      s.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '42' } },
      });
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 2, totalTokens: 10 },
      };
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('what is the answer?');
    await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

    const types = events.map((e) => e.type);
    expect(types).toContain('thinking.start');
    expect(types).toContain('thinking.delta');
    expect(types).toContain('thinking.stop');
    expect(types).toContain('text.delta');
    expect(types).toContain('turn.result');

    session.dispose();
  });

  it('images: sending PromptImage formats ACP image blocks', async () => {
    const s = createFakeAgyServer();
    let receivedPrompt: unknown;
    s.handle('session/prompt', (params) => {
      receivedPrompt = params.prompt;
      return { stopReason: 'end_turn' };
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

    const img: PromptImage = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', mediaType: 'image/png' };
    session.send('inspect image', [img]);

    await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');
    expect(receivedPrompt).toEqual([
      { type: 'image', data: img.data, mimeType: 'image/png' },
      { type: 'text', text: 'inspect image' },
    ]);

    session.dispose();
  });

  it('model and effort switching, and graceful gpt-oss handling', async () => {
    const s = createFakeAgyServer();
    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work', model: 'gemini-3.8-flash', effort: 'low' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

    // Switch model to gpt-oss-120b-medium
    await session.setModel('gpt-oss-120b-medium');
    expect(s.paramsOf('session/set_config_option', 2)).toMatchObject({
      configId: 'model',
      value: 'gpt-oss-120b-medium',
    });

    // Setting effort while on gpt-oss should not crash (no thought_level in configOptions)
    await session.setEffort('high');

    // Switching back to gemini-4-argon should re-sync the effort
    await session.setModel('gemini-4-argon');
    const setConfigs = s.received.filter((m) => m.method === 'session/set_config_option');
    const lastThoughtConfig = setConfigs.filter((m) => (m.params as { configId?: string })?.configId === 'thought_level').pop();
    expect(lastThoughtConfig?.params).toMatchObject({
      configId: 'thought_level',
      value: 'high',
    });

    session.dispose();
  });

  it('mode switching and allowBypassPermissions', async () => {
    const s = createFakeAgyServer();
    const { adapter } = setup(s);

    // Initial session with acceptEdits
    const session1 = await adapter.createSession({ cwd: '/work', permissionMode: 'acceptEdits' });
    await until(() => s.methods().includes('session/set_mode'), 'session/set_mode');
    expect(s.paramsOf('session/set_mode')).toMatchObject({ modeId: 'accept-edits' });
    session1.dispose();

    // Bypass permissions with allowBypassPermissions: true -> accept-edits
    const s2 = createFakeAgyServer();
    const { adapter: adapter2 } = setup(s2);
    const session2 = await adapter2.createSession({
      cwd: '/work',
      permissionMode: 'bypassPermissions',
      allowBypassPermissions: true,
    });
    await until(() => s2.methods().includes('session/set_mode'), 'session/set_mode');
    expect(s2.paramsOf('session/set_mode')).toMatchObject({ modeId: 'accept-edits' });
    session2.dispose();

    // Bypass permissions with allowBypassPermissions: false -> default (no set_mode needed)
    const s3 = createFakeAgyServer();
    const { adapter: adapter3 } = setup(s3);
    const session3 = await adapter3.createSession({
      cwd: '/work',
      permissionMode: 'bypassPermissions',
      allowBypassPermissions: false,
    });
    const events3 = collect(session3);
    await until(() => events3.some((e) => e.type === 'session.init'), 'session.init');
    expect(s3.methods().filter((m) => m === 'session/set_mode')).toHaveLength(0);
    session3.dispose();
  });

  it('live permission request: emits permission.request, supports allow, allow-edits, deny', async () => {
    const s = createFakeAgyServer();
    let promptResolve!: (val: unknown) => void;
    s.handle('session/prompt', (params) => {
      s.request('req_perm_1', 'session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call_edit_1',
          name: 'edit_file',
          args: { Path: '/work/file.txt', Target: 'old text', Replacement: 'new text' },
          title: 'Editing file.txt',
        },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'deny', kind: 'reject_once' },
        ],
      });
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('edit something');

    await until(() => events.some((e) => e.type === 'permission.request'), 'permission.request');
    const permReq = events.find((e) => e.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(permReq).toMatchObject({
      type: 'permission.request',
      toolUseId: 'call_edit_1',
      toolName: 'Edit',
      description: 'Editing file.txt',
      diff: {
        kind: 'edit',
        filePath: '/work/file.txt',
        oldText: 'old text',
        newText: 'new text',
      },
    });

    // Test allow
    const responded = session.respondPermission('call_edit_1', 'allow');
    expect(responded).toBe(true);

    await until(() => s.replies().some((r) => r.id === 'req_perm_1'), 'reply req_perm_1');
    const reply1 = s.replies().find((r) => r.id === 'req_perm_1');
    expect(reply1?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });

    const resolved = events.find((e) => e.type === 'permission.resolved');
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: 'call_edit_1',
      decision: 'allow',
      by: 'user',
    });

    promptResolve({ stopReason: 'end_turn' });
    await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');
    session.dispose();
  });

  it('respondPermission allow-edits switches session mode and responds allow', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', (params) => {
      s.request('req_perm_edits', 'session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call_edits',
          name: 'write_file',
          args: { Path: '/work/new.txt', Content: 'hello' },
        },
      });
      return { stopReason: 'end_turn' };
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('write something');

    await until(() => events.some((e) => e.type === 'permission.request'), 'permission.request');
    session.respondPermission('call_edits', 'allow-edits');

    await until(() => s.methods().includes('session/set_mode'), 'session/set_mode');
    expect(s.paramsOf('session/set_mode')).toMatchObject({ modeId: 'accept-edits' });

    await until(() => s.replies().some((r) => r.id === 'req_perm_edits'), 'reply req_perm_edits');
    const reply = s.replies().find((r) => r.id === 'req_perm_edits');
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });

    const modeChanged = events.find((e) => e.type === 'mode.changed');
    expect(modeChanged).toMatchObject({ type: 'mode.changed', mode: 'acceptEdits' });

    session.dispose();
  });

  it('bypassPermissions auto-responds allow without emitting permission.request', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', (params) => {
      s.request('req_bypass_1', 'session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call_cmd', name: 'run_command', args: { CommandLine: 'echo 1' } },
      });
      return { stopReason: 'end_turn' };
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({
      cwd: '/work',
      permissionMode: 'bypassPermissions',
      allowBypassPermissions: true,
    });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('run echo');

    await until(() => s.replies().some((r) => r.id === 'req_bypass_1'), 'reply req_bypass_1');
    const reply = s.replies().find((r) => r.id === 'req_bypass_1');
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(events.filter((e) => e.type === 'permission.request')).toHaveLength(0);

    session.dispose();
  });

  it('interactive questions: elicitation/create emits question.request and answers with 1-based index', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', (params) => {
      s.request('req_elicit_1', 'elicitation/create', {
        sessionId: params.sessionId,
        toolCallId: 'call_q_1',
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: {
            q1: {
              type: 'string',
              description: 'Select frontend library',
              oneOf: [
                { const: '1', title: 'React' },
                { const: '2', title: 'Vue' },
                { const: '3', title: 'Svelte' },
              ],
            },
            q1_other: { type: 'string' },
          },
          required: ['q1'],
        },
      });
      return { stopReason: 'end_turn' };
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('ask me a question');

    await until(() => events.some((e) => e.type === 'question.request'), 'question.request');
    const qReq = events.find((e) => e.type === 'question.request') as AgentEventOf<'question.request'>;
    expect(qReq).toMatchObject({
      type: 'question.request',
      toolUseId: 'call_q_1',
      questions: [
        {
          question: 'Select frontend library',
          options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Svelte' }],
          multiSelect: false,
        },
      ],
    });

    const answered = session.answerQuestion('call_q_1', { 'Select frontend library': 'Vue' });
    expect(answered).toBe(true);

    await until(() => s.replies().some((r) => r.id === 'req_elicit_1'), 'reply req_elicit_1');
    const reply = s.replies().find((r) => r.id === 'req_elicit_1');
    expect(reply?.result).toEqual({ action: 'accept', content: { q1: '2' } });

    session.dispose();
  });

  it('interrupt and dispose abort pending permissions and cancel pending questions', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', (params) => {
      s.request('req_perm_abort', 'session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call_abort_perm' },
      });
      s.request('req_elicit_abort', 'elicitation/create', {
        sessionId: params.sessionId,
        toolCallId: 'call_abort_elicit',
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', oneOf: [{ const: '1', title: 'Opt' }] },
          },
        },
      });
      return new Promise(() => {}); // hold prompt
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('trigger prompt');

    await until(() => events.some((e) => e.type === 'permission.request'), 'permission.request');
    await until(() => events.some((e) => e.type === 'question.request'), 'question.request');

    const interruptPromise = session.interrupt();

    await until(() => s.replies().some((r) => r.id === 'req_perm_abort'), 'reply perm abort');
    await until(() => s.replies().some((r) => r.id === 'req_elicit_abort'), 'reply elicit abort');

    const permReply = s.replies().find((r) => r.id === 'req_perm_abort');
    expect(permReply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });

    const elicitReply = s.replies().find((r) => r.id === 'req_elicit_abort');
    expect(elicitReply?.result).toEqual({ action: 'cancel' });

    const resolved = events.find((e) => e.type === 'permission.resolved');
    expect(resolved).toMatchObject({
      type: 'permission.resolved',
      toolUseId: 'call_abort_perm',
      decision: 'deny',
      by: 'abort',
    });

    session.dispose();
    await interruptPromise.catch(() => {});
  });

  it('interrupt sends session/cancel notification and marks turn cancelled', async () => {
    const s = createFakeAgyServer();
    let promptResolve!: (val: unknown) => void;
    s.handle('session/prompt', () => {
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('long running task');

    await until(() => s.methods().includes('session/prompt'), 'session/prompt');
    const interruptPromise = session.interrupt();

    await until(() => s.methods().includes('session/cancel'), 'session/cancel');
    expect(s.paramsOf('session/cancel')).toMatchObject({ sessionId: DEFAULT_SESSION_ID });

    promptResolve({ stopReason: 'cancelled' });
    await interruptPromise;

    const result = events.find((e) => e.type === 'turn.result');
    expect(result).toMatchObject({
      type: 'turn.result',
      ok: false,
      interrupted: true,
      subtype: 'cancelled',
    });

    session.dispose();
  });

  it('process crash during turn marks turn as error', async () => {
    const s = createFakeAgyServer();
    s.handle('session/prompt', () => {
      setTimeout(() => s.exit(1), 10);
      return new Promise(() => {}); // never resolves
    });

    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    session.send('crash now');

    await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result error');
    const result = events.find((e) => e.type === 'turn.result');
    expect(result).toMatchObject({
      type: 'turn.result',
      ok: false,
      subtype: 'error',
    });

    session.dispose();
  });

  it('resumeSession calls session/resume with sessionId', async () => {
    const s = createFakeAgyServer();
    const { adapter } = setup(s);
    const session = await adapter.resumeSession('existing-session-123', { cwd: '/work' });
    const events = collect(session);

    await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
    expect(s.methods()).toContain('session/resume');
    expect(s.paramsOf('session/resume')).toMatchObject({
      sessionId: 'existing-session-123',
      cwd: '/work',
    });

    session.dispose();
  });

  it('capabilities returns base models and effort levels', async () => {
    const s = createFakeAgyServer();
    const { adapter } = setup(s);
    const session = await adapter.createSession({ cwd: '/work' });

    const caps = await session.capabilities();
    expect(caps.models).toHaveLength(5);
    expect(caps.models.map((m) => m.value)).toEqual([
      'gemini-4-argon',
      'gemini-3.8-flash',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b-medium',
    ]);
    const argon = caps.models.find((m) => m.value === 'gemini-4-argon');
    expect(argon).toMatchObject({
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'high'],
    });

    const gptOss = caps.models.find((m) => m.value === 'gpt-oss-120b-medium');
    expect(gptOss).toMatchObject({
      supportsEffort: false,
    });

    session.dispose();
  });

  it('accountInfo reads tier name and caches it', async () => {
    const s = createFakeAgyServer();
    const { adapter } = setup(s);

    const info = await adapter.accountInfo('/work');
    expect(info).toEqual({ subscriptionType: 'Google AI Pro' });

    // Repeated call uses cache
    const info2 = await adapter.accountInfo('/work');
    expect(info2).toEqual({ subscriptionType: 'Google AI Pro' });
  });

  it('missing executablePath throws AGY_NOT_FOUND', async () => {
    const adapter = new AntigravityAdapter({ executablePath: undefined });
    await expect(adapter.createSession({ cwd: '/work' })).rejects.toThrow(AGY_NOT_FOUND);
  });

  it('listSessions filters by cwd and overlays user names from sessionIndex', async () => {
    const s = createFakeAgyServer();
    s.handle('session/list', () => ({
      sessions: [
        { sessionId: 'sess_1', cwd: '/work', title: 'Default Title 1', updatedAt: '2026-03-30T10:00:00Z' },
        { sessionId: 'sess_2', cwd: '/other', title: 'Other Title', updatedAt: '2026-03-30T11:00:00Z' },
        { sessionId: 'sess_3', cwd: '/work', title: 'Default Title 3', updatedAt: '2026-03-30T12:00:00Z' },
      ],
    }));

    const state = memoryStore();
    state.update('agentura.antigravity.names', { sess_1: 'Custom Name 1' });
    const { adapter } = setup(s, { state });

    const sessions = await adapter.listSessions('/work');
    expect(sessions).toHaveLength(2);
    // Ordered descending by updatedAt
    expect(sessions[0]).toMatchObject({
      id: 'sess_3',
      title: 'Default Title 3',
      cwd: '/work',
      provider: 'antigravity',
    });
    expect(sessions[1]).toMatchObject({
      id: 'sess_1',
      title: 'Custom Name 1',
      cwd: '/work',
      provider: 'antigravity',
    });
  });

  it('loadHistory calls session/load and rebuilds history', async () => {
    const s = createFakeAgyServer();
    s.handle('session/load', (params) => {
      s.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });
      s.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        },
      });
      return {
        sessionId: params.sessionId,
        models: FAKE_MODELS,
        modes: FAKE_MODES,
        configOptions: makeConfigOptions(),
      };
    });

    const { adapter } = setup(s);
    const history = await adapter.loadHistory('sess_1', '/work');
    expect(history.turns).toBe(1);
    expect(history.events.map((e) => e.type)).toContain('turn.result');
    const textDelta = history.events.find((e) => e.type === 'text.delta');
    expect(textDelta).toMatchObject({ type: 'text.delta', text: 'world' });
  });

  it('renameSession updates name in sessionIndex', async () => {
    const state = memoryStore();
    const { adapter } = setup(createFakeAgyServer(), { state });

    await adapter.renameSession('sess_123', 'My Renamed Session');
    expect(state.get('agentura.antigravity.names', {})).toEqual({
      sess_123: 'My Renamed Session',
    });
  });
});
