import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession, PromptFile, PromptImage } from '../types';
import { CursorAdapter, type CursorAdapterConfig, type CursorSpawnOptions } from './adapter';
import { CURSOR_NOT_FOUND } from './executable';
import { FakeAcp } from './fakeServer';

const SESSION = 'sess-1';

function server(): FakeAcp {
  const s = new FakeAcp();
  s.handle('initialize', () => ({ protocolVersion: 1 }));
  s.handle('authenticate', () => ({}));
  s.handle('session/new', () => ({
    sessionId: SESSION,
    models: {
      currentModelId: 'gpt-5.4-nano[reasoning=medium]',
      availableModels: [
        { modelId: 'default[]', name: 'Auto' },
        { modelId: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]', name: 'grok-4.7' },
        { _modelsCount: 47 },
      ],
    },
  }));
  s.handle('session/load', (p) => ({
    sessionId: p.sessionId,
    models: { currentModelId: 'default[]', availableModels: [{ modelId: 'default[]', name: 'Auto' }] },
  }));
  s.handle('session/set_config_option', () => ({}));
  return s;
}

function open(s: FakeAcp, config: Partial<CursorAdapterConfig> = {}) {
  const logs: string[] = [];
  const spawned: { args: string[]; options: CursorSpawnOptions }[] = [];
  const env = { PATH: '/usr/bin', CURSOR_API_KEY: 'should-not-be-logged' };
  const adapter = new CursorAdapter({
    executablePath: '/bin/agent',
    engineVersion: '2026.11.05-86047df',
    spawn: (path, args, options) => {
      spawned.push({ args: [path, ...args], options });
      return s;
    },
    env,
    graceMs: 20,
    interruptWaitMs: 30,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...config,
  });
  return { adapter, logs, spawned, env };
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((e) => events.push(e));
  return events;
}

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout: ${what}`);
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('CursorAdapter', () => {
  it('pong: initialize, authenticate, session/new, текст без мыслей, turn.result', async () => {
    const s = server();
    s.handle('session/prompt', () => {
      s.notify('session/update', {
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The user wants pong' } },
      });
      s.notify('session/update', {
        sessionId: SESSION,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'copy-request-id' }, { _commandsCount: 115 }] },
      });
      s.notify('session/update', {
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'p' } },
      });
      s.notify('session/update', {
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ong' } },
      });
      return { stopReason: 'end_turn' };
    });
    const { adapter, spawned, env } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(events[0]).toMatchObject({
      type: 'session.init',
      sessionId: SESSION,
      model: 'gpt-5.4-nano[reasoning=medium]',
      cwd: '/work',
      permissionMode: 'default',
      tools: [],
      slashCommands: [],
      skills: [],
      engineVersion: '2026.11.05-86047df',
      apiKeySource: 'none',
    });
    expect(spawned[0]?.args).toEqual(['/bin/agent', 'acp']);
    expect(spawned[0]?.options.shell).toBe(false);
    expect(spawned[0]?.options.cwd).toBe('/work');
    expect(spawned[0]?.options.env).toBe(env);
    expect(JSON.stringify(spawned[0]?.args)).not.toMatch(/force|yolo|--model/);
    const caps = await session.capabilities();
    expect(caps.models.map((m) => m.value)).toEqual([
      'default[]',
      'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
    ]);
    expect(caps.commands).toEqual([]);

    session.send('Reply with exactly one word: pong');
    await until(() => types(events).includes('turn.result'));
    const deltas = events.filter((e) => e.type === 'text.delta');
    expect(deltas.map((e) => (e.type === 'text.delta' ? e.text : '')).join('')).toBe('pong');
    expect(deltas.map((e) => (e.type === 'text.delta' ? e.text : '')).join('')).not.toContain('user wants');
    expect(deltas[0]).toMatchObject({ messageId: 'c1' });
    expect(deltas[1]).toMatchObject({ messageId: 'c1' });
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', ok: true, interrupted: false, subtype: 'end_turn' });
    expect(types(events)).toEqual(['session.init', 'turn.start', 'text.delta', 'text.delta', 'turn.result']);
    expect(s.methods().filter((m) => m !== '<response>')).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/prompt',
    ]);
    session.dispose();
  });

  it('второй send во время хода ждёт в очереди и не склеивается с первым', async () => {
    const s = server();
    const pending: ((value: unknown) => void)[] = [];
    s.handle('session/prompt', () => new Promise((resolve) => pending.push(resolve)));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('one');
    await until(() => s.methods().filter((m) => m === 'session/prompt').length === 1);
    session.send('two');
    await new Promise((r) => setTimeout(r, 20));
    expect(s.methods().filter((m) => m === 'session/prompt')).toEqual(['session/prompt']);
    expect(s.paramsOf('session/prompt').prompt).toEqual([{ type: 'text', text: 'one' }]);
    pending[0]!({ stopReason: 'end_turn' });
    await until(() => s.methods().filter((m) => m === 'session/prompt').length === 2);
    expect(s.paramsOf('session/prompt', 1).prompt).toEqual([{ type: 'text', text: 'two' }]);
    pending[1]!({ stopReason: 'end_turn' });
    await until(() => events.filter((e) => e.type === 'turn.result').length === 2);
    session.dispose();
  });

  it('модель из createSession уходит в set_config_option до session.init', async () => {
    const s = server();
    let release: (value: unknown) => void = () => {};
    s.handle('session/set_config_option', () => new Promise((resolve) => (release = resolve)));
    const session = await open(s).adapter.createSession({
      cwd: '/work',
      model: 'composer-2.5[fast=true]',
    });
    const events = collect(session);
    await until(() => s.methods().includes('session/set_config_option'));
    expect(types(events)).not.toContain('session.init');
    expect(s.paramsOf('session/set_config_option')).toEqual({
      sessionId: SESSION,
      configId: 'model',
      value: 'composer-2.5[fast=true]',
    });
    release({});
    await until(() => types(events).includes('session.init'));
    expect(events.find((e) => e.type === 'session.init')).toMatchObject({ model: 'composer-2.5[fast=true]' });
    session.dispose();
  });

  it('interrupt до старта хода: turn.start и interrupted, процесс жив, prompt не ушёл', async () => {
    const s = server();
    let release: (value: unknown) => void = () => {};
    s.handle('initialize', () => new Promise((resolve) => (release = resolve)));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('hello');
    await session.interrupt();
    release({ protocolVersion: 1 });
    await until(() => types(events).includes('turn.result'), 'synthetic turn');
    expect(types(events).filter((t) => t === 'turn.start' || t === 'turn.result')).toEqual(['turn.start', 'turn.result']);
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ ok: false, interrupted: true });
    expect(s.methods()).not.toContain('session/prompt');
    expect(s.exited).toBe(false);
    expect(s.killed).toBe(false);
    session.dispose();
  });

  it('Stop до старта снимает уже взятый промпт, следующий в очереди уходит отдельно', async () => {
    const s = server();
    let release: (value: unknown) => void = () => {};
    s.handle('initialize', () => new Promise((resolve) => (release = resolve)));
    s.handle('session/prompt', () => ({ stopReason: 'end_turn' }));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    session.send('two');
    await session.interrupt();
    release({ protocolVersion: 1 });
    await until(() => s.methods().includes('session/prompt'));
    expect(s.paramsOf('session/prompt').prompt).toEqual([{ type: 'text', text: 'two' }]);
    expect(s.methods().filter((m) => m === 'session/prompt')).toEqual(['session/prompt']);
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ interrupted: true, ok: false });
    expect(s.killed).toBe(false);
    session.dispose();
  });

  it('Stop посреди хода — session/cancel без id, stopReason cancelled, процесс жив', async () => {
    const s = server();
    let release: (value: unknown) => void = () => {};
    s.handle('session/prompt', () => new Promise((resolve) => (release = resolve)));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('sleep');
    await until(() => s.methods().includes('session/prompt'));
    const done = session.interrupt();
    await until(() => s.methods().includes('session/cancel'));
    const cancel = s.received.find((m) => m.method === 'session/cancel');
    expect(cancel).toMatchObject({ method: 'session/cancel', params: { sessionId: SESSION } });
    expect(cancel).not.toHaveProperty('id');
    release({ stopReason: 'cancelled' });
    await done;
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({
      ok: false,
      interrupted: true,
      subtype: 'cancelled',
    });
    expect(s.killed).toBe(false);
    expect(s.exited).toBe(false);
    session.dispose();
  });

  it('Stop посреди хода не склеивает следующее сообщение и не убивает процесс', async () => {
    const s = server();
    const pending: ((value: unknown) => void)[] = [];
    s.handle('session/prompt', () => new Promise((resolve) => pending.push(resolve)));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('one');
    await until(() => s.methods().includes('session/prompt'));
    session.send('two');
    const done = session.interrupt();
    await until(() => s.methods().includes('session/cancel'));
    expect(s.methods().filter((m) => m === 'session/prompt')).toEqual(['session/prompt']);
    expect(s.paramsOf('session/prompt').prompt).toEqual([{ type: 'text', text: 'one' }]);
    expect(s.killed).toBe(false);
    pending[0]!({ stopReason: 'cancelled' });
    await done;
    await until(() => s.methods().filter((m) => m === 'session/prompt').length === 2);
    expect(s.paramsOf('session/prompt', 1).prompt).toEqual([{ type: 'text', text: 'two' }]);
    expect(s.killed).toBe(false);
    pending[1]!({ stopReason: 'end_turn' });
    await until(() => events.filter((e) => e.type === 'turn.result').length === 2);
    session.dispose();
  });

  it('stdout оборвался посреди хода: turn.result ok=false, error fatal, session.closed', async () => {
    const s = server();
    s.handle('session/prompt', () => new Promise(() => {}));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('hello');
    await until(() => s.methods().includes('session/prompt'));
    s.exit(1);
    await until(() => types(events).includes('session.closed'));
    const tail = events.slice(events.findIndex((e) => e.type === 'turn.result'));
    expect(tail.map((e) => e.type)).toEqual(['turn.result', 'error', 'session.closed']);
    expect(tail[0]).toMatchObject({ type: 'turn.result', ok: false });
    expect(tail[1]).toMatchObject({ type: 'error', fatal: true });
    expect(tail[2]).toMatchObject({ type: 'session.closed' });
  });

  it('resume зовёт session/load и не рисует повтор истории как живой текст', async () => {
    const s = server();
    s.handle('session/load', (p) => {
      s.notify('session/update', {
        sessionId: p.sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Reply with exactly one word: pong' } },
      });
      s.notify('session/update', {
        sessionId: p.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
      });
      return { sessionId: p.sessionId, models: { currentModelId: 'default[]', availableModels: [] } };
    });
    const session = await open(s).adapter.resumeSession('sess-9', { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(events.some((e) => e.type === 'text.delta')).toBe(false);
    expect(events.find((e) => e.type === 'session.init')).toMatchObject({ sessionId: 'sess-9' });
    expect(s.paramsOf('session/load')).toEqual({ sessionId: 'sess-9', cwd: '/work', mcpServers: [] });
    expect(s.methods()).not.toContain('session/new');
    session.dispose();
  });

  it('разрешение id 0 до этапа 3 — отказ reject-once, ход не зависает', async () => {
    const s = server();
    s.handle('session/prompt', () => {
      s.request(0, 'session/request_permission', {
        sessionId: SESSION,
        options: [{ optionId: 'reject-once', kind: 'reject_once' }],
      });
      return { stopReason: 'end_turn' };
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('curl');
    await until(() => types(events).includes('turn.result'));
    expect(s.replies()).toContainEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });
    expect(events.some((e) => e.type === 'permission.request')).toBe(false);
    session.dispose();
  });

  it('картинки и файлы — warn и дроп, уходит только текст', async () => {
    const s = server();
    s.handle('session/prompt', () => ({ stopReason: 'end_turn' }));
    const { adapter, logs } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    const image: PromptImage = { mediaType: 'image/png', data: 'aGVsbG8=' };
    const file: PromptFile = { kind: 'text', path: 'a.txt', data: 'hi', size: 2 };
    expect(session.send('hello', [image], [file])).toBe(true);
    await until(() => s.methods().includes('session/prompt'));
    expect(s.paramsOf('session/prompt').prompt).toEqual([{ type: 'text', text: 'hello' }]);
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('image'))).toBe(true);
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('file'))).toBe(true);
    session.dispose();
  });

  it('setModel — session/set_config_option configId model', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    collect(session);
    await session.setModel('composer-2.5[fast=true]');
    expect(s.paramsOf('session/set_config_option')).toEqual({
      sessionId: SESSION,
      configId: 'model',
      value: 'composer-2.5[fast=true]',
    });
    session.dispose();
  });

  it('нет пути к бинарнику — createSession бросает «не найден»', async () => {
    const adapter = new CursorAdapter({ executablePath: '' });
    await expect(adapter.createSession({ cwd: '/work' })).rejects.toThrow(CURSOR_NOT_FOUND);
    await expect(new CursorAdapter().createSession({ cwd: '/work' })).rejects.toThrow(CURSOR_NOT_FOUND);
  });

  it('dispose: stdin закрывается; зависший процесс — kill после grace, затем SIGKILL', async () => {
    const polite = server();
    const a = await open(polite).adapter.createSession({ cwd: '/work' });
    const eventsA = collect(a);
    await until(() => types(eventsA).includes('session.init'));
    a.dispose();
    await until(() => polite.exited);
    expect(polite.killed).toBe(false);
    expect(eventsA.at(-1)).toMatchObject({ type: 'session.closed', reason: 'disposed' });

    const stubborn = server();
    stubborn.ignoreStdinEnd = true;
    const b = await open(stubborn).adapter.createSession({ cwd: '/work' });
    await until(() => stubborn.methods().includes('authenticate'));
    b.dispose();
    expect(stubborn.killed).toBe(false);
    expect(stubborn.signals).toEqual([]);
    await until(() => stubborn.killed, 'kill');
    expect(stubborn.signals[0]).toBe('SIGTERM');

    const deaf = server();
    deaf.ignoreStdinEnd = true;
    deaf.ignoreTerm = true;
    const c = await open(deaf).adapter.createSession({ cwd: '/work' });
    await until(() => deaf.methods().includes('authenticate'));
    c.dispose();
    expect(deaf.signals).toEqual([]);
    await until(() => deaf.signals.includes('SIGTERM'), 'SIGTERM');
    expect(deaf.exited).toBe(false);
    await until(() => deaf.exited, 'SIGKILL');
    expect(deaf.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
