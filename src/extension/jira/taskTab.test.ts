import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../agent/types';
import type { TaskActionMessage, TaskStateMessage, TaskTransitionsMessage } from '../../shared/task';
import type { TaskGroup } from '../taskGroups';
import type { JiraSource, JiraWriter } from './source';
import { TaskTab, type TaskTabDeps } from './taskTab';
import type { TaskView } from './taskService';

const TASK = 'jira:inst:ABC-1';
const group: TaskGroup = {
  task: { key: 'ABC-1', instanceId: 'inst', title: 'T', url: '' },
  sessions: [{ provider: 'claude', id: 's1' }],
  openedAt: { s1: 5000 },
};

function setup(over: { sessionId?: string; pending?: string; source?: JiraSource } = {}) {
  const state = { sessionId: over.sessionId, pending: over.pending, visible: true };
  const views: TaskView[] = [];
  const service = {
    attach: vi.fn((_k: string, v: TaskView) => {
      views.push(v);
      return { update: vi.fn(), dispose: vi.fn() };
    }),
    refresh: vi.fn(async () => undefined),
    nudge: vi.fn(),
    afterWrite: vi.fn(async () => undefined),
    contextOf: vi.fn(() => ({ key: 'ABC-1', text: '# ABC-1: T\n' })),
    commentOf: vi.fn((_k: string, id: string) => (id === 'c1' ? { author: 'Anna', text: 'hello' } : undefined)),
    attachmentUrl: vi.fn((_k: string, id: string) => (id === 'a1' ? 'https://x.test/f.png' : id === 'bad' ? 'javascript:alert(1)' : undefined)),
    issueUrl: vi.fn(() => 'https://x.test/browse/ABC-1'),
    sourceFor: vi.fn(() => over.source),
  };
  const posted: (TaskStateMessage | TaskTransitionsMessage | TaskActionMessage)[] = [];
  const deps = {
    service,
    groups: { groupOf: (id: string) => (id === 's1' ? { taskKey: TASK, group } : undefined) },
    sessionId: () => state.sessionId,
    pending: () => state.pending,
    visible: () => state.visible,
    turns: () => [],
    post: (m: TaskStateMessage | TaskTransitionsMessage | TaskActionMessage) => void posted.push(m),
    prefill: vi.fn(),
    attach: vi.fn(),
    openUrl: vi.fn(),
    connect: vi.fn(),
    now: () => 9000,
  } satisfies TaskTabDeps;
  return { tab: new TaskTab(deps), deps, service, state, views, posted };
}

describe('TaskTab', () => {
  it('сессия в группе: подписка на задачу группы; openedAt — из группы; повторный sync не пересоздаёт подписку', () => {
    const { tab, service, views } = setup({ sessionId: 's1' });
    tab.sync();
    tab.sync();
    expect(service.attach).toHaveBeenCalledTimes(1);
    expect(service.attach.mock.calls[0]![0]).toBe(TASK);
    expect(views[0]!.openedAt()).toBe(5000);
  });

  it('ожидание задачи (вкладка без сессии): подписка, openedAt = момент первого sync', () => {
    const { tab, service, views } = setup({ pending: TASK });
    tab.sync();
    expect(service.attach).toHaveBeenCalledTimes(1);
    expect(views[0]!.openedAt()).toBe(9000);
  });

  it('/clear: сессия ушла, вкладка осталась с задачей (ожидание) — лента нового чата начинается с этого момента', () => {
    let nowMs = 9000;
    const { tab, state, views, service } = setup({ sessionId: 's1' });
    tab['deps'].now = () => nowMs;
    tab.sync();
    expect(views[0]!.openedAt()).toBe(5000);
    nowMs = 12000;
    state.sessionId = undefined;
    state.pending = TASK;
    tab.sync();
    expect(service.attach).toHaveBeenCalledTimes(1); // та же задача — подписка та же
    expect(views[0]!.openedAt()).toBe(12000);
  });

  it('вкладка вне задачи: подписки нет; отвязали — webview получает «задачи нет»', () => {
    const { tab, state, service, posted } = setup({ sessionId: 's1' });
    tab.sync();
    state.sessionId = 'unknown';
    tab.sync();
    expect(posted).toEqual([{ type: 'task.state', events: [], fetchedAt: 0, source: 'none' }]);
    tab.sync();
    expect(posted).toHaveLength(1);
    expect(service.attach).toHaveBeenCalledTimes(1);
  });

  it('resend (webview пересоздан) подписывается заново', () => {
    const { tab, service } = setup({ sessionId: 's1' });
    tab.sync();
    tab.resend();
    expect(service.attach).toHaveBeenCalledTimes(2);
  });

  it('task.refresh и task.toComposer', () => {
    const { tab, service, deps } = setup({ sessionId: 's1' });
    tab.sync();
    tab.handle({ type: 'task.refresh' });
    expect(service.refresh).toHaveBeenCalledWith(TASK);
    tab.handle({ type: 'task.toComposer', commentId: 'c1' });
    expect(deps.prefill).toHaveBeenCalledWith('ABC-1 · Anna:\nhello');
    tab.handle({ type: 'task.toComposer', commentId: 'nope' });
    expect(deps.prefill).toHaveBeenCalledTimes(1);
    // без commentId — контекст всей задачи файлом (как «Чат по задаче…»)
    tab.handle({ type: 'task.toComposer' });
    expect(service.contextOf).toHaveBeenCalledWith(TASK);
    expect(deps.attach).toHaveBeenCalledWith('ABC-1.md', '# ABC-1: T\n');
    expect(deps.prefill).toHaveBeenCalledTimes(1);
    // карточка ещё не загружена — ничего
    service.contextOf.mockReturnValueOnce(undefined as never);
    tab.handle({ type: 'task.toComposer' });
    expect(deps.attach).toHaveBeenCalledTimes(1);
  });

  it('task.openExternal: вложение — в браузере (только http/https); задача — в Jiraffe или по ссылке', async () => {
    const jf: JiraSource = {
      kind: 'jiraffe',
      instances: () => [],
      issue: async () => {
        throw new Error('x');
      },
      myself: async () => ({ displayName: 'x' }),
      openIssue: vi.fn(async () => undefined),
    };
    const a = setup({ sessionId: 's1', source: jf });
    a.tab.sync();
    a.tab.handle({ type: 'task.openExternal', attachmentId: 'a1' });
    a.tab.handle({ type: 'task.openExternal', attachmentId: 'bad' });
    expect(a.deps.openUrl).toHaveBeenCalledTimes(1);
    expect(a.deps.openUrl).toHaveBeenCalledWith('https://x.test/f.png');
    a.tab.handle({ type: 'task.openExternal' });
    expect(jf.openIssue).toHaveBeenCalledWith('inst', 'ABC-1', true);
    expect(a.deps.openUrl).toHaveBeenCalledTimes(1);

    const b = setup({ sessionId: 's1', source: { ...jf, kind: 'own', openIssue: undefined } });
    b.tab.sync();
    b.tab.handle({ type: 'task.openExternal' });
    expect(b.deps.openUrl).toHaveBeenCalledWith('https://x.test/browse/ABC-1');

    // Jiraffe не смогла открыть — запасной путь по ссылке
    const failing = { ...jf, openIssue: vi.fn(async () => Promise.reject(new Error('no'))) };
    const c = setup({ sessionId: 's1', source: failing });
    c.tab.sync();
    c.tab.handle({ type: 'task.openExternal' });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.deps.openUrl).toHaveBeenCalledWith('https://x.test/browse/ABC-1');
  });

  it('task.connect открывает подключение Jira; taskKey — задача вкладки', () => {
    const { tab, deps } = setup({ sessionId: 's1' });
    expect(tab.taskKey).toBeUndefined();
    tab.sync();
    expect(tab.taskKey).toBe(TASK);
    tab.handle({ type: 'task.connect' });
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('запросы без задачи игнорируются', () => {
    const { tab, service } = setup({});
    tab.handle({ type: 'task.refresh' });
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('nudge: итог хода главного агента и результат инструмента с ключом задачи; чужой текст и субагент — нет', () => {
    const { tab, service } = setup({ sessionId: 's1' });
    tab.sync();
    const result = { type: 'turn.result' } as AgentEvent;
    tab.onAgentEvent(result);
    expect(service.nudge).toHaveBeenCalledTimes(1);
    tab.onAgentEvent({ ...result, agentId: 'sub' } as AgentEvent);
    expect(service.nudge).toHaveBeenCalledTimes(1);
    tab.onAgentEvent({ type: 'tool.result', toolUseId: 't', isError: false, content: 'Created comment on abc-1 ok' } as AgentEvent);
    expect(service.nudge).toHaveBeenCalledTimes(2);
    tab.onAgentEvent({ type: 'tool.result', toolUseId: 't', isError: false, content: 'nothing about it' } as AgentEvent);
    expect(service.nudge).toHaveBeenCalledTimes(2);
  });

  describe('запись от имени пользователя (roadmap 20)', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    function writable(writer: Partial<JiraWriter>) {
      const w: JiraWriter = {
        addComment: vi.fn(async () => ({ id: '10' })),
        transitions: vi.fn(async () => [
          { id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' as const }, requiresFields: false, extra: 1 },
        ]),
        transition: vi.fn(async () => undefined),
        logWork: vi.fn(async () => ({ id: '20' })),
        ...writer,
      };
      const source: JiraSource = {
        kind: 'own',
        writer: w,
        instances: () => [],
        issue: async () => {
          throw new Error('x');
        },
        myself: async () => ({ displayName: 'x' }),
      };
      const t = setup({ sessionId: 's1', source });
      t.tab.sync();
      return { ...t, w };
    }

    it('task.transitions: список переходов без лишних полей; ошибка источника — error', async () => {
      const { tab, posted, w } = writable({});
      tab.handle({ type: 'task.transitions' });
      await flush();
      expect(w.transitions).toHaveBeenCalledWith('inst', 'ABC-1');
      expect(posted.at(-1)).toEqual({
        type: 'task.transitions',
        items: [{ id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' }, requiresFields: false }],
      });
      vi.mocked(w.transitions).mockRejectedValueOnce(new Error('boom'));
      tab.handle({ type: 'task.transitions' });
      await flush();
      expect(posted.at(-1)).toEqual({ type: 'task.transitions', items: [], error: 'boom' });
    });

    it('task.transition / task.comment / task.logWork: ok → task.action и загрузка мимо окна 5 с', async () => {
      const { tab, posted, w, service } = writable({});
      tab.handle({ type: 'task.transition', transitionId: '11' });
      await flush();
      expect(w.transition).toHaveBeenCalledWith('inst', 'ABC-1', '11');
      expect(posted.at(-1)).toEqual({ type: 'task.action', kind: 'transition', ok: true });
      tab.handle({ type: 'task.comment', body: 'Готово' });
      await flush();
      expect(w.addComment).toHaveBeenCalledWith('inst', 'ABC-1', 'Готово');
      expect(posted.at(-1)).toEqual({ type: 'task.action', kind: 'comment', ok: true });
      tab.handle({ type: 'task.logWork', seconds: 5400, date: '2026-10-09', comment: 'ревью' });
      await flush();
      expect(w.logWork).toHaveBeenCalledWith('inst', 'ABC-1', { seconds: 5400, date: '2026-10-09', comment: 'ревью' });
      expect(posted.at(-1)).toEqual({ type: 'task.action', kind: 'logWork', ok: true });
      expect(service.afterWrite).toHaveBeenCalledTimes(3);
      expect(service.afterWrite).toHaveBeenCalledWith(TASK);
    });

    it('нет writer (Jiraffe без API v2) — no-writer, без записи', async () => {
      const ro: JiraSource = {
        kind: 'jiraffe',
        instances: () => [],
        issue: async () => {
          throw new Error('x');
        },
        myself: async () => ({ displayName: 'x' }),
      };
      const { tab, posted, service } = setup({ sessionId: 's1', source: ro });
      tab.sync();
      tab.handle({ type: 'task.comment', body: 'x' });
      tab.handle({ type: 'task.transition', transitionId: '1' });
      tab.handle({ type: 'task.logWork', seconds: 60, date: '2026-10-09', comment: '' });
      tab.handle({ type: 'task.transitions' });
      await flush();
      expect(posted.slice(-4)).toEqual([
        { type: 'task.action', kind: 'comment', ok: false, error: 'no-writer' },
        { type: 'task.action', kind: 'transition', ok: false, error: 'no-writer' },
        { type: 'task.action', kind: 'logWork', ok: false, error: 'no-writer' },
        { type: 'task.transitions', items: [], error: 'no-writer' },
      ]);
      expect(service.afterWrite).not.toHaveBeenCalled();
    });

    it('ошибка источника — task.action с текстом (до 300 символов), карточка не грузится', async () => {
      const { tab, posted, service } = writable({
        addComment: vi.fn(async () => Promise.reject(new Error('x'.repeat(1000)))),
        logWork: vi.fn(async () => Promise.reject(new Error('seconds must be an integer'))),
      });
      tab.handle({ type: 'task.comment', body: 'hi' });
      await flush();
      const m = posted.at(-1) as TaskActionMessage;
      expect(m).toMatchObject({ type: 'task.action', kind: 'comment', ok: false });
      expect(m.error).toBe(`${'x'.repeat(300)}…`);
      tab.handle({ type: 'task.logWork', seconds: 0, date: 'x', comment: '' });
      await flush();
      expect(posted.at(-1)).toEqual({ type: 'task.action', kind: 'logWork', ok: false, error: 'seconds must be an integer' });
      expect(service.afterWrite).not.toHaveBeenCalled();
    });

    it('повторный клик, пока запись летит, второй раз не пишет', async () => {
      let done!: () => void;
      const { tab, w, posted } = writable({
        addComment: vi.fn(() => new Promise<{ id?: string }>((r) => (done = () => r({})))),
      });
      tab.handle({ type: 'task.comment', body: 'a' });
      tab.handle({ type: 'task.comment', body: 'a' });
      expect(w.addComment).toHaveBeenCalledTimes(1);
      done();
      await flush();
      expect(posted.filter((m) => m.type === 'task.action')).toHaveLength(1);
      tab.handle({ type: 'task.comment', body: 'b' });
      expect(w.addComment).toHaveBeenCalledTimes(2);
    });

    it('task.openLink: только http/https/mailto', () => {
      const { tab, deps } = writable({});
      tab.handle({ type: 'task.openLink', url: 'https://x.test/a?b=1' });
      tab.handle({ type: 'task.openLink', url: 'mailto:a@x.test' });
      tab.handle({ type: 'task.openLink', url: 'javascript:alert(1)' });
      tab.handle({ type: 'task.openLink', url: 'file:///etc/passwd' });
      tab.handle({ type: 'task.openLink', url: 'command:workbench.action.terminal.new' });
      tab.handle({ type: 'task.openLink', url: `https://x.test/${'a'.repeat(4000)}` });
      expect(deps.openUrl.mock.calls).toEqual([['https://x.test/a?b=1'], ['mailto:a@x.test']]);
    });
  });
});
