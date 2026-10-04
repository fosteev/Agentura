/**
 * Раскладка графа агентов (roadmap 11, этап 2) — чистая функция, пиксели холста. Основной слева по
 * центру, агенты хода колонкой справа (строка на агента, порядок дерева), вложенные (`parentAgentId`) —
 * следующими колонками, фоновые задачи — ниже агентов. Рёбра — кубические кривые от правого края
 * источника к левому краю цели, подпись ребра — у его начала, на высоте цели (как в прототипе `.gmap`).
 * Зума и перетаскивания нет: не поместилось — холст прокручивается.
 */

export interface LayoutInput {
  /** Агенты хода в порядке дерева; `depth` 0 — от основного, `parentId` — родитель среди этих же. */
  agents: { id: string; depth: number; parentId?: string }[];
  tasks: { id: string }[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutNode extends Box {
  id: string;
  kind: 'agent' | 'task';
}

export interface LayoutEdge {
  /** Id цели. */
  id: string;
  /** Источник: `main` или id родителя. */
  from: string;
  /** SVG path: `M x1 y1 C … x2 y2`. */
  d: string;
  /** Левый верхний угол подписи. */
  label: { x: number; y: number };
}

export interface GraphLayout {
  width: number;
  height: number;
  main: Box;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** Размеры (px): поля, основной, зазор под рёбра, узел агента, вложенный узел, шаг строки. */
export const GRAPH_SIZES = {
  pad: 20,
  top: 20,
  bottom: 44,
  mainW: 180,
  mainH: 104,
  gap: 110,
  nodeW: 280,
  nestW: 240,
  nodeH: 64,
  step: 96,
  taskGap: 24,
} as const;

const S = GRAPH_SIZES;

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mx = Math.round((x1 + x2) / 2);
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

/** Левая граница колонки глубины `depth`. */
function columnX(depth: number): number {
  const first = S.pad + S.mainW + S.gap;
  return depth === 0 ? first : first + S.nodeW + S.gap + (depth - 1) * (S.nestW + S.gap);
}

/** `w`, `h` — видимый размер холста: граф центрируется по высоте, холст не меньше видимой области. */
export function graphLayout(view: LayoutInput, w: number, h: number): GraphLayout {
  const nodes: LayoutNode[] = [];
  view.agents.forEach((a, i) => {
    const depth = Math.max(0, a.depth);
    nodes.push({
      id: a.id,
      kind: 'agent',
      x: columnX(depth),
      y: S.top + i * S.step,
      w: depth === 0 ? S.nodeW : S.nestW,
      h: S.nodeH,
    });
  });
  const tasksTop = S.top + view.agents.length * S.step + (view.agents.length ? S.taskGap : 0);
  view.tasks.forEach((t, j) => {
    nodes.push({ id: t.id, kind: 'task', x: columnX(0), y: tasksTop + j * S.step, w: S.nodeW, h: S.nodeH });
  });

  // основной — по центру колонки агентов (нет агентов — фоновых задач)
  const col = nodes.filter((n) => n.kind === 'agent');
  const pool = col.length ? col : nodes;
  let center = pool.length
    ? (Math.min(...pool.map((n) => n.y)) + Math.max(...pool.map((n) => n.y + n.h))) / 2
    : S.top + S.mainH / 2;
  // основной выше колонки (один агент) — колонку вниз, чтобы центры совпали
  const lift = Math.ceil(S.top + S.mainH / 2 - center);
  if (lift > 0) {
    for (const n of nodes) n.y += lift;
    center += lift;
  }
  const main: Box = { x: S.pad, y: Math.round(center - S.mainH / 2), w: S.mainW, h: S.mainH };

  const bottom = Math.max(main.y + main.h, ...nodes.map((n) => n.y + n.h)) + S.bottom;
  const right = Math.max(main.x + main.w, ...nodes.map((n) => n.x + n.w)) + S.pad;
  // свободное место по высоте — граф по центру
  const dy = h > bottom ? Math.floor((h - bottom) / 2) : 0;
  if (dy) {
    main.y += dy;
    for (const n of nodes) n.y += dy;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mid = (b: Box) => Math.round(b.y + b.h / 2);
  const edges: LayoutEdge[] = [];
  for (const a of view.agents) {
    const to = byId.get(a.id)!;
    const parent = a.parentId ? byId.get(a.parentId) : undefined;
    const from: Box = parent ?? main;
    const x1 = from.x + from.w;
    const y1 = mid(from);
    edges.push({
      id: a.id,
      from: parent ? a.parentId! : 'main',
      d: curve(x1, y1, to.x, mid(to)),
      label: { x: x1 + 16, y: to.y + 6 },
    });
  }
  for (const t of view.tasks) {
    const to = byId.get(t.id)!;
    // фоновые — из нижней части основного, пунктиром
    const y1 = main.y + main.h - 16;
    edges.push({ id: t.id, from: 'main', d: curve(main.x + main.w, y1, to.x, mid(to)), label: { x: 0, y: 0 } });
  }

  return {
    width: Math.max(w, right),
    height: Math.max(h, bottom + dy),
    main,
    nodes,
    edges,
  };
}
