import { describe, expect, it, vi } from 'vitest';
import { EventHub } from '../agent/stream';
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  SessionCapabilities,
  SessionOptions,
} from '../agent/types';
import type { ToWebview } from '../protocol';
import { ChatController, type ChatDeps } from './chatController';

class FakeSession implements AgentSession {
  readonly events = new EventHub<AgentEvent>();
  id = 'sess-1';
  sent: string[] = [];
  permissions: [string, string, string | undefined][] = [];
  modes: string[] = [];
  interrupts = 0;
  compacts = 0;
  disposed = false;
  send(text: string) {
    this.sent.push(text);
    return true;
  }
  respondPermission(id: string, decision: 'allow' | 'allow-always' | 'deny', message?: string) {
    this.permissions.push([id, decision, message]);
    return true;
  }
  answerQuestion() {
    return true;
  }
  decidePlan() {
    return true;
  }
  async setMode(m: string) {
    this.modes.push(m);
  }
  async setModel() {}
  async setEffort() {}
  async interrupt() {
    this.interrupts++;
  }
  compact() {
    this.compacts++;
    return true;
  }
  async stopTask() {}
  async contextUsage() {
    return undefined;
  }
  async capabilities(): Promise<SessionCapabilities> {
    return { models: [{ value: 'opus', displayName: 'Opus' }], commands: [] };
  }
  dispose() {
    this.disposed = true;
  }
  emit(e: AgentEvent) {
    this.events.emit(e);
  }
}

function setup() {
  const sessions: FakeSession[] = [];
  const created: SessionOptions[] = [];
  const adapter = {
    id: 'fake',
    createSession: async (o: SessionOptions) => {
      created.push(o);
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
  } as unknown as AgentAdapter;
  const posted: ToWebview[] = [];
  const titles: string[] = [];
  const deps: ChatDeps = {
    adapter,
    cwd: '/p',
    project: 'p',
    post: (m) => posted.push(m),
    setTitle: (t) => titles.push(t),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: () => ({ allowBypass: false, defaultModel: 'sonnet' }),
    findFiles: async (q) => [{ path: `${q}.ts`, name: `${q}.ts`, dir: '', isDir: false }],
    pickFiles: async () => [],
    readSelection: async () => 'выделенный текст',
    listRecent: async () => [],
    showSessions: vi.fn(),
  };
  const controller = new ChatController(deps);
  return { controller, sessions, created, posted, titles, deps };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ChatController', () => {
  it('сессия создаётся с режимом default и моделью из настройки', async () => {
    const { controller, created } = setup();
    controller.start();
    await tick();
    expect(created[0]).toMatchObject({ cwd: '/p', permissionMode: 'default', model: 'sonnet' });
  });

  it('ready: отдаёт chat.info, список недавних и возможности движка', async () => {
    const { controller, posted } = setup();
    controller.start();
    await controller.handle({ type: 'ready' });
    await tick();
    const types = posted.map((m) => m.type);
    expect(types).toContain('chat.info');
    expect(types).toContain('sessions.update');
    expect(types).toContain('capabilities');
  });

  it('send: текст + блок контекста (с текстом выделения) уходит в сессию', async () => {
    const { controller, sessions } = setup();
    controller.start();
    await controller.handle({
      type: 'send',
      sessionId: '',
      text: 'поправь',
      attachments: [
        { kind: 'file', path: 'a.ts' },
        { kind: 'selection', path: 'a.ts', startLine: 1, endLine: 2 },
      ],
    });
    const sent = sessions[0]!.sent[0]!;
    expect(sent.startsWith('поправь')).toBe(true);
    expect(sent).toContain('- файл: a.ts');
    expect(sent).toContain('выделенный текст');
  });

  it('send: выделение не прочиталось (файл закрыт) — сообщение всё равно уходит', async () => {
    const { controller, sessions, deps } = setup();
    deps.readSelection = async () => {
      throw new Error('нет файла');
    };
    controller.start();
    await controller.handle({
      type: 'send',
      sessionId: '',
      text: 'глянь',
      attachments: [{ kind: 'selection', path: 'gone.ts', startLine: 1, endLine: 1 }],
    });
    expect(sessions[0]!.sent[0]).toContain('- выделение: gone.ts:1-1');
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('события сессии идут в webview с id сессии, маркер вкладки следует за состоянием', async () => {
    const { controller, sessions, posted, titles } = setup();
    controller.start();
    await tick();
    const s = sessions[0]!;
    s.emit({ type: 'turn.start', at: 1, prompt: 'x' });
    s.emit({ type: 'session.title', title: 'мигание' });
    expect(posted.filter((m) => m.type === 'agent.event')).toHaveLength(2);
    expect(posted.find((m) => m.type === 'agent.event')).toMatchObject({ sessionId: 'sess-1' });
    expect(titles).toContain('● Agentura');
    expect(titles.at(-1)).toBe('● Agentura · мигание');
    s.emit({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 1,
      apiDurationMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
      permissionDenials: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(titles.at(-1)).toBe('Agentura · мигание');
  });

  it('запрос разрешения (заглушка этапа 3): отказ с пояснением, ход не виснет', async () => {
    const { controller, sessions, deps } = setup();
    controller.start();
    await tick();
    const s = sessions[0]!;
    s.emit({
      type: 'permission.request',
      toolUseId: 't1',
      toolName: 'Bash',
      input: {},
      canAlwaysAllow: true,
    });
    expect(s.permissions).toHaveLength(1);
    expect(s.permissions[0]![0]).toBe('t1');
    expect(s.permissions[0]![1]).toBe('deny');
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('interrupt, режим, compact доходят до сессии', async () => {
    const { controller, sessions } = setup();
    controller.start();
    await controller.handle({ type: 'interrupt', sessionId: '' });
    await controller.handle({ type: 'mode.set', sessionId: '', mode: 'plan' });
    await controller.handle({ type: 'compact', sessionId: '' });
    await controller.handle({ type: 'effort.set', sessionId: '', effort: 'nope' });
    const s = sessions[0]!;
    expect([s.interrupts, s.modes, s.compacts]).toEqual([1, ['plan'], 1]);
  });

  it('files.find → files.result с тем же requestId', async () => {
    const { controller, posted } = setup();
    await controller.handle({ type: 'files.find', requestId: 7, query: 'abc' });
    expect(posted).toContainEqual({
      type: 'files.result',
      requestId: 7,
      items: [{ path: 'abc.ts', name: 'abc.ts', dir: '', isDir: false }],
    });
  });

  it('newSession: старая сессия закрывается, новая создаётся, webview получает reset', async () => {
    const { controller, sessions, posted } = setup();
    controller.start();
    await tick();
    controller.newSession(true);
    await tick();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.disposed).toBe(true);
    expect(posted.some((m) => m.type === 'session.reset')).toBe(true);
    // события старой сессии уже не идут в webview
    const before = posted.length;
    sessions[0]!.emit({ type: 'session.title', title: 'старая' });
    expect(posted.length).toBe(before);
  });

  it('ошибка создания сессии: fatal error и session.closed в webview', async () => {
    const { deps, posted } = setup();
    const failing = new ChatController({
      ...deps,
      adapter: {
        createSession: async () => Promise.reject(new Error('нет claude')),
      } as unknown as AgentAdapter,
    });
    failing.start();
    await tick();
    await tick();
    const events = posted
      .filter((m) => m.type === 'agent.event')
      .map((m) => (m as { event: AgentEvent }).event.type);
    expect(events).toEqual(['error', 'session.closed']);
  });
});
