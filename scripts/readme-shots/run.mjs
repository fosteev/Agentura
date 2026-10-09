// README screenshots from the real webview bundles (dist/webview/*.js), English UI on English data.
// Renders every frame in headless Chrome (2x), then crops/montages them with PIL into docs/images/.
// Usage:  npm run build && node scripts/readme-shots/run.mjs     (needs Chrome, python3 + Pillow)
// Temporary html/png go to os.tmpdir(), nothing is written to the repo except the final PNGs.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as data from './data.mjs';
import { CHROME, ROOT, THEMES, graphHtml, montage, pool, put, shot, splitHtml, surfaceHtml } from './lib.mjs';

for (const s of ['chat', 'sidebar', 'agents', 'settings']) {
  if (!existsSync(join(ROOT, 'dist', 'webview', `${s}.js`))) {
    console.error(`dist/webview/${s}.js not found: run "npm run build" first`);
    process.exit(1);
  }
}
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  process.exit(1);
}

const OUT = join(ROOT, 'docs', 'images');
mkdirSync(OUT, { recursive: true });
const TMP = mkdtempSync(join(tmpdir(), 'agentura-readme-'));
const dark = THEMES.dark;
const jobs = []; // async functions, run in a pool

// ---- message sets -------------------------------------------------------------------------------------------

const limitsMsg = () => ({ type: 'limits.update', ...data.limits() });

/** Everything the host sends a chat tab on `ready`. */
function chatMessages(events, { feedStyle = 'journal', agentsView = 'list', gitLayout = 'stack', composerLayout = 'classic', extra = [] } = {}) {
  return [
    { type: 'chat.info', project: data.PROJECT, cwd: data.CWD, allowBypass: false, feedStyle, agentsView, gitLayout, composerLayout },
    { type: 'capabilities', sessionId: 's1', ...data.capabilities },
    { type: 'session.defaults', mode: 'manual', effort: 'high' },
    limitsMsg(),
    { type: 'session.history', sessionId: 's1', events, skippedTurns: 0, title: 'Fix board counter blink', model: data.MODEL, mode: 'default' },
    ...extra,
    limitsMsg(),
  ];
}

const sidebarMessages = ({ view = 'compact', top = 'compact' } = {}) => [
  { type: 'sidebar.view', view, context: true, time: true, top },
  { type: 'account.info', ...data.account },
  limitsMsg(),
  { type: 'sessions.update', sessions: data.sessions, current: 's1', project: data.PROJECT },
];

// ---- page helpers ---------------------------------------------------------------------------------------------

let n = 0;
const name = (p) => `${p}-${++n}`;

function chatPage(theme, events, panel, opts) {
  return put(TMP, `${name('chat')}.html`, surfaceHtml({ surface: 'chat', theme, state: { panel }, messages: chatMessages(events, opts) }));
}

function sidebarPage(theme, opts) {
  return put(TMP, `${name('sidebar')}.html`, surfaceHtml({ surface: 'sidebar', theme, bg: THEMES[theme].side, messages: sidebarMessages(opts) }));
}

const png = (p) => join(TMP, `${p}-${++n}.png`);
const labelStyle = { bg: dark.bg, fg: dark.desc };
const WIDE = { w: 360 }; // right panel width of the spec

// ---- 1. hero -------------------------------------------------------------------------------------------------

for (const theme of ['dark', 'light']) {
  jobs.push(async () => {
    const side = sidebarPage(theme);
    const chat = chatPage(theme, data.finishedTurn(), { ...WIDE, tab: 'changes' });
    const page = put(TMP, `${name('hero')}.html`, splitHtml({ theme, w: 1324, h: 760, panes: [{ file: side, w: 300 }, { file: chat, w: 1023 }] }));
    const raw = await shot(page, png('hero'), 1324, 760);
    await montage({ single: true, frames: [{ src: raw }], out: join(OUT, `hero-${theme}.png`) }, TMP);
  });
}

// ---- 2. feed styles (2x2) --------------------------------------------------------------------------------------

jobs.push(async () => {
  const styles = [['journal', 'journal (default)'], ['folded', 'folded'], ['replies', 'replies'], ['cards', 'cards']];
  const frames = await Promise.all(styles.map(async ([style, label]) => {
    const page = chatPage('dark', data.finishedTurn(), { off: true }, { feedStyle: style });
    return { src: await shot(page, png('feed'), 760, 760), label };
  }));
  await montage({ ...labelStyle, cols: 2, frames, out: join(OUT, 'feed-styles.png') }, TMP);
});

// ---- 2b. composer layouts (2x3): the bottom of the tab ---------------------------------------------------------

jobs.push(async () => {
  const layouts = [['classic', 'classic (default)'], ['card', 'card'], ['statusline', 'status line'], ['gauges', 'gauges on top'], ['minimal', 'minimal'], ['shell', 'shell prompt']];
  const extra = [
    { type: 'context.usage', usedTokens: 131_250, maxTokens: 200_000, source: 'engine' },
    { type: 'editor.context', file: { path: 'apps/board/src/Counter.tsx', name: 'Counter.tsx' }, selection: { path: 'apps/board/src/Counter.tsx', name: 'Counter.tsx', startLine: 12, endLine: 40 } },
  ];
  const frames = await Promise.all(layouts.map(async ([layout, label]) => {
    const page = chatPage('dark', data.finishedTurn(), { off: true }, { composerLayout: layout, extra });
    // 760 px tall page at 2x: keep the lowest 190 css px, which is the whole input of every layout
    return { src: await shot(page, png('composer'), 760, 760), label, crop: [0, 1140, 1520, 380] };
  }));
  await montage({ ...labelStyle, cols: 2, frames, out: join(OUT, 'composer-layouts.png') }, TMP);
});

// ---- 3/4. agents: four views in the right panel, and the graph tab ---------------------------------------------

const AGENTS_GRID = { cols: 4 }; // 1x4 in a row: four 360 px strips next to each other read better than a 2x2 of tall ones
jobs.push(async () => {
  const views = ['list', 'tree', 'lanes', 'cards'];
  const frames = await Promise.all(views.map(async (view) => {
    const page = chatPage('dark', data.runningTurn(), { ...WIDE, tab: 'agents' }, { agentsView: view });
    return { src: await shot(page, png('agents'), 1000, 760), label: view, crop: [(1000 - WIDE.w) * 2, 0, WIDE.w * 2, 1520] };
  }));
  await montage({ ...labelStyle, ...AGENTS_GRID, frames, out: join(OUT, 'agents-views.png') }, TMP);
});

jobs.push(async () => {
  const events = data.runningTurn();
  const focusId = events.find((e) => e.type === 'agent.start' && e.taskId === 'a2').agentId;
  const chat = put(TMP, `${name('gchat')}.html`, surfaceHtml({
    surface: 'chat', theme: 'dark', relay: true, state: { panel: { off: true } },
    messages: [...chatMessages(events, { agentsView: 'graph' }), { type: 'agents.graph', open: true }],
  }));
  const graph = put(TMP, `${name('graph')}.html`, surfaceHtml({ surface: 'agents', theme: 'dark', messages: [] }));
  const page = put(TMP, `${name('gwrap')}.html`, graphHtml({ theme: 'dark', w: 1100, h: 760, chatFile: chat, graphFile: graph, focusId }));
  const raw = await shot(page, png('graph'), 1100, 760, 6000);
  await montage({ single: true, frames: [{ src: raw }], out: join(OUT, 'agents-graph.png') }, TMP);
});

// ---- 5. git layouts (1x3) --------------------------------------------------------------------------------------

jobs.push(async () => {
  const layouts = ['stack', 'picker', 'unified'];
  const frames = await Promise.all(layouts.map(async (layout) => {
    const panel = { ...WIDE, tab: 'git', ...(layout === 'picker' ? { gitRepo: `${data.CWD}/ws-client` } : {}) };
    const page = chatPage('dark', data.gitTurn(), panel, { gitLayout: layout, extra: [{ type: 'git.state', snapshot: data.gitSnapshot }] });
    return { src: await shot(page, png('git'), 1000, 760), label: layout, crop: [(1000 - WIDE.w) * 2, 0, WIDE.w * 2, 1520] };
  }));
  await montage({ ...labelStyle, cols: 3, frames, out: join(OUT, 'git-layouts.png') }, TMP);
});

// ---- 6. session list (1x3) -------------------------------------------------------------------------------------

jobs.push(async () => {
  const frames = await Promise.all(['detailed', 'compact', 'dense'].map(async (view) => {
    // headless Chrome will not lay a window out narrower than ~500 px: the 300 px sidebar lives in an iframe
    const side = sidebarPage('dark', { view });
    const page = put(TMP, `${name('sessions')}.html`, splitHtml({ theme: 'dark', w: 300, h: 760, panes: [{ file: side, w: 300 }] }));
    return { src: await shot(page, png('sessions'), 300, 760), label: view, crop: [0, 0, 600, 1520] };
  }));
  await montage({ ...labelStyle, cols: 3, frames, out: join(OUT, 'session-list.png') }, TMP);
});

// ---- 7. settings, page "Look" ----------------------------------------------------------------------------------

jobs.push(async () => {
  const values = {
    defaultPermissionMode: 'manual', allowBypassPermissions: false, defaultModel: '', defaultEffort: 'high',
    contextThresholds: [120_000, 150_000], usagePollMinutes: 15, 'limits.readKeychain': true, claudeExecutable: '',
    'sessionList.view': 'compact', 'sessionList.context': true, 'sessionList.time': true, 'sidebar.top': 'detailed',
    'feed.style': 'journal', 'composer.layout': 'classic', 'agents.view': 'list', 'git.layout': 'stack', 'feed.fontSize': 13, 'ui.fontSize': 13,
    'font.interface': '', 'font.panels': '', 'font.code': '', language: 'auto',
  };
  const page = put(TMP, `${name('settings')}.html`, surfaceHtml({
    surface: 'settings', theme: 'dark', state: { settingsSection: 'look' },
    messages: [{ type: 'settings.state', values, overridden: [] }],
  }));
  const raw = await shot(page, png('settings'), 1100, 760);
  // only the feed style cards: the agent-view previews below are cramped at this width (app bug, not the harness)
  await montage({ single: true, frames: [{ src: raw, crop: [0, 0, 2200, 704] }], out: join(OUT, 'settings-look.png') }, TMP);
});

// ---- 8. Jira tasks (roadmap 19, stage 9): `node scripts/readme-shots/run.mjs tasks` renders only these --------------
// Frames of both themes go to TASK_SHOTS_DIR (task-real-<frame>-<theme>.png); the README picture is docs/images/jira-tasks.png.

const SHOTS = process.env.TASK_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const taskJobs = [];
const taskMsgs = [data.taskState(), data.taskChatRows()];
const seenOld = () => Date.now() - 60 * 60_000; // everything newer than this is "new" in the feed

const taskSidebar = (theme, mode) => put(TMP, `${name('tsidebar')}.html`, surfaceHtml({
  surface: 'sidebar', theme, bg: THEMES[theme].side,
  messages: [
    { type: 'sidebar.view', view: 'compact', context: true, time: true, top: 'compact', tasks: mode },
    { type: 'account.info', ...data.account },
    limitsMsg(),
    { type: 'sessions.update', sessions: data.taskSessions, current: 's1', project: data.PROJECT, tasks: data.taskGroups },
  ],
}));

const taskChat = (theme, panel, extra = []) => chatPage(theme, data.taskTurn(), panel, { extra: [...taskMsgs, ...extra] });
const out = (frame, theme) => (SHOTS ? join(SHOTS, `task-real-${frame}-${theme}.png`) : join(TMP, `task-real-${frame}-${theme}.png`));
const single = (src, dest) => montage({ single: true, frames: [{ src }], out: dest }, TMP);

for (const theme of ['dark', 'light']) {
  for (const mode of ['groups', 'section']) {
    taskJobs.push(async () => {
      const page = put(TMP, `${name('tside')}.html`, splitHtml({ theme, w: 300, h: 760, panes: [{ file: taskSidebar(theme, mode), w: 300 }] }));
      await single(await shot(page, png('tside'), 300, 760), out(`sidebar-${mode}`, theme));
    });
  }
  // roadmap 20: the card is the "task" view of the chat tab (view: 'task'), the sub-tab is taskView
  for (const [frame, view, sub] of [['chat', 'chat', 'comments'], ['card', 'task', 'comments'], ['changes', 'task', 'changes']]) {
    taskJobs.push(async () => {
      const panel = { ...WIDE, tab: 'changes', view, taskView: sub, taskSeen: seenOld(), taskSeenKey: data.TASK_KEY };
      await single(await shot(taskChat(theme, panel), png('tchat'), 1100, 760), out(`chat-${frame}`, theme));
    });
  }
  taskJobs.push(async () => {
    const panel = { ...WIDE, tab: 'changes', view: 'chat', taskView: 'changes', taskSeen: seenOld(), taskSeenKey: data.TASK_KEY };
    const chat = taskChat(theme, panel, [data.tabChats()]);
    await single(await shot(chat, png('ttab'), 1100, 760), out('tab', theme));
  });
  taskJobs.push(async () => {
    const values = {
      defaultPermissionMode: 'manual', allowBypassPermissions: false, defaultModel: '', defaultEffort: 'high',
      contextThresholds: [120_000, 150_000], usagePollMinutes: 15, 'limits.readKeychain': true, claudeExecutable: '',
      'sessionList.view': 'compact', 'sessionList.context': true, 'sessionList.time': true, 'sidebar.top': 'detailed',
      'feed.style': 'journal', 'composer.layout': 'classic', 'agents.view': 'list', 'git.layout': 'stack', 'feed.fontSize': 13, 'ui.fontSize': 13,
      'font.interface': '', 'font.panels': '', 'font.code': '', language: 'auto',
      'tasks.sidebar': 'groups', 'tasks.card': 'tab', 'tasks.tab': 'chat', 'jira.source': 'auto', 'tasks.refresh': '30s',
      'tasks.humanChanges': true, 'jira.agentTools': { comment: true, transition: true, worklog: true },
    };
    const page = put(TMP, `${name('tsettings')}.html`, surfaceHtml({
      surface: 'settings', theme, state: { settingsSection: 'integrations' },
      messages: [{ type: 'settings.state', values, overridden: [] }, { type: 'integrations.state', state: data.integrations }],
    }));
    await single(await shot(page, png('tsettings'), 1100, 760), out('integrations', theme));
  });
}

// README picture: sidebar with the task group + chat with the "changes" feed (dark), like the hero
taskJobs.push(async () => {
  const side = taskSidebar('dark', 'groups');
  const panel = { ...WIDE, tab: 'changes', view: 'task', taskView: 'comments', taskSeen: seenOld(), taskSeenKey: data.TASK_KEY };
  const chat = taskChat('dark', panel);
  const page = put(TMP, `${name('tshero')}.html`, splitHtml({ theme: 'dark', w: 1324, h: 760, panes: [{ file: side, w: 300 }, { file: chat, w: 1023 }] }));
  await single(await shot(page, png('tshero'), 1324, 760), join(OUT, 'jira-tasks.png'));
});

// ---- go --------------------------------------------------------------------------------------------------------

try {
  await pool(process.argv[2] === 'tasks' ? taskJobs : [...jobs, ...taskJobs], 4);
  console.log(`done: ${OUT}`);
} finally {
  if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
  else console.log(`tmp kept: ${TMP}`);
}
