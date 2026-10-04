import { describe, expect, it } from 'vitest';
import {
  agentOpen,
  agentTurns,
  agentsViewPane,
  axisTicks,
  cardList,
  cardView,
  defaultScope,
  estLabel,
  estTokens,
  laneView,
  pickSelected,
} from './agentViews';
import { initialHud, type AgentNode, type HudState, type TimelineSeg } from './hudState';

const T0 = 1_000_000;
const now = T0 + 100_000;

const seg = (
  id: string,
  at: number,
  endAt: number | undefined,
  o: Partial<TimelineSeg> = {},
): TimelineSeg => ({
  id,
  kind: 'tool',
  name: 'Read',
  input: { file_path: '/repo/a.ts' },
  at,
  ...(endAt !== undefined ? { endAt } : {}),
  state: endAt === undefined ? 'run' : 'ok',
  ...o,
});

const agent = (id: string, o: Partial<AgentNode> = {}): AgentNode => ({
  agentId: id,
  taskId: `t-${id}`,
  description: `задача ${id}`,
  taskType: 'local_agent',
  subagentType: 'Explore',
  background: false,
  status: 'completed',
  startedAt: T0 + 5_000,
  endedAt: T0 + 45_000,
  durationMs: 40_000,
  tokens: 9_400,
  turnNo: 14,
  segs: [],
  calls: 0,
  ...o,
});

const shell = (id: string, o: Partial<AgentNode> = {}): AgentNode => ({
  agentId: id,
  taskId: `t-${id}`,
  description: 'pnpm dev',
  taskType: 'local_bash',
  background: true,
  status: 'running',
  startedAt: T0 - 360_000,
  turnNo: 11,
  segs: [],
  calls: 0,
  ...o,
});

function hud(agents: AgentNode[], o: Partial<HudState> = {}): HudState {
  return {
    ...initialHud(),
    turnNo: 14,
    turns: [{ turnNo: 14, startedAt: T0, segs: [] }],
    agents,
    ...o,
  };
}

const o = { now };

describe('estTokens / estLabel', () => {
  it('ceil(len / 4); подпись всегда с «≈»', () => {
    expect(estTokens('')).toBe(0);
    expect(estTokens('abcd')).toBe(1);
    expect(estTokens('abcde')).toBe(2);
    expect(estLabel(85)).toBe('≈85');
    expect(estLabel(400)).toBe('≈0.4k');
    expect(estLabel(2100)).toBe('≈2.1k');
    expect(estLabel(143_000)).toBe('≈143k');
  });
});

describe('agentTurns', () => {
  const agents = [
    agent('a', { turnNo: 9, subagentType: 'Plan' }),
    agent('b', { turnNo: 12 }),
    agent('c', { turnNo: 12, status: 'failed', summary: 'ECONNREFUSED' }),
    agent('d', { turnNo: 14, status: 'running', endedAt: undefined, durationMs: undefined }),
    shell('s'),
    shell('done', { status: 'completed', turnNo: 4, endedAt: T0 - 10_000 }),
  ];
  const h = hud(agents);

  it('scope=turn: один ход — последний с агентами; идущая фоновая задача с пометкой «с хода»', () => {
    const g = agentTurns(h, 'turn', o);
    expect(g.map((x) => x.turnNo)).toEqual([14]);
    expect(g[0]!.agents.map((a) => a.agentId)).toEqual(['d']);
    expect(g[0]!.tasks.map((t) => [t.agentId, t.since])).toEqual([['s', 11]]);
    expect(g[0]!.live).toBe(true);
  });

  it('scope=turn: идущий агент старого хода показан в последнем', () => {
    const old = hud([agent('a', { turnNo: 12, status: 'running' }), agent('b', { turnNo: 14 })]);
    const g = agentTurns(old, 'turn', o)[0]!;
    expect(g.agents.map((a) => a.agentId)).toEqual(['a', 'b']);
  });

  it('scope=session: новые сверху; ходы без агентов и задач не попадают; задача — в своём ходе', () => {
    const g = agentTurns(h, 'session', o);
    expect(g.map((x) => x.turnNo)).toEqual([14, 12, 9, 4]);
    // идущий shell из хода 11 перенесён под последний ход, ход 11 пуст и пропущен
    expect(g[0]!.tasks.map((t) => t.agentId)).toEqual(['s']);
    expect(g[3]!.tasks.map((t) => t.agentId)).toEqual(['done']);
    expect(g[3]!.agents).toEqual([]);
  });

  it('kinds, счётчики и токены хода', () => {
    const g12 = agentTurns(h, 'session', o).find((x) => x.turnNo === 12)!;
    expect(g12.kinds).toBe('Explore ×2');
    expect(g12.counts).toEqual({ ok: 1, err: 1, run: 0, stop: 0 });
    expect(g12.tokens).toBe(18_800);
    expect(g12.live).toBe(false);
    expect(g12.endedAt).toBe(T0 + 45_000);
    const g9 = agentTurns(h, 'session', o).find((x) => x.turnNo === 9)!;
    expect(g9.kinds).toBe('Plan');
  });

  it('вложенные субагенты — по parentAgentId; родитель вне хода — верхний уровень', () => {
    const g = agentTurns(
      hud([
        agent('p'),
        agent('k', { parentAgentId: 'p' }),
        agent('x', { parentAgentId: 'нет-такого' }),
      ]),
      'turn',
      o,
    )[0]!;
    expect(g.agents.map((a) => [a.agentId, a.depth, a.parentId])).toEqual([
      ['p', 0, undefined],
      ['k', 1, 'p'],
      ['x', 0, undefined],
    ]);
  });

  it('нет агентов — нет ходов', () => {
    expect(agentTurns(hud([]), 'turn', o)).toEqual([]);
    expect(agentTurns(hud([]), 'session', o)).toEqual([]);
  });

  it('старт хода — по таймлайну основного, иначе по самому раннему агенту', () => {
    expect(agentTurns(hud([agent('a')]), 'turn', o)[0]!.startedAt).toBe(T0);
    const g = agentTurns(hud([agent('a')], { turns: [] }), 'turn', o)[0]!;
    expect(g.startedAt).toBe(T0 + 5_000);
    // без таймлайна: старт — по узлам своего хода, а не по фоновой задаче / идущему агенту другого хода
    const mixed = agentTurns(
      hud(
        [
          agent('a'),
          shell('s'),
          agent('old', { turnNo: 9, status: 'running', startedAt: T0 - 900_000 }),
        ],
        {
          turns: [],
        },
      ),
      'turn',
      o,
    )[0]!;
    expect(mixed.startedAt).toBe(T0 + 5_000);
    // таймлайн без времени (история, startedAt 0) не берётся — ось не от эпохи
    const zero = agentTurns(
      hud([agent('a')], { turns: [{ turnNo: 14, startedAt: 0, segs: [] }] }),
      'turn',
      o,
    )[0]!;
    expect(zero.startedAt).toBe(T0 + 5_000);
  });

  it('цикл в parentAgentId — агенты не пропадают', () => {
    const g = agentTurns(
      hud([agent('a', { parentAgentId: 'b' }), agent('b', { parentAgentId: 'a' }), agent('c')]),
      'turn',
      o,
    )[0]!;
    expect(g.agents.map((l) => l.agentId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('pickSelected: заданный, иначе первый идущий, иначе первый', () => {
    const g = agentTurns(hud([agent('a'), agent('b', { status: 'running' })]), 'turn', o);
    expect(pickSelected(g, 'a')).toBe('a');
    expect(pickSelected(g, 'zzz')).toBe('b');
    expect(pickSelected(g)).toBe('b');
    const done = agentTurns(hud([agent('a'), agent('c')]), 'turn', o);
    expect(pickSelected(done)).toBe('a');
    expect(pickSelected([])).toBeUndefined();
  });
});

describe('axisTicks', () => {
  it('3–5 меток для ходов от 3 с до суток', () => {
    for (const s of [
      3, 4, 7, 12, 16, 20, 25, 40, 59, 78, 100, 200, 400, 777, 1500, 2400, 5000, 7200, 20_000,
      86_400,
    ]) {
      const n = axisTicks(s * 1000).length;
      expect(n, `${s}s`).toBeGreaterThanOrEqual(3);
      expect(n, `${s}s`).toBeLessThanOrEqual(5);
    }
  });

  it('шаг из ряда 10s…30m; подписи m:ss, позиции в процентах', () => {
    expect(axisTicks(100_000).map((t) => t.label)).toEqual(['0', '0:30', '1:00', '1:30']);
    expect(axisTicks(100_000).map((t) => t.pct)).toEqual([0, 30, 60, 90]);
    expect(axisTicks(40_000).map((t) => t.label)).toEqual(['0', '0:10', '0:20', '0:30', '0:40']);
    expect(axisTicks(55_000).map((t) => t.label)).toEqual(['0', '0:15', '0:30', '0:45']);
    expect(axisTicks(1_000_000).map((t) => t.label)).toEqual(['0', '5:00', '10:00', '15:00']);
    expect(axisTicks(3 * 3600_000).map((t) => t.label)).toEqual(['0', '1h', '2h', '3h']);
    expect(axisTicks(90 * 60_000).map((t) => t.label)).toEqual(['0', '30:00', '1h', '1h30']);
  });

  it('нелепо длинный ход (дни) — всё равно не больше пяти меток', () => {
    for (const d of [2, 10, 400, 20_000]) {
      expect(axisTicks(d * 86_400_000).length).toBeLessThanOrEqual(5);
    }
  });
});

describe('laneView', () => {
  const think = seg('th', T0, T0 + 6_000, { kind: 'think', name: undefined, input: undefined });
  const call = seg('m1', T0 + 1_000, T0 + 2_000);
  const agentCall = seg('ag', T0 + 5_000, T0 + 80_000, { name: 'Agent', input: {} });
  const turns = [{ turnNo: 14, startedAt: T0, segs: [think, call, agentCall] }];

  const base = [
    agent('a', { startedAt: T0 + 5_000, endedAt: T0 + 45_000 }),
    agent('b', {
      status: 'running',
      endedAt: undefined,
      durationMs: undefined,
      startedAt: T0 + 5_000,
    }),
    agent('e', {
      status: 'failed',
      startedAt: T0 + 5_000,
      endedAt: T0 + 27_000,
      summary: 'x',
    }),
  ];
  const lanesOf = (h: HudState, scope: 'turn' | 'session' = 'turn') => {
    const g = agentTurns(h, scope, o)[0]!;
    return laneView(h, g, now);
  };

  it('ось от старта таймлайна основного до now; дорожка на каждого агента, основной первым', () => {
    const lv = lanesOf(hud(base, { turns }));
    expect(lv.spanMs).toBe(100_000);
    expect(lv.axis.length).toBeGreaterThanOrEqual(3);
    expect(lv.lanes.map((l) => l.key)).toEqual(['main', 'a', 'b', 'e']);
    const a = lv.lanes[1]!;
    expect(a.bars[0]).toMatchObject({ cls: 'ok', from: 5, to: 45 });
    expect(lv.lanes[2]!.bars[0]).toMatchObject({ cls: 'busy', from: 5, to: 100 });
    expect(lv.lanes[3]!.bars[0]).toMatchObject({ cls: 'err', from: 5, to: 27 });
  });

  it('линия «сейчас» — у идущих и у основного идущего хода', () => {
    const lv = lanesOf(hud(base, { turns }));
    expect(lv.lanes.map((l) => l.now)).toEqual([100, undefined, 100, undefined]);
  });

  it('основной: think и инструменты, вызов Agent не полоса, «ждёт» от первого старта до конца последнего', () => {
    const lv = lanesOf(hud(base, { turns }));
    const main = lv.lanes[0]!;
    expect(main.bars.map((b) => b.cls)).toEqual(['think', 'tool', 'wait']);
    expect(main.bars[2]).toMatchObject({ from: 5, to: 100 });
  });

  it('нет таймлайна хода — ось от самого раннего агента', () => {
    const lv = lanesOf(hud(base, { turns: [] }));
    expect(lv.lanes[1]!.bars[0]!.from).toBe(0);
    expect(lv.spanMs).toBe(now - (T0 + 5_000));
  });

  it('фоновая задача, стартовавшая раньше оси, — от 0 с меткой «↤»', () => {
    const lv = lanesOf(hud([...base, shell('s')], { turns }));
    const sh = lv.lanes.at(-1)!;
    expect(sh.shell).toBe(true);
    expect(sh.bars[0]).toMatchObject({ cls: 'sh', from: 0, before: true });
    expect(sh.now).toBe(100);
    expect(sh).toMatchObject({ mark: '◐', status: 'busy' });
    const done = lanesOf(
      hud(
        [
          ...base,
          shell('s', {
            status: 'completed',
            turnNo: 14,
            startedAt: T0 + 1_000,
            endedAt: T0 + 20_000,
          }),
        ],
        { turns },
      ),
    );
    expect(done.lanes.find((l) => l.key === 's')).toMatchObject({ mark: '○', status: 'ok' });
  });

  it('полосы не выходят за 100%: короткая полоса у правого края сдвигается влево', () => {
    const lv = lanesOf(
      hud([...base, agent('z', { startedAt: now, endedAt: now, durationMs: 0 })], { turns }),
    );
    for (const l of lv.lanes)
      for (const b of l.bars) {
        expect(b.from, l.key).toBeGreaterThanOrEqual(0);
        expect(b.to, l.key).toBeLessThanOrEqual(100);
        expect(b.to - b.from, l.key).toBeGreaterThan(0);
        expect(Number.isFinite(b.from) && Number.isFinite(b.to)).toBe(true);
      }
  });

  it('засечки вызовов ≤ 60: у агента с сотнями вызовов лишние сливаются', () => {
    const segs = Array.from({ length: 200 }, (_, i) =>
      seg(`s${i}`, T0 + 5_000 + i * 150, T0 + 5_100 + i * 150),
    );
    const lv = lanesOf(hud([agent('big', { segs, calls: 200 })], { turns }));
    const ticks = lv.lanes[1]!.bars[0]!.ticks!;
    expect(ticks.length).toBeLessThanOrEqual(60);
    expect(ticks.length).toBeGreaterThan(10);
    expect(ticks.every((t) => t >= 0 && t <= 100)).toBe(true);
  });

  it('завершённый ход: ось до последнего окончания, линии «сейчас» нет', () => {
    const h = hud([agent('a')], {
      turns: [{ turnNo: 14, startedAt: T0, endedAt: T0 + 50_000, segs: [] }],
    });
    const lv = lanesOf(h);
    expect(lv.spanMs).toBe(50_000);
    expect(lv.lanes.every((l) => l.now === undefined)).toBe(true);
  });
});

describe('cardView / cardList', () => {
  it('идущие → упавшие и остановленные → готовые; внутри — по старту', () => {
    const h = hud([
      agent('ok1', { startedAt: T0 + 1_000 }),
      agent('run1', { status: 'running', startedAt: T0 + 9_000 }),
      agent('err1', { status: 'failed', startedAt: T0 + 3_000, summary: 'boom' }),
      agent('run0', { status: 'running', startedAt: T0 + 2_000 }),
      agent('stop1', { status: 'stopped', startedAt: T0 + 1_500 }),
    ]);
    const g = agentTurns(h, 'turn', o)[0]!;
    expect(cardList(g, now).map((c) => c.line.agentId)).toEqual([
      'run0',
      'run1',
      'stop1',
      'err1',
      'ok1',
    ]);
  });

  it('идущая: текущий вызов и полоска из ≤ 20 состояний; готовая: выдержка и оценка итога', () => {
    const segs = Array.from({ length: 30 }, (_, i) =>
      seg(`s${i}`, T0 + i * 100, i === 29 ? undefined : T0 + i * 100 + 50),
    );
    const run = cardView(
      agent('r', { status: 'running', segs, calls: 30, model: 'claude-sonnet-5-5' }),
      now,
    );
    expect(run.live).toMatch(/^read/);
    expect(run.cells).toHaveLength(20);
    expect(run.cells.at(-1)).toBe('gr');
    expect(run.cells[0]).toBe('rd');
    expect(run.kind).toBe('Explore · sonnet-5.5');
    expect(run.resultEst).toBeNull();

    const summary = 'Найдено   одно место:\nQueue.tsx:58 — ' + 'x'.repeat(400);
    const done = cardView(agent('d', { summary }), now);
    expect(done.live).toBeNull();
    expect(done.excerpt.length).toBeLessThanOrEqual(201);
    expect(done.excerpt.startsWith('Найдено одно место: Queue.tsx:58')).toBe(true);
    expect(done.excerpt.endsWith('…')).toBe(true);
    expect(done.resultEst).toBe(estLabel(estTokens(summary)));

    const err = cardView(agent('e', { status: 'failed', summary: 'ECONNREFUSED' }), now);
    expect(err.excerpt).toBe('ECONNREFUSED');
    expect(err.resultEst).toBeNull();
  });
});

describe('agentOpen / agentsViewPane', () => {
  it('промпт и итог с оценкой, три последних вызова, транскрипт только при сессии', () => {
    const segs = Array.from({ length: 6 }, (_, i) =>
      seg(`s${i}`, T0 + i * 1000, T0 + i * 1000 + 400),
    );
    const a = agent('a', { segs, calls: 6, prompt: 'x'.repeat(2400), summary: 'готово' });
    const d = agentOpen(a, now);
    expect(d.rows).toHaveLength(3);
    expect(d.promptLabel).toContain('≈0.6k');
    expect(d.callsLabel).toContain('6');
    expect(d.summary).toBe('готово');
    expect(d.transcript).toBe(true);
    expect(agentOpen(a, now, undefined, false).transcript).toBe(false);
    expect(d.stopTaskId).toBeUndefined();
    expect(agentOpen(agent('r', { status: 'running' }), now).stopTaskId).toBe('t-r');
  });

  it('модель панели: охват по умолчанию по виду, выбранный агент раскрыт, карточки без деталей', () => {
    expect([defaultScope('tree'), defaultScope('lanes'), defaultScope('cards')]).toEqual([
      'session',
      'turn',
      'turn',
    ]);
    const h = hud([agent('a'), agent('b', { status: 'running' })]);
    const opts = { working: true, waiting: true, now };
    const tree = agentsViewPane(h, 'tree', 'session', { ...opts, selected: 'a' });
    expect(tree.selectedId).toBe('a');
    expect(tree.open?.agentId).toBe('a');
    const cards = agentsViewPane(h, 'cards', 'turn', opts);
    expect(cards.open).toBeUndefined();
    expect(cards.cardsOf(0)).toHaveLength(2);
    expect(cards.cardsOf(0)).toBe(cards.cardsOf(0)); // запомнено
    expect(cards.cardsOf(5)).toEqual([]);
    expect(cards.statusLine).toBe('1 идёт · 1 готово');
    const lanes = agentsViewPane(h, 'lanes', 'turn', opts);
    expect(lanes.laneOf(0)!.lanes).toHaveLength(3);
    expect(lanes.laneOf(5)).toBeUndefined();
  });
});
