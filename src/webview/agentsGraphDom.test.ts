// @vitest-environment jsdom
/**
 * Граф агентов во вкладке редактора (roadmap 11, этап 2) в DOM: снимок чата (`graphSync`) → вкладка графа
 * (`agentsGraph/store` + `GraphApp`), узлы, выбор, детали, действия; отправка снимков только пока граф открыт.
 * Данные — живой прогон `agents-parallel` через `dispatchEvent`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { agentsParallelEvents } from '../agent/claude/__fixtures__/agentsParallel';
import type { ToWebview } from '../protocol';
import { AgentOpen } from './components/AgentViews';
import { agentOpen } from './agentViews';
import { ui } from './strings';
import { GraphApp } from './agentsGraph/App';
import {
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  GRAPH_ZOOM_STEP,
  graphZoom,
  handleGraphMessage,
  restoreGraphState,
  setGraphZoom,
} from './agentsGraph/store';
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
  it('missing launch prompt is explicit; tree details show model and effort', async () => {
    const { subs } = await play();
    const agent = { ...subs[1]!, prompt: undefined, model: 'gpt-6-astra', reasoningEffort: 'high' };
    hudState.value = { ...hudState.value, agents: [agent] };
    handleGraphMessage(graphSnapshot());
    const graph = mountGraph();
    await flush();
    expect(q(graph, '.gd').textContent).toContain(ui.agents.view.promptUnavailable);
    expect(q(graph, '.gmap .n[data-agent] .h').textContent).toContain('gpt-6-astra · high');
    expect(q(graph, '.gd .hd .m').textContent).toContain('gpt-6-astra');
    expect(q(graph, '.gd .hd .m').textContent).toContain('effort high');
    const host = document.createElement('div');
    mounted.push(host);
    document.body.append(host);
    render(h(AgentOpen, { d: agentOpen(agent, Date.now()), variant: 'open', onStop() {}, onTranscript() {} }), host);
    expect(q(host, '.open .m').textContent).toContain('gpt-6-astra');
    expect(q(host, '.open .m').textContent).toContain('effort high');
    expect(host.textContent).toContain(ui.agents.view.promptUnavailable);
  });

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

  it('Codex snapshot hides stop and transcript while retaining agents', async () => {
    await play();
    const snap = graphSnapshot();
    handleGraphMessage({ ...snap, graph: { ...snap.graph, actions: { agentStop: false, agentTranscript: false } } });
    const host = mountGraph();
    await flush();
    expect(qa(host, '.gmap .n[data-agent]').length).toBeGreaterThan(0);
    expect(qa(host, '.gmap button.stop')).toHaveLength(0);
    expect(qa(host, '.gmap .gd .ac button')).toHaveLength(0);
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
    expect(qa(host, '.pv-graph .zoom')).toHaveLength(0);
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

describe('зум на графе (масштаб, колесо, кнопки, персистентность)', () => {
  it('кнопки − / + / вписать, % и сброс по двойному клику в 100%', async () => {
    await play();
    handleGraphMessage(graphSnapshot());
    const host = mountGraph();
    await flush();

    const zoomGroup = q(host, '.gmap .cv .bar .zoom');
    expect(zoomGroup).toBeTruthy();

    const [btnOut, btnIn, btnFit] = qa<HTMLButtonElement>(zoomGroup, 'button');
    const pct = q(zoomGroup, '.pct');

    expect(pct.textContent).toBe('100%');
    expect(graphZoom.value).toBe(1);

    // Увеличение (+)
    btnIn!.click();
    await flush();
    expect(graphZoom.value).toBe(1 + GRAPH_ZOOM_STEP);
    expect(pct.textContent).toBe('110%');

    // Уменьшение (−)
    btnOut!.click();
    await flush();
    expect(graphZoom.value).toBe(1);
    expect(pct.textContent).toBe('100%');

    btnOut!.click();
    await flush();
    expect(graphZoom.value).toBe(0.9);
    expect(pct.textContent).toBe('90%');

    // Двойной клик по % сбрасывает в 100%
    pct.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(graphZoom.value).toBe(1);
    expect(pct.textContent).toBe('100%');

    // Границы: GRAPH_ZOOM_MIN
    setGraphZoom(GRAPH_ZOOM_MIN);
    await flush();
    expect(btnOut!.disabled).toBe(true);
    expect(btnIn!.disabled).toBe(false);

    // Границы: GRAPH_ZOOM_MAX
    setGraphZoom(GRAPH_ZOOM_MAX);
    await flush();
    expect(btnOut!.disabled).toBe(false);
    expect(btnIn!.disabled).toBe(true);

    // Вписать: сбрасывает scroll и клампит масштаб по холсту
    const sc = q(host, '.gmap .sc');
    sc.scrollLeft = 50;
    sc.scrollTop = 30;
    btnFit!.click();
    await flush();
    expect(sc.scrollLeft).toBe(0);
    expect(sc.scrollTop).toBe(0);
    expect(graphZoom.value).toBeGreaterThanOrEqual(GRAPH_ZOOM_MIN);
    expect(graphZoom.value).toBeLessThanOrEqual(1);
  });

  it('при пустом графе кнопки зума выключены, а wheel не меняет масштаб', async () => {
    const host = mountGraph();
    await flush();

    const zoomGroup = q(host, '.gmap .cv .bar .zoom');
    const [btnOut, btnIn, btnFit] = qa<HTMLButtonElement>(zoomGroup, 'button');
    expect(btnOut!.disabled).toBe(true);
    expect(btnIn!.disabled).toBe(true);
    expect(btnFit!.disabled).toBe(true);

    const sc = q(host, '.gmap .sc');
    const wheel = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true });
    sc.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(graphZoom.value).toBe(1);
  });

  it('колесо мыши: обычный scroll не перехватывается, ⌘/Ctrl+wheel масштабирует к курсору с учетом --ui-zoom', async () => {
    await play();
    handleGraphMessage(graphSnapshot());
    const host = mountGraph();
    await flush();

    const sc = q(host, '.gmap .sc');
    expect(sc).toBeTruthy();

    // 1. Обычный wheel без ctrlKey/metaKey не отменяется и не меняет зум
    const normalWheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    sc.dispatchEvent(normalWheel);
    expect(normalWheel.defaultPrevented).toBe(false);
    expect(graphZoom.value).toBe(1);

    // 2. Wheel c ctrlKey приближает (deltaY < 0 -> зум растет)
    const zoomInEvent = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      cancelable: true,
      clientX: 200,
      clientY: 150,
    });
    sc.dispatchEvent(zoomInEvent);
    expect(zoomInEvent.defaultPrevented).toBe(true);
    expect(graphZoom.value).toBeGreaterThan(1);

    // Мелкий тачпад-pinch (deltaY = -2, deltaMode = 0) не залипает в мёртвой зоне
    setGraphZoom(1);
    await flush();
    const smallPinch = new WheelEvent('wheel', {
      deltaY: -2,
      deltaMode: 0,
      ctrlKey: true,
      cancelable: true,
      clientX: 200,
      clientY: 150,
    });
    sc.dispatchEvent(smallPinch);
    expect(smallPinch.defaultPrevented).toBe(true);
    expect(graphZoom.value).toBe(1.008);

    // Сбросим обратно в 1
    setGraphZoom(1);
    await flush();

    // 3. Wheel с metaKey отдаляет (deltaY > 0 -> зум уменьшается)
    const zoomOutEvent = new WheelEvent('wheel', {
      deltaY: 100,
      metaKey: true,
      cancelable: true,
      clientX: 200,
      clientY: 150,
    });
    sc.dispatchEvent(zoomOutEvent);
    expect(zoomOutEvent.defaultPrevented).toBe(true);
    expect(graphZoom.value).toBeLessThan(1);

    // 4. Учёт --ui-zoom (когда getBoundingClientRect отличается от clientWidth / clientHeight)
    setGraphZoom(1);
    await flush();

    Object.defineProperty(sc, 'clientWidth', { value: 600, configurable: true });
    Object.defineProperty(sc, 'clientHeight', { value: 400, configurable: true });
    sc.scrollLeft = 100;
    sc.scrollTop = 50;

    vi.spyOn(sc, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      top: 50,
      right: 350,
      bottom: 250,
      width: 300,
      height: 200,
      x: 50,
      y: 50,
      toJSON() {},
    });

    const uiZoomWheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      cancelable: true,
      clientX: 200,
      clientY: 150,
    });
    sc.dispatchEvent(uiZoomWheel);
    await flush();

    const newZ = graphZoom.value;
    expect(newZ).toBeGreaterThan(1);
    expect(sc.scrollLeft).toBe(Math.max(0, Math.round(400 * newZ - 300)));
    expect(sc.scrollTop).toBe(Math.max(0, Math.round(250 * newZ - 200)));
  });

  it('персистентность zoom в webview.setState через restoreGraphState (Reload Window) и сохранение при смене сессии', async () => {
    await play();
    handleGraphMessage(graphSnapshot());
    mountGraph();
    await flush();

    // При дефолтном зуме 1 поле zoom опускается
    expect(state.stored).toMatchObject({ sessionId: 'sess' });
    expect((state.stored as Record<string, unknown>).graph).not.toHaveProperty('zoom');

    // Меняем зум
    setGraphZoom(1.4);
    expect(state.stored).toMatchObject({ sessionId: 'sess', graph: { zoom: 1.4 } });

    // Reload Window: restoreGraphState восстанавливает зум
    restoreGraphState();
    expect(graphZoom.value).toBe(1.4);

    // Смена сессии: выбор агента сбрасывается, но зум вкладки сохраняется
    handleGraphMessage({ ...graphSnapshot(), sessionId: 'sess-2', graph: { ...graphSnapshot().graph, agents: [] } });
    await flush();
    expect(graphZoom.value).toBe(1.4);
    expect(state.stored).toMatchObject({ sessionId: 'sess-2', graph: { zoom: 1.4 } });
  });
});

describe('микроанимации графа, всплывающих слоёв и ленты (roadmap 40, этап 3)', () => {
  const readCss = (name: string) => readFileSync(join(__dirname, '..', '..', 'media', name), 'utf8');

  it('agents-graph.css оживляет path.busy, полосу контекста .ctxb i и узлы .gmap .n', async () => {
    const css = readCss('agents-graph.css');
    expect(css).toMatch(
      /@keyframes\s+gmap-flow\s*\{\s*from\s*\{\s*stroke-dashoffset:\s*0;\s*\}\s*to\s*\{\s*stroke-dashoffset:\s*-9;\s*\}\s*\}/,
    );
    expect(css).toMatch(
      /\.gmap\s+svg\.edges\s+path\.busy\s*\{(?=[^}]*stroke-dasharray:\s*5\s+4;)(?=[^}]*animation:\s*gmap-flow\s+0\.75s\s+linear\s+infinite;)[^}]*\}/,
    );
    expect(css).toMatch(
      /@keyframes\s+gmap-node-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*\}\s*to\s*\{\s*opacity:\s*1;\s*\}\s*\}/,
    );
    expect(css).toMatch(
      /\.gmap\s+\.n\s*\{(?=[^}]*animation:\s*gmap-node-in\s+var\(--dur-fast\)\s+var\(--ease-out\);)(?=[^}]*transition:\s*border-color\s+var\(--dur-fast\)\s+ease,\s*box-shadow\s+var\(--dur-fast\)\s+ease;)[^}]*\}/,
    );
    expect(css).toMatch(
      /\.gmap\s+\.n\.main\s+\.ctxb\s+i\s*\{[^}]*transition:\s*width\s+var\(--dur\)\s+var\(--ease-out\),\s*background-color\s+var\(--dur\)\s+ease;/,
    );

    await play();
    handleGraphMessage(graphSnapshot());
    const host = mountGraph();
    await flush();
    expect(qa(host, '.gmap svg.edges path.busy')).toHaveLength(1);
    expect(qa(host, '.gmap .n.main .ctxb i')).toHaveLength(1);
  });

  it('всплывающие меню, попапы и дискретные карточки ленты имеют короткий вход без остаточного transform на .ncp', () => {
    const hud = readCss('hud.css');
    const webview = readCss('webview.css');
    const tasks = readCss('tasks.css');

    expect(hud).toMatch(
      /@keyframes\s+pop-up\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(4px\);\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*translateY\(0\);\s*\}\s*\}/,
    );
    expect(hud).toMatch(
      /@keyframes\s+pop-down\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(-4px\);\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*translateY\(0\);\s*\}\s*\}/,
    );
    expect(hud).toMatch(/\.menu\.up\s*\{[^}]*animation:\s*pop-up\s+var\(--dur-fast\)\s+var\(--ease-out\);/);
    expect(hud).toMatch(/\.menu\.down\s*\{[^}]*animation:\s*pop-down\s+var\(--dur-fast\)\s+var\(--ease-out\);/);
    expect(hud).toMatch(/\.sidebar\s*>\s*\.pop\s*\{[^}]*animation:\s*pop-down\s+var\(--dur-fast\)\s+var\(--ease-out\);/);

    expect(tasks).toMatch(
      /@keyframes\s+ncp-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(-4px\);\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*translateY\(0\);\s*\}\s*\}/,
    );
    expect(tasks).toMatch(
      /\.ncp\s*\{(?=[^}]*animation:\s*ncp-in\s+var\(--dur-fast\)\s+var\(--ease-out\);)(?![^}]*\bforwards\b)(?![^}]*\btransform:)[^}]*\}/,
    );

    expect(hud).toMatch(
      /@keyframes\s+card-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(3px\);\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*translateY\(0\);\s*\}\s*\}/,
    );
    expect(hud).toMatch(/\.ask\s*\{[^}]*animation:\s*card-in\s+var\(--dur\)\s+var\(--ease-out\);/);
    expect(hud).toMatch(/\.banner\s*\{[^}]*animation:\s*card-in\s+var\(--dur\)\s+var\(--ease-out\);/);
    expect(webview).toMatch(/\.log\s+\.tool-full\s*\{[^}]*animation:\s*card-in\s+var\(--dur\)\s+var\(--ease-out\);/);
    expect(webview).toMatch(
      /\.log\s+\.txt\.think-full\s*\{[^}]*animation:\s*card-in\s+var\(--dur\)\s+var\(--ease-out\);/,
    );
  });

  it('стримящийся .log .txt (без .think-full) и строки .log .e не имеют animation или transition', () => {
    let txtRules = 0;
    let entryRules = 0;
    for (const file of ['hud.css', 'webview.css', 'feed.css']) {
      const clean = readCss(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@keyframes\s+[\w-]+\s*\{(?:\{[^{}]*\}|[^{}])*\}/g, '');
      for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = m[1]!
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith('@'));
        const body = m[2]!;
        for (const sel of selectors) {
          const isStreamingTxt =
            /\.log\b[\s\S]*\.txt(?![\w-])/.test(sel) &&
            !sel.includes('.think-full') &&
            /\.txt(?::[\w-]+)?$/.test(sel);
          const isLogEntry = /\.log\b[\s\S]*\.e(?:[.[#:][\w:="[\]-]*)*$/.test(sel);
          if (isStreamingTxt) txtRules++;
          if (isLogEntry) entryRules++;
          if (isStreamingTxt || isLogEntry) {
            expect(body, `${file}: ${sel}`).not.toMatch(/\b(?:animation|transition)\s*:/);
          }
        }
      }
    }
    expect(txtRules).toBeGreaterThanOrEqual(2);
    expect(entryRules).toBeGreaterThanOrEqual(5);
  });
});
