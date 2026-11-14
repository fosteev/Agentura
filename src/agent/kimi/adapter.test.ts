import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcpRpcError } from '../acp/client';
import type { AgentEvent, AgentSession, PromptFile, PromptImage } from '../types';
import { KimiAdapter, type KimiAdapterConfig, type KimiSpawnOptions } from './adapter';
import {
  DEFAULT_KIMI_SESSION_ID,
  FakeKimiAcp,
  createFakeKimiServer,
  makeKimiConfigOptions,
} from './fakeServer';

function setup(server: FakeKimiAcp = createFakeKimiServer(), config: Partial<KimiAdapterConfig> = {}) {
  const logs: string[] = [];
  const spawned: { path: string; args: string[]; options: KimiSpawnOptions }[] = [];
  const adapter = new KimiAdapter({
    executablePath: '/bin/kimi',
    engineVersion: '2.6.0',
    spawn: (path, args, options) => {
      spawned.push({ path, args, options });
      return server;
    },
    graceMs: 20,
    interruptWaitMs: 50,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...config,
  });
  return { adapter, logs, spawned, server };
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((event) => events.push(event));
  return events;
}

async function until(condition: () => boolean, what = 'condition', max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout: ${what}`);
}

function fixtureUpdates(scenario: string): unknown[] {
  const frames = readFileSync(join(__dirname, '../../../test/fixtures/kimi/acp-basic.ndjson'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  return frames
    .filter((frame) => frame.dir === 'out' && frame.scenario === scenario && frame.msg.method === 'session/update')
    .map((frame) => frame.msg.params.update);
}

describe('KimiAdapter ACP core', () => {
  it('handshakes, streams fake text/thoughts, commands and confirmed context', async () => {
    const { adapter, server, spawned } = setup();
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    const capabilities = await session.capabilities();
    await until(() => events.some((event) => event.type === 'session.init'), 'session.init');

    expect(server.paramsOf('initialize')).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} },
      },
    });
    expect(spawned[0]?.args).toEqual(['acp']);
    expect(events.find((event) => event.type === 'session.init')).toMatchObject({
      sessionId: DEFAULT_KIMI_SESSION_ID, model: 'kimi-code/k3.1-pro', effort: 'high', engineVersion: '2.6.0',
    });
    expect(capabilities.models.find((model) => model.value === 'kimi-code/k3.1-pro')).toMatchObject({
      effortLevels: ['low', 'high', 'max'],
    });

    session.send('ping');
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('')).toBe('pong');
    expect(events.some((event) => event.type === 'thinking.delta')).toBe(true);
    expect(events.some((event) => event.type === 'session.title')).toBe(true);
    expect(events.find((event) => event.type === 'turn.result')).toMatchObject({ ok: true, usageKnown: false });
    expect(events.find((event) => event.type === 'context.usage')).toMatchObject({
      usedTokens: 19219, maxTokens: 1048576, source: 'engine',
    });
    await expect(session.contextUsage()).resolves.toMatchObject({ usedTokens: 19219, maxTokens: 1048576 });
    await expect(session.capabilities()).resolves.toMatchObject({
      commands: expect.arrayContaining([expect.objectContaining({ name: 'compact' })]),
    });
    session.dispose();
  });

  it('sends images and embedded text resources, while PDF is explicitly dropped', async () => {
    const server = createFakeKimiServer();
    let prompt: unknown;
    server.handle('session/prompt', (params) => {
      prompt = params.prompt;
      return { stopReason: 'end_turn' };
    });
    const { adapter, logs } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    const image: PromptImage = { mediaType: 'image/png', data: 'QUJD' };
    const files: PromptFile[] = [
      { kind: 'text', path: 'a.txt', data: 'RESOURCE_MARKER_1002', size: 20 },
      { kind: 'pdf', path: 'a.pdf', data: 'JVBERi0=', size: 8 },
    ];
    session.send('inspect', [image], files);
    await until(() => events.some((event) => event.type === 'turn.result'), 'turn.result');
    expect(prompt).toEqual([
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///work/a.txt', mimeType: 'text/plain', text: 'RESOURCE_MARKER_1002' } },
      { type: 'text', text: 'inspect' },
    ]);
    expect(logs.some((line) => /PDF attachment/.test(line))).toBe(true);
    session.dispose();
  });

  it('serializes queued turns instead of overlapping session/prompt', async () => {
    const server = createFakeKimiServer();
    let releaseFirst!: (result: unknown) => void;
    let calls = 0;
    server.handle('session/prompt', () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => (releaseFirst = resolve));
      server.update(DEFAULT_KIMI_SESSION_ID, {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' },
      });
      return { stopReason: 'end_turn' };
    });
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('first');
    session.send('second');
    await until(() => calls === 1, 'first prompt');
    expect(calls).toBe(1);
    releaseFirst({ stopReason: 'end_turn' });
    await until(() => events.filter((event) => event.type === 'turn.result').length === 2, 'two results');
    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === 'turn.start').map((event) => event.prompt)).toEqual(['first', 'second']);
    session.dispose();
  });

  it('Stop sends session/cancel and the same process accepts another turn', async () => {
    const server = createFakeKimiServer();
    let finishStop!: (result: unknown) => void;
    let calls = 0;
    server.handle('session/prompt', () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => (finishStop = resolve));
      server.update(DEFAULT_KIMI_SESSION_ID, {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' },
      });
      return { stopReason: 'end_turn' };
    });
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('long');
    await until(() => server.methods().includes('session/prompt'), 'prompt');
    const stopping = session.interrupt();
    expect(server.paramsOf('session/cancel')).toEqual({ sessionId: DEFAULT_KIMI_SESSION_ID });
    finishStop({ stopReason: 'cancelled' });
    await stopping;
    expect(events.find((event) => event.type === 'turn.result')).toMatchObject({
      subtype: 'cancelled', interrupted: true, ok: false,
    });
    session.send('after');
    await until(() => events.filter((event) => event.type === 'turn.result').length === 2, 'after cancel');
    expect(events.filter((event) => event.type === 'turn.result').at(-1)).toMatchObject({ ok: true, text: 'after' });
    session.dispose();
  });

  it('resumeSession uses session/resume and does not overwrite server config with defaults', async () => {
    const server = createFakeKimiServer();
    const { adapter } = setup(server);
    const session = await adapter.resumeSession('existing-kimi', {
      cwd: '/work', model: 'must-not-be-applied', permissionMode: 'plan', effort: 'low',
    });
    const events = collect(session);
    await session.capabilities();
    expect(server.paramsOf('session/resume')).toEqual({ sessionId: 'existing-kimi', cwd: '/work', mcpServers: [] });
    expect(server.methods()).not.toContain('session/set_config_option');
    expect(server.methods()).not.toContain('session/set_mode');
    expect(events.find((event) => event.type === 'session.init')).toMatchObject({
      sessionId: 'existing-kimi', model: 'kimi-code/k3.1-pro', effort: 'high', permissionMode: 'default',
    });
    session.dispose();
  });

  it('absorbs config_option_update and current_mode_update into existing events', async () => {
    const server = createFakeKimiServer();
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    server.update(DEFAULT_KIMI_SESSION_ID, {
      sessionUpdate: 'config_option_update',
      configOptions: makeKimiConfigOptions('kimi-code/k3', 'low', 'default'),
    });
    server.update(DEFAULT_KIMI_SESSION_ID, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
    await until(() => events.some((event) => event.type === 'mode.changed'), 'mode.changed');
    expect(events.filter((event) => event.type === 'session.init').at(-1)).toMatchObject({
      model: 'kimi-code/k3', effort: 'low', permissionMode: 'acceptEdits',
    });
    expect(events.find((event) => event.type === 'mode.changed')).toMatchObject({ mode: 'acceptEdits' });
    session.dispose();
  });

  it('fake server replays real Read and Edit fixtures through the full adapter', async () => {
    const server = createFakeKimiServer();
    server.handle('session/prompt', (params) => {
      const blocks = params.prompt as { type: string; text?: string }[];
      const scenario = blocks.find((block) => block.type === 'text')?.text ?? '';
      for (const update of fixtureUpdates(scenario)) server.update(DEFAULT_KIMI_SESSION_ID, update);
      return { stopReason: 'end_turn' };
    });
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('tool-read');
    await until(() => events.some((event) => event.type === 'turn.result'), 'Read result');
    session.send('edit');
    await until(() => events.filter((event) => event.type === 'turn.result').length === 2, 'Edit result');
    expect(events.filter((event) => event.type === 'tool.start')).toHaveLength(2);
    const edit = events.filter((event) => event.type === 'tool.result').at(-1);
    expect(edit).toMatchObject({
      result: expect.objectContaining({ filePath: '<WORK>/out.txt', structuredPatch: expect.any(Array) }),
    });
    session.dispose();
  });

  it('RPC errors close only the turn; process crashes close the session with raw error text', async () => {
    const server = createFakeKimiServer();
    let calls = 0;
    server.handle('session/prompt', () => {
      calls++;
      if (calls === 1) throw new AcpRpcError('Unknown thinking value', -32602, undefined, 'Kimi');
      server.update(DEFAULT_KIMI_SESSION_ID, {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' },
      });
      return { stopReason: 'end_turn' };
    });
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('bad');
    await until(() => events.some((event) => event.type === 'turn.result'), 'RPC error result');
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      fatal: false, message: 'Unknown thinking value', code: '-32602',
    });
    expect(events.find((event) => event.type === 'turn.result')).toMatchObject({
      subtype: 'error', errors: ['Unknown thinking value'],
    });
    session.send('good');
    await until(() => events.filter((event) => event.type === 'turn.result').length === 2, 'recovered result');
    expect(events.filter((event) => event.type === 'turn.result').at(-1)).toMatchObject({ ok: true, text: 'recovered' });
    session.dispose();

    const crashing = createFakeKimiServer();
    crashing.handle('session/prompt', () => {
      setTimeout(() => crashing.exit(1), 5);
      return new Promise(() => {});
    });
    const crashed = await setup(crashing).adapter.createSession({ cwd: '/work' });
    const crashEvents = collect(crashed);
    await crashed.capabilities();
    crashed.send('crash');
    await until(() => crashEvents.some((event) => event.type === 'session.closed'), 'session.closed');
    expect(crashEvents.find((event) => event.type === 'turn.result')).toMatchObject({ subtype: 'error' });
    expect(crashEvents.filter((event) => event.type === 'error').at(-1)).toMatchObject({ fatal: true });
  });

  it('turn boundary cancels unanswered reverse requests instead of leaving them hanging', async () => {
    const server = createFakeKimiServer();
    server.handle('session/prompt', (params) => {
      server.request(0, 'session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call', title: 'Bash' },
        options: [{ optionId: 'reject', kind: 'reject_once' }],
      });
      server.request('question', 'elicitation/create', { mode: 'form', requestedSchema: { type: 'object' } });
      return { stopReason: 'end_turn' };
    });
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('requests');
    await until(() => server.replies().length === 2, 'reverse replies');
    expect(server.replies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 0, result: { outcome: { outcome: 'cancelled' } } }),
      expect.objectContaining({ id: 'question', result: { action: 'decline' } }),
    ]));
    expect(events.some((event) => event.type === 'permission.request')).toBe(true);
    expect(session.respondPermission('call', 'allow')).toBe(false);
    expect(session.answerQuestion('call', {})).toBe(false);
    await expect(session.setMode('plan')).resolves.toBeUndefined();
    session.dispose();
  });

  it('dispose performs session/close before stdin shutdown', async () => {
    const server = createFakeKimiServer();
    const { adapter } = setup(server);
    const session = await adapter.createSession({ cwd: '/work' });
    await session.capabilities();
    session.dispose();
    await until(() => server.exited, 'graceful exit');
    expect(server.methods()).toContain('session/close');
    expect(server.paramsOf('session/close')).toEqual({ sessionId: DEFAULT_KIMI_SESSION_ID });
    expect(server.signals).toEqual([]);
  });

  it('shutdown escalates stdin end to SIGTERM and SIGKILL by timeout', async () => {
    const server = createFakeKimiServer();
    server.handle('session/close', () => new Promise(() => {}));
    server.ignoreStdinEnd = true;
    server.ignoreTerm = true;
    const { adapter } = setup(server, { graceMs: 10 });
    const session = await adapter.createSession({ cwd: '/work' });
    await session.capabilities();
    session.dispose();
    await until(() => server.signals.includes('SIGKILL'), 'SIGKILL');
    expect(server.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(server.methods()).toContain('session/close');
  });
});
