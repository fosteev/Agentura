import type { ComponentChildren } from 'preact';
import type { FeedRow } from '../chatState';
import type { SessionSummary } from '../../protocol';
import type { AgentsView, FeedStyle } from '../../settings';
import { agentMapView } from '../agentsView';
import { agentGraphView, agentsViewPane, defaultScope } from '../agentViews';
import { graphModel } from '../agentsGraph/model';
import { AgentsGraph } from './AgentsGraph';
import { initialHud, type AgentNode, type HudState, type TimelineSeg } from '../hudState';
import { uiLang } from '../strings';
import { Log } from './Log';
import { SidebarView, type SidebarData, type SidebarLook } from './Sidebar';
import { AgentsPane } from './SidePanes';

/**
 * Миниатюры вида во вкладке настроек: настоящие `Log` и `SidebarView` на фикстуре, уменьшенные CSS-`zoom`.
 * Вёрстка та же, что у ленты и панели, поэтому превью не расходится с ними. Все превью `inert` — только картинка.
 */

const CWD = '/repo';
const noop = () => {};

const TEXT = {
  ru: {
    ask: 'Почини мигание счётчика талонов на табло',
    think: 'табло сбрасывает состояние при новом соединении',
    reply:
      'Причина — `Counter` сбрасывал счётчик при каждом переподключении сокета. Убрал сброс: значение держится до нового снимка, тесты проходят.',
    sessions: [
      'мигание счётчика талонов',
      'плашка «нет связи» на табло',
      'почему падает lint в ws-client',
      'ретраи запросов к сервису очереди',
      'миграция табло на новый ws-client',
    ],
    account: { email: 'you@example.com', plan: 'Max 5×', login: 'через CLI · ок' },
  },
  en: {
    ask: 'Fix the ticket counter flicker on the board',
    think: 'the board resets its state on a new connection',
    reply:
      'The cause: `Counter` reset the count on every socket reconnect. Removed the reset: the value holds until the next snapshot, tests pass.',
    sessions: [
      'ticket counter flicker',
      '“no connection” banner on the board',
      'why lint fails in ws-client',
      'retries for queue service requests',
      'move the board to the new ws-client',
    ],
    account: { email: 'you@example.com', plan: 'Max 5×', login: 'CLI · ok' },
  },
}[uiLang];

/** Один завершённый ход: запрос, раздумье, чтение, правка, тесты, ответ, итог. */
function feedRows(now: number): FeedRow[] {
  const t = now - 60_000;
  const file = `${CWD}/apps/board/src/Counter.tsx`;
  return [
    { id: 1, kind: 'user', text: TEXT.ask, at: '14:41' },
    { id: 2, kind: 'think', messageId: 'm1', text: TEXT.think, startedAt: t, endedAt: t + 12_000 },
    {
      id: 3,
      kind: 'tool',
      toolUseId: 't1',
      name: 'Read',
      input: { file_path: file },
      startedAt: t + 12_000,
      state: 'ok',
      durationMs: 300,
    },
    {
      id: 4,
      kind: 'tool',
      toolUseId: 't2',
      name: 'Edit',
      input: { file_path: file, old_string: 'a\nb', new_string: 'a\nb\nc\nd\ne\nf' },
      startedAt: t + 14_000,
      state: 'ok',
      durationMs: 1_100,
    },
    {
      id: 5,
      kind: 'tool',
      toolUseId: 't3',
      name: 'Bash',
      input: { command: 'pnpm test --filter board' },
      startedAt: t + 16_000,
      state: 'ok',
      durationMs: 9_800,
    },
    { id: 6, kind: 'text', messageId: 'm2', text: TEXT.reply, streaming: false },
    { id: 7, kind: 'sum', parts: ['in 1 204', 'out 2 318'], cost: '$0.21', time: '48s' },
  ];
}

function sidebarData(now: number): SidebarData {
  const min = 60_000;
  const states: SessionSummary['state'][] = ['live', 'waiting', 'idle', 'idle', 'idle'];
  const ago = [0, 96 * min, 3 * 60 * min, 4 * 60 * min, 26 * 60 * min];
  const ctx = [131_000, 44_000, 12_000, 27_000, 168_000];
  const sessions = TEXT.sessions.map((title, i): SessionSummary => ({
    id: `s${i}`,
    title,
    turns: [14, 3, 2, 7, 31][i] ?? 1,
    costUsd: [1.84, 0.42, 0.11, 0.93, 6.2][i] ?? 0,
    state: states[i] ?? 'idle',
    updatedAt: now - (ago[i] ?? 0),
    contextTokens: ctx[i] ?? 0,
  }));
  return {
    windows: [
      { kind: 'five-hour', percent: 62, resetsAt: now + 128 * min },
      { kind: 'weekly', percent: 34, resetsAt: now + 3 * 24 * 60 * min },
    ],
    account: { ...TEXT.account, engine: 'claude 2.1.285' },
    sessions,
    current: 's0',
    project: 'queue-board',
    now,
  };
}

/** Лента в виде `style`; `scaled` — размер текста из настройки (`--feed-zoom`), иначе масштаб карточки. */
export function FeedPreview({ style, scaled }: { style: FeedStyle; scaled?: boolean }) {
  const now = Date.now();
  return (
    <div class={scaled ? 'pv pv-feed pv-sized' : 'pv pv-feed'} inert aria-hidden="true">
      <div class="webview" data-feed={style}>
        <Log
          rows={feedRows(now)}
          cwd={CWD}
          now={now}
          showThinking
          mode=""
          onDiff={noop}
          onPreview={noop}
          onOpenUrl={noop}
        />
      </div>
    </div>
  );
}

// ——— вкладка «агенты»: момент прототипа (ход 14 идёт 1:18, два агента идут, один готов, один упал, фоном dev-сервер) ———

const AGENTS_TEXT = {
  ru: {
    board: 'apps/board — где сбрасывается состояние',
    kiosk: 'apps/kiosk — где сбрасывается состояние',
    operator: 'apps/operator — где сбрасывается состояние',
    ws: 'ws-client — воспроизвести разрыв',
    prompt:
      'Найди все места, где при переподключении сокета сбрасывается состояние очереди и талонов. Только чтение.',
    done: '1 место: Queue.tsx:58 — сброс очереди в onOpen до прихода снимка.',
    err: 'bash pnpm test:e2e — ECONNREFUSED 127.0.0.1:4100',
    dev: 'pnpm dev --filter board',
  },
  en: {
    board: 'apps/board — where the state is reset',
    kiosk: 'apps/kiosk — where the state is reset',
    operator: 'apps/operator — where the state is reset',
    ws: 'ws-client — reproduce the disconnect',
    prompt:
      'Find every place where the queue and ticket state is reset when the socket reconnects. Read only.',
    done: '1 place: Queue.tsx:58 — the queue is reset in onOpen before the snapshot arrives.',
    err: 'bash pnpm test:e2e — ECONNREFUSED 127.0.0.1:4100',
    dev: 'pnpm dev --filter board',
  },
}[uiLang];

/** Фикстура `HudState` для превью: те же агенты, что в прототипе `agents-map.html`. */
function agentsHud(now: number): HudState {
  const t0 = now - 78_000;
  const call = (id: string, name: string, input: Record<string, unknown>, at: number, endAt?: number): TimelineSeg => ({
    id,
    kind: 'tool',
    name,
    input,
    at,
    ...(endAt !== undefined ? { endAt } : {}),
    state: endAt === undefined ? 'run' : 'ok',
  });
  const sub = (
    n: string,
    description: string,
    status: AgentNode['status'],
    from: number,
    to: number | undefined,
    tokens: number,
    calls: number,
    segs: TimelineSeg[],
    extra: Partial<AgentNode> = {},
  ): AgentNode => ({
    agentId: `tool-${n}`,
    taskId: `task-${n}`,
    description,
    taskType: 'local_agent',
    subagentType: 'Explore',
    background: false,
    status,
    startedAt: from,
    ...(to !== undefined ? { endedAt: to, durationMs: to - from } : {}),
    tokens,
    toolUses: calls,
    turnNo: 14,
    prompt: AGENTS_TEXT.prompt,
    model: 'claude-sonnet-5-5',
    segs,
    calls,
    ...extra,
  });
  const read = (id: string, from: number) => call(id, 'Read', { file_path: '/repo/src/store.ts' }, from, from + 400);
  const grep = (id: string, from: number, open = false) =>
    call(id, 'Grep', { pattern: 'on\\(open' }, from, open ? undefined : from + 200);
  return {
    ...initialHud(),
    context: { used: 136_080, max: 200_000 },
    turnNo: 14,
    turns: [
      {
        turnNo: 14,
        startedAt: t0,
        segs: [{ id: 'th', kind: 'think', at: t0, endAt: t0 + 6_000, state: 'ok' }],
      },
    ],
    agents: [
      sub('a', AGENTS_TEXT.board, 'completed', t0 + 5_000, t0 + 46_000, 9_400, 6, [
        read('a1', t0 + 6_000),
        read('a2', t0 + 14_000),
        grep('a3', t0 + 22_000),
      ], { summary: AGENTS_TEXT.done }),
      sub('b', AGENTS_TEXT.kiosk, 'running', t0 + 5_000, undefined, 12_300, 14, [
        read('b1', t0 + 20_000),
        grep('b2', t0 + 40_000),
        grep('b3', t0 + 70_000, true),
      ]),
      sub('c', AGENTS_TEXT.operator, 'running', t0 + 20_000, undefined, 7_800, 8, [
        read('c1', t0 + 30_000),
        read('c2', t0 + 60_000, ),
        call('c3', 'Read', { file_path: '/repo/src/panel/OperatorPanel.tsx' }, t0 + 74_000),
      ]),
      sub('d', AGENTS_TEXT.ws, 'failed', t0 + 5_000, t0 + 27_000, 2_100, 3, [
        call('d1', 'Bash', { command: 'pnpm test:e2e' }, t0 + 8_000, t0 + 26_000),
      ], { subagentType: 'general-purpose', summary: AGENTS_TEXT.err }),
      {
        agentId: 'tool-dev',
        taskId: 'task-dev',
        description: AGENTS_TEXT.dev,
        taskType: 'local_bash',
        background: true,
        status: 'running',
        startedAt: t0 - 6 * 60_000,
        turnNo: 11,
        segs: [],
        calls: 0,
      },
    ],
  };
}

/** Размер холста графа в превью (до уменьшения `zoom`). */
const GRAPH_PREVIEW = { w: 620, h: 560 };

/** Вкладка «агенты» в виде `view`: настоящий `AgentsPane` на фикстуре; `graph` — настоящий граф (холст без деталей). */
export function AgentsPreview({ view }: { view: AgentsView }) {
  const now = Date.now();
  const h = agentsHud(now);
  if (view === 'graph') {
    const snap = agentGraphView(h, { state: 'waiting', model: 'claude-opus-5-5', cwd: CWD });
    return (
      <div class="pv pv-agents pv-graph" inert aria-hidden="true">
        <div class="webview" data-agents={view}>
          <AgentsGraph
            model={graphModel(snap, { now, hasSession: true, selected: 'tool-b' })}
            size={GRAPH_PREVIEW}
            onTurn={noop}
            onSelect={noop}
            onStop={noop}
            onTranscript={noop}
          />
        </div>
      </div>
    );
  }
  const o = { working: true, waiting: true, now, cwd: CWD, hasSession: true, model: 'claude-opus-5-5' };
  return (
    <div class="pv pv-agents" inert aria-hidden="true">
      <div class="webview" data-agents={view}>
        <aside class="pane side">
          <AgentsPane
            model={
              view === 'list'
                ? { mode: 'list', view: agentMapView(h, o) }
                : { mode: 'views', view: agentsViewPane(h, view, defaultScope(view), o) }
            }
            now={now}
            onSelect={noop}
            onStop={noop}
            onTranscript={noop}
            onScope={noop}
          />
        </aside>
      </div>
    </div>
  );
}

/** Боковая панель: `part="top"` — верх (аккаунт, лимиты), `"list"` — заголовок «Сессии» и список. */
export function SidebarPreview({ look, part }: { look: SidebarLook; part: 'top' | 'list' }) {
  return (
    <div class={`pv pv-side pv-${part}`} inert aria-hidden="true">
      <SidebarView look={look} data={sidebarData(Date.now())} />
    </div>
  );
}

/** Выбор вида карточками-миниатюрами (`role="radiogroup"`): клик выбирает, стрелки — как у радиокнопок. */
export function ChoiceCards<V extends string>({
  label,
  value,
  options,
  preview,
  onPick,
  onTry,
  kind,
  removable,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  preview: (v: V) => ComponentChildren;
  onPick: (v: V) => void;
  /** Примерка: наведение или фокус на карточке (`undefined` — ушли). */
  onTry?: (v: V | undefined) => void;
  /** Модификатор сетки: `fonts` — плотные карточки шрифтов. */
  kind?: string;
  /** У части карточек — ✕ «удалить» (скачанные шрифты); кнопка рядом с карточкой, не внутри неё. */
  removable?: { has: (v: V) => boolean; label: string; onRemove: (v: V) => void };
}) {
  const ids = options.map(([v]) => v);
  const onKey = (e: KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    // стрелки — только на карточках; на ✕ рядом с карточкой они не должны менять выбор
    if (!step || (e.target as HTMLElement).getAttribute('role') !== 'radio') return;
    e.preventDefault();
    const next = ids[(ids.indexOf(value) + step + ids.length) % ids.length];
    if (next === undefined) return;
    onPick(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div
      class={kind ? `cards ${kind}` : 'cards'}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      onMouseLeave={() => onTry?.(undefined)}
      onFocusOut={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null))
          onTry?.(undefined);
      }}
    >
      {options.map(([v, name]) => {
        const card = (
          <button
            key={v}
            type="button"
            role="radio"
            data-value={v}
            aria-checked={v === value}
            tabIndex={v === value ? 0 : -1}
            class={v === value ? 'card on' : 'card'}
            onClick={() => v !== value && onPick(v)}
            onMouseEnter={() => onTry?.(v)}
            onFocus={() => onTry?.(v)}
          >
            {preview(v)}
            <span class="cn">{name}</span>
          </button>
        );
        if (!removable?.has(v)) return card;
        return (
          <div key={v} class="cw">
            {card}
            <button
              type="button"
              class="cx"
              data-remove={v}
              aria-label={`${removable.label}: ${name}`}
              title={removable.label}
              onClick={(e) => {
                // кнопка исчезнет вместе с карточкой — фокус на выбранную карточку группы, а не в никуда
                (e.currentTarget as HTMLElement)
                  .closest('[role="radiogroup"]')
                  ?.querySelector<HTMLElement>('[aria-checked="true"]')
                  ?.focus();
                removable.onRemove(v);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
