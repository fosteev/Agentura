import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../agent/types';
import type { TaskStateMessage } from '../../shared/task';
import type { TaskGroup } from '../taskGroups';
import type { JiraSource } from './source';
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
    commentOf: vi.fn((_k: string, id: string) => (id === 'c1' ? { author: 'Anna', text: 'hello' } : undefined)),
    attachmentUrl: vi.fn((_k: string, id: string) => (id === 'a1' ? 'https://x.test/f.png' : id === 'bad' ? 'javascript:alert(1)' : undefined)),
    issueUrl: vi.fn(() => 'https://x.test/browse/ABC-1'),
    sourceFor: vi.fn(() => over.source),
  };
  const posted: TaskStateMessage[] = [];
  const deps = {
    service,
    groups: { groupOf: (id: string) => (id === 's1' ? { taskKey: TASK, group } : undefined) },
    sessionId: () => state.sessionId,
    pending: () => state.pending,
    visible: () => state.visible,
    turns: () => [],
    post: (m: TaskStateMessage) => void posted.push(m),
    prefill: vi.fn(),
    openUrl: vi.fn(),
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
});
