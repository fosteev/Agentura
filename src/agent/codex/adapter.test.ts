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
/** `toolUseId` карточки для id запроса: у сессии свой префикс (id запросов у каждого процесса с 0). */
const tid = (session: AgentSession, id: number) => (session as unknown as { approvals: { key(id: number): string } }).approvals.key(id);
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

  it('Claude-специфика — no-op', async () => {
    const s = server();
    const { adapter } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    expect(session.compact()).toBe(false);
    expect(session.respondPermission('x', 'allow')).toBe(false);
    await expect(session.setMode('plan')).resolves.toBeUndefined();
    await expect(session.contextUsage()).resolves.toBeUndefined();
    session.dispose();
  });
});

describe('CodexAdapter: подтверждения и инструменты (этап 4)', () => {
  const COMMAND = {
    kind: 'command',
    threadId: THREAD,
    turnId: 'turn-1',
    itemId: 'exec-1',
    startedAtMs: 1,
    environmentId: 'local',
    command: '/bin/zsh -lc ls',
    cwd: '/work',
    availableDecisions: ['accept', 'cancel'],
  };
  const responses = (s: FakeAppServer) =>
    s.received.filter((m) => m.method === '<response>').map((m) => m.params as { id: number; result?: unknown; error?: { code: number } });

  async function started() {
    const s = server();
    const { adapter, logs } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('go');
    await until(() => types(events).includes('turn.start'));
    return { s, session, events, logs };
  }

  it('allow: permission.request → respondPermission → ответ серверу с тем же id → permission.resolved', async () => {
    const { s, session, events } = await started();
    s.request(77, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    expect(events.find((e) => e.type === 'permission.request')).toMatchObject({ toolUseId: tid(session, 77), toolName: 'Bash', input: { command: 'ls' } });
    expect(session.respondPermission(tid(session, 77), 'allow')).toBe(true);
    await until(() => responses(s).length === 1);
    expect(responses(s)).toMatchObject([{ id: 77, result: { decision: 'accept' } }]);
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({ toolUseId: tid(session, 77), decision: 'allow', by: 'user' });
    // сервер подтверждает своим уведомлением — второго события нет
    s.notify('serverRequest/resolved', { threadId: THREAD, requestId: 77 });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'permission.resolved')).toHaveLength(1);
    session.dispose();
  });

  it('deny: decline; повторный ответ на тот же запрос — false', async () => {
    const { s, session } = await started();
    s.request(5, 'item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'fc-1', startedAtMs: 1 });
    await until(() => (session as unknown as { approvals: { size: number } }).approvals.size === 1);
    expect(session.respondPermission(tid(session, 5), 'deny')).toBe(true);
    expect(session.respondPermission(tid(session, 5), 'deny')).toBe(false);
    await until(() => responses(s).length === 1);
    expect(responses(s)).toMatchObject([{ id: 5, result: { decision: 'decline' } }]);
    session.dispose();
  });

  it('неизвестный server request: ответ ошибкой -32601, лог, видимая ошибка; ход не виснет', async () => {
    const { s, session, events, logs } = await started();
    s.request(9, 'item/something/new', {});
    await until(() => responses(s).length === 1);
    expect(responses(s)).toMatchObject([{ id: 9, error: { code: -32601 } }]);
    expect(logs.some((l) => /item\/something\/new/.test(l))).toBe(true);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: false, code: 'unsupported_request' });
    session.dispose();
  });

  it('вопрос: question.request → answerQuestion → ответ по id вопроса', async () => {
    const { s, session, events } = await started();
    s.request(3, 'item/tool/requestUserInput', {
      threadId: THREAD,
      turnId: 'turn-1',
      itemId: 'q',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{ id: 'a', header: 'H', question: 'Pick?', isOther: true, isSecret: false, options: [{ label: 'X', description: '' }] }],
    });
    await until(() => types(events).includes('question.request'));
    expect(session.answerQuestion(tid(session, 3), { 'Pick?': 'X' })).toBe(true);
    await until(() => responses(s).length === 1);
    expect(responses(s)[0]).toMatchObject({ id: 3, result: { answers: { a: { answers: ['X'] } } } });
    session.dispose();
  });

  it('Stop при открытом запросе: cancel серверу, карточка снимается (abort), ход закрывается', async () => {
    const { s, session, events } = await started();
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    const stopping = session.interrupt();
    await until(() => s.methods().includes('turn/interrupt'));
    expect(responses(s)).toMatchObject([{ id: 1, result: { decision: 'cancel' } }]);
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({ toolUseId: tid(session, 1), decision: 'deny', by: 'abort' });
    finishTurn(s, 'turn-1', 'interrupted');
    await stopping;
    expect(events.filter((e) => e.type === 'turn.result')).toHaveLength(1);
    expect(session.respondPermission(tid(session, 1), 'allow')).toBe(false);
    session.dispose();
  });

  it('Stop: turn/completed не пришёл — abandon тоже снимает открытые запросы', async () => {
    const s = server();
    s.handle('turn/interrupt', () => {
      throw new Error('no active turn');
    });
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('go');
    await until(() => types(events).includes('turn.start'));
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    await session.interrupt();
    expect(events.filter((e) => e.type === 'permission.resolved')).toHaveLength(1);
    expect(types(events)).toContain('turn.result');
    session.dispose();
  });

  it('dispose с открытым запросом: permission.resolved(abort) раньше session.closed', async () => {
    const { s, session, events } = await started();
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    session.dispose();
    const t = types(events);
    expect(t.indexOf('permission.resolved')).toBeGreaterThan(-1);
    expect(t.indexOf('permission.resolved')).toBeLessThan(t.indexOf('session.closed'));
  });

  it('падение процесса с открытым запросом: карточка снимается до session.closed', async () => {
    const { s, events } = await started();
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    s.exit(1);
    await until(() => types(events).includes('session.closed'));
    const t = types(events);
    expect(t.indexOf('permission.resolved')).toBeLessThan(t.indexOf('session.closed'));
  });

  it('turn/completed с открытым запросом: карточка остаётся (сервер может ждать), снимает serverRequest/resolved', async () => {
    const { s, session, events } = await started();
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    finishTurn(s, 'turn-1');
    await until(() => types(events).includes('turn.result'));
    expect(types(events)).not.toContain('permission.resolved');
    expect(responses(s)).toEqual([]);
    s.notify('serverRequest/resolved', { threadId: THREAD, requestId: 1 });
    await until(() => types(events).includes('permission.resolved'));
    expect(session.respondPermission(tid(session, 1), 'allow')).toBe(false);
    expect(responses(s)).toEqual([]);
    session.dispose();
  });

  it('serverRequest/resolved от сервера (таймаут на его стороне) снимает карточку', async () => {
    const { s, session, events } = await started();
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    s.notify('serverRequest/resolved', { threadId: THREAD, requestId: 1 });
    await until(() => types(events).includes('permission.resolved'));
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({ by: 'abort' });
    expect(session.respondPermission(tid(session, 1), 'allow')).toBe(false);
    session.dispose();
  });

  it('инструменты: item/started → approval → item/completed — строка Bash и вывод по порядку', async () => {
    const { s, session, events } = await started();
    const item = (status: string, extra = {}) => ({
      type: 'commandExecution', id: 'exec-1', command: '/bin/zsh -lc ls', cwd: '/work', status, source: 'agent',
      aggregatedOutput: null, exitCode: null, durationMs: null, ...extra,
    });
    s.notify('item/started', { threadId: THREAD, turnId: 'turn-1', startedAtMs: 1, item: item('inProgress') });
    s.request(1, 'item/commandExecution/requestApproval', COMMAND);
    await until(() => types(events).includes('permission.request'));
    session.respondPermission(tid(session, 1), 'allow');
    s.notify('item/commandExecution/outputDelta', { threadId: THREAD, turnId: 'turn-1', itemId: 'exec-1', delta: 'a.txt\n' });
    s.notify('item/completed', { threadId: THREAD, turnId: 'turn-1', completedAtMs: 9, item: item('completed', { exitCode: 0 }) });
    await until(() => types(events).includes('tool.result'));
    const order = types(events).filter((t) => /^(tool|permission)\./.test(t));
    expect(order).toEqual(['tool.start', 'permission.request', 'permission.resolved', 'tool.progress', 'tool.result']);
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ isError: false, content: 'a.txt\n' });
    session.dispose();
  });
});

// Живая запись (codex-cli 0.160.0, untrusted + workspace-write): порядок и формы сообщений как на проводе.
type Recorded = { dir: 'in' | 'out'; msg?: { id?: number; method: string; params: Record<string, unknown> } };
const live = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/codex/approvals.json', import.meta.url), 'utf8'),
) as Record<'commandDeclined' | 'commandAccepted' | 'commandLate' | 'fileAdd' | 'fileUpdate', Recorded[]>;

describe('CodexAdapter: по живой записи подтверждений', () => {
  /** Проигрывает записанные сообщения сервера; на запросе останавливается — дальше ответит тест. */
  function player(s: FakeAppServer, seq: Recorded[]) {
    const queue = seq.filter((r) => r.dir === 'in' && r.msg).map((r) => r.msg!);
    const fix = (params: Record<string, unknown>) => {
      const out = JSON.parse(JSON.stringify(params)) as { threadId?: string; turnId?: string; turn?: { id?: string } };
      if (out.threadId) out.threadId = THREAD;
      if (out.turnId) out.turnId = 'turn-1';
      if (out.turn) out.turn = { ...out.turn, id: 'turn-1' };
      return out;
    };
    return {
      /** Шлёт сообщения до запроса включительно (или до конца); `skipTurnStart` — turn/started уже дал fake. */
      play(): void {
        while (queue.length) {
          const m = queue.shift()!;
          if (m.method === 'turn/started') continue;
          if (m.id !== undefined) {
            s.request(m.id, m.method, fix(m.params));
            return;
          }
          s.notify(m.method, fix(m.params));
        }
      },
      get done(): boolean {
        return queue.length === 0;
      },
    };
  }
  async function open2(name: keyof typeof live) {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('go');
    await until(() => types(events).includes('turn.start'));
    return { s, session, events, play: player(s, live[name]) };
  }
  const sent = (s: FakeAppServer) =>
    s.received.filter((m) => m.method === '<response>').map((m) => m.params as { id: number; result?: unknown });

  it('команда: отказ — decline, строка Bash закрывается ошибкой declined', async () => {
    const { s, session, events, play } = await open2('commandDeclined');
    play.play();
    await until(() => types(events).includes('permission.request'));
    expect(events.find((e) => e.type === 'tool.start')).toMatchObject({ name: 'Bash', input: { command: 'ls' } });
    const req = events.find((e) => e.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(req).toMatchObject({ toolName: 'Bash', input: { command: 'ls' }, canAlwaysAllow: true, always: { destination: 'codexRules' } });
    session.respondPermission(req.toolUseId, 'deny');
    play.play();
    await until(() => types(events).includes('turn.result'));
    expect(sent(s)).toMatchObject([{ result: { decision: 'decline' } }]);
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ isError: true, content: 'declined' });
    expect(events.filter((e) => e.type === 'permission.resolved')).toHaveLength(1);
    session.dispose();
  });

  it('команда: allow-always по записанному списку решений — постоянное правило ls', async () => {
    const { s, session, events, play } = await open2('commandAccepted');
    play.play();
    await until(() => types(events).includes('permission.request'));
    const req = events.find((e) => e.type === 'permission.request') as AgentEventOf<'permission.request'>;
    session.respondPermission(req.toolUseId, 'allow-always');
    play.play();
    await until(() => types(events).includes('tool.result'));
    expect(sent(s)).toMatchObject([{ result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } } } }]);
    // aggregatedOutput у живого сервера null — вывода нет, но это не ошибка
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ isError: false, content: '' });
    session.dispose();
  });

  it('команда: запрос пришёл ПОСЛЕ turn/completed — карточка есть и ответ работает', async () => {
    const { s, session, events, play } = await open2('commandLate');
    play.play();
    await until(() => types(events).includes('permission.request'));
    const t = types(events);
    expect(t.indexOf('turn.result')).toBeLessThan(t.indexOf('permission.request'));
    const req = events.find((e) => e.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(req.input).toEqual({ command: "echo hello-agentura; sleep 2; echo done-agentura" });
    expect(session.respondPermission(req.toolUseId, 'allow')).toBe(true);
    await until(() => sent(s).length === 1);
    expect(sent(s)).toMatchObject([{ result: { decision: 'accept' } }]);
    session.dispose();
  });

  it('создание файла: карточка Write с превью, затем Write с результатом create', async () => {
    const { s, session, events, play } = await open2('fileAdd');
    play.play();
    await until(() => types(events).includes('permission.request'));
    const req = events.find((e) => e.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(req).toMatchObject({ toolName: 'Write', input: { file_path: '/work/a.txt' }, diff: { kind: 'write', content: 'hi\n' } });
    session.respondPermission(req.toolUseId, 'allow');
    play.play();
    await until(() => types(events).includes('turn.result'));
    expect(sent(s)).toMatchObject([{ result: { decision: 'accept' } }]);
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ isError: false, result: { type: 'create', filePath: '/work/a.txt' } });
    session.dispose();
  });

  it('правка файла: карточка Edit с превью из ханков; «принимать правки» — acceptForSession', async () => {
    const { s, session, events, play } = await open2('fileUpdate');
    play.play();
    await until(() => types(events).includes('permission.request'));
    const req = events.find((e) => e.type === 'permission.request') as AgentEventOf<'permission.request'>;
    expect(req).toMatchObject({ toolName: 'Edit', diff: { kind: 'edit', oldText: 'line1\nline2\nline3', newText: 'line1\nline two\nline3' } });
    session.respondPermission(req.toolUseId, 'allow-edits');
    play.play();
    await until(() => types(events).includes('turn.result'));
    expect(sent(s)).toMatchObject([{ result: { decision: 'acceptForSession' } }]);
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({
      result: { structuredPatch: [{ lines: [' line1', '-line2', '+line two', ' line3'] }] },
    });
    session.dispose();
  });
});

describe('CodexAdapter: история (этап 5)', () => {
  const history = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/codex/history.json', import.meta.url), 'utf8'),
  ) as { threadRead: { thread: Record<string, unknown> }; threadList: { data: Record<string, unknown>[] } };
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    ...history.threadList.data[0],
    id,
    ...extra,
  });

  /** Каждый запрос — новый процесс: `spawn` отдаёт свежий сервер, `servers` — их журнал. */
  function queries(setup: (s: FakeAppServer) => void): { adapter: CodexAdapter; servers: FakeAppServer[] } {
    const servers: FakeAppServer[] = [];
    const adapter = new CodexAdapter({
      executablePath: '/bin/codex',
      graceMs: 20,
      spawn: () => {
        const s = new FakeAppServer();
        s.handle('initialize', () => ({}));
        setup(s);
        servers.push(s);
        return s;
      },
    });
    return { adapter, servers };
  }

  it('listSessions: thread/list по cwd, имя или начало первого сообщения, секунды → мс, без субагентов', async () => {
    const { adapter, servers } = queries((s) =>
      s.handle('thread/list', () => ({
        data: [
          row('t1', { name: '  Моё  имя ', preview: 'первое сообщение', updatedAt: 200, createdAt: 100 }),
          row('t2', { name: null, preview: 'Run\n  this   now' }),
          row('t3', { parentThreadId: 't1' }),
          row('t4', { ephemeral: true }),
          row('t5', { name: null, preview: '' }),
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    );
    const list = await adapter.listSessions('/work');
    expect(list.map((i) => i.id)).toEqual(['t1', 't2', 't5']);
    expect(list[0]).toMatchObject({
      title: 'Моё имя',
      firstPrompt: 'первое сообщение',
      cwd: '/work',
      createdAt: 100_000,
      updatedAt: 200_000,
      provider: 'codex',
    });
    expect(list[1]!.title).toBe('Run this now');
    expect(list[2]!.title).toBe('Codex t5');
    expect(servers[0]!.paramsOf('thread/list')).toMatchObject({ cwd: '/work', sortKey: 'updated_at' });
    // короткоживущий сервер: stdin закрыт, процесс вышел
    await until(() => servers[0]!.exited, 'server exit');
  });

  it('listSessions: листает страницы по nextCursor', async () => {
    const { adapter, servers } = queries((s) =>
      s.handle('thread/list', (p) =>
        p.cursor
          ? { data: [row('b')], nextCursor: null, backwardsCursor: null }
          : { data: [row('a')], nextCursor: 'c1', backwardsCursor: null },
      ),
    );
    expect((await adapter.listSessions('/work')).map((i) => i.id)).toEqual(['a', 'b']);
    expect(servers[0]!.paramsOf('thread/list', 1)).toMatchObject({ cursor: 'c1' });
  });

  it('listSessions: ошибка сервера — отказ (процесс всё равно закрыт); нет codex — отказ без запуска', async () => {
    const { adapter, servers } = queries((s) =>
      s.handle('thread/list', () => {
        throw new Error('boom');
      }),
    );
    await expect(adapter.listSessions('/work')).rejects.toThrow(/boom/);
    await until(() => servers[0]!.exited, 'server exit');
    const spawn = vi.fn();
    await expect(new CodexAdapter({ executablePath: () => undefined, spawn }).listSessions('/w')).rejects.toThrow(/Codex CLI/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('loadHistory: thread/read с ходами → события ленты (по живой записи)', async () => {
    const { adapter, servers } = queries((s) => s.handle('thread/read', () => history.threadRead));
    const h = await adapter.loadHistory('019f0000-0000-7000-8000-000000000001', '/work');
    expect(servers[0]!.paramsOf('thread/read')).toEqual({
      threadId: '019f0000-0000-7000-8000-000000000001',
      includeTurns: true,
    });
    expect(h).toMatchObject({ turns: 1, skippedTurns: 0, model: 'gpt-6-luna' });
    expect(types(h.events)).toEqual([
      'turn.start',
      'tool.start',
      'tool.result',
      'tool.start',
      'tool.result',
      'text.delta',
      'turn.result',
    ]);
    const bash = h.events.filter((e) => e.type === 'tool.start');
    expect(bash[0]).toMatchObject({ name: 'Bash', input: { command: 'echo hello' } });
    // `aggregatedOutput: null` у второй команды — вывода нет, но результат есть
    const results = h.events.filter((e) => e.type === 'tool.result');
    expect(results[0]).toMatchObject({ isError: false, content: 'hello\n' });
    expect(results[1]).toMatchObject({ isError: false });
    await until(() => servers[0]!.exited, 'server exit');
  });

  it('loadHistory: тред не найден — отказ (контроллер начнёт новую сессию)', async () => {
    const { adapter } = queries((s) =>
      s.handle('thread/read', () => {
        throw new Error('thread not found');
      }),
    );
    await expect(adapter.loadHistory('nope', '/work')).rejects.toThrow(/not found/);
  });

  it('renameSession: thread/name/set с id треда и именем', async () => {
    const { adapter, servers } = queries((s) => s.handle('thread/name/set', () => ({})));
    await adapter.renameSession('t1', 'Новое имя', '/work');
    expect(servers[0]!.paramsOf('thread/name/set')).toEqual({ threadId: 't1', name: 'Новое имя' });
  });

  describe('resume: «already has an active writer»', () => {
    function resuming(failures: number, message = 'thread 01 already has an active writer'): {
      s: FakeAppServer;
      logs: string[];
      adapter: CodexAdapter;
      calls: () => number;
    } {
      const s = server();
      let calls = 0;
      s.handle('thread/resume', (p) => {
        if (++calls <= failures) throw new Error(message);
        return { ...fixture.threadStart, thread: { ...fixture.threadStart.thread, id: p.threadId } };
      });
      const { adapter, logs } = open(s, { resumeRetryMs: 5 });
      return { s, logs, adapter, calls: () => calls };
    }

    it('повторяет с паузой и поднимает сессию', async () => {
      const { adapter, calls, logs } = resuming(2);
      const session = await adapter.resumeSession(THREAD, { cwd: '/work' });
      const events = collect(session);
      await until(() => types(events).includes('session.init'), 'session.init');
      expect(calls()).toBe(3);
      expect(logs.some((l) => /writer busy/.test(l))).toBe(true);
      expect(types(events)).not.toContain('error');
      session.dispose();
    });

    it('писатель не отпустил за все повторы — ошибка в ленте, сессия закрыта', async () => {
      const { adapter, calls } = resuming(99);
      const session = await adapter.resumeSession(THREAD, { cwd: '/work' });
      const events = collect(session);
      await until(() => types(events).includes('session.closed'), 'session.closed');
      expect(calls()).toBe(4);
      expect(events.find((e) => e.type === 'error')).toMatchObject({ fatal: true, message: expect.stringMatching(/active writer/) });
    });

    it('другая ошибка не повторяется', async () => {
      const { adapter, calls } = resuming(99, 'thread not found');
      const session = await adapter.resumeSession(THREAD, { cwd: '/work' });
      const events = collect(session);
      await until(() => types(events).includes('session.closed'), 'session.closed');
      expect(calls()).toBe(1);
    });
  });
});
