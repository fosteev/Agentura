/**
 * Ходы ленты (roadmap 08, виды ленты): плоские строки `rows` → контейнеры-ходы и сводка свёрнутых действий.
 * Чистые функции, без Preact и DOM; вид (журнал, свёрнуто, реплики, карточки) — CSS по `data-feed`.
 */
import type { FeedRow } from './chatState';
import type { FeedItem } from './agentsView';
import { editStats, formatDuration, toolView } from './toolView';
import { ui } from './strings';

type UserRow = Extract<FeedRow, { kind: 'user' }>;
type SumRow = Extract<FeedRow, { kind: 'sum' }>;

/** Подряд идущие tool/think/agents — одна серия `.steps`; остальное (текст, карточки, sys) — по одному. */
export type TurnPart =
  | { kind: 'steps'; id: number; items: FeedItem[] }
  | { kind: 'item'; item: FeedItem };

export interface Turn {
  kind: 'turn';
  /** id строки `user`, у «безымянного» хода — id первой строки. */
  id: number;
  user?: UserRow;
  parts: TurnPart[];
  /** Закрывает ход; нет — ход идёт (или оборван без итога). */
  sum?: SumRow;
}

/** Строка вне хода: до первого `user` и `sys` между ходами. */
export interface Loose {
  kind: 'loose';
  item: FeedItem;
}

export type FeedBlock = Turn | Loose;

const isStep = (it: FeedItem): boolean =>
  it.kind === 'tool' || it.kind === 'think' || it.kind === 'agents';

/**
 * Ход открывает строка `user` (кроме «в очереди» посреди идущего хода — она остаётся в нём; на `turn.start`
 * лента переносит её в конец) и закрывает `sum` или ошибка без итога (карточка `fail` или погашенная —
 * `sys` с `tag: 'fail'`): она остаётся последней строкой хода. Ход, начатый движком без `user` (пробуждение
 * после фоновой задачи): не-`sys` строка после закрытого хода открывает «безымянный» ход. Строки до первого
 * хода и `sys` вне открытого хода остаются вне контейнеров.
 */
export function feedTurns(items: readonly FeedItem[]): FeedBlock[] {
  const out: FeedBlock[] = [];
  let cur: Turn | undefined; // открытый ход (без sum)
  let seenTurn = false; // был хотя бы один ход — тогда строка без user открывает безымянный
  const push = (t: Turn, it: FeedItem): void => {
    const last = t.parts[t.parts.length - 1];
    if (isStep(it)) {
      if (last?.kind === 'steps') last.items.push(it);
      else t.parts.push({ kind: 'steps', id: it.id, items: [it] });
    } else t.parts.push({ kind: 'item', item: it });
  };
  for (const it of items) {
    if (it.kind === 'user' && !(it.queued && cur)) {
      cur = { kind: 'turn', id: it.id, user: it, parts: [] };
      out.push(cur);
      seenTurn = true;
      continue;
    }
    if (it.kind === 'sum') {
      if (cur) {
        cur.sum = it;
        cur = undefined;
      } else if (seenTurn) {
        // итог без открытого хода (оборванная лента): безымянный закрытый ход
        out.push({ kind: 'turn', id: it.id, parts: [], sum: it });
      } else out.push({ kind: 'loose', item: it });
      continue;
    }
    if (cur) {
      push(cur, it);
      if (it.kind === 'fail' || (it.kind === 'sys' && it.tag === 'fail')) cur = undefined;
      continue;
    }
    if (it.kind === 'sys' || !seenTurn) {
      out.push({ kind: 'loose', item: it });
      continue;
    }
    cur = { kind: 'turn', id: it.id, parts: [] };
    out.push(cur);
    push(cur, it);
  }
  return out;
}

/** Действия хода: tool + think + агенты (группа агентов — по числу агентов). */
export function stepRows(items: readonly FeedItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const it of items) {
    if (it.kind === 'agents') rows.push(...it.rows);
    else if (it.kind === 'tool' || it.kind === 'think') rows.push(it);
  }
  return rows;
}

export interface FoldOp {
  op: string;
  /** Сколько раз встретилась (`read ×2`). */
  times: number;
  /** Сумма `+a −d` у edit/write. */
  add?: number;
  del?: number;
  /** У bash — итог последнего запуска: длительность или «ошибка». */
  result?: string;
  /** Результат красный (ошибка). */
  bad?: boolean;
}

export interface StripSeg {
  /** `th` — think, `ed` — edit/write, `rn` — bash, `''` — остальное. */
  cls: 'th' | 'ed' | 'rn' | '';
  /** Вес сегмента: `durationMs` (не меньше 1). */
  flex: number;
}

export interface FoldSummary {
  /** Число tool + think строк (агенты — по числу агентов). */
  count: number;
  ops: FoldOp[];
  /** Суммарное время рассуждений, мс (0 — не было). */
  thinkMs: number;
  strip: StripSeg[];
  /** Сумма `durationMs` строк, мс. */
  durationMs: number;
}

export const MAX_STRIP = 40;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Сводка свёрнутого хода по его строкам-действиям (`stepRows`). `now` — для ещё идущих think. */
export function foldSummary(rows: readonly FeedRow[], now?: number): FoldSummary {
  const ops: FoldOp[] = [];
  const strip: StripSeg[] = [];
  let thinkMs = 0;
  let durationMs = 0;
  let count = 0;
  const seg = (cls: StripSeg['cls'], ms: number): void => {
    if (strip.length < MAX_STRIP) strip.push({ cls, flex: Math.max(1, Math.round(ms)) });
  };
  for (const r of rows) {
    if (r.kind === 'think') {
      count++;
      const ms = Math.max(0, (r.endedAt ?? now ?? r.startedAt) - r.startedAt);
      thinkMs += ms;
      durationMs += ms;
      seg('th', ms);
    } else if (r.kind === 'tool') {
      count++;
      const ms = r.durationMs ?? 0;
      durationMs += ms;
      seg(EDIT_TOOLS.has(r.name) ? 'ed' : r.name === 'Bash' ? 'rn' : '', ms);
      const op = toolView(r.name, r.input).op;
      let o = ops.find((x) => x.op === op);
      if (!o) ops.push((o = { op, times: 0 }));
      o.times++;
      const stats = editStats(r.name, r.input, r.result);
      if (stats) {
        o.add = (o.add ?? 0) + stats.add;
        o.del = (o.del ?? 0) + stats.del;
      }
      if (r.name === 'Bash') {
        if (r.state === 'err') {
          o.result = ui.log.toolError;
          o.bad = true;
        } else if (r.state === 'ok' && r.durationMs !== undefined) {
          o.result = formatDuration(r.durationMs);
          delete o.bad;
        }
      }
    }
  }
  return { count, ops, thinkMs, strip, durationMs };
}
