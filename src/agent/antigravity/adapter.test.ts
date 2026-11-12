import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { AcpRpcError } from '../acp/client';
import { availableCommandsOf, availableModesOf, permissionModeOf, parseElicitation, formatElicitationAnswer } from './acpProtocol';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf, AgentSession, PromptImage } from '../types';
import {
  AntigravityAdapter,
  agySpawnArgs,
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
    await expect(session.setModel('invalid')).rejects.toThrow('model rejected');
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

  describe('Context usage and window tracking', () => {
    async function writeTranscript(
      dataDir: string,
      sessionId: string,
      lines: (string | Record<string, unknown>)[],
    ): Promise<string> {
      const dir = join(dataDir, 'brain', sessionId, '.system_generated', 'logs');
      await mkdir(dir, { recursive: true });
      const content = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
      const filePath = join(dir, 'transcript.jsonl');
      await writeFile(filePath, content, 'utf8');
      return filePath;
    }

    it('emits initial context.usage on createSession and captures transcript usage on resumeSession and contextUsage()', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-ctx-test-'));
      try {
        const s = createFakeAgyServer();
        const { adapter } = setup(s, { dataDir: tempDir });
        const session = await adapter.createSession({ cwd: '/work', model: 'gemini-4-argon' });
        const events = collect(session);

        await until(() => events.some((e) => e.type === 'context.usage'), 'initial context.usage');
        const initialUsage = events.find((e) => e.type === 'context.usage');
        expect(initialUsage).toMatchObject({
          type: 'context.usage',
          usedTokens: 0,
          maxTokens: 1_000_000,
          percentage: 0,
          source: 'usage',
        });

        const directUsage = await session.contextUsage();
        expect(directUsage).toMatchObject({
          type: 'context.usage',
          usedTokens: 0,
          maxTokens: 1_000_000,
          percentage: 0,
          source: 'usage',
        });
        session.dispose();

        // Write transcript for resumeSession
        const resumeSessionId = DEFAULT_SESSION_ID;
        await writeTranscript(tempDir, resumeSessionId, [
          {
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            step_index: 3,
            input_tokens: 3000,
            cache_read_tokens: 500,
            cache_write_tokens: 200,
            output_tokens: 300,
          },
        ]);

        const sResume = createFakeAgyServer(resumeSessionId);
        const { adapter: resumeAdapter } = setup(sResume, { dataDir: tempDir });
        const resumed = await resumeAdapter.resumeSession(resumeSessionId, { cwd: '/work', model: 'gemini-4-argon' });
        const resumeEvents = collect(resumed);

        await until(() => resumeEvents.some((e) => e.type === 'context.usage'), 'resume context.usage');
        const resumedUsage = resumeEvents.find((e) => e.type === 'context.usage');
        expect(resumedUsage).toMatchObject({
          type: 'context.usage',
          usedTokens: 4000,
          maxTokens: 1_000_000,
          source: 'usage',
        });

        const directResumeUsage = await resumed.contextUsage();
        expect(directResumeUsage).toMatchObject({
          type: 'context.usage',
          usedTokens: 4000,
          maxTokens: 1_000_000,
          source: 'usage',
        });
        resumed.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('multi-step turn with tool_call uses transcript PLANNER_RESPONSE tokens instead of inflated result.usage', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-ctx-test-'));
      try {
        const s = createFakeAgyServer();
        s.handle('session/prompt', async (params) => {
          // Tool call notification during turn
          s.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_1',
              title: 'Bash: ls',
              rawName: 'Bash',
              rawInput: { command: 'ls' },
            },
          });

          // Write step 0 to transcript while tool call executes
          await writeTranscript(tempDir, DEFAULT_SESSION_ID, [
            {
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              step_index: 0,
              input_tokens: 1500,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              output_tokens: 100,
            },
          ]);

          await new Promise((r) => setTimeout(r, 20));

          // Write step 1 to transcript for final planner response
          await writeTranscript(tempDir, DEFAULT_SESSION_ID, [
            {
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              step_index: 0,
              input_tokens: 1500,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              output_tokens: 100,
            },
            {
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              step_index: 1,
              input_tokens: 2500,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              output_tokens: 200,
            },
          ]);

          return {
            stopReason: 'end_turn',
            // Inflated usage from server summing all steps
            usage: { inputTokens: 50_000, outputTokens: 10_000, totalTokens: 60_000 },
          };
        });

        const { adapter } = setup(s, { dataDir: tempDir });
        const session = await adapter.createSession({ cwd: '/work', model: 'gemini-4-argon' });
        const events = collect(session);
        await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

        session.send('run multi-step');
        await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

        const usages = events.filter((e) => e.type === 'context.usage');
        // Initial usage (0 tokens) + tool call update (1600 tokens) + turn completion update (2700 tokens)
        const finalUsage = usages.at(-1);
        expect(finalUsage).toMatchObject({
          type: 'context.usage',
          usedTokens: 2700,
          maxTokens: 1_000_000,
        });
        // Make sure inflated 60,000 tokens was never emitted
        expect(usages.some((u) => (u as AgentEventOf<'context.usage'>).usedTokens === 60_000)).toBe(false);

        session.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('multi-step turn with tool_call but missing transcript does not overwrite usedTokens with inflated result.usage', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-ctx-test-'));
      try {
        const s = createFakeAgyServer();
        s.handle('session/prompt', (params) => {
          s.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_x',
              title: 'Read: file.ts',
              rawName: 'Read',
              rawInput: { file_path: 'file.ts' },
            },
          });
          return {
            stopReason: 'end_turn',
            usage: { inputTokens: 40_000, outputTokens: 5_000, totalTokens: 45_000 },
          };
        });

        const { adapter } = setup(s, { dataDir: tempDir });
        const session = await adapter.createSession({ cwd: '/work', model: 'gemini-4-argon' });
        const events = collect(session);
        await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

        session.send('read something');
        await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

        const usages = events.filter((e) => e.type === 'context.usage');
        expect(usages).toHaveLength(1); // Only initial context.usage
        expect((usages[0] as AgentEventOf<'context.usage'>).usedTokens).toBe(0);

        session.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('single-step turn without transcript falls back to result.usage', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-ctx-test-'));
      try {
        const s = createFakeAgyServer();
        s.handle('session/prompt', () => ({
          stopReason: 'end_turn',
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cachedReadTokens: 50,
            cachedWriteTokens: 0,
            totalTokens: 200,
          },
        }));

        const { adapter } = setup(s, { dataDir: tempDir });
        const session = await adapter.createSession({ cwd: '/work', model: 'gemini-4-argon' });
        const events = collect(session);
        await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

        session.send('quick question');
        await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

        const usages = events.filter((e) => e.type === 'context.usage');
        expect(usages.at(-1)).toMatchObject({
          type: 'context.usage',
          usedTokens: 200, // 120 + 30 + 50
          maxTokens: 1_000_000,
        });

        session.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('loadHistory appends context.usage event to history.events when transcript exists', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-ctx-test-'));
      try {
        const sessionId = '99999999-8888-7777-6666-555555555555';
        await writeTranscript(tempDir, sessionId, [
          {
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            step_index: 5,
            input_tokens: 12_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 800,
          },
        ]);

        const s = createFakeAgyServer(sessionId);
        s.handle('session/load', (params) => ({
          sessionId: params.sessionId,
          models: FAKE_MODELS,
          modes: FAKE_MODES,
          configOptions: makeConfigOptions('gemini-4-argon'),
        }));

        const { adapter } = setup(s, { dataDir: tempDir });
        const historyWithTranscript = await adapter.loadHistory(sessionId, '/work');
        const lastEvent = historyWithTranscript.events.at(-1);
        expect(lastEvent).toMatchObject({
          type: 'context.usage',
          usedTokens: 12_800,
          maxTokens: 1_000_000,
        });

        // History without transcript does not append context.usage
        const sEmpty = createFakeAgyServer();
        sEmpty.handle('session/load', (params) => ({
          sessionId: params.sessionId,
          models: FAKE_MODELS,
          modes: FAKE_MODES,
          configOptions: makeConfigOptions('gemini-4-argon'),
        }));
        const { adapter: emptyAdapter } = setup(sEmpty, { dataDir: tempDir });
        const emptyHistory = await emptyAdapter.loadHistory('00000000-0000-0000-0000-000000000000', '/work');
        expect(emptyHistory.events.some((e) => e.type === 'context.usage')).toBe(false);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('setModel window recalculation and error handling', () => {
    it('switches model window dynamically: gemini (1M) -> claude (200k) -> gpt-oss (128k) -> unknown (0)', async () => {
      const s = createFakeAgyServer();
      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work', model: 'gemini-4-argon' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      // Switch to Claude Sonnet
      await session.setModel('claude-sonnet-5-5');
      const claudeUsage = events.filter((e) => e.type === 'context.usage').at(-1);
      expect(claudeUsage).toMatchObject({
        type: 'context.usage',
        maxTokens: 200_000,
      });

      // Switch to GPT-OSS 120B
      await session.setModel('gpt-oss-120b-medium');
      const gptUsage = events.filter((e) => e.type === 'context.usage').at(-1);
      expect(gptUsage).toMatchObject({
        type: 'context.usage',
        maxTokens: 128_000,
      });

      // Switch to unknown custom model
      await session.setModel('custom-model-x');
      const unknownUsage = events.filter((e) => e.type === 'context.usage').at(-1);
      expect(unknownUsage).toMatchObject({
        type: 'context.usage',
        maxTokens: 0,
      });

      session.dispose();
    });

    it('setModel failure emits non-fatal error, re-emits session.init with previous model, and rejects', async () => {
      const s = createFakeAgyServer();
      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work', model: 'claude-sonnet-5-5' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      s.handle('session/set_config_option', (params) => {
        if (params.configId === 'model' && params.value === 'failing-model') {
          throw new Error('quota exceeded');
        }
        return { configOptions: makeConfigOptions() };
      });

      await expect(session.setModel('failing-model')).rejects.toThrow('quota exceeded');

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toMatchObject({
        type: 'error',
        fatal: false,
        message: 'session/set_config_option model failed: quota exceeded',
      });

      const inits = events.filter((e) => e.type === 'session.init');
      const lastInit = inits.at(-1);
      expect(lastInit).toMatchObject({
        type: 'session.init',
        model: 'claude-sonnet-5-5',
      });

      session.dispose();
    });
  });

  describe('compact()', () => {
    it('returns false when not ready or during turn, and sends /compact and emits compaction events in idle', async () => {
      const s = createFakeAgyServer();
      let promptText = '';
      s.handle('session/prompt', (params) => {
        const blocks = params.prompt as { type: string; text?: string }[];
        promptText = blocks?.[0]?.text ?? '';
        return {
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        };
      });

      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      // Idle compaction
      const started = session.compact();
      expect(started).toBe(true);
      expect(promptText).toBe('/compact');

      await until(() => events.some((e) => e.type === 'compaction.end'), 'compaction.end');
      expect(events.some((e) => e.type === 'compaction.start')).toBe(true);
      const endEvent = events.find((e) => e.type === 'compaction.end');
      expect(endEvent).toMatchObject({
        type: 'compaction.end',
        ok: true,
        trigger: 'manual',
      });

      session.dispose();
    });

    it('returns false during active turn', async () => {
      const s = createFakeAgyServer();
      let resolvePrompt!: () => void;
      s.handle('session/prompt', () => new Promise((r) => {
        resolvePrompt = () => r({ stopReason: 'end_turn', usage: { totalTokens: 10 } });
      }));

      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      session.send('start long turn');
      await until(() => events.some((e) => e.type === 'turn.start'), 'turn.start');

      // compact during active turn should return false
      expect(session.compact()).toBe(false);

      resolvePrompt();
      await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');
      session.dispose();
    });

    it('emits compaction.end with ok: false on RPC error or cancellation', async () => {
      const s = createFakeAgyServer();
      s.handle('session/prompt', () => {
        throw new AcpRpcError('compaction failed', -32001, undefined, 'Antigravity');
      });

      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      const started = session.compact();
      expect(started).toBe(true);

      await until(() => events.some((e) => e.type === 'compaction.end'), 'compaction.end');
      const errorEnd = events.find((e) => e.type === 'compaction.end');
      expect(errorEnd).toMatchObject({
        type: 'compaction.end',
        ok: false,
        trigger: 'manual',
        error: 'compaction failed',
      });

      // Cancellation case
      s.handle('session/prompt', () => ({
        stopReason: 'cancelled',
      }));

      events.length = 0;
      session.compact();
      await until(() => events.some((e) => e.type === 'compaction.end'), 'compaction.end cancelled');
      const cancelEnd = events.find((e) => e.type === 'compaction.end');
      expect(cancelEnd).toMatchObject({
        type: 'compaction.end',
        ok: false,
        trigger: 'manual',
        error: 'cancelled',
      });

      session.dispose();
    });
  });

  describe('out-of-turn notifications (available_commands_update & session_info_update)', () => {
    it('availableCommandsOf extracts clean deduplicated command names and ignores non-command frames', () => {
      const frames = readFileSync(join(__dirname, '../../../test/fixtures/antigravity/acp-pong.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const cmdUpdate = frames.find(
        (f) => f.msg.method === 'session/update' && f.msg.params?.update?.sessionUpdate === 'available_commands_update',
      ).msg.params.update;
      expect(availableCommandsOf(cmdUpdate)).toEqual(['goal', 'compact']);
      expect(
        availableCommandsOf({
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: ' /goal ' },
            { name: 'compact' },
            { name: 'goal' },
            { name: '   ' },
            { name: '/' },
            { _commandsCount: 10 },
            { name: '//plan' },
          ],
        }),
      ).toEqual(['goal', 'compact', 'plan']);
      expect(availableCommandsOf({ sessionUpdate: 'session_info_update', title: 'Hi' })).toBeUndefined();
      expect(availableCommandsOf({ sessionUpdate: 'available_commands_update' })).toBeUndefined();
    });

    it('captures available_commands_update during handshake and re-emits session.init when commands change in idle', async () => {
      const s = createFakeAgyServer();
      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      const firstInit = events.find((e) => e.type === 'session.init') as AgentEventOf<'session.init'>;
      expect(firstInit.slashCommands).toEqual(['goal', 'compact']);

      // Identical list in idle does not spam duplicate session.init
      s.notify('session/update', {
        sessionId: DEFAULT_SESSION_ID,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'goal' }, { name: 'compact' }],
        },
      });
      // Foreign sessionId is ignored
      s.notify('session/update', {
        sessionId: '00000000-0000-4000-8000-000000000000',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'foreign' }],
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(events.filter((e) => e.type === 'session.init')).toHaveLength(1);

      // Changed list in idle re-emits session.init
      s.notify('session/update', {
        sessionId: DEFAULT_SESSION_ID,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: '/goal' }, { name: 'compact' }, { name: 'schedule' }],
        },
      });
      await until(() => events.filter((e) => e.type === 'session.init').length === 2, 'updated session.init');
      const secondInit = events.filter((e) => e.type === 'session.init')[1] as AgentEventOf<'session.init'>;
      expect(secondInit.slashCommands).toEqual(['goal', 'compact', 'schedule']);

      session.dispose();
    });

    it('emits session.title on delayed session_info_update after session/prompt without duplicating in-turn updates', async () => {
      const s = createFakeAgyServer();
      s.handle('session/prompt', (params) => {
        s.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'In-Turn Title' },
        });
        s.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        });
        return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      });

      const { adapter } = setup(s);
      const session = await adapter.createSession({ cwd: '/work' });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      session.send('hello');
      await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

      // In-turn session_info_update emitted exactly once
      expect(events.filter((e) => e.type === 'session.title')).toEqual([
        { type: 'session.title', title: 'In-Turn Title' },
      ]);

      // Foreign session title in idle is ignored
      s.notify('session/update', {
        sessionId: '00000000-0000-4000-8000-000000000000',
        update: { sessionUpdate: 'session_info_update', title: 'Wrong Session' },
      });
      // Delayed auto-title arriving after session/prompt finished
      s.notify('session/update', {
        sessionId: DEFAULT_SESSION_ID,
        update: { sessionUpdate: 'session_info_update', title: 'Delayed Auto Title' },
      });

      await until(
        () => events.some((e) => e.type === 'session.title' && e.title === 'Delayed Auto Title'),
        'delayed session.title',
      );
      expect(events.filter((e) => e.type === 'session.title')).toEqual([
        { type: 'session.title', title: 'In-Turn Title' },
        { type: 'session.title', title: 'Delayed Auto Title' },
      ]);

      session.dispose();
    });

    it('resolves eager MCP server names from <dataDir>/mcp in live sessions, permissions, and loadHistory', async () => {
      const tmp = await mkdtemp(join(os.tmpdir(), 'agy-adapter-mcp-'));
      try {
        await mkdir(join(tmp, 'mcp', 'hansard_history'), { recursive: true });
        await mkdir(join(tmp, 'mcp', 'gemini-api_gemini-api-docs'), { recursive: true });

        const s = createFakeAgyServer();
        let promptResolve!: (val: unknown) => void;
        s.handle('session/prompt', (params) => {
          s.request('req_perm_mcp', 'session/request_permission', {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: 'perm-mcp-1',
              name: 'mcp_hansard_history_search_past_sessions',
              rawInput: { query: 'test' },
            },
            options: [
              { optionId: 'allow', kind: 'allow_once' },
              { optionId: 'deny', kind: 'reject_once' },
            ],
          });
          s.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'perm-mcp-1',
              name: 'mcp_hansard_history_search_past_sessions',
              rawInput: { query: 'test' },
              status: 'completed',
              rawOutput: { output: 'ok' },
            },
          });
          return new Promise((resolve) => {
            promptResolve = resolve;
          });
        });

        let currentServer = s;
        const adapter = new AntigravityAdapter({
          executablePath: '/bin/agy',
          dataDir: tmp,
          spawn: () => currentServer,
          graceMs: 20,
          interruptWaitMs: 50,
        });
        const session = await adapter.createSession({ cwd: '/work' });
        const events = collect(session);
        await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

        session.send('run mcp');
        await until(() => events.some((e) => e.type === 'permission.request'), 'permission.request');
        session.respondPermission('perm-mcp-1', 'allow');
        await until(() => s.replies().some((r) => r.id === 'req_perm_mcp'), 'reply req_perm_mcp');
        promptResolve({ stopReason: 'end_turn' });
        await until(() => events.some((e) => e.type === 'turn.result'), 'turn.result');

        expect(events.find((e) => e.type === 'permission.request')).toMatchObject({
          toolName: 'mcp__hansard_history__search_past_sessions',
        });
        expect(events.find((e) => e.type === 'tool.start')).toMatchObject({
          name: 'mcp__hansard_history__search_past_sessions',
        });
        session.dispose();

        // Remove directory on disk: adapter caches mcpServers read once and reuses it in loadHistory
        await rm(join(tmp, 'mcp'), { recursive: true, force: true });
        const loader = createFakeAgyServer();
        loader.handle('session/load', (params) => {
          loader.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
          });
          loader.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'hist-mcp-1',
              name: 'mcp_gemini-api_gemini-api-docs_gemini_search_docs',
              rawInput: { query: 'docs' },
              status: 'completed',
              rawOutput: { output: 'found' },
            },
          });
          return {};
        });
        currentServer = loader;
        const history = await adapter.loadHistory(DEFAULT_SESSION_ID, '/work');
        expect(history.events.find((e) => e.type === 'tool.start')).toMatchObject({
          name: 'mcp__gemini-api_gemini-api-docs__gemini_search_docs',
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('bypassPermissions inheritance, server auto mode, and reactive parent wakeup', () => {
    it('spawns agy with --dangerously-skip-permissions strictly when bypassPermissions and allowBypassPermissions are both active', async () => {
      expect(agySpawnArgs('bypassPermissions', true)).toEqual(['acp', '--dangerously-skip-permissions']);
      expect(agySpawnArgs('bypassPermissions', false)).toEqual(['acp']);
      expect(agySpawnArgs('acceptEdits', true)).toEqual(['acp']);
      expect(agySpawnArgs('default', true)).toEqual(['acp']);
      expect(agySpawnArgs('plan', true)).toEqual(['acp']);
      expect(agySpawnArgs(undefined, true)).toEqual(['acp']);
      expect(agySpawnArgs(undefined, false)).toEqual(['acp']);

      const spawned: { args: string[]; server: FakeAgyAcp }[] = [];
      const adapter = new AntigravityAdapter({
        executablePath: '/bin/agy',
        graceMs: 20,
        interruptWaitMs: 50,
        spawn: (_path, args) => {
          const server = createFakeAgyServer();
          spawned.push({ args, server });
          return server;
        },
      });

      const sBypass = await adapter.createSession({
        cwd: '/work',
        permissionMode: 'bypassPermissions',
        allowBypassPermissions: true,
      });
      await sBypass.capabilities();
      expect(spawned[0]?.args).toEqual(['acp', '--dangerously-skip-permissions']);
      sBypass.dispose();

      const sGated = await adapter.createSession({
        cwd: '/work',
        permissionMode: 'bypassPermissions',
        allowBypassPermissions: false,
      });
      await sGated.capabilities();
      expect(spawned[1]?.args).toEqual(['acp']);
      sGated.dispose();

      const sAccept = await adapter.createSession({
        cwd: '/work',
        permissionMode: 'acceptEdits',
        allowBypassPermissions: true,
      });
      await sAccept.capabilities();
      expect(spawned[2]?.args).toEqual(['acp']);
      sAccept.dispose();

      await adapter.listSessions('/work');
      expect(spawned[3]?.args).toEqual(['acp']);

      const freshAdapter = new AntigravityAdapter({
        executablePath: '/bin/agy',
        graceMs: 20,
        spawn: (_path, args) => {
          const server = createFakeAgyServer();
          spawned.push({ args, server });
          return server;
        },
      });
      await freshAdapter.accountInfo('/work');
      expect(spawned[4]?.args).toEqual(['acp']);
    });

    it('transparently respawns agy via session/resume on idle setMode(bypassPermissions) <-> setMode(default) without session.closed', async () => {
      const spawned: { args: string[]; server: FakeAgyAcp }[] = [];
      const adapter = new AntigravityAdapter({
        executablePath: '/bin/agy',
        graceMs: 20,
        interruptWaitMs: 50,
        spawn: (_path, args) => {
          const server = createFakeAgyServer(DEFAULT_SESSION_ID);
          server.handle('session/prompt', (params) => {
            server.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `handled-by-${spawned.length}` },
              },
            });
            return { stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
          });
          spawned.push({ args, server });
          return server;
        },
      });

      const session = await adapter.createSession({
        cwd: '/work',
        model: 'claude-sonnet-5-5',
        effort: 'high',
        permissionMode: 'default',
        allowBypassPermissions: true,
      });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.args).toEqual(['acp']);

      // Idle switch default -> bypassPermissions: rotates transport and resumes same sessionId
      await session.setMode('bypassPermissions');
      expect(spawned).toHaveLength(2);
      expect(spawned[0]?.server.exited).toBe(true);
      expect(spawned[1]?.args).toEqual(['acp', '--dangerously-skip-permissions']);
      expect(spawned[1]?.server.methods()).toContain('session/resume');
      expect(spawned[1]?.server.paramsOf('session/resume')).toMatchObject({
        sessionId: DEFAULT_SESSION_ID,
        cwd: '/work',
      });
      const resumedConfigs = spawned[1]!.server.received
        .filter((m) => m.method === 'session/set_config_option')
        .map((m) => m.params);
      expect(resumedConfigs).toEqual([
        { sessionId: DEFAULT_SESSION_ID, configId: 'model', value: 'claude-sonnet-5-5' },
        { sessionId: DEFAULT_SESSION_ID, configId: 'thought_level', value: 'high' },
      ]);
      expect(spawned[1]?.server.paramsOf('session/set_mode')).toMatchObject({
        sessionId: DEFAULT_SESSION_ID,
        modeId: 'accept-edits',
      });
      expect(events.some((e) => e.type === 'session.closed')).toBe(false);
      expect(events.filter((e) => e.type === 'mode.changed').at(-1)).toMatchObject({
        type: 'mode.changed',
        mode: 'bypassPermissions',
      });

      // Prompt runs on the newly spawned bypass worker
      session.send('run child');
      await until(() => events.some((e) => e.type === 'turn.result'), 'first turn.result');
      expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ text: 'handled-by-2' });

      // Idle switch bypassPermissions -> default: rotates back to plain ['acp']
      await session.setMode('default');
      expect(spawned).toHaveLength(3);
      expect(spawned[1]?.server.exited).toBe(true);
      expect(spawned[2]?.args).toEqual(['acp']);
      expect(spawned[2]?.server.methods()).toContain('session/resume');
      expect(events.some((e) => e.type === 'session.closed')).toBe(false);
      expect(events.filter((e) => e.type === 'mode.changed').at(-1)).toMatchObject({
        type: 'mode.changed',
        mode: 'default',
      });

      session.send('after downgrade');
      await until(() => events.filter((e) => e.type === 'turn.result').length === 2, 'second turn.result');
      expect(events.filter((e) => e.type === 'turn.result')[1]).toMatchObject({ text: 'handled-by-3' });

      session.dispose();
    });

    it('defers respawn (pendingRespawn) when setMode(bypassPermissions) is called mid-turn and respawns before next queued prompt', async () => {
      const spawned: { args: string[]; server: FakeAgyAcp }[] = [];
      let finishFirstTurn!: () => void;

      const adapter = new AntigravityAdapter({
        executablePath: '/bin/agy',
        graceMs: 20,
        interruptWaitMs: 50,
        spawn: (_path, args) => {
          const idx = spawned.length;
          const server = createFakeAgyServer(DEFAULT_SESSION_ID);
          if (idx === 0) {
            server.handle('session/prompt', (params) => {
              server.request('perm_mid_1', 'session/request_permission', {
                sessionId: params.sessionId,
                toolCall: { toolCallId: 'call_mid_1', name: 'run_command', args: { CommandLine: 'git status' } },
              });
              return new Promise((resolve) => {
                finishFirstTurn = () => {
                  server.notify('session/update', {
                    sessionId: params.sessionId,
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-1' } },
                  });
                  resolve({ stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
                };
              });
            });
          } else {
            server.handle('session/prompt', (params) => {
              server.notify('session/update', {
                sessionId: params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-2-on-bypass' } },
              });
              return { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
            });
          }
          spawned.push({ args, server });
          return server;
        },
      });

      const session = await adapter.createSession({
        cwd: '/work',
        model: 'gemini-3.8-flash',
        effort: 'low',
        permissionMode: 'default',
        allowBypassPermissions: true,
      });
      const events = collect(session);
      await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

      session.send('first prompt');
      await until(() => events.some((e) => e.type === 'permission.request'), 'permission.request');

      // Switch to bypassPermissions mid-turn + enqueue second prompt before turn 1 ends
      await session.setMode('bypassPermissions');
      session.send('second prompt');

      // Still on process #1 while turn 1 is open, but set_mode applied and hanging permission auto-allowed
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.server.exited).toBe(false);
      expect(spawned[0]?.server.paramsOf('session/set_mode')).toMatchObject({ modeId: 'accept-edits' });
      expect(spawned[0]?.server.replies().find((r) => r.id === 'perm_mid_1')?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      // Finish turn 1 -> pendingRespawn rotates worker BEFORE 'second prompt' is sent
      finishFirstTurn();
      await until(() => events.filter((e) => e.type === 'turn.result').length === 2, 'both turns finished');

      expect(spawned).toHaveLength(2);
      expect(spawned[0]?.server.exited).toBe(true);
      expect(spawned[1]?.args).toEqual(['acp', '--dangerously-skip-permissions']);
      expect(spawned[1]?.server.methods()).toContain('session/resume');
      expect(spawned[1]?.server.paramsOf('session/prompt')).toMatchObject({
        sessionId: DEFAULT_SESSION_ID,
        prompt: [{ type: 'text', text: 'second prompt' }],
      });
      expect(events.filter((e) => e.type === 'turn.result').map((e) => (e as AgentEventOf<'turn.result'>).text)).toEqual([
        'turn-1',
        'turn-2-on-bypass',
      ]);
      expect(events.some((e) => e.type === 'session.closed')).toBe(false);

      session.dispose();
    });

    it('preserves server auto mode across repeated resumeSession without sending session/set_mode, and exits auto on explicit setMode', async () => {
      expect(availableModesOf({ modes: FAKE_MODES })).toEqual(['default', 'accept-edits', 'auto', 'plan']);
      expect(
        availableModesOf({
          modes: {
            availableModes: [
              { modeId: 'auto' },
              { value: 'plan' },
              { id: 'auto' },
              { id: 'unknown-mode' },
            ],
          },
        }),
      ).toEqual(['auto', 'plan']);
      expect(permissionModeOf('auto')).toBe('acceptEdits');

      const state = memoryStore();
      const s1 = createFakeAgyServer(DEFAULT_SESSION_ID, { mode: 'auto' });
      const { adapter: adapter1 } = setup(s1, { state });

      // 1st resume without explicit permissionMode
      const resumed1 = await adapter1.resumeSession(DEFAULT_SESSION_ID, { cwd: '/work' });
      const events1 = collect(resumed1);
      await until(() => events1.some((e) => e.type === 'session.init'), 'resumed1 session.init');

      expect(events1.find((e) => e.type === 'session.init')).toMatchObject({
        permissionMode: 'acceptEdits',
      });
      expect(s1.methods().filter((m) => m === 'session/set_mode')).toHaveLength(0);
      resumed1.dispose();

      // 2nd resume with the same state store: saved settings must NOT clobber server 'auto' into 'accept-edits'
      const s2 = createFakeAgyServer(DEFAULT_SESSION_ID, { mode: 'auto' });
      const { adapter: adapter2 } = setup(s2, { state });
      const resumed2 = await adapter2.resumeSession(DEFAULT_SESSION_ID, { cwd: '/work' });
      const events2 = collect(resumed2);
      await until(() => events2.some((e) => e.type === 'session.init'), 'resumed2 session.init');

      expect(events2.find((e) => e.type === 'session.init')).toMatchObject({
        permissionMode: 'acceptEdits',
      });
      expect(s2.methods().filter((m) => m === 'session/set_mode')).toHaveLength(0);

      // Explicit user setMode('default') transitions server out of 'auto' and persists choice
      await resumed2.setMode('default');
      expect(s2.paramsOf('session/set_mode')).toMatchObject({
        sessionId: DEFAULT_SESSION_ID,
        modeId: 'default',
      });
      expect(events2.filter((e) => e.type === 'mode.changed').at(-1)).toMatchObject({
        type: 'mode.changed',
        mode: 'default',
      });
      resumed2.dispose();

      // 3rd resume after explicit setMode('default'): now 'default' IS enforced over server 'auto'
      const s3 = createFakeAgyServer(DEFAULT_SESSION_ID, { mode: 'auto' });
      const { adapter: adapter3 } = setup(s3, { state });
      const resumed3 = await adapter3.resumeSession(DEFAULT_SESSION_ID, { cwd: '/work' });
      const events3 = collect(resumed3);
      await until(() => events3.some((e) => e.type === 'session.init'), 'resumed3 session.init');
      expect(events3.find((e) => e.type === 'session.init')).toMatchObject({
        permissionMode: 'default',
      });
      expect(s3.paramsOf('session/set_mode')).toMatchObject({
        sessionId: DEFAULT_SESSION_ID,
        modeId: 'default',
      });
      resumed3.dispose();
    });

    it('delivers parent subagent reply both when session/prompt is held open (HoldOwnedTurn) and via out-of-turn reactive wakeupTurn', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-wakeup-test-'));
      try {
        const transcriptDir = join(tempDir, 'brain', DEFAULT_SESSION_ID, '.system_generated', 'logs');
        await mkdir(transcriptDir, { recursive: true });
        const transcriptPath = join(transcriptDir, 'transcript.jsonl');

        // 1) HoldOwnedTurn: session/prompt stays open across invoke_subagent + schedule until WAKEUP_OK
        const sHeld = createFakeAgyServer();
        sHeld.handle('session/prompt', async (params) => {
          sHeld.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'sub_1',
              name: 'invoke_subagent',
              rawInput: { TypeName: 'self', Role: 'Ping', Prompt: 'reply PONG' },
              status: 'in_progress',
            },
          });
          sHeld.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'sub_1',
              name: 'invoke_subagent',
              status: 'completed',
              rawOutput: { output: 'Created subagent' },
            },
          });
          await new Promise((r) => setTimeout(r, 10));
          sHeld.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAKEUP_' } },
          });
          sHeld.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } },
          });
          await writeFile(
            transcriptPath,
            JSON.stringify({
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              step_index: 2,
              input_tokens: 4000,
              cache_read_tokens: 1000,
              cache_write_tokens: 0,
              output_tokens: 50,
            }) + '\n',
            'utf8',
          );
          return { stopReason: 'end_turn', usage: { inputTokens: 9000, outputTokens: 100, totalTokens: 9100 } };
        });

        const { adapter: heldAdapter } = setup(sHeld, { dataDir: tempDir, wakeupIdleMs: 25 });
        const heldSession = await heldAdapter.createSession({
          cwd: '/work',
          model: 'gemini-3.8-flash',
          permissionMode: 'bypassPermissions',
          allowBypassPermissions: true,
        });
        const heldEvents = collect(heldSession);
        await until(() => heldEvents.some((e) => e.type === 'session.init'), 'held session.init');

        heldSession.send('ping child');
        await until(() => heldEvents.some((e) => e.type === 'turn.result'), 'held turn.result');
        expect(heldEvents.find((e) => e.type === 'turn.result')).toMatchObject({
          ok: true,
          subtype: 'end_turn',
          text: 'WAKEUP_OK',
        });
        expect(heldEvents.filter((e) => e.type === 'context.usage').at(-1)).toMatchObject({
          usedTokens: 5050,
        });
        heldSession.dispose();

        // 2) Out-of-turn reactive wakeup: session/prompt ends with WAITING, then server pushes session/update while idle
        const sAsync = createFakeAgyServer();
        let promptCalls = 0;
        sAsync.handle('session/prompt', (params) => {
          promptCalls++;
          const text = promptCalls === 1 ? 'WAITING' : 'NEXT_USER_TURN';
          sAsync.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          });
          return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        });

        const { adapter: asyncAdapter } = setup(sAsync, { dataDir: tempDir, wakeupIdleMs: 25 });
        const asyncSession = await asyncAdapter.createSession({
          cwd: '/work',
          model: 'gemini-3.8-flash',
          permissionMode: 'bypassPermissions',
          allowBypassPermissions: true,
        });
        const asyncEvents = collect(asyncSession);
        await until(() => asyncEvents.some((e) => e.type === 'session.init'), 'async session.init');

        asyncSession.send('spawn child and stop');
        await until(() => asyncEvents.some((e) => e.type === 'turn.result'), 'initial turn.result');

        // Transcript updated by reactive wakeup step
        await writeFile(
          transcriptPath,
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            step_index: 5,
            input_tokens: 6000,
            cache_read_tokens: 2000,
            cache_write_tokens: 0,
            output_tokens: 120,
          }) + '\n',
          'utf8',
        );

        // Out-of-turn wakeup frames arrive when this.turn === undefined
        sAsync.notify('session/update', {
          sessionId: DEFAULT_SESSION_ID,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'got PONG' } },
        });
        sAsync.notify('session/update', {
          sessionId: DEFAULT_SESSION_ID,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'wake_tool_1',
            name: 'read_file',
            rawInput: { Path: '/work/out.txt' },
            status: 'completed',
            rawOutput: { output: 'PONG' },
          },
        });
        sAsync.notify('session/update', {
          sessionId: DEFAULT_SESSION_ID,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAKEUP_OK' } },
        });

        await until(
          () => asyncEvents.filter((e) => e.type === 'turn.result').length === 2,
          'wakeup turn.result after idleMs',
        );

        const turnStarts = asyncEvents.filter((e) => e.type === 'turn.start') as AgentEventOf<'turn.start'>[];
        expect(turnStarts).toHaveLength(2);
        expect(turnStarts[0]?.prompt).toBe('spawn child and stop');
        // Engine-initiated wakeup turn has no prompt so UI does not render an empty user bubble
        expect(turnStarts[1]?.prompt).toBeUndefined();

        const turnResults = asyncEvents.filter((e) => e.type === 'turn.result') as AgentEventOf<'turn.result'>[];
        expect(turnResults[1]).toMatchObject({
          ok: true,
          subtype: 'end_turn',
          text: 'WAKEUP_OK',
        });
        expect(asyncEvents.filter((e) => e.type === 'context.usage').at(-1)).toMatchObject({
          usedTokens: 8120,
        });

        // 3) Wakeup turn interrupted by a new user send() closes immediately before the user turn starts
        const slowAdapterSetup = setup(sAsync, { dataDir: tempDir, wakeupIdleMs: 5000 });
        const slowSession = await slowAdapterSetup.adapter.createSession({ cwd: '/work' });
        const slowEvents = collect(slowSession);
        await until(() => slowEvents.some((e) => e.type === 'session.init'), 'slow session.init');

        sAsync.notify('session/update', {
          sessionId: DEFAULT_SESSION_ID,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL_WAKEUP' } },
        });
        await until(() => slowEvents.some((e) => e.type === 'text.delta'), 'partial wakeup delta');

        slowSession.send('follow-up question');
        await until(
          () => slowEvents.filter((e) => e.type === 'turn.result').length === 2,
          'both partial wakeup and follow-up finished',
        );

        const orderedTurns = slowEvents.filter((e) => e.type === 'turn.start' || e.type === 'turn.result');
        expect(orderedTurns.map((e) => (e.type === 'turn.start' ? `start:${e.prompt ?? '<wakeup>'}` : `end:${e.text}`))).toEqual([
          'start:<wakeup>',
          'end:PARTIAL_WAKEUP',
          'start:follow-up question',
          'end:NEXT_USER_TURN',
        ]);

        slowSession.dispose();
        asyncSession.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('live subagent graph, transcripts, history timelines, and silent parent wakeup (Stage 5)', () => {
    const CHILD_1 = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
    const CHILD_2 = 'bbbbbbbb-2222-4333-8444-bbbbbbbbbbbb';
    const NESTED_1 = 'cccccccc-3333-4444-8555-cccccccccccc';

    async function brainFile(dataDir: string, uuid: string, rows: unknown[] = []): Promise<string> {
      const dir = join(dataDir, 'brain', uuid.toLowerCase(), '.system_generated', 'logs');
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'transcript.jsonl');
      await writeFile(file, rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
      return file;
    }

    it('streams live subagents, nested subagents, waiting_for_input, send_message reopen, and agentTranscript', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-stage5-live-'));
      try {
        const childPath = await brainFile(tempDir, CHILD_1, []);
        await brainFile(tempDir, NESTED_1, [
          { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Nested brief' },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            input_tokens: 200,
            output_tokens: 15,
            content: 'Nested summary ok',
          },
        ]);

        const server = createFakeAgyServer();
        let promptTurn = 0;
        server.handle('session/prompt', (params) => {
          promptTurn++;
          if (promptTurn === 1) {
            server.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call_agent_1',
                name: 'invoke_subagent',
                rawInput: { TypeName: 'research', Role: 'Repo Explorer', Prompt: 'Inspect repo' },
                status: 'in_progress',
              },
            });
            server.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call_agent_1',
                name: 'invoke_subagent',
                status: 'completed',
                rawOutput: {
                  output: `Created the following subagent:\n{\n  "conversationId": "${CHILD_1}"\n}`,
                },
              },
            });
            return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } };
          }
          // Turn 2: parent sends follow-up via send_message to CHILD_1
          server.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_send_1',
              name: 'send_message',
              rawInput: { Recipient: CHILD_1, Message: 'Check one more file' },
              status: 'completed',
              rawOutput: { output: 'Message sent.' },
            },
          });
          return { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 10 } };
        });

        const { adapter } = setup(server, {
          dataDir: tempDir,
          subagentPollMs: 15,
          subagentWaitingMs: 30,
        });
        const session = await adapter.createSession({ cwd: '/work' });
        const events = collect(session);
        await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

        session.send('launch researcher');
        await until(
          () => events.some((e) => e.type === 'agent.start' && e.agentId === 'call_agent_1'),
          'top-level agent.start',
        );
        expect(events.find((e) => e.type === 'agent.start' && e.agentId === 'call_agent_1')).toMatchObject({
          type: 'agent.start',
          agentId: 'call_agent_1',
          taskId: CHILD_1,
          description: 'Repo Explorer',
          subagentType: 'research',
          taskType: 'subagent',
          background: true,
        });

        // Child writes step 0 + step 1 with unclosed tool_call -> triggers waiting_for_input after 30ms
        await appendFile(
          childPath,
          JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Inspect repo' }) +
            '\n' +
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              thinking: 'Launching nested helper',
              tool_calls: [
                { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Sub Helper', Prompt: 'Nested brief' } },
              ],
            }) +
            '\n',
          'utf8',
        );

        await until(
          () =>
            events.some(
              (e) =>
                e.type === 'agent.progress' &&
                e.agentId === 'call_agent_1' &&
                e.status === 'waiting_for_input',
            ),
          'waiting_for_input progress',
        );

        // Complete nested subagent spawn + final round 1 response
        await appendFile(
          childPath,
          JSON.stringify({
            step_index: 2,
            type: 'GENERIC',
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${NESTED_1}"}`,
          }) +
            '\n' +
            JSON.stringify({
              step_index: 3,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              input_tokens: 700,
              output_tokens: 30,
              content: 'Round 1 complete',
            }) +
            '\n',
          'utf8',
        );

        await until(
          () =>
            events.some((e) => e.type === 'agent.end' && e.agentId === 'call_agent_1') &&
            events.some((e) => e.type === 'agent.end' && e.taskId === NESTED_1),
          'round 1 and nested agent.end',
        );

        // Parent sends follow-up message -> reopens agent.start for call_agent_1
        session.send('ask follow-up');
        await until(
          () => events.filter((e) => e.type === 'agent.start' && e.agentId === 'call_agent_1').length === 2,
          'reopened agent.start via send_message',
        );

        await appendFile(
          childPath,
          JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Check one more file' }) +
            '\n' +
            JSON.stringify({
              step_index: 5,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              input_tokens: 800,
              output_tokens: 25,
              content: 'Round 2 complete',
            }) +
            '\n',
          'utf8',
        );

        await until(
          () => events.filter((e) => e.type === 'agent.end' && e.agentId === 'call_agent_1').length === 2,
          'round 2 agent.end',
        );

        // Verify agentTranscript uses cached Role + TypeName even when chatController passes empty title ''
        const transcriptMd = await adapter.agentTranscript(DEFAULT_SESSION_ID, '/work', CHILD_1, '');
        expect(transcriptMd).toContain('# Repo Explorer · research');
        expect(transcriptMd).toContain(`conversation://${CHILD_1}`);
        expect(transcriptMd).toContain('Round 2 complete');

        // Path traversal and missing transcripts return undefined
        expect(await adapter.agentTranscript(DEFAULT_SESSION_ID, '/work', '../etc/passwd', '')).toBeUndefined();
        expect(await adapter.agentTranscript(DEFAULT_SESSION_ID, '/work', CHILD_2, '')).toBeUndefined();

        session.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('handles manage_subagents(list | kill | kill_all) and picks up silent reactive parent turn from transcript.jsonl', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-stage5-silent-'));
      try {
        const parentPath = await brainFile(tempDir, DEFAULT_SESSION_ID, [
          { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'start workers' },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            input_tokens: 500,
            output_tokens: 20,
            content: 'spawned',
          },
        ]);
        await brainFile(tempDir, CHILD_1, [
          { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'worker 1' },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            tool_calls: [{ name: 'ask_question', args: { questions: [] } }],
          },
        ]);
        await brainFile(tempDir, CHILD_2, [
          { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'worker 2' },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 30' } }],
          },
        ]);

        const server = createFakeAgyServer();
        let callNo = 0;
        server.handle('session/prompt', (params) => {
          callNo++;
          if (callNo === 1) {
            for (const [tcId, uuid, role] of [
              ['sub_a', CHILD_1, 'Worker A'],
              ['sub_b', CHILD_2, 'Worker B'],
            ] as const) {
              server.notify('session/update', {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: tcId,
                  name: 'invoke_subagent',
                  rawInput: { TypeName: 'self', Role: role, Prompt: role },
                  status: 'completed',
                  rawOutput: { output: `Created the following subagent:\n{"conversationId":"${uuid}"}` },
                },
              });
            }
            server.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'mgr_list',
                name: 'manage_subagents',
                rawInput: { Action: 'list' },
                status: 'completed',
                rawOutput: {
                  output: JSON.stringify({
                    subagents: [{ conversationId: CHILD_1, state: 'waiting_for_input' }],
                  }),
                },
              },
            });
            return { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20 } };
          }
          // Turn 2: kill_all
          server.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'mgr_kill_all',
              name: 'manage_subagents',
              rawInput: { Action: 'kill_all' },
              status: 'completed',
              rawOutput: { output: 'All killed' },
            },
          });
          return { stopReason: 'end_turn', usage: { inputTokens: 520, outputTokens: 10 } };
        });

        const { adapter } = setup(server, {
          dataDir: tempDir,
          subagentPollMs: 15,
          subagentWaitingMs: 5000, // high threshold so list triggers waiting_for_input immediately
        });
        const session = await adapter.createSession({ cwd: '/work', model: 'gemini-3.8-flash' });
        const events = collect(session);
        await until(() => events.some((e) => e.type === 'session.init'), 'session.init');

        session.send('start workers');
        await until(() => events.some((e) => e.type === 'turn.result'), 'turn 1 result');

        expect(
          events.some(
            (e) =>
              e.type === 'agent.progress' &&
              e.agentId === 'sub_a' &&
              e.status === 'waiting_for_input',
          ),
        ).toBe(true);

        // Silent reactive parent turn written ONLY to parent transcript.jsonl (no session/update on ACP stdout!)
        await appendFile(
          parentPath,
          JSON.stringify({
            step_index: 2,
            type: 'SYSTEM_MESSAGE',
            status: 'DONE',
            content: `<SYSTEM_MESSAGE>\n[Message] sender=${CHILD_1} content=Need guidance\n</SYSTEM_MESSAGE>`,
          }) +
            '\n' +
            JSON.stringify({
              step_index: 3,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              input_tokens: 3000,
              cache_read_tokens: 1000,
              output_tokens: 55,
              thinking: 'Subagent A needs input',
              content: 'SILENT_PARENT_REPLY_OK',
            }) +
            '\n',
          'utf8',
        );

        await until(
          () =>
            events.some(
              (e) => e.type === 'turn.result' && (e as AgentEventOf<'turn.result'>).text === 'SILENT_PARENT_REPLY_OK',
            ),
          'silent parent reactive turn picked up',
        );

        expect(events.filter((e) => e.type === 'context.usage').at(-1)).toMatchObject({
          usedTokens: 4055,
        });

        // Now send Turn 2 with manage_subagents(kill_all) -> both sub_a and sub_b close with status: 'stopped'
        session.send('kill everything');
        await until(
          () =>
            events.some((e) => e.type === 'agent.end' && e.agentId === 'sub_a' && e.status === 'stopped') &&
            events.some((e) => e.type === 'agent.end' && e.agentId === 'sub_b' && e.status === 'stopped'),
          'kill_all stopped both subagents',
        );

        session.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('reconstructs subagent timelines via adapter.loadHistory and populates agentTranscript metadata', async () => {
      const tempDir = await mkdtemp(join(os.tmpdir(), 'agy-stage5-history-'));
      try {
        await brainFile(tempDir, CHILD_1, [
          { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Audit code' },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            input_tokens: 600,
            output_tokens: 40,
            content: 'Audit clean',
          },
        ]);

        const server = createFakeAgyServer();
        server.handle('session/load', (params) => {
          server.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run audit' } },
          });
          server.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'hist_sub_1',
              name: 'invoke_subagent',
              status: 'completed',
              rawInput: { TypeName: 'flutter_a11y_agent', Role: 'A11y Auditor', Prompt: 'Audit code' },
              rawOutput: { output: `Created the following subagent:\n{"conversationId":"${CHILD_1}"}` },
            },
          });
          server.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Done' },
            },
          });
          return { sessionId: params.sessionId };
        });

        const { adapter } = setup(server, { dataDir: tempDir });
        const history = await adapter.loadHistory(DEFAULT_SESSION_ID, '/work');
        expect(history.events.some((e) => e.type === 'agent.start' && e.agentId === 'hist_sub_1')).toBe(true);
        expect(history.events.find((e) => e.type === 'agent.end' && e.agentId === 'hist_sub_1')).toMatchObject({
          type: 'agent.end',
          agentId: 'hist_sub_1',
          taskId: CHILD_1,
          status: 'completed',
          summary: 'Audit clean',
        });

        // Metadata cached during loadHistory is used by agentTranscript
        const md = await adapter.agentTranscript(DEFAULT_SESSION_ID, '/work', CHILD_1, '');
        expect(md).toContain('# A11y Auditor · flutter_a11y_agent');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
