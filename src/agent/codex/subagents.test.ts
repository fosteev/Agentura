import { describe, expect, it } from 'vitest';
import { CodexEventMapper } from './mapper';
import { buildCodexHistory } from './history';
import type { Thread, ThreadItem } from './protocol';
import { applyHud, initialHud } from '../../webview/hudState';
import { agentDetail } from '../../webview/agentsView';
import { agentGraphView } from '../../webview/agentViews';
import { graphModel } from '../../webview/agentsGraph/model';
import { graphLayout } from '../../webview/agentsGraph/layout';
import type { AgentEvent } from '../types';

// Форма activity из живого Codex 0.166.0: spawnAgent и итог в этих item отсутствуют.
const activity = (id: string, kind: 'started' | 'completed', at: number): ThreadItem => ({
  type: 'subAgentActivity', id: `${id}-${kind}`, kind, agentThreadId: id,
  agentPath: `/root/${id}`, model: kind === 'started' ? 'gpt-6.1-sol' : null,
  startedAtMs: at,
});
const child = (id: string): Thread => ({
  id, parentThreadId: 'root', model: 'gpt-6.1-sol',
  turns: [{ id: 't', status: 'completed', error: null, items: [
    { type: 'userMessage', id: 'u', clientId: null, content: [{ type: 'text', text: `Task ${id}`, text_elements: [] }] },
    { type: 'agentMessage', id: 'm', text: `${id}_OK`, phase: 'final_answer' },
  ] }],
}) as Thread;
const graph = (events: AgentEvent[]) => {
  const hud = events.reduce((s, e) => applyHud(s, e, 5000), initialHud());
  const snapshot = agentGraphView(hud, { state: 'idle' });
  const model = graphModel(snapshot, { now: 5000, hasSession: true });
  return { snapshot, model, layout: graphLayout(model.layout, 1000, 600) };
};

describe('Codex subagents → graph', () => {
  it('activity carries effort even when thread/read has no launch prompt', () => {
    const mapper = new CodexEventMapper();
    mapper.threadId = 'root';
    const item = { ...activity('alpha', 'started', 1100), reasoningEffort: 'high' } as ThreadItem;
    const events = mapper.collaborationItem(item, 1100);
    const thread = child('alpha');
    thread.turns[0]!.items = thread.turns[0]!.items.filter((i) => i.type !== 'userMessage');
    events.push(...mapper.enrichSubagent(thread));
    const { snapshot, model } = graph(events);
    expect(snapshot.agents[0]).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'high', subagentType: 'Codex' });
    expect(snapshot.agents[0]?.prompt).toBeUndefined();
    expect(model.total?.tokens).toBe('—');
    expect(model.nodes[0]?.head).toBe('Codex · gpt-6.1-sol');
  });

  it('running child exposes full prompt, model and effort in panel and graph details', () => {
    const mapper = new CodexEventMapper();
    mapper.threadId = 'root';
    const events = mapper.collaborationItem(activity('alpha', 'started', 1100), 1100);
    const thread = child('alpha');
    thread.reasoningEffort = 'high';
    thread.turns[0]!.status = 'inProgress';
    events.push(...mapper.enrichSubagent(thread));
    const { snapshot, model } = graph(events);
    expect(snapshot.agents[0]).toMatchObject({ status: 'running', prompt: 'Task alpha',
      model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    const detail = agentDetail(snapshot.agents[0]!, 5000);
    expect(detail.prompt).toBe('Task alpha');
    expect(detail.meta).toContainEqual({ value: 'gpt-6.1-sol' });
    expect(detail.meta).toContainEqual({ label: 'effort', value: 'high' });
    expect(model.detail?.meta).toContainEqual({ label: 'effort', value: 'high' });
  });

  it('живые activity: два агента, два ребра, метаданные после завершения не сбрасывают статус и время', () => {
    const mapper = new CodexEventMapper();
    mapper.threadId = 'root';
    const events: AgentEvent[] = [{ type: 'turn.start', at: 1000 }];
    for (const id of ['alpha', 'beta']) {
      events.push(...mapper.collaborationItem(activity(id, 'started', 1100), 1100));
      expect(mapper.collaborationItem(activity(id, 'started', 1100), 1100)).toEqual([]);
      events.push(...mapper.collaborationItem(activity(id, 'completed', 2000), 2000));
      events.push(...mapper.enrichSubagent(child(id)));
    }
    const { snapshot, model, layout } = graph(events);
    expect(model.nodes.map((n) => n.kind)).toEqual(['agent', 'agent']);
    expect(layout.edges.map((e) => e.from)).toEqual(['main', 'main']);
    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.agents[0]).toMatchObject({ status: 'completed', startedAt: 1100, endedAt: 2000,
      prompt: 'Task alpha', summary: 'alpha_OK', subagentType: 'Codex' });
  });

  it('история воспроизводит activity и читает промпт/итог дочернего треда', () => {
    const root = { id: 'root', model: 'gpt-6.1-sol', turns: [{ id: 't', status: 'completed',
      startedAt: 1, completedAt: 3, error: null,
      items: [activity('alpha', 'started', 1100), activity('alpha', 'completed', 2000)],
    }] } as Thread;
    const h = buildCodexHistory(root, { children: [child('alpha')] });
    const { snapshot, model } = graph(h.events);
    expect(model.nodes[0]?.kind).toBe('agent');
    expect(snapshot.agents[0]).toMatchObject({ status: 'completed', startedAt: 1100, endedAt: 2000,
      prompt: 'Task alpha', summary: 'alpha_OK' });
    expect(graph(buildCodexHistory(root).events).snapshot.agents).toHaveLength(1);
  });

  it('метаданные восстанавливают вложенность и ошибку дочернего треда', () => {
    const mapper = new CodexEventMapper();
    mapper.threadId = 'root';
    const events = mapper.collaborationItem(activity('nested', 'started', 1100), 1100);
    events.push(...mapper.collaborationItem(activity('nested', 'completed', 2000), 2000));
    const thread = child('nested');
    thread.parentThreadId = 'parent';
    thread.turns[0]!.status = 'failed';
    events.push(...mapper.enrichSubagent(thread));
    expect(graph(events).snapshot.agents[0]).toMatchObject({ parentAgentId: 'parent', status: 'failed' });
  });

  it('завершение восстанавливается из ребёнка, если activity конца потеряна', () => {
    const mapper = new CodexEventMapper();
    mapper.threadId = 'root';
    const events = mapper.collaborationItem(activity('alpha', 'started', 1100), 1100);
    const thread = child('alpha');
    thread.turns[0]!.completedAt = 2;
    events.push(...mapper.enrichSubagent(thread));
    expect(graph(events).snapshot.agents[0]).toMatchObject({ status: 'completed', endedAt: 2000, summary: 'alpha_OK' });
  });
});
