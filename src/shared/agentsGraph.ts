/**
 * Снимок карты агентов для вкладки графа (roadmap 11, этап 2). `HudState` живёт в webview чата; граф —
 * отдельная вкладка редактора, поэтому чат шлёт сериализуемое подмножество через хост (`agents.snapshot`).
 * Типы повторяют `AgentNode`/`TimelineSeg` из `src/webview/hudState.ts` (хост не тянет модули webview);
 * совместимость в обе стороны проверяет компилятор в `agentViews.ts`.
 */

/** Сколько последних строк хода агента уходит в снимок. */
export const GRAPH_SEGS = 8;

export interface GraphSeg {
  id: string;
  kind: 'think' | 'tool' | 'text';
  name?: string;
  /** Вход инструмента; длинные строки обрезаны (`Write` несёт весь файл) — для подписи хватает начала. */
  input?: Record<string, unknown>;
  at: number;
  endAt?: number;
  state: 'run' | 'ok' | 'err' | 'stopped';
  waiting?: 'permission' | 'question' | 'plan';
  detail?: string;
}

/** Субагент или фоновая задача — поля `AgentNode`, у `segs` только последние `GRAPH_SEGS`. */
export interface GraphAgent {
  agentId: string;
  taskId: string;
  description: string;
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
  turnNo: number;
  prompt?: string;
  model?: string;
  summary?: string;
  segs: GraphSeg[];
  calls: number;
}

export interface AgentGraphView {
  /** Название сессии — заголовок вкладки «Агенты · …». */
  title?: string;
  /** Рабочая папка: короткие пути в подписях вызовов. */
  cwd?: string;
  /** Основной агент. */
  main: {
    model?: string;
    /** Токены контекста; нет — ещё не известно. */
    used?: number;
    limit: number;
    /** `working` — отвечает, `waiting` — ждёт своих агентов, `idle` — ждёт задачу. */
    state: 'idle' | 'working' | 'waiting';
    /** Текущий ход пользователя (`HudState.turnNo`). */
    turnNo: number;
  };
  /** Таймлайны основного без сегментов: начало и конец хода (`HudState.turns`). */
  turns: { turnNo?: number; startedAt: number; endedAt?: number }[];
  /** Субагенты и фоновые задачи сессии. */
  agents: GraphAgent[];
}

const STATUSES = new Set(['running', 'completed', 'failed', 'stopped']);
const MAIN_STATES = new Set(['idle', 'working', 'waiting']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

function isGraphAgent(v: unknown): v is GraphAgent {
  return (
    isObj(v) &&
    typeof v.agentId === 'string' &&
    typeof v.taskId === 'string' &&
    typeof v.description === 'string' &&
    typeof v.taskType === 'string' &&
    typeof v.status === 'string' &&
    STATUSES.has(v.status) &&
    num(v.startedAt) &&
    num(v.turnNo) &&
    num(v.calls) &&
    optStr(v.parentAgentId) &&
    optStr(v.prompt) &&
    optStr(v.summary) &&
    Array.isArray(v.segs) &&
    v.segs.every((s) => isObj(s) && typeof s.id === 'string' && num(s.at))
  );
}

/** Проверка снимка, пришедшего снаружи (webview чата → хост → webview графа): форма, без глубины. */
export function isAgentGraphView(v: unknown): v is AgentGraphView {
  if (!isObj(v) || !isObj(v.main) || !Array.isArray(v.turns) || !Array.isArray(v.agents)) return false;
  const m = v.main;
  return (
    num(m.limit) &&
    num(m.turnNo) &&
    typeof m.state === 'string' &&
    MAIN_STATES.has(m.state) &&
    (m.used === undefined || num(m.used)) &&
    optStr(m.model) &&
    optStr(v.title) &&
    optStr(v.cwd) &&
    v.turns.every((t) => isObj(t) && num(t.startedAt)) &&
    v.agents.every(isGraphAgent)
  );
}
