/**
 * Несколько агентов (A6, этап 2 roadmap 0.2): из `HudState.agents` и строк ленты — готовые к
 * отрисовке группа субагентов в ленте, карта «список + детали», бейдж вкладки и живая строка
 * «ждёт агентов». Классы — по прототипу `prototype/shared/agents.css`. Чистые функции.
 *
 * Данные — только то, что даёт движок (живая разведка `scripts/agents-smoke.mjs`): текущий вызов —
 * последний незакрытый `tool.start` агента, токены и время — `task_progress`/`task_notification`,
 * итог — `summary` уведомления. Чего движок не даёт (стоимость агента, токены итога в контексте
 * основного, таймер кэша субагента), того здесь нет.
 */
import { clock, type FeedRow } from './chatState';
import type { AgentNode, HudState, TimelineSeg } from './hudState';
import { compactTokens, segClass, sessionTotals } from './hudView';
import { ui } from './strings';
import { formatDuration, shortModel, splitPath, toolView } from './toolView';

/** Инструменты основного, которые запускают субагента. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

type ToolRow = Extract<FeedRow, { kind: 'tool' }>;

/** Субагент (`Agent`/`Task`), а не фоновая задача основного (shell, monitor). */
export function isSubagent(a: AgentNode): boolean {
  return (
    a.taskType === 'local_agent' ||
    a.taskType === 'remote_agent' ||
    a.taskType === 'agent' ||
    !!a.subagentType
  );
}

export function isAgentRow(r: FeedRow): r is ToolRow {
  return r.kind === 'tool' && AGENT_TOOLS.has(r.name);
}

/** Сколько агент работает (идёт — до `now`). */
function elapsed(a: AgentNode, now: number): number {
  if (a.status === 'running') return Math.max(0, now - a.startedAt, a.durationMs ?? 0);
  return a.durationMs ?? Math.max(0, (a.endedAt ?? now) - a.startedAt);
}

/** Что агент делает сейчас: незакрытый вызов, иначе рассуждение/текст, иначе последний инструмент прогресса. */
function currentCall(a: AgentNode, cwd?: string): string {
  for (let i = a.segs.length - 1; i >= 0; i--) {
    const g = a.segs[i]!;
    if (g.endAt !== undefined) continue;
    if (g.kind === 'tool') return segText(g, cwd);
    return g.kind === 'think' ? ui.agents.thinking : ui.agents.writing;
  }
  const last = a.segs[a.segs.length - 1];
  if (last?.kind === 'tool') return segText(last, cwd);
  return a.lastTool ? a.lastTool.toLowerCase() : ui.agents.starting;
}

function segText(g: TimelineSeg, cwd?: string): string {
  const v = toolView(g.name ?? '', g.input ?? {}, cwd);
  const what = v.dim && !v.dimAfter ? splitPath(v.what).base || v.what : v.what;
  return `${v.op} ${what}`.trim();
}

/** Первая содержательная строка итога: без рамки `[Subagent hand-back]` и пустых строк. */
export function firstLine(text: string | undefined): string {
  if (!text) return '';
  const body = text.includes('The report follows:') ? text.split('The report follows:')[1]! : text;
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^```/.test(l));
  return (line ?? '').replace(/\*\*/g, '').slice(0, 200);
}

// ——— лента: группа под вызовами Agent/Task ———

export type FeedItem = FeedRow | { kind: 'agents'; id: number; rows: ToolRow[] };

/**
 * Подряд идущие вызовы `Agent`/`Task` (параллельные вызовы одного ответа модели) → одна группа.
 * Одиночный вызов — тоже группа (строка агента со статусом, итогом и ■).
 */
export function feedItems(rows: readonly FeedRow[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (isAgentRow(r)) {
      if (prev && prev.kind === 'agents') prev.rows.push(r);
      else out.push({ kind: 'agents', id: r.id, rows: [r] });
    } else out.push(r);
  }
  return out;
}

export interface GroupRowView {
  agentId: string;
  cls: 'ok' | 'busy' | 'err' | '';
  /** `✓ ✕ ■`; у идущего — спиннер. */
  mark: string;
  spin: boolean;
  type: string;
  desc: string;
  /** Вторая строка: текущий вызов, итог (`→`), ошибка. */
  note: string;
  arrow?: boolean;
  right: string;
  stopTaskId?: string;
  link?: 'summary' | 'log';
}

export interface GroupView {
  live: boolean;
  what: string;
  status: string;
  tokens?: string;
  time: string;
  rows: GroupRowView[];
  /** Фоновые задачи сессии, что ещё идут: «pnpm dev · 6m». */
  background?: string;
  /** Основной ждёт агентов этой группы (их вызовы ещё без результата). */
  waiting: boolean;
}

export function agentsById(h: HudState): Map<string, AgentNode> {
  return new Map(h.agents.map((a) => [a.agentId, a]));
}

export function agentGroupView(
  rows: readonly ToolRow[],
  h: HudState,
  now: number,
  cwd?: string,
): GroupView {
  const byId = agentsById(h);
  const views = rows.map((r) => groupRow(r, byId.get(r.toolUseId), now, cwd));
  const nodes = rows.map((r) => byId.get(r.toolUseId)).filter((a): a is AgentNode => !!a);
  const count = (c: GroupRowView['cls']) => views.filter((v) => v.cls === c).length;
  const running = count('busy');
  const parts = [
    running ? ui.agents.group.running(running) : '',
    count('ok') ? ui.agents.group.done(count('ok')) : '',
    count('err') ? ui.agents.group.failed(count('err')) : '',
    views.filter((v) => v.cls === '' && !v.spin).length
      ? ui.agents.group.stopped(views.filter((v) => v.cls === '' && !v.spin).length)
      : '',
  ].filter(Boolean);
  const tokens = nodes.reduce((n, a) => n + (a.tokens ?? 0), 0);
  const start = Math.min(...rows.map((r) => byId.get(r.toolUseId)?.startedAt ?? r.startedAt));
  const end = running
    ? now
    : Math.max(
        ...rows.map((r) => {
          const a = byId.get(r.toolUseId);
          if (a) return a.startedAt + elapsed(a, now);
          return r.startedAt + (r.durationMs ?? 0);
        }),
      );
  const bg = h.agents.filter((a) => !isSubagent(a) && a.status === 'running');
  const waiting = rows.some((r) => {
    const a = byId.get(r.toolUseId);
    return r.state === 'run' && a?.status === 'running' && !a.background;
  });
  return {
    live: running > 0,
    what: rows.length > 1 ? ui.agents.group.parallel(rows.length) : ui.agents.group.single,
    status: parts.length ? `· ${parts.join(' · ')}` : '',
    ...(tokens > 0 ? { tokens: compactTokens(tokens) } : {}),
    time: formatDuration(Math.max(0, end - start)),
    rows: views,
    ...(bg.length
      ? {
          background:
            `${bg[0]!.description} · ${formatDuration(elapsed(bg[0]!, now))}` +
            (bg.length > 1 ? ui.agents.group.more(bg.length - 1) : ''),
        }
      : {}),
    waiting,
  };
}

function groupRow(r: ToolRow, a: AgentNode | undefined, now: number, cwd?: string): GroupRowView {
  const type = a?.subagentType ?? str(r.input['subagent_type']) ?? 'agent';
  const desc = a?.description || str(r.input['description']) || toolView(r.name, r.input).what;
  if (!a) {
    // нет задачи (старый транскрипт, движок не прислал task_started) — по самой строке вызова
    const run = r.state === 'run';
    const ms = run ? Math.max(0, now - r.startedAt) : (r.durationMs ?? 0);
    return {
      agentId: r.toolUseId,
      cls: run ? 'busy' : r.state === 'ok' ? 'ok' : r.state === 'err' ? 'err' : '',
      mark: r.state === 'ok' ? '✓' : r.state === 'err' ? '✕' : r.state === 'stopped' ? '■' : '',
      spin: run,
      type,
      desc,
      note: run ? '' : firstLine(r.content),
      ...(r.state === 'ok' && r.content ? { arrow: true } : {}),
      right: formatDuration(ms),
    };
  }
  const time = formatDuration(elapsed(a, now));
  const right = a.tokens !== undefined ? `${compactTokens(a.tokens)} · ${time}` : time;
  const base = { agentId: a.agentId, type, desc, right };
  switch (a.status) {
    case 'running': {
      const call = currentCall(a, cwd);
      const calls = a.calls || a.toolUses || 0;
      return {
        ...base,
        cls: 'busy',
        mark: '',
        spin: true,
        note: calls > 1 ? `${call} · ${ui.agents.nthCall(calls)}` : call,
        stopTaskId: a.taskId,
      };
    }
    case 'completed':
      return {
        ...base,
        cls: 'ok',
        mark: '✓',
        spin: false,
        note: firstLine(a.summary ?? r.content),
        arrow: true,
        link: 'summary',
      };
    case 'failed':
      return {
        ...base,
        cls: 'err',
        mark: '✕',
        spin: false,
        note: firstLine(a.summary ?? r.content) || ui.agents.failed,
        link: 'log',
      };
    default:
      return {
        ...base,
        cls: '',
        mark: '■',
        spin: false,
        note: ui.agents.stopped,
        link: 'log',
      };
  }
}

/**
 * Субагенты, которых основной сейчас ждёт: вызов `Agent` без результата, агент идёт и не фоновый.
 * Пока они есть, живая строка — «ждёт N агентов» с «stop all».
 */
export function waitingAgents(rows: readonly FeedRow[], h: HudState): AgentNode[] {
  const open = new Set(
    rows.filter((r) => isAgentRow(r) && r.state === 'run').map((r) => (r as ToolRow).toolUseId),
  );
  return h.agents.filter(
    (a) => open.has(a.agentId) && a.status === 'running' && !a.background && isSubagent(a),
  );
}

/** Живые субагенты сессии — для «stop all». Фоновые shell-задачи не трогаем: это не агенты. */
export function liveSubagents(h: HudState): AgentNode[] {
  return h.agents.filter((a) => a.status === 'running' && isSubagent(a));
}

// ——— бейдж вкладки «агенты» ———

/** `идут / всего` за ход (идущие из прошлых ходов тоже считаются); без агентов — нет бейджа. */
export function agentBadge(h: HudState): { text: string; live: boolean } | undefined {
  const shown = h.agents.filter(
    (a) => isSubagent(a) && (a.turnNo === h.turnNo || a.status === 'running'),
  );
  if (shown.length === 0) return undefined;
  const running = shown.filter((a) => a.status === 'running').length;
  return running > 0
    ? { text: `${running} / ${shown.length}`, live: true }
    : { text: String(shown.length), live: false };
}

// ——— вкладка «агенты»: список + детали ———

export interface MapRowView {
  /** Нет — основной. */
  agentId?: string;
  cls: string;
  mark: string;
  name: string;
  meta: string;
  tokens: string;
  stopTaskId?: string;
  depth: number;
}

export interface DetailRowView {
  at: string;
  op: string;
  ev: string;
  dim?: string;
  dimAfter?: boolean;
  d: string;
  now?: boolean;
  mute?: boolean;
}

export interface AgentDetailView {
  agentId: string;
  taskId: string;
  title: string;
  type: string;
  status: 'busy' | 'ok' | 'err' | 'stop';
  statusText: string;
  meta: { label?: string; value: string }[];
  prompt?: string;
  summary?: string;
  summaryLabel: string;
  timelineLabel: string;
  strip: { cls?: string; flex: number }[];
  rows: DetailRowView[];
  stopTaskId?: string;
  /** Транскрипт на диске есть только у субагента (`<сессия>/subagents/agent-<task>.jsonl`). */
  transcript: boolean;
}

export interface AgentMapView {
  heading: string;
  rows: MapRowView[];
  tasks: MapRowView[];
  bar: { cls?: string; flex: number }[];
  totals: { label: string; value: string }[];
  detail?: AgentDetailView;
}

/** Ход, чьих агентов показывает карта: выбранного агента, иначе последний ход с агентами. */
function mapTurn(h: HudState, selected?: string): number | undefined {
  const sel = selected ? h.agents.find((a) => a.agentId === selected) : undefined;
  if (sel && isSubagent(sel)) return sel.turnNo;
  const subs = h.agents.filter(isSubagent);
  return subs.length ? Math.max(...subs.map((a) => a.turnNo)) : undefined;
}

/** Агенты карты: субагенты её хода и все идущие. Порядок — как запускались. */
export function mapAgents(h: HudState, selected?: string): AgentNode[] {
  const turn = mapTurn(h, selected);
  return h.agents.filter((a) => isSubagent(a) && (a.turnNo === turn || a.status === 'running'));
}

/** Кого показать в деталях: выбранного, иначе первого идущего, иначе первого. */
export function detailAgent(h: HudState, selected?: string): AgentNode | undefined {
  const shown = mapAgents(h, selected);
  return (
    shown.find((a) => a.agentId === selected) ??
    shown.find((a) => a.status === 'running') ??
    shown[0]
  );
}

const TASKS_SHOWN = 6;

export function agentMapView(
  h: HudState,
  o: {
    selected?: string;
    working: boolean;
    /** Основной ждёт агентов (`waitingAgents` не пуст). */
    waiting: boolean;
    model?: string;
    now: number;
    cwd?: string;
    /** Есть сессия движка — значит, есть и транскрипты субагентов на диске. */
    hasSession?: boolean;
  },
): AgentMapView {
  const now = o.now;
  const shown = mapAgents(h, o.selected);
  const detail = detailAgent(h, o.selected);
  const ids = new Set(shown.map((a) => a.agentId));

  const used = h.context?.used;
  const rows: MapRowView[] = [
    {
      cls: 'a main',
      mark: o.working ? '●' : '○',
      name: ui.agents.main,
      meta: `${o.model ? shortModel(o.model) : '—'} · ${
        o.working
          ? o.waiting
            ? ui.agents.waitingAgents
            : ui.agents.answering
          : ui.agents.waitingTask
      }`,
      tokens: used !== undefined ? compactTokens(used) : '—',
      depth: 0,
    },
  ];
  // дерево: субагент → его субагенты (parentAgentId); родителя нет на карте — на верхний уровень
  const walk = (parent: string | undefined, depth: number) => {
    for (const a of shown) {
      const p = a.parentAgentId && ids.has(a.parentAgentId) ? a.parentAgentId : undefined;
      if (p !== parent) continue;
      rows.push(mapRow(a, depth + 1, now, a.agentId === detail?.agentId, o.cwd));
      walk(a.agentId, depth + 1);
    }
  };
  walk(undefined, 0);

  const tasks = h.agents
    .filter((a) => !isSubagent(a))
    .sort(
      (x, y) =>
        Number(y.status === 'running') - Number(x.status === 'running') ||
        y.startedAt - x.startedAt,
    )
    .slice(0, TASKS_SHOWN)
    .map((a): MapRowView => {
      const running = a.status === 'running';
      return {
        agentId: a.agentId,
        cls: running ? 'a busy' : 'a',
        mark: running ? '◐' : a.status === 'failed' ? '✕' : '○',
        name: a.description || a.taskType,
        meta: running
          ? `${ui.agents.shell} · ${formatDuration(elapsed(a, now))}`
          : a.status === 'failed'
            ? `${ui.agents.failed} ${clock(a.endedAt ?? now)}`
            : a.status === 'stopped'
              ? `${ui.agents.stopped} ${clock(a.endedAt ?? now)}`
              : ui.agents.finishedAt(clock(a.endedAt ?? now)),
        tokens: '—',
        ...(running ? { stopTaskId: a.taskId } : {}),
        depth: 0,
      };
    });

  const bar = shown.map((a) => ({
    ...(a.status === 'running'
      ? { cls: 'c' }
      : a.status === 'completed'
        ? { cls: 'o' }
        : { cls: 'e' }),
    flex: Math.max(1, Math.round((a.tokens ?? 0) / 100)),
  }));

  const tokens = shown.reduce((n, a) => n + (a.tokens ?? 0), 0);
  const totals = [
    ...(shown.length ? [{ label: ui.agents.turnTokens, value: compactTokens(tokens) }] : []),
    ...sessionTotals(h),
  ];

  let heading: string = ui.agents.heading;
  const first = shown[0];
  if (first) {
    const live = o.working || shown.some((a) => a.status === 'running');
    heading = `${ui.agents.heading} · ${clock(first.startedAt)} · ${
      live ? `${ui.agents.running} ${formatDuration(now - first.startedAt)}` : ui.agents.turnDone
    }`;
  }

  return {
    heading,
    rows,
    tasks,
    bar,
    totals,
    ...(detail ? { detail: agentDetail(detail, now, o.cwd, o.hasSession ?? true) } : {}),
  };
}

function mapRow(a: AgentNode, depth: number, now: number, sel: boolean, cwd?: string): MapRowView {
  const time = formatDuration(elapsed(a, now));
  const model = a.model ? `${shortModel(a.model)} · ` : '';
  const status =
    a.status === 'running'
      ? 'busy'
      : a.status === 'completed'
        ? 'ok'
        : a.status === 'failed'
          ? 'err'
          : '';
  const meta =
    a.status === 'running'
      ? `${currentCall(a, cwd)} · ${time}`
      : a.status === 'completed'
        ? `${model}${ui.agents.doneIn(time)}`
        : a.status === 'failed'
          ? `${ui.agents.failed} · ${firstLine(a.summary) || '—'} · ${time}`
          : `${ui.agents.stopped} · ${time}`;
  return {
    agentId: a.agentId,
    cls: ['a', 'sub', status, sel && 'sel'].filter(Boolean).join(' '),
    mark:
      a.status === 'running'
        ? '◐'
        : a.status === 'completed'
          ? '✓'
          : a.status === 'failed'
            ? '✕'
            : '■',
    name: `${a.subagentType ?? a.taskType}: ${a.description}`,
    meta,
    tokens: a.tokens !== undefined ? compactTokens(a.tokens) : '—',
    ...(a.status === 'running' ? { stopTaskId: a.taskId } : {}),
    depth,
  };
}

/** Сколько строк хода агента показать целиком; длиннее — начало, «ещё N», конец. */
const DETAIL_HEAD = 2;
const DETAIL_TAIL = 8;

export function agentDetail(
  a: AgentNode,
  now: number,
  cwd?: string,
  hasSession = true,
): AgentDetailView {
  const time = formatDuration(elapsed(a, now));
  const status: AgentDetailView['status'] =
    a.status === 'running'
      ? 'busy'
      : a.status === 'completed'
        ? 'ok'
        : a.status === 'failed'
          ? 'err'
          : 'stop';
  const statusText =
    status === 'busy'
      ? ui.agents.detail.live(time)
      : status === 'ok'
        ? ui.agents.detail.ok(time)
        : status === 'err'
          ? ui.agents.detail.err(time)
          : ui.agents.detail.stopped(time);
  const calls = Math.max(a.calls, a.toolUses ?? 0);
  const meta: AgentDetailView['meta'] = [
    ...(a.model ? [{ value: shortModel(a.model) }] : []),
    ...(a.tokens !== undefined
      ? [{ label: ui.agents.detail.tokens, value: compactTokens(a.tokens) }]
      : []),
    { label: ui.agents.detail.calls, value: String(calls) },
  ];

  const all = a.segs.map((g): DetailRowView => {
    const running = g.endAt === undefined && a.status === 'running';
    const dur = formatDuration((g.endAt ?? now) - g.at);
    const at = (Math.max(0, g.at - a.startedAt) / 1000).toFixed(1);
    if (g.kind !== 'tool') {
      return {
        at,
        op: g.kind === 'think' ? 'think' : 'text',
        ev: g.kind === 'think' ? '' : ui.agents.detail.text,
        d: running ? `${dur}…` : dur,
        mute: true,
        ...(running ? { now: true } : {}),
      };
    }
    const v = toolView(g.name ?? '', g.input ?? {}, cwd);
    const tail = running ? `${dur}…` : dur;
    return {
      at,
      op: v.op,
      ev: v.what,
      ...(v.dim ? { dim: v.dim } : {}),
      ...(v.dimAfter ? { dimAfter: true } : {}),
      d: g.detail && !running ? `${g.detail} · ${tail}` : tail,
      ...(running ? { now: true } : {}),
    };
  });
  const rows =
    all.length > DETAIL_HEAD + DETAIL_TAIL + 1
      ? [
          ...all.slice(0, DETAIL_HEAD),
          {
            at: '—',
            op: '…',
            ev: ui.agents.detail.more(all.length - DETAIL_HEAD - DETAIL_TAIL),
            d: '',
            mute: true,
          },
          ...all.slice(-DETAIL_TAIL),
        ]
      : all;
  const strip = a.segs.map((g) => {
    const cls = segClass(g);
    return {
      ...(cls ? { cls } : {}),
      flex: Math.max(1, Math.round(Math.max(0, (g.endAt ?? now) - g.at) / 100)),
    };
  });
  return {
    agentId: a.agentId,
    taskId: a.taskId,
    title: a.description || a.agentId,
    type: a.subagentType ?? a.taskType,
    status,
    statusText,
    meta,
    ...(a.prompt ? { prompt: a.prompt } : {}),
    ...(a.summary && a.status !== 'running' ? { summary: a.summary } : {}),
    summaryLabel: a.status === 'failed' ? ui.agents.detail.error : ui.agents.detail.summary,
    timelineLabel: ui.agents.detail.timeline(calls),
    strip,
    rows,
    ...(a.status === 'running' ? { stopTaskId: a.taskId } : {}),
    transcript: hasSession && isSubagent(a),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
