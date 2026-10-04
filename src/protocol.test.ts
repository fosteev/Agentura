import { describe, expect, it, vi } from 'vitest';
import { isFromWebview, postToHost, postToWebview, AGENT_EVENT_TYPES } from './protocol';

describe('protocol', () => {
  it('принимает известные сообщения webview и отбрасывает мусор', () => {
    expect(isFromWebview({ type: 'ready' })).toBe(true);
    expect(isFromWebview({ type: 'limits.refresh' })).toBe(true);
    expect(isFromWebview({ type: 'send', sessionId: 's', text: 'привет' })).toBe(true);
    expect(isFromWebview({ type: 'preview.open', path: '/a/x.html' })).toBe(true);
    expect(isFromWebview({ type: 'link.open', url: 'https://claude.ai/artifact/1' })).toBe(true);
    expect(isFromWebview({ type: 'diff.changes', sessionId: 's', toolUseIds: ['t'] })).toBe(true);
    expect(isFromWebview({ type: 'fonts.add', kind: 'code' })).toBe(true);
    expect(isFromWebview({ type: 'fonts.add', kind: 'panels' })).toBe(true);
    expect(isFromWebview({ type: 'fonts.remove', family: 'Onest' })).toBe(true);
    expect(isFromWebview({ type: 'unknown' })).toBe(false);
    expect(isFromWebview({ type: 'toString' })).toBe(false);
    expect(isFromWebview(null)).toBe(false);
    expect(isFromWebview('ready')).toBe(false);
  });

  it('граф агентов (roadmap 11): openGraph, snapshot и действия графа проверяются по полям', () => {
    const graph = {
      title: 'сессия',
      main: { limit: 200_000, used: 1000, state: 'working', turnNo: 2 },
      turns: [{ turnNo: 2, startedAt: 1 }],
      agents: [
        {
          agentId: 'tool-1',
          taskId: 't1',
          description: 'd',
          taskType: 'local_agent',
          background: false,
          status: 'running',
          startedAt: 1,
          turnNo: 2,
          calls: 0,
          segs: [{ id: 's', kind: 'tool', at: 2, state: 'run' }],
        },
      ],
    };
    expect(isFromWebview({ type: 'agents.openGraph' })).toBe(true);
    expect(isFromWebview({ type: 'agents.openGraph', agentId: 'tool-1' })).toBe(true);
    expect(isFromWebview({ type: 'agents.openGraph', agentId: 5 })).toBe(false);
    expect(isFromWebview({ type: 'agents.snapshot', sessionId: 's', graph })).toBe(true);
    expect(isFromWebview({ type: 'agents.snapshot', sessionId: '', graph })).toBe(true);
    expect(isFromWebview({ type: 'agents.snapshot', graph })).toBe(false);
    expect(isFromWebview({ type: 'agents.snapshot', sessionId: 's', graph: {} })).toBe(false);
    expect(
      isFromWebview({
        type: 'agents.snapshot',
        sessionId: 's',
        graph: { ...graph, main: { ...graph.main, state: 'busy' } },
      }),
    ).toBe(false);
    expect(
      isFromWebview({
        type: 'agents.snapshot',
        sessionId: 's',
        graph: { ...graph, agents: [{ ...graph.agents[0], status: 'x' }] },
      }),
    ).toBe(false);
    expect(
      isFromWebview({
        type: 'agents.snapshot',
        sessionId: 's',
        graph: { ...graph, agents: [{ ...graph.agents[0], segs: 'нет' }] },
      }),
    ).toBe(false);
    expect(isFromWebview({ type: 'agent.stop', sessionId: 's', taskId: 't' })).toBe(true);
    expect(isFromWebview({ type: 'agent.stop', taskId: 't' })).toBe(false);
    expect(isFromWebview({ type: 'agent.transcript', sessionId: 's', agentId: 'a', taskId: 't' })).toBe(true);
    expect(isFromWebview({ type: 'agent.transcript', sessionId: 's', taskId: 't' })).toBe(false);
  });

  it('вкладка «git» (roadmap 12): запросы проверяются по полям', () => {
    const ok = [
      { type: 'git.watch', on: true },
      { type: 'git.stage', root: '/w', paths: ['a.ts'] },
      { type: 'git.unstage', root: '/w', paths: ['a.ts', 'b.ts'] },
      { type: 'git.discard', root: '/w', paths: ['a.ts'] },
      { type: 'git.commit', roots: ['/w', '/w/b'], message: 'm', amend: false, push: true },
      { type: 'git.commit', roots: ['/w'], message: 'm', amend: true, push: false, all: true },
      { type: 'git.sync', op: 'fetch' },
      { type: 'git.sync', root: '/w', op: 'push' },
      { type: 'git.branch', root: '/w' },
      { type: 'git.open', root: '/w', path: 'a.ts', staged: false },
      { type: 'git.openFile', root: '/w', path: 'a.ts' },
      { type: 'git.openRepository' },
      { type: 'git.message', roots: ['/w', '/w/b'] },
    ];
    for (const m of ok) expect(isFromWebview(m), JSON.stringify(m)).toBe(true);
    const bad = [
      { type: 'git.watch' },
      { type: 'git.stage', root: '/w', paths: [] },
      { type: 'git.stage', root: '/w', paths: 'a.ts' },
      { type: 'git.unstage', paths: ['a.ts'] },
      { type: 'git.discard', root: '/w', paths: [1] },
      { type: 'git.commit', roots: [], message: 'm', amend: false, push: false },
      { type: 'git.commit', roots: ['/w'], message: 'm', amend: false },
      { type: 'git.commit', roots: ['/w'], message: 'm', amend: false, push: false, all: 'yes' },
      { type: 'git.sync', op: 'rebase' },
      { type: 'git.sync', root: 1, op: 'fetch' },
      { type: 'git.branch' },
      { type: 'git.open', root: '/w', path: 'a.ts' },
      { type: 'git.openFile', root: '/w' },
      { type: 'git.message', roots: [] },
      { type: 'git.message', roots: '/w' },
      { type: 'git.status' },
    ];
    for (const m of bad) expect(isFromWebview(m), JSON.stringify(m)).toBe(false);
  });

  it('обёртки postMessage передают сообщение как есть', () => {
    const toWebview = vi.fn().mockResolvedValue(true);
    postToWebview({ postMessage: toWebview }, { type: 'init', surface: 'chat', version: '0.0.1' });
    expect(toWebview).toHaveBeenCalledWith({ type: 'init', surface: 'chat', version: '0.0.1' });

    const toHost = vi.fn();
    postToHost({ postMessage: toHost }, { type: 'ready' });
    expect(toHost).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('список событий этапа 2 без дублей', () => {
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
  });
});
