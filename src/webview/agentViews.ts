/**
 * Виды вкладки «агенты» (roadmap 11, этап 1): дерево сессии, дорожки времени, карточки. Чистые
 * функции над `HudState` — готовые к отрисовке модели, без DOM и без пикселей (дорожки — в
 * процентах). Список (А) остаётся в `agentsView.ts`. Данных больше, чем даёт движок, здесь нет:
 * размер промпта и итога — оценка по длине текста (`estTokens`), стоимости агента нет.
 */
import { clock } from './chatState';
import {
  AGENT_TOOLS,
  agentDetail,
  backgroundTasks,
  currentCall,
  detailRows,
  elapsed,
  isSubagent,
  mainRow,
  mapRow,
  taskRow,
  type AgentDetailView,
  type DetailRowView,
  type MapRowView,
} from './agentsView';
import type { AgentNode, HudState, TimelineSeg, TurnTimeline } from './hudState';
import { ui } from './strings';
import { compactTokens, formatDuration, shortModel } from './toolView';

export type AgentScope = 'turn' | 'session';
export type AgentStatus = 'busy' | 'ok' | 'err' | 'stop';

/** Сколько фоновых задач показывать в одном ходе. */
const TASKS_SHOWN = 6;

// ——— оценка размера текста ———

/** Токены по длине текста: ceil(len / 4). Других источников размера промпта и итога у движка нет. */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `≈0.4k`, `≈85`, `≈2.1k` — всегда с «≈»: это оценка, а не счётчик. */
export function estLabel(n: number): string {
  if (n < 100) return `≈${n}`;
  if (n < 1000) return `≈${(n / 1000).toFixed(1)}k`;
  return `≈${compactTokens(n)}`;
}

// ——— строки агентов и ходы ———

export interface AgentLine extends MapRowView {
  agentId: string;
  taskId: string;
  status: AgentStatus;
  /** `Explore`, `general-purpose`. */
  type: string;
  /** Описание задачи агента. */
  title: string;
  /** Сколько работает / проработал: `1m 12s`. */
  time: string;
  /** Что агент делает или чем кончил: текущий вызов, начало итога, текст ошибки. */
  brief: string;
  /** Родитель, если он есть среди показанных (вложенный субагент). */
  parentId?: string;
}

export interface TaskLine extends MapRowView {
  agentId: string;
  /** Ход, в котором задача запущена, если не тот, под которым она показана («с хода 11»). */
  since?: number;
}

export interface TurnGroup {
  turnNo: number;
  startedAt: number;
  /** Нет у идущего хода. */
  endedAt?: number;
  live: boolean;
  /** `Explore ×2 · Plan` — кто работал. */
  kinds: string;
  counts: { ok: number; err: number; run: number; stop: number };
  /** Токены субагентов хода. */
  tokens: number;
  /** Порядок дерева: родитель → его дети (`parentId`). */
  agents: AgentLine[];
  tasks: TaskLine[];
  /** Исходные узлы (для дорожек и карточек). */
  nodes: AgentNode[];
  taskNodes: AgentNode[];
}

function statusOf(a: AgentNode): AgentStatus {
  return a.status === 'running'
    ? 'busy'
    : a.status === 'completed'
      ? 'ok'
      : a.status === 'failed'
        ? 'err'
        : 'stop';
}

/** Первая непустая строка, не длиннее ~120 символов. */
function oneLine(text: string | undefined): string {
  const l =
    (text ?? '')
      .slice(0, 2000)
      .split('\n')
      .map((x) => x.trim())
      .find(Boolean) ?? '';
  return l.length > 120 ? `${l.slice(0, 120).trimEnd()}…` : l;
}

function briefOf(a: AgentNode, cwd?: string): string {
  if (a.status === 'running') return currentCall(a, cwd);
  if (a.status === 'completed') {
    const l = oneLine(a.summary);
    return l ? `→ ${l}` : ui.agents.done;
  }
  if (a.status === 'failed') return oneLine(a.summary) || ui.agents.failed;
  return ui.agents.stopped;
}

function agentLine(
  a: AgentNode,
  depth: number,
  now: number,
  cwd?: string,
  parentId?: string,
): AgentLine {
  return {
    ...mapRow(a, depth, now, false, cwd),
    agentId: a.agentId,
    taskId: a.taskId,
    status: statusOf(a),
    type: a.subagentType ?? a.taskType,
    title: a.description || a.agentId,
    time: formatDuration(elapsed(a, now)),
    brief: briefOf(a, cwd),
    ...(parentId ? { parentId } : {}),
  };
}

/** Порядок дерева: субагент → его субагенты (`parentAgentId`); родителя нет среди показанных — верхний уровень. */
function treeLines(nodes: AgentNode[], now: number, cwd?: string): AgentLine[] {
  const ids = new Set(nodes.map((a) => a.agentId));
  const parentOf = (a: AgentNode) =>
    a.parentAgentId && a.parentAgentId !== a.agentId && ids.has(a.parentAgentId)
      ? a.parentAgentId
      : undefined;
  const kids = new Map<string | undefined, AgentNode[]>();
  for (const a of nodes) {
    const p = parentOf(a);
    kids.set(p, [...(kids.get(p) ?? []), a]);
  }
  const out: AgentLine[] = [];
  const seen = new Set<string>();
  const add = (a: AgentNode, depth: number, p: string | undefined) => {
    if (seen.has(a.agentId)) return;
    seen.add(a.agentId);
    out.push(agentLine(a, depth, now, cwd, p));
    for (const k of kids.get(a.agentId) ?? []) add(k, depth + 1, a.agentId);
  };
  for (const a of kids.get(undefined) ?? []) add(a, 0, undefined);
  // цикл в `parentAgentId` (до корня не дойти) — такие агенты на верхний уровень, а не пропадают
  for (const a of nodes) add(a, 0, undefined);
  return out;
}

function typeOf(a: AgentNode): string {
  if (isSubagent(a)) return a.subagentType ?? a.taskType;
  return a.taskType === 'local_bash' ? ui.agents.view.shellKind : a.taskType;
}

/** `Explore ×2 · Plan` — по порядку первого появления. */
function kindsOf(nodes: AgentNode[]): string {
  const counts = new Map<string, number>();
  for (const a of nodes) counts.set(typeOf(a), (counts.get(typeOf(a)) ?? 0) + 1);
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ');
}

/** Последний ход, в котором есть агенты (иначе — фоновые задачи); нет ни тех ни других — `undefined`. */
export function lastAgentTurn(h: HudState): number | undefined {
  const subs = h.agents.filter(isSubagent);
  const pool = subs.length ? subs : h.agents;
  return pool.length ? Math.max(...pool.map((a) => a.turnNo)) : undefined;
}

/**
 * Ходы вкладки, новые сверху. `turn` — последний ход с агентами плюс всё, что идёт (как список);
 * `session` — каждый ход, где есть агенты или фоновые задачи. Идущие фоновые задачи показаны под
 * последним ходом (с пометкой «с хода N»), а не там, где запущены.
 */
export function agentTurns(
  h: HudState,
  scope: AgentScope,
  o: { now: number; cwd?: string },
): TurnGroup[] {
  const last = lastAgentTurn(h);
  if (last === undefined) return [];
  const subs = h.agents.filter(isSubagent);
  const tasks = backgroundTasks(h);
  const nos =
    scope === 'turn' ? [last] : [...new Set(h.agents.map((a) => a.turnNo))].sort((x, y) => y - x);

  const groups: TurnGroup[] = [];
  for (const n of nos) {
    const nodes = subs.filter(
      (a) => a.turnNo === n || (scope === 'turn' && a.status === 'running'),
    );
    const taskNodes = tasks
      .filter((t) =>
        scope === 'turn'
          ? t.turnNo === n || t.status === 'running'
          : n === last
            ? t.turnNo === n || t.status === 'running'
            : t.turnNo === n && t.status !== 'running',
      )
      .slice(0, TASKS_SHOWN);
    if (nodes.length === 0 && taskNodes.length === 0) continue;

    const own = h.turns.find((t) => t.turnNo === n && t.startedAt > 0);
    const all = [...nodes, ...taskNodes];
    const mine = all.filter((a) => a.turnNo === n);
    const startedAt =
      own?.startedAt ?? Math.min(...(mine.length ? mine : all).map((a) => a.startedAt));
    const mainOpen =
      n === h.turnNo && h.turns.length > 0 && h.turns[h.turns.length - 1]!.endedAt === undefined;
    const live = nodes.some((a) => a.status === 'running') || mainOpen;
    const ends = nodes.map((a) => a.endedAt ?? a.startedAt + (a.durationMs ?? 0));
    const counts = { ok: 0, err: 0, run: 0, stop: 0 };
    for (const a of nodes) {
      const s = statusOf(a);
      counts[s === 'busy' ? 'run' : s]++;
    }
    groups.push({
      turnNo: n,
      startedAt,
      ...(!live && ends.length ? { endedAt: Math.max(...ends) } : {}),
      live,
      kinds: kindsOf(all),
      counts,
      tokens: nodes.reduce((sum, a) => sum + (a.tokens ?? 0), 0),
      agents: treeLines(nodes, o.now, o.cwd),
      tasks: taskNodes.map((t) => ({
        ...taskRow(t, o.now),
        agentId: t.agentId,
        ...(t.turnNo !== n ? { since: t.turnNo } : {}),
      })),
      nodes,
      taskNodes,
    });
  }
  return groups;
}

/** Выбранный агент: заданный, если он есть на экране, иначе первый идущий, иначе первый. */
export function pickSelected(groups: TurnGroup[], selected?: string): string | undefined {
  const all = groups.flatMap((g) => g.agents);
  return (
    all.find((a) => a.agentId === selected)?.agentId ??
    groups[0]?.agents.find((a) => a.status === 'busy')?.agentId ??
    all.find((a) => a.status === 'busy')?.agentId ??
    all[0]?.agentId
  );
}

// ——— блок выбранного агента (дерево и дорожки) ———

export interface AgentOpenView {
  agentId: string;
  taskId: string;
  title: string;
  type: string;
  status: AgentStatus;
  statusText: string;
  meta: AgentDetailView['meta'];
  prompt?: string;
  promptLabel: string;
  summary?: string;
  summaryLabel: string;
  callsLabel: string;
  rows: DetailRowView[];
  stopTaskId?: string;
  transcript: boolean;
}

const OPEN_CALLS = 3;

export function agentOpen(
  a: AgentNode,
  now: number,
  cwd?: string,
  hasSession = true,
): AgentOpenView {
  const d = agentDetail(a, now, cwd, hasSession);
  const calls = Math.max(a.calls, a.toolUses ?? 0);
  const done = a.status !== 'running' && a.summary;
  return {
    agentId: a.agentId,
    taskId: a.taskId,
    title: d.title,
    type: d.type,
    status: d.status,
    statusText: d.statusText,
    meta: d.meta,
    ...(a.prompt ? { prompt: a.prompt } : {}),
    promptLabel: ui.agents.view.promptLabel(estLabel(estTokens(a.prompt ?? ''))),
    ...(done ? { summary: a.summary! } : {}),
    summaryLabel:
      a.status === 'failed'
        ? ui.agents.view.errorLabel
        : ui.agents.view.summaryLabel(estLabel(estTokens(a.summary ?? ''))),
    callsLabel: ui.agents.view.callsLabel(calls),
    rows: detailRows(a, now, cwd)
      .filter((r) => !r.mute)
      .slice(-OPEN_CALLS),
    ...(d.stopTaskId ? { stopTaskId: d.stopTaskId } : {}),
    transcript: d.transcript,
  };
}

// ——— В · дорожки ———

export interface AxisTick {
  pct: number;
  label: string;
}

const AXIS_STEPS_S = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21_600, 43_200, 86_400,
];

/** `0`, `0:30`, `1:00`, `12:30`; от часа — `1h`, `1h30`. */
function axisLabel(sec: number): string {
  if (sec === 0) return '0';
  if (sec >= 3600) {
    const m = Math.floor((sec % 3600) / 60);
    return `${Math.floor(sec / 3600)}h${m ? String(m).padStart(2, '0') : ''}`;
  }
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Деления оси: наименьший шаг из ряда (1s … 30m, дальше — часы), дающий не больше пяти меток
 * (включая нуль); сверх суток шаг кратен суткам, так что меток всегда ≤ 5.
 */
export function axisTicks(spanMs: number): AxisTick[] {
  const spanS = Math.max(1, spanMs / 1000);
  const step =
    AXIS_STEPS_S.find((s) => Math.floor(spanS / s) + 1 <= 5) ??
    Math.ceil(spanS / 4 / 86_400) * 86_400;
  const out: AxisTick[] = [];
  for (let t = 0; t <= spanS; t += step) {
    out.push({ pct: Math.round((t / spanS) * 1000) / 10, label: axisLabel(t) });
  }
  return out;
}

export interface LaneBar {
  cls: 'think' | 'tool' | 'wait' | 'busy' | 'ok' | 'err' | 'stop' | 'sh';
  /** Проценты оси. */
  from: number;
  to: number;
  /** Засечки вызовов, % внутри полосы. */
  ticks?: number[];
  /** Началась раньше оси: от нуля с меткой «↤». */
  before?: boolean;
}

export interface Lane {
  key: string;
  /** Нет у основного. */
  agentId?: string;
  main?: boolean;
  shell?: boolean;
  label: string;
  title: string;
  mark?: string;
  status?: AgentStatus;
  /** `12.3k · 1m 12s`. */
  sub: string;
  bars: LaneBar[];
  /** Положение линии «сейчас», %: у идущих. */
  now?: number;
}

export interface LaneView {
  axis: AxisTick[];
  spanMs: number;
  lanes: Lane[];
}

const MAX_TICKS = 60;
const MAX_BARS = 120;

const pct1 = (x: number) => Math.round(Math.min(100, Math.max(0, x)) * 10) / 10;

/** Полоса не короче `min` и не за краем оси: у правого края сдвигается влево. */
function clampBar(from: number, to: number, min: number): { from: number; to: number } {
  const t = Math.min(100, Math.max(to, from + min));
  return { from: Math.round(Math.max(0, Math.min(from, t - min)) * 10) / 10, to: t };
}

/** Засечки не больше `MAX_TICKS`: близкие сливаются, остаток прореживается равномерно. */
function tickMarks(a: AgentNode, endT: number): number[] {
  const len = Math.max(1, endT - a.startedAt);
  const raw = a.segs.map((g) => pct1(((g.at - a.startedAt) / len) * 100));
  const merged: number[] = [];
  for (const t of raw)
    if (merged.length === 0 || t - merged[merged.length - 1]! >= 0.5) merged.push(t);
  if (merged.length <= MAX_TICKS) return merged;
  return Array.from(
    { length: MAX_TICKS },
    (_, i) => merged[Math.floor((i * merged.length) / MAX_TICKS)]!,
  );
}

/** Сегменты основного → полосы: подряд идущие одного вида сливаются (зазор < 0.4%). */
function mainBars(tls: TurnTimeline[], now: number, at: (t: number) => number): LaneBar[] {
  const bars: LaneBar[] = [];
  for (const tl of tls) {
    const tlEnd = tl.endedAt ?? now;
    for (const g of tl.segs as TimelineSeg[]) {
      if (g.kind === 'text') continue;
      if (g.kind === 'tool' && AGENT_TOOLS.has(g.name ?? '')) continue; // этот вызов и есть «ждёт»
      const cls = g.kind === 'think' ? 'think' : 'tool';
      const { from, to } = clampBar(at(g.at), at(g.endAt ?? tlEnd), 0.3);
      const prev = bars[bars.length - 1];
      if (prev && prev.cls === cls && from - prev.to < 0.4) prev.to = Math.max(prev.to, to);
      else bars.push({ cls, from, to });
    }
  }
  return bars.slice(-MAX_BARS);
}

/**
 * Ось и дорожки одного хода. Начало оси — старт таймлайна основного этого хода, иначе самый ранний
 * старт агентов хода; конец — последнее окончание или `now` у идущего. Всё в процентах оси.
 */
export function laneView(h: HudState, g: TurnGroup, now: number): LaneView {
  const tls = h.turns.filter((t) => t.turnNo === g.turnNo && t.startedAt > 0);
  const own = g.nodes.filter((a) => a.turnNo === g.turnNo);
  const startPool = [...own, ...g.taskNodes.filter((a) => a.turnNo === g.turnNo)];
  const start =
    tls[0]?.startedAt ??
    Math.min(
      ...(startPool.length ? startPool : [...g.nodes, ...g.taskNodes]).map((a) => a.startedAt),
    );
  const endOf = (a: AgentNode) =>
    a.status === 'running' ? now : (a.endedAt ?? a.startedAt + (a.durationMs ?? 0));
  const anyRun =
    g.live ||
    g.nodes.some((a) => a.status === 'running') ||
    g.taskNodes.some((a) => a.status === 'running');
  const ends = [
    ...g.nodes.map(endOf),
    ...g.taskNodes.map(endOf),
    ...tls.map((t) => t.endedAt ?? start),
  ];
  const end = Math.max(start + 1000, ...ends, ...(anyRun ? [now] : []));
  const span = end - start;
  const at = (t: number) => pct1(((t - start) / span) * 100);
  const nowAt = at(now);

  const lanes: Lane[] = [];

  // основной: рассуждение и инструменты, между первым стартом агента и концом последнего — «ждёт»
  const bars = mainBars(tls, now, at);
  if (g.nodes.length) {
    const w = clampBar(
      at(Math.min(...g.nodes.map((a) => a.startedAt))),
      at(Math.max(...g.nodes.map(endOf))),
      0.3,
    );
    bars.push({ cls: 'wait', ...w });
  }
  lanes.push({
    key: 'main',
    main: true,
    label: ui.agents.main,
    title: ui.agents.main,
    sub: '',
    bars,
    ...(g.live ? { now: nowAt } : {}),
  });

  const lines = new Map(g.agents.map((l) => [l.agentId, l]));
  for (const a of g.nodes) {
    const line = lines.get(a.agentId);
    const before = a.startedAt < start;
    const { from, to } = clampBar(before ? 0 : at(a.startedAt), at(endOf(a)), 0.8);
    const status = statusOf(a);
    lanes.push({
      key: a.agentId,
      agentId: a.agentId,
      label: a.description || a.agentId,
      title: `${a.subagentType ?? a.taskType}: ${a.description}`,
      mark: line?.mark ?? '◐',
      status,
      sub: `${a.tokens !== undefined ? compactTokens(a.tokens) : '—'} · ${formatDuration(elapsed(a, now))}`,
      bars: [
        {
          cls: status,
          from,
          to,
          ticks: tickMarks(a, endOf(a)),
          ...(before ? { before: true } : {}),
        },
      ],
      ...(a.status === 'running' ? { now: nowAt } : {}),
    });
  }

  for (const t of g.taskNodes) {
    const before = t.startedAt < start;
    const { from, to } = clampBar(before ? 0 : at(t.startedAt), at(endOf(t)), 0.8);
    lanes.push({
      key: t.agentId,
      shell: true,
      label: t.description || t.taskType,
      title: t.description || t.taskType,
      mark: t.status === 'running' ? '◐' : t.status === 'failed' ? '✕' : '○',
      status: statusOf(t),
      sub: `${ui.agents.view.shellKind} · ${formatDuration(elapsed(t, now))}`,
      bars: [
        {
          cls: 'sh',
          from,
          to,
          ...(before ? { before: true } : {}),
        },
      ],
      ...(t.status === 'running' ? { now: nowAt } : {}),
    });
  }

  return { axis: axisTicks(span), spanMs: span, lanes };
}

// ——— Г · карточки ———

export interface CardView {
  line: AgentLine;
  /** `Explore · sonnet-5.5`. */
  kind: string;
  /** Текущий вызов; нет — агент не идёт. */
  live: string | null;
  /** Состояния последних вызовов: `rd` — прошёл, `gr` — идёт, `er` — упал, пусто — прерван. */
  cells: ('rd' | 'gr' | 'er' | '')[];
  /** Начало итога (или текста ошибки), ~200 символов. */
  excerpt: string;
  /** `≈0.4k` — сколько итог добавит в контекст основного; только у готового. */
  resultEst: string | null;
  calls: number;
  /** Транскрипт на диске есть у субагента, если есть сессия. */
  transcript: boolean;
}

const CELLS = 20;
const EXCERPT = 200;

export function cardView(a: AgentNode, now: number, cwd?: string, hasSession = true): CardView {
  const text = (a.summary ?? '')
    .slice(0, EXCERPT * 4)
    .replace(/\s+/g, ' ')
    .trim();
  return {
    line: agentLine(a, 0, now, cwd),
    kind: `${a.subagentType ?? a.taskType}${a.model ? ` · ${shortModel(a.model)}` : ''}`,
    live: a.status === 'running' ? currentCall(a, cwd) : null,
    cells: a.segs
      .slice(-CELLS)
      .map((g) =>
        g.state === 'run' ? 'gr' : g.state === 'ok' ? 'rd' : g.state === 'err' ? 'er' : '',
      ),
    excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT).trimEnd()}…` : text,
    resultEst: a.status === 'completed' && text ? estLabel(estTokens(a.summary ?? '')) : null,
    calls: Math.max(a.calls, a.toolUses ?? 0),
    transcript: hasSession && isSubagent(a),
  };
}

const CARD_RANK: Record<AgentNode['status'], number> = {
  running: 0,
  failed: 1,
  stopped: 1,
  completed: 2,
};

/** Идущие сверху, потом упавшие и остановленные, потом готовые; внутри — по старту. */
export function cardList(g: TurnGroup, now: number, cwd?: string, hasSession = true): CardView[] {
  return [...g.nodes]
    .sort((x, y) => CARD_RANK[x.status] - CARD_RANK[y.status] || x.startedAt - y.startedAt)

    .map((a) => cardView(a, now, cwd, hasSession));
}

/** `ход 12 · 14:30 · Explore ×2 ✓✓` — подпись свёрнутого хода без разметки; для тестов и aria. */
export function turnSummary(g: TurnGroup): string {
  const c = g.counts;
  const marks = '✓'.repeat(c.ok) + '✕'.repeat(c.err) + '■'.repeat(c.stop) + '◐'.repeat(c.run);
  return `${ui.agents.view.turnTitle(g.turnNo)} · ${clock(g.startedAt)} · ${g.kinds}${marks ? ` ${marks}` : ''}`;
}

// ——— модель вкладки для видов «дерево / дорожки / карточки» ———

export type AgentsViewMode = 'tree' | 'lanes' | 'cards';

/** Охват по умолчанию: дерево показывает сессию, остальные — последний ход. */
export function defaultScope(mode: AgentsViewMode): AgentScope {
  return mode === 'tree' ? 'session' : 'turn';
}

export interface ViewsPane {
  mode: AgentsViewMode;
  scope: AgentScope;
  main: MapRowView;
  groups: TurnGroup[];
  selectedId?: string;
  /** Выбранный агент: раскрыт в дереве, под дорожками. */
  open?: AgentOpenView;
  /**
   * Дорожки хода `groups[i]` (вид `lanes`) и его карточки (вид `cards`). Считаются по запросу и
   * запоминаются: свёрнутые ходы охвата «сессия» дорожек и карточек не строят.
   */
  laneOf: (i: number) => LaneView | undefined;
  cardsOf: (i: number) => CardView[];
  /** Токены субагентов на экране. */
  tokens: string;
  /** Карточки: `2 идут · 1 готов · 1 ошибка` по первому ходу. */
  statusLine: string;
}

/** Функция от индекса с запоминанием результата. */
function lazy<T>(f: (i: number) => T): (i: number) => T {
  const memo = new Map<number, T>();
  return (i) => {
    if (!memo.has(i)) memo.set(i, f(i));
    return memo.get(i)!;
  };
}

export function agentsViewPane(
  h: HudState,
  mode: AgentsViewMode,
  scope: AgentScope,
  o: {
    selected?: string;
    working: boolean;
    waiting: boolean;
    model?: string;
    now: number;
    cwd?: string;
    hasSession?: boolean;
  },
): ViewsPane {
  const groups = agentTurns(h, scope, { now: o.now, ...(o.cwd ? { cwd: o.cwd } : {}) });
  const selectedId = pickSelected(groups, o.selected);
  const node = selectedId
    ? groups.flatMap((g) => g.nodes).find((a) => a.agentId === selectedId)
    : undefined;
  const c = groups[0]?.counts;
  const v = ui.agents.view.counts;
  return {
    mode,
    scope,
    main: mainRow(h, o),
    groups,
    ...(selectedId ? { selectedId } : {}),
    ...(node && mode !== 'cards'
      ? { open: agentOpen(node, o.now, o.cwd, o.hasSession ?? true) }
      : {}),
    laneOf: lazy((i) => (groups[i] ? laneView(h, groups[i], o.now) : undefined)),
    cardsOf: lazy((i) =>
      groups[i] ? cardList(groups[i], o.now, o.cwd, o.hasSession ?? true) : [],
    ),
    tokens: compactTokens(groups.reduce((n, g) => n + g.tokens, 0)),
    statusLine: c
      ? [
          c.run && v.running(c.run),
          c.ok && v.ok(c.ok),
          c.err && v.err(c.err),
          c.stop && v.stop(c.stop),
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  };
}
