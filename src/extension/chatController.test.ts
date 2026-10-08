import { describe, expect, it, vi } from 'vitest';
import { EventHub } from '../agent/stream';
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  PlanDecision,
  PromptFile,
  PromptImage,
  SessionCapabilities,
  SessionHistory,
  SessionOptions,
} from '../agent/types';
import type { ToWebview } from '../protocol';
import { MAX_IMAGE_BASE64, MAX_IMAGES_PER_MESSAGE } from '../shared/images';

/** png 1×1 — хост сверяет формат по сигнатуре. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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
import { AgentsGraphLink } from './agentsGraphLink';
import type { AgentGraphView } from '../shared/agentsGraph';

class FakeSession implements AgentSession {
  readonly events = new EventHub<AgentEvent>();
  id = 'sess-1';
  sent: string[] = [];
  images: (readonly PromptImage[] | undefined)[] = [];
  files: (readonly PromptFile[] | undefined)[] = [];
  permissions: [string, string, string | undefined][] = [];
  modes: string[] = [];
  interrupts = 0;
  compacts = 0;
  disposed = false;
  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]) {
    this.sent.push(text);
    this.images.push(images);
    this.files.push(files);
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
  stopped: string[] = [];
  async stopTask(taskId: string) {
    this.stopped.push(taskId);
  }
  async contextUsage() {
    return undefined;
  }
  remotes: boolean[] = [];
  async setRemote(on: boolean) {
    this.remotes.push(on);
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

  it('defaultPermissionMode и defaultEffort применяются к новой сессии', async () => {
    const { controller, created, deps } = setup();
    deps.settings = () => ({
      allowBypass: false,
      defaultPermissionMode: 'acceptEdits',
      defaultEffort: 'high',
    });
    controller.start();
    await tick();
    expect(created[0]).toMatchObject({ permissionMode: 'acceptEdits', effort: 'high' });
  });

  it('session.defaults: webview, готовый позже создания сессии, получает режим и effort из настроек', async () => {
    const { controller, posted, deps } = setup();
    deps.settings = () => ({
      allowBypass: false,
      defaultPermissionMode: 'plan',
      defaultEffort: 'low',
    });
    controller.start();
    await tick();
    posted.length = 0;
    await controller.handle({ type: 'ready' });
    expect(posted).toContainEqual({ type: 'session.defaults', mode: 'plan', effort: 'low' });
  });

  it('defaultPermissionMode: manual — обычный режим; bypass без разрешения — тоже; мусорный effort не передаётся', async () => {
    const m = setup();
    m.deps.settings = () => ({
      allowBypass: false,
      defaultPermissionMode: 'manual',
      defaultEffort: '',
    });
    m.controller.start();
    await tick();
    expect(m.created[0]).toMatchObject({ permissionMode: 'default' });
    expect(m.created[0]).not.toHaveProperty('effort');

    const b = setup();
    b.deps.settings = () => ({
      allowBypass: false,
      defaultPermissionMode: 'bypassPermissions',
      defaultEffort: 'ultra',
    });
    b.controller.start();
    await tick();
    expect(b.created[0]).toMatchObject({ permissionMode: 'default' });
    expect(b.created[0]).not.toHaveProperty('effort');

    const c = setup();
    c.deps.settings = () => ({ allowBypass: true, defaultPermissionMode: 'bypassPermissions' });
    c.controller.start();
    await tick();
    expect(c.created[0]).toMatchObject({ permissionMode: 'bypassPermissions' });
  });

  it('pushInfo: после смены настроек вкладка получает свежие allowBypass и пороги', async () => {
    const { controller, posted, deps } = setup();
    await controller.handle({ type: 'ready' });
    posted.length = 0;
    deps.settings = () => ({ allowBypass: true, contextThresholds: [10, 20] });
    controller.pushInfo();
    expect(posted).toEqual([
      expect.objectContaining({
        type: 'chat.info',
        allowBypass: true,
        contextThresholds: [10, 20],
      }),
    ]);
  });

  it('pushInfo: вид ленты из настроек уходит в chat.info', async () => {
    const { controller, posted, deps } = setup();
    await controller.handle({ type: 'ready' });
    posted.length = 0;
    deps.settings = () => ({ allowBypass: false, feedStyle: 'cards' });
    controller.pushInfo();
    expect(posted).toEqual([expect.objectContaining({ type: 'chat.info', feedStyle: 'cards' })]);
  });

  it('pushInfo: раскладка поля ввода из настроек уходит в chat.info', async () => {
    const { controller, posted, deps } = setup();
    await controller.handle({ type: 'ready' });
    posted.length = 0;
    deps.settings = () => ({ allowBypass: false, composerLayout: 'shell' });
    controller.pushInfo();
    expect(posted).toEqual([expect.objectContaining({ type: 'chat.info', composerLayout: 'shell' })]);
  });

  it('pushInfo: вид вкладки «агенты» из настроек уходит в chat.info', async () => {
    const { controller, posted, deps } = setup();
    await controller.handle({ type: 'ready' });
    posted.length = 0;
    deps.settings = () => ({ allowBypass: false, agentsView: 'lanes' });
    controller.pushInfo();
    expect(posted).toEqual([expect.objectContaining({ type: 'chat.info', agentsView: 'lanes' })]);
  });

  it('pushInfo: раскладка вкладки «git» из настроек уходит в chat.info', async () => {
    const { controller, posted, deps } = setup();
    await controller.handle({ type: 'ready' });
    posted.length = 0;
    deps.settings = () => ({ allowBypass: false, gitLayout: 'unified' });
    controller.pushInfo();
    expect(posted).toEqual([expect.objectContaining({ type: 'chat.info', gitLayout: 'unified' })]);
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
    expect(titles).toContain('● Новая сессия');
    expect(titles.at(-1)).toBe('● мигание');
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
    expect(titles.at(-1)).toBe('мигание');
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

  it('diff.changes: один файл — openDiff (before первой, after последней), несколько — openChanges', async () => {
    const { controller, sessions, deps } = setup();
    const opened: OpenDiff[] = [];
    const multi: { title: string; files: OpenDiff[] }[] = [];
    deps.openDiff = async (d) => void opened.push(d);
    deps.openChanges = async (title, files) => void multi.push({ title, files });
    controller.start();
    await tick();
    const s = sessions[0]!;
    const write = (id: string, file: string, before: string | null, content: string) => {
      const input = { file_path: file, content };
      s.emit({ type: 'tool.start', toolUseId: id, name: 'Write', input });
      s.emit({
        type: 'tool.result',
        toolUseId: id,
        isError: false,
        content: 'ok',
        result: {
          type: before === null ? 'create' : 'update',
          filePath: file,
          content,
          originalFile: before,
        },
      });
    };
    write('w1', '/p/f.ts', 'v0', 'v1');
    write('w2', '/p/g.ts', 'g0', 'g1');
    write('w3', '/p/f.ts', 'v1', 'v2');

    await controller.handle({ type: 'diff.changes', sessionId: '', toolUseIds: ['w1', 'w3'] });
    expect(multi).toHaveLength(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      key: 'changes-w1-w3',
      filePath: '/p/f.ts',
      before: 'v0',
      after: 'v2',
      stage: 'applied',
    });

    await controller.handle({
      type: 'diff.changes',
      sessionId: '',
      toolUseIds: ['w1', 'w2', 'w3', 'нет'],
    });
    expect(opened).toHaveLength(1);
    expect(multi).toHaveLength(1);
    expect(multi[0]!.files.map((f) => [f.filePath, f.before, f.after])).toEqual([
      ['/p/f.ts', 'v0', 'v2'],
      ['/p/g.ts', 'g0', 'g1'],
    ]);
    expect(deps.log.warn).toHaveBeenCalled();

    // файл создан Write и потом правлен Edit: слева пусто, справа — после Edit
    write('c1', '/p/n.ts', null, 'a\n');
    const edit = (id: string, file: string, result: Record<string, unknown>) => {
      const input = { file_path: file, old_string: 'a', new_string: 'b' };
      s.emit({ type: 'tool.start', toolUseId: id, name: 'Edit', input });
      s.emit({ type: 'tool.result', toolUseId: id, isError: false, content: 'ok', result });
    };
    edit('c2', '/p/n.ts', { filePath: '/p/n.ts', originalFile: 'a\n', oldString: 'a', newString: 'b' });
    // фрагмент (правка без исходного файла) с целыми сторонами не склеивается
    edit('c3', '/p/n.ts', { filePath: '/p/n.ts', oldString: 'b', newString: 'c' });
    // правка с ошибкой в this.edits не попадает
    s.emit({ type: 'tool.start', toolUseId: 'c4', name: 'Edit', input: { file_path: '/p/n.ts' } });
    s.emit({ type: 'tool.result', toolUseId: 'c4', isError: true, content: 'no match' });
    await controller.handle({
      type: 'diff.changes',
      sessionId: '',
      toolUseIds: ['c1', 'c2', 'c3', 'c4'],
    });
    expect(opened.at(-1)).toMatchObject({ key: 'changes-c1-c2', before: '', after: 'b\n' });
    // одни фрагменты — последний сам по себе
    await controller.handle({ type: 'diff.changes', sessionId: '', toolUseIds: ['c3'] });
    expect(opened.at(-1)).toMatchObject({ key: 'changes-c3-c3', before: 'b', after: 'c' });

    // длинная сессия: ранние правки вытеснены из сторон (MAX_EDITS), дифф за сессию всё равно от первой
    const many = Array.from({ length: 70 }, (_, i) => `m${i}`);
    many.forEach((id, i) => write(id, '/p/long.ts', i === 0 ? null : `L${i}`, `L${i + 1}`));
    await controller.handle({ type: 'diff.changes', sessionId: '', toolUseIds: many });
    expect(opened.at(-1)).toMatchObject({ key: 'changes-m0-m69', before: '', after: 'L70' });
    // охват «ход» — свежие правки: before — первой из них
    await controller.handle({ type: 'diff.changes', sessionId: '', toolUseIds: many.slice(65) });
    expect(opened.at(-1)).toMatchObject({ key: 'changes-m65-m69', before: 'L65', after: 'L70' });
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

  it('remote.set доходит до сессии; выключение без сессии движок не поднимает', async () => {
    const { controller, sessions } = setup();
    await controller.handle({ type: 'remote.set', on: false });
    expect(sessions).toHaveLength(0);
    await controller.handle({ type: 'remote.set', sessionId: '', on: true });
    await controller.handle({ type: 'remote.set', on: false });
    expect(sessions[0]!.remotes).toEqual([true, false]);
  });

  it('выбор rc во вкладке переживает новую сессию (/clear) и перекрывает настройку', async () => {
    const { controller, sessions, deps } = setup();
    controller.start();
    await tick();
    await controller.handle({ type: 'remote.set', on: true });
    await controller.handle({ type: 'session.new' });
    await controller.handle({ type: 'send', sessionId: '', text: 'hi' });
    await tick();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.remotes).toEqual([true]);
    // выключили руками — настройка «вкл» новую сессию вкладки больше не включает
    deps.settings = () => ({ allowBypass: false, remoteControl: true });
    await controller.handle({ type: 'remote.set', on: false });
    await controller.handle({ type: 'session.new' });
    await controller.handle({ type: 'send', sessionId: '', text: 'hi' });
    await tick();
    expect(sessions[2]!.remotes).toEqual([]);
  });

  it('agentura.remoteControl: новая сессия Claude включает Remote Control сама', async () => {
    const { controller, sessions, deps } = setup();
    deps.settings = () => ({ allowBypass: false, remoteControl: true });
    controller.start();
    await tick();
    expect(sessions[0]!.remotes).toEqual([true]);
  });

  it('remote.state уходит в webview как событие агента', async () => {
    const { controller, sessions, posted } = setup();
    controller.start();
    await tick();
    sessions[0]!.emit({ type: 'remote.state', state: 'on', url: 'https://claude.ai/code/cse_1' });
    expect(posted).toContainEqual({
      type: 'agent.event',
      sessionId: 'sess-1',
      event: { type: 'remote.state', state: 'on', url: 'https://claude.ai/code/cse_1' },
    });
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

  it('на движке Antigravity вместо лимитов Claude уходит квота agy (quota.update)', async () => {
    const { posted, deps } = setup();
    const rows = [{ label: 'Gemini', remaining: 20 }];
    const agy = vi.fn(async () => ({ rows, updatedAt: 5 }));
    const refresh = vi.fn(async () => snap);
    const agyController = new ChatController({ ...deps, provider: 'antigravity', usage: { refresh }, agyQuota: { refresh: agy } });
    agyController.start();
    await agyController.handle({ type: 'ready' });
    await tick();
    expect(posted).toContainEqual({ type: 'quota.update', rows, updatedAt: 5 });
    expect(refresh).not.toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'limits.update')).toBe(false);
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

describe('ChatController: долг разрешений (этап 6 roadmap 0.2)', () => {
  const edit = (filePath: string) => ({
    type: 'permission.request' as const,
    toolUseId: 'e1',
    toolName: 'Edit',
    input: { file_path: filePath },
    canAlwaysAllow: false,
    diff: { kind: 'edit' as const, filePath, oldText: 'b', newText: 'c', replaceAll: false },
  });

  it('относительный file_path: превью читает файл от cwd сессии, а не процесса', async () => {
    const t = setup();
    const read = vi.fn(async () => 'a\nb\n');
    t.deps.readText = read;
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(edit('src/a.ts'));
    await tick();
    expect(read).toHaveBeenCalledWith('/p/src/a.ts');
    const opened: OpenDiff[] = [];
    t.deps.openDiff = async (d) => void opened.push(d);
    await t.controller.handle({ type: 'diff.open', sessionId: '', toolUseId: 'e1' });
    expect(opened[0]).toMatchObject({ filePath: '/p/src/a.ts', stage: 'proposed' });
  });

  it('автосохранение: файл сохраняется, когда человек разрешил правку, а не когда показана карточка; отказ не сохраняет', async () => {
    const t = setup();
    const saved: string[] = [];
    t.deps.readText = async () => 'a\nb\n';
    t.deps.saveFile = async (p) => void saved.push(p);
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    s.emit(edit('rel/f.ts'));
    await tick();
    expect(saved).toEqual([]); // карточка показана, решения ещё нет
    await t.controller.handle({
      type: 'permission.respond',
      sessionId: '',
      toolUseId: 'e1',
      decision: 'deny',
    });
    expect(saved).toEqual([]);
    expect(s.permissions).toEqual([['e1', 'deny', undefined]]);
    await t.controller.handle({
      type: 'permission.respond',
      sessionId: '',
      toolUseId: 'e1',
      decision: 'allow',
    });
    expect(saved).toEqual(['/p/rel/f.ts']);
    expect(s.permissions.at(-1)).toEqual(['e1', 'allow', undefined]);
  });

  it('автосохранение: запрос не на правку (Bash) файлов не трогает; сбой сохранения ответ не блокирует', async () => {
    const t = setup();
    const saveFile = vi.fn(async () => {
      throw new Error('диск');
    });
    t.deps.saveFile = saveFile;
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    s.emit({
      type: 'permission.request',
      toolUseId: 'b1',
      toolName: 'Bash',
      input: { command: 'ls' },
      canAlwaysAllow: false,
    });
    await t.controller.handle({
      type: 'permission.respond',
      sessionId: '',
      toolUseId: 'b1',
      decision: 'allow',
    });
    expect(saveFile).not.toHaveBeenCalled();
    s.emit(edit('/p/x.ts'));
    await t.controller.handle({
      type: 'permission.respond',
      sessionId: '',
      toolUseId: 'e1',
      decision: 'allow',
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(s.permissions.at(-1)).toEqual(['e1', 'allow', undefined]);
  });
});

describe('ChatController: лимиты API на сессию (этап 6 roadmap 0.2)', () => {
  const pdfOf = (pages: number) =>
    Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n%%EOF`).toString(
      'base64',
    );
  const pdf = (pages: number, path = `d${pages}.pdf`) => ({
    kind: 'pdf' as const,
    path,
    data: pdfOf(pages),
    size: 100,
    pages,
  });
  const attachMsgs = (posted: ToWebview[]) =>
    posted.filter(
      (m): m is Extract<ToWebview, { type: 'session.attach' }> => m.type === 'session.attach',
    );

  it('два pdf по 60 страниц в разных ходах: второй отброшен (100 страниц на запрос со всей историей)', async () => {
    const t = setup();
    t.controller.start();
    await tick();
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'один',
      files: [pdf(60, 'a.pdf')],
    });
    expect(t.sessions[0]!.files[0]).toHaveLength(1);
    expect(attachMsgs(t.posted).at(-1)).toMatchObject({ pdfPages: 60 });
    const before = attachMsgs(t.posted).length;
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'два',
      files: [pdf(60, 'b.pdf')],
    });
    expect(t.sessions[0]!.sent).toEqual(['один', 'два']);
    expect(t.sessions[0]!.files[1]).toBeUndefined(); // текст ушёл, pdf — нет
    expect(t.deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('sessionPages'));
    // webview прибавил 60 страниц заранее — хост возвращает точный счёт и для отброшенного вложения
    expect(attachMsgs(t.posted)).toHaveLength(before + 1);
    expect(attachMsgs(t.posted).at(-1)).toMatchObject({ pdfPages: 60 });
    // небольшой pdf в пределах остатка проходит
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'три',
      files: [pdf(40, 'c.pdf')],
    });
    expect(t.sessions[0]!.files[2]).toHaveLength(1);
    expect(attachMsgs(t.posted).at(-1)).toMatchObject({ pdfPages: 100 });
  });

  it('два сообщения по 15 МБ base64: второе отброшено по размеру тела запроса (24 МБ на сессию)', async () => {
    const t = setup();
    t.controller.start();
    await tick();
    const big = `iVBORw0KGgo${'A'.repeat(4 * 1024 * 1024 - 11)}`; // < 5 МБ на картинку
    const images = Array.from({ length: 3 }, () => ({
      mediaType: 'image/png' as const,
      data: big,
    }));
    await t.controller.handle({ type: 'send', sessionId: '', text: 'первые', images }); // 12 МБ
    await t.controller.handle({ type: 'send', sessionId: '', text: 'вторые', images }); // ещё 12 МБ — впритык
    expect(t.sessions[0]!.images[1]).toHaveLength(3);
    await t.controller.handle({ type: 'send', sessionId: '', text: 'третьи', images });
    expect(t.sessions[0]!.images[2]).toBeUndefined();
    expect(t.deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('session'));
  });

  it('компакция сбрасывает счёт: после compaction.end pdf снова принимаются', async () => {
    const t = setup();
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'один',
      files: [pdf(90, 'a.pdf')],
    });
    s.emit({ type: 'compaction.end', ok: true, preTokens: 100, postTokens: 10 });
    expect(attachMsgs(t.posted).at(-1)).toEqual({ type: 'session.attach', pdfPages: 0, chars: 0 });
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'два',
      files: [pdf(90, 'b.pdf')],
    });
    expect(s.files[1]).toHaveLength(1);
  });

  it('неудачная компакция счёт не трогает', async () => {
    const t = setup();
    t.controller.start();
    await tick();
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'один',
      files: [pdf(90, 'a.pdf')],
    });
    t.sessions[0]!.emit({ type: 'compaction.end', ok: false });
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'два',
      files: [pdf(90, 'b.pdf')],
    });
    expect(t.sessions[0]!.files[1]).toBeUndefined();
  });

  it('resume: счёт берётся из истории сессии (attach) и уходит в webview вместе с ней', async () => {
    const sessions: FakeSession[] = [];
    const adapter = {
      id: 'fake',
      loadHistory: async (): Promise<SessionHistory> => ({
        events: [],
        turns: 2,
        skippedTurns: 0,
        attach: { pdfPages: 70, chars: 1000 },
      }),
      createSession: async () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
      resumeSession: async (id: string) => {
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
    };
    const controller = new ChatController(deps);
    await controller.handle({ type: 'ready' });
    await controller.resume('s-old');
    await tick();
    expect(attachMsgs(posted).at(-1)).toEqual({
      type: 'session.attach',
      pdfPages: 70,
      chars: 1000,
    });
    await controller.handle({ type: 'send', sessionId: 's-old', text: 'ещё', files: [pdf(40)] });
    expect(sessions.at(-1)!.files[0]).toBeUndefined(); // 70 + 40 > 100
    await controller.handle({ type: 'send', sessionId: 's-old', text: 'мало', files: [pdf(30)] });
    expect(sessions.at(-1)!.files[1]).toHaveLength(1);
  });

  it('текст файлов — не больше 70 % свободного окна модели: лишний файл отброшен', async () => {
    const t = setup();
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    // окно 200k, занято 160k → вложениям 70 % свободных 40k токенов = 28k ≈ 112k символов
    s.emit({
      type: 'context.usage',
      usedTokens: 160_000,
      maxTokens: 200_000,
      source: 'engine',
    });
    const file = (path: string, chars: number) => ({
      kind: 'text' as const,
      path,
      data: 'x'.repeat(chars),
      size: chars,
    });
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'файлы',
      files: [file('a.txt', 60_000), file('b.txt', 60_000)], // 15k + 15k токенов > 28k
    });
    expect(s.files[0]!.map((f) => f.path)).toEqual(['a.txt']);
    expect(t.deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('context'));
  });

  it('окно ещё неизвестно (движок не прислал context.usage) — хост окном не режет, проверка за webview', async () => {
    const t = setup();
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    const file = (path: string) => ({
      kind: 'text' as const,
      path,
      data: 'x'.repeat(250_000),
      size: 250_000,
    });
    // ≈ 250k токенов — больше 70 % окна 200k по умолчанию, но у сессии после resume окно может быть 1M
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'файлы',
      files: [file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt')],
    });
    expect(s.files[0]).toHaveLength(4);
  });
});

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

  it('resume: defaultPermissionMode и defaultEffort не применяются (режим — из истории, effort — движка)', async () => {
    const { controller, resumed, posted } = setupResume({
      resumeId: 's-old',
      settings: () => ({
        allowBypass: false,
        defaultPermissionMode: 'acceptEdits',
        defaultEffort: 'high',
      }),
    });
    controller.start();
    await tick();
    await tick();
    expect(resumed[0]![1]).toMatchObject({ permissionMode: 'plan' });
    expect(resumed[0]![1]).not.toHaveProperty('effort');
    expect(posted.some((m) => m.type === 'session.defaults')).toBe(false);
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
    expect(openSession).toHaveBeenCalledWith('other', 'claude');
    await controller.handle({ type: 'session.resume', sessionId: 'cx', provider: 'codex' });
    expect(openSession).toHaveBeenLastCalledWith('cx', 'codex');
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

  it('пересев при идущем ходе: события во время чтения транскрипта — после истории, без дублей и без потерь', async () => {
    const { controller, sessions, posted, loadHistory } = setupResume();
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
    s.emit({ type: 'turn.start', at: 100, prompt: 'сделай' });
    // ответ m0 пишется: его дельты до пересева в транскрипте ещё нет
    s.emit({ type: 'text.delta', messageId: 'm0', text: 'Начинаю' });
    await tick();
    // транскрипт к моменту чтения: ход открыт, m1 и вызов t1 уже записаны
    const transcript: AgentEvent[] = [
      { type: 'turn.start', prompt: 'сделай', at: 100 },
      { type: 'text.delta', messageId: 'm1', text: 'Смотрю.' },
      { type: 'tool.start', toolUseId: 't1', name: 'Bash', input: {} },
      { type: 'tool.result', toolUseId: 't1', isError: false, content: 'ok' },
    ];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    loadHistory.mockImplementation(async () => {
      await gate; // искусственная задержка чтения транскрипта
      return { events: transcript, turns: 1, skippedTurns: 0 };
    });
    posted.length = 0;

    await controller.handle({ type: 'ready' }); // webview пересоздан
    await tick();
    // пока читаем: часть уже в транскрипте (m1, t1), часть — нет
    s.emit({ type: 'text.delta', messageId: 'm0', text: ' работу' });
    s.emit({ type: 'text.delta', messageId: 'm1', text: 'Смотрю.' });
    s.emit({ type: 'tool.start', toolUseId: 't1', name: 'Bash', input: {} });
    s.emit({ type: 'tool.result', toolUseId: 't1', isError: false, content: 'ok' });
    s.emit({ type: 'text.delta', messageId: 'm2', text: 'Готово' });
    s.emit({ type: 'tool.start', toolUseId: 't2', name: 'Bash', input: {} });
    expect(posted.some((m) => m.type === 'agent.event')).toBe(false);
    release();
    await tick();
    await tick();

    const kinds = posted.map((m) =>
      m.type === 'agent.event'
        ? `${m.event.type}:${(m.event as { toolUseId?: string; messageId?: string }).toolUseId ?? (m.event as { messageId?: string }).messageId ?? ''}`
        : m.type,
    );
    const at = kinds.indexOf('session.history');
    expect(at).toBeGreaterThanOrEqual(0);
    const after = kinds.slice(at + 1).filter((k) => /^(text|tool)/.test(k));
    expect(after).toEqual(['text.delta:m0', 'text.delta:m0', 'text.delta:m2', 'tool.start:t2']);
    const m0 = posted
      .filter(
        (m): m is Extract<ToWebview, { type: 'agent.event' }> =>
          m.type === 'agent.event' && m.event.type === 'text.delta' && m.event.messageId === 'm0',
      )
      .map((m) => (m.event as { text: string }).text)
      .join('');
    expect(m0).toBe('Начинаю работу');

    // после пересева — снова напрямую
    posted.length = 0;
    s.emit({ type: 'tool.result', toolUseId: 't2', isError: false, content: 'ok' });
    expect(kinds.length).toBeGreaterThan(0);
    expect(posted.map((m) => m.type)).toEqual(['agent.event']);
  });

  it('пересев: карточка, пришедшая пока читали транскрипт, и ждущая из снимка — после истории; ответ на неё доходит движку', async () => {
    const { controller, sessions, posted, loadHistory } = setupResume();
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
    s.emit({ type: 'turn.start', at: 100, prompt: 'сделай' });
    const ask = {
      type: 'permission.request' as const,
      toolUseId: 'p-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      canAlwaysAllow: false,
    };
    s.emit(ask); // ждала до пересева: попадёт в снимок
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    loadHistory.mockImplementation(async () => {
      await gate;
      return {
        events: [{ type: 'turn.start', prompt: 'сделай', at: 100 }],
        turns: 1,
        skippedTurns: 0,
      };
    });
    posted.length = 0;
    await controller.handle({ type: 'ready' });
    await tick();
    s.emit({ ...ask, toolUseId: 'p-2' }); // пришла во время чтения: в буфер
    release();
    await tick();
    await tick();
    const ids = posted.map((m) =>
      m.type === 'agent.event' && m.event.type === 'permission.request'
        ? m.event.toolUseId
        : m.type === 'session.history'
          ? 'history'
          : '',
    );
    const h = ids.indexOf('history');
    // обе карточки — после истории; p-1 может прийти и снимком, и из буфера — webview дедупит по toolUseId
    expect(ids.indexOf('p-1')).toBeGreaterThan(h);
    expect(ids.indexOf('p-2')).toBeGreaterThan(h);
    await controller.handle({
      type: 'permission.respond',
      sessionId: 'live-1',
      toolUseId: 'p-1',
      decision: 'allow',
    });
    expect(s.permissions).toEqual([['p-1', 'allow', undefined]]);
  });

  it('два пересева подряд: первый, дочитавший позже, не затирает второй; события обоих не теряются', async () => {
    const { controller, sessions, posted, loadHistory } = setupResume();
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
    s.emit({ type: 'turn.start', at: 100, prompt: 'сделай' });
    await tick();
    const gates: (() => void)[] = [];
    loadHistory.mockImplementation(async () => {
      await new Promise<void>((r) => gates.push(r));
      return {
        events: [{ type: 'turn.start', prompt: 'сделай', at: 100 }],
        turns: 1,
        skippedTurns: 0,
      };
    });
    posted.length = 0;
    await controller.handle({ type: 'ready' }); // пересев A
    await tick();
    s.emit({ type: 'tool.start', toolUseId: 'a1', name: 'Bash', input: {} });
    await controller.handle({ type: 'ready' }); // пересев B, пока A читает
    await tick();
    s.emit({ type: 'tool.start', toolUseId: 'b1', name: 'Bash', input: {} });
    expect(gates).toHaveLength(2);
    gates[1]!(); // B дочитал первым
    await tick();
    await tick();
    gates[0]!(); // A — позже
    await tick();
    await tick();
    const kinds = posted.map((m) =>
      m.type === 'agent.event'
        ? `${m.event.type}:${(m.event as { toolUseId?: string }).toolUseId ?? ''}`
        : m.type,
    );
    expect(kinds.filter((k) => k === 'session.history')).toHaveLength(1);
    const at = kinds.indexOf('session.history');
    expect(kinds.slice(at + 1).filter((k) => k.startsWith('tool.start'))).toEqual([
      'tool.start:a1',
      'tool.start:b1',
    ]);
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

  it('syncTitle: название из списка (ai-title) — во вкладку, повтор ничего не шлёт', () => {
    const { controller, posted, deps } = setupResume({});
    controller.syncTitle('VS Code вкладки API');
    expect(deps.setTitle).toHaveBeenLastCalledWith('VS Code вкладки API');
    const calls = vi.mocked(deps.setTitle).mock.calls.length;
    const sent = posted.length;
    controller.syncTitle('VS Code вкладки API');
    expect(deps.setTitle).toHaveBeenCalledTimes(calls);
    expect(posted).toHaveLength(sent);
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
    const resumeOptions: Record<string, unknown>[] = [];
    const retryPoint = vi.fn(
      async (): Promise<{ keepUuid: string; promptUuid: string } | undefined> => ({
        keepUuid: 'keep-1',
        promptUuid: 'prompt-1',
      }),
    );
    const loadHistory = vi.fn(async (): Promise<SessionHistory> => ({
      events: [],
      turns: 0,
      skippedTurns: 0,
    }));
    const adapter = {
      id: 'fake',
      loadHistory,
      retryPoint,
      createSession: async () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
      resumeSession: async (id: string, o: Record<string, unknown>) => {
        resumed.push(id);
        resumeOptions.push(o);
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
    return {
      controller: new ChatController(deps),
      sessions,
      resumed,
      resumeOptions,
      retryPoint,
      loadHistory,
      posted,
      deps,
    };
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

  it('«Повторить ход» повторяет и картинки сообщения', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    const images = [{ mediaType: 'image/png' as const, data: PNG, width: 10, height: 10 }];
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'что тут?', images });
    t.sessions[0]!.emit({ type: 'error', fatal: true, message: 'ECONNRESET' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.sessions[1]!.sent).toEqual(['что тут?']);
    expect(t.sessions[1]!.images).toEqual([images]);
  });

  it('«Повторить ход» повторяет и файлы сообщения (этап 8)', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    const files = [{ kind: 'text' as const, path: 'a.txt', data: 'abc', size: 3 }];
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'глянь', files });
    t.sessions[0]!.emit({ type: 'error', fatal: true, message: 'ECONNRESET' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.sessions[1]!.sent).toEqual(['глянь']);
    expect(t.sessions[1]!.files).toEqual([files]);
  });

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

  /** Ход начался (turn.start с промптом) и оборвался: упал движок. */
  async function interrupted(t: ReturnType<typeof build>, text = 'почини табло') {
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text });
    t.sessions[0]!.emit({ type: 'turn.start', at: 1, prompt: text } as AgentEvent);
    t.sessions[0]!.emit({ type: 'error', fatal: true, message: 'ECONNRESET' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' });
  }

  it('«Повторить»: оборванный ход отбрасывается при возобновлении (resumeSessionAt), в ленте его промпта нет, промпт уходит один раз', async () => {
    const t = build();
    await interrupted(t);
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.retryPoint).toHaveBeenCalledWith('sess-1', '/p', 'почини табло');
    expect(t.resumeOptions[0]).toMatchObject({
      dropTurn: { keepUuid: 'keep-1', promptUuid: 'prompt-1' },
    });
    expect(t.loadHistory).toHaveBeenCalledWith('sess-1', '/p', { stopBefore: 'prompt-1' });
    expect(t.sessions[1]!.sent).toEqual(['почини табло']);
  });

  it('«Повторить»: нет точки отката (чужие сообщения после промпта, ход первый) — возобновление целиком, как раньше', async () => {
    const t = build();
    t.retryPoint.mockResolvedValue(undefined);
    await interrupted(t);
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.resumeOptions[0]).not.toHaveProperty('dropTurn');
    expect(t.loadHistory).toHaveBeenLastCalledWith('sess-1', '/p');
    expect(t.sessions[1]!.sent).toEqual(['почини табло']);
  });

  it('«Повторить»: сообщение, которое движок ещё не начал, не отбрасывает ничего (его может не быть в транскрипте)', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'не начато' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'упал' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.retryPoint).not.toHaveBeenCalled();
    expect(t.resumeOptions[0]).not.toHaveProperty('dropTurn');
  });

  it('SDK отказал в отбрасывании («Resume rejected»): сразу повтор без него, промпт не теряется, повторно не отбрасывается', async () => {
    const t = build();
    await interrupted(t);
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.sessions).toHaveLength(2);
    // движок возобновил с отбрасыванием и отказал на первом сообщении
    t.sessions[1]!.emit({
      type: 'error',
      fatal: true,
      message:
        'Claude Code returned an error result: Resume rejected by --resume-drops-turn: resuming at x would discard entries not attributable',
    });
    await tick();
    await tick();
    expect(t.resumeOptions).toHaveLength(2);
    expect(t.resumeOptions[0]).toHaveProperty('dropTurn');
    expect(t.resumeOptions[1]).not.toHaveProperty('dropTurn');
    expect(t.sessions[2]!.sent).toEqual(['почини табло']);
    // третьего захода нет: отказ запомнен
    t.sessions[2]!.emit({ type: 'turn.start', at: 2, prompt: 'почини табло' } as AgentEvent);
    t.sessions[2]!.emit({ type: 'session.closed', reason: 'error', message: 'снова' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.resumeOptions[2]).not.toHaveProperty('dropTurn');
  });

  it('отказ SDK только итогом хода (`error_during_execution` с errors) посреди хода — повтор без отбрасывания после итога', async () => {
    const t = build();
    await interrupted(t);
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    // маппер открывает ход по очереди промптов и закрывает его итогом с ошибкой отказа
    t.sessions[1]!.emit({ type: 'turn.start', at: 2, prompt: 'почини табло' } as AgentEvent);
    await tick();
    expect(t.resumeOptions).toHaveLength(1);
    t.sessions[1]!.emit({
      type: 'turn.result',
      ok: false,
      subtype: 'error_during_execution',
      durationMs: 1,
      errors: ['Resume rejected by --resume-drops-turn: resuming at x would discard entries'],
    } as AgentEvent);
    await tick();
    await tick();
    expect(t.resumeOptions).toHaveLength(2);
    expect(t.resumeOptions[1]).not.toHaveProperty('dropTurn');
    expect(t.sessions[2]!.sent).toEqual(['почини табло']);
  });

  it('ход-пробуждение без промпта не забирает сообщение из очереди: его успешный итог не мешает повтору', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'моё' });
    // фоновая задача разбудила движок раньше, чем он взял сообщение
    t.sessions[0]!.emit({ type: 'turn.start', at: 1 } as AgentEvent);
    t.sessions[0]!.emit({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      durationMs: 1,
    } as AgentEvent);
    t.sessions[0]!.emit({ type: 'turn.start', at: 2, prompt: 'моё' } as AgentEvent);
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'обрыв' });
    t.retryPoint.mockResolvedValue(undefined);
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.sessions[1]!.sent).toEqual(['моё']);
  });

  it('inflight — очередь: два сообщения, упавшие вместе, «Повторить» шлёт оба по порядку', async () => {
    const t = build();
    t.controller.start();
    await tick();
    t.sessions[0]!.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'первое' });
    t.sessions[0]!.emit({ type: 'turn.start', at: 1, prompt: 'первое' } as AgentEvent);
    // во время хода отправлено второе — движок поставил его в очередь, отдельным ходом оно ещё не шло
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'второе' });
    t.sessions[0]!.emit({ type: 'error', fatal: true, message: 'ECONNRESET' });
    t.sessions[0]!.emit({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.resumed).toEqual(['sess-1']);
    expect(t.sessions[1]!.sent).toEqual(['первое', 'второе']);
  });

  it('inflight: успешный итог снимает начатое сообщение, ждущее остаётся; влитое в ход (turn.input) — тоже снято', async () => {
    const t = build();
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    s.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'А' });
    s.emit({ type: 'turn.start', at: 1, prompt: 'А' } as AgentEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'Б' });
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'В' });
    s.emit({ type: 'turn.input', at: 2, prompt: 'Б' } as AgentEvent);
    s.emit(okResult); // закрыл ход с А и влитым Б; В ещё в очереди
    s.emit({ type: 'error', fatal: true, message: 'упал' });
    s.emit({ type: 'session.closed', reason: 'error', message: 'упал' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.sessions[1]!.sent).toEqual(['В']);
  });

  it('inflight: упавший законченный ход не повторяется вместе с новым сообщением', async () => {
    const t = build();
    t.controller.start();
    await tick();
    const s = t.sessions[0]!;
    s.emit(initEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'старое' });
    s.emit({ type: 'turn.start', at: 1, prompt: 'старое' } as AgentEvent);
    s.emit({ ...okResult, ok: false, subtype: 'error_max_turns' } as AgentEvent);
    await t.controller.handle({ type: 'send', sessionId: 'sess-1', text: 'новое' });
    s.emit({ type: 'error', fatal: true, message: 'упал' });
    s.emit({ type: 'session.closed', reason: 'error', message: 'упал' });
    await t.controller.handle({ type: 'turn.retry', sessionId: 'sess-1', turn: true });
    await tick();
    expect(t.sessions[1]!.sent).toEqual(['новое']);
  });

  it('settings.open открывает вкладку настроек', async () => {
    const openSettings = vi.fn();
    const t = build({ openSettings });
    await t.controller.handle({ type: 'settings.open' });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('claude не найден: движок не стартует, в ленте карточка с кодом engine_missing', async () => {
    const t = build({
      engine: {
        ready: async () => ({ ok: false as const, problem: 'Не найден Claude Code' }),
      },
    });
    t.controller.start();
    await tick();
    expect(t.sessions).toHaveLength(0);
    expect(t.posted).toContainEqual(
      expect.objectContaining({
        type: 'agent.event',
        event: expect.objectContaining({
          type: 'error',
          fatal: true,
          code: 'engine_missing',
          message: 'Не найден Claude Code',
        }),
      }),
    );
  });

  it('claude найден позже: «Повторить» поднимает движок', async () => {
    let ok = false;
    const t = build({
      engine: {
        ready: async () => (ok ? { ok: true as const } : { ok: false as const, problem: 'нет' }),
      },
    });
    t.controller.start();
    await tick();
    expect(t.sessions).toHaveLength(0);
    ok = true;
    await t.controller.handle({ type: 'turn.retry', sessionId: '', turn: false });
    await tick();
    expect(t.sessions).toHaveLength(1);
  });

  it('сессию заменили, пока шёл поиск claude: старое поколение движок не спавнит', async () => {
    const waiting: (() => void)[] = [];
    const t = build({
      engine: {
        ready: () =>
          new Promise<{ ok: true }>((r) => {
            waiting.push(() => r({ ok: true }));
          }),
      },
    });
    t.controller.start();
    t.controller.newSession(true);
    for (const go of waiting) go();
    await tick();
    expect(t.sessions).toHaveLength(1);
    expect(t.posted).not.toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ type: 'error' }) }),
    );
  });

  it('сообщение, отправленное без claude, не теряется: «Проверить снова» его отправляет', async () => {
    let ok = false;
    const t = build({
      engine: {
        ready: async () => (ok ? { ok: true as const } : { ok: false as const, problem: 'нет' }),
      },
    });
    t.controller.start();
    await tick();
    await t.controller.handle({ type: 'send', sessionId: '', text: 'привет' });
    expect(t.sessions).toHaveLength(0);
    ok = true;
    await t.controller.handle({ type: 'turn.retry', sessionId: '', turn: true });
    await tick();
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]!.sent).toEqual(['привет']);
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

describe('картинки в сообщении (этап 4 roadmap 0.2)', () => {
  it('send: картинки уходят в session.send рядом с текстом; негодные отброшены с предупреждением', async () => {
    const t = setup();
    const ok = {
      mediaType: 'image/png' as const,
      data: PNG,
      width: 1568,
      height: 1000,
      name: 'скриншот 1',
    };
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'что на скриншоте?',
      images: [
        ok,
        { mediaType: 'image/heic', data: PNG } as never,
        { mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64 + 4) },
        { mediaType: 'image/png' } as never,
      ],
    });
    const s = t.sessions[0]!;
    expect(s.sent).toEqual(['что на скриншоте?']);
    expect(s.images).toEqual([[ok]]);
    expect(t.deps.log.warn).toHaveBeenCalledTimes(3);
  });

  it('send без картинок — как раньше (images не передаются); больше 10 — лишние отброшены', async () => {
    const t = setup();
    await t.controller.handle({ type: 'send', sessionId: '', text: 'привет' });
    const many = Array.from({ length: 12 }, () => ({
      mediaType: 'image/png' as const,
      data: PNG,
    }));
    await t.controller.handle({ type: 'send', sessionId: '', text: 'много', images: many });
    expect(t.sessions[0]!.images[0]).toBeUndefined();
    expect(t.sessions[0]!.images[1]).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });

  it('image.pick: диалог хоста → image.picked; пусто — ничего', async () => {
    const t = setup();
    const picked = [{ name: 'a.png', mediaType: 'image/png', data: PNG }];
    t.deps.pickAttachments = vi.fn(async () => ({ images: picked, files: [] }));
    await t.controller.handle({ type: 'image.pick' });
    expect(t.posted.at(-1)).toEqual({ type: 'image.picked', items: picked });
    t.deps.pickAttachments = vi.fn(async () => ({ images: [], files: [] }));
    const before = t.posted.length;
    await t.controller.handle({ type: 'image.pick' });
    expect(t.posted).toHaveLength(before);
    expect(t.sessions).toHaveLength(0); // сессию не поднимает
  });

  it('image.open: только картинка нашего формата и размера уходит во временный файл', async () => {
    const t = setup();
    t.deps.openImage = vi.fn(async () => {});
    await t.controller.handle({ type: 'image.open', mediaType: 'image/png', data: PNG });
    await t.controller.handle({ type: 'image.open', mediaType: 'text/html', data: 'PHNjcmlwdD4=' });
    await t.controller.handle({ type: 'image.open', mediaType: 'image/png', data: '' });
    expect(t.deps.openImage).toHaveBeenCalledTimes(1);
    expect(t.deps.openImage).toHaveBeenCalledWith({ mediaType: 'image/png', data: PNG });
  });

  it('хост сверяет содержимое: тип по сигнатуре, не base64 и не картинка — отброшены', async () => {
    const t = setup();
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'что тут?',
      images: [
        // png под видом jpeg (файл с неверным расширением): API отверг бы media_type
        { mediaType: 'image/jpeg', data: PNG },
        { mediaType: 'image/png', data: `data:image/png;base64,${PNG}` },
        { mediaType: 'image/png', data: 'PHNjcmlwdD4=' },
      ],
    });
    expect(t.sessions[0]!.images).toEqual([[{ mediaType: 'image/png', data: PNG }]]);
    expect(t.deps.log.warn).toHaveBeenCalledTimes(2);
  });

  it('картинки одного сообщения вместе — не больше 20 МБ base64: лишние отброшены', async () => {
    const t = setup();
    // 4.5 МБ: валидный base64 с сигнатурой png
    const big = `iVBORw0KGgo${'A'.repeat(4.5 * 1024 * 1024 - 11)}`;
    const many = Array.from({ length: 6 }, () => ({ mediaType: 'image/png' as const, data: big }));
    await t.controller.handle({ type: 'send', sessionId: '', text: 'много', images: many });
    expect(t.sessions[0]!.images[0]).toHaveLength(4);
    expect(t.deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('картинка отброшена: total'),
    );
  });

  it('все картинки отброшены и текста нет — пустое сообщение не уходит', async () => {
    const t = setup();
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: '',
      images: [{ mediaType: 'image/png', data: 'PHNjcmlwdD4=' }],
    });
    expect(t.sessions[0]?.sent ?? []).toEqual([]);
  });
});

describe('файлы в сообщении (этап 8 roadmap 0.2)', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF').toString('base64');
  const txt = { kind: 'text' as const, path: 'docs/a.txt', data: 'секрет', size: 12 };

  it('send: файлы уходят в session.send после проверки; размер и страницы пересчитаны; негодные отброшены', async () => {
    const t = setup();
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'что в файлах?',
      files: [
        { ...txt, size: 1 },
        { kind: 'pdf', path: '/abs/b.pdf', data: PDF, size: 999, pages: 7 },
        { kind: 'text', path: 'bin.dat', data: 'a\u0000b', size: 3 },
        { kind: 'pdf', path: 'fake.pdf', data: 'PHNjcmlwdD4=', size: 8 },
        { kind: 'exe', path: 'x', data: 'x', size: 1 } as never,
        { kind: 'text', path: '', data: 'x', size: 1 },
      ],
    });
    const s = t.sessions[0]!;
    expect(s.sent).toEqual(['что в файлах?']);
    expect(s.images).toEqual([undefined]);
    expect(s.files).toEqual([
      [
        { kind: 'text', path: 'docs/a.txt', data: 'секрет', size: 12 },
        {
          kind: 'pdf',
          path: '/abs/b.pdf',
          data: PDF,
          size: Buffer.from(PDF, 'base64').length,
          pages: 1,
        },
      ],
    ]);
    expect(t.deps.log.warn).toHaveBeenCalledTimes(4);
  });

  it('больше 10 файлов и сверх 20 МБ вместе с картинками — лишние отброшены; одни отброшенные — не уходит', async () => {
    const t = setup();
    const many = Array.from({ length: 12 }, (_, i) => ({ ...txt, path: `f${i}.txt` }));
    await t.controller.handle({ type: 'send', sessionId: '', text: 'много', files: many });
    expect(t.sessions[0]!.files[0]).toHaveLength(10);
    const big = `iVBORw0KGgo${'A'.repeat(4.5 * 1024 * 1024 - 11)}`;
    const images = Array.from({ length: 4 }, () => ({
      mediaType: 'image/png' as const,
      data: big,
    }));
    const text = { ...txt, data: 'x'.repeat(200 * 1024) };
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: 'картинки и файлы',
      images,
      files: [text, { ...text, path: 'b.txt' }],
    });
    // 18 МБ картинок + 200 КБ текста влезают, второй текст — уже нет
    expect(t.sessions[0]!.files[1]).toHaveLength(2);
    expect(t.deps.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('total'));
    const huge = { ...txt, data: 'x'.repeat(250 * 1024) };
    const four = Array.from({ length: 9 }, (_, i) => ({ ...huge, path: `h${i}.txt` }));
    await t.controller.handle({ type: 'send', sessionId: '', text: 'ещё', images, files: four });
    expect(t.sessions[0]!.files[2]!.length).toBeLessThan(9);
    expect(t.deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('файл отброшен: total'));
    await t.controller.handle({
      type: 'send',
      sessionId: '',
      text: '',
      files: [{ kind: 'text', path: 'e.txt', data: '   ', size: 3 }],
    });
    expect(t.sessions[0]!.sent).toHaveLength(3);
  });

  it('image.pick: картинки — image.picked, файлы — file.picked', async () => {
    const t = setup();
    const images = [{ name: 'a.png', mediaType: 'image/png', data: PNG }];
    const files = [
      { ...txt, name: 'a.txt' },
      { name: 'b.bin', problem: 'binary' as const },
    ];
    t.deps.pickAttachments = vi.fn(async () => ({ images, files }));
    await t.controller.handle({ type: 'image.pick' });
    expect(t.posted.slice(-2)).toEqual([
      { type: 'image.picked', items: images },
      { type: 'file.picked', items: files },
    ]);
  });

  it('attach.uris: только строки уходят хосту; пустой список — без чтения; ответ — file.picked', async () => {
    const t = setup();
    t.deps.readUris = vi.fn(async () => ({
      images: [],
      files: [{ name: 'src', problem: 'folder' as const }],
    }));
    await t.controller.handle({ type: 'attach.uris', uris: [] });
    await t.controller.handle({ type: 'attach.uris', uris: 'file:///x' as never });
    expect(t.deps.readUris).not.toHaveBeenCalled();
    await t.controller.handle({ type: 'attach.uris', uris: ['file:///p/src', 1 as never] });
    expect(t.deps.readUris).toHaveBeenCalledWith(['file:///p/src']);
    expect(t.posted.at(-1)).toEqual({
      type: 'file.picked',
      items: [{ name: 'src', problem: 'folder' }],
    });
    expect(t.sessions).toHaveLength(0);
  });

  it('attach.uris: папка из перетаскивания — чип-ссылка attach.picked (внутри — относительный путь, вне — абсолютный)', async () => {
    const t = setup();
    const folders = [
      { path: 'src', name: 'src', dir: '', isDir: true },
      { path: '/opt/lib', name: 'lib', dir: '/opt', isDir: true },
    ];
    t.deps.readUris = vi.fn(async () => ({ images: [], files: [], folders }));
    await t.controller.handle({ type: 'attach.uris', uris: ['file:///p/src', 'file:///opt/lib'] });
    expect(t.posted.at(-1)).toEqual({ type: 'attach.picked', items: folders });
  });

  it('file.open: тип и путь проверены; data передаётся, пустая — нет', async () => {
    const t = setup();
    t.deps.openFile = vi.fn(async () => {});
    await t.controller.handle({ type: 'file.open', kind: 'text', path: 'docs/a.txt', data: 'abc' });
    await t.controller.handle({ type: 'file.open', kind: 'pdf', path: '/abs/b.pdf', data: '' });
    await t.controller.handle({ type: 'file.open', kind: 'html', path: 'x.html' });
    await t.controller.handle({ type: 'file.open', kind: 'text', path: '' });
    expect(t.deps.openFile).toHaveBeenNthCalledWith(1, {
      kind: 'text',
      path: 'docs/a.txt',
      data: 'abc',
    });
    expect(t.deps.openFile).toHaveBeenNthCalledWith(2, { kind: 'pdf', path: '/abs/b.pdf' });
    expect(t.deps.openFile).toHaveBeenCalledTimes(2);
  });
});

describe('граф агентов во вкладке редактора (roadmap 11, этап 2)', () => {
  const graph = (n: number): AgentGraphView => ({
    title: 'сессия',
    main: { limit: 200_000, state: 'working', turnNo: 1 },
    turns: [],
    agents: Array.from({ length: n }, (_, i) => ({
      agentId: `tool-${i}`,
      taskId: `task-${i}`,
      description: `агент ${i}`,
      taskType: 'local_agent',
      background: false,
      status: 'running' as const,
      startedAt: 1,
      turnNo: 1,
      calls: 0,
      segs: [],
    })),
  });
  const init = (s: FakeSession, sessionId: string) =>
    s.emit({
      type: 'session.init',
      sessionId,
      model: 'sonnet',
      cwd: '/p',
      tools: [],
      permissionMode: 'default',
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
    } as unknown as AgentEvent);

  it('agents.openGraph и agents.snapshot уходят менеджеру вкладок, сессию движка не поднимают', async () => {
    const t = setup();
    const openGraph = vi.fn();
    const graphSnapshot = vi.fn();
    const controller = new ChatController({ ...t.deps, openGraph, graphSnapshot });
    await controller.handle({ type: 'agents.openGraph', agentId: 'tool-0' });
    await controller.handle({ type: 'agents.openGraph' });
    const snap = { type: 'agents.snapshot' as const, sessionId: '', graph: graph(0) };
    await controller.handle(snap);
    expect(openGraph.mock.calls).toEqual([['tool-0'], [undefined]]);
    expect(graphSnapshot).toHaveBeenCalledWith(snap);
    expect(t.created).toHaveLength(0);
  });

  /** Чат с живой сессией `sess-1` и привязанный к нему граф — как их связывает `ChatPanel`. */
  async function linked(extra: Partial<ChatDeps> = {}) {
    const t = setup();
    const toGraph: ToWebview[] = [];
    const warn = vi.fn();
    const link = new AgentsGraphLink({ post: (m) => toGraph.push(m), setTitle: vi.fn(), warn });
    const controller = new ChatController({
      ...t.deps,
      ...extra,
      graphSnapshot: (m) => link.snapshot(m),
    });
    controller.start();
    await tick();
    const s = t.sessions[0]!;
    init(s, 'sess-1');
    expect(controller.sessionId).toBe('sess-1');
    link.bind({
      sessionId: () => controller.sessionId,
      post: (m) => t.posted.push(m),
      handle: (m) => controller.handle(m),
    });
    return { ...t, controller, link, toGraph, warn, s };
  }

  it('снимок чата доходит до вкладки графа; граф готов позже — получает последний', async () => {
    const { controller, link, toGraph, posted } = await linked();
    // привязка просит у чата снимок
    expect(posted.filter((m) => m.type === 'agents.graph')).toEqual([{ type: 'agents.graph', open: true }]);
    await controller.handle({ type: 'agents.snapshot', sessionId: 'sess-1', graph: graph(1) });
    expect(toGraph).toHaveLength(0); // webview графа ещё не готов
    link.fromGraph({ type: 'ready' });
    expect(toGraph).toEqual([{ type: 'agents.snapshot', sessionId: 'sess-1', graph: graph(1) }]);
    // агенты идут — новые снимки сразу доходят
    await controller.handle({ type: 'agents.snapshot', sessionId: 'sess-1', graph: graph(2) });
    expect(toGraph.at(-1)).toEqual({ type: 'agents.snapshot', sessionId: 'sess-1', graph: graph(2) });
  });

  it('agent.stop из графа доходит до сессии своего чата; для другой сессии — отброшен', async () => {
    const { link, s, warn } = await linked();
    link.fromGraph({ type: 'ready' });
    link.fromGraph({ type: 'agent.stop', sessionId: 'sess-1', taskId: 'task-0' });
    await tick();
    expect(s.stopped).toEqual(['task-0']);
    link.fromGraph({ type: 'agent.stop', sessionId: 'sess-old', taskId: 'task-9' });
    link.fromGraph({ type: 'agent.stop', sessionId: '', taskId: 'task-9' });
    await tick();
    expect(s.stopped).toEqual(['task-0']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('agent.transcript из графа — тот же обработчик чата', async () => {
    const openText = vi.fn().mockResolvedValue(undefined);
    const { link, deps } = await linked({ openText });
    const agentTranscript = vi.fn().mockResolvedValue('# транскрипт');
    (deps.adapter as { agentTranscript?: unknown }).agentTranscript = agentTranscript;
    link.fromGraph({ type: 'agent.transcript', sessionId: 'sess-1', agentId: 'tool-0', taskId: 'task-0' });
    await tick();
    expect(agentTranscript).toHaveBeenCalledWith('sess-1', '/p', 'task-0', '');
    expect(openText).toHaveBeenCalledWith(expect.objectContaining({ text: '# транскрипт' }));
  });

  it('вкладку графа закрыли — чату «граф закрыт», снимки больше не пересылаются', async () => {
    const { controller, link, toGraph, posted } = await linked();
    link.fromGraph({ type: 'ready' });
    link.dispose();
    expect(posted.filter((m) => m.type === 'agents.graph').at(-1)).toEqual({ type: 'agents.graph', open: false });
    toGraph.length = 0;
    await controller.handle({ type: 'agents.snapshot', sessionId: 'sess-1', graph: graph(1) });
    expect(toGraph).toHaveLength(0);
  });

  it('ходы для ленты задачи: старт/итог главного агента пишутся в журнал, субагент — нет, /clear обнуляет', async () => {
    const { controller, sessions, deps } = setup();
    const events: string[] = [];
    const sessionCalls: [string | undefined, string | undefined][] = [];
    deps.onEvent = (e) => events.push(e.type);
    deps.onSession = (id, why) => void sessionCalls.push([id, why]);
    controller.start();
    await tick();
    const s = sessions[0]!;
    const result = {
      type: 'turn.result' as const,
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 1,
      apiDurationMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
      permissionDenials: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    s.emit({ type: 'turn.start', at: 1000, prompt: 'x' });
    s.emit({ type: 'turn.start', at: 1500, prompt: 'sub', agentId: 'a1' });
    expect(controller.turns()).toEqual([{ start: 1000 }]);
    s.emit(result);
    const [span] = controller.turns();
    expect(span!.start).toBe(1000);
    expect(span!.end).toBeGreaterThanOrEqual(1000);
    expect(events).toEqual(['turn.start', 'turn.start', 'turn.result']);
    // обрыв сессии закрывает идущий ход: иначе он «покрывал» бы всё до now
    s.emit({ type: 'turn.start', at: 2000, prompt: 'y' });
    s.emit({ type: 'session.closed', reason: 'error', message: 'boom' });
    expect(controller.turns()[1]!.end).toBeGreaterThanOrEqual(2000);
    controller.newSession(true);
    expect(controller.turns()).toEqual([]);
    // /clear сообщает вкладке причину: новая сессия остаётся в группе задачи
    expect(sessionCalls).toContainEqual([undefined, 'clear']);
  });
});
