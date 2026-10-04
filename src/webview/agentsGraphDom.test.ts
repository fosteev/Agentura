// @vitest-environment jsdom
/**
 * Граф агентов во вкладке редактора (roadmap 11, этап 2) в DOM: снимок чата (`graphSync`) → вкладка графа
 * (`agentsGraph/store` + `GraphApp`), узлы, выбор, детали, действия; отправка снимков только пока граф открыт.
 * Данные — живой прогон `agents-parallel` через `dispatchEvent`.
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { agentsParallelEvents } from '../agent/claude/__fixtures__/agentsParallel';
import type { ToWebview } from '../protocol';
import { GraphApp } from './agentsGraph/App';
import { handleGraphMessage, restoreGraphState } from './agentsGraph/store';
import { initialState } from './chatState';
import { AgentsPreview } from './components/SettingsPreview';
import { GRAPH_DEBOUNCE_MS, graphSnapshot, installGraphSync } from './graphSync';
import { initialHud, type AgentNode } from './hudState';
import { chat, dispatchEvent, hudState } from './store';
import * as vscode from './vscode';

const flush = () => new Promise((r) => setTimeout(r, 30));
const posted: Record<string, unknown>[] = [];
const mounted: HTMLElement[] = [];
// заглушка до импортов: `host()` кэширует api, а модули превью читают состояние уже при загрузке
const state = vi.hoisted(() => {
  const box: { stored: unknown } = { stored: undefined };
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage() {},
    getState: () => box.stored,
    setState: (s: unknown) => void (box.stored = s),
  });
  return box;
});

const q = <T extends Element = HTMLElement>(host: ParentNode, sel: string) => host.querySelector<T>(sel)!;
const qa = <T extends Element = HTMLElement>(host: ParentNode, sel: string) => [
  ...host.querySelectorAll<T>(sel),
];

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  state.stored = undefined;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m as Record<string, unknown>));
  chat.value = initialState();
  hudState.value = initialHud();
  restoreGraphState();
});
afterEach(() => vi.useRealTimers());

/** Посреди хода: три субагента идут, фоновый shell; первый — готов, третий упал. */
async function play() {
  const all = await agentsParallelEvents();
  const calls = all.map((e, i) => (e.type === 'tool.start' && e.agentId ? i : -1)).filter((i) => i >= 0);
  let now = Date.now();
  for (const e of all.slice(0, calls[2]! + 1) as AgentEvent[]) dispatchEvent(e, (now += 10));
  const [bg, ...subs] = hudState.value.agents as [AgentNode, ...AgentNode[]];
  hudState.value = {
    ...hudState.value,
    agents: [
      bg,
      { ...subs[0]!, status: 'completed', endedAt: now, durationMs: 40_000, summary: 'Нашёл одно место.' },
      subs[1]!,
      { ...subs[2]!, status: 'failed', endedAt: now, durationMs: 22_000, summary: 'ECONNREFUSED' },
    ],
  };
  chat.value = { ...chat.value, sessionId: 'sess', title: 'починка табло', status: 'working' };
  return { subs, bg };
}

function mountGraph() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(GraphApp, {}), host);
  return host;
}

const fromHost = (m: ToWebview) => window.dispatchEvent(new MessageEvent('message', { data: m }));

describe('вкладка графа', () => {
  it('узел на каждого агента и фоновую задачу, ребро на каждый узел; выбран идущий, детали — с промптом', async () => {
    const { subs } = await play();
    handleGraphMessage(graphSnapshot());
    const host = mountGraph();
    await flush();
    const nodes = qa(host, '.gmap .n[data-agent]');
    expect(nodes.map((n) => n.dataset['agent'])).toEqual(subs.map((a) => a.agentId));
    expect(qa(host, '.gmap .n[data-task]')).toHaveLength(1);
    expect(qa(host, '.gmap svg.edges path')).toHaveLength(4);
    expect(qa(host, '.gmap .n.main')).toHaveLength(1);
    // подписи рёбер: готовый вернул итог, идущий — «…», упавший — «✕»
    expect(qa(host, '.gmap .lab').map((l) => l.textContent?.split(' · ')[1])).toEqual([
      expect.stringMatching(/^↙ ≈/),
      '…',
      '✕',
    ]);
    const sel = qa(host, '.gmap .n.sel');
    expect(sel).toHaveLength(1);
    expect(sel[0]!.dataset['agent']).toBe(subs[1]!.agentId);
    expect(q(host, '.gmap .gd .q').textContent).toBe(subs[1]!.prompt);
    expect(q(host, '.gmap .gd .hd .t').textContent).toContain(subs[1]!.description);
    // полоса ходов: один ход, нажат
    expect(qa(host, '.gmap .bar .turns button[aria-pressed="true"]')).toHaveLength(1);
  });

  it('клик по агенту переносит выбор и детали; «остановить» и «транскрипт» — с сессией снимка', async () => {
    const { subs } = await play();
    handleGraphMessage(graphSnapshot());
    const host = mountGraph();
    await flush();
    q(host, `.gmap .n[data-agent="${subs[0]!.agentId}"]`).click();
    await flush();
    expect(q(host, '.gmap .n.sel').dataset['agent']).toBe(subs[0]!.agentId);
    expect(qa(host, '.gmap .gd .q').at(-1)!.textContent).toBe('Нашёл одно место.');
    expect(qa(host, '.gmap .gd .ac button.stop')).toHaveLength(0); // готовый — не остановить
    q(host, `.gmap .n[data-agent="${subs[1]!.agentId}"]`).click();
    await flush();
    q(host, '.gmap .gd .ac button.stop').click();
    qa(host, '.gmap .gd .ac button')[0]!.click();
    expect(posted).toEqual([
      { type: 'agent.stop', sessionId: 'sess', taskId: subs[1]!.taskId },
      { type: 'agent.transcript', sessionId: 'sess', agentId: subs[1]!.agentId, taskId: subs[1]!.taskId },
    ]);
    // выбор сохранён в состоянии webview вместе с сессией
    expect(state.stored).toMatchObject({ sessionId: 'sess', graph: { selected: subs[1]!.agentId } });
  });

  it('agents.focus выбирает агента (и до снимка, и после); смена сессии сбрасывает выбор', async () => {
    const { subs } = await play();
    handleGraphMessage({ type: 'agents.focus', agentId: subs[2]!.agentId });
    handleGraphMessage(graphSnapshot());
    const host = mountGraph();
    await flush();
    expect(q(host, '.gmap .n.sel').dataset['agent']).toBe(subs[2]!.agentId);
    expect(q(host, '.gmap .gd .q.err').textContent).toBe('ECONNREFUSED');
    handleGraphMessage({ type: 'agents.focus', agentId: subs[0]!.agentId });
    await flush();
    expect(q(host, '.gmap .n.sel').dataset['agent']).toBe(subs[0]!.agentId);
    // во вкладке чата новая сессия без агентов
    handleGraphMessage({ ...graphSnapshot(), sessionId: 'other', graph: { ...graphSnapshot().graph, agents: [] } });
    await flush();
    expect(qa(host, '.gmap .n[data-agent]')).toHaveLength(0);
    expect(q(host, '.gmap .none').textContent).toBeTruthy();
    expect(state.stored).toMatchObject({ sessionId: 'other', graph: {} });
  });

  it('перезагрузка окна: пустой снимок чата без сессии не сбрасывает выбор и сессию в состоянии', async () => {
    const { subs } = await play();
    state.stored = { sessionId: 'sess', graph: { selected: subs[2]!.agentId } };
    restoreGraphState();
    const host = mountGraph();
    // webview чата поднялся, историю ещё не получил: сессии нет, агентов нет
    handleGraphMessage({ type: 'agents.snapshot', sessionId: '', graph: { ...graphSnapshot().graph, agents: [] } });
    expect(state.stored).toMatchObject({ sessionId: 'sess', graph: { selected: subs[2]!.agentId } });
    handleGraphMessage(graphSnapshot());
    await flush();
    expect(q(host, '.gmap .n.sel').dataset['agent']).toBe(subs[2]!.agentId);
  });

  it('до первого снимка — «ждём данные»; кривой снимок не принимается', () => {
    const host = mountGraph();
    expect(q(host, '.gmap .none').textContent).toMatch(/Ждём/);
    handleGraphMessage({ type: 'agents.snapshot', sessionId: 's', graph: {} as never });
    expect(q(host, '.gmap .none').textContent).toMatch(/Ждём/);
  });
});

describe('снимки из чата (graphSync)', () => {
  it('пока граф закрыт — ничего; открыт — сразу снимок, дальше не чаще раза в 250 мс и без повторов', async () => {
    const off = installGraphSync();
    try {
      await play();
      vi.useFakeTimers();
      hudState.value = { ...hudState.value };
      vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS * 2);
      expect(posted).toHaveLength(0);

      fromHost({ type: 'agents.graph', open: true });
      expect(posted.map((m) => m['type'])).toEqual(['agents.snapshot']);
      expect(posted[0]).toMatchObject({ sessionId: 'sess', graph: { title: 'починка табло' } });

      // три изменения подряд — один снимок через 250 мс
      const agents = hudState.value.agents;
      for (const n of [1, 2, 3]) {
        hudState.value = { ...hudState.value, agents: agents.map((a) => ({ ...a, tokens: n })) };
      }
      vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS - 1);
      expect(posted).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(posted).toHaveLength(2);
      expect((posted[1]!['graph'] as { agents: { tokens: number }[] }).agents[0]!.tokens).toBe(3);

      // изменение, не меняющее снимок (печатает текст ответа) — не шлётся
      chat.value = { ...chat.value, rows: [...chat.value.rows] };
      vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS);
      expect(posted).toHaveLength(2);

      // граф просит свежий (его webview пересоздан) — шлётся даже без изменений
      fromHost({ type: 'agents.graph', open: true });
      expect(posted).toHaveLength(3);

      fromHost({ type: 'agents.graph', open: false });
      hudState.value = { ...hudState.value, agents: [] };
      vi.advanceTimersByTime(GRAPH_DEBOUNCE_MS * 2);
      expect(posted).toHaveLength(3);
    } finally {
      off();
    }
  });
});

describe('превью в ⚙ → «Вид»', () => {
  it('graph — настоящий граф на фикстуре: четыре агента, фоновая задача, выбран идущий', () => {
    const host = document.createElement('div');
    mounted.push(host);
    document.body.append(host);
    render(h(AgentsPreview, { view: 'graph' }), host);
    expect(qa(host, '.pv-graph .gmap .n[data-agent]')).toHaveLength(4);
    expect(qa(host, '.pv-graph .gmap .n[data-task]')).toHaveLength(1);
    expect(q(host, '.pv-graph .gmap .n.sel').dataset['agent']).toBe('tool-b');
    expect(qa(host, '.pv-graph .gmap .amap, .pv-graph #pane-agents')).toHaveLength(0);
  });

  it('панельные превью помечены активной вкладкой — иначе широкая вёрстка hud.css их прячет', () => {
    for (const view of ['list', 'tree', 'lanes', 'cards'] as const) {
      const host = document.createElement('div');
      mounted.push(host);
      document.body.append(host);
      render(h(AgentsPreview, { view }), host);
      expect(q(host, '.pv-agents .pane.side').dataset['active']).toBe('agents');
      expect(q<HTMLElement>(host, '#pane-agents').hidden).toBe(false);
    }
  });
});
