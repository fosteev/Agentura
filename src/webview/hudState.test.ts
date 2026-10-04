import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_BASELINES, replayProbeLog } from '../agent/claude/replay';
import type { AgentEvent } from '../agent/types';
import {
  TTL_1H,
  TTL_5M,
  applyHud,
  cacheExpiresAt,
  cacheHitRatio,
  cacheTtl,
  contextMax,
  initialHud,
  resetHud,
  type HudState,
} from './hudState';

const logsDir = join(__dirname, '..', '..', 'spikes', 'sdk-probe', 'logs');

async function feed(name: string): Promise<{ hud: HudState; events: AgentEvent[] }> {
  const lines = readFileSync(join(logsDir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const { events } = await replayProbeLog(lines, PROBE_BASELINES[name] ?? 0);
  let hud = initialHud();
  for (const e of events) hud = applyHud(hud, e, 1_000_000);
  return { hud, events };
}

const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;
const usage = (o: Partial<Record<string, number>>) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...o,
});

describe('кэш', () => {
  it('таймер: последний ответ с кэшем + TTL; 1 ч для входа подписки, 5 мин иначе', () => {
    let s = applyHud(initialHud(), ev({ type: 'session.init', apiKeySource: 'none' }));
    s = applyHud(
      s,
      ev({
        type: 'usage.message',
        messageId: 'm',
        model: 'x',
        final: true,
        at: 10_000,
        usage: usage({ cacheRead: 100 }),
      }),
    );
    expect(cacheTtl(s)).toBe(TTL_1H);
    expect(cacheExpiresAt(s)).toBe(10_000 + TTL_1H);
    const api = applyHud(
      initialHud(),
      ev({ type: 'session.init', apiKeySource: 'ANTHROPIC_API_KEY' }),
    );
    expect(cacheTtl(api)).toBe(TTL_5M);
  });

  it('TTL берётся из записи в кэш: ephemeral_5m → 5 мин даже на подписке', () => {
    let s = applyHud(initialHud(), ev({ type: 'session.init', apiKeySource: 'none' }));
    s = applyHud(
      s,
      ev({
        type: 'usage.message',
        messageId: 'm',
        model: 'x',
        final: true,
        at: 1,
        usage: usage({ cacheWrite: 50, cacheWrite5m: 50, cacheWrite1h: 0 }),
      }),
    );
    expect(cacheTtl(s)).toBe(TTL_5M);
    s = applyHud(
      s,
      ev({
        type: 'usage.message',
        messageId: 'm2',
        model: 'x',
        final: true,
        at: 2,
        usage: usage({ cacheWrite: 50, cacheWrite5m: 0, cacheWrite1h: 50 }),
      }),
    );
    expect(cacheTtl(s)).toBe(TTL_1H);
  });

  it('ответ без кэша и ответ субагента таймер не двигают', () => {
    let s = applyHud(
      initialHud(),
      ev({
        type: 'usage.message',
        messageId: 'a',
        model: 'x',
        final: true,
        at: 5,
        usage: usage({ cacheRead: 1 }),
      }),
    );
    s = applyHud(
      s,
      ev({
        type: 'usage.message',
        messageId: 'b',
        model: 'x',
        final: true,
        at: 99,
        usage: usage({ input: 10 }),
      }),
    );
    s = applyHud(
      s,
      ev({
        type: 'usage.message',
        agentId: 'sub',
        messageId: 'c',
        model: 'x',
        final: true,
        at: 77,
        usage: usage({ cacheRead: 5 }),
      }),
    );
    expect(s.cache.lastAt).toBe(5);
  });

  it('доля попаданий: cache_read / (input + cache_read + cache_creation)', () => {
    expect(
      cacheHitRatio({
        costUsd: 0,
        turns: 0,
        durationMs: 0,
        input: 10,
        cacheRead: 80,
        cacheWrite: 10,
      }),
    ).toBeCloseTo(0.8);
    expect(
      cacheHitRatio({ costUsd: 0, turns: 0, durationMs: 0, input: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBeUndefined();
  });
});

describe('итоги сессии и контекст', () => {
  it('turn.result: стоимость — накопленная total_cost_usd, ходы и время суммируются', () => {
    const r = (total: number, dur: number) =>
      ev({
        type: 'turn.result',
        ok: true,
        subtype: 'success',
        interrupted: false,
        durationMs: dur,
        apiDurationMs: dur,
        numTurns: 1,
        usage: usage({ input: 10, cacheRead: 90 }),
        costUsd: 0.1,
        totalCostUsd: total,
        permissionDenials: [],
      });
    let s = initialHud();
    s = applyHud(s, r(0.1, 1000));
    s = applyHud(s, r(0.35, 2500));
    expect(s.totals).toMatchObject({
      costUsd: 0.35,
      turns: 2,
      durationMs: 3500,
      input: 20,
      cacheRead: 180,
    });
  });

  it('context.usage: шкала обновляется, max и порог автосжатия запоминаются', () => {
    let s = applyHud(
      initialHud(),
      ev({ type: 'context.usage', usedTokens: 1000, source: 'usage' }),
    );
    expect(contextMax(s)).toBe(200_000);
    s = applyHud(
      s,
      ev({
        type: 'context.usage',
        usedTokens: 5000,
        maxTokens: 1_000_000,
        autoCompactThreshold: 800_000,
        source: 'engine',
      }),
    );
    s = applyHud(s, ev({ type: 'context.usage', usedTokens: 6000, source: 'usage' }));
    expect(s.context).toEqual({ used: 6000, max: 1_000_000, autoCompact: 800_000 });
  });

  it('компакция: шкала прыгает на postTokens; неудачная не трогает', () => {
    let s = applyHud(
      initialHud(),
      ev({ type: 'context.usage', usedTokens: 186_000, maxTokens: 200_000, source: 'engine' }),
    );
    s = applyHud(s, ev({ type: 'compaction.end', ok: false }));
    expect(s.context?.used).toBe(186_000);
    s = applyHud(
      s,
      ev({ type: 'compaction.end', ok: true, preTokens: 186_000, postTokens: 41_000 }),
    );
    expect(s.context).toMatchObject({ used: 41_000, max: 200_000 });
  });

  it('resetHud сбрасывает всё, кроме порогов', () => {
    const s = resetHud(
      applyHud(
        { ...initialHud([1, 2]) },
        ev({ type: 'context.usage', usedTokens: 5, source: 'usage' }),
      ),
    );
    expect(s.context).toBeUndefined();
    expect(s.thresholds).toEqual([1, 2]);
  });
});

describe('на логах пробы', () => {
  it('09 (контекст): число контекста = engine `totalTokens`, окно запомнено', async () => {
    const { hud, events } = await feed('09-context-sonnet');
    const engine = events.filter((e) => e.type === 'context.usage' && e.source === 'engine');
    expect(engine.length).toBeGreaterThan(0);
    const last = engine[engine.length - 1] as Extract<AgentEvent, { type: 'context.usage' }>;
    expect(hud.context?.used).toBe(last.usedTokens);
    expect(hud.context?.max).toBe(last.maxTokens);
  });

  it('06 (компакция): контекст после компакции = postTokens', async () => {
    const { hud, events } = await feed('06-compact');
    const end = events.find((e) => e.type === 'compaction.end');
    expect(end).toBeDefined();
    expect(hud.totals.turns).toBeGreaterThan(0);
  });

  it('05 (субагенты): дерево агентов с итоговым статусом, токенами; ход закрыт', async () => {
    const { hud, events } = await feed('05-subagents');
    const starts = events.filter((e) => e.type === 'agent.start');
    expect(starts.length).toBeGreaterThan(0);
    expect(hud.agents).toHaveLength(
      new Set(starts.map((e) => (e as { agentId: string }).agentId)).size,
    );
    expect(hud.agents.every((a) => a.status !== 'running')).toBe(true);
    // события субагентов не попали в таймлайн основного хода
    const mainTools = events.filter((e) => e.type === 'tool.start' && !e.agentId).length;
    const segTools = hud.turns.flatMap((t) => t.segs).filter((g) => g.kind === 'tool').length;
    expect(segTools).toBeLessThanOrEqual(mainTools);
    expect(hud.turns.every((t) => t.endedAt !== undefined)).toBe(true);
  });

  it('01: по ходу — сегменты think/tool/text закрыты, время не отрицательное', async () => {
    const { hud } = await feed('01-basic-control');
    for (const t of hud.turns) {
      for (const g of t.segs) {
        expect(g.endAt).toBeDefined();
        expect(g.endAt! - g.at).toBeGreaterThanOrEqual(0);
      }
    }
    expect(hud.totals.turns).toBe(3);
  });
});

describe('таймлайн хода', () => {
  it('turn.start открывает ход; tool/think/text — сегменты по порядку; result считает длительность', () => {
    let s = initialHud();
    const push = (e: Record<string, unknown>, now = 0) => (s = applyHud(s, ev(e), now));
    push({ type: 'turn.start', at: 1000 });
    push({ type: 'thinking.start', messageId: 'm1', at: 1000 });
    push({ type: 'thinking.stop', messageId: 'm1', at: 3000 });
    push({ type: 'tool.start', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, at: 3100 });
    push({ type: 'tool.result', toolUseId: 't1', isError: false, content: '', durationMs: 900 });
    push({ type: 'text.delta', messageId: 'm2', text: 'а' }, 4200);
    push({ type: 'text.delta', messageId: 'm2', text: 'б' }, 4300);
    const t = s.turns[0]!;
    expect(t.segs.map((g) => g.kind)).toEqual(['think', 'tool', 'text']);
    expect(t.segs[1]).toMatchObject({ at: 3100, endAt: 4000, state: 'ok' });
    expect(t.segs[2]!.endAt).toBeUndefined();
    push({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 3500,
      apiDurationMs: 3000,
      numTurns: 1,
      usage: usage({}),
      totalCostUsd: 0,
      permissionDenials: [],
    });
    expect(s.turns[0]!.endedAt).toBe(4500);
    expect(s.turns[0]!.segs[2]!.endAt).toBe(4500);
  });

  it('прерванный ход: бегущий инструмент становится stopped', () => {
    let s = initialHud();
    s = applyHud(s, ev({ type: 'turn.start', at: 0 }));
    s = applyHud(s, ev({ type: 'tool.start', toolUseId: 't', name: 'Bash', input: {}, at: 10 }));
    s = applyHud(
      s,
      ev({
        type: 'turn.result',
        ok: false,
        subtype: 'error_during_execution',
        interrupted: true,
        durationMs: 500,
        apiDurationMs: 0,
        numTurns: 1,
        usage: usage({}),
        totalCostUsd: 0,
        permissionDenials: [],
      }),
    );
    expect(s.turns[0]!.segs[0]!.state).toBe('stopped');
  });

  it('хранятся не больше трёх последних ходов', () => {
    let s = initialHud();
    for (let i = 0; i < 5; i++) s = applyHud(s, ev({ type: 'turn.start', at: i * 10 }));
    expect(s.turns).toHaveLength(3);
    expect(s.turns[2]!.startedAt).toBe(40);
  });

  it('turnNo таймлайна — номер хода пользователя; ход-пробуждение несёт прежний', () => {
    let s = initialHud();
    s = applyHud(s, ev({ type: 'turn.start', at: 0, prompt: 'один' }));
    s = applyHud(s, ev({ type: 'turn.start', at: 10, prompt: 'два' }));
    s = applyHud(s, ev({ type: 'turn.start', at: 20 }));
    expect(s.turns.map((t) => t.turnNo)).toEqual([1, 2, 2]);
    expect(s.turnNo).toBe(2);
  });
});

describe('агенты', () => {
  it('start → progress → end: статус, токены, вложенная фоновая задача', () => {
    let s = initialHud();
    s = applyHud(
      s,
      ev({
        type: 'agent.start',
        agentId: 'a1',
        taskId: 'k1',
        description: 'Explore',
        taskType: 'local_agent',
        subagentType: 'Explore',
        background: false,
      }),
      100,
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
      110,
    );
    s = applyHud(
      s,
      ev({
        type: 'agent.progress',
        agentId: 'a1',
        taskId: 'k1',
        totalTokens: 8100,
        toolUses: 3,
        lastToolName: 'Read',
      }),
      120,
    );
    s = applyHud(
      s,
      ev({
        type: 'agent.end',
        agentId: 'a1',
        taskId: 'k1',
        status: 'completed',
        totalTokens: 8200,
      }),
      200,
    );
    expect(s.agents).toHaveLength(2);
    expect(s.agents[0]).toMatchObject({
      status: 'completed',
      tokens: 8200,
      toolUses: 3,
      lastTool: 'Read',
      endedAt: 200,
    });
    expect(s.agents[1]).toMatchObject({ status: 'running', background: true, parentAgentId: 'a1' });
    // сессия закрылась — бегущие задачи остановлены (приёмка этапа 4)
    s = applyHud(s, ev({ type: 'session.closed', reason: 'error' }), 300);
    expect(s.agents[1]).toMatchObject({ status: 'stopped', endedAt: 300 });
    expect(s.agents[0]).toMatchObject({ status: 'completed', endedAt: 200 });
  });
});
