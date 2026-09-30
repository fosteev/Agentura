import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_BASELINES, replayProbeLog } from '../agent/claude/replay';
import type { AgentEvent } from '../agent/types';
import { formatCost } from './toolView';
import { buildPrompt } from '../shared/prompt';
import {
  applyEvent,
  initialState,
  queueUser,
  resetSession,
  type ChatState,
  type FeedRow,
} from './chatState';

const logsDir = join(__dirname, '..', '..', 'spikes', 'sdk-probe', 'logs');

function readLog(name: string): Record<string, unknown>[] {
  return readFileSync(join(logsDir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function feed(name: string): Promise<{ state: ChatState; events: AgentEvent[] }> {
  const { events } = await replayProbeLog(readLog(name), PROBE_BASELINES[name] ?? 0);
  let state = { ...initialState(), cwd: '/Users/fost/Projects/Agentura' };
  for (const e of events) state = applyEvent(state, e, 1_000_000);
  return { state, events };
}

const kinds = (rows: FeedRow[]) => rows.map((r) => r.kind);

describe('редьюсер ленты на логах пробы', () => {
  it('01: три хода — три user, три sum, стоимость итога = разность total_cost_usd', async () => {
    const { state, events } = await feed('01-basic-control');
    expect(state.rows.filter((r) => r.kind === 'user')).toHaveLength(3);
    const sums = state.rows.filter((r): r is Extract<FeedRow, { kind: 'sum' }> => r.kind === 'sum');
    expect(sums).toHaveLength(3);
    const results = events.filter((e) => e.type === 'turn.result');
    sums.forEach((sum, i) => {
      const r = results[i]!;
      if (r.type !== 'turn.result') throw new Error('unreachable');
      expect(sum.cost).toBe(formatCost(r.costUsd!));
      expect(sum.parts[0]).toContain('in ');
    });
    expect(state.status).toBe('idle');
    expect(state.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(state.title).toBeTruthy();
  });

  it('01: текст ответа собран из дельт одной строкой на сообщение', async () => {
    const { state, events } = await feed('01-basic-control');
    const textRows = state.rows.filter(
      (r): r is Extract<FeedRow, { kind: 'text' }> => r.kind === 'text',
    );
    const deltas = events.filter((e) => e.type === 'text.delta' && !e.agentId);
    expect(textRows.map((r) => r.text).join('')).toBe(
      deltas.map((e) => (e.type === 'text.delta' ? e.text : '')).join(''),
    );
    expect(textRows.every((r) => !r.streaming)).toBe(true);
  });

  it('02: Edit/Write — строки инструментов закрыты результатом, статус после хода idle', async () => {
    const { state } = await feed('02-permissions-edit');
    const tools = state.rows.filter(
      (r): r is Extract<FeedRow, { kind: 'tool' }> => r.kind === 'tool',
    );
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.state !== 'run')).toBe(true);
    expect(tools.some((t) => t.name === 'Edit' && t.state === 'ok')).toBe(true);
  });

  it('03–04: запросы вопроса и плана дают заглушку в ленте (карточки — этап 5)', async () => {
    for (const name of ['03-ask-user-question', '04-plan-mode']) {
      const { state } = await feed(name);
      expect(state.rows.some((r) => r.kind === 'sys' && r.tone === 'bad')).toBe(true);
    }
  });

  it('05: события субагентов не попадают в ленту основного агента', async () => {
    const { state, events } = await feed('05-subagents');
    const sub = events.filter(
      (e) => e.agentId && (e.type === 'text.delta' || e.type === 'tool.start'),
    );
    expect(sub.length).toBeGreaterThan(0);
    const toolIds = new Set(state.rows.flatMap((r) => (r.kind === 'tool' ? [r.toolUseId] : [])));
    for (const e of sub) if (e.type === 'tool.start') expect(toolIds.has(e.toolUseId)).toBe(false);
  });

  it('06: компакция — строка sys с «было → стало», а не «сжимаю» навсегда', async () => {
    const { state } = await feed('06-compact');
    const sys = state.rows.filter((r) => r.kind === 'sys');
    expect(sys.length).toBeGreaterThan(0);
    const texts = sys.map((r) => (r.kind === 'sys' ? JSON.stringify(r.text) : ''));
    expect(texts.some((t) => t.includes('→'))).toBe(true);
    expect(texts.some((t) => t.includes('сжимаю'))).toBe(false);
  });

  it('07: thinking — строка think с текстом и концом', async () => {
    const { state } = await feed('07-thinking');
    const think = state.rows.find(
      (r): r is Extract<FeedRow, { kind: 'think' }> => r.kind === 'think',
    );
    expect(think).toBeDefined();
    expect(think!.endedAt).toBeDefined();
  });
});

describe('редьюсер: очередь и границы хода', () => {
  const start = (prompt: string | undefined): AgentEvent => ({
    type: 'turn.start',
    at: 1_700_000_000_000,
    ...(prompt !== undefined ? { prompt } : {}),
  });

  it('сообщение «в очереди» становится обычным по turn.start и не задваивается', () => {
    let s = queueUser(initialState(), 'привет');
    expect(s.rows[0]).toMatchObject({ kind: 'user', queued: true });
    s = applyEvent(s, start('привет'));
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: 'user', queued: false });
    expect(s.status).toBe('working');
  });

  it('блок контекста отделяется от текста пользователя', () => {
    const prompt = buildPrompt('посмотри', [{ kind: 'file', path: 'src/a.ts' }]);
    let s = queueUser(initialState(), 'посмотри');
    s = applyEvent(s, start(prompt));
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0] as Extract<FeedRow, { kind: 'user' }>;
    expect(row.text).toBe('посмотри');
    expect(row.context).toContain('src/a.ts');
  });

  it('ход без prompt (пробуждение движка) строки пользователя не создаёт', () => {
    const s = applyEvent(initialState(), start(undefined));
    expect(s.rows).toHaveLength(0);
    expect(s.status).toBe('working');
  });

  it('два сообщения в очереди закрываются по своим текстам', () => {
    let s = queueUser(queueUser(initialState(), 'раз'), 'два');
    s = applyEvent(s, start('раз'));
    expect(s.rows.map((r) => (r.kind === 'user' ? r.queued : null))).toEqual([false, true]);
  });

  it('склеенные движком сообщения (prompts) закрывают каждое свою строку, с контекстом', () => {
    const a = buildPrompt('раз', [{ kind: 'file', path: 'src/a.ts' }]);
    let s = queueUser(queueUser(initialState(), 'раз'), 'два');
    s = applyEvent(s, { type: 'turn.start', at: 1, prompt: `${a}\n\nдва`, prompts: [a, 'два'] });
    expect(s.rows).toHaveLength(2);
    expect(s.rows.map((r) => (r.kind === 'user' ? [r.text, r.queued] : null))).toEqual([
      ['раз', false],
      ['два', false],
    ]);
    expect((s.rows[0] as Extract<FeedRow, { kind: 'user' }>).context).toContain('src/a.ts');
  });

  it('сообщение, влитое в идущий ход (turn.input), перестаёт быть «в очереди»', () => {
    let s = applyEvent(queueUser(initialState(), 'первое'), start('первое'));
    s = queueUser(s, 'добавка');
    s = applyEvent(s, { type: 'turn.input', prompt: 'добавка', at: 2 });
    expect(s.rows.map((r) => (r.kind === 'user' ? r.queued : null))).toEqual([false, false]);
    expect(s.status).toBe('working');
  });

  it('прерванный ход закрывает бегущие инструменты как stopped', () => {
    let s = applyEvent(initialState(), start('x'));
    s = applyEvent(s, {
      type: 'tool.start',
      toolUseId: 't1',
      name: 'Bash',
      input: { command: 'sleep 9' },
    });
    s = applyEvent(s, {
      type: 'turn.result',
      ok: false,
      subtype: 'error_during_execution',
      interrupted: true,
      durationMs: 1000,
      apiDurationMs: 500,
      numTurns: 1,
      totalCostUsd: 0,
      permissionDenials: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
    });
    const tool = s.rows.find((r) => r.kind === 'tool') as Extract<FeedRow, { kind: 'tool' }>;
    expect(tool.state).toBe('stopped');
    expect(kinds(s.rows).at(-1)).toBe('sys');
    expect(s.status).toBe('idle');
  });

  it('session.closed закрывает сессию и оставляет системную строку', () => {
    const s = applyEvent(initialState(), { type: 'session.closed', reason: 'exit' });
    expect(s.closed).toEqual({ reason: 'exit' });
    expect(s.rows).toHaveLength(1);
  });

  it('лимит: error с code limit даёт статус limited', () => {
    const s = applyEvent(initialState(), {
      type: 'error',
      message: 'лимит',
      fatal: false,
      code: 'limit',
    });
    expect(s.status).toBe('limited');
  });

  it('resetSession сохраняет воркспейс и сбрасывает ленту', () => {
    let s = { ...initialState(), project: 'p', cwd: '/p', allowBypass: true };
    s = queueUser(s, 'a');
    const r = resetSession(s);
    expect(r.rows).toHaveLength(0);
    expect(r).toMatchObject({ project: 'p', cwd: '/p', allowBypass: true });
  });
});
