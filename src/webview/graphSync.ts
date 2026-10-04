import { effect, signal } from '@preact/signals';
import type { FromWebview } from '../protocol';
import { waitingAgents } from './agentsView';
import { agentGraphView } from './agentViews';
import { chat, hudState } from './store';
import { onHostMessage, send } from './vscode';

/**
 * Снимки для вкладки графа агентов (roadmap 11, этап 2). Пока хост говорит, что граф этой вкладки чата
 * открыт и виден (`agents.graph {open: true}`), изменения `HudState` и состояния чата уходят снимком
 * `agents.snapshot` не чаще раза в `GRAPH_DEBOUNCE_MS`; одинаковый снимок второй раз не шлётся.
 * Граф закрыт — ничего не считается и не шлётся.
 */
export const GRAPH_DEBOUNCE_MS = 250;

/** Граф этой вкладки открыт (и виден). */
export const graphOpen = signal(false);

let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent: string | undefined;

/** Снимок сейчас: состояние основного — из чата, агенты — из `HudState`. */
export function graphSnapshot(): Extract<FromWebview, { type: 'agents.snapshot' }> {
  const s = chat.value;
  const h = hudState.value;
  const working = s.status === 'working' || s.status === 'waiting';
  const waiting = working && s.status !== 'waiting' && waitingAgents(s.rows, h).length > 0;
  return {
    type: 'agents.snapshot',
    sessionId: s.sessionId,
    graph: agentGraphView(h, {
      state: !working ? 'idle' : waiting ? 'waiting' : 'working',
      ...(s.model ? { model: s.model } : {}),
      ...(s.title ? { title: s.title } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
    }),
  };
}

function cancel(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** Отправить снимок сейчас; `force` — даже если он не изменился (граф просит свежий). */
export function flushGraph(force = false): void {
  cancel();
  if (!graphOpen.peek()) return;
  const m = graphSnapshot();
  const json = JSON.stringify(m);
  if (!force && json === lastSent) return;
  lastSent = json;
  send(m);
}

/** Слушать `agents.graph` и слать снимки при изменениях; возвращает отписку. */
export function installGraphSync(): () => void {
  const off = onHostMessage((m) => {
    if (m.type !== 'agents.graph') return;
    graphOpen.value = m.open;
    if (m.open) flushGraph(true);
    else {
      cancel();
      lastSent = undefined;
    }
  });
  const stop = effect(() => {
    // подписка на оба сигнала; сам снимок — по таймеру, не чаще раза в GRAPH_DEBOUNCE_MS
    void chat.value;
    void hudState.value;
    if (!graphOpen.value || timer !== undefined) return;
    timer = setTimeout(() => flushGraph(), GRAPH_DEBOUNCE_MS);
  });
  return () => {
    off();
    stop();
    cancel();
    graphOpen.value = false;
    lastSent = undefined;
  };
}
