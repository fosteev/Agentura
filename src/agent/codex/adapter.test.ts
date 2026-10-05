import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventOf, AgentSession } from '../types';
import { CodexAdapter, type CodexAdapterConfig } from './adapter';
import { FakeAppServer } from './fakeServer';
import type { ThreadSession } from './protocol';

const fixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/codex/ok-turn.json', import.meta.url), 'utf8'),
) as { threadStart: ThreadSession; modelList: { data: unknown[] } };

const THREAD = fixture.threadStart.thread.id;
const t = (id: string, status = 'inProgress', extra: Record<string, unknown> = {}) => ({
  id,
  items: [],
  status,
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: 500,
  ...extra,
});

/** Сервер, как живой: initialize → thread/start|resume → turn/start (ответ, затем turn/started). */
function server(): FakeAppServer {
  const s = new FakeAppServer();
  let turns = 0;
  s.handle('initialize', () => ({ userAgent: 'fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'macos' }));
  s.handle('thread/start', (p) => ({ ...fixture.threadStart, model: p.model ?? fixture.threadStart.model }));
  s.handle('thread/resume', (p) => ({
    ...fixture.threadStart,
    thread: { ...fixture.threadStart.thread, id: p.threadId },
  }));
  s.handle('turn/start', () => {
    const id = `turn-${++turns}`;
    setTimeout(() => s.notify('turn/started', { threadId: THREAD, turn: t(id) }), 0);
    return { turn: t(id) };
  });
  s.handle('turn/interrupt', () => ({}));
  s.handle('model/list', () => fixture.modelList);
  return s;
}

function open(
  s: FakeAppServer,
  config: Partial<CodexAdapterConfig> = {},
): { adapter: CodexAdapter; logs: string[] } {
  const logs: string[] = [];
  const adapter = new CodexAdapter({
    executablePath: '/bin/codex',
    spawn: () => s,
    graceMs: 20,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...config,
  });
  return { adapter, logs };
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
const finishTurn = (s: FakeAppServer, id: string, status = 'completed', extra: Record<string, unknown> = {}) =>
  s.notify('turn/completed', { threadId: THREAD, turn: t(id, status, extra) });

describe('CodexAdapter: handshake и ход', () => {
  it('порядок: initialize → initialized → thread/start → turn/start; session.init раньше turn.start', async () => {
    const s = server();
    const { adapter } = open(s, { thread: { approvalPolicy: 'on-request', sandbox: 'read-only' } });
    const session = await adapter.createSession({ cwd: '/work', model: 'gpt-6-luna' });
    const events = collect(session);
    expect(session.id).toBe('');
    expect(session.send('привет')).toBe(true);
    await until(() => s.methods().includes('turn/start'));
    // тред пустым не заводим: thread/start ушёл только вместе с первым сообщением
    expect(s.methods()).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(s.paramsOf('initialize')).toMatchObject({ clientInfo: { name: 'agentura', title: 'Agentura' } });
    expect(s.paramsOf('thread/start')).toEqual({
      cwd: '/work',
      model: 'gpt-6-luna',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    });
    expect(s.paramsOf('turn/start')).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'привет', text_elements: [] }],
      model: 'gpt-6-luna',
    });
    await until(() => types(events).includes('turn.start'));
    expect(types(events).slice(0, 2)).toEqual(['session.init', 'turn.start']);
    expect(session.id).toBe(THREAD);
    expect(events[1]).toMatchObject({ prompt: 'привет' });
    session.dispose();
  });

  it('без настроек approval/sandbox не передаёт их: решает ~/.codex/config.toml', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    session.send('x');
    await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('thread/start')).toEqual({ cwd: '/work' });
    const turn = s.paramsOf('turn/start');
    expect(turn.approvalPolicy).toBeUndefined();
    expect(turn.sandboxPolicy).toBeUndefined();
    session.dispose();
  });

  it('дельты → text.delta, completed → turn.result ok и context.usage', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('hi');
    await until(() => types(events).includes('turn.start'));
    s.notify('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'm1', delta: 'O' });
    s.notify('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'm1', delta: 'K' });
    finishTurn(s, 'turn-1');
    await until(() => types(events).includes('turn.result'));
    expect(events.filter((e) => e.type === 'text.delta')).toMatchObject([
      { messageId: 'm1', text: 'O' },
      { messageId: 'm1', text: 'K' },
    ]);
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ ok: true, text: 'OK' });
    session.dispose();
  });

  it('failed и interrupted — не ok', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => s.methods().includes('turn/start'));
    s.notify('error', {
      threadId: THREAD,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'model is not available', codexErrorInfo: null, additionalDetails: null },
    });
    finishTurn(s, 'turn-1', 'failed');
    await until(() => types(events).includes('turn.result'));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: false, message: 'model is not available' });
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ ok: false, subtype: 'error' });
    session.dispose();
  });

  it('turn/start отклонён: turn.start, error, turn.result; сессия жива и принимает следующее', async () => {
    const s = server();
    let reject = true;
    const ok = s.handlers.get('turn/start')!;
    s.handle('turn/start', (p, id) => {
      if (reject) {
        reject = false;
        throw new Error('rate limited');
      }
      return ok(p, id);
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => types(events).includes('turn.result'));
    expect(types(events)).toEqual(['session.init', 'turn.start', 'error', 'turn.result']);
    expect(events[2]).toMatchObject({ fatal: false, message: expect.stringContaining('rate limited') });
    session.send('two');
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    session.dispose();
  });

  it('thread/start отклонён: ход закрывается ошибкой, процесс жив', async () => {
    const s = server();
    s.handle('thread/start', () => {
      throw new Error('no such model');
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => types(events).includes('turn.result'));
    expect(types(events)).toEqual(['turn.start', 'error', 'turn.result']);
    expect(s.methods()).not.toContain('turn/start');
    expect(s.killed).toBe(false);
    session.dispose();
  });

  it('картинки уходят image-блоками перед текстом; файлы не отправляются', async () => {
    const s = server();
    const { adapter, logs } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    session.send('what is this', [{ mediaType: 'image/png', data: 'QUJD' }], [
      { kind: 'text', path: 'a.txt', data: 'x', size: 1 },
    ]);
    await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('turn/start').input).toEqual([
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'text', text: 'what is this', text_elements: [] },
    ]);
    expect(logs.some((l) => /file attachment/.test(l))).toBe(true);
    session.dispose();
  });

  it('очередь: следующий turn/start только после turn/completed, сообщения не склеиваются', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('first');
    session.send('second');
    await until(() => types(events).includes('turn.start'));
    await new Promise((r) => setTimeout(r, 30));
    expect(s.methods().filter((m) => m === 'turn/start')).toHaveLength(1);
    finishTurn(s, 'turn-1');
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    await until(() => types(events).filter((x) => x === 'turn.start').length === 2);
    expect(s.paramsOf('turn/start', 1).input).toEqual([{ type: 'text', text: 'second', text_elements: [] }]);
    expect(events.filter((e) => e.type === 'turn.start')).toMatchObject([{ prompt: 'first' }, { prompt: 'second' }]);
    // один тред на оба хода
    expect(s.methods().filter((m) => m === 'thread/start')).toHaveLength(1);
    session.dispose();
  });

  it('setModel/setEffort действуют со следующего turn/start', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work', model: 'a' });
    session.send('one');
    await until(() => s.methods().includes('turn/start'));
    await session.setModel('gpt-6-luna');
    await session.setEffort('low');
    finishTurn(s, 'turn-1');
    session.send('two');
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    expect(s.paramsOf('turn/start', 0).model).toBe('a');
    expect(s.paramsOf('turn/start', 1)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    session.dispose();
  });
});

describe('CodexAdapter: interrupt', () => {
  it('turn/interrupt с threadId и turnId, ждёт turn/completed interrupted, процесс не убивает', async () => {
    const s = server();
    s.handle('turn/interrupt', () => {
      setTimeout(() => finishTurn(s, 'turn-1', 'interrupted'), 5);
      return {};
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('long job');
    await until(() => types(events).includes('turn.start'));
    await session.interrupt();
    expect(s.paramsOf('turn/interrupt')).toEqual({ threadId: THREAD, turnId: 'turn-1' });
    const result = events.find((e) => e.type === 'turn.result') as AgentEventOf<'turn.result'>;
    expect(result).toMatchObject({ ok: false, interrupted: true });
    expect(s.killed).toBe(false);
    expect(s.exited).toBe(false);
    // сессия после Stop работает
    session.send('again');
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    session.dispose();
  });

  it('Stop не сбрасывает очередь: следующее сообщение стартует новый ход после interrupted', async () => {
    const s = server();
    s.handle('turn/interrupt', () => {
      setTimeout(() => finishTurn(s, 'turn-1', 'interrupted'), 5);
      return {};
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    session.send('queued');
    await until(() => types(events).includes('turn.start'));
    await session.interrupt();
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ interrupted: true, ok: false });
    session.dispose();
  });

  it('Stop до старта хода: turn/start не уходит, лента получает turn.result interrupted', async () => {
    const s = server();
    let release!: () => void;
    s.handle('thread/start', () => new Promise((resolve) => (release = () => resolve(fixture.threadStart))));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => s.methods().includes('thread/start'));
    await session.interrupt();
    release();
    await until(() => types(events).includes('turn.result'));
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ interrupted: true, ok: false });
    expect(s.methods()).not.toContain('turn/start');
    session.dispose();
  });

  it('без активного хода interrupt ничего не шлёт', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    await session.interrupt();
    expect(s.methods()).not.toContain('turn/interrupt');
    session.dispose();
  });
});

describe('CodexAdapter: resume, процесс, возможности', () => {
  it('resume: thread/resume вместо thread/start, session.init сразу, id известен', async () => {
    const s = server();
    const session = await open(s).adapter.resumeSession('old-thread', { cwd: '/work', model: 'gpt-6-luna' });
    const events = collect(session);
    expect(session.id).toBe('old-thread');
    await until(() => types(events).includes('session.init'));
    expect(s.methods()).toEqual(['initialize', 'initialized', 'thread/resume']);
    expect(s.paramsOf('thread/resume')).toMatchObject({ threadId: 'old-thread', cwd: '/work', model: 'gpt-6-luna', excludeTurns: true });
    expect(events[0]).toMatchObject({ type: 'session.init', sessionId: 'old-thread' });
    session.send('continue');
    await until(() => s.methods().includes('turn/start'));
    expect(s.methods()).not.toContain('thread/start');
    expect(s.paramsOf('turn/start').threadId).toBe('old-thread');
    session.dispose();
  });

  it('resume неизвестного треда: fatal error и session.closed', async () => {
    const s = server();
    s.handle('thread/resume', () => {
      throw new Error('thread not found');
    });
    const session = await open(s).adapter.resumeSession('nope', { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.closed'));
    expect(events[0]).toMatchObject({ type: 'error', fatal: true, message: expect.stringContaining('thread not found') });
    expect(events[1]).toMatchObject({ type: 'session.closed', reason: 'error' });
    expect(session.send('x')).toBe(false);
  });

  it('падение процесса посреди хода: error fatal + session.closed exit, send → false', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => types(events).includes('turn.start'));
    s.exit(1);
    await until(() => types(events).includes('session.closed'), 'session.closed');
    expect(events.at(-2)).toMatchObject({ type: 'error', fatal: true });
    expect(events.at(-1)).toMatchObject({ type: 'session.closed', reason: 'exit' });
    expect(session.send('two')).toBe(false);
    await expect(session.interrupt()).resolves.toBeUndefined();
  });

  it('initialize не ответил ошибкой: fatal и закрытие', async () => {
    const s = server();
    s.handle('initialize', () => {
      throw new Error('bad handshake');
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => types(events).includes('session.closed'));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: true });
    expect(s.methods()).not.toContain('thread/start');
  });

  it('dispose: stdin закрывается, процесс уходит сам; завис — kill после grace', async () => {
    const polite = server();
    const a = await open(polite).adapter.createSession({ cwd: '/work' });
    const eventsA = collect(a);
    a.dispose();
    await until(() => polite.exited);
    expect(polite.killed).toBe(false);
    expect(eventsA.at(-1)).toMatchObject({ type: 'session.closed', reason: 'disposed' });

    const stubborn = server();
    stubborn.ignoreStdinEnd = true;
    const b = await open(stubborn).adapter.createSession({ cwd: '/work' });
    await until(() => stubborn.methods().includes('initialized'));
    b.dispose();
    await until(() => stubborn.killed, 'kill');

    // SIGTERM игнорирует — через ещё один grace SIGKILL
    const deaf = server();
    deaf.ignoreStdinEnd = true;
    deaf.ignoreTerm = true;
    const c = await open(deaf).adapter.createSession({ cwd: '/work' });
    await until(() => deaf.methods().includes('initialized'));
    c.dispose();
    await until(() => deaf.exited, 'SIGKILL');
    expect(deaf.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('Stop, а turn/completed не приходит (сервер: хода нет) — ход закрывается interrupted, очередь жива', async () => {
    const s = server();
    s.handle('turn/interrupt', () => Promise.reject(new Error('no active turn')));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    await until(() => types(events).includes('turn.start'));
    await session.interrupt();
    expect(events.filter((e) => e.type === 'turn.result')).toMatchObject([{ ok: false, interrupted: true }]);
    // поздний turn/completed того же хода второго turn.result не даёт
    finishTurn(s, 'turn-1', 'interrupted');
    session.send('two');
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'turn.result')).toHaveLength(1);
    session.dispose();
  });

  it('таймаут turn/start фатален: сервер мог начать ход, второй turn/start поверх него не уходит', async () => {
    const s = server();
    s.handle('turn/start', () => new Promise(() => {}));
    const session = await open(s, { startTimeoutMs: 30 }).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    session.send('two');
    await until(() => types(events).includes('session.closed'));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: true });
    expect(s.methods().filter((m) => m === 'turn/start')).toHaveLength(1);
  });

  it('turn/started и turn/completed чужого треда не трогают наш ход', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('one');
    session.send('two');
    await until(() => types(events).includes('turn.start'));
    s.notify('turn/started', { threadId: 'other-thread', turn: t('foreign') });
    s.notify('turn/completed', { threadId: 'other-thread', turn: t('turn-1') });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.methods().filter((m) => m === 'turn/start')).toHaveLength(1);
    s.handle('turn/interrupt', () => {
      setTimeout(() => finishTurn(s, 'turn-1', 'interrupted'), 5);
      return {};
    });
    await session.interrupt();
    expect(s.paramsOf('turn/interrupt')).toEqual({ threadId: THREAD, turnId: 'turn-1' });
    session.dispose();
  });

  it('model/list упал — следующий capabilities() спрашивает снова', async () => {
    const s = server();
    let calls = 0;
    s.handle('model/list', () => (++calls === 1 ? Promise.reject(new Error('boom')) : fixture.modelList));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    expect((await session.capabilities()).models).toEqual([]);
    expect((await session.capabilities()).models.length).toBeGreaterThan(0);
    session.dispose();
  });

  it('approval до этапа 4 — явный отказ по схеме (decline), неизвестный запрос — -32601; лог говорит об этом', async () => {
    const s = server();
    const { adapter, logs } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    session.send('one');
    await until(() => s.methods().includes('turn/start'));
    s.request(77, 'item/commandExecution/requestApproval', { command: 'rm -rf x' });
    s.request(78, 'item/fileChange/requestApproval', {});
    s.request(79, 'item/tool/requestUserInput', {});
    await until(() => s.received.filter((m) => m.method === '<response>').length === 3);
    const responses = s.received.filter((m) => m.method === '<response>').map((m) => m.params);
    expect(responses).toMatchObject([
      { id: 77, result: { decision: 'decline' } },
      { id: 78, result: { decision: 'decline' } },
      { id: 79, error: { code: -32601 } },
    ]);
    expect(logs.some((l) => /requestApproval/.test(l))).toBe(true);
    session.dispose();
  });

  it('turn/completed чужого хода не закрывает текущий и не пускает очередь', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('first');
    session.send('second');
    await until(() => types(events).includes('turn.start'));
    finishTurn(s, 'turn-other');
    await new Promise((r) => setTimeout(r, 30));
    expect(types(events)).not.toContain('turn.result');
    expect(s.methods().filter((m) => m === 'turn/start')).toHaveLength(1);
    finishTurn(s, 'turn-1');
    await until(() => s.methods().filter((m) => m === 'turn/start').length === 2);
    expect(events.filter((e) => e.type === 'turn.result')).toHaveLength(1);
    session.dispose();
  });

  it('capabilities: модели из model/list без hidden; уровни effort только из EffortLevel', async () => {
    const s = server();
    s.handle('model/list', () => ({
      data: [
        { id: 'a', model: 'a', displayName: 'A', description: 'main', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'ultra', description: '' }] },
        { id: 'h', model: 'h', displayName: 'H', description: '', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
      ],
      nextCursor: null,
    }));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const caps = await session.capabilities();
    expect(caps).toEqual({
      models: [{ value: 'a', displayName: 'A', description: 'main', supportsEffort: true, effortLevels: ['low'] }],
      commands: [],
    });
    expect(s.methods().filter((m) => m === 'model/list')).toHaveLength(1);
    await session.capabilities();
    expect(s.methods().filter((m) => m === 'model/list')).toHaveLength(1);
    session.dispose();
  });

  it('model/list упал: пустые списки, сессия жива', async () => {
    const s = server();
    s.handle('model/list', () => {
      throw new Error('offline');
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    await expect(session.capabilities()).resolves.toEqual({ models: [], commands: [] });
    expect(s.killed).toBe(false);
    session.dispose();
  });

  it('нет codex: createSession бросает понятную ошибку; spawn не вызван', async () => {
    const spawn = vi.fn();
    const adapter = new CodexAdapter({ executablePath: () => undefined, spawn });
    await expect(adapter.createSession({ cwd: '/w' })).rejects.toThrow(/Codex CLI/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('Claude-специфика — no-op; история и список пока пусты', async () => {
    const s = server();
    const { adapter } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    expect(session.compact()).toBe(false);
    expect(session.respondPermission('x', 'allow')).toBe(false);
    await expect(session.setMode('plan')).resolves.toBeUndefined();
    await expect(session.contextUsage()).resolves.toBeUndefined();
    await expect(adapter.listSessions()).resolves.toEqual([]);
    await expect(adapter.loadHistory()).resolves.toMatchObject({ events: [], turns: 0 });
    session.dispose();
  });
});
