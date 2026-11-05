import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('каталог настроек получает модели и их effort без создания треда, загрузки скиллов или MCP', async () => {
    const s = server();
    const { adapter } = open(s);
    const models = await adapter.listModels('/work');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => (m.effortLevels?.length ?? 0) > 0)).toBe(true);
    expect(s.methods()).toContain('model/list');
    expect(s.methods()).not.toContain('thread/start');
    expect(s.methods()).not.toContain('skills/list');
    expect(s.methods()).not.toContain('mcpServerStatus/list');
  });
  it.each(['high', 'low'] as const)('effort нового чата %s применяется до первого запроса; несовместимый берётся из Codex', async (effort) => {
    const s = server();
    s.handle('thread/start', () => ({ ...fixture.threadStart, model: 'test', reasoningEffort: 'medium' }));
    s.handle('model/list', () => ({ data: [{ model: 'test', displayName: 'Test', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'medium' }] }], nextCursor: null }));
    const session = await open(s).adapter.createSession({ cwd: '/work', codexDefaults: { model: 'test', effort } });
    session.send('test');
    await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('turn/start')).toMatchObject({ model: 'test', effort: effort === 'high' ? 'high' : 'medium' });
    session.dispose();
  });
  it('дефолты нового чата применяются до первого turn/start с точной sandbox-политикой', async () => {
    const s = server();
    s.handle('thread/start', (p) => ({ ...fixture.threadStart, model: p.model, approvalPolicy: p.approvalPolicy }));
    s.handle('thread/settings/update', () => ({}));
    const { adapter } = open(s);
    const session = await adapter.createSession({ cwd: '/work', codexDefaults: {
      model: 'gpt-test', approval: 'never', sandbox: 'workspaceWrite',
    } });
    const events = collect(session);
    session.send('test');
    await until(() => types(events).includes('turn.start'));
    expect(s.paramsOf('thread/start')).toMatchObject({ model: 'gpt-test', approvalPolicy: 'never' });
    const sandboxPolicy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true };
    expect(s.paramsOf('thread/settings/update')).toEqual({ threadId: THREAD, sandboxPolicy });
    expect(s.methods().indexOf('thread/settings/update')).toBeLessThan(s.methods().indexOf('turn/start'));
    expect(s.paramsOf('turn/start')).toMatchObject({ model: 'gpt-test' });
    // turn/start наследует уже подтверждённые настройки треда.
    expect(s.paramsOf('turn/start')).not.toHaveProperty('sandboxPolicy');
    expect(events.find((e) => e.type === 'session.init')).toMatchObject({
      sessionPolicy: { approval: 'never', sandbox: 'workspaceWrite', sandboxPolicy },
    });
    session.dispose();
  });

  it('полный доступ в дефолтах без allowBypass ограничивается рабочей папкой', async () => {
    const s = server();
    s.handle('thread/settings/update', () => ({}));
    const session = await open(s).adapter.createSession({ cwd: '/work', codexDefaults: { sandbox: 'dangerFullAccess' } });
    session.send('test');
    await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('thread/settings/update')).toMatchObject({ sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } });
    session.dispose();
  });

  it('resume игнорирует дефолты нового Codex-чата', async () => {
    const s = server();
    const session = await open(s).adapter.resumeSession(THREAD, { cwd: '/work', codexDefaults: {
      model: 'gpt-new', effort: 'max', approval: 'never', sandbox: 'dangerFullAccess',
    } });
    await until(() => s.methods().includes('thread/resume'));
    session.send('continue');
    await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('thread/resume')).not.toHaveProperty('model');
    expect(s.paramsOf('thread/resume')).not.toHaveProperty('approvalPolicy');
    expect(s.methods()).not.toContain('thread/settings/update');
    session.dispose();
  });

  it('retries child metadata while the first turn is not yet persisted', async () => {
    const s = server();
    let reads = 0;
    s.handle('thread/read', () => ({ thread: {
      id: 'child', parentThreadId: THREAD, model: 'gpt-6.1-sol', reasoningEffort: 'high',
      turns: ++reads === 1 ? [] : [t('child-turn', 'inProgress', { items: [
        { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Live child task' }] },
      ] })],
    } }));
    const { adapter } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('test');
    await until(() => types(events).includes('turn.start'));
    s.notify('item/completed', { threadId: THREAD, item: {
      type: 'subAgentActivity', id: 'start', kind: 'started', agentThreadId: 'child', agentPath: '/root/child',
    } });
    await until(() => events.some((e) => e.type === 'agent.start' && e.prompt === 'Live child task'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.start',
      prompt: 'Live child task', model: 'gpt-6.1-sol', reasoningEffort: 'high' }));
    expect(events.some((e) => e.type === 'agent.end')).toBe(false);
    expect(reads).toBe(2);
    session.dispose();
  });

  it('activity обогащается дочерним thread/read; ответ ребёнка не попадает в текст основного', async () => {
    const s = server();
    s.handle('thread/read', () => ({ thread: {
      id: 'child', parentThreadId: THREAD, model: 'gpt-6.1-sol',
      turns: [t('child-turn', 'completed', { items: [
        { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Child task' }] },
        { type: 'agentMessage', id: 'm', text: 'CHILD_OK', phase: 'final_answer' },
      ] })],
    } }));
    const { adapter } = open(s);
    const session = await adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    session.send('test');
    await until(() => types(events).includes('turn.start'));
    for (const kind of ['started', 'completed']) s.notify('item/completed', {
      threadId: THREAD, completedAtMs: kind === 'started' ? 1000 : 2000,
      item: { type: 'subAgentActivity', id: kind, kind, agentThreadId: 'child', agentPath: '/root/child', model: null },
    });
    await until(() => events.some((e) => e.type === 'agent.end' && e.summary === 'CHILD_OK'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.start', prompt: 'Child task', subagentType: 'Codex' }));
    expect(events.some((e) => e.type === 'text.delta')).toBe(false);
    expect(s.received.filter((m) => m.method === 'thread/read')).toHaveLength(2);
    session.dispose();
  });

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

  it('браузер (roadmap 27): `browser: true` — в аргументах спавна обе пары -c mcp_servers.browser.*; без — как раньше', async () => {
    const spawned: string[][] = [];
    const spawn = (_exe: string, args: string[]) => (spawned.push(args), server());
    const adapter = new CodexAdapter({ executablePath: '/bin/codex', spawn: spawn as never, graceMs: 20 });
    (await adapter.createSession({ cwd: '/work' })).dispose();
    expect(spawned[0]).toEqual(['app-server', '--listen', 'stdio://']);
    (await adapter.createSession({ cwd: '/work', browser: false })).dispose();
    expect(spawned[1]).toEqual(['app-server', '--listen', 'stdio://']);
    (await adapter.createSession({ cwd: '/work', browser: true })).dispose();
    expect(spawned[2]).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'mcp_servers.browser.command="npx"',
      '-c',
      'mcp_servers.browser.args=["-y","@playwright/mcp@latest","--extension"]',
    ]);
    (await adapter.resumeSession('thr', { cwd: '/work', browser: true })).dispose();
    expect(spawned[3]).toContain('mcp_servers.browser.command="npx"');
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

describe('CodexAdapter: статус MCP (roadmap 21)', () => {
  it('не сообщает об успешном отключении, если Codex проигнорировал проектный конфиг', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentura-mcp-toggle-'));
    const s = server();
    s.handle('mcpServerStatus/list', () => ({ data: [srv('probe', 'connected')], nextCursor: null }));
    s.handle('config/mcpServer/reload', () => ({}));
    const session = await open(s).adapter.resumeSession(THREAD, { cwd });
    const events = collect(session);
    try {
      await until(() => types(events).includes('session.init'));
      await session.mcpToggle!('probe', false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: false,
        message: expect.stringContaining('project trust') }));
      expect(mcpOf(events).at(-1)?.servers).toMatchObject([{ name: 'probe', status: 'connected' }]);
    } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
  it('переключает MCP через конфиг текущей папки и reload; общий config API не вызывается', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentura-mcp-toggle-'));
    const s = server();
    let enabled = true;
    s.handle('mcpServerStatus/list', () => ({ data: [srv('probe', enabled ? 'connected' : 'disabled')], nextCursor: null }));
    s.handle('config/mcpServer/reload', async () => {
      enabled = !(await readFile(join(cwd, '.codex/config.toml'), 'utf8')).includes('= false');
      return {};
    });
    const session = await open(s).adapter.resumeSession(THREAD, { cwd });
    const events = collect(session);
    try {
      await until(() => types(events).includes('session.init'));
      await session.mcpToggle!('probe', false);
      expect(mcpOf(events).at(-1)?.servers).toMatchObject([{ name: 'probe', status: 'disabled' }]);
      await session.mcpToggle!('probe', true);
      expect(mcpOf(events).at(-1)?.servers).toMatchObject([{ name: 'probe', status: 'connected' }]);
      expect(s.methods()).not.toContain('config/value/write');
      expect(s.methods()).not.toContain('config/batchWrite');
      expect(s.received.filter((m) => m.method === 'config/mcpServer/reload')).toHaveLength(2);
      expect(events.some((e) => e.type === 'error')).toBe(false);
    } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([null, 'plugin'])('не создаёт конфиг для отсутствующего или плагинного сервера: %s', async (plugin) => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentura-mcp-toggle-'));
    const s = server();
    s.handle('mcpServerStatus/list', () => ({ data: plugin ? [{ ...srv('probe', 'connected'), pluginId: plugin }] : [], nextCursor: null }));
    const session = await open(s).adapter.resumeSession(THREAD, { cwd });
    const events = collect(session);
    try {
      await until(() => types(events).includes('session.init'));
      await session.mcpToggle!('probe', false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: false }));
      await expect(readFile(join(cwd, '.codex/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(s.methods()).not.toContain('config/mcpServer/reload');
    } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  const srv = (name: string, runtimeStatus: string | null) => ({
    name,
    runtimeStatus,
    serverInfo: null,
    tools: {},
    toolsError: null,
    pluginId: null,
  });
  const mcpOf = (events: AgentEvent[]) =>
    events.filter((e): e is AgentEventOf<'mcp.status'> => e.type === 'mcp.status');
  /** Сессия с открытым тредом (`thread/resume` ответил): только тогда `mcpStatus`/`mcpReloadAll` что-то делают. */
  async function opened(s: ReturnType<typeof server>) {
    const o = open(s);
    const session = await o.adapter.resumeSession(THREAD, { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'), 'тред открыт');
    return { session, events, logs: o.logs };
  }

  it('mcpStatus листает страницы по cursor (две), detail toolsAndAuthOnly, threadId треда; одно событие с полным списком', async () => {
    const s = server();
    s.handle('mcpServerStatus/list', (p) =>
      p.cursor === 'p2'
        ? { data: [srv('c', 'failed')], nextCursor: null }
        : { data: [srv('a', 'connected'), srv('b', 'starting')], nextCursor: 'p2' },
    );
    const session = await open(s).adapter.resumeSession(THREAD, { cwd: '/work' });
    const events = collect(session);
    await until(() => s.methods().includes('thread/resume'));
    await session.mcpStatus!();
    expect(s.methods().filter((m) => m === 'mcpServerStatus/list')).toHaveLength(2);
    expect(s.paramsOf('mcpServerStatus/list', 0)).toEqual({ detail: 'toolsAndAuthOnly', threadId: THREAD });
    expect(s.paramsOf('mcpServerStatus/list', 1)).toEqual({ detail: 'toolsAndAuthOnly', threadId: THREAD, cursor: 'p2' });
    expect(mcpOf(events)).toHaveLength(1);
    expect(mcpOf(events)[0]!.servers.map((x) => [x.name, x.status])).toEqual([
      ['a', 'connected'],
      ['b', 'pending'],
      ['c', 'failed'],
    ]);
    session.dispose();
  });

  it('вечный nextCursor — не больше 10 страниц', async () => {
    const s = server();
    let n = 0;
    s.handle('mcpServerStatus/list', () => ({ data: [srv(`s${++n}`, 'connected')], nextCursor: `c${n}` }));
    const { session, events } = await opened(s);
    await session.mcpStatus!();
    expect(s.methods().filter((m) => m === 'mcpServerStatus/list')).toHaveLength(10);
    expect(mcpOf(events)[0]!.servers).toHaveLength(10);
    session.dispose();
  });

  it('тот же nextCursor повторился — листание останавливается, страница не дублируется', async () => {
    const s = server();
    let n = 0;
    s.handle('mcpServerStatus/list', () => ({ data: [srv(`s${++n}`, 'connected')], nextCursor: 'same' }));
    const { session, events } = await opened(s);
    await session.mcpStatus!();
    expect(s.methods().filter((m) => m === 'mcpServerStatus/list')).toHaveLength(2);
    expect(mcpOf(events)[0]!.servers.map((x) => x.name)).toEqual(['s1', 's2']);
    session.dispose();
  });

  it('mcpWatch: список после открытия треда; без mcpWatch — не спрашивает; startupStatus/updated — точечно', async () => {
    const s = server();
    s.handle('mcpServerStatus/list', () => ({ data: [srv('a', 'starting'), srv('b', 'connected')], nextCursor: null }));
    const quiet = await open(s).adapter.createSession({ cwd: '/work' });
    quiet.send('hi');
    await until(() => s.methods().includes('turn/start'));
    expect(s.methods()).not.toContain('mcpServerStatus/list');
    quiet.dispose();

    const s2 = server();
    s2.handle('mcpServerStatus/list', () => ({ data: [srv('a', 'starting'), srv('b', 'connected')], nextCursor: null }));
    const session = await open(s2).adapter.createSession({ cwd: '/work', mcpWatch: true });
    const events = collect(session);
    session.send('hi');
    await until(() => mcpOf(events).length === 1, 'mcp.status после thread/start');
    s2.notify('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'a', status: 'ready', error: null, failureReason: null });
    s2.notify('mcpServer/startupStatus/updated', { threadId: 'other', name: 'b', status: 'failed', error: 'x', failureReason: null });
    await until(() => mcpOf(events).length === 2, 'обновление сервера a');
    await new Promise((r) => setTimeout(r, 20));
    expect(mcpOf(events)).toHaveLength(2);
    expect(mcpOf(events)[1]!.servers.map((x) => [x.name, x.status])).toEqual([
      ['a', 'connected'],
      ['b', 'connected'],
    ]);
    session.dispose();
  });

  it('mcpReloadAll → config/mcpServer/reload, затем список; ошибки — в лог, без исключения', async () => {
    const s = server();
    let fail = false;
    s.handle('config/mcpServer/reload', () => (fail ? Promise.reject(new Error('nope')) : {}));
    s.handle('mcpServerStatus/list', () => (fail ? Promise.reject(new Error('down')) : { data: [], nextCursor: null }));
    const { session, events, logs } = await opened(s);
    await session.mcpReloadAll!();
    expect(s.methods().filter((m) => m === 'config/mcpServer/reload' || m === 'mcpServerStatus/list')).toEqual([
      'config/mcpServer/reload',
      'mcpServerStatus/list',
    ]);
    expect(mcpOf(events)).toEqual([{ type: 'mcp.status', servers: [], at: expect.any(Number) }]);
    fail = true;
    await expect(session.mcpReloadAll!()).resolves.toBeUndefined();
    expect(logs.filter((l) => /config\/mcpServer\/reload failed|mcpServerStatus\/list failed/.test(l))).toHaveLength(2);
    expect(types(events)).not.toContain('error');
    session.dispose();
  });

  it('до открытия треда mcpStatus/mcpReloadAll ничего не шлют (без threadId Codex поднял бы все серверы)', async () => {
    const s = server();
    s.handle('mcpServerStatus/list', () => ({ data: [], nextCursor: null }));
    const session = await open(s).adapter.createSession({ cwd: '/work', mcpWatch: true });
    await session.mcpStatus!();
    await session.mcpReloadAll!();
    expect(s.methods().filter((m) => m === 'mcpServerStatus/list' || m === 'config/mcpServer/reload')).toEqual([]);
    session.dispose();
  });

  it('dispose, пока список в пути, — ни события, ни предупреждения', async () => {
    const s = server();
    let fail: (e: Error) => void = () => {};
    s.handle('mcpServerStatus/list', () => new Promise((_, reject) => (fail = reject)));
    const { session, events, logs } = await opened(s);
    const pending = session.mcpStatus!();
    await until(() => s.methods().includes('mcpServerStatus/list'));
    session.dispose();
    fail(new Error('closed'));
    await pending;
    expect(mcpOf(events)).toEqual([]);
    expect(logs.filter((l) => /mcpServerStatus\/list failed/.test(l))).toEqual([]);
  });

  it('уведомление «ready», пришедшее, пока список в пути, ответ списка (снятый раньше) не откатывает', async () => {
    const s = server();
    let answer: (v: unknown) => void = () => {};
    s.handle('mcpServerStatus/list', () => new Promise((resolve) => (answer = resolve)));
    const { session, events } = await opened(s);
    const pending = session.mcpStatus!();
    await until(() => s.methods().includes('mcpServerStatus/list'));
    s.notify('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'a', status: 'ready', error: null, failureReason: null });
    await until(() => mcpOf(events).length === 1, 'уведомление');
    answer({ data: [srv('a', 'starting'), srv('b', 'connected')], nextCursor: null });
    await pending;
    expect(mcpOf(events).at(-1)!.servers.map((x) => [x.name, x.status])).toEqual([
      ['a', 'connected'],
      ['b', 'connected'],
    ]);
    session.dispose();
  });
});


describe('Codex manual compaction', () => {
  it('serializes compaction and queued messages; duplicate requests are rejected', async () => {
    const s = server();
    s.handle('thread/compact/start', () => ({}));
    const { adapter } = open(s);
    const session = await adapter.resumeSession(THREAD, { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(session.compact()).toBe(true);
    expect(session.compact()).toBe(false);
    await until(() => s.methods().includes('thread/compact/start'));
    session.send('after compact');
    await new Promise((r) => setTimeout(r, 10));
    expect(s.methods()).not.toContain('turn/start');
    s.notify('turn/started', { threadId: THREAD, turn: t('compact-1') });
    finishTurn(s, 'compact-1');
    await until(() => s.methods().includes('turn/start'));
    expect(events.filter((e) => e.type === 'compaction.start')).toHaveLength(1);
    expect(events.find((e) => e.type === 'compaction.end')).toMatchObject({ ok: true });
    expect(session.compact()).toBe(false);
    session.dispose();
  });

  it('RPC failure clears the indicator, allows retry, and close clears pending compact', async () => {
    const s = server();
    s.handle('thread/compact/start', () => { throw new Error('rejected'); });
    const { adapter } = open(s);
    const session = await adapter.resumeSession(THREAD, { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(session.compact()).toBe(true);
    await until(() => types(events).includes('compaction.end'));
    expect(events.find((e) => e.type === 'compaction.end')).toMatchObject({ ok: false });
    s.handle('thread/compact/start', () => ({}));
    expect(session.compact()).toBe(true);
    session.dispose();
    expect(events.filter((e) => e.type === 'compaction.end')).toHaveLength(2);
  });
});


it('compact Stop targets its turn and timeout closes an uncertain session', async () => {
  const s = server();
  s.handle('thread/compact/start', () => ({}));
  const { adapter } = open(s, { startTimeoutMs: 100 });
  const session = await adapter.resumeSession(THREAD, { cwd: '/work' });
  const events = collect(session);
  await until(() => types(events).includes('session.init'));
  session.compact();
  s.notify('turn/started', { threadId: THREAD, turn: t('compact-stop') });
  await session.interrupt();
  expect(s.paramsOf('turn/interrupt')).toEqual({ threadId: THREAD, turnId: 'compact-stop' });
  finishTurn(s, 'compact-stop', 'interrupted');
  await until(() => types(events).includes('compaction.end'));
  expect(events.find((e) => e.type === 'compaction.end')).toMatchObject({ ok: false });
  session.compact();
  await until(() => types(events).includes('session.closed'));
  expect(events.filter((e) => e.type === 'compaction.end')).toHaveLength(2);
  expect(events.filter((e) => e.type === 'compaction.end').at(-1)).toMatchObject({ ok: false });
});


describe('Codex native skills', () => {
  it('keeps duplicate names and sends only the explicitly selected path', async () => {
    const s = server();
    const skills = [
      { name: 'review', description: 'local', path: '/work/SKILL.md', enabled: true },
      { name: 'review', description: 'home', path: '/home/SKILL.md', enabled: true },
      { name: 'disabled', description: '', path: '/disabled/SKILL.md', enabled: false },
    ];
    s.handle('skills/list', () => ({ data: [{ cwd: '/work', skills, errors: [] }] }));
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const caps = await session.capabilities();
    expect(caps.commands.map((c) => c.skillPath)).toEqual(['/work/SKILL.md', '/home/SKILL.md']);
    session.send('/review code', undefined, undefined, { name: 'review', path: '/home/SKILL.md' });
    await until(() => s.received.some((m) => m.method === 'turn/start'));
    expect((s.received.find((m) => m.method === 'turn/start')?.params as { input: unknown[] }).input).toContainEqual({ type: 'skill', name: 'review', path: '/home/SKILL.md' });
    session.dispose();
  });
});

describe('Codex dynamic Jira integration', () => {
  it.each(['comment', 'transition', 'worklog'] as const)('routes %s to TaskTools with native response', async (name) => {
    const s = server(); const { adapter } = open(s);
    const run = vi.fn(async () => ({ text: 'written' }));
    const taskTools = { spec: () => ({ issue: 'A-1', instance: 'jira', tools: [name] }), onDidChange: () => () => {}, run };
    const session = await adapter.createSession({ cwd: '/work', taskTools });
    const events = collect(session); session.send('task');
    await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('thread/start')['dynamicTools']).toMatchObject([{ name: `mcp__agentura_jira__${name}` }]);
    expect(s.paramsOf('initialize')['capabilities']).toMatchObject({ experimentalApi: true });
    const args = name === 'comment' ? { text: 'done' } : name === 'transition' ? { to: 'Done' } : { minutes: 2 };
    s.request(900, 'item/tool/call', { threadId: THREAD, turnId: 'turn-1', callId: 'call-1', namespace: null, tool: `mcp__agentura_jira__${name}`, arguments: args });
    if (name !== 'comment') {
      await until(() => events.some((e) => e.type === 'permission.request'));
      const e = events.find((e) => e.type === 'permission.request')!;
      expect(session.respondPermission(e.toolUseId, 'allow')).toBe(true);
    }
    await until(() => s.methods().includes('<response>'));
    expect(run).toHaveBeenCalledWith(name, args);
    expect(s.paramsOf('<response>')).toMatchObject({ id: 900, result: { success: true, contentItems: [{ type: 'inputText', text: 'written' }] } });
    session.dispose();
  });
  it('does not register dynamic tools on resume', async () => {
    const s = server(); const { adapter } = open(s); const run = vi.fn(async () => ({ text: 'bad' }));
    const session = await adapter.resumeSession(THREAD, { cwd: '/work', taskTools: { spec: () => ({ issue: 'A-1', instance: 'jira', tools: ['comment'] }), onDidChange: () => () => {}, run } });
    session.send('task'); await until(() => s.methods().includes('turn/start'));
    expect(s.paramsOf('thread/resume')).not.toHaveProperty('dynamicTools');
    s.request(900, 'item/tool/call', { threadId: THREAD, turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'mcp__agentura_jira__comment', arguments: { text: 'bad' } });
    await until(() => s.methods().includes('<response>'));
    expect(s.paramsOf('<response>')).toMatchObject({ result: { success: false } }); expect(run).not.toHaveBeenCalled(); session.dispose();
  });
});

describe('Codex native planning and independent session policies', () => {
  async function idle(s: FakeAppServer, config: Partial<CodexAdapterConfig> = {}, allowBypassPermissions = false) {
    const session = await open(s, config).adapter.createSession({ cwd: '/work', allowBypassPermissions });
    const events = collect(session);
    session.send('open');
    await until(() => types(events).includes('turn.start'));
    finishTurn(s, 'turn-1');
    await until(() => types(events).includes('turn.result'));
    await new Promise((r) => setTimeout(r, 0));
    return { session, events };
  }
  const effective = (extra: Record<string, unknown> = {}) => ({
    approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    collaborationMode: { mode: 'default', settings: { model: 'gpt-native', reasoning_effort: 'high', developer_instructions: null } },
    model: 'gpt-native', effort: 'high', ...extra,
  });

  it('plan before first prompt uses native built-in mode without overriding permissions; plan output is ordinary text', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.setCodexSettings!({ kind: 'planning', value: 'plan' });
    expect(s.methods()).not.toContain('thread/start');
    session.send('plan this');
    await until(() => types(events).includes('turn.start'));
    expect(s.paramsOf('turn/start')).toMatchObject({ collaborationMode: { mode: 'plan', settings: {
      model: fixture.threadStart.model, developer_instructions: null,
    } } });
    expect(s.paramsOf('turn/start').approvalPolicy).toBeUndefined();
    expect(s.paramsOf('turn/start').sandboxPolicy).toBeUndefined();
    s.notify('item/plan/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'p', delta: 'The plan' });
    s.notify('item/completed', { threadId: THREAD, turnId: 'turn-1', item: { type: 'plan', id: 'p', text: 'The plan' } });
    finishTurn(s, 'turn-1');
    await until(() => types(events).includes('turn.result'));
    expect(events.filter((e) => e.type === 'text.delta')).toEqual([{ type: 'text.delta', messageId: 'p', text: 'The plan' }]);
    expect(events.some((e) => e.type === 'plan.request')).toBe(false);
    session.dispose();
  });

  it('planning/default, approval and sandbox writes contain only their own axis and keep complete current details', async () => {
    const s = server().handle('thread/settings/update', () => ({}));
    const custom = { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: false };
    s.handle('thread/start', () => ({ ...fixture.threadStart, sandbox: custom }));
    const { session, events } = await idle(s);
    await session.setCodexSettings!({ kind: 'planning', value: 'plan' });
    expect(s.paramsOf('thread/settings/update')).toEqual({ threadId: THREAD, collaborationMode: {
      mode: 'plan', settings: { model: fixture.threadStart.model, reasoning_effort: fixture.threadStart.reasoningEffort, developer_instructions: null },
    } });
    await session.setCodexSettings!({ kind: 'planning', value: 'default' });
    expect(s.paramsOf('thread/settings/update', 1)).not.toHaveProperty('sandboxPolicy');
    await session.setCodexSettings!({ kind: 'sandbox', value: 'workspaceWrite' });
    expect(s.received.filter((m) => m.method === 'thread/settings/update')).toHaveLength(2);
    await session.setCodexSettings!({ kind: 'approval', value: 'never' });
    expect(s.paramsOf('thread/settings/update', 2)).toEqual({ threadId: THREAD, approvalPolicy: 'never' });
    expect(events.filter((e) => e.type === 'session.settings').at(-1)).toMatchObject({ sessionPolicy: { sandboxPolicy: custom } });
    await session.setCodexSettings!({ kind: 'sandbox', value: 'readOnly' });
    expect(s.paramsOf('thread/settings/update', 3)).toEqual({ threadId: THREAD, sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    await session.setCodexSettings!({ kind: 'sandbox', value: 'workspaceWrite' });
    expect(s.paramsOf('thread/settings/update', 4)).toEqual({ threadId: THREAD, sandboxPolicy: {
      type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    } });
    expect(events.filter((e) => e.type === 'session.settings').at(-1)).toMatchObject({ sessionPolicy: { approvalPolicy: 'never' } });
    session.dispose();
  });

  it('effective notification before RPC response wins over requested presets, foreign threads are ignored', async () => {
    const s = server();
    const { session, events } = await idle(s);
    s.handle('thread/settings/update', () => {
      s.notify('thread/settings/updated', { threadId: THREAD, threadSettings: effective() });
      return {};
    });
    await session.setCodexSettings!({ kind: 'approval', value: 'never' });
    expect(events.filter((e) => e.type === 'session.settings').at(-1)).toMatchObject({ sessionPolicy: { approval: 'on-request' }, planningMode: 'default' });
    const count = events.length;
    s.notify('thread/settings/updated', { threadId: 'other', threadSettings: effective({ approvalPolicy: 'never' }) });
    expect(events).toHaveLength(count);
    session.send('next');
    await until(() => s.received.filter((m) => m.method === 'turn/start').length === 2);
    expect(s.paramsOf('turn/start', 1)).toMatchObject({ collaborationMode: { mode: 'default', settings: { model: 'gpt-native', reasoning_effort: 'high' } } });
    session.dispose();
  });

  it('resume uses effective planning and full policies without policy overrides', async () => {
    const s = server();
    s.handle('thread/resume', () => ({ ...fixture.threadStart,
      collaborationMode: effective().collaborationMode,
      sandbox: { type: 'externalSandbox', networkAccess: 'restricted' },
    }));
    const session = await open(s).adapter.resumeSession(THREAD, { cwd: '/work' });
    const events = collect(session);
    await until(() => types(events).includes('session.init'));
    expect(events[0]).toMatchObject({ planningMode: 'default', sessionPolicy: { sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' } } });
    expect(s.paramsOf('thread/resume')).not.toHaveProperty('sandbox');
    expect(s.paramsOf('thread/resume')).not.toHaveProperty('approvalPolicy');
    session.dispose();
  });

  it('active turn, pending question, compact and full access guard reject changes without writes', async () => {
    const s = server();
    const { session } = await idle(s);
    await expect(session.setCodexSettings!({ kind: 'sandbox', value: 'dangerFullAccess' })).rejects.toThrow('disabled');
    s.request(71, 'item/tool/requestUserInput', { threadId: THREAD, turnId: 'turn-1', itemId: 'q', questions: [{ id: 'q', header: 'Q', question: 'Q?', options: null }] });
    await expect(session.setCodexSettings!({ kind: 'planning', value: 'plan' })).rejects.toThrow('idle');
    session.answerQuestion(tid(session, 71), { q: 'yes' });
    s.handle('thread/compact/start', () => ({}));
    expect(session.compact()).toBe(true);
    await expect(session.setCodexSettings!({ kind: 'approval', value: 'never' })).rejects.toThrow('idle');
    session.dispose();
    expect(s.methods()).not.toContain('thread/settings/update');
  });

  it('settings failure does not claim success; queued send waits and Stop aborts that pre-start turn', async () => {
    const s = server();
    const { session, events } = await idle(s);
    let fail!: (error: Error) => void;
    s.handle('thread/settings/update', () => new Promise((_, reject) => { fail = reject; }));
    const setting = session.setCodexSettings!({ kind: 'planning', value: 'plan' });
    await until(() => !!fail);
    session.send('queued');
    await session.interrupt();
    expect(s.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    fail(new Error('settings refused'));
    await expect(setting).rejects.toThrow('settings refused');
    await until(() => events.filter((e) => e.type === 'turn.result').length === 2);
    expect(events.filter((e) => e.type === 'turn.result').at(-1)).toMatchObject({ interrupted: true });
    expect(events.some((e) => e.type === 'session.settings')).toBe(false);
    expect(s.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    session.dispose();
  });

  it('queued send uses confirmed mode; close drops late response and timeout closes unknown permission state', async () => {
    const s = server();
    const { session, events } = await idle(s);
    let ack!: () => void;
    s.handle('thread/settings/update', () => new Promise((resolve) => { ack = () => resolve({}); }));
    const setting = session.setCodexSettings!({ kind: 'planning', value: 'plan' });
    await until(() => !!ack);
    session.send('queued');
    expect(s.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    ack();
    await setting;
    await until(() => s.received.filter((m) => m.method === 'turn/start').length === 2);
    expect(s.paramsOf('turn/start', 1)).toMatchObject({ collaborationMode: { mode: 'plan' } });
    session.dispose();
    expect(events.filter((e) => e.type === 'session.closed')).toHaveLength(1);
    const s2 = server();
    const opened = await idle(s2, { timeoutMs: 30 });
    s2.handle('thread/settings/update', () => new Promise(() => {}));
    await expect(opened.session.setCodexSettings!({ kind: 'approval', value: 'never' })).rejects.toThrow('timed out');
    expect(opened.events.filter((e) => e.type === 'session.closed')).toHaveLength(1);
    expect(opened.events.some((e) => e.type === 'session.settings')).toBe(false);
  });
  it('full access is sent only by an explicit allowed choice; active turns reject policy changes', async () => {
    const s = server().handle('thread/settings/update', () => ({}));
    const { session } = await idle(s, {}, true);
    expect(s.paramsOf('thread/start')).not.toHaveProperty('sandbox');
    await session.setCodexSettings!({ kind: 'sandbox', value: 'dangerFullAccess' });
    expect(s.paramsOf('thread/settings/update')).toEqual({ threadId: THREAD, sandboxPolicy: { type: 'dangerFullAccess' } });
    session.send('running');
    await until(() => s.received.filter((m) => m.method === 'turn/start').length === 2);
    await expect(session.setCodexSettings!({ kind: 'approval', value: 'never' })).rejects.toThrow('idle');
    session.dispose();
  });

  it('permissions before thread and late settings response after close cannot claim a changed state', async () => {
    const s = server();
    const session = await open(s).adapter.createSession({ cwd: '/work' });
    await expect(session.setCodexSettings!({ kind: 'approval', value: 'never' })).rejects.toThrow('existing thread');
    expect(s.methods()).not.toContain('thread/start');
    session.dispose();
    const s2 = server();
    const opened = await idle(s2);
    let ack!: () => void;
    s2.handle('thread/settings/update', () => new Promise((resolve) => { ack = () => resolve({}); }));
    const pending = opened.session.setCodexSettings!({ kind: 'planning', value: 'plan' });
    const rejected = expect(pending).rejects.toThrow();
    await until(() => !!ack);
    opened.session.dispose();
    ack();
    await rejected;
    expect(opened.events.some((e) => e.type === 'session.settings')).toBe(false);
  });

});
