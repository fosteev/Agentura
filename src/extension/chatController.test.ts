import { describe, expect, it, vi } from 'vitest';
import { EventHub } from '../agent/stream';
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  PlanDecision,
  SessionCapabilities,
  SessionHistory,
  SessionOptions,
} from '../agent/types';
import type { ToWebview } from '../protocol';
import {
  ChatController,
  describeEvent,
  PLAN_REFINE_MESSAGE,
  PLAN_REFINE_PREFIX,
  PLAN_REJECT_MESSAGE,
  planDecision,
  type ChatDeps,
  type OpenDiff,
} from './chatController';

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
  respondPermission(id: string, decision: string, message?: string) {
    this.permissions.push([id, decision, message]);
    return true;
  }
  answers: [string, Record<string, string>][] = [];
  plans: [string, PlanDecision][] = [];
  answerQuestion(id: string, answers: Record<string, string>) {
    this.answers.push([id, answers]);
    return true;
  }
  decidePlan(id: string, d: PlanDecision) {
    this.plans.push([id, d]);
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

const snap = { windows: [{ kind: 'five-hour' as const, percent: 62 }], updatedAt: 1234 };

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

  it('запрос разрешения ждёт ответа карточки: маркер «?», ответ уходит в сессию', async () => {
    const { controller, sessions, titles } = setup();
    controller.start();
    await tick();
    const s = sessions[0]!;
    s.emit({ type: 'turn.start', at: 1, prompt: 'x' });
    s.emit({
      type: 'permission.request',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      canAlwaysAllow: true,
    });
    expect(s.permissions).toHaveLength(0);
    expect(titles.at(-1)).toMatch(/^\? /);
    await controller.handle({
      type: 'permission.respond',
      sessionId: 'sess-1',
      toolUseId: 't1',
      decision: 'allow-always',
    });
    expect(s.permissions).toEqual([['t1', 'allow-always', undefined]]);
  });

  it('два запроса сразу (основной и субагент): «?» держится до последнего ответа', async () => {
    const { controller, sessions, titles } = setup();
    controller.start();
    await tick();
    const s = sessions[0]!;
    s.emit({ type: 'turn.start', at: 1, prompt: 'x' });
    s.emit({ type: 'question.request', toolUseId: 'q', questions: [] });
    s.emit({
      type: 'permission.request',
      agentId: 'sub',
      toolUseId: 'p',
      toolName: 'Bash',
      input: {},
      canAlwaysAllow: false,
    });
    s.emit({ type: 'permission.resolved', toolUseId: 'q', decision: 'allow', by: 'user' });
    expect(titles.at(-1)).toMatch(/^\? /);
    s.emit({
      type: 'permission.resolved',
      agentId: 'sub',
      toolUseId: 'p',
      decision: 'allow',
      by: 'user',
    });
    expect(titles.at(-1)).toMatch(/^● /);
  });

  it('вопрос и план: ответы и кнопки плана → решения сессии', async () => {
    const { controller, sessions } = setup();
    controller.start();
    await tick();
    const s = sessions[0]!;
    await controller.handle({
      type: 'question.answer',
      sessionId: '',
      toolUseId: 'q',
      answers: { 'Цвет?': 'Синий' },
    });
    expect(s.answers).toEqual([['q', { 'Цвет?': 'Синий' }]]);
    for (const decision of ['run', 'run-edits', 'refine', 'reject'] as const) {
      await controller.handle({
        type: 'plan.decide',
        sessionId: '',
        toolUseId: decision,
        decision,
        ...(decision === 'refine' ? { feedback: ' добавь тесты ' } : {}),
      });
    }
    expect(s.plans).toEqual([
      ['run', { approve: true, mode: 'default' }],
      ['run-edits', { approve: true, mode: 'acceptEdits' }],
      ['refine', { approve: false, feedback: `${PLAN_REFINE_PREFIX}добавь тесты` }],
      ['reject', { approve: false, feedback: PLAN_REJECT_MESSAGE, interrupt: true }],
    ]);
    expect(planDecision('refine', '  ')).toEqual({ approve: false, feedback: PLAN_REFINE_MESSAGE });
  });

  it('ответ карточке после /clear не уходит в старую сессию', async () => {
    const { controller, sessions } = setup();
    controller.start();
    await tick();
    sessions[0]!.emit({
      type: 'permission.request',
      toolUseId: 't1',
      toolName: 'Bash',
      input: {},
      canAlwaysAllow: false,
    });
    controller.newSession(true);
    await controller.handle({
      type: 'permission.respond',
      sessionId: 'sess-1',
      toolUseId: 't1',
      decision: 'allow',
    });
    expect(sessions[0]!.permissions).toEqual([]);
    expect(sessions[1]!.permissions).toEqual([['t1', 'allow', undefined]]); // новая сессия: брокер вернёт false
  });

  it('agent.transcript: текст адаптера — документом только для чтения; нет файла — только журнал', async () => {
    const { controller, deps } = setup();
    const asked: unknown[][] = [];
    const opened: { key: string; name: string; text: string }[] = [];
    (deps.adapter as { agentTranscript?: unknown }).agentTranscript = async (...a: unknown[]) => {
      asked.push(a);
      return a[2] === 'tk1' ? '# t' : undefined;
    };
    deps.openText = async (d) => void opened.push(d);
    await controller.handle({
      type: 'agent.transcript',
      sessionId: 's1',
      agentId: 'toolu_1',
      taskId: 'tk1',
    });
    await controller.handle({
      type: 'agent.transcript',
      sessionId: 's1',
      agentId: 'toolu_2',
      taskId: 'tk2',
    });
    expect(asked).toEqual([
      ['s1', '/p', 'tk1', ''],
      ['s1', '/p', 'tk2', ''],
    ]);
    expect(opened).toEqual([{ key: 'agent-tk1', name: 'agent-tk1.md', text: '# t' }]);
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
  });

  it('bypass без настройки allowBypassPermissions не включается', async () => {
    const { controller, sessions, deps } = setup();
    controller.start();
    await tick();
    await controller.handle({ type: 'mode.set', sessionId: '', mode: 'bypassPermissions' });
    expect(sessions[0]!.modes).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('правка: превью ханков вдогонку запросу, «открыть дифф» — предложенная, потом применённая', async () => {
    const { controller, sessions, posted, deps } = setup();
    const opened: OpenDiff[] = [];
    deps.readText = async () => 'a\nb\nc\n';
    deps.openDiff = async (d) => void opened.push(d);
    controller.start();
    await tick();
    const s = sessions[0]!;
    const input = {
      file_path: '/p/f.ts',
      old_string: 'b\n',
      new_string: 'B\n',
      replace_all: false,
    };
    s.emit({ type: 'tool.start', toolUseId: 'e1', name: 'Edit', input });
    s.emit({
      type: 'permission.request',
      toolUseId: 'e1',
      toolName: 'Edit',
      input,
      canAlwaysAllow: true,
      diff: {
        kind: 'edit',
        filePath: '/p/f.ts',
        oldText: 'b\n',
        newText: 'B\n',
        replaceAll: false,
      },
    });
    await tick();
    const preview = posted.find((m) => m.type === 'diff.preview');
    expect(preview).toMatchObject({
      toolUseId: 'e1',
      preview: {
        add: 1,
        del: 1,
        hunks: [{ header: '@@ -1,3 +1,3 @@', lines: [' a', '-b', '+B', ' c'] }],
      },
    });
    await controller.handle({ type: 'diff.open', sessionId: '', toolUseId: 'e1' });
    expect(opened[0]).toMatchObject({
      key: 'e1-proposed',
      before: 'a\nb\nc\n',
      after: 'a\nB\nc\n',
      stage: 'proposed',
    });

    s.emit({
      type: 'tool.result',
      toolUseId: 'e1',
      isError: false,
      content: 'ok',
      result: {
        filePath: '/p/f.ts',
        oldString: 'b\n',
        newString: 'B\n',
        originalFile: 'a\nb\nc\n',
        structuredPatch: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
        ],
      },
    });
    await controller.handle({ type: 'diff.open', sessionId: '', toolUseId: 'e1' });
    expect(opened[1]).toMatchObject({ key: 'e1-applied', after: 'a\nB\nc\n', stage: 'applied' });

    await controller.handle({ type: 'diff.open', sessionId: '', toolUseId: 'нет' });
    expect(opened).toHaveLength(2);
  });

  it('preview.open: абсолютный .html — в deps, остальное отброшено с warn', async () => {
    const { controller, deps } = setup();
    const previews: string[] = [];
    deps.openPreview = async (p) => void previews.push(p);
    controller.start();
    await tick();
    await controller.handle({ type: 'preview.open', path: '/p/page.html' });
    await controller.handle({ type: 'preview.open', path: '/p/PAGE.HTM' });
    expect(previews).toEqual(['/p/page.html', '/p/PAGE.HTM']);
    await controller.handle({ type: 'preview.open', path: 'rel/page.html' });
    await controller.handle({ type: 'preview.open', path: '/p/script.ts' });
    expect(previews).toHaveLength(2);
    expect(deps.log.warn).toHaveBeenCalledTimes(2);
  });

  it('link.open: только https://claude.ai/, остальное — warn', async () => {
    const { controller, deps } = setup();
    const urls: string[] = [];
    deps.openExternal = (u) => void urls.push(u);
    controller.start();
    await tick();
    await controller.handle({ type: 'link.open', url: 'https://claude.ai/artifact/abc' });
    await controller.handle({ type: 'link.open', url: 'https://evil.example/https://claude.ai/' });
    await controller.handle({ type: 'link.open', url: 'http://claude.ai/x' });
    await controller.handle({ type: 'link.open', url: 'file:///etc/passwd' });
    expect(urls).toEqual(['https://claude.ai/artifact/abc']);
    expect(deps.log.warn).toHaveBeenCalledTimes(3);
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

  it('ready: пороги контекста из настроек и лимиты подписки уходят в webview', async () => {
    const { controller, posted, deps } = setup();
    deps.settings = () => ({ allowBypass: false, contextThresholds: [100, 200] });
    const refresh = vi.fn(async () => snap);
    deps.usage = { refresh };
    controller.start();
    await controller.handle({ type: 'ready' });
    await tick();
    expect(posted.find((m) => m.type === 'chat.info')).toMatchObject({
      contextThresholds: [100, 200],
    });
    expect(posted).toContainEqual({ type: 'limits.update', ...snap });
  });

  it('limits.refresh и конец хода перечитывают лимиты; ошибка источника не роняет чат', async () => {
    const { controller, sessions, posted, deps } = setup();
    const refresh = vi.fn(async () => snap);
    deps.usage = { refresh };
    controller.start();
    await controller.handle({ type: 'limits.refresh' });
    expect(refresh).toHaveBeenCalledTimes(1);
    sessions[0]!.emit({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 1,
      apiDurationMs: 1,
      numTurns: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      totalCostUsd: 0,
      permissionDenials: [],
    });
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
    refresh.mockRejectedValueOnce(new Error('сеть'));
    await controller.handle({ type: 'limits.refresh' });
    expect(deps.log.warn).toHaveBeenCalled();
    expect(posted.filter((m) => m.type === 'limits.update')).toHaveLength(2);
  });

  it('limit.update движка: окна уходят в запасной источник, при rejected — обновление точных', async () => {
    const { controller, sessions, deps } = setup();
    const refresh = vi.fn(async () => snap);
    const observe = vi.fn();
    deps.usage = { refresh };
    deps.observeLimits = observe;
    controller.start();
    await controller.handle({ type: 'limits.refresh' });
    const w = [{ kind: 'five-hour' as const, percent: 100 }];
    sessions[0]!.emit({ type: 'limit.update', source: 'engine', status: 'allowed', windows: w });
    expect(observe).toHaveBeenCalledWith(w);
    expect(refresh).toHaveBeenCalledTimes(1);
    sessions[0]!.emit({ type: 'limit.update', source: 'engine', status: 'rejected', windows: w });
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  // второй проход ревью этапа 3
  it('падение старой сессии после /clear не затирает новую и не пишет в ленту', async () => {
    const { deps, posted } = setup();
    let rejectFirst: (e: Error) => void = () => {};
    const made: FakeSession[] = [];
    let calls = 0;
    const controller = new ChatController({
      ...deps,
      adapter: {
        createSession: () =>
          calls++ === 0
            ? new Promise<AgentSession>((_, reject) => (rejectFirst = reject))
            : Promise.resolve(made[made.push(new FakeSession()) - 1]!),
      } as unknown as AgentAdapter,
    });
    controller.start(); // сессия A висит
    controller.newSession(true); // B создаётся
    await tick();
    rejectFirst(new Error('A упала'));
    await tick();
    await tick();
    const events = posted.filter((m) => m.type === 'agent.event');
    expect(events).toHaveLength(0);
    // B осталась текущей: send доходит до неё
    await controller.handle({ type: 'send', sessionId: '', text: 'привет' });
    expect(made[0]!.sent).toEqual(['привет']);
  });

  it('send по очереди: сообщение с выделением не обгоняется следующим', async () => {
    const { deps, sessions } = setup();
    let release: (t: string) => void = () => {};
    const controller = new ChatController({
      ...deps,
      readSelection: () => new Promise<string>((r) => (release = r)),
    });
    controller.start();
    const first = controller.handle({
      type: 'send',
      sessionId: '',
      text: 'первое',
      attachments: [{ kind: 'selection', path: 'a.ts', startLine: 1, endLine: 2 }],
    });
    const second = controller.handle({ type: 'send', sessionId: '', text: 'второе' });
    await tick();
    expect(sessions[0]!.sent).toEqual([]);
    release('текст');
    await Promise.all([first, second]);
    expect(sessions[0]!.sent.map((t) => t.split('\n')[0])).toEqual(['первое', 'второе']);
  });

  it('ошибка capabilities() не даёт необработанного отказа — только предупреждение', async () => {
    const { controller, sessions, deps } = setup();
    controller.start();
    await tick();
    sessions[0]!.capabilities = () => Promise.reject(new Error('движок молчит'));
    controller.onReady();
    await tick();
    await tick();
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('движок молчит'));
  });

  it('session.closed: сессия уходит из live-списка и не возвращается туда', async () => {
    const { deps, sessions } = setup();
    const live = { set: vi.fn(), delete: vi.fn() };
    const controller = new ChatController({ ...deps, live: live as unknown as ChatDeps['live'] });
    controller.start();
    await tick();
    const s = sessions[0]!;
    s.emit({
      type: 'session.init',
      sessionId: 'sess-1',
      model: 'sonnet',
      cwd: '/p',
      tools: [],
      permissionMode: 'default',
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
    } as unknown as AgentEvent);
    expect(live.set).toHaveBeenCalled();
    live.set.mockClear();
    s.emit({ type: 'session.closed', reason: 'error', message: 'упал' });
    expect(live.delete).toHaveBeenCalledWith('sess-1');
    // упавшая сессия остаётся в списке строкой `err` — до «Повторить ход», возобновления или закрытия вкладки
    expect(live.set).toHaveBeenCalledWith('sess-1', 'error');
    live.set.mockClear();
    controller.dispose();
    expect(live.delete).toHaveBeenLastCalledWith('sess-1');
  });
});

// ——— этап 6: возобновление, история, пересев webview ———

describe('ChatController: сессии (этап 6)', () => {
  const editResult = {
    filePath: '/p/a.ts',
    originalFile: 'a\nb\n',
    structuredPatch: [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] },
    ],
  };
  const historyEvents: AgentEvent[] = [
    { type: 'turn.start', prompt: 'поправь', at: 1 },
    {
      type: 'tool.start',
      toolUseId: 't1',
      name: 'Edit',
      input: { file_path: '/p/a.ts', old_string: 'b', new_string: 'c' },
      at: 2,
    },
    {
      type: 'tool.result',
      toolUseId: 't1',
      isError: false,
      content: 'ok',
      result: editResult,
      at: 3,
    },
    { type: 'text.delta', messageId: 'm', text: 'Готово' },
    {
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 2,
      apiDurationMs: 0,
      numTurns: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      totalCostUsd: 0.1,
      permissionDenials: [],
    },
  ];

  function setupResume(over: Partial<ChatDeps> = {}, history: Partial<SessionHistory> = {}) {
    const sessions: FakeSession[] = [];
    const resumed: [string, Record<string, unknown>][] = [];
    const created: SessionOptions[] = [];
    const loadHistory = vi.fn(async (): Promise<SessionHistory> => ({
      events: historyEvents,
      turns: 1,
      skippedTurns: 0,
      model: 'claude-haiku-4-5',
      mode: 'plan',
      totalCostUsd: 0.5,
      ...history,
    }));
    const adapter = {
      id: 'fake',
      loadHistory,
      createSession: async (o: SessionOptions) => {
        created.push(o);
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
      resumeSession: async (id: string, o: Record<string, unknown>) => {
        resumed.push([id, o]);
        const s = new FakeSession();
        s.id = id;
        sessions.push(s);
        return s;
      },
    } as unknown as AgentAdapter;
    const posted: ToWebview[] = [];
    const opened: OpenDiff[] = [];
    const deps: ChatDeps = {
      adapter,
      cwd: '/p',
      project: 'p',
      post: (m) => posted.push(m),
      setTitle: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      settings: () => ({ allowBypass: false, defaultModel: 'sonnet' }),
      findFiles: async () => [],
      pickFiles: async () => [],
      readSelection: async () => undefined,
      listRecent: async () => [],
      showSessions: vi.fn(),
      openDiff: async (d) => void opened.push(d),
      titleOf: async () => 'Мигание табло',
      ...over,
    };
    return {
      controller: new ChatController(deps),
      sessions,
      resumed,
      created,
      loadHistory,
      posted,
      opened,
      deps,
    };
  }

  const historyMsg = (posted: ToWebview[]) =>
    posted.find(
      (m): m is Extract<ToWebview, { type: 'session.history' }> => m.type === 'session.history',
    );

  it('вкладку закрыли, пока читалась история: процесс движка не поднимается ни resume, ни пересевом', async () => {
    const { controller, resumed, created, loadHistory } = setupResume({ resumeId: 's-old' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = loadHistory.getMockImplementation()!;
    loadHistory.mockImplementation(async () => {
      await gate;
      return original();
    });
    controller.start();
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'ready' }); // пересоздание webview во время чтения
    controller.dispose();
    release();
    await tick();
    await tick();
    await tick();
    expect(resumed).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('resumeId: история читается, движок возобновляется с моделью, режимом и базой стоимости из сессии', async () => {
    const { controller, resumed, created, loadHistory } = setupResume({ resumeId: 's-old' });
    controller.start();
    await tick();
    await tick();
    expect(loadHistory).toHaveBeenCalledWith('s-old', '/p');
    expect(created).toHaveLength(0);
    expect(resumed).toEqual([
      [
        's-old',
        expect.objectContaining({
          permissionMode: 'plan',
          model: 'claude-haiku-4-5',
          baselineCostUsd: 0.5,
          cwd: '/p',
        }),
      ],
    ]);
    expect(controller.sessionId).toBe('s-old');
    expect(controller.pristine).toBe(false);
  });

  it('база стоимости: нет cost-state в транскрипте — 0 (движок продолжит итог с нуля); bypass без настройки → default', async () => {
    const { controller, resumed } = setupResume(
      { resumeId: 's' },
      { totalCostUsd: undefined, mode: 'bypassPermissions' },
    );
    controller.start();
    await tick();
    await tick();
    expect(resumed[0]![1]).toMatchObject({ baselineCostUsd: 0, permissionMode: 'default' });
  });

  it('восстановление: история уходит на ready, без тяжёлых файлов в событиях; название и режим — в заголовке', async () => {
    const { controller, posted } = setupResume({ resumeId: 's-old' });
    controller.start();
    await tick();
    await tick();
    expect(historyMsg(posted)).toBeUndefined(); // webview ещё не готов
    await controller.handle({ type: 'ready' });
    await tick();
    const h = historyMsg(posted)!;
    expect(h).toMatchObject({
      sessionId: 's-old',
      title: 'Мигание табло',
      model: 'claude-haiku-4-5',
      mode: 'plan',
      skippedTurns: 0,
    });
    const result = h.events.find((e) => e.type === 'tool.result') as {
      result: Record<string, unknown>;
    };
    expect(result.result['originalFile']).toBeUndefined();
    expect(result.result['structuredPatch']).toBeDefined();
  });

  it('ready пришёл раньше, чем прочиталась история: она уходит сразу по готовности, не теряется', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { controller, posted, loadHistory } = setupResume({ resumeId: 's-old' });
    loadHistory.mockImplementation(async () => {
      await gate;
      return { events: historyEvents, turns: 1, skippedTurns: 0 };
    });
    controller.start();
    await controller.handle({ type: 'ready' }); // webview загрузился быстрее транскрипта
    expect(historyMsg(posted)).toBeUndefined();
    release();
    await tick();
    await tick();
    expect(posted.filter((m) => m.type === 'session.history')).toHaveLength(1);
  });

  it('«diff» в восстановленной истории находит правку (стороны — из результата, присланного хосту целиком)', async () => {
    const { controller, opened, deps } = setupResume({ resumeId: 's-old' });
    controller.start();
    await tick();
    await tick();
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'diff.open', sessionId: 's-old', toolUseId: 't1' });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      filePath: '/p/a.ts',
      before: 'a\nb\n',
      after: 'a\nc\n',
      stage: 'applied',
    });
    expect(deps.log.warn).not.toHaveBeenCalled();
  });

  it('клик по сессии в живой вкладке: без менеджера вкладок возобновляется на месте и сразу шлёт историю', async () => {
    const { controller, posted, resumed } = setupResume();
    controller.start();
    await controller.handle({ type: 'ready' });
    await tick();
    posted.length = 0;
    await controller.handle({ type: 'session.resume', sessionId: 's-2' });
    await tick();
    expect(historyMsg(posted)).toMatchObject({ sessionId: 's-2' });
    expect(resumed.map((r) => r[0])).toEqual(['s-2']);
    expect(controller.sessionId).toBe('s-2');
  });

  it('с менеджером вкладок клик отдаётся ему (openSession), сессия не трогается', async () => {
    const openSession = vi.fn();
    const { controller, resumed, created } = setupResume({ openSession });
    controller.start();
    await tick();
    await controller.handle({ type: 'session.resume', sessionId: 'other' });
    expect(openSession).toHaveBeenCalledWith('other');
    expect(resumed).toHaveLength(0);
    expect(created).toHaveLength(1);
  });

  it('транскрипта нет: вкладка остаётся с новой сессией, webview получает сброс', async () => {
    const { controller, posted, created } = setupResume({ resumeId: 'gone' });
    (controller as unknown as { deps: ChatDeps }).deps.adapter.loadHistory = async () => {
      throw new Error('нет файла');
    };
    controller.start();
    await tick();
    await tick();
    expect(posted.some((m) => m.type === 'session.reset')).toBe(true);
    expect(created).toHaveLength(1);
    expect(controller.sessionId).toBeUndefined();
  });

  it('фоновая вкладка: историю читаем, процесс движка — по wake()', async () => {
    const { controller, resumed } = setupResume({ resumeId: 's-old' });
    controller.start(false);
    await tick();
    await tick();
    expect(resumed).toHaveLength(0);
    controller.wake();
    await tick();
    expect(resumed).toHaveLength(1);
  });

  it('webview пересоздан при живой сессии: история + init + ждущие запросы с превью диффа уходят на второй ready', async () => {
    const { controller, sessions, posted } = setupResume({ readText: async () => 'a\nb\n' });
    controller.start();
    await controller.handle({ type: 'ready' });
    await tick();
    const s = sessions[0]!;
    s.id = 'live-1';
    s.emit({
      type: 'session.init',
      sessionId: 'live-1',
      model: 'sonnet',
      cwd: '/p',
      permissionMode: 'default',
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: '2.1.285',
    });
    s.emit({ type: 'turn.start', at: 100 });
    s.emit({
      type: 'permission.request',
      toolUseId: 'perm-1',
      toolName: 'Edit',
      input: {},
      canAlwaysAllow: false,
      diff: { kind: 'edit', filePath: '/p/a.ts', oldText: 'b', newText: 'c', replaceAll: false },
    });
    s.emit({
      type: 'question.request',
      toolUseId: 'q-1',
      questions: [{ question: 'Какой?', options: [], multiSelect: false }],
    });
    s.emit({
      type: 'permission.request',
      toolUseId: 'perm-2',
      toolName: 'Bash',
      input: {},
      canAlwaysAllow: true,
    });
    s.emit({ type: 'permission.resolved', toolUseId: 'perm-2', decision: 'allow', by: 'user' });
    await tick();
    await tick();
    posted.length = 0;

    await controller.handle({ type: 'ready' }); // webview пересоздан
    await tick();
    await tick();
    const kinds = posted.map((m) =>
      m.type === 'agent.event'
        ? `event:${m.event.type}:${(m.event as { toolUseId?: string }).toolUseId ?? ''}`
        : m.type,
    );
    expect(kinds).toContain('session.history');
    expect(kinds).toContain('event:session.init:');
    expect(kinds).toContain('event:turn.start:');
    expect(kinds).toContain('event:permission.request:perm-1');
    expect(kinds).toContain('event:question.request:q-1');
    expect(kinds).not.toContain('event:permission.request:perm-2'); // уже закрыт
    expect(kinds).toContain('diff.preview');
    // история — раньше запросов: сброс ленты не должен съесть карточки
    expect(kinds.indexOf('session.history')).toBeLessThan(
      kinds.indexOf('event:permission.request:perm-1'),
    );
  });

  it('ready в первый раз у новой сессии ничего не пересевает', async () => {
    const { controller, posted } = setupResume();
    controller.start();
    await controller.handle({ type: 'ready' });
    await tick();
    expect(posted.some((m) => m.type === 'session.history')).toBe(false);
  });

  it('runCommand: команда боковой панели ждёт ready', async () => {
    const { controller, posted } = setupResume();
    controller.runCommand('status');
    expect(posted.some((m) => m.type === 'chat.command')).toBe(false);
    await controller.handle({ type: 'ready' });
    expect(posted.filter((m) => m.type === 'chat.command')).toHaveLength(1);
    controller.runCommand('status');
    expect(posted.filter((m) => m.type === 'chat.command')).toHaveLength(2);
  });

  it('setTitle меняет заголовок и шлёт session.title', async () => {
    const { controller, sessions, posted, deps } = setupResume({});
    controller.start();
    await tick();
    const s = sessions[0]!;
    s.id = 'n1';
    s.emit({
      type: 'session.init',
      sessionId: 'n1',
      model: 'm',
      cwd: '/p',
      permissionMode: 'default',
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: '1',
    });
    controller.setTitle('Новое имя');
    expect(deps.setTitle).toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'agent.event' && m.event.type === 'session.title')).toBe(
      true,
    );
  });
});

// ——— этап 7: ошибки, «Повторить ход», журнал ———

describe('ChatController: ошибки и повтор хода (этап 7)', () => {
  const initEvent = {
    type: 'session.init',
    sessionId: 'sess-1',
    model: 'sonnet',
    cwd: '/p',
    tools: [],
    permissionMode: 'default',
    slashCommands: [],
    skills: [],
    agents: [],
    apiKeySource: 'none',
    engineVersion: '2.1.285',
  } as unknown as AgentEvent;
  const okResult = {
    type: 'turn.result',
    ok: true,
    subtype: 'success',
    interrupted: false,
    durationMs: 1,
    apiDurationMs: 0,
    numTurns: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    totalCostUsd: 0.1,
    permissionDenials: [],
  } as unknown as AgentEvent;

  function build(over: Partial<ChatDeps> = {}) {
    const sessions: FakeSession[] = [];
    const resumed: string[] = [];
    const loadHistory = vi.fn(async (): Promise<SessionHistory> => ({
      events: [],
      turns: 0,
      skippedTurns: 0,
    }));
    const adapter = {
      id: 'fake',
      loadHistory,
      createSession: async () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
      resumeSession: async (id: string) => {
        resumed.push(id);
        const s = new FakeSession();
        s.id = id;
        sessions.push(s);
        return s;
      },
    } as unknown as AgentAdapter;
    const posted: ToWebview[] = [];
    const deps: ChatDeps = {
      adapter,
      cwd: '/p',
      project: 'p',
      post: (m) => posted.push(m),
      setTitle: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      settings: () => ({ allowBypass: false }),
      findFiles: async () => [],
      pickFiles: async () => [],
      readSelection: async () => undefined,
      listRecent: async () => [],
      showSessions: vi.fn(),
      showLogs: vi.fn(),
      ...over,
    };
    return { controller: new ChatController(deps), sessions, resumed, loadHistory, posted, deps };
  }

  /** Новая сессия: init, пользователь отправил промпт, движок упал посреди хода. */
  async function crashed() {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'почини табло' });
    t.sessions[0]!.emit({ type: 'error', fatal: true, message: 'ECONNRESET' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' });
    return t;
  }

  it('«Повторить ход»: resume упавшей сессии по запомненному id и тот же промпт ещё раз', async () => {
    const t = await crashed();
    // у новой сессии, упавшей до resume, `sessionId` после closed пуст — id помнится отдельно
    expect(t.controller.sessionId).toBeUndefined();
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.resumed).toEqual(['sess-1']);
    expect(t.loadHistory).toHaveBeenCalledWith('sess-1', '/p');
    expect(t.sessions[1]!.sent).toEqual(['почини табло']);
  });

  it('промпт успешного хода не повторяется: «Повторить» только возобновляет', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'привет' });
    t.sessions[0]!.emit(okResult);
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'упал' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.resumed).toEqual(['sess-1']);
    expect(t.sessions[1]!.sent).toEqual([]);
  });

  it('сессия, не дожившая до init: повтор — заново с тем же промптом', async () => {
    const t = build();
    t.controller.start();
    await tick();
    await t.controller.handle({ type: 'send', sessionId: '', text: 'привет' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'нет сети' });
    await t.controller.handle({ type: 'turn.retry', sessionId: '', turn: true });
    await tick();
    expect(t.resumed).toEqual([]);
    expect(t.sessions[1]!.sent).toEqual(['привет']);
  });

  it('«Возобновить сессию» (turn: false) после неудачного, но законченного хода промпт не шлёт', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'привет' });
    t.sessions[0]!.emit({ ...okResult, ok: false, subtype: 'error_max_turns' } as AgentEvent);
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'упал в покое' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: false });
    await tick();
    expect(t.resumed).toEqual(['sess-1']);
    expect(t.sessions[1]!.sent).toEqual([]);
  });

  it('«Повторить» на устаревшей карточке во время идущего хода ничего не делает', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'новый ход' });
    t.sessions[0]!.emit({ type: 'turn.start', at: 1, prompt: 'новый ход' } as AgentEvent);
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.resumed).toEqual([]);
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]!.sent).toEqual(['новый ход']);
  });

  it('упавшая сессия: строка списка `error`, после «Повторить» — снята', async () => {
    const live = { set: vi.fn(), delete: vi.fn() };
    const t = build({ live: live as unknown as ChatDeps['live'] });
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'упал' });
    expect(live.set).toHaveBeenLastCalledWith('sess-1', 'error');
    live.delete.mockClear();
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    expect(live.delete).toHaveBeenCalledWith('sess-1');
  });

  it('log.show открывает журнал', async () => {
    const t = build();
    await t.controller.handle({ type: 'log.show' });
    expect(t.deps.showLogs).toHaveBeenCalled();
  });

  it('журнал: строки контроллера с префиксом из 8 символов id, все события — debug, ошибки — error', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.id = 'abcdef12-3456-7890';
    t.sessions[0]!.emit({ ...initEvent, sessionId: 'abcdef12-3456-7890' } as AgentEvent);
    expect(t.deps.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^\[abcdef12\] session\.init/),
    );
    expect(t.deps.log.debug).toHaveBeenCalledWith('[abcdef12] ← session.init');
    t.sessions[0]!.emit({ type: 'text.delta', messageId: 'm', text: 'привет' });
    expect(t.deps.log.debug).toHaveBeenCalledWith('[abcdef12] ← text.delta 6 симв.');
    t.sessions[0]!.emit({ type: 'error', fatal: true, message: 'ECONNRESET' });
    expect(t.deps.log.error).toHaveBeenCalledWith('[abcdef12] error (fatal): ECONNRESET');
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' });
    expect(t.deps.log.error).toHaveBeenCalledWith('[abcdef12] session.closed: error — ECONNRESET');
  });

  it('журнал: до init префикс «новая»', async () => {
    const t = build();
    t.controller.start();
    await tick();
    expect(t.deps.log.info).toHaveBeenCalledWith('[новая] Сессия агента создана');
  });

  it('describeEvent: одна строка без текстов и результатов', () => {
    expect(
      describeEvent({ type: 'tool.start', toolUseId: 't', name: 'Edit', input: { a: 1 } }),
    ).toBe('tool.start Edit');
    expect(
      describeEvent({
        type: 'limit.update',
        source: 'engine',
        status: 'rejected',
        windows: [{ kind: 'five-hour', percent: 100 }],
      }),
    ).toBe('limit.update engine rejected five-hour 100%');
    expect(
      describeEvent({ type: 'text.delta', agentId: 'agent-12345678', messageId: 'm', text: 'abc' }),
    ).toBe('text.delta [агент agent-12] 3 симв.');
  });
});
