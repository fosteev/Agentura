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
function chatMessages(events, { feedStyle = 'journal', agentsView = 'list', gitLayout = 'stack', extra = [] } = {}) {
  return [
    { type: 'chat.info', project: data.PROJECT, cwd: data.CWD, allowBypass: false, feedStyle, agentsView, gitLayout },
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
    'feed.style': 'journal', 'agents.view': 'list', 'git.layout': 'stack', 'feed.fontSize': 13, 'ui.fontSize': 13,
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

// ---- go --------------------------------------------------------------------------------------------------------

try {
  await pool(jobs, 4);
  console.log(`done: ${OUT}`);
} finally {
  if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
  else console.log(`tmp kept: ${TMP}`);
}
