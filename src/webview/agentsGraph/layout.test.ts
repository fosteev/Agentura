import { describe, expect, it } from 'vitest';
import { GRAPH_SIZES as S, graphLayout, type Box } from './layout';

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const cy = (b: Box) => b.y + b.h / 2;

describe('graphLayout', () => {
  const input = {
    agents: [
      { id: 'a', depth: 0 },
      { id: 'b', depth: 0 },
      { id: 'b1', depth: 1, parentId: 'b' },
      { id: 'c', depth: 0 },
    ],
    tasks: [{ id: 'dev' }],
  };

  it('основной слева по центру агентов; агенты колонкой, вложенные — следующей, фоновые — ниже', () => {
    const l = graphLayout(input, 400, 200);
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    expect(l.main.x).toBe(S.pad);
    const col = ['a', 'b', 'c'].map(at);
    expect(new Set(col.map((n) => n.x)).size).toBe(1);
    expect(col[0]!.x).toBeGreaterThan(l.main.x + l.main.w);
    expect(at('b1').x).toBeGreaterThan(col[0]!.x + col[0]!.w);
    // строка на агента в порядке дерева
    expect(['a', 'b', 'b1', 'c'].map((id) => at(id).y)).toEqual(
      [0, 1, 2, 3].map((i) => S.top + i * S.step),
    );
    // основной — по центру строк агентов
    const agents = l.nodes.filter((n) => n.kind === 'agent');
    const mid = (Math.min(...agents.map((n) => n.y)) + Math.max(...agents.map((n) => n.y + n.h))) / 2;
    expect(Math.abs(cy(l.main) - mid)).toBeLessThanOrEqual(1);
    // фоновая — ниже всех агентов, в колонке агентов
    expect(at('dev').kind).toBe('task');
    expect(at('dev').x).toBe(col[0]!.x);
    expect(at('dev').y).toBeGreaterThan(Math.max(...agents.map((n) => n.y + n.h)));
    // узлы не налезают друг на друга и на основной
    const all = [l.main, ...l.nodes];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!)).toBe(false);
    // холст вмещает всё, даже если видимая область меньше
    expect(l.width).toBeGreaterThanOrEqual(Math.max(...l.nodes.map((n) => n.x + n.w)));
    expect(l.height).toBeGreaterThanOrEqual(Math.max(...l.nodes.map((n) => n.y + n.h)));
  });

  it('рёбра: от основного к агентам и фоновым, от родителя к вложенному; кубические кривые', () => {
    const l = graphLayout(input, 400, 200);
    expect(l.edges.map((e) => [e.id, e.from])).toEqual([
      ['a', 'main'],
      ['b', 'main'],
      ['b1', 'b'],
      ['c', 'main'],
      ['dev', 'main'],
    ]);
    const b = l.nodes.find((n) => n.id === 'b')!;
    const b1 = l.nodes.find((n) => n.id === 'b1')!;
    const e = l.edges.find((x) => x.id === 'b1')!;
    expect(e.d).toBe(
      `M${b.x + b.w} ${Math.round(cy(b))} C${Math.round((b.x + b.w + b1.x) / 2)} ${Math.round(cy(b))} ${Math.round((b.x + b.w + b1.x) / 2)} ${Math.round(cy(b1))} ${b1.x} ${Math.round(cy(b1))}`,
    );
    expect(l.edges.every((x) => /^M\d+ \d+ C\d+ \d+ \d+ \d+ \d+ \d+$/.test(x.d))).toBe(true);
    // подпись — у начала ребра, на высоте цели
    expect(e.label.x).toBe(b.x + b.w + 16);
    expect(e.label.y).toBeGreaterThanOrEqual(b1.y);
  });

  it('большая видимая область: граф по центру по высоте, холст — во всю область', () => {
    const small = graphLayout({ agents: [{ id: 'a', depth: 0 }], tasks: [] }, 1200, 900);
    expect(small.width).toBe(1200);
    expect(small.height).toBe(900);
    const a = small.nodes[0]!;
    expect(a.y).toBeGreaterThan(300);
    expect(Math.abs(cy(small.main) - cy(a))).toBeLessThanOrEqual(1);
  });

  it('только фоновые задачи — основной по их центру; пусто — только основной', () => {
    const t = graphLayout({ agents: [], tasks: [{ id: 'x' }] }, 100, 100);
    expect(t.main.y).toBe(S.top);
    expect(Math.abs(cy(t.main) - cy(t.nodes[0]!))).toBeLessThanOrEqual(1);
    const e = graphLayout({ agents: [], tasks: [] }, 100, 100);
    expect(e.nodes).toEqual([]);
    expect(e.edges).toEqual([]);
    expect(e.main.y).toBe(S.top);
  });
});
