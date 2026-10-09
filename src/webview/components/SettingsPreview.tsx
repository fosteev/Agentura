import type { ComponentChildren } from 'preact';
import type { FeedRow } from '../chatState';
import type { SessionSummary, TaskGroupSummary } from '../../protocol';
import type { AgentsView, ComposerLayout, FeedStyle, GitLayout, TaskCardMode, TaskTabMode } from '../../settings';
import type { TabChatsMessage } from '../../shared/taskTab';
import type { TaskStateMessage } from '../../shared/task';
import type { GitFileStatus, GitFileView, GitRepoView, GitSnapshot } from '../../shared/git';
import { agentMapView } from '../agentsView';
import { agentGraphView, agentsViewPane, defaultScope } from '../agentViews';
import { graphModel } from '../agentsGraph/model';
import { AgentsGraph } from './AgentsGraph';
import { initialHud, type AgentNode, type HudState, type TimelineSeg } from '../hudState';
import { ui, uiLang } from '../strings';
import { Log } from './Log';
import { SidebarView, type SidebarData, type SidebarLook } from './Sidebar';
import { AgentsPane } from './SidePanes';
import { GitPane } from './GitPane';
import { ChatTabs, TaskStrip } from './TaskPane';

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
    tasks: [
      ['NEWMFC-1482', 'Электронная очередь: талон не печатается после перерыва', 'В работе'],
      ['GARM-833', 'Pulse: пуш о тревоге дублируется', 'Открыта'],
    ],
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
    tasks: [
      ['NEWMFC-1482', 'Electronic queue: the ticket is not printed after a break', 'In progress'],
      ['GARM-833', 'Pulse: the alarm push is duplicated', 'Open'],
    ],
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
        {/* data-active: в широкой вёрстке (html[data-width]) hud.css прячет вкладки панели, кроме активной */}
        <aside class="pane side" data-active="agents">
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

const gitFile = (path: string, status: GitFileStatus, add: number, del: number): GitFileView => ({
  path,
  status,
  add,
  del,
});

/** Три репозитория рабочей папки (фикстура превью раскладок вкладки «git»). */
function gitFixture(): GitSnapshot {
  const at = Date.now() - 3_600_000;
  const repo = (r: Partial<GitRepoView> & { name: string }): GitRepoView => ({
    root: `${CWD}/${r.name}`,
    rel: r.name,
    published: true,
    unstaged: [],
    staged: [],
    log: [],
    ...r,
  });
  return {
    state: 'ok',
    repos: [
      repo({
        name: 'board',
        branch: 'fix/board-blink',
        ahead: 1,
        behind: 0,
        unstaged: [gitFile('.env.local', 'M', 1, 1)],
        staged: [
          gitFile('src/__tests__/Counter.test.tsx', 'A', 31, 0),
          gitFile('src/Counter.tsx', 'M', 6, 2),
        ],
        log: [{ hash: '7be04d1', subject: 'Counter reads snapshot', at, unpushed: true }],
      }),
      repo({
        name: 'ws-client',
        branch: 'fix/reconnect',
        published: false,
        unstaged: [gitFile('README.md', 'M', 12, 0), gitFile('src/reconnect.test.ts', 'M', 18, 4)],
        staged: [gitFile('src/backoff.ts', 'A', 40, 0), gitFile('src/reconnect.ts', 'M', 27, 7)],
        log: [{ hash: 'c81e0b4', subject: 'Reconnect on close code 1006', at, unpushed: false }],
      }),
      repo({ name: 'infra', branch: 'main', ahead: 0, behind: 3 }),
    ],
  };
}

/** Вкладка «git» в раскладке `layout`: настоящий `GitPane` на трёх репозиториях. */
export function GitPreview({ layout }: { layout: GitLayout }) {
  const snapshot = gitFixture();
  return (
    <div class="pv pv-git" inert aria-hidden="true">
      <div class="webview" data-git={layout}>
        <aside class="pane side" data-active="git">
          <GitPane
            snapshot={snapshot}
            agentPaths={new Set()}
            cwd={CWD}
            tree={false}
            agentOnly={false}
            now={Date.now()}
            layout={layout}
            repoRoot={snapshot.repos[1]!.root}
            onTree={noop}
            onAgentOnly={noop}
            onRepo={noop}
          />
        </aside>
      </div>
    </div>
  );
}


// ——— поле ввода: статичный снимок (глобальное состояние поля превью не трогает) ———

const COMPOSER_TEXT = {
  ru: { typed: 'Почини мигание счётчика', file: 'Counter.tsx', lines: '12–40', project: 'queue-board' },
  en: { typed: 'Fix the counter flicker', file: 'Counter.tsx', lines: '12–40', project: 'queue-board' },
}[uiLang];

/** Поле ввода в раскладке `layout`: те же классы и `data-layout`, что у настоящего, данные — образец (контекст 66 %). */
export function ComposerPreview({ layout }: { layout: ComposerLayout }) {
  const T = COMPOSER_TEXT;
  const c = ui.compose;
  const mode = ui.modes.default?.[0] ?? '';
  const vars = '--p:66;--c:var(--warn)';
  const typed = (
    <div class="pop">
      <div class="prompt">
        <span class="p">$</span>
        <div class="typed">{T.typed}</div>
      </div>
    </div>
  );
  const ring = (
    <span class="cr">
      <span class="ring" style={vars} />
      <span class="pc" style="color:var(--warn)">66%</span>
    </span>
  );
  const bar = (
    <span class="bar" style={vars}>
      <i />
      <u style="left:75%" />
    </span>
  );
  const btn = (cls: string, label: string) => (
    <span class="pop">
      <button class={cls}>{label}</button>
    </span>
  );
  const chip = (
    <span class="auto">
      {c.autoFile} <b>{T.file}</b>
      <span class="x">✕</span>
    </span>
  );
  const cache = (
    <span class="meters time">
      <span class="m">
        <span class="clock" />
        <b>3:12</b>
      </span>
      <span class="m lim">
        {c.fiveHour} <b class="pct">62%</b>
      </span>
    </span>
  );
  let body;
  if (layout === 'card') {
    body = (
      <>
        <div class="frame">
          <div class="chips">{chip}</div>
          {typed}
          <div class="row">
            <span class="pop"><button class="plus ib">{c.plus}</button></span>
            <span class="pop"><button class="pill mode"><b>{mode}</b></button></span>
            <span class="pop"><button class="pill engine">claude · opus 4.5 · high</button></span>
            <span class="sp" />
            {ring}
            <button class="send go">↑</button>
          </div>
        </div>
      </>
    );
  } else if (layout === 'statusline') {
    body = (
      <>
        <div class="inp">
          <div class="chips refs">
            <span class="auto ref">@<b>{T.file}</b><span class="rg-l">:{T.lines}</span></span>
          </div>
          {typed}
        </div>
        <div class="sl">
          {btn('plus', c.plus)}
          {btn('blk mode', mode)}
          {btn('agent', 'claude')}
          <span class="pop"><button><b>opus 4.5</b></button></span>
          <span class="pop"><button class="effort"><b>high</b></button></span>
          <span class="sp" />
          <span class="cr cs">ctx {bar} <b>131k/200k</b></span>
          {cache}
          <button class="send go">↵</button>
        </div>
      </>
    );
  } else if (layout === 'gauges') {
    body = (
      <>
        <div class="ctx top">
          <div class="chips">{chip}</div>
          <span class="g">
            <span class="cn gauge">{c.context} {bar} <b>131k/200k</b></span>
            {cache}
          </span>
        </div>
        {typed}
        <div class="sets">
          {btn('plus', c.plusFile)}
          {btn('mode', mode)}
          {btn('agent', 'claude')}
          <span class="pop"><button><b>opus 4.5</b></button></span>
          <span class="pop"><button><b>high</b></button></span>
          <span class="sp" />
          <button class="send go">{c.sendLong}</button>
        </div>
      </>
    );
  } else if (layout === 'minimal') {
    body = (
      <>
        <div class="one">
          {btn('dollar mode', '$')}
          <div class="chips">{chip}</div>
          {typed}
          {ring}
          {btn('plus ib', c.plus)}
          <span class="pop eng"><button class="engine">opus 4.5 · high</button></span>
          <button class="send go">↵</button>
        </div>
      </>
    );
  } else if (layout === 'shell') {
    body = (
      <>
        <div class="pl">
          <span class="dir">{T.project}</span>
          {btn('mdt mode', mode)}
          <span class="mdl">
            <span class="pop"><button>claude</button></span>
            <span class="sep-c">/</span>
            <span class="pop"><button><b>opus 4.5</b></button></span>
            <span class="sep-c">:</span>
            <span class="pop"><button><b>high</b></button></span>
          </span>
          {btn('plus', c.plus)}
          <span class="rg">
            <span class="cr cs">{bar} <b class="pc" style="color:var(--warn)">66%</b></span>
            {cache}
          </span>
        </div>
        <div class="chips refs">
          <span class="auto plus"><span class="mk">+</span><b>{T.file}</b><span class="rg-l">:{T.lines}</span></span>
        </div>
        <div class="ln">
          {typed}
          <button class="send go">↵</button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div class="blocks">
          {Array.from({ length: 20 }, (_, i) => (
            <i class={i < 13 ? 'on' : ''} />
          ))}
        </div>
        <div class="ctx">{chip}<span class="cn">{c.context} <b>131k / 200k</b></span></div>
        {typed}
        <div class="opts">
          {btn('plus', c.plus)}
          {btn('mode', mode)}
          {btn('agent', 'claude')}
          <span class="pop"><button>{c.model} <b>opus 4.5</b></button></span>
          <span class="pop"><button>{c.effort} <b>high</b></button></span>
          <button class="send">{c.send}</button>
        </div>
      </>
    );
  }
  return (
    <div class="pv pv-composer" inert aria-hidden="true">
      <div class="webview">
        <footer
          class="compose"
          data-layout={layout}
          style={layout === 'statusline' || layout === 'minimal' ? vars : undefined}
        >
          {body}
        </footer>
      </div>
    </div>
  );
}

/** Фикстура групп задач для превью `tasks.sidebar`: две задачи, чаты s0+s1 и s3; остальные — вне задач. */
function taskFixture(sessions: SessionSummary[]): { sessions: SessionSummary[]; tasks: TaskGroupSummary[] } {
  const [a, b] = TEXT.tasks as [string, string, string][];
  const spec: [[string, string, string], string[]][] = [
    [a!, ['s0', 's1']],
    [b!, ['s3']],
  ];
  const tasks = spec.map(([[key, title, status], sessionIds], i): TaskGroupSummary => ({
    taskKey: `jira:demo:${key}`,
    meta: { key, instanceId: 'demo', title, status, statusCategory: i === 0 ? 'indeterminate' : 'new', url: '' },
    sessionIds,
  }));
  const keyOf = new Map(tasks.flatMap((t) => t.sessionIds.map((id) => [id, t.meta] as const)));
  return {
    sessions: sessions.map((s) => {
      const m = keyOf.get(s.id);
      return m ? { ...s, task: { key: m.key, title: m.title, status: m.status } } : s;
    }),
    tasks,
  };
}

/** Боковая панель: верх, лимиты нескольких движков, список сессий или задачи Jira (группы / секция). */
export function SidebarPreview({
  look,
  part,
}: {
  look: SidebarLook;
  part: 'top' | 'limits' | 'list' | 'tasks';
}) {
  const data = sidebarData(Date.now());
  if (part === 'tasks') {
    const fx = taskFixture(data.sessions);
    data.sessions = fx.sessions;
    data.tasks = fx.tasks;
  }
  if (part === 'limits') {
    data.provider = 'claude';
    data.engines = [
      {
        engine: 'codex',
        state: 'ok',
        email: TEXT.account.email,
        plan: 'Plus',
        windows: [
          { kind: 'fiveHour', percent: 78, resetsAt: data.now + 60 * 60_000 },
          { kind: 'weekly', percent: 41, resetsAt: data.now + 2 * 24 * 60 * 60_000 },
        ],
        updatedAt: data.now,
      },
      {
        engine: 'antigravity',
        state: 'ok',
        email: TEXT.account.email,
        windows: [{ kind: 'model', name: 'Gemini', percent: 23 }],
        updatedAt: data.now,
      },
    ];
  }
  return (
    <div class={`pv pv-side pv-${part}`} inert aria-hidden="true">
      <SidebarView look={look} data={data} />
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


/** Фикстура для превью `tasks.card`: первая задача из образца, статус «в работе». */
function taskCardFixture(): TaskStateMessage & { taskKey: string } {
  const [key, title, status] = TEXT.tasks[0] as [string, string, string];
  return {
    type: 'task.state',
    taskKey: `jira:demo:${key}`,
    card: {
      key,
      instanceId: 'demo',
      instanceName: 'demo',
      title,
      type: 'Task',
      status,
      statusCategory: 'indeterminate',
      url: '',
      updatedAt: 0,
      description: '',
      descriptionHtml: '',
      created: 0,
      labels: [],
      components: [],
      fixVersions: [],
      time: {},
      attachments: [],
      comments: [],
      history: [],
      worklogs: [],
      canWrite: false,
    },
    events: [],
    fetchedAt: 1,
    source: 'jiraffe',
  };
}

/**
 * Где карточка задачи в чате по задаче (`tasks.card`, roadmap 19): схема окна редактора — настоящая полоска
 * `TaskStrip` и условные блоки (лента, вкладки панели, карточка Jiraffe). Сплит без Jiraffe работает как панель — пометка.
 */
export function TaskCardPreview({ mode }: { mode: TaskCardMode }) {
  const st = taskCardFixture();
  const lines = (n: number) => Array.from({ length: n }, () => <i />);
  const chat = (
    <div class="tcp-chat">
      <TaskStrip state={st} />
      <div class="tcp-feed">{lines(5)}</div>
    </div>
  );
  return (
    <div class={`pv pv-taskcard pv-tc-${mode}`} inert aria-hidden="true">
      {mode === 'split' && (
        <div class="tcp-card">
          <b>J</b>
          <div class="tcp-feed">{lines(6)}</div>
        </div>
      )}
      {chat}
      {/* вкладка «задача» есть в обоих режимах (roadmap 20, решение 10); схему под полосу задачи перерисует этап 2 */}
      <div class="tcp-side">
        <div class="tcp-tabs">
          <span class={mode === 'split' ? 'on' : undefined}>{ui.tabs.changes}</span>
          <span>{ui.tabs.git}</span>
          <span class={mode === 'tab' ? 'on' : undefined}>{ui.tabs.task}</span>
        </div>
        <div class="tcp-feed">{lines(5)}</div>
      </div>
      {mode === 'split' && <small class="tcp-note">{ui.settings.tasksCard.onlyJiraffe}</small>}
    </div>
  );
}

/**
 * Вкладки чатов по задаче (`tasks.tab`, roadmap 19, этап 7): схема окна редактора — ряд вкладок редактора, настоящая
 * полоска `TaskStrip`, у `task` — настоящие внутренние вкладки `ChatTabs` (`tasks.html#b`), и лента.
 */
export function TaskTabPreview({ mode }: { mode: TaskTabMode }) {
  const st = taskCardFixture();
  const key = st.card!.key;
  const [chat1, chat2] = TEXT.sessions as [string, string];
  const other = (TEXT.tasks[1] as [string, string, string])[0];
  const lines = (n: number) => Array.from({ length: n }, () => <i />);
  const inner: TabChatsMessage = {
    type: 'tab.chats',
    taskKey: st.taskKey,
    chats: [
      { id: 'c1', title: chat1, provider: 'claude', status: 'idle', active: false },
      { id: 'c2', title: chat2, provider: 'codex', status: 'working', active: true },
    ],
    persist: { taskKey: st.taskKey, chats: [] },
  };
  const tabs =
    mode === 'task' ? [key, other, TEXT.sessions[2]!] : [`${key} · ${chat2}`, `${key} · ${chat1}`, TEXT.sessions[2]!];
  return (
    <div class={`pv pv-tasktab pv-tt-${mode}`} inert aria-hidden="true">
      <div class="ttp-tabs">
        {tabs.map((t, i) => (
          <span class={i === 0 ? 'on' : undefined}>{t}</span>
        ))}
      </div>
      <div class="ttp-chat">
        <TaskStrip state={st} />
        {mode === 'task' && <ChatTabs state={inner} />}
        <div class="ttp-feed">{lines(4)}</div>
      </div>
    </div>
  );
}
