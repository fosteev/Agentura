import { describe, expect, it, vi } from 'vitest';
import type { FromWebview, ToWebview } from '../protocol';
import type { AgentGraphView } from '../shared/agentsGraph';
import { AgentsGraphLink, PendingGraphs, graphStateSession } from './agentsGraphLink';

const view = (title?: string): AgentGraphView => ({
  ...(title ? { title } : {}),
  main: { limit: 200_000, state: 'idle', turnNo: 0 },
  turns: [],
  agents: [],
});

function make(visible = true) {
  const toGraph: ToWebview[] = [];
  const toChat: ToWebview[] = [];
  const handled: FromWebview[] = [];
  const titles: (string | undefined)[] = [];
  let session: string | undefined = 's1';
  const link = new AgentsGraphLink(
    { post: (m) => toGraph.push(m), setTitle: (t) => titles.push(t), warn: vi.fn() },
    visible,
  );
  link.bind({
    sessionId: () => session,
    post: (m) => toChat.push(m),
    handle: (m) => void handled.push(m),
  });
  return {
    link,
    toGraph,
    toChat,
    handled,
    titles,
    setSession: (id: string | undefined) => (session = id),
  };
}

const graphFlags = (msgs: ToWebview[]) =>
  msgs.filter((m) => m.type === 'agents.graph').map((m) => (m as { open: boolean }).open);

describe('AgentsGraphLink', () => {
  it('привязка и ready графа просят у чата снимок; заголовок — из снимка', () => {
    const t = make();
    expect(graphFlags(t.toChat)).toEqual([true]);
    t.link.snapshot({ type: 'agents.snapshot', sessionId: 's1', graph: view('починка табло') });
    expect(t.titles).toEqual(['починка табло']);
    t.link.fromGraph({ type: 'ready' });
    expect(graphFlags(t.toChat)).toEqual([true, true]);
    expect(t.toGraph.map((m) => m.type)).toEqual(['agents.snapshot']);
  });

  it('скрытый граф снимков не просит; показали — чат шлёт свежий; webview чата пересоздан — снова «открыт»', () => {
    const t = make(false);
    expect(graphFlags(t.toChat)).toEqual([]);
    t.link.setVisible(true);
    t.link.setVisible(false);
    expect(graphFlags(t.toChat)).toEqual([true, false]);
    t.link.chatReady(); // скрыт — не просим
    t.link.setVisible(true);
    t.link.chatReady();
    expect(graphFlags(t.toChat)).toEqual([true, false, true, true]);
  });

  it('webview графа пересоздан (вкладку скрыли и показали) — получает последний снимок', () => {
    const t = make();
    t.link.fromGraph({ type: 'ready' });
    t.link.snapshot({ type: 'agents.snapshot', sessionId: 's1', graph: view() });
    t.toGraph.length = 0;
    t.link.fromGraph({ type: 'ready' });
    expect(t.toGraph).toEqual([{ type: 'agents.snapshot', sessionId: 's1', graph: view() }]);
  });

  it('выбор агента — один раз, когда граф готов; смена сессии во вкладке чата его сбрасывает', () => {
    const t = make();
    t.link.focusAgent('tool-1');
    expect(t.toGraph).toHaveLength(0);
    t.link.fromGraph({ type: 'ready' });
    expect(t.toGraph).toEqual([{ type: 'agents.focus', agentId: 'tool-1' }]);
    t.link.fromGraph({ type: 'ready' });
    expect(t.toGraph.filter((m) => m.type === 'agents.focus')).toHaveLength(1);

    const u = make();
    u.link.snapshot({ type: 'agents.snapshot', sessionId: 's1', graph: view() });
    u.link.focusAgent('tool-1');
    u.link.snapshot({ type: 'agents.snapshot', sessionId: 's2', graph: view() });
    u.link.fromGraph({ type: 'ready' });
    expect(u.toGraph.map((m) => m.type)).toEqual(['agents.snapshot']);
  });

  it('выбор агента во скрытом графе ждёт ready пересозданного webview, а не уходит в выгруженный', () => {
    const t = make();
    t.link.fromGraph({ type: 'ready' });
    t.link.setVisible(false);
    t.link.focusAgent('tool-1'); // клик в ленте: reveal ещё не успел показать вкладку
    expect(t.toGraph.filter((m) => m.type === 'agents.focus')).toHaveLength(0);
    t.link.setVisible(true);
    t.link.fromGraph({ type: 'ready' });
    expect(t.toGraph.filter((m) => m.type === 'agents.focus')).toEqual([{ type: 'agents.focus', agentId: 'tool-1' }]);
  });

  it('снимок без сессии (чат ещё не получил историю) не сбрасывает отложенный выбор', () => {
    const t = make();
    t.link.snapshot({ type: 'agents.snapshot', sessionId: 's1', graph: view() });
    t.link.focusAgent('tool-1');
    t.link.snapshot({ type: 'agents.snapshot', sessionId: '', graph: view() });
    t.link.fromGraph({ type: 'ready' });
    expect(t.toGraph.filter((m) => m.type === 'agents.focus')).toEqual([{ type: 'agents.focus', agentId: 'tool-1' }]);
  });

  it('действия графа — только для текущей сессии чата', () => {
    const t = make();
    t.link.fromGraph({ type: 'agent.stop', sessionId: 's1', taskId: 'a' });
    t.setSession('s2'); // во вкладке чата другая сессия, граф ещё показывает прежнюю
    t.link.fromGraph({ type: 'agent.stop', sessionId: 's1', taskId: 'b' });
    t.link.fromGraph({ type: 'agent.transcript', sessionId: 's2', agentId: 'x', taskId: 'c' });
    t.setSession(undefined);
    t.link.fromGraph({ type: 'agent.stop', sessionId: '', taskId: 'd' });
    t.link.fromGraph({ type: 'send', sessionId: 's2', text: 'чужое' });
    expect(t.handled).toEqual([
      { type: 'agent.stop', sessionId: 's1', taskId: 'a' },
      { type: 'agent.transcript', sessionId: 's2', agentId: 'x', taskId: 'c' },
    ]);
  });

  it('закрыт: чату «граф закрыт» один раз, дальше ничего не шлёт', () => {
    const t = make();
    t.link.fromGraph({ type: 'ready' });
    t.link.dispose();
    t.link.dispose();
    t.link.snapshot({ type: 'agents.snapshot', sessionId: 's1', graph: view() });
    t.link.fromGraph({ type: 'agent.stop', sessionId: 's1', taskId: 'a' });
    t.link.setVisible(false);
    expect(graphFlags(t.toChat)).toEqual([true, true, false]);
    expect(t.toGraph).toHaveLength(0);
    expect(t.handled).toHaveLength(0);
  });
});

describe('PendingGraphs, graphStateSession', () => {
  it('граф ждёт чат своей сессии; забранный не удаляется повторно', () => {
    const p = new PendingGraphs<string>();
    p.add('s1', 'g1');
    p.add('s2', 'g2');
    expect(p.claim('s3')).toBeUndefined();
    expect(p.claim('s2')).toBe('g2');
    expect(p.remove('g2')).toBe(false);
    expect(p.remove('g1')).toBe(true);
    expect(p.claim('s1')).toBeUndefined();
  });

  it('id сессии из состояния webview графа', () => {
    expect(graphStateSession({ sessionId: 's1', graph: { turn: 2 } })).toBe('s1');
    expect(graphStateSession({ sessionId: '' })).toBeUndefined();
    expect(graphStateSession({ sessionId: 5 })).toBeUndefined();
    expect(graphStateSession(undefined)).toBeUndefined();
    expect(graphStateSession('s1')).toBeUndefined();
  });
});
