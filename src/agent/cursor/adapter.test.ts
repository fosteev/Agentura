import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  s.handle('session/load', () => ({
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

const STANDARD = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

function permissionParams(
  options: { optionId: string; kind: string; name?: string }[] = STANDARD,
  toolCallId = 'tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7',
) {
  return {
    sessionId: SESSION,
    toolCall: {
      toolCallId,
      title: '`curl`',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'curl' },
      content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist: curl' } }],
    },
    options,
  };
}

/** Ход не заканчивается, пока клиент не ответит на server request с этим id. */
function waitForReply(s: FakeAcp, id: number, fire: () => void): void {
  s.handle('session/prompt', () => {
    fire();
    return replyWhen(s, id);
  });
}

function replyWhen(s: FakeAcp, id: number): Promise<{ stopReason: string }> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (s.replies().some((r) => r.id === id && r.result !== undefined)) {
        clearInterval(timer);
        resolve({ stopReason: 'end_turn' });
      }
    }, 5);
  });
}

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

  it('ход и ожидание разрешения не ограничены RPC-таймаутом в две минуты', async () => {
    const s = server();
    let release!: (value: unknown) => void;
    s.handle('session/prompt', () => new Promise((resolve) => {
      release = resolve;
      s.request(0, 'session/request_permission', permissionParams());
    }));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    vi.useFakeTimers();
    try {
      session.send('long work');
      await vi.advanceTimersByTimeAsync(180_000);
      expect(types(events)).toContain('permission.request');
      expect(types(events)).not.toContain('session.closed');
      expect(types(events)).not.toContain('turn.result');
      const card = events.find((e) => e.type === 'permission.request');
      expect(session.respondPermission(card!.toolUseId, 'allow')).toBe(true);
      release({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter((e) => e.type === 'turn.result')).toMatchObject([{ ok: true }]);
    } finally {
      session.dispose();
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();
    }
  });

  it('Stop без ответа закрывает транспорт и не запускает очередь поверх старого хода', async () => {
    const s = server();
    s.ignoreStdinEnd = true;
    s.ignoreTerm = true;
    let release!: (value: unknown) => void;
    s.handle('session/prompt', () => new Promise((resolve) => (release = resolve)));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    vi.useFakeTimers();
    try {
      session.send('first');
      await vi.advanceTimersByTimeAsync(0);
      session.send('queued');
      const stopped = session.interrupt();
      await vi.advanceTimersByTimeAsync(30);
      await stopped;
      expect(events.filter((e) => e.type === 'turn.result')).toMatchObject([{ interrupted: true }]);
      expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: true });
      expect(types(events)).toContain('session.closed');
      expect(session.send('next')).toBe(false);
      const count = events.length;
      s.notify('session/update', {
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
      });
      release({ stopReason: 'cancelled' });
      await vi.advanceTimersByTimeAsync(50);
      expect(events).toHaveLength(count);
      expect(s.methods().filter((m) => m === 'session/prompt')).toHaveLength(1);
      expect(s.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      session.dispose();
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();
    }
  });

  it('resume принимает session/load из записанного протокола без sessionId и продолжает чат', async () => {
    const s = server();
    replayLoad(s);
    s.handle('session/prompt', () => ({ stopReason: 'end_turn' }));
    const session = await open(s).adapter.resumeSession('sess-pong', { cwd: '/work' });
    const events = collect(session);
    try {
      await session.capabilities();
      expect(events.find((e) => e.type === 'session.init')).toMatchObject({ sessionId: 'sess-pong' });
      expect(types(events)).not.toContain('text.delta');
      expect(session.send('continue')).toBe(true);
      await until(() => types(events).includes('turn.result'));
      expect(s.paramsOf('session/prompt').sessionId).toBe('sess-pong');
    } finally {
      session.dispose();
    }
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
      return { models: { currentModelId: 'default[]', availableModels: [] } };
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

  it('разрешение во время session/load — отказ без карточки', async () => {
    const s = server();
    s.handle('session/load', () => {
      s.request(0, 'session/request_permission', permissionParams());
      return { models: { currentModelId: 'default[]', availableModels: [] } };
    });
    const session = await open(s).adapter.resumeSession('sess-9', { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(events.some((e) => e.type === 'permission.request')).toBe(false);
    expect(s.replies()[0]).toMatchObject({
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });
    session.dispose();
  });

  it('tool во время хода: kind сервера, ход доходит до turn.result', async () => {
    const s = server();
    s.handle('session/prompt', () => {
      s.notify('session/update', {
        sessionId: SESSION,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool_read_1',
          title: 'Read note',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'note.txt' },
        },
      });
      s.notify('session/update', {
        sessionId: SESSION,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool_read_1',
          status: 'completed',
          rawOutput: { content: 'marker-alpha\n' },
        },
      });
      s.notify('session/update', {
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      });
      return { stopReason: 'end_turn' };
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('read');
    await until(() => types(events).includes('turn.result'));
    expect(events.find((e) => e.type === 'tool.start')).toMatchObject({
      toolUseId: 'tool_read_1',
      name: 'read',
      input: { path: 'note.txt' },
    });
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({
      toolUseId: 'tool_read_1',
      isError: false,
      content: 'marker-alpha\n',
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', ok: true });
    session.dispose();
  });

  it('разрешение id 0: карточка, allow отвечает optionId кадра один раз', async () => {
    const s = server();
    waitForReply(s, 0, () => s.request(0, 'session/request_permission', permissionParams()));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('curl');
    await until(() => types(events).includes('permission.request'));
    expect(s.replies()).toEqual([]);
    const req = events.find((e) => e.type === 'permission.request');
    expect(req).toMatchObject({
      toolUseId: 'tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7',
      toolName: 'execute',
      input: { command: 'curl' },
      canAlwaysAllow: true,
      reason: 'Not in allowlist: curl',
    });
    expect(session.respondPermission('tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7', 'allow')).toBe(true);
    await until(() => types(events).includes('turn.result'));
    expect(s.replies()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    ]);
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({
      toolUseId: 'tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7',
      decision: 'allow',
      by: 'user',
    });
    session.dispose();
  });

  it('deny и allow-always берут optionId кадра; без «всегда» уходит один раз', async () => {
    const s = server();
    waitForReply(s, 4, () => s.request(4, 'session/request_permission', permissionParams()));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('curl');
    await until(() => types(events).includes('permission.request'));
    expect(session.respondPermission('tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7', 'deny')).toBe(true);
    await until(() => types(events).includes('turn.result'));
    expect(s.replies()[0]).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });

    const once = server();
    const onlyOnce = STANDARD.filter((o) => o.optionId !== 'allow-always');
    waitForReply(once, 8, () => once.request(8, 'session/request_permission', permissionParams(onlyOnce, 'tool_once')));
    const second = await open(once).adapter.createSession({ cwd: '/work' });
    const ev2 = collect(second);
    await until(() => types(ev2).includes('session.init'));
    second.send('curl');
    await until(() => types(ev2).includes('permission.request'));
    expect(ev2.find((e) => e.type === 'permission.request')).toMatchObject({ canAlwaysAllow: false, toolUseId: 'tool_once' });
    expect(second.respondPermission('tool_once', 'allow-always')).toBe(true);
    await until(() => types(ev2).includes('turn.result'));
    expect(once.replies()[0]).toMatchObject({ id: 8, result: { outcome: { optionId: 'allow-once' } } });

    const always = server();
    waitForReply(always, 9, () => always.request(9, 'session/request_permission', permissionParams(STANDARD, 'tool_always')));
    const third = await open(always).adapter.createSession({ cwd: '/work' });
    const ev3 = collect(third);
    await until(() => types(ev3).includes('session.init'));
    third.send('curl');
    await until(() => types(ev3).includes('permission.request'));
    expect(third.respondPermission('tool_always', 'allow-always')).toBe(true);
    expect(third.respondPermission('tool_always', 'allow-edits')).toBe(false);
    await until(() => types(ev3).includes('turn.result'));
    expect(always.replies()[0]).toMatchObject({ id: 9, result: { outcome: { optionId: 'allow-always' } } });
    second.dispose();
    third.dispose();
    session.dispose();
  });

  it('allow-edits для Cursor равен allow-once и не включает автопринятие', async () => {
    const s = server();
    waitForReply(s, 2, () => s.request(2, 'session/request_permission', permissionParams(STANDARD, 'tool_edits')));
    const session = await open(s).adapter.createSession({ cwd: '/work', permissionMode: 'acceptEdits' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(events[0]).toMatchObject({ permissionMode: 'acceptEdits' });
    expect(s.methods()).not.toContain('session/set_mode');
    session.send('edit');
    await until(() => types(events).includes('permission.request'));
    expect(session.respondPermission('tool_edits', 'allow-edits')).toBe(true);
    await until(() => types(events).includes('turn.result'));
    expect(s.replies()[0]).toMatchObject({ id: 2, result: { outcome: { optionId: 'allow-once' } } });
    session.dispose();
  });

  it('нет toolCallId — отказ формой спайка и warn, карточки нет', async () => {
    const s = server();
    waitForReply(s, 0, () =>
      s.request(0, 'session/request_permission', { sessionId: SESSION, options: STANDARD }),
    );
    const { adapter, logs } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('curl');
    await until(() => types(events).includes('turn.result'));
    expect(events.some((e) => e.type === 'permission.request')).toBe(false);
    expect(s.replies()[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('permission'))).toBe(true);
    session.dispose();
  });

  it('bypass с флагом отвечает один раз без карточки; без флага — как default', async () => {
    const auto = server();
    waitForReply(auto, 0, () => auto.request(0, 'session/request_permission', permissionParams()));
    const skipped = await open(auto).adapter.createSession({
      cwd: '/work',
      permissionMode: 'bypassPermissions',
      allowBypassPermissions: true,
    });
    const ev = collect(skipped);
    await until(() => types(ev).includes('session.init'));
    skipped.send('curl');
    await until(() => types(ev).includes('turn.result'));
    expect(ev.some((e) => e.type === 'permission.request')).toBe(false);
    expect(auto.replies()[0]).toMatchObject({ id: 0, result: { outcome: { optionId: 'allow-once' } } });

    const ask = server();
    waitForReply(ask, 1, () => ask.request(1, 'session/request_permission', permissionParams(STANDARD, 'tool_ask')));
    const plain = await open(ask).adapter.createSession({ cwd: '/work', permissionMode: 'bypassPermissions' });
    const ev2 = collect(plain);
    await until(() => types(ev2).includes('session.init'));
    expect(ev2[0]).toMatchObject({ permissionMode: 'default' });
    plain.send('curl');
    await until(() => types(ev2).includes('permission.request'));
    expect(plain.respondPermission('tool_ask', 'deny')).toBe(true);
    await until(() => types(ev2).includes('turn.result'));
    skipped.dispose();
    plain.dispose();
  });

  it('interrupt при висящем разрешении отвечает отказом и снимает запрос', async () => {
    const s = server();
    s.handle('session/prompt', () => {
      s.request(0, 'session/request_permission', permissionParams());
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          if (s.methods().includes('session/cancel')) {
            clearInterval(timer);
            resolve({ stopReason: 'cancelled' });
          }
        }, 5);
      });
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('curl');
    await until(() => types(events).includes('permission.request'));
    await session.interrupt();
    expect(s.replies()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ]);
    expect(session.respondPermission('tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7', 'allow')).toBe(false);
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({ decision: 'deny', by: 'abort' });
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ interrupted: true });
    expect(s.killed).toBe(false);
    session.dispose();
  });

  it('разрешение и план, пришедшие после Stop, получают отказ без карточки', async () => {
    const s = server();
    let n = 0;
    s.handle('session/prompt', () => {
      n += 1;
      if (n === 1) {
        return new Promise((resolve) => {
          const timer = setInterval(() => {
            if (!s.methods().includes('session/cancel')) return;
            clearInterval(timer);
            s.request(0, 'session/request_permission', permissionParams());
            s.request(6, 'cursor/create_plan', { toolCallId: 'tool_plan_late', plan: '# late' });
            const wait = setInterval(() => {
              const ids = s.replies().map((reply) => reply.id);
              if (ids.includes(0) && ids.includes(6)) {
                clearInterval(wait);
                resolve({ stopReason: 'cancelled' });
              }
            }, 5);
          }, 5);
        });
      }
      s.request(4, 'session/request_permission', permissionParams(STANDARD, 'tool_next'));
      return replyWhen(s, 4);
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('curl');
    await until(() => types(events).includes('turn.start'));
    await session.interrupt();
    expect(events.some((e) => e.type === 'permission.request' || e.type === 'plan.request')).toBe(false);
    expect(s.replies()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      {
        jsonrpc: '2.0',
        id: 6,
        result: { outcome: { outcome: 'rejected', reason: 'rejected' } },
      },
    ]);
    expect(session.respondPermission('tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7', 'allow')).toBe(false);
    expect(session.decidePlan('tool_plan_late', { approve: true })).toBe(false);
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ interrupted: true });
    session.send('next');
    await until(() => events.filter((e) => e.type === 'permission.request').length === 1);
    expect(session.respondPermission('tool_next', 'allow')).toBe(true);
    await until(() => events.filter((e) => e.type === 'turn.result').length === 2);
    expect(s.replies()[2]).toMatchObject({ id: 4, result: { outcome: { optionId: 'allow-once' } } });
    expect(s.killed).toBe(false);
    session.dispose();
  });

  it('план: accept и reject по id кадра; ask_question — skipped без карточки', async () => {
    const s = server();
    let n = 0;
    s.handle('session/prompt', () => {
      n += 1;
      if (n === 1) {
        s.request(0, 'cursor/create_plan', {
          toolCallId: 'tool_plan_1',
          name: 'Rename',
          plan: '# step',
          todos: [],
        });
        return replyWhen(s, 0);
      }
      s.request(7, 'cursor/create_plan', { toolCallId: 'tool_plan_2', plan: '# next' });
      return replyWhen(s, 7);
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    session.send('plan');
    await until(() => types(events).includes('plan.request'));
    expect(events.find((e) => e.type === 'plan.request')).toMatchObject({ toolUseId: 'tool_plan_1', plan: '# step' });
    expect(events.some((e) => e.type === 'question.request')).toBe(false);
    expect(session.decidePlan('tool_plan_1', { approve: true })).toBe(true);
    await until(() => types(events).includes('turn.result'));
    expect(s.replies()[0]).toEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'accepted' } } });

    session.send('plan 2');
    await until(() => events.filter((e) => e.type === 'plan.request').length === 2);
    expect(session.decidePlan('tool_plan_2', { approve: false, feedback: 'spike' })).toBe(true);
    await until(() => events.filter((e) => e.type === 'turn.result').length === 2);
    expect(s.replies()[1]).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'rejected', reason: 'spike' } },
    });

    s.request(3, 'cursor/ask_question', {
      toolCallId: 'tool_q',
      questions: [{ id: 'q1', prompt: 'ping?', options: [{ id: 'a', label: 'pong' }] }],
    });
    await until(() => s.replies().some((r) => r.id === 3));
    expect(s.replies().find((r) => r.id === 3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { outcome: { outcome: 'skipped' } },
    });
    expect(events.some((e) => e.type === 'question.request')).toBe(false);
    expect(session.answerQuestion('tool_q', { 'ping?': 'pong' })).toBe(false);
    session.dispose();
  });

  it('cursor/task в журнал debug и не в ленту', async () => {
    const s = server();
    const { adapter, logs } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    s.notify('cursor/task', { toolCallId: 'tool_t', description: 'explore' });
    s.notify('cursor/update_todos', { toolCallId: 'tool_t', todos: [], merge: false });
    s.notify('cursor/generate_image', { toolCallId: 'tool_t', description: 'icon' });
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.filter((l) => l.startsWith('debug:') && l.includes('cursor/task'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('cursor/update_todos'))).toBe(true);
    expect(logs.some((l) => l.includes('cursor/generate_image'))).toBe(true);
    expect(types(events)).toEqual(['session.init']);
    session.dispose();
  });

  it('setMode: plan и agent; отказ сервера — нефатальная ошибка, сессия жива', async () => {
    const s = server();
    s.handle('session/set_mode', () => ({}));
    const session = await open(s).adapter.createSession({ cwd: '/work', permissionMode: 'plan' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(s.paramsOf('session/set_mode')).toEqual({ sessionId: SESSION, modeId: 'plan' });
    expect(events[0]).toMatchObject({ type: 'session.init', permissionMode: 'plan' });
    await session.setMode('acceptEdits');
    expect(s.paramsOf('session/set_mode', 1)).toEqual({ sessionId: SESSION, modeId: 'agent' });
    expect(events.find((e) => e.type === 'mode.changed')).toMatchObject({ mode: 'acceptEdits' });
    await session.setMode('default');
    expect(s.paramsOf('session/set_mode', 2)).toEqual({ sessionId: SESSION, modeId: 'agent' });

    const bad = server();
    bad.handle('session/set_mode', () => {
      throw new Error('rejected');
    });
    const broken = await open(bad).adapter.createSession({ cwd: '/work' });
    const ev = collect(broken);
    await until(() => types(ev).includes('session.init'));
    await broken.setMode('plan');
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ fatal: false });
    expect(ev.some((e) => e.type === 'mode.changed')).toBe(false);
    expect(ev.some((e) => e.type === 'session.closed')).toBe(false);
    bad.handle('session/prompt', () => ({ stopReason: 'end_turn' }));
    broken.send('still alive');
    await until(() => types(ev).includes('turn.result'));
    session.dispose();
    broken.dispose();
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

interface HistoryRow {
  dir: 'in' | 'out';
  scenario: string;
  msg: {
    method?: string;
    result?: unknown;
    params?: unknown;
  };
}

function historyRows(): HistoryRow[] {
  return readFileSync(new URL('../../../test/fixtures/cursor/history.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line) as HistoryRow);
}

/** Повтор `session/load` из фикстуры: кадры `session/update`, затем result. */
function replayLoad(s: FakeAcp): void {
  s.handle('session/load', () => {
    let result: unknown = {};
    for (const row of historyRows()) {
      if (row.scenario !== 'load' || row.dir !== 'out') continue;
      if (row.msg.method === 'session/update') s.notify('session/update', row.msg.params);
      if (row.msg.result !== undefined) result = row.msg.result;
    }
    return result;
  });
}

const textOf = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.text : '')).join('');

describe('Cursor list, history, account', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentura-cursor-'));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('listSessions: session/list по cwd, чужой cwd не входит, заголовок — id', async () => {
    const s = server();
    s.handle('session/list', (p) => ({
      sessions: [
        { sessionId: 'sess-old', cwd: p.cwd, updatedAt: '2026-11-05T16:45:04.674Z' },
        { sessionId: 'sess-other', cwd: `${String(p.cwd)}-other`, updatedAt: '2026-11-05T19:00:00.000Z' },
        { sessionId: 'sess-new', cwd: p.cwd, updatedAt: '2026-11-05T18:00:00.000Z' },
      ],
    }));
    const { adapter, spawned } = open(s, { timeoutMs: 1000 });
    const list = await adapter.listSessions(dir);
    expect(s.paramsOf('session/list')).toEqual({ cwd: dir });
    expect(s.methods().filter((m) => m !== '<response>')).toEqual([
      'initialize',
      'authenticate',
      'session/list',
    ]);
    expect(spawned[0]?.args).toEqual(['/bin/agent', 'acp']);
    expect(spawned[0]?.options.shell).toBe(false);
    expect(JSON.stringify(spawned)).not.toContain('--force');
    expect(list).toEqual([
      {
        id: 'sess-new',
        title: 'sess-new',
        cwd: dir,
        updatedAt: Date.parse('2026-11-05T18:00:00.000Z'),
        provider: 'cursor',
      },
      {
        id: 'sess-old',
        title: 'sess-old',
        cwd: dir,
        updatedAt: Date.parse('2026-11-05T16:45:04.674Z'),
        provider: 'cursor',
      },
    ]);
    await until(() => s.exited, 'list process exit');
  });

  it('listSessions: кривой ответ — пусто; -32601 — пусто и один warn; падение процесса не затирает чужой список', async () => {
    const bad = server();
    bad.handle('session/list', () => ({ sessions: 'nope' }));
    expect(await open(bad, { timeoutMs: 1000 }).adapter.listSessions(dir)).toEqual([]);

    const logs: string[] = [];
    const missing = new CursorAdapter({
      executablePath: '/bin/agent',
      graceMs: 20,
      timeoutMs: 1000,
      log: (level, message) => logs.push(`${level}: ${message}`),
      spawn: () => server(),
    });
    expect(await missing.listSessions(dir)).toEqual([]);
    expect(await missing.listSessions(dir)).toEqual([]);
    expect(logs.filter((line) => line.startsWith('warn:'))).toHaveLength(1);
    expect(logs[0]).toContain('session/list');

    const dead = server();
    dead.handle('session/list', () => {
      dead.exit(1);
      return new Promise(() => {});
    });
    const claude = [{ id: 'c1' }];
    let sidebar: { id: string }[] = claude;
    try {
      sidebar = await open(dead, { timeoutMs: 1000 }).adapter.listSessions(dir);
    } catch {
      // отказ списка не подменяет соседний список
    }
    expect(sidebar).toBe(claude);

    await expect(new CursorAdapter().listSessions(dir)).rejects.toThrow(CURSOR_NOT_FOUND);
  });

  it('loadHistory: pong из фикстуры — turn.start, текст, turn.result; live оставляет последний ход', async () => {
    const s = server();
    replayLoad(s);
    const { adapter } = open(s, { timeoutMs: 1000 });
    const history = await adapter.loadHistory('sess-pong', dir);
    expect(s.paramsOf('session/load')).toEqual({ sessionId: 'sess-pong', cwd: dir, mcpServers: [] });
    expect(history.turns).toBe(2);
    expect(history.skippedTurns).toBe(0);
    expect(history.model).toBe('gpt-5.4-nano[reasoning=medium]');
    expect(history.mode).toBeUndefined();
    expect(history.events.map((e) => e.type)).toEqual([
      'turn.start',
      'text.delta',
      'text.delta',
      'turn.result',
      'turn.start',
      'tool.start',
      'tool.result',
      'text.delta',
      'turn.result',
    ]);
    expect(history.events[0]).toMatchObject({
      type: 'turn.start',
      prompt: 'Reply with exactly one word: pong.',
    });
    expect(history.events[3]).toMatchObject({ type: 'turn.result', ok: true, subtype: 'end_turn', text: 'pong' });
    expect(textOf(history.events)).toBe('pongok');
    expect(textOf(history.events)).not.toContain('wants');
    expect(JSON.stringify(history.events)).not.toContain('One Word Pong');
    expect(JSON.stringify(history.events)).not.toContain('step');
    const tool = history.events.find((e) => e.type === 'tool.start');
    expect(tool).toMatchObject({
      type: 'tool.start',
      toolUseId: 'tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7',
      name: 'execute',
      input: { command: 'printf ok' },
    });
    expect(history.events.some((e) => e.type === 'tool.start' && e.toolUseId.startsWith('replay-'))).toBe(false);
    const ids = new Set(
      history.events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.messageId : '')),
    );
    expect(ids.size).toBe(2);

    const liveServer = server();
    replayLoad(liveServer);
    const live = await open(liveServer, { timeoutMs: 1000 }).adapter.loadHistory('sess-pong', dir, { live: true });
    expect(live.events.filter((e) => e.type === 'turn.result')).toHaveLength(1);
    expect(live.events.at(-1)).toMatchObject({ type: 'text.delta', text: 'ok' });

    const shortServer = server();
    replayLoad(shortServer);
    const short = await open(shortServer, { timeoutMs: 1000 }).adapter.loadHistory('sess-pong', dir, {
      maxTurns: 1,
    });
    expect(short.turns).toBe(2);
    expect(short.skippedTurns).toBe(1);
    expect(short.events.filter((e) => e.type === 'turn.start')).toHaveLength(1);
    expect(short.events[0]).toMatchObject({ type: 'turn.start', prompt: 'Run the command.' });
  });

  it('loadHistory: нет данных и ошибка load — пустая история; нет бинарника — отказ', async () => {
    const empty = server();
    empty.handle('session/load', () => ({ modes: { currentModeId: 'agent' } }));
    const quiet = await open(empty, { timeoutMs: 1000 }).adapter.loadHistory('sess-pong', dir);
    expect(quiet).toEqual({ events: [], turns: 0, skippedTurns: 0 });

    const missing = server();
    const logs: string[] = [];
    missing.handle('session/load', () => {
      throw new Error('Session not found');
    });
    const { adapter } = open(missing, { timeoutMs: 1000, log: (level, message) => logs.push(`${level}: ${message}`) });
    await expect(adapter.loadHistory('missing', dir)).resolves.toEqual({ events: [], turns: 0, skippedTurns: 0 });
    expect(logs.some((line) => line.startsWith('warn:') && line.includes('session/load'))).toBe(true);

    await expect(new CursorAdapter().loadHistory('sess-pong', dir)).rejects.toThrow(CURSOR_NOT_FOUND);
  });

  it('renameSession дважды не создаёт файл и не запускает процесс', async () => {
    const s = server();
    const { adapter, spawned } = open(s);
    expect(await readdir(dir)).toEqual([]);
    await adapter.renameSession('sess-pong', 'One', dir);
    await adapter.renameSession('sess-pong', 'Two', dir);
    expect(await readdir(dir)).toEqual([]);
    expect(spawned).toEqual([]);
    expect(s.methods()).toEqual([]);
  });

  it('accountInfo: email и тариф из about, без acp; сбой — пустой объект', async () => {
    const about = [
      'About Cursor CLI',
      'CLI Version         2026.11.05-86047df',
      'Model               Auto',
      'Subscription Tier   Premium',
      'OS                  test-os',
      'User Email          person@example.com',
    ].join('\n');
    const calls: string[] = [];
    const { adapter, spawned } = open(server(), {
      run: async (_path, args) => {
        calls.push(args[0] ?? '');
        return about;
      },
    });
    await expect(adapter.accountInfo(dir)).resolves.toEqual({
      email: 'person@example.com',
      subscriptionType: 'Premium',
    });
    expect(calls).toEqual(['about']);
    expect(spawned).toEqual([]);

    const fallback = new CursorAdapter({
      executablePath: '/bin/agent',
      spawn: () => {
        throw new Error('acp spawned');
      },
      run: async (_path, args) => {
        if (args[0] === 'about') throw new Error('about down');
        return 'Logged in as person@example.com\n';
      },
    });
    await expect(fallback.accountInfo(dir)).resolves.toEqual({ email: 'person@example.com' });

    const blank = new CursorAdapter({
      executablePath: '/bin/agent',
      spawn: () => {
        throw new Error('acp spawned');
      },
      run: async () => 'Model               Auto\n',
    });
    await expect(blank.accountInfo(dir)).resolves.toEqual({});
    await expect(new CursorAdapter().accountInfo(dir)).resolves.toEqual({});
  });
});
