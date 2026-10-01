/**
 * Агрегаты приборов: контекст, кэш, итоги сессии, таймлайн хода, дерево агентов. Чистый редьюсер
 * `AgentEvent` → `HudState` без Preact и DOM (по образцу `chatState.ts`); вид — `hudView.ts`.
 * В отличие от ленты видит события субагентов: они нужны панели «агенты».
 */
import type { AgentEvent } from '../agent/types';
import { editStats, formatInt, matchCount } from './toolView';

export const TTL_5M = 5 * 60_000;
export const TTL_1H = 60 * 60_000;
/** Пороги шкалы контекста по умолчанию (настройка `agentura.contextThresholds`). */
export const DEFAULT_THRESHOLDS: readonly number[] = [120_000, 150_000];
/** Окно по умолчанию, пока движок не сообщил своё. */
export const DEFAULT_CONTEXT_MAX = 200_000;

export interface ContextState {
  used: number;
  max?: number;
  /** Порог автосжатия движка; нет — считаем концом шкалы. */
  autoCompact?: number;
}

export interface TimelineSeg {
  id: string;
  kind: 'think' | 'tool' | 'text';
  /** Для `tool` — имя и вход инструмента (подпись строки строится во view). */
  name?: string;
  input?: Record<string, unknown>;
  at: number;
  endAt?: number;
  state: 'run' | 'ok' | 'err' | 'stopped';
  /** Инструмент ждёт человека: разрешение, ответ на вопрос, решение по плану (до `permission.resolved`). */
  waiting?: 'permission' | 'question' | 'plan';
  /** `+6 −2`, `3` (совпадения) — то, что ставится перед временем. */
  detail?: string;
}

export interface TurnTimeline {
  startedAt: number;
  endedAt?: number;
  segs: TimelineSeg[];
}

export interface AgentNode {
  /** Id вызова инструмента, запустившего задачу (`Agent`/`Task` или фоновый `Bash`). */
  agentId: string;
  taskId: string;
  description: string;
  /** `local_agent` — субагент; `local_bash`, `monitor`… — фоновая задача. */
  taskType: string;
  subagentType?: string;
  background: boolean;
  parentAgentId?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastTool?: string;
  /** Ход пользователя, в котором задача запущена (`HudState.turnNo`): «за ход» — бейдж, карта, группа. */
  turnNo: number;
  /** Промпт от основного (`task_started.prompt`). */
  prompt?: string;
  /** Модель субагента — из его `usage.message`. */
  model?: string;
  /** Итог, возвращённый основному (`task_notification.summary`); у упавшего — текст ошибки. */
  summary?: string;
  /**
   * Ход агента: его вызовы инструментов, рассуждение и текст (события с `agentId`) — как панель
   * «ход». Последние `MAX_AGENT_SEGS`; `calls` — сколько вызовов было всего.
   */
  segs: TimelineSeg[];
  calls: number;
}

/** Сколько строк хода агента держать (длинные агенты делают сотни вызовов). */
export const MAX_AGENT_SEGS = 200;

export interface HudState {
  thresholds: number[];
  context?: ContextState;
  /** Окно контекста из `turn.result.contextWindow`, если `context.usage` его не принёс. */
  contextWindow?: number;
  /** Вход подписки CLI (`apiKeySource: none`) — TTL кэша 1 ч, иначе 5 мин. */
  subscription?: boolean;
  cache: { lastAt?: number; ttlMs?: number };
  totals: {
    costUsd: number;
    turns: number;
    durationMs: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Идёт сжатие контекста (`compaction.start` → `compaction.end`): индикатор «сжимаю» у шкалы. */
  compacting?: boolean;
  /** Последние ходы, старый первым; у активного нет `endedAt`. */
  turns: TurnTimeline[];
  agents: AgentNode[];
  /** Номер хода пользователя: `turn.start` с промптом (ход-пробуждение после фоновой задачи — не новый). */
  turnNo: number;
}

const KEEP_TURNS = 3;

export function initialHud(thresholds: readonly number[] = DEFAULT_THRESHOLDS): HudState {
  return {
    thresholds: [...thresholds],
    cache: {},
    totals: { costUsd: 0, turns: 0, durationMs: 0, input: 0, cacheRead: 0, cacheWrite: 0 },
    turns: [],
    agents: [],
    turnNo: 0,
  };
}

/** Новая сессия: всё, кроме настроек, сбрасывается. */
export function resetHud(s: HudState): HudState {
  return initialHud(s.thresholds);
}

/** Окно контекста: из шкалы, иначе из хода, иначе 200k. */
export function contextMax(s: HudState): number {
  return s.context?.max ?? s.contextWindow ?? DEFAULT_CONTEXT_MAX;
}

/** TTL кэша: по записи в кэш последнего ответа (`ephemeral_*`), иначе по типу входа. */
export function cacheTtl(s: HudState): number {
  return s.cache.ttlMs ?? (s.subscription ? TTL_1H : TTL_5M);
}

export function cacheExpiresAt(s: HudState): number | undefined {
  return s.cache.lastAt === undefined ? undefined : s.cache.lastAt + cacheTtl(s);
}

/** Доля попаданий в кэш за сессию: `cache_read / (input + cache_read + cache_creation)`. */
export function cacheHitRatio(t: HudState['totals']): number | undefined {
  const total = t.input + t.cacheRead + t.cacheWrite;
  return total > 0 ? t.cacheRead / total : undefined;
}

function activeTurn(s: HudState): TurnTimeline | undefined {
  const last = s.turns[s.turns.length - 1];
  return last && last.endedAt === undefined ? last : undefined;
}

/** Активный ход; нет — начинается неявный (события пришли без `turn.start`). */
function ensureTurn(s: HudState, now: number): { state: HudState; turn: TurnTimeline } {
  const cur = activeTurn(s);
  if (cur) return { state: s, turn: cur };
  const turn: TurnTimeline = { startedAt: now, segs: [] };
  return { state: { ...s, turns: [...s.turns, turn].slice(-KEEP_TURNS) }, turn };
}

function withTurn(s: HudState, turn: TurnTimeline): HudState {
  return { ...s, turns: [...s.turns.slice(0, -1), turn] };
}

/** Закрыть открытый текстовый сегмент (после него пошёл инструмент, рассуждение или конец хода). */
function closeText(turn: TurnTimeline, at: number): TurnTimeline {
  if (!turn.segs.some((g) => g.kind === 'text' && g.endAt === undefined)) return turn;
  return {
    ...turn,
    segs: turn.segs.map((g) =>
      g.kind === 'text' && g.endAt === undefined ? { ...g, endAt: at, state: 'ok' } : g,
    ),
  };
}

function patchSeg(
  turn: TurnTimeline,
  pred: (g: TimelineSeg) => boolean,
  patch: Partial<TimelineSeg>,
): TurnTimeline {
  const i = turn.segs.map(pred).lastIndexOf(true);
  if (i < 0) return turn;
  const segs = turn.segs.slice();
  segs[i] = { ...segs[i]!, ...patch };
  return { ...turn, segs };
}

function closeAll(turn: TurnTimeline, at: number, interrupted: boolean): TurnTimeline {
  return {
    ...turn,
    segs: turn.segs.map((g) =>
      g.endAt !== undefined
        ? g
        : { ...g, endAt: at, state: g.kind === 'tool' ? (interrupted ? 'stopped' : 'err') : 'ok' },
    ),
  };
}

function updateAgent(
  s: HudState,
  agentId: string,
  fallback: () => AgentNode,
  patch: (a: AgentNode) => AgentNode,
): HudState {
  const i = s.agents.findIndex((a) => a.agentId === agentId);
  const agents = s.agents.slice();
  if (i < 0) agents.push(patch(fallback()));
  else agents[i] = patch(agents[i]!);
  return { ...s, agents };
}

export function applyHud(s: HudState, e: AgentEvent, now = Date.now()): HudState {
  const blank = (agentId: string, taskId: string, description: string): AgentNode => ({
    agentId,
    taskId,
    description,
    taskType: 'agent',
    background: false,
    status: 'running',
    startedAt: now,
    turnNo: s.turnNo,
    segs: [],
    calls: 0,
  });
  switch (e.type) {
    case 'agent.start':
      return updateAgent(
        s,
        e.agentId,
        () => ({
          ...blank(e.agentId, e.taskId, e.description),
          taskType: e.taskType,
          background: e.background,
          startedAt: e.at ?? now,
        }),
        (a) => ({
          ...a,
          taskId: e.taskId,
          description: e.description,
          taskType: e.taskType,
          background: e.background,
          ...(e.subagentType ? { subagentType: e.subagentType } : {}),
          ...(e.parentAgentId ? { parentAgentId: e.parentAgentId } : {}),
          ...(e.prompt ? { prompt: e.prompt } : {}),
        }),
      );
    case 'agent.progress':
      return updateAgent(
        s,
        e.agentId,
        () => blank(e.agentId, e.taskId, e.description ?? ''),
        (a) => ({
          ...a,
          // `description` прогресса — «Reading alpha/notes.md»: что агент делает сейчас, не его задача
          ...(e.totalTokens !== undefined ? { tokens: e.totalTokens } : {}),
          ...(e.toolUses !== undefined ? { toolUses: e.toolUses } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          ...(e.lastToolName ? { lastTool: e.lastToolName } : {}),
        }),
      );
    case 'agent.end':
      // конец задачи, начала которой нет (старт отрезан `maxTurns`, старый транскрипт): узел без
      // типа и описания стал бы фантомным «субагентом» в карте и бейдже — пропускаем
      if (!s.agents.some((a) => a.agentId === e.agentId)) return s;
      return updateAgent(
        s,
        e.agentId,
        () => blank(e.agentId, e.taskId, e.summary ?? ''),
        (a) => ({
          ...a,
          status: e.status,
          endedAt: e.at ?? now,
          ...(e.summary ? { summary: e.summary } : {}),
          ...(e.totalTokens !== undefined ? { tokens: e.totalTokens } : {}),
          ...(e.toolUses !== undefined ? { toolUses: e.toolUses } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          segs: closeSegs(a.segs, e.at ?? now, e.status !== 'completed'),
        }),
      );
    default:
      break;
  }
  // события субагента — в его ход (строки «ход агента» и «текущий вызов»), основной не трогают
  if (e.agentId) return applySubagent(s, e.agentId, e, now);

  switch (e.type) {
    case 'session.init':
      return { ...s, subscription: e.apiKeySource === 'none' };
    case 'context.usage': {
      const prev = s.context;
      const max = e.maxTokens ?? prev?.max;
      const autoCompact = e.autoCompactThreshold ?? prev?.autoCompact;
      return {
        ...s,
        context: {
          used: e.usedTokens,
          ...(max !== undefined ? { max } : {}),
          ...(autoCompact !== undefined ? { autoCompact } : {}),
        },
      };
    }
    case 'compaction.start':
      return { ...s, compacting: true };
    case 'compaction.end': {
      const { compacting: _c, ...rest } = s;
      void _c;
      if (!e.ok || e.postTokens === undefined) return rest;
      const prev = s.context;
      return { ...rest, context: { ...prev, used: e.postTokens } };
    }
    case 'permission.request':
    case 'question.request':
    case 'plan.request':
      return setWaiting(
        s,
        e.toolUseId,
        e.type === 'permission.request'
          ? 'permission'
          : e.type === 'question.request'
            ? 'question'
            : 'plan',
      );
    case 'permission.resolved':
      return setWaiting(s, e.toolUseId, undefined);
    case 'usage.message': {
      const u = e.usage;
      let out = s;
      if (u.cacheRead + u.cacheWrite > 0) {
        const ttlMs =
          (u.cacheWrite1h ?? 0) > 0 ? TTL_1H : (u.cacheWrite5m ?? 0) > 0 ? TTL_5M : s.cache.ttlMs;
        out = {
          ...out,
          cache: { lastAt: e.at ?? now, ...(ttlMs !== undefined ? { ttlMs } : {}) },
        };
      }
      return out;
    }
    case 'turn.start': {
      const closed = s.turns.map((t) =>
        t.endedAt === undefined ? { ...closeAll(t, e.at, true), endedAt: e.at } : t,
      );
      return {
        ...s,
        turns: [...closed, { startedAt: e.at, segs: [] }].slice(-KEEP_TURNS),
        // ход-пробуждение (без промпта) продолжает ход пользователя: его агенты — те же «за ход»
        ...(e.prompt !== undefined || e.prompts ? { turnNo: s.turnNo + 1 } : {}),
      };
    }
    case 'thinking.start': {
      const { state, turn } = ensureTurn(s, e.at);
      const t = closeText(turn, e.at);
      return withTurn(state, {
        ...t,
        segs: [...t.segs, { id: e.messageId, kind: 'think', at: e.at, state: 'run' }],
      });
    }
    case 'thinking.stop': {
      const turn = activeTurn(s);
      if (!turn) return s;
      return withTurn(
        s,
        patchSeg(turn, (g) => g.kind === 'think' && g.id === e.messageId, {
          endAt: e.at,
          state: 'ok',
        }),
      );
    }
    case 'text.delta': {
      const { state, turn } = ensureTurn(s, now);
      const last = turn.segs[turn.segs.length - 1];
      if (last && last.kind === 'text' && last.id === e.messageId && last.endAt === undefined) {
        return state;
      }
      const t = closeText(turn, now);
      return withTurn(state, {
        ...t,
        segs: [...t.segs, { id: e.messageId, kind: 'text', at: now, state: 'run' }],
      });
    }
    case 'tool.start': {
      const at = e.at ?? now;
      const { state, turn } = ensureTurn(s, at);
      const t = closeText(turn, at);
      return withTurn(state, {
        ...t,
        segs: [
          ...t.segs,
          { id: e.toolUseId, kind: 'tool', name: e.name, input: e.input, at, state: 'run' },
        ],
      });
    }
    case 'tool.result': {
      const turn = activeTurn(s);
      if (!turn) return s;
      const seg = turn.segs.find((g) => g.kind === 'tool' && g.id === e.toolUseId);
      if (!seg) return s;
      const endAt =
        e.durationMs !== undefined ? seg.at + e.durationMs : (e.at ?? Math.max(now, seg.at));
      const detail = toolDetail(seg.name ?? '', seg.input ?? {}, e.result);
      return withTurn(
        s,
        patchSeg(turn, (g) => g.kind === 'tool' && g.id === e.toolUseId, {
          endAt,
          state: e.isError ? 'err' : 'ok',
          ...(detail ? { detail } : {}),
        }),
      );
    }
    case 'turn.result': {
      const turn = activeTurn(s);
      let out = s;
      let at = now;
      if (turn) {
        const endedAt = turn.startedAt + e.durationMs;
        const closeAt = Math.max(endedAt, ...turn.segs.map((g) => g.endAt ?? g.at));
        at = Math.max(endedAt, closeAt);
        out = withTurn(s, {
          ...closeAll(turn, closeAt, e.interrupted),
          endedAt: at,
        });
      }
      // Ход основного кончился — агенты переднего плана кончились с ним (он ждёт их результата). Без
      // их уведомления (Esc посреди работы агентов) они «бежали» бы вечно; позднее `agent.end` поправит итог.
      if (out.agents.some((a) => a.status === 'running' && !a.background)) {
        out = {
          ...out,
          agents: out.agents.map((a) =>
            a.status === 'running' && !a.background
              ? { ...a, status: 'stopped' as const, endedAt: at, segs: closeSegs(a.segs, at, true) }
              : a,
          ),
        };
      }
      const u = e.usage;
      const t = out.totals;
      const { compacting: _c, ...calm } = out;
      void _c;
      return {
        ...calm,
        ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}),
        totals: {
          // `total_cost_usd` движка — накопленная стоимость сессии (с базой при resume)
          costUsd: e.totalCostUsd,
          turns: t.turns + 1,
          durationMs: t.durationMs + e.durationMs,
          input: t.input + u.input,
          cacheRead: t.cacheRead + u.cacheRead,
          cacheWrite: t.cacheWrite + u.cacheWrite,
        },
      };
    }
    case 'session.closed': {
      // процесс движка ушёл — его задачи тоже: не «бегут» (тик, кнопка ■ в никуда)
      const agents = s.agents.map((a) =>
        a.status === 'running'
          ? { ...a, status: 'stopped' as const, endedAt: now, segs: closeSegs(a.segs, now, true) }
          : a,
      );
      const { compacting: _c, ...calm } = s;
      void _c;
      const out = { ...calm, agents };
      const turn = activeTurn(out);
      if (!turn) return out;
      return withTurn(out, { ...closeAll(turn, now, true), endedAt: now });
    }
    default:
      return s;
  }
}

/** Незакрытые строки хода агента — закрыть: агент закончился или остановлен. */
function closeSegs(segs: TimelineSeg[], at: number, stopped: boolean): TimelineSeg[] {
  if (!segs.some((g) => g.endAt === undefined)) return segs;
  return segs.map((g) =>
    g.endAt !== undefined
      ? g
      : { ...g, endAt: Math.max(at, g.at), state: g.kind === 'tool' && stopped ? 'stopped' : 'ok' },
  );
}

/**
 * Событие субагента → его ход. Агента ещё нет (`agent.start` не пришёл) — событие теряется: без
 * задачи его некуда приписать (живой движок шлёт `task_started` раньше сообщений агента).
 */
function applySubagent(s: HudState, agentId: string, e: AgentEvent, now: number): HudState {
  const i = s.agents.findIndex((a) => a.agentId === agentId);
  if (i < 0) return s;
  const a = s.agents[i]!;
  const put = (next: AgentNode): HudState => {
    const agents = s.agents.slice();
    agents[i] = next;
    return { ...s, agents };
  };
  const add = (seg: TimelineSeg, call = false): HudState => {
    const segs = closeText({ startedAt: a.startedAt, segs: a.segs }, seg.at).segs;
    return put({
      ...a,
      segs: [...segs, seg].slice(-MAX_AGENT_SEGS),
      calls: a.calls + (call ? 1 : 0),
    });
  };
  switch (e.type) {
    case 'usage.message':
      return a.model || !e.model ? s : put({ ...a, model: e.model });
    case 'tool.start':
      // повторная доставка или поздний вызов уже закончившегося агента — его ход не трогаем
      if (a.status !== 'running' || a.segs.some((g) => g.id === e.toolUseId)) return s;
      return add(
        {
          id: e.toolUseId,
          kind: 'tool',
          name: e.name,
          input: e.input,
          at: e.at ?? now,
          state: 'run',
        },
        true,
      );
    case 'tool.result': {
      const seg = a.segs.find((g) => g.kind === 'tool' && g.id === e.toolUseId);
      if (!seg) return s;
      const endAt =
        e.durationMs !== undefined ? seg.at + e.durationMs : (e.at ?? Math.max(now, seg.at));
      const detail = toolDetail(seg.name ?? '', seg.input ?? {}, e.result);
      const t = patchSeg({ startedAt: a.startedAt, segs: a.segs }, (g) => g === seg, {
        endAt,
        state: e.isError ? 'err' : 'ok',
        ...(detail ? { detail } : {}),
      });
      return put({ ...a, segs: t.segs });
    }
    case 'thinking.start':
      return add({ id: e.messageId, kind: 'think', at: e.at, state: 'run' });
    case 'thinking.stop': {
      const t = patchSeg(
        { startedAt: a.startedAt, segs: a.segs },
        (g) => g.kind === 'think' && g.id === e.messageId && g.endAt === undefined,
        { endAt: e.at, state: 'ok' },
      );
      return put({ ...a, segs: t.segs });
    }
    case 'text.delta': {
      const last = a.segs[a.segs.length - 1];
      if (last && last.kind === 'text' && last.id === e.messageId) return s;
      return add({ id: e.messageId, kind: 'text', at: now, state: 'run' });
    }
    default:
      return s;
  }
}

/** Пометить строку инструмента «ждёт человека» (или снять пометку). */
function setWaiting(s: HudState, toolUseId: string, waiting: TimelineSeg['waiting']): HudState {
  const turn = activeTurn(s);
  if (!turn) return s;
  const i = turn.segs.findIndex((g) => g.kind === 'tool' && g.id === toolUseId);
  if (i < 0) return s;
  const segs = turn.segs.slice();
  const { waiting: _w, ...seg } = segs[i]!;
  void _w;
  segs[i] = waiting ? { ...seg, waiting } : seg;
  return withTurn(s, { ...turn, segs });
}

function toolDetail(name: string, input: Record<string, unknown>, result: unknown): string {
  const stats = editStats(name, input, result);
  if (stats) return `+${formatInt(stats.add)} −${formatInt(stats.del)}`;
  const n = matchCount(name, result);
  return n !== undefined ? String(n) : '';
}
