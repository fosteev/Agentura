import { describe, expect, it, vi } from 'vitest';
import { EventHub } from '../agent/stream';
import { CodexEventMapper } from '../agent/codex/mapper';
import { providerFeatures } from '../agent/features';
import type {
  AgentAdapter,
  AgentEvent,
  AgentProvider,
  AgentSession,
  SessionHistory,
} from '../agent/types';
import { isFromWebview, type ToWebview } from '../protocol';
import { ChatController, type ChatDeps } from './chatController';

class Session implements AgentSession {
  readonly events = new EventHub<AgentEvent>();
  sent: string[] = [];
  disposed = false;
  constructor(public id: string) {}
  send(text: string) {
    this.sent.push(text);
    return true;
  }
  responded: [string, string][] = [];
  respondPermission(toolUseId: string, decision: string) {
    this.responded.push([toolUseId, decision]);
    return true;
  }
  answerQuestion() {
    return true;
  }
  decidePlan() {
    return true;
  }
  async setMode() {}
  async setModel() {}
  async setEffort() {}
  async interrupt() {}
  compact() {
    return false;
  }
  async stopTask() {}
  async contextUsage() {
    return undefined;
  }
  async capabilities() {
    return { models: [{ value: this.id, displayName: this.id }], commands: [] };
  }
  dispose() {
    this.disposed = true;
  }
}

/** Адаптер, помнящий, что у него просили (`created`/`resumed`) и какие сессии отдал. */
class AgyTestSession extends Session {
  retried: string[] = [];
  /** Что ответит адаптер (`false` — режим уже такой / bypass не разрешён сессии). */
  accept = true;
  async retryWithMode(mode: string) {
    this.retried.push(mode);
    return this.accept;
  }
}

function fakeAdapter(name: string, make: (id: string) => Session = (id) => new Session(id)) {
  const created: Record<string, unknown>[] = [];
  const resumed: [string, Record<string, unknown>][] = [];
  const sessions: Session[] = [];
  const loaded: string[] = [];
  const adapter = {
    id: name,
    createSession: async (o: Record<string, unknown>) => {
      created.push(o);
      const s = make(`${name}-new`);
      sessions.push(s);
      return s;
    },
    resumeSession: async (id: string, o: Record<string, unknown>) => {
      resumed.push([id, o]);
      const s = make(id);
      sessions.push(s);
      return s;
    },
    loadHistory: async (id: string): Promise<SessionHistory> => {
      loaded.push(id);
      return { events: [], turns: 0, skippedTurns: 0 };
    },
  } as unknown as AgentAdapter;
  return { adapter, created, resumed, sessions, loaded };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<ChatDeps> = {}) {
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  const agy = fakeAdapter('agy', (id) => new AgyTestSession(id));
  const posted: ToWebview[] = [];
  const remembered: AgentProvider[] = [];
  const codexReady = vi.fn(async () => ({ ok: true as const }));
  const agyReady = vi.fn(async () => ({ ok: true as const }));
  const deps: ChatDeps = {
    adapter: claude.adapter,
    adapterFor: (p) => (p === 'codex' ? codex.adapter : p === 'antigravity' ? agy.adapter : claude.adapter),
    engineFor: (p) =>
      p === 'codex' ? { ready: codexReady } : p === 'antigravity' ? { ready: agyReady } : undefined,
    rememberProvider: (p) => remembered.push(p),
    cwd: '/p',
    project: 'p',
    post: (m) => posted.push(m),
    setTitle: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: () => ({
      allowBypass: true,
      defaultModel: 'sonnet',
      defaultEffort: 'max',
      defaultPermissionMode: 'acceptEdits',
    }),
    findFiles: async () => [],
    pickFiles: async () => [],
    readSelection: async () => '',
    listRecent: async () => [],
    showSessions: vi.fn(),
    ...over,
  };
  const controller = new ChatController(deps);
  return { controller, claude, codex, agy, posted, remembered, codexReady, agyReady };
}

const infos = (posted: ToWebview[]) =>
  posted.filter((m): m is Extract<ToWebview, { type: 'chat.info' }> => m.type === 'chat.info');

describe('ChatController: маршрутизация по провайдеру', () => {
  it('Claude по умолчанию: chat.info несёт provider и полные флаги, сессия — у Claude-адаптера', async () => {
    const { controller, claude, codex, posted } = setup();
    controller.start();
    await tick();
    controller.pushInfo();
    expect(claude.created).toHaveLength(1);
    expect(codex.created).toHaveLength(0);
    expect(infos(posted).at(-1)).toMatchObject({
      provider: 'claude',
      features: providerFeatures('claude'),
    });
  });

  it('Codex: сессию создаёт адаптер Codex, настройки и модель Claude ему не передаются', async () => {
    const { controller, claude, codex, posted, codexReady } = setup({ provider: 'codex' });
    controller.start();
    await tick();
    expect(claude.created).toHaveLength(0);
    expect(codex.created).toEqual([
      { cwd: '/p', allowBypassPermissions: false, permissionMode: 'default' },
    ]);
    expect(codexReady).toHaveBeenCalled();
    controller.pushInfo();
    expect(infos(posted).at(-1)).toMatchObject({
      provider: 'codex',
      features: providerFeatures('codex'),
    });
    // режим и effort Claude вкладке Codex не рассылаются
    expect(posted.some((m) => m.type === 'session.defaults')).toBe(false);
  });

  it('Codex: возможности движка (model/list) уходят в webview', async () => {
    const { controller, posted } = setup({ provider: 'codex' });
    await controller.handle({ type: 'ready' });
    await tick();
    await tick();
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'capabilities',
        models: [{ value: 'codex-new', displayName: 'codex-new' }],
      }),
    );
  });

  it('Codex не найден: карточка engine_missing, процесс не стартует', async () => {
    const { controller, codex, posted } = setup({
      provider: 'codex',
      engineFor: () => ({
        ready: async () => ({ ok: false as const, problem: 'Codex CLI not found' }),
      }),
    });
    controller.start();
    await tick();
    await tick();
    expect(codex.created).toHaveLength(0);
    const err = posted.find((m) => m.type === 'agent.event' && m.event.type === 'error');
    expect(err).toMatchObject({
      event: { message: 'Codex CLI not found', code: 'engine_missing', fatal: true },
    });
  });

  it('resume Codex-сессии: история и resumeSession — у Codex-адаптера, модель по умолчанию Claude не подставляется', async () => {
    const { controller, claude, codex } = setup({ provider: 'codex', resumeId: 'thr-1' });
    controller.start();
    await tick();
    await tick();
    expect(claude.loaded).toHaveLength(0);
    expect(codex.loaded).toEqual(['thr-1']);
    expect(codex.resumed).toHaveLength(1);
    expect(codex.resumed[0]![1]).toMatchObject({ permissionMode: 'default', baselineCostUsd: 0 });
    expect(codex.resumed[0]![1]).not.toHaveProperty('model');
  });

  it('resume Codex-вкладки (Reload Window): лента из истории треда, название из списка, модель треда уходит в resume', async () => {
    const { controller, codex, posted } = setup({
      provider: 'codex',
      resumeId: 'thr-1',
      titleOf: async (id) => (id === 'thr-1' ? 'Мой тред' : undefined),
    });
    codex.adapter.loadHistory = async (): Promise<SessionHistory> => ({
      events: [
        { type: 'turn.start', prompt: 'привет', at: 1 },
        { type: 'text.delta', messageId: 'm', text: 'здравствуйте' },
      ] as SessionHistory['events'],
      turns: 1,
      skippedTurns: 0,
      model: 'gpt-x',
    });
    controller.start();
    controller.onReady();
    await tick();
    await tick();
    const history = posted.find((m) => m.type === 'session.history');
    expect(history).toMatchObject({ sessionId: 'thr-1', title: 'Мой тред', model: 'gpt-x' });
    expect(codex.resumed[0]![1]).toMatchObject({ model: 'gpt-x' });
  });

  it('resume с другим провайдером: вкладка берёт движок сессии и шлёт свежий chat.info', async () => {
    const { controller, claude, codex, posted } = setup();
    controller.start();
    await tick();
    posted.length = 0;
    await controller.resume('thr-2', true, 'codex');
    expect(controller.provider).toBe('codex');
    expect(infos(posted)[0]).toMatchObject({ provider: 'codex' });
    expect(codex.resumed.map(([id]) => id)).toEqual(['thr-2']);
    expect(claude.resumed).toHaveLength(0);
  });
});

describe('ChatController: Antigravity', () => {
  it('новая вкладка: сессия у адаптера agy, режим из настроек (bypass разрешён), модель и effort Claude не передаются', async () => {
    const { controller, claude, agy, posted, agyReady } = setup({ provider: 'antigravity' });
    controller.start();
    await tick();
    expect(claude.created).toHaveLength(0);
    expect(agyReady).toHaveBeenCalled();
    expect(agy.created).toEqual([{ cwd: '/p', allowBypassPermissions: true, permissionMode: 'acceptEdits' }]);
    controller.pushInfo();
    expect(infos(posted).at(-1)).toMatchObject({
      provider: 'antigravity',
      features: providerFeatures('antigravity'),
    });
    // режим — как у Claude (4 режима), effort не рассылается
    expect(posted).toContainEqual({ type: 'session.defaults', mode: 'acceptEdits' });
  });

  it('resume: история и resumeSession — у адаптера agy, а не Claude', async () => {
    const { controller, claude, agy } = setup({ provider: 'antigravity', resumeId: 'conv-1' });
    controller.start();
    await tick();
    await tick();
    expect(claude.loaded).toHaveLength(0);
    expect(agy.loaded).toEqual(['conv-1']);
    expect(agy.resumed.map(([id]) => id)).toEqual(['conv-1']);
    expect(agy.resumed[0]![1]).toMatchObject({ permissionMode: 'default', baselineCostUsd: 0 });
    expect(agy.resumed[0]![1]).not.toHaveProperty('model');
  });

  it('agy не найден: карточка engine_missing, процесс не стартует', async () => {
    const { controller, agy, posted } = setup({
      provider: 'antigravity',
      engineFor: () => ({ ready: async () => ({ ok: false as const, problem: 'agy not found' }) }),
    });
    controller.start();
    await tick();
    await tick();
    expect(agy.created).toHaveLength(0);
    expect(posted.find((m) => m.type === 'agent.event' && m.event.type === 'error')).toMatchObject({
      event: { message: 'agy not found', code: 'engine_missing', fatal: true },
    });
  });

  it('engine.set antigravity в пустой вкладке: сессия agy, выбор запоминается', async () => {
    const { controller, agy, remembered } = setup();
    await controller.handle({ type: 'engine.set', provider: 'antigravity' });
    controller.start();
    await tick();
    expect(controller.provider).toBe('antigravity');
    expect(remembered).toEqual(['antigravity']);
    expect(agy.created).toHaveLength(1);
  });

  it('смена движка в пустой вкладке сразу обновляет приборы: agy — квота, обратно на Claude — лимиты', async () => {
    const agyQuota = { refresh: vi.fn(async () => ({ rows: [{ label: 'Gemini', remaining: 20 }], updatedAt: 1 })) };
    const usage = { refresh: vi.fn(async () => ({ windows: [], updatedAt: 2 })) };
    const { controller, posted } = setup({ agyQuota, usage });
    await controller.handle({ type: 'engine.set', provider: 'antigravity' });
    await tick();
    expect(agyQuota.refresh).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ type: 'quota.update', rows: [{ label: 'Gemini', remaining: 20 }], updatedAt: 1 });
    expect(usage.refresh).not.toHaveBeenCalled();
    await controller.handle({ type: 'engine.set', provider: 'claude' });
    await tick();
    expect(usage.refresh).toHaveBeenCalledTimes(1);
    expect(agyQuota.refresh).toHaveBeenCalledTimes(1);
  });

  it('agy.retry: повтор уходит сессии agy; bypass без разрешения в настройках — нет', async () => {
    const { controller, agy } = setup({ provider: 'antigravity' });
    controller.start();
    await tick();
    await controller.handle({ type: 'agy.retry', sessionId: 'agy-new', mode: 'acceptEdits' });
    await controller.handle({ type: 'agy.retry', sessionId: 'agy-new', mode: 'bypassPermissions' });
    expect((agy.sessions[0] as AgyTestSession).retried).toEqual(['acceptEdits', 'bypassPermissions']);
    const off = setup({
      provider: 'antigravity',
      settings: () => ({ allowBypass: false }),
    });
    off.controller.start();
    await tick();
    await off.controller.handle({ type: 'agy.retry', sessionId: 'agy-new', mode: 'bypassPermissions' });
    expect((off.agy.sessions[0] as AgyTestSession).retried).toEqual([]);
  });

  it('agy.retry: хост или адаптер повтор не принял — webview получает agy.retryRejected', async () => {
    const off = setup({ provider: 'antigravity', settings: () => ({ allowBypass: false }) });
    off.controller.start();
    await tick();
    await off.controller.handle({ type: 'agy.retry', sessionId: 'agy-new', mode: 'bypassPermissions' });
    expect(off.posted).toContainEqual({ type: 'agy.retryRejected' });
    const { controller, agy, posted } = setup({ provider: 'antigravity' });
    controller.start();
    await tick();
    (agy.sessions[0] as AgyTestSession).accept = false;
    await controller.handle({ type: 'agy.retry', sessionId: 'agy-new', mode: 'acceptEdits' });
    expect((agy.sessions[0] as AgyTestSession).retried).toEqual(['acceptEdits']);
    expect(posted).toContainEqual({ type: 'agy.retryRejected' });
  });

  it('agy.retry в Claude-вкладке игнорируется: ни режима, ни сообщения, ни ответа webview', async () => {
    const { controller, claude, posted } = setup();
    controller.start();
    await tick();
    const s = claude.sessions[0]!;
    const setMode = vi.spyOn(s, 'setMode');
    const before = posted.length;
    await controller.handle({ type: 'agy.retry', sessionId: 'x', mode: 'acceptEdits' });
    expect(setMode).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    expect(posted.slice(before)).toEqual([]);
  });

  it('defaultPermissionMode=bypassPermissions без allowBypassPermissions: agy стартует в default без bypass', async () => {
    const { controller, agy } = setup({
      provider: 'antigravity',
      settings: () => ({ allowBypass: false, defaultPermissionMode: 'bypassPermissions' }),
    });
    controller.start();
    await tick();
    expect(agy.created).toEqual([{ cwd: '/p', allowBypassPermissions: false, permissionMode: 'default' }]);
  });

  it('resume: заголовок вкладки спрашивается с провайдером вкладки', async () => {
    const titleOf = vi.fn(async () => 'Беседа agy');
    const { controller } = setup({ provider: 'antigravity', resumeId: 'conv-1', titleOf });
    controller.start();
    await tick();
    await tick();
    expect(titleOf).toHaveBeenCalledWith('conv-1', 'antigravity');
  });

  it('протокол: agy.retry принимает только два режима; engine.set — antigravity', () => {
    expect(isFromWebview({ type: 'agy.retry', sessionId: 's', mode: 'acceptEdits' })).toBe(true);
    expect(isFromWebview({ type: 'agy.retry', sessionId: 's', mode: 'bypassPermissions' })).toBe(true);
    expect(isFromWebview({ type: 'agy.retry', sessionId: 's', mode: 'plan' })).toBe(false);
    expect(isFromWebview({ type: 'engine.set', provider: 'antigravity' })).toBe(true);
  });
});

describe('ChatController: выбор движка engine.set', () => {
  it('в пустой вкладке: сессия прежнего движка закрывается, поднимается новая, выбор запоминается', async () => {
    const { controller, claude, codex, posted, remembered } = setup();
    controller.start();
    await tick();
    expect(claude.sessions).toHaveLength(1);
    await controller.handle({ type: 'engine.set', provider: 'codex' });
    await tick();
    expect(controller.provider).toBe('codex');
    expect(claude.sessions[0]!.disposed).toBe(true);
    expect(codex.created).toHaveLength(1);
    expect(remembered).toEqual(['codex']);
    expect(infos(posted).at(-1)).toMatchObject({ provider: 'codex' });
    expect(posted.some((m) => m.type === 'session.reset')).toBe(true);
  });

  it('тот же движок — ничего не происходит', async () => {
    const { controller, claude, remembered } = setup();
    controller.start();
    await tick();
    await controller.handle({ type: 'engine.set', provider: 'claude' });
    expect(claude.sessions).toHaveLength(1);
    expect(remembered).toEqual([]);
  });

  it('после первого сообщения выбор игнорируется', async () => {
    const { controller, claude, codex, remembered } = setup();
    controller.start();
    await tick();
    await controller.handle({ type: 'send', text: 'привет' } as never);
    await controller.handle({ type: 'engine.set', provider: 'codex' });
    await tick();
    expect(controller.provider).toBe('claude');
    expect(claude.sessions[0]!.disposed).toBe(false);
    expect(codex.created).toHaveLength(0);
    expect(remembered).toEqual([]);
  });

  it('возобновлённая сессия остаётся на своём движке', async () => {
    const { controller, codex, remembered } = setup({ resumeId: 'abc' });
    controller.start();
    await tick();
    await tick();
    await controller.handle({ type: 'engine.set', provider: 'codex' });
    expect(controller.provider).toBe('claude');
    expect(codex.created).toHaveLength(0);
    expect(remembered).toEqual([]);
  });

  it('/clear в Codex-вкладке остаётся на Codex', async () => {
    const { controller, claude, codex } = setup({ provider: 'codex' });
    controller.start();
    await tick();
    await controller.handle({ type: 'session.new' });
    await tick();
    expect(codex.created).toHaveLength(2);
    expect(claude.created).toHaveLength(0);
  });

  it('протокол: engine.set принимает только известные движки', () => {
    expect(isFromWebview({ type: 'engine.set', provider: 'codex' })).toBe(true);
    expect(isFromWebview({ type: 'engine.set', provider: 'gemini' })).toBe(false);
    expect(isFromWebview({ type: 'engine.set' })).toBe(false);
  });

  it('Codex: события инструментов мапера попадают в «изменения» и превью карточки; решение уходит сессии Codex', async () => {
    const opened: { filePath: string; before: string; after: string }[] = [];
    const { controller, codex, posted } = setup({
      provider: 'codex',
      openDiff: async (d) => void opened.push(d),
      readText: async () => undefined,
    });
    controller.start();
    await tick();
    const session = codex.sessions[0]!;
    // события — те, что выдаёт настоящий маппер на живых формах item/*
    const m = new CodexEventMapper(() => 1);
    m.threadId = 'thr';
    const base = { threadId: 'thr', turnId: 'turn-1' };
    const update = {
      path: '/p/b.txt',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1,3 +1,3 @@\n line1\n-line2\n+line two\n line3\n',
    };
    const add = { path: '/p/a.txt', kind: { type: 'add' }, diff: 'hi\n' };
    const item = (id: string, change: unknown, status: string) => ({ type: 'fileChange', id, changes: [change], status });
    for (const e of [
      ...m.map('item/started', { ...base, startedAtMs: 1, item: item('fc-1', add, 'inProgress') }),
      ...m.map('item/completed', { ...base, completedAtMs: 2, item: item('fc-1', add, 'completed') }),
      ...m.map('item/started', { ...base, startedAtMs: 3, item: item('fc-2', update, 'inProgress') }),
      ...m.map('item/completed', { ...base, completedAtMs: 4, item: item('fc-2', update, 'completed') }),
    ])
      session.events.emit(e);
    await controller.handle({ type: 'diff.changes', sessionId: '', toolUseIds: ['fc-1'] });
    await controller.handle({ type: 'diff.changes', sessionId: '', toolUseIds: ['fc-2'] });
    expect(opened).toMatchObject([
      { filePath: '/p/a.txt', before: '', after: 'hi\n' },
      { filePath: '/p/b.txt', before: 'line1\nline2\nline3', after: 'line1\nline two\nline3' },
    ]);

    // карточка подтверждения на создание файла: превью уходит в вебвью, ответ — сессии Codex
    session.events.emit({
      type: 'permission.request',
      toolUseId: '0',
      toolName: 'Write',
      input: { file_path: '/p/a.txt' },
      canAlwaysAllow: true,
      always: { rules: [], directories: [], mode: 'acceptEdits' },
      diff: { kind: 'write', filePath: '/p/a.txt', content: 'hi\n' },
    });
    await tick();
    await tick();
    expect(posted.some((p) => p.type === 'diff.preview')).toBe(true);
    await controller.handle({ type: 'permission.respond', sessionId: '', toolUseId: '0', decision: 'allow-edits' });
    expect(session.responded).toEqual([['0', 'allow-edits']]);
  });
});
