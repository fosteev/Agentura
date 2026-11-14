import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from '../types';
import { KimiAdapter } from './adapter';
import { DEFAULT_KIMI_SESSION_ID, FakeKimiAcp, createFakeKimiServer } from './fakeServer';
import { KimiSessionIndex, memoryStore } from './sessionIndex';

function setup(server: FakeKimiAcp, state = memoryStore()) {
  return new KimiAdapter({ executablePath: '/bin/kimi', spawn: () => server, state, graceMs: 20 });
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

describe('Kimi confirmed session settings', () => {
  it('maps model/effort/all permission modes and applies options only to a new session', async () => {
    const server = createFakeKimiServer();
    const adapter = setup(server);
    const session = await adapter.createSession({
      cwd: '/work', model: 'kimi-code/k3', effort: 'low', permissionMode: 'acceptEdits',
    });
    const events = collect(session);
    await session.capabilities();
    expect(server.paramsOf('session/set_model')).toEqual({
      sessionId: DEFAULT_KIMI_SESSION_ID, modelId: 'kimi-code/k3',
    });
    expect(server.paramsOf('session/set_config_option')).toEqual({
      sessionId: DEFAULT_KIMI_SESSION_ID, configId: 'thinking', value: 'low',
    });
    expect(server.paramsOf('session/set_mode')).toEqual({ sessionId: DEFAULT_KIMI_SESSION_ID, modeId: 'auto' });
    expect(events.filter((event) => event.type === 'session.init').at(-1)).toMatchObject({
      model: 'kimi-code/k3', effort: 'low', permissionMode: 'acceptEdits',
    });
    await session.setMode('default');
    await session.setMode('plan');
    await session.setMode('bypassPermissions');
    expect(server.received.filter((message) => message.method === 'session/set_mode').at(-1)?.params).toMatchObject({ modeId: 'default' });
    session.dispose();

    const allowed = createFakeKimiServer();
    const bypass = await setup(allowed).createSession({ cwd: '/work', allowBypassPermissions: true });
    await bypass.capabilities();
    await bypass.setMode('bypassPermissions');
    expect(allowed.paramsOf('session/set_mode')).toMatchObject({ modeId: 'yolo' });
    expect((await bypass.capabilities()).models.find((model) => model.value === 'kimi-code/k3.1-pro')?.effortLevels)
      .toEqual(['low', 'high', 'max']);
    bypass.dispose();
  });

  it('returns RPC errors and re-emits actual model/effort/mode after every rejected change', async () => {
    const server = createFakeKimiServer();
    const session = await setup(server).createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    const rejected = (message: string) => () => {
      throw Object.assign(new Error(message), { code: -32602 });
    };
    server.handle('session/set_model', rejected('bad model'));
    await expect(session.setModel('invalid')).rejects.toThrow('bad model');
    expect(events.filter((event) => event.type === 'session.init').at(-1)).toMatchObject({
      model: 'kimi-code/k3.1-pro', effort: 'high', permissionMode: 'default',
    });
    server.handle('session/set_config_option', rejected('bad thinking'));
    await expect(session.setEffort('low')).rejects.toThrow('bad thinking');
    expect(events.filter((event) => event.type === 'session.init').at(-1)).toMatchObject({ effort: 'high' });
    server.handle('session/set_mode', rejected('bad mode'));
    await expect(session.setMode('plan')).rejects.toThrow('bad mode');
    expect(events.filter((event) => event.type === 'session.init').at(-1)).toMatchObject({ permissionMode: 'default' });
    expect(events.filter((event) => event.type === 'error').map((event) => event.message)).toEqual([
      'session/set_model failed: bad model',
      'session/set_config_option thinking failed: bad thinking',
      'session/set_mode failed: bad mode',
    ]);
    session.dispose();
  });

  it('keeps real boolean thinking separate and hides effort picker without fake EffortLevel', async () => {
    const state = memoryStore();
    const server = createFakeKimiServer();
    const session = await setup(server, state).createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    const frames = readFileSync(join(__dirname, '../../../test/fixtures/kimi/acp-config-boolean.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const update = frames.find((frame) => frame.scenario === 'config/thinking/on' && frame.msg.method === 'session/update').msg.params.update;
    server.update(DEFAULT_KIMI_SESSION_ID, update);
    await until(() => {
      const init = events.filter((event) => event.type === 'session.init').at(-1);
      return init?.type === 'session.init' && init.model === 'kimi-code/kimi-for-coding-highspeed';
    }, 'boolean config');
    const init = events.filter((event) => event.type === 'session.init').at(-1)!;
    expect(init.effort).toBeUndefined();
    const current = (await session.capabilities()).models.find((model) => model.value === init.model)!;
    expect(current).toMatchObject({ supportsEffort: false });
    expect(current.effortLevels).toBeUndefined();
    const saved = new KimiSessionIndex(state).settingsOf(DEFAULT_KIMI_SESSION_ID);
    expect(saved).toMatchObject({ model: init.model, permissionMode: 'default' });
    expect(saved?.effort).toBeUndefined();
    session.dispose();
  });

  it('persists confirmed settings but resume trusts server state instead of index/defaults', async () => {
    const state = memoryStore();
    const firstServer = createFakeKimiServer();
    const first = await setup(firstServer, state).createSession({ cwd: '/work' });
    await first.capabilities();
    await first.setModel('kimi-code/k3');
    await first.setEffort('low');
    await first.setMode('plan');
    expect(new KimiSessionIndex(state).settingsOf(DEFAULT_KIMI_SESSION_ID)).toEqual({
      model: 'kimi-code/k3', effort: 'low', permissionMode: 'plan',
    });
    first.dispose();

    const resumedServer = createFakeKimiServer();
    const resumed = await setup(resumedServer, state).resumeSession(DEFAULT_KIMI_SESSION_ID, {
      cwd: '/work', model: 'must-not-apply', effort: 'max', permissionMode: 'bypassPermissions', allowBypassPermissions: true,
    });
    const events = collect(resumed);
    await resumed.capabilities();
    expect(resumedServer.methods()).not.toContain('session/set_model');
    expect(resumedServer.methods()).not.toContain('session/set_config_option');
    expect(resumedServer.methods()).not.toContain('session/set_mode');
    expect(events.filter((event) => event.type === 'session.init').at(-1)).toMatchObject({
      model: 'kimi-code/k3.1-pro', effort: 'high', permissionMode: 'default',
    });
    expect(await setup(createFakeKimiServer(), state).accountInfo('/work')).toEqual({});
    resumed.dispose();
  });
});
