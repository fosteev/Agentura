import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyHud, initialHud, type HudState } from './hudState';
import type { AgentEvent } from '../agent/types';
import {
  cacheView,
  compactTokens,
  contextBlocks,
  contextFullAt,
  contextScale,
  contextView,
  contextZone,
  formatCountdown,
  limitLevel,
  limitMeter,
  limitsView,
  sessionTotals,
  segClass,
} from './hudView';
import { agentMapView } from './agentsView';

const TH = [120_000, 150_000];
const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;

describe('контекст: зона и цвет по порогам', () => {
  it('ok до первого порога, warn до второго, hot до конца шкалы, full на конце', () => {
    expect(contextZone(0, TH, 200_000)).toBe('ok');
    expect(contextZone(119_999, TH, 200_000)).toBe('ok');
    expect(contextZone(120_000, TH, 200_000)).toBe('warn');
    expect(contextZone(149_999, TH, 200_000)).toBe('warn');
    expect(contextZone(150_000, TH, 200_000)).toBe('hot');
    expect(contextZone(199_999, TH, 200_000)).toBe('hot');
    expect(contextZone(200_000, TH, 200_000)).toBe('full');
  });

  it('пороги из настройки, порядок не важен; конец шкалы — автосжатие движка, не больше окна', () => {
    expect(contextZone(60_000, [100_000, 50_000], 200_000)).toBe('warn');
    expect(contextFullAt(160_000, 200_000)).toBe(160_000);
    expect(contextFullAt(undefined, 1_000_000)).toBe(1_000_000);
    expect(contextFullAt(2_000_000, 1_000_000)).toBe(1_000_000);
  });
});

describe('20 блоков шкалы', () => {
  const cls = (used: number) => contextBlocks(used, 200_000, TH, 200_000).map((b) => b.cls);

  it('131 250 из 200 000 — ровно как в прототипе chat.html (11 on, on t, on w, part, t)', () => {
    expect(cls(131_250)).toEqual([
      ...Array<string>(11).fill('on'),
      'on t',
      'on w',
      'part',
      't',
      ...Array<string>(5).fill(''),
    ]);
  });

  it('168 420: оранжевый блок и частичный оранжевый (limit.html)', () => {
    const b = contextBlocks(168_420, 200_000, TH, 200_000);
    expect(b.map((x) => x.cls).slice(11, 16)).toEqual(['on t', 'on w', 'on w', 'on w t', 'on h']);
    expect(b[16]!.style?.['--c']).toBe('var(--hot)');
    expect(b[16]!.cls).toBe('part');
  });

  it('пусто и полно; блок = max/20, окно 1M — свой шаг', () => {
    expect(cls(0).every((c) => c === '' || c === 't')).toBe(true);
    expect(cls(200_000).filter((c) => c.startsWith('on'))).toHaveLength(20);
    expect(cls(200_000)[19]).toBe('on h'); // цвет блока — зона его начала (190k)
    // 1M: шаг 50k → 120k — в третьем блоке
    const big = contextBlocks(125_000, 1_000_000, TH, 1_000_000);
    expect(big.filter((b) => b.cls.startsWith('on'))).toHaveLength(2);
    expect(big[2]!.cls).toBe('part t');
  });
});

describe('contextView', () => {
  it('класс числа и пометка порога', () => {
    const at = (used: number) => {
      const s: HudState = { ...initialHud(), context: { used, max: 200_000 } };
      return contextView(s);
    };
    expect(at(0).numCls).toBe('zero');
    expect(at(50_000).numCls).toBe('ok');
    expect(at(130_000).numCls).toBe('');
    expect(at(160_000).numCls).toBe('hot');
    expect(at(160_000).note).toBe('порог 150k пройден');
    expect(at(200_000).numCls).toBe('full');
    expect(at(1234).now).toBe('1 234');
    expect(at(50_000).title).toContain('120k 150k');
  });

  it('окно 1M: шкала 0–200k по порогам, число — от полного окна', () => {
    const at = (used: number, thresholds = [120_000, 150_000]) =>
      contextView({
        ...initialHud(thresholds),
        context: { used, max: 1_000_000, autoCompact: 967_000 },
      });
    const v = at(131_250);
    expect(v.max).toBe('1 000 000');
    // те же блоки, что при окне 200k (эталон chat.html)
    expect(v.blocks.map((b) => b.cls)).toEqual(
      contextBlocks(131_250, 200_000, [120_000, 150_000], 967_000).map((b) => b.cls),
    );
    expect(v.blocks.filter((b) => b.cls.split(' ').includes('t'))).toHaveLength(2);
    expect(v.title).toContain('шкала до 200k');
    // за краем шкалы — все блоки залиты, зона hot, пока не автосжатие
    const over = at(400_000);
    expect(over.blocks.every((b) => b.cls.startsWith('on'))).toBe(true);
    expect(over.zone).toBe('hot');
    // свои пороги выше — шкала растягивается (400k / 0,75 ≈ 534k)
    expect(contextScale(1_000_000, [300_000, 400_000])).toBe(533_334);
    expect(contextScale(200_000, [300_000, 400_000])).toBe(200_000);
    expect(contextScale(200_000, [120_000, 150_000])).toBe(200_000);
  });
});

describe('кэш: таймер', () => {
  const base = (): HudState => ({ ...initialHud(), cache: { lastAt: 1000, ttlMs: 300_000 } });

  it('обратный отсчёт до истечения', () => {
    expect(formatCountdown(252_000)).toBe('04:12');
    expect(formatCountdown(3_600_000)).toBe('1:00:00');
    expect(formatCountdown(-5)).toBe('00:00');
    const v = cacheView(base(), 1000 + 252_000);
    expect(v.time).toBe('00:48');
    expect(v.expired).toBe(false);
    expect(v.left).toBeCloseTo(48_000 / 300_000);
  });

  it('истёк и «нет данных»', () => {
    expect(cacheView(base(), 1000 + 300_001)).toMatchObject({ time: 'истёк', expired: true });
    expect(cacheView(initialHud(), 5)).toMatchObject({ time: '—', hit: '—' });
  });
});

describe('лимиты', () => {
  it('цвет по проценту как в прототипе: оранжевый, >70 жёлтый, >85 красный', () => {
    expect(limitLevel(62)).toBe('lim-hot');
    expect(limitLevel(70)).toBe('lim-hot');
    expect(limitLevel(71)).toBe('lim-warn');
    expect(limitLevel(86)).toBe('lim-full');
  });

  it('ячейки из 10, 100 % — full; проценты ограничены 0…100', () => {
    expect(limitMeter({ kind: 'five-hour', percent: 62 })).toMatchObject({
      percent: 62,
      cells: 6,
      full: false,
    });
    expect(limitMeter({ kind: 'five-hour', percent: 100 })).toMatchObject({
      cells: 10,
      full: true,
      level: 'lim-full',
    });
    expect(limitMeter({ kind: 'five-hour', percent: 140 })?.percent).toBe(100);
    expect(limitMeter(undefined)).toBeUndefined();
  });

  it('подсказка: окно 5 ч и неделя со временем сброса', () => {
    const at = new Date(2026, 9, 1, 12, 0).getTime();
    const v = limitsView(
      [
        { kind: 'five-hour', percent: 62, resetsAt: new Date(2026, 9, 1, 17, 0).getTime() },
        { kind: 'weekly', percent: 34, resetsAt: new Date(2026, 9, 2, 9, 0).getTime() },
        { kind: 'weekly-model', model: 'Opus', percent: 99 },
      ],
      at,
    );
    expect(v.five?.percent).toBe(62);
    expect(v.week?.percent).toBe(34);
    expect(v.title).toBe('5-часовое окно · сброс 17:00\nнеделя 34% · сброс пт 09:00');
    expect(limitsView([], at).title).toContain('пока не получены');
  });
});

describe('итоги сессии и агенты', () => {
  it('sessionTotals: «—» до первого хода', () => {
    expect(sessionTotals(initialHud()).map((r) => r.value)).toEqual(['—', '0', '—', '—']);
  });

  it('sessionTotals: итог без части ходов (модель без цены) — с пометкой; точный итог движка её снимает', () => {
    const result = (extra: Partial<Extract<AgentEvent, { type: 'turn.result' }>>): AgentEvent => ({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 1000,
      apiDurationMs: 0,
      numTurns: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      totalCostUsd: 0.5,
      permissionDenials: [],
      ...extra,
    });
    const now = Date.now();
    let h = applyHud(initialHud(), { type: 'turn.start', at: now, prompt: 'a' }, now);
    h = applyHud(h, result({ costPartial: true }), now);
    expect(sessionTotals(h)[0]!.value).toBe('$0.50 ≈ без части ходов');
    h = applyHud(h, { type: 'turn.start', at: now, prompt: 'b' }, now);
    h = applyHud(h, result({ totalCostUsd: 0.7 }), now);
    expect(sessionTotals(h)[0]!.value).toBe('$0.70');
  });

  it('compactTokens', () => {
    expect([compactTokens(950), compactTokens(8100), compactTokens(131_250)]).toEqual([
      '950',
      '8.1k',
      '131k',
    ]);
  });

  it('карта: основной и субагент деревом, фоновая задача отдельно; ■ только у бегущих', () => {
    let s = initialHud();
    s = applyHud(
      s,
      ev({
        type: 'agent.start',
        agentId: 'a1',
        taskId: 'k1',
        description: 'Explore',
        taskType: 'x',
        subagentType: 'Explore',
        background: false,
      }),
      0,
    );
    s = applyHud(
      s,
      ev({
        type: 'agent.start',
        agentId: 'b1',
        taskId: 'k2',
        description: 'pnpm test',
        taskType: 'local_bash',
        background: true,
        parentAgentId: 'a1',
      }),
      0,
    );
    s = applyHud(
      s,
      ev({
        type: 'agent.end',
        agentId: 'a1',
        taskId: 'k1',
        status: 'completed',
        totalTokens: 8100,
      }),
      0,
    );
    const view = agentMapView(s, {
      working: true,
      waiting: false,
      model: 'claude-opus-5-5',
      now: 3200,
    });
    expect(view.rows.map((r) => [r.depth, r.mark, r.stopTaskId ?? false])).toEqual([
      [0, '●', false],
      [1, '✓', false],
    ]);
    expect(view.tasks.map((r) => [r.mark, r.stopTaskId ?? false, r.meta])).toEqual([
      ['◐', 'k2', 'shell · 3.2s'],
    ]);
    expect(view.rows[1]!.tokens).toBe('8.1k');
    expect(view.rows[0]!.meta).toBe('opus-5.5 · отвечает');
  });
});

describe('цвета сегментов таймлайна', () => {
  it('segClass: think, текст, правки, bash; остальное без класса', () => {
    const seg = (kind: 'think' | 'text' | 'tool', name?: string) =>
      ({ id: 1, kind, at: 0, state: 'ok', ...(name ? { name, input: {} } : {}) }) as never;
    expect(segClass(seg('think'))).toBe('th');
    expect(segClass(seg('text'))).toBe('tx');
    expect(segClass(seg('tool', 'Edit'))).toBe('ed');
    expect(segClass(seg('tool', 'Bash'))).toBe('rn');
    expect(segClass(seg('tool', 'Read'))).toBeUndefined();
  });
});

describe('прототип: шкала блоков совпадает с chat.html', () => {
  it('классы 20 блоков фикстуры прототипа', () => {
    const html = readFileSync(
      join(__dirname, '..', '..', 'prototype', 'screens', 'chat.html'),
      'utf8',
    );
    const m = /<div class="blocks"[^>]*>(.*?)<\/div>/.exec(html)!;
    const proto = [...m[1]!.matchAll(/<i class="([^"]*)"><\/i>|<i><\/i>/g)].map((x) => x[1] ?? '');
    // в прототипе: 12 «сжатых» on-блока до порога, 13-й warn, частичный 14-й (131k)
    const mine = contextBlocks(131_250, 200_000, TH, 200_000).map((b) => b.cls);
    expect(mine).toEqual(proto);
  });
});
