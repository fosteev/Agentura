import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { buildHistory } from '../agent/claude/history';
import { withSubagentTimelines } from '../agent/claude/subagents';
import { readTranscriptExtras } from '../data/transcriptExtras';
import {
  AGENTS_SUBAGENTS_DIR,
  AGENTS_TRANSCRIPT,
  agentsParallelEvents,
  agentsParallelMessages,
} from '../agent/claude/__fixtures__/agentsParallel';
import { applyEvent, initialState, seedHistory, type ChatState, type FeedRow } from './chatState';
import { applyHud, initialHud, type HudState } from './hudState';
import {
  agentBadge,
  agentGroupView,
  agentMapView,
  feedItems,
  firstLine,
  liveSubagents,
  waitingAgents,
} from './agentsView';

/** Живой поток через редьюсеры ленты и приборов; `now` — время события или тик на шаг. */
function play(events: readonly AgentEvent[]): { chat: ChatState; hud: HudState; now: number } {
  let chat = initialState();
  let hud = initialHud();
  let now = 1_000_000;
  for (const e of events) {
    now += 50;
    if ('at' in e && typeof e.at === 'number') now = Math.max(now, e.at);
    chat = applyEvent(chat, e, now);
    hud = applyHud(hud, e, now);
  }
  return { chat, hud, now };
}

function groups(rows: readonly FeedRow[]) {
  return feedItems(rows).filter((i) => i.kind === 'agents');
}

describe('живой прогон agents-parallel: стор и вид', () => {
  it('посреди хода: группа ×3, два идут с текущим вызовом и ■, основной ждёт агентов', async () => {
    const all = await agentsParallelEvents();
    // момент: все три субагента сделали по вызову, ни один ещё не пишет итог
    const calls = all
      .map((e, i) => (e.type === 'tool.start' && e.agentId ? i : -1))
      .filter((i) => i >= 0);
    const { chat, hud, now } = play(all.slice(0, calls[2]! + 1));
    const [g] = groups(chat.rows);
    expect(g && g.kind === 'agents' ? g.rows.length : 0).toBe(3);
    const view = agentGroupView(
      g!.kind === 'agents' ? g!.rows : [],
      hud,
      now,
      '/tmp/agentura-agents',
    );
    expect(view.what).toBe('×3 параллельно');
    expect(view.live).toBe(true);
    expect(view.rows.map((r) => [r.type, r.cls, !!r.stopTaskId])).toEqual([
      ['Explore', 'busy', true],
      ['Explore', 'busy', true],
      ['general-purpose', 'busy', true],
    ]);
    // текущий вызов: у третьего Read ещё идёт, у первых — последний закрытый
    expect(view.rows.map((r) => r.note)).toEqual([
      'read notes.md',
      'read notes.md',
      'read notes.md',
    ]);
    expect(view.rows[0]!.right).toMatch(/^11\.\dk · /);
    expect(view.waiting).toBe(true);
    expect(view.background).toMatch(/^Background sleep task · /);
    expect(waitingAgents(chat.rows, hud).map((a) => a.subagentType)).toEqual([
      'Explore',
      'Explore',
    ]);
    expect(liveSubagents(hud)).toHaveLength(3);
    expect(agentBadge(hud)).toEqual({ text: '3 / 3', live: true });

    const map = agentMapView(hud, {
      working: true,
      waiting: true,
      now,
      cwd: '/tmp/agentura-agents',
    });
    expect(map.rows.map((r) => [r.depth, r.mark])).toEqual([
      [0, '●'],
      [1, '◐'],
      [1, '◐'],
      [1, '◐'],
    ]);
    expect(map.rows[0]!.meta).toMatch(/ждёт агентов$/);
    expect(map.tasks.map((t) => [t.mark, !!t.stopTaskId])).toEqual([['◐', true]]);
    // детали — первый идущий: промпт от основного, ход агента, ■
    expect(map.detail?.type).toBe('Explore');
    expect(map.detail?.prompt).toMatch(/alpha\/notes\.md/);
    expect(map.detail?.stopTaskId).toBeTruthy();
    expect(map.detail?.rows.some((r) => r.op === 'read')).toBe(true);
  });

  it('Esc посреди агентов без уведомлений: передний план — «остановлено», фоновый идёт', async () => {
    const all = await agentsParallelEvents();
    const calls = all
      .map((e, i) => (e.type === 'tool.start' && e.agentId ? i : -1))
      .filter((i) => i >= 0);
    const result = all.find((e) => e.type === 'turn.result')!;
    const { hud } = play([
      ...all.slice(0, calls[2]! + 1),
      { ...result, interrupted: true } as AgentEvent,
      { type: 'turn.start', at: Date.now(), prompt: 'дальше' },
    ]);
    const subs = hud.agents.filter((a) => a.taskType === 'local_agent');
    expect(subs.map((a) => [a.background, a.status])).toEqual([
      [false, 'stopped'],
      [false, 'stopped'],
      [true, 'running'],
    ]);
    expect(subs.filter((a) => !a.background).every((a) => a.segs.every((g) => g.endAt))).toBe(true);
    expect(liveSubagents(hud).map((a) => a.background)).toEqual([true]);
  });

  it('повтор вызова субагента и конец без начала не плодят строк и узлов', async () => {
    const all = await agentsParallelEvents();
    const i = all.findIndex((e) => e.type === 'tool.start' && e.agentId);
    const { hud } = play([
      ...all.slice(0, i + 1),
      all[i]!,
      { type: 'agent.end', agentId: 'toolu_lost', taskId: 'lost', status: 'completed' },
    ]);
    const a = hud.agents.find((x) => x.agentId === (all[i] as { agentId: string }).agentId)!;
    expect(a.calls).toBe(1);
    expect(a.segs.filter((g) => g.kind === 'tool')).toHaveLength(1);
    expect(hud.agents.some((x) => x.agentId === 'toolu_lost')).toBe(false);
  });

  it('после хода: все готовы, итоги одной строкой, токены и дерево', async () => {
    const { chat, hud, now } = play(await agentsParallelEvents());
    const [g] = groups(chat.rows);
    const view = agentGroupView(g!.kind === 'agents' ? g!.rows : [], hud, now);
    expect(view.live).toBe(false);
    expect(view.status).toBe('· 3 готово');
    expect(view.rows.map((r) => [r.cls, r.mark, r.link])).toEqual([
      ['ok', '✓', 'summary'],
      ['ok', '✓', 'summary'],
      ['ok', '✓', 'summary'],
    ]);
    expect(view.rows[1]!.note).toBe('reset() из onReconnect');
    expect(view.tokens).toBe('49.6k');
    expect(view.waiting).toBe(false);
    expect(view.background).toBeUndefined();
    expect(agentBadge(hud)).toEqual({ text: '3', live: false });
    // в основную ленту вызовы субагентов не попали: только Bash и три Agent основного
    expect(
      chat.rows.filter((r) => r.kind === 'tool').map((r) => r.kind === 'tool' && r.name),
    ).toEqual(['Bash', 'Agent', 'Agent', 'Agent']);

    const map = agentMapView(hud, { working: false, waiting: false, now });
    expect(map.heading).toMatch(/^агенты · \d\d:\d\d · ход завершён$/);
    expect(map.rows.slice(1).map((r) => r.mark)).toEqual(['✓', '✓', '✓']);
    expect(map.bar.map((b) => b.cls)).toEqual(['o', 'o', 'o']);
    expect(map.totals[0]).toEqual({ label: 'субагенты за ход', value: '49.6k' });
    expect(map.tasks[0]?.meta).toMatch(/^завершён /);
    expect(map.detail?.summary).toMatch(/сброс состояния в onOpen/);
    expect(map.detail?.statusText).toMatch(/^✓ готово за /);

    const sel = agentMapView(hud, {
      working: false,
      waiting: false,
      now,
      selected: map.rows[3]!.agentId!,
    });
    expect(sel.detail?.type).toBe('general-purpose');
    expect(sel.rows[3]!.cls).toContain('sel');
  });
});

describe('история agents-parallel: resume показывает группу с итогами', () => {
  it('группа ×3, итоги, ход агента из subagents/', async () => {
    const extras = await readTranscriptExtras(AGENTS_TRANSCRIPT);
    const events = buildHistory(agentsParallelMessages(), {
      toolResults: extras.toolResults,
    }).events;
    await withSubagentTimelines(events, AGENTS_SUBAGENTS_DIR);
    const now = Date.now();
    const chat = seedHistory(initialState(), { sessionId: 's', skippedTurns: 0 }, events, now);
    let hud = initialHud();
    for (const e of events) hud = applyHud(hud, e, now);

    // уведомления о задачах — не реплики пользователя
    expect(chat.rows.filter((r) => r.kind === 'user')).toHaveLength(1);
    const [g] = groups(chat.rows);
    const view = agentGroupView(g!.kind === 'agents' ? g!.rows : [], hud, now);
    expect(view.what).toBe('×3 параллельно');
    expect(view.rows.map((r) => [r.cls, r.note])).toEqual([
      ['ok', 'The second line of the file is:'],
      ['ok', 'reset() из onReconnect'],
      ['ok', 'The file `gamma/notes.md` has 5 lines in total.'],
    ]);
    expect(view.rows[0]!.right).toMatch(/^12\.\dk · 5\.\ds$/);

    const map = agentMapView(hud, { working: false, waiting: false, now });
    expect(map.rows).toHaveLength(4);
    expect(map.detail?.rows.map((r) => r.op)).toEqual(['think', 'read', 'think']);
    expect(map.detail?.timelineLabel).toBe('ход агента · 1 вызов');
    expect(map.tasks).toHaveLength(1);
  });
});

describe('мелочи вида', () => {
  it('firstLine: без рамки hand-back, ``` и **', () => {
    expect(firstLine('[Subagent hand-back] x The report follows:\n  ```\n  **a** b\n')).toBe('a b');
    expect(firstLine(undefined)).toBe('');
  });

  it('вызов Agent без задачи (старый транскрипт) — строка по самому вызову', () => {
    let chat = initialState();
    let hud = initialHud();
    const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;
    for (const e of [
      ev({ type: 'turn.start', prompt: 'x', at: 1 }),
      ev({
        type: 'tool.start',
        toolUseId: 't',
        name: 'Task',
        input: { description: 'd', subagent_type: 'Plan' },
        at: 1,
      }),
      ev({ type: 'tool.result', toolUseId: 't', isError: true, content: 'boom', at: 2001 }),
    ]) {
      chat = applyEvent(chat, e, 3000);
      hud = applyHud(hud, e, 3000);
    }
    const [g] = groups(chat.rows);
    const v = agentGroupView(g!.kind === 'agents' ? g!.rows : [], hud, 3000);
    expect(v.rows[0]).toMatchObject({
      cls: 'err',
      mark: '✕',
      type: 'Plan',
      desc: 'd',
      note: 'boom',
    });
    expect(agentBadge(hud)).toBeUndefined();
  });
});
