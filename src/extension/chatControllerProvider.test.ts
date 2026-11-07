import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  /** Файлы каждого `send` (нет — `undefined`). */
  sentFiles: (readonly { kind: string; path: string }[] | undefined)[] = [];
  disposed = false;
  constructor(public id: string) {}
  send(text: string, _images?: unknown, files?: readonly { kind: string; path: string }[]) {
    this.sent.push(text);
    this.sentFiles.push(files);
    return true;
  }
  responded: [string, string][] = [];
  respondPermission(toolUseId: string, decision: string) {
    this.responded.push([toolUseId, decision]);
    return true;
  }
  asked: [string, Record<string, string>][] = [];
  answerQuestion(toolUseId: string, answers: Record<string, string>) {
    this.asked.push([toolUseId, answers]);
    return true;
  }
  planned: unknown[] = [];
  decidePlan(toolUseId: string, decision: unknown) {
    this.planned.push([toolUseId, decision]);
    return true;
  }
  modes: string[] = [];
  async setMode(mode: string) {
    this.modes.push(mode);
  }
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
class AgyTestSession extends Session {}

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
  const cursor = fakeAdapter('cursor');
  const posted: ToWebview[] = [];
  const remembered: AgentProvider[] = [];
  const codexReady = vi.fn(async () => ({ ok: true as const }));
  const agyReady = vi.fn(async () => ({ ok: true as const }));
  const cursorReady = vi.fn(async () => ({ ok: true as const }));
  const deps: ChatDeps = {
    adapter: claude.adapter,
    adapterFor: (p) =>
      p === 'codex'
        ? codex.adapter
        : p === 'antigravity'
          ? agy.adapter
          : p === 'cursor'
            ? cursor.adapter
            : claude.adapter,
    engineFor: (p) =>
      p === 'codex'
        ? { ready: codexReady }
        : p === 'antigravity'
          ? { ready: agyReady }
          : p === 'cursor'
            ? { ready: cursorReady }
            : undefined,
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
  return { controller, claude, codex, agy, cursor, posted, remembered, codexReady, agyReady, cursorReady };
}

const infos = (posted: ToWebview[]) =>
  posted.filter((m): m is Extract<ToWebview, { type: 'chat.info' }> => m.type === 'chat.info');

describe('subagent action guards', () => {
  it.each(['codex', 'antigravity'] as const)('does not create %s session for stale stop', async (provider) => {
    const t = setup({ provider });
    await t.controller.handle({ type: 'agent.stop', sessionId: 'stale', taskId: 'unknown' });
    expect(t.codex.created).toHaveLength(0);
    expect(t.agy.created).toHaveLength(0);
  });
});

describe('ChatController: маршрутизация по провайдеру', () => {
  it('новый Codex-чат получает только свои дефолты, resume их не применяет', async () => {
    const settings = () => ({ allowBypass: false, defaultModel: 'opus', defaultPermissionMode: 'acceptEdits',
      codexDefaults: { model: 'gpt-test', effort: 'high' as const, approval: 'never' as const, sandbox: 'workspaceWrite' as const } });
    const fresh = setup({ provider: 'codex', settings });
    fresh.controller.start();
    await tick();
    expect(fresh.codex.created[0]).toMatchObject({ model: 'gpt-test', codexDefaults: settings().codexDefaults });
    const resumed = setup({ provider: 'codex', resumeId: 'existing', settings });
    resumed.controller.start();
    await tick();
    await tick();
    expect(resumed.codex.resumed[0]![1]).not.toHaveProperty('codexDefaults');
    expect(resumed.codex.resumed[0]![1]).not.toHaveProperty('model');
    const claude = setup({ provider: 'claude', settings });
    claude.controller.start();
    await tick();
    expect(claude.claude.created[0]).toMatchObject({ model: 'opus', permissionMode: 'acceptEdits' });
    expect(claude.claude.created[0]).not.toHaveProperty('codexDefaults');
  });
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
      { cwd: '/p', allowBypassPermissions: true, mcpWatch: true, permissionMode: 'default' },
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

  it('протокол: engine.set — antigravity', () => {
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

  it('текстовые вложения (roadmap 26): Codex — в блок контекста, pdf до адаптера не доходит (Д8); Claude — файлами', async () => {
    const files = [
      { kind: 'text', path: 'K-1.md', data: '# K-1', size: 5 },
      { kind: 'pdf', path: 'a.pdf', data: 'JVBERi0=', size: 6 },
    ];
    const cx = setup({ provider: 'codex' });
    cx.controller.start();
    await tick();
    await cx.controller.handle({ type: 'send', sessionId: '', text: 'продолжи', files } as never);
    const s = cx.codex.sessions[0]!;
    expect(s.sent[0]).toBe('продолжи\n\n[Agentura: контекст]\n--- K-1.md ---\n# K-1');
    expect(s.sentFiles[0]).toBeUndefined();
    const cl = setup();
    cl.controller.start();
    await tick();
    await cl.controller.handle({ type: 'send', sessionId: '', text: 'продолжи', files } as never);
    expect(cl.claude.sessions[0]!.sent[0]).toBe('продолжи');
    expect(cl.claude.sessions[0]!.sentFiles[0]?.map((f) => f.path)).toEqual(['K-1.md', 'a.pdf']);
  });

  it('Д8: движку без файлов только pdf и нет текста — сообщение не уходит (пустое)', async () => {
    const cx = setup({ provider: 'codex' });
    cx.controller.start();
    await tick();
    const files = [{ kind: 'pdf', path: 'a.pdf', data: 'JVBERi0=', size: 6 }];
    await cx.controller.handle({ type: 'send', sessionId: '', text: '', files } as never);
    expect(cx.codex.sessions[0]?.sent ?? []).toEqual([]);
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
    expect(isFromWebview({ type: 'engine.set', provider: 'cursor' })).toBe(true);
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


it('rejects stale or forged Codex skill identity without falling back to plain text', async () => {
  const cx = setup({ provider: 'codex' });
  cx.controller.start();
  await tick();
  await cx.controller.handle({ type: 'send', sessionId: '', text: '/review', skill: { name: 'review', path: '/forged/SKILL.md' } });
  expect(cx.codex.sessions[0]!.sent).toEqual([]);
  cx.controller.dispose();
});


it('opens and sends the exact API skill path, then rejects a removed file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-skill-'));
  const path = join(dir, 'SKILL.md');
  const openPath = vi.fn();
  const cx = setup({ provider: 'codex', openPath });
  try {
    await writeFile(path, '# Skill');
    cx.controller.start();
    await tick();
    const session = cx.codex.sessions[0]!;
    vi.spyOn(session, 'capabilities').mockResolvedValue({ models: [], commands: [{ name: 'review', description: '', skillPath: path }] } as never);
    const send = vi.spyOn(session, 'send');
    await cx.controller.handle({ type: 'skill.open', name: 'review', path });
    expect(openPath).toHaveBeenCalledWith(path);
    await cx.controller.handle({ type: 'send', sessionId: '', text: '/review', skill: { name: 'review', path } });
    expect(send).toHaveBeenCalledWith('/review', undefined, undefined, { name: 'review', path });
    await rm(path);
    await cx.controller.handle({ type: 'send', sessionId: '', text: '/review', skill: { name: 'review', path } });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    cx.controller.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});


describe('Codex Jira host wiring', () => {
  it('passes TaskTools to Codex without permission-mode overrides', async () => {
    const taskTools = { spec: () => undefined, onDidChange: () => () => {}, run: vi.fn(async () => ({ text: 'ok' })) };
    const t = setup({ provider: 'codex', taskTools });
    t.controller.start(); await tick();
    expect(t.codex.created[0]).toMatchObject({ taskTools, allowBypassPermissions: true });
    t.controller.dispose();
  });
});


it('rejects unsupported Codex mode/plan messages before creating a session', async () => {
  const t = setup({ provider: 'codex' });
  await t.controller.handle({ type: 'mode.set', sessionId: '', mode: 'bypassPermissions' });
  await t.controller.handle({ type: 'plan.decide', sessionId: '', toolUseId: 'stale', decision: 'reject' });
  expect(t.codex.created).toHaveLength(0);
});

describe('native Codex settings host boundary', () => {
  it('rejects foreign providers, forged changes and stale sessions without starting a process', async () => {
    for (const provider of ['claude', 'antigravity'] as const) {
      const t = setup({ provider });
      await t.controller.handle({ type: 'codex.settings', sessionId: '', change: { kind: 'approval', value: 'never' } });
      expect(t.claude.created).toHaveLength(0);
      expect(t.agy.created).toHaveLength(0);
    }
    const t = setup({ provider: 'codex' });
    for (const change of [
      { kind: 'sandbox', value: 'workspaceWrite', writableRoots: ['/'] },
      { kind: 'planning', value: 'bypassPermissions' },
      { kind: 'sandbox', value: { type: 'dangerFullAccess' } },
    ]) {
      expect(isFromWebview({ type: 'codex.settings', sessionId: '', change })).toBe(false);
      await t.controller.handle({ type: 'codex.settings', sessionId: '', change } as never);
    }
    await t.controller.handle({ type: 'codex.settings', sessionId: 'old', change: { kind: 'planning', value: 'plan' } });
    expect(t.codex.created).toHaveLength(0);
  });

  it('routes only explicit native settings, respects the full access gate and keeps actual notification for reload', async () => {
    const t = setup({ provider: 'codex', settings: () => ({ allowBypass: false }) });
    t.controller.start();
    await tick();
    const session = t.codex.sessions[0]!;
    const settings = vi.fn(async () => {});
    Object.assign(session, { setCodexSettings: settings });
    await t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'sandbox', value: 'dangerFullAccess' } });
    expect(settings).not.toHaveBeenCalled();
    await t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'planning', value: 'plan' } });
    expect(settings).toHaveBeenCalledWith({ kind: 'planning', value: 'plan' });
    session.events.emit({ type: 'session.init', sessionId: session.id, model: 'gpt', cwd: '/p', permissionMode: 'default', tools: [], slashCommands: [], skills: [], agents: [], apiKeySource: 'none', engineVersion: 'test' });
    const effective: AgentEvent = { type: 'session.settings', planningMode: 'plan', sessionPolicy: {
      approval: 'on-request', sandbox: 'workspaceWrite', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/exact'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    } };
    session.events.emit(effective);
    t.posted.length = 0;
    t.controller.onReady();
    t.controller.onReady();
    await tick();
    await tick();
    expect(t.posted).toContainEqual({ type: 'agent.event', sessionId: session.id, event: effective });
    t.controller.dispose();
  });

  it('failed settings surface an error and release pending state; active turn and approvals are rejected', async () => {
    const t = setup({ provider: 'codex' });
    t.controller.start();
    await tick();
    const session = t.codex.sessions[0]!;
    const settings = vi.fn(async () => { throw new Error('policy refused'); });
    Object.assign(session, { setCodexSettings: settings });
    await t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'approval', value: 'never' } });
    expect(t.posted).toContainEqual(expect.objectContaining({ type: 'agent.event', event: expect.objectContaining({ type: 'error', message: expect.stringContaining('policy refused') }) }));
    expect(t.posted.at(-1)).toEqual({ type: 'codex.settingsResult' });
    session.events.emit({ type: 'turn.start', at: 1 });
    await t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'planning', value: 'plan' } });
    expect(settings).toHaveBeenCalledTimes(1);
    t.controller.dispose();
  });
  it('reload before first thread preserves native planning without starting a thread', async () => {
    const t = setup({ provider: 'codex' });
    t.controller.start();
    await tick();
    const session = t.codex.sessions[0]!;
    session.id = '';
    session.events.emit({ type: 'session.settings', planningMode: 'plan' });
    t.posted.length = 0;
    t.controller.onReady();
    t.controller.onReady();
    await tick();
    expect(t.posted).toContainEqual({ type: 'agent.event', sessionId: '', event: { type: 'session.settings', planningMode: 'plan' } });
    t.controller.dispose();
  });

  it('concurrent/rejected requests do not release the host lock of an in-flight change', async () => {
    const t = setup({ provider: 'codex' });
    t.controller.start();
    await tick();
    const session = t.codex.sessions[0]!;
    let ack!: () => void;
    const settings = vi.fn(() => new Promise<void>((resolve) => { ack = resolve; }));
    Object.assign(session, { setCodexSettings: settings });
    const first = t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'planning', value: 'plan' } });
    await tick();
    await t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'approval', value: 'never' } });
    await t.controller.handle({ type: 'codex.settings', sessionId: session.id, change: { kind: 'sandbox', value: 'workspaceWrite' } });
    expect(settings).toHaveBeenCalledTimes(1);
    ack();
    await first;
    t.controller.dispose();
  });

});

describe('ChatController: Cursor', () => {
  it('сессию создаёт адаптер Cursor: режим из настроек, без модели Claude и дефолтов Codex', async () => {
    const { controller, claude, codex, cursor, posted, cursorReady } = setup({ provider: 'cursor' });
    controller.start();
    await tick();
    expect(claude.created).toHaveLength(0);
    expect(codex.created).toHaveLength(0);
    expect(cursor.created).toEqual([
      { cwd: '/p', allowBypassPermissions: true, permissionMode: 'acceptEdits' },
    ]);
    expect(cursor.created[0]).not.toHaveProperty('model');
    expect(cursor.created[0]).not.toHaveProperty('effort');
    expect(cursor.created[0]).not.toHaveProperty('codexDefaults');
    expect(cursorReady).toHaveBeenCalled();
    controller.pushInfo();
    expect(infos(posted).at(-1)).toMatchObject({
      provider: 'cursor',
      features: providerFeatures('cursor'),
    });
    expect(infos(posted).at(-1)?.features).toMatchObject({
      plan: true,
      questions: false,
      context: false,
      cost: false,
    });
  });

  it('непустой cursor.defaultModel уходит в createSession; пустой — свойства model нет', async () => {
    const settings = (model: string) => () => ({
      allowBypass: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits' as const,
      cursorDefaultModel: model,
    });
    const withModel = setup({ provider: 'cursor', settings: settings('composer-2.5[fast=true]') });
    withModel.controller.start();
    await tick();
    expect(withModel.cursor.created[0]).toMatchObject({
      cwd: '/p',
      allowBypassPermissions: true,
      permissionMode: 'acceptEdits',
      model: 'composer-2.5[fast=true]',
    });
    expect(withModel.cursor.created[0]).not.toHaveProperty('effort');
    expect(withModel.cursor.created[0]).not.toHaveProperty('codexDefaults');
    expect(withModel.posted).toContainEqual({ type: 'session.defaults', mode: 'acceptEdits' });
    expect(withModel.claude.created).toHaveLength(0);

    const empty = setup({ provider: 'cursor', settings: settings('') });
    empty.controller.start();
    await tick();
    expect(empty.cursor.created[0]).not.toHaveProperty('model');
    expect(empty.cursor.created[0]).not.toHaveProperty('effort');
  });

  it('resume Cursor берёт модель из истории и не подставляет дефолт настроек', async () => {
    const settings = () => ({
      allowBypass: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits' as const,
      cursorDefaultModel: 'composer-2.5[fast=true]',
    });
    const withHistory = setup({ provider: 'cursor', resumeId: 'sess-1', settings });
    withHistory.cursor.adapter.loadHistory = async (): Promise<SessionHistory> => ({
      events: [],
      turns: 0,
      skippedTurns: 0,
      model: 'default[]',
    });
    withHistory.controller.start();
    await tick();
    await tick();
    expect(withHistory.cursor.resumed[0]![1]).toMatchObject({ model: 'default[]' });
    expect(withHistory.cursor.created).toHaveLength(0);

    const noHistoryModel = setup({ provider: 'cursor', resumeId: 'sess-2', settings });
    noHistoryModel.controller.start();
    await tick();
    await tick();
    expect(noHistoryModel.cursor.resumed[0]![1]).not.toHaveProperty('model');
  });

  it('bypass без allowBypass понижается до default и не уходит в setMode', async () => {
    const settings = () => ({ allowBypass: false, defaultPermissionMode: 'bypassPermissions' as const });
    const { controller, cursor } = setup({ provider: 'cursor', settings });
    controller.start();
    await tick();
    expect(cursor.created[0]).toMatchObject({ permissionMode: 'default', allowBypassPermissions: false });
    await controller.handle({ type: 'mode.set', sessionId: 'cursor-new', mode: 'bypassPermissions' });
    expect(cursor.sessions[0]!.modes).toEqual([]);
  });

  it('acceptEdits не включает allowBypass: карточка всё равно зовёт respondPermission этой сессии', async () => {
    const settings = () => ({ allowBypass: false, defaultPermissionMode: 'acceptEdits' as const });
    const { controller, cursor, claude } = setup({ provider: 'cursor', settings });
    controller.start();
    await tick();
    expect(cursor.created[0]).toMatchObject({ permissionMode: 'acceptEdits', allowBypassPermissions: false });
    const session = cursor.sessions[0]!;
    await controller.handle({
      type: 'permission.respond',
      sessionId: session.id,
      toolUseId: 'tool_1',
      decision: 'allow',
    });
    await controller.handle({
      type: 'question.answer',
      sessionId: session.id,
      toolUseId: 'tool_q',
      answers: { q: 'a' },
    });
    await controller.handle({
      type: 'plan.decide',
      sessionId: session.id,
      toolUseId: 'tool_p',
      decision: 'run',
    });
    expect(session.responded).toEqual([['tool_1', 'allow']]);
    expect(session.asked).toEqual([['tool_q', { q: 'a' }]]);
    expect(session.planned[0]).toEqual(['tool_p', { approve: true, mode: 'default' }]);
    expect(claude.sessions).toHaveLength(0);
  });

  it('бинарник не найден: карточка engine_missing, сессия не создаётся', async () => {
    const { controller, cursor, claude, posted } = setup({
      provider: 'cursor',
      engineFor: () => ({ ready: async () => ({ ok: false as const, problem: 'Cursor CLI (agent) not found' }) }),
    });
    controller.start();
    await tick();
    await tick();
    expect(cursor.created).toHaveLength(0);
    expect(claude.created).toHaveLength(0);
    expect(posted.find((m) => m.type === 'agent.event' && m.event.type === 'error')).toMatchObject({
      event: { message: 'Cursor CLI (agent) not found', code: 'engine_missing', fatal: true },
    });
  });

  it('resume идёт в адаптер Cursor, не в Claude', async () => {
    const { controller, claude, cursor } = setup({ provider: 'cursor', resumeId: 'sess-1' });
    controller.start();
    await tick();
    await tick();
    expect(claude.loaded).toHaveLength(0);
    expect(claude.resumed).toHaveLength(0);
    expect(cursor.loaded).toEqual(['sess-1']);
    expect(cursor.resumed).toHaveLength(1);
  });

  it('engine.set cursor в пустой вкладке запоминает движок и поднимает Cursor', async () => {
    const { controller, cursor, claude, remembered } = setup();
    await controller.handle({ type: 'engine.set', provider: 'cursor' });
    await tick();
    expect(controller.provider).toBe('cursor');
    expect(remembered).toEqual(['cursor']);
    expect(cursor.created).toHaveLength(1);
    expect(claude.created).toHaveLength(0);
  });
});
