import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_BASELINES, replayProbeLog } from '../agent/claude/replay';
import type { AgentEvent } from '../agent/types';
import { formatCost } from './toolView';
import { buildPrompt } from '../shared/prompt';
import {
  activeCard,
  answerSummary,
  answersOf,
  applyEvent,
  attachPreview,
  initialState,
  markPermission,
  markRetrying,
  markPlan,
  markQuestionSent,
  pendingPlan,
  permissionSubject,
  pickOption,
  queueUser,
  questionReady,
  resetSession,
  seedHistory,
  setCustomAnswer,
  type ChatState,
  type FeedRow,
  type PermCard,
  type PlanCard,
  type QuestionCard,
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

  it('02: карточки разрешений — «всегда» для Bash даёт строку с правилом, после хода карточек нет', async () => {
    const { events } = await replayProbeLog(readLog('02-permissions-edit'), 0);
    let state: ChatState = { ...initialState(), cwd: '/Users/fost/Projects/Agentura' };
    const seen: string[] = [];
    for (const e of events) {
      state = applyEvent(state, e, 1_000_000);
      if (e.type === 'permission.request') {
        seen.push(e.toolName);
        expect(state.status).toBe('waiting');
        const card = state.rows.at(-1) as PermCard;
        expect(card.kind).toBe('perm');
        // как ответил пользователь в пробе: Bash node -e — «всегда», остальное — «разрешить»
        const always = e.toolName === 'Bash' && String(e.input['command']).startsWith('node');
        state = markPermission(state, e.toolUseId, always ? 'allow-always' : 'allow');
      }
    }
    expect(seen).toEqual(['Edit', 'Bash', 'Bash', 'Write', 'Bash', 'Bash']);
    expect(state.rows.some((r) => r.kind === 'perm')).toBe(false);
    expect(state.pending).toEqual([]);
    expect(state.status).toBe('idle');
    const always = state.rows.find(
      (r) => r.kind === 'sys' && JSON.stringify(r.text).includes('всегда'),
    );
    expect(always).toMatchObject({
      text: [
        'всегда: ',
        { code: 'Bash(node -e "console.log(1)")' },
        ' → .claude/settings.local.json',
      ],
    });
  });

  it('03: вопрос — карточка остаётся отвеченной, под ней «выбран вариант 2»', async () => {
    const { events } = await replayProbeLog(readLog('03-ask-user-question'), 0);
    let state = initialState();
    for (const e of events) {
      state = applyEvent(state, e, 1_000_000);
      if (e.type === 'question.request') {
        const q = e.questions[0]!;
        state = pickOption(state, e.toolUseId, q.question, 'Синий');
        const card = state.rows.at(-1) as QuestionCard;
        expect(answersOf(card)).toEqual({ [q.question]: 'Синий' });
        state = markQuestionSent(state, e.toolUseId);
      }
    }
    const i = state.rows.findIndex((r) => r.kind === 'question');
    expect(state.rows[i]).toMatchObject({ kind: 'question', state: 'answered' });
    expect(state.rows[i + 1]).toMatchObject({ kind: 'sys', text: ['выбран вариант 2'] });
  });

  it('04: план — «доработать» с текстом, затем «выполнять, принимая правки»; режим сменил движок', async () => {
    const { events } = await replayProbeLog(readLog('04-plan-mode'), 0);
    let state = initialState();
    let n = 0;
    for (const e of events) {
      state = applyEvent(state, e, 1_000_000);
      if (e.type === 'plan.request') {
        expect(pendingPlan(state)?.toolUseId).toBe(e.toolUseId);
        state =
          n++ === 0
            ? markPlan(state, e.toolUseId, 'refine', 'добавь проверку git diff')
            : markPlan(state, e.toolUseId, 'run-edits');
      }
    }
    const sys = state.rows.flatMap((r) => (r.kind === 'sys' ? [r.text.join('')] : []));
    expect(sys).toContain('план на доработку: добавь проверку git diff');
    expect(sys).toContain('план принят · выполняю, принимая правки');
    expect(sys).toContain('режим: принимать правки');
    const plans = state.rows.filter((r): r is PlanCard => r.kind === 'plan');
    expect(plans.map((p) => [p.state, p.choice])).toEqual([
      ['done', 'refine'],
      ['done', 'run-edits'],
    ]);
    expect(state.mode).toBe('acceptEdits');
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

  it('склеенные сообщения с картинкой: скрин остаётся у своей строки, не дублируется под чужой; итог считает его раз', () => {
    const img = { mediaType: 'image/png', data: 'iVBOR', width: 750, height: 1000 };
    let s = queueUser(queueUser(initialState(), 'раз', [img]), 'два');
    s = applyEvent(s, {
      type: 'turn.start',
      at: 1,
      prompt: 'раз\n\nдва',
      prompts: ['раз', 'два'],
      images: [img],
    });
    const rows = s.rows as Extract<FeedRow, { kind: 'user' }>[];
    expect(rows.map((r) => r.images?.length ?? 0)).toEqual([1, 0]);
    expect(s.turnImageTokens).toBe(1000);
    // без своих строк (вкладку перезагрузили) — картинки события у последнего сообщения
    const fresh = applyEvent(initialState(), {
      type: 'turn.start',
      at: 1,
      prompt: 'раз\n\nдва',
      prompts: ['раз', 'два'],
      images: [img],
    });
    expect((fresh.rows as Extract<FeedRow, { kind: 'user' }>[]).map((r) => r.images?.length ?? 0)).toEqual([0, 1]);
    expect(fresh.turnImageTokens).toBe(1000);
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

describe('системные строки этапа 4', () => {
  const e = (x: Record<string, unknown>) => x as unknown as AgentEvent;

  it('смена режима движком — строка; выбранный из интерфейса режим (уже в состоянии) — нет', () => {
    let s = initialState();
    s = applyEvent(s, e({ type: 'mode.changed', mode: 'default' }), 0);
    expect(s.rows).toHaveLength(0);
    s = applyEvent(s, e({ type: 'mode.changed', mode: 'plan' }), 0);
    expect(s.mode).toBe('plan');
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: 'sys', text: ['режим: plan'] });
    s = applyEvent(
      { ...s, mode: 'acceptEdits' },
      e({ type: 'mode.changed', mode: 'acceptEdits' }),
      0,
    );
    expect(s.rows).toHaveLength(1);
  });

  it('session.init с effort (agentura.defaultEffort) — меню effort показывает его; без effort — прежний', () => {
    const init = { type: 'session.init', sessionId: 's', model: 'm', permissionMode: 'default' };
    let s = applyEvent(initialState(), e({ ...init, effort: 'high' }), 0);
    expect(s.effort).toBe('high');
    s = applyEvent(s, e(init), 0);
    expect(s.effort).toBe('high');
  });

  it('«ход не начат»: ошибка лимита со временем сброса из limit.update', () => {
    let s = initialState();
    const reset = new Date(2026, 9, 1, 17, 0).getTime();
    s = applyEvent(
      s,
      e({
        type: 'limit.update',
        source: 'engine',
        status: 'rejected',
        windows: [],
        resetsAt: reset,
      }),
      reset - 3_600_000,
    );
    s = applyEvent(
      s,
      e({ type: 'error', message: 'лимит 5-часового окна исчерпан', fatal: false, code: 'limit' }),
      reset - 3_600_000,
    );
    const row = s.rows[0] as Extract<FeedRow, { kind: 'sys' }>;
    expect(row.tone).toBe('bad');
    expect(row.text).toEqual(['ход не начат: лимит 5-часового окна исчерпан · сброс в 17:00']);
    // новый ход — время сброса забыто
    s = applyEvent(s, e({ type: 'turn.start', at: 1 }), 1);
    expect(s.limitResetsAt).toBeUndefined();
  });

  it('ошибка без кода лимита — карточка ошибки, а не «ход не начат»', () => {
    const s = applyEvent(initialState(), e({ type: 'error', message: 'сеть', fatal: false }), 0);
    expect(s.rows[0]).toMatchObject({ kind: 'fail', message: 'сеть', fatal: false, state: 'open' });
    expect(s.status).toBe('error');
  });
});

describe('карточки .ask (этап 5)', () => {
  const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;
  const perm = (id: string, extra: Record<string, unknown> = {}) =>
    ev({
      type: 'permission.request',
      toolUseId: id,
      toolName: 'Bash',
      input: { command: 'ls' },
      canAlwaysAllow: false,
      ...extra,
    });
  const resolved = (
    id: string,
    decision: 'allow' | 'deny',
    by: 'user' | 'abort' = 'user',
    agentId?: string,
  ) =>
    ev({
      type: 'permission.resolved',
      toolUseId: id,
      decision,
      by,
      ...(agentId ? { agentId } : {}),
    });

  it('запрос субагента — карточка в ленте и waiting; повтор того же id — без второй карточки', () => {
    let s = applyEvent(initialState(), ev({ type: 'turn.start', at: 1 }), 1);
    s = applyEvent(s, perm('p', { agentId: 'sub' }), 2);
    s = applyEvent(s, perm('p', { agentId: 'sub' }), 2);
    expect(s.rows.filter((r) => r.kind === 'perm')).toHaveLength(1);
    expect(s.status).toBe('waiting');
    expect(activeCard(s)?.toolUseId).toBe('p');
  });

  it('два запроса: ответ на один оставляет waiting и активной — второй', () => {
    let s = applyEvent(initialState(), ev({ type: 'turn.start', at: 1 }), 1);
    s = applyEvent(s, perm('a'), 2);
    s = applyEvent(s, perm('b'), 2);
    s = markPermission(s, 'a', 'allow');
    expect(activeCard(s)?.toolUseId).toBe('b');
    s = applyEvent(s, resolved('a', 'allow'), 3);
    expect(s.status).toBe('waiting');
    s = applyEvent(s, resolved('b', 'allow'), 3);
    expect(s.status).toBe('working');
    expect(s.rows.some((r) => r.kind === 'perm')).toBe(false);
  });

  it('отказ — строка «отклонено: команда» на месте карточки; отмена движком — без строки', () => {
    let s = applyEvent(initialState(), perm('a'), 1);
    s = markPermission(s, 'a', 'deny');
    s = applyEvent(s, resolved('a', 'deny'), 1);
    expect(s.rows).toMatchObject([
      { kind: 'sys', tone: 'bad', text: ['отклонено: ', { code: 'ls' }] },
    ]);
    let t = applyEvent(initialState(), perm('b'), 1);
    t = applyEvent(t, resolved('b', 'deny', 'abort'), 1);
    expect(t.rows).toEqual([]);
    expect(t.pending).toEqual([]);
  });

  it('превью от хоста цепляется к карточке по toolUseId', () => {
    let s = applyEvent(
      initialState(),
      perm('a', { toolName: 'Edit', input: { file_path: '/p/x.ts' } }),
      1,
    );
    s = attachPreview(s, 'a', {
      filePath: '/p/x.ts',
      add: 1,
      del: 0,
      hunks: [],
      hidden: 0,
      isNew: false,
    });
    expect((s.rows[0] as PermCard).preview?.add).toBe(1);
    expect(permissionSubject(s.rows[0] as PermCard)).toBe('x.ts');
  });

  it('вопросы: multiSelect, свой ответ, несколько вопросов', () => {
    const questions = [
      {
        question: 'Цвет?',
        header: 'Цвет',
        options: [{ label: 'Красный' }, { label: 'Синий' }],
        multiSelect: true,
      },
      {
        question: 'Размер?',
        header: 'Размер',
        options: [{ label: 'S' }, { label: 'M' }],
        multiSelect: false,
      },
    ];
    let s = applyEvent(
      initialState(),
      ev({ type: 'question.request', toolUseId: 'q', questions }),
      1,
    );
    s = pickOption(s, 'q', 'Цвет?', 'Красный');
    s = pickOption(s, 'q', 'Цвет?', 'Синий');
    expect(questionReady(s.rows[0] as QuestionCard)).toBe(false);
    s = setCustomAnswer(s, 'q', 'Размер?', 'XL');
    const card = s.rows[0] as QuestionCard;
    expect(questionReady(card)).toBe(true);
    expect(answersOf(card)).toEqual({ 'Цвет?': 'Красный, Синий', 'Размер?': 'XL' });
    expect(answerSummary(card)).toEqual(['Цвет: выбраны варианты 1, 2 · Размер: свой ответ: XL']);
    // повторный клик снимает выбор
    s = pickOption(s, 'q', 'Цвет?', 'Красный');
    expect(answersOf(s.rows[0] as QuestionCard)['Цвет?']).toBe('Синий');
  });

  it('отклонённый вопрос и отменённый план', () => {
    let s = applyEvent(
      initialState(),
      ev({ type: 'question.request', toolUseId: 'q', questions: [] }),
      1,
    );
    s = applyEvent(s, resolved('q', 'deny'), 1);
    expect(s.rows.map((r) => r.kind)).toEqual(['question', 'sys']);
    expect((s.rows[0] as QuestionCard).state).toBe('declined');
    let t = applyEvent(
      initialState(),
      ev({ type: 'plan.request', toolUseId: 'p', plan: '# P' }),
      1,
    );
    t = applyEvent(t, resolved('p', 'deny', 'abort'), 1);
    expect(t.rows.map((r) => r.kind)).toEqual(['plan']);
    expect((t.rows[0] as PlanCard).state).toBe('cancelled');
  });

  it('отклонённый план — красная строка', () => {
    let s = applyEvent(
      initialState(),
      ev({ type: 'plan.request', toolUseId: 'p', plan: '# P' }),
      1,
    );
    s = markPlan(s, 'p', 'reject');
    s = applyEvent(s, resolved('p', 'deny'), 1);
    expect(s.rows[1]).toMatchObject({ kind: 'sys', tone: 'bad', text: ['план отклонён'] });
  });
});

describe('ошибки и лимит (этап 7)', () => {
  const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;
  const kindsOf = (s: ChatState) => s.rows.map((r) => r.kind);
  const turn = (s: ChatState) =>
    applyEvent(s, ev({ type: 'turn.start', at: 1, prompt: 'сделай' }), 1);

  it('fatal error + session.closed(error) — одна карточка с turn=true, открытые строки закрыты', () => {
    let s = turn(initialState());
    s = applyEvent(s, ev({ type: 'tool.start', toolUseId: 't', name: 'Bash', input: {} }), 1);
    s = applyEvent(s, ev({ type: 'error', fatal: true, message: 'ECONNRESET' }), 1);
    s = applyEvent(s, ev({ type: 'session.closed', reason: 'error', message: 'ECONNRESET' }), 1);
    const fails = s.rows.filter((r): r is Extract<FeedRow, { kind: 'fail' }> => r.kind === 'fail');
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ fatal: true, turn: true, message: 'ECONNRESET' });
    expect(s.rows.find((r) => r.kind === 'tool')).toMatchObject({ state: 'stopped' });
    expect(s.status).toBe('error');
    expect(s.closed?.reason).toBe('error');
  });

  it('exit посреди хода — карточка, exit в покое — тихая строка', () => {
    const mid = applyEvent(turn(initialState()), ev({ type: 'session.closed', reason: 'exit' }), 1);
    expect(kindsOf(mid)).toContain('fail');
    const idle = applyEvent(initialState(), ev({ type: 'session.closed', reason: 'exit' }), 1);
    expect(kindsOf(idle)).toEqual(['sys']);
  });

  it('после успешного хода (sum) ошибка — карточка «возобновить», не «повторить ход»', () => {
    let s = turn(initialState());
    s = applyEvent(
      s,
      ev({
        type: 'turn.result',
        ok: true,
        subtype: 'success',
        interrupted: false,
        durationMs: 1,
        apiDurationMs: 0,
        numTurns: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        totalCostUsd: 0,
        permissionDenials: [],
      }),
      2,
    );
    s = applyEvent(s, ev({ type: 'error', fatal: true, message: 'упал' }), 3);
    expect(s.rows.at(-1)).toMatchObject({ kind: 'fail', turn: false });
  });

  it('api_retry — не ошибка: одна нейтральная строка на серию повторов, статус не меняется', () => {
    let s = turn(initialState());
    s = applyEvent(
      s,
      ev({ type: 'error', fatal: false, code: 'api_retry', message: 'Повтор 1/10' }),
      1,
    );
    s = applyEvent(
      s,
      ev({ type: 'error', fatal: false, code: 'api_retry', message: 'Повтор 2/10' }),
      1,
    );
    const rows = s.rows.filter((r) => r.kind === 'sys');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: ['Повтор 2/10'] });
    expect((rows[0] as { tone?: string }).tone).toBeUndefined();
    expect(s.status).toBe('working');
  });

  it('markRetrying гасит карточку; новая ошибка заменяет «повторяю…», а не копится', () => {
    let s = applyEvent(turn(initialState()), ev({ type: 'error', fatal: true, message: 'a' }), 1);
    s = markRetrying(s);
    expect(s.rows.at(-1)).toMatchObject({ kind: 'fail', state: 'retrying' });
    s = applyEvent(s, ev({ type: 'error', fatal: true, message: 'b' }), 2);
    const fails = s.rows.filter((r) => r.kind === 'fail');
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ message: 'b', state: 'open' });
  });

  it('карточка ошибки гаснет (становится красной строкой), когда человек пошёл дальше: новое сообщение или ход', () => {
    const base = applyEvent(
      turn(initialState()),
      ev({ type: 'error', fatal: false, message: 'ответ не получен' }),
      1,
    );
    expect(base.rows.at(-1)).toMatchObject({ kind: 'fail', state: 'open' });
    for (const s of [
      queueUser(base, 'дальше'),
      applyEvent(base, ev({ type: 'turn.start', at: 2, prompt: 'дальше' }), 2),
    ]) {
      expect(s.rows.some((r) => r.kind === 'fail')).toBe(false);
      expect(s.rows.find((r) => r.kind === 'sys' && r.tone === 'bad')).toMatchObject({
        text: ['ответ не получен'],
      });
    }
  });

  it('limit.update rejected и ошибка limit — одна строка «ход не начат» с причиной и сбросом', () => {
    let s = turn(initialState());
    s = applyEvent(
      s,
      ev({
        type: 'limit.update',
        source: 'engine',
        status: 'rejected',
        windows: [],
        resetsAt: 5 * 3_600_000,
      }),
      1,
    );
    s = applyEvent(
      s,
      ev({ type: 'error', fatal: false, code: 'limit', message: 'лимит 5-часового окна исчерпан' }),
      1,
    );
    const rows = s.rows.filter((r) => r.kind === 'sys' && r.tag === 'limit');
    expect(rows).toHaveLength(1);
    const text = (rows[0] as Extract<FeedRow, { kind: 'sys' }>).text.join('');
    expect(text).toContain('ход не начат: лимит 5-часового окна исчерпан');
    expect(text).toContain('сброс в');
    expect(s.status).toBe('limited');
    // событие без текста позже не затирает причину
    s = applyEvent(
      s,
      ev({ type: 'limit.update', source: 'engine', status: 'rejected', windows: [] }),
      2,
    );
    expect(
      (
        s.rows.find((r) => r.kind === 'sys' && r.tag === 'limit') as Extract<
          FeedRow,
          { kind: 'sys' }
        >
      ).text.join(''),
    ).toContain('5-часового');
  });

  it('seedHistory: давняя ошибка из транскрипта — строка, без кнопки; closed не переносится', () => {
    const s = seedHistory(
      initialState(),
      { sessionId: 's', skippedTurns: 0 },
      [
        ev({ type: 'turn.start', at: 1, prompt: 'x' }),
        ev({ type: 'error', fatal: false, code: 'unknown', message: 'API Error' }),
      ],
      10,
    );
    expect(kindsOf(s)).not.toContain('fail');
    expect(s.rows.at(-1)).toMatchObject({ kind: 'sys', tone: 'bad', text: ['API Error'] });
    expect(s.closed).toBeUndefined();
  });
});
