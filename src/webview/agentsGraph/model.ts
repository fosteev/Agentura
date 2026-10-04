/**
 * Модель вкладки графа агентов (roadmap 11, этап 2): из снимка `AgentGraphView` — полоса ходов, основной,
 * узлы и подписи рёбер выбранного хода, детали выбранного агента. Ходы и строки агентов — общие функции
 * видов панели (`agentTurns`, `agentOpen`) над `HudState`, собранным из снимка.
 */
import type { AgentGraphView } from '../../shared/agentsGraph';
import { GRAPH_SEGS } from '../../shared/agentsGraph';
import { elapsed, isSubagent } from '../agentsView';
import {
  agentOpen,
  agentTurns,
  estLabel,
  estTokens,
  hudOfGraph,
  pickSelected,
  type AgentOpenView,
  type AgentStatus,
  type TurnGroup,
} from '../agentViews';
import type { AgentNode } from '../hudState';
import { ui } from '../strings';
import { compactTokens, formatDuration, shortModel } from '../toolView';
import type { LayoutInput } from './layout';

export interface GraphTurnButton {
  turnNo: number;
  label: string;
  live: boolean;
}

export interface GraphMainView {
  working: boolean;
  model: string;
  state: string;
  context: string;
  /** Заполнение шкалы контекста, 0–100. */
  ctxPct: number;
  ctxCls: '' | 'warn' | 'full';
  returned: string;
}

export interface GraphNodeView {
  id: string;
  kind: 'agent' | 'task';
  status: AgentStatus;
  /** `ok` / `busy` / `err` / `stop` / `shell` — класс узла. */
  cls: string;
  mark: string;
  /** `Explore · sonnet-5.5`, `shell · фоном`. */
  head: string;
  tokens?: string;
  time: string;
  title: string;
  sub: string;
  /** Подпись ребра: `↗ ≈0.6k`, `↙ ≈0.4k` | `…` | `✕` | `■`. */
  up?: string;
  down?: string;
  downCls?: 'dn' | 'run' | 'err' | 'mute';
  stopTaskId?: string;
}

export interface GraphModel {
  turns: GraphTurnButton[];
  turnNo?: number;
  /** Итог выбранного хода: токены агентов и время. */
  total?: { tokens: string; time: string };
  main: GraphMainView;
  nodes: GraphNodeView[];
  layout: LayoutInput;
  selectedId?: string;
  detail?: AgentOpenView;
}

const TASKS_TYPE = (a: AgentNode) => (a.taskType === 'local_bash' ? ui.agents.view.shellKind : a.taskType);

function mainView(v: AgentGraphView, g: TurnGroup | undefined): GraphMainView {
  const m = v.main;
  const working = m.state !== 'idle';
  const pct = m.used !== undefined && m.limit > 0 ? Math.min(100, (m.used / m.limit) * 100) : 0;
  const returned = (g?.nodes ?? [])
    .filter((a) => a.status === 'completed' && a.summary)
    .reduce((n, a) => n + estTokens(a.summary!), 0);
  return {
    working,
    model: m.model ? shortModel(m.model) : '—',
    state:
      m.state === 'waiting'
        ? ui.agents.waitingAgents
        : m.state === 'working'
          ? ui.agents.answering
          : ui.agents.waitingTask,
    context: ui.agents.graph.context(
      m.used !== undefined ? compactTokens(m.used) : '—',
      compactTokens(m.limit),
    ),
    ctxPct: Math.round(pct),
    ctxCls: pct >= 85 ? 'full' : pct >= 60 ? 'warn' : '',
    returned: ui.agents.graph.returned(returned > 0 ? estLabel(returned) : '0'),
  };
}

function agentNode(line: TurnGroup['agents'][number], a: AgentNode): GraphNodeView {
  const st = line.status;
  return {
    id: line.agentId,
    kind: 'agent',
    status: st,
    cls: st,
    mark: st === 'ok' ? '✓' : st === 'err' ? '✕' : st === 'stop' ? '■' : '◐',
    head: a.model ? `${line.type} · ${shortModel(a.model)}` : line.type,
    ...(a.tokens !== undefined ? { tokens: compactTokens(a.tokens) } : {}),
    time: line.time,
    title: line.title,
    sub: line.brief,
    up: `↗ ${estLabel(estTokens(a.prompt ?? ''))}`,
    ...(st === 'ok'
      ? { down: `↙ ${estLabel(estTokens(a.summary ?? ''))}`, downCls: 'dn' as const }
      : st === 'busy'
        ? { down: '…', downCls: 'run' as const }
        : st === 'err'
          ? { down: '✕', downCls: 'err' as const }
          : { down: '■', downCls: 'mute' as const }),
    ...(line.stopTaskId ? { stopTaskId: line.stopTaskId } : {}),
  };
}

function taskNode(t: AgentNode, under: number, now: number): GraphNodeView {
  const running = t.status === 'running';
  const status: AgentStatus = running ? 'busy' : t.status === 'failed' ? 'err' : t.status === 'stopped' ? 'stop' : 'ok';
  const time = formatDuration(elapsed(t, now));
  return {
    id: t.agentId,
    kind: 'task',
    status,
    cls: 'shell',
    mark: running ? '◐' : status === 'err' ? '✕' : status === 'stop' ? '■' : '○',
    head: `${TASKS_TYPE(t)} · ${ui.agents.view.bg}`,
    time,
    title: t.description || t.taskType,
    sub: [
      running ? ui.agents.running : status === 'err' ? ui.agents.failed : status === 'stop' ? ui.agents.stopped : ui.agents.done,
      t.turnNo !== under ? ui.agents.view.sinceTurn(t.turnNo) : '',
    ]
      .filter(Boolean)
      .join(' · '),
    ...(running ? { stopTaskId: t.taskId } : {}),
  };
}

/**
 * `turn` — ход, выбранный в полосе (нет или его больше нет — последний), `selected` — агент (нет или не в
 * этом ходе — первый идущий, иначе первый).
 */
export function graphModel(
  v: AgentGraphView,
  o: { now: number; turn?: number; selected?: string; hasSession: boolean },
): GraphModel {
  const h = hudOfGraph(v);
  const cwd = v.cwd || undefined;
  const groups = agentTurns(h, 'session', { now: o.now, ...(cwd ? { cwd } : {}) });
  const g = groups.find((x) => x.turnNo === o.turn) ?? groups[0];
  const main = mainView(v, g);
  if (!g) return { turns: [], main, nodes: [], layout: { agents: [], tasks: [] } };

  const byId = new Map(g.nodes.map((a) => [a.agentId, a]));
  const nodes: GraphNodeView[] = [
    ...g.agents.map((line) => agentNode(line, byId.get(line.agentId)!)),
    ...g.taskNodes.map((t) => taskNode(t, g.turnNo, o.now)),
  ];
  const selectedId = pickSelected([g], o.selected);
  const sel = selectedId ? byId.get(selectedId) : undefined;
  return {
    // полоса — старые слева, как в прототипе
    turns: [...groups].reverse().map((x) => ({
      turnNo: x.turnNo,
      label: `${x.turnNo} · ${x.live ? ui.agents.graph.live : x.kinds}`,
      live: x.live,
    })),
    turnNo: g.turnNo,
    total: {
      tokens: compactTokens(g.tokens),
      time: formatDuration((g.live ? o.now : (g.endedAt ?? o.now)) - g.startedAt),
    },
    main,
    nodes,
    layout: {
      agents: g.agents.map((a) => ({ id: a.agentId, depth: a.depth, ...(a.parentId ? { parentId: a.parentId } : {}) })),
      tasks: g.taskNodes.map((t) => ({ id: t.agentId })),
    },
    ...(selectedId ? { selectedId } : {}),
    ...(sel && isSubagent(sel) ? { detail: agentOpen(sel, o.now, cwd, o.hasSession, GRAPH_SEGS) } : {}),
  };
}
