import { signal } from '@preact/signals';
import type { ToWebview } from '../../protocol';
import { isAgentGraphView, type AgentGraphView } from '../../shared/agentsGraph';
import { readGraphState, saveGraphState, send } from '../vscode';

/**
 * Состояние вкладки графа агентов (roadmap 11, этап 2): последний снимок от чата, выбранные ход и агент.
 * Выбор локальный (у графа свой, у панели чата — свой) и сохраняется в состоянии webview.
 */
export const graphSnap = signal<{ sessionId: string; graph: AgentGraphView } | undefined>(undefined);
export const graphTurn = signal<number | undefined>(undefined);
export const graphSelected = signal<string | undefined>(undefined);
/** Свои часы: таймеры идущих агентов считаются от их `startedAt`. */
export const graphNow = signal(Date.now());

/** Сессия, которую граф показывал до перезагрузки или скрытия вкладки (выбор относится к ней). */
let shownSession: string | undefined;
/** Агент из `agents.focus`, которого нет в снимке: выбрать, когда появится. */
let pendingFocus: string | undefined;

/** Восстановить выбор из состояния webview (вызывается при загрузке; тесты — для чистого старта). */
export function restoreGraphState(): void {
  const st = readGraphState();
  graphSnap.value = undefined;
  pendingFocus = undefined;
  shownSession = st.sessionId;
  graphTurn.value = st.graph.turn;
  graphSelected.value = st.graph.selected;
}

function persist(): void {
  const s = graphSnap.value;
  if (!s) return;
  // пустой снимок не стирает сессию, к которой сериализатор вернёт граф после перезагрузки
  saveGraphState(s.sessionId || shownSession || '', {
    ...(graphTurn.value !== undefined ? { turn: graphTurn.value } : {}),
    ...(graphSelected.value ? { selected: graphSelected.value } : {}),
  });
}

function applyFocus(agentId: string): boolean {
  const a = graphSnap.value?.graph.agents.find((x) => x.agentId === agentId);
  if (!a) return false;
  graphSelected.value = agentId;
  graphTurn.value = a.turnNo;
  return true;
}

export function handleGraphMessage(m: ToWebview): void {
  switch (m.type) {
    case 'agents.snapshot': {
      if (!isAgentGraphView(m.graph)) return;
      // во вкладке чата другая сессия — выбор прежней не годится. Пустой id — «сессия неизвестна» (webview чата
      // после перезагрузки окна ещё не получил историю, или новая сессия без id): выбор не сбрасываем
      if (m.sessionId && shownSession && shownSession !== m.sessionId) {
        graphTurn.value = undefined;
        graphSelected.value = undefined;
        pendingFocus = undefined;
      }
      if (m.sessionId) shownSession = m.sessionId;
      graphSnap.value = { sessionId: m.sessionId, graph: m.graph };
      if (pendingFocus && applyFocus(pendingFocus)) pendingFocus = undefined;
      persist();
      break;
    }
    case 'agents.focus':
      if (applyFocus(m.agentId)) {
        pendingFocus = undefined;
        persist();
      } else pendingFocus = m.agentId;
      break;
    default:
      break;
  }
}

export function pickTurn(turnNo: number): void {
  graphTurn.value = turnNo;
  pendingFocus = undefined;
  // выбранный агент из другого хода — в новом ходе выберется первый идущий
  persist();
}

export function pickAgent(agentId: string): void {
  graphSelected.value = agentId;
  pendingFocus = undefined;
  persist();
}

/** Действия — в сессию, которую граф показывает; хост сверит её с сессией чата. */
export function stopGraphAgent(taskId: string): void {
  const s = graphSnap.value;
  if (s) send({ type: 'agent.stop', sessionId: s.sessionId, taskId });
}

export function openGraphTranscript(agentId: string, taskId: string): void {
  const s = graphSnap.value;
  if (s) send({ type: 'agent.transcript', sessionId: s.sessionId, agentId, taskId });
}

/** Что-то идёт (основной или агенты) — часам есть смысл тикать. */
export function graphLive(): boolean {
  const g = graphSnap.value?.graph;
  return !!g && (g.main.state !== 'idle' || g.agents.some((a) => a.status === 'running'));
}
