// Shared pieces: VS Code theme variables, webview html shells, headless Chrome, Python montage.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const furl = (p) => pathToFileURL(p).href;

// VS Code Dark Modern / Light Modern values (the variables the webview CSS reads).
export const THEMES = {
  dark: { bg: '#1f1f1f', side: '#181818', fg: '#cccccc', desc: '#9d9d9d', dis: '#6f6f6f', border: '#2b2b2b', inp: '#313131', inpb: '#3c3c3c', widget: '#202020', hover: '#2a2d2e', code: '#2b2b2b',
    focus: '#0078d4', link: '#4daafc', btn: '#0078d4', btnfg: '#ffffff', btn2: '#313131', btn2fg: '#cccccc', sel: '#264f78', badge: '#616161', badgefg: '#f8f8f8', green: '#89d185', yellow: '#cca700', orange: '#d18616', red: '#f14c4c', blue: '#3794ff', purple: '#b180d7', add: '#81b88b', del_: '#c74e39', hoverbg: '#202020', hoverb: '#454545', shadow: '#0000005c' },
  light: { bg: '#ffffff', side: '#f8f8f8', fg: '#3b3b3b', desc: '#717171', dis: '#61616199', border: '#e5e5e5', inp: '#ffffff', inpb: '#cecece', widget: '#f8f8f8', hover: '#f2f2f2', code: '#f2f2f2',
    focus: '#005fb8', link: '#005fb8', btn: '#005fb8', btnfg: '#ffffff', btn2: '#e5e5e5', btn2fg: '#3b3b3b', sel: '#add6ff', badge: '#cccccc', badgefg: '#3b3b3b', green: '#388a34', yellow: '#bf8803', orange: '#d18616', red: '#e51400', blue: '#1a85ff', purple: '#652d90', add: '#587c0c', del_: '#ad0707', hoverbg: '#f8f8f8', hoverb: '#c8c8c8', shadow: '#00000029' },
};

// Single quotes only: double quotes inside the style attribute would cut the --vscode-* list short.
function themeVars(t) {
  return `--vscode-font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,'SF Mono',monospace;
--vscode-editor-background:${t.bg};--vscode-sideBar-background:${t.side};--vscode-foreground:${t.fg};--vscode-descriptionForeground:${t.desc};--vscode-disabledForeground:${t.dis};
--vscode-panel-border:${t.border};--vscode-input-background:${t.inp};--vscode-input-border:${t.inpb};--vscode-editorWidget-background:${t.widget};--vscode-list-hoverBackground:${t.hover};
--vscode-textCodeBlock-background:${t.code};--vscode-focusBorder:${t.focus};--vscode-textLink-foreground:${t.link};--vscode-button-background:${t.btn};--vscode-button-foreground:${t.btnfg};
--vscode-button-secondaryBackground:${t.btn2};--vscode-button-secondaryForeground:${t.btn2fg};--vscode-editor-selectionBackground:${t.sel};--vscode-badge-background:${t.badge};--vscode-badge-foreground:${t.badgefg};
--vscode-charts-green:${t.green};--vscode-charts-yellow:${t.yellow};--vscode-charts-orange:${t.orange};--vscode-charts-red:${t.red};--vscode-charts-blue:${t.blue};--vscode-charts-purple:${t.purple};
--vscode-gitDecoration-addedResourceForeground:${t.add};--vscode-gitDecoration-deletedResourceForeground:${t.del_};--vscode-editorHoverWidget-background:${t.hoverbg};--vscode-editorHoverWidget-border:${t.hoverb};--vscode-editorHoverWidget-foreground:${t.fg};--vscode-widget-shadow:${t.shadow};`.replace(/\n/g, '');
}

const CSS = ['fonts/fonts.css', 'tokens.css', 'hud.css', 'tasks.css', 'agents.css', 'agents-map.css', 'changes.css', 'git.css', 'feed.css', 'composer.css', 'attach.css', 'webview.css', 'tooltip.css'];
const cssFor = (surface) => [
  ...CSS,
  ...(surface === 'settings' ? ['settings.css'] : []),
  ...(surface === 'agents' || surface === 'settings' ? ['agents-graph.css'] : []),
];

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const APPEARANCE = { type: 'appearance', fontInterface: '', fontPanels: '', fontCode: '', feedFontSize: 13, uiFontSize: 13, userFonts: { ui: [], code: [] } };

/**
 * html of one webview surface. `messages` are posted to the page after its `ready`, one by one (50 ms apart);
 * `state` is what `getState()` returns; `relay` forwards `agents.snapshot` to the parent page.
 */
export function surfaceHtml({ surface, theme, messages = [], state, relay = false, bg }) {
  const t = THEMES[theme];
  const seq = [{ type: 'init', surface, version: '0.3.0' }, APPEARANCE, ...messages];
  const links = cssFor(surface).map((c) => `<link rel="stylesheet" href="${furl(join(ROOT, 'media', c))}">`).join('');
  return `<!doctype html><html lang="en" style="${themeVars(t)}"><head><meta charset="utf-8">${links}
<script>
var __state=${json(state ?? {})};
var __seq=${json(seq)};
window.acquireVsCodeApi=function(){return{
 postMessage:function(m){
  if(m&&m.type==='ready'){__seq.forEach(function(x,i){setTimeout(function(){window.postMessage(x,'*')},50*(i+1))})}
  else if(${relay}&&m&&m.type==='agents.snapshot'){parent.postMessage({relay:m},'*')}
 },
 getState:function(){return __state},setState:function(s){__state=s}}};
</script></head>
<body class="vscode-${theme}" data-vscode-theme-kind="vscode-${theme}" style="margin:0;background:${bg ?? t.bg};color:${t.fg};font-family:var(--vscode-font-family);font-size:13px">
<div id="root"></div><script type="module" src="${furl(join(ROOT, 'dist', 'webview', `${surface}.js`))}"></script></body></html>`;
}

/** Wrapper page: iframes side by side, plain `rows` of [file, width] with 1 px dividers. */
export function splitHtml({ theme, w, h, panes }) {
  const t = THEMES[theme];
  const cells = panes.map((p, i) =>
    `${i ? `<div style="width:1px;background:${t.border}"></div>` : ''}<iframe src="${furl(p.file)}" style="width:${p.w}px;height:${h}px;border:0;display:block"></iframe>`).join('');
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${t.bg};display:flex">${cells}</body></html>`;
}

/**
 * Chat + graph: the chat runs in a hidden iframe, its `agents.snapshot` goes to the graph iframe (what the host
 * does between the two tabs); the agent is picked after the snapshot has landed.
 */
export function graphHtml({ theme, w, h, chatFile, graphFile, focusId }) {
  const t = THEMES[theme];
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${t.bg}">
<iframe id="chat" src="${furl(chatFile)}" style="position:absolute;left:0;top:0;width:900px;height:${h}px;border:0;visibility:hidden"></iframe>
<iframe id="graph" src="${furl(graphFile)}" style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;border:0"></iframe>
<script>
var g=document.getElementById('graph'),focused=false;
window.addEventListener('message',function(e){var r=e.data&&e.data.relay;if(!r)return;
 g.contentWindow.postMessage(r,'*');
 if(!focused&&r.graph&&r.graph.agents&&r.graph.agents.length){focused=true;setTimeout(function(){g.contentWindow.postMessage({type:'agents.focus',agentId:${json(focusId)}},'*')},150)}});
</script></body></html>`;
}

/** Writes `html` into `dir` and returns its path. */
export function put(dir, name, html) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, html);
  return p;
}

let queue = Promise.resolve();
/**
 * Screenshot of `file` at 2x with a virtual-time budget (so timers in the page run to completion).
 * Chrome runs one at a time: parallel instances share the default profile and an explicit
 * --user-data-dir makes headless Chrome linger after the screenshot.
 */
export function shot(file, out, w, h, budget = 4000) {
  const run = () => new Promise((resolve, reject) => {
    const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files', '--hide-scrollbars',
      '--force-device-scale-factor=2', `--window-size=${w},${h}`,
      `--virtual-time-budget=${budget}`, `--screenshot=${out}`, furl(file)];
    const p = spawn(CHROME, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`chrome exited ${code} for ${file}`))));
  });
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

/** Runs async `tasks` (functions) at most `n` at a time. */
export async function pool(tasks, n = 4) {
  const it = tasks[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => {
    for (let r = it.next(); !r.done; r = it.next()) await r.value();
  }));
}

/** PIL: crop/montage/optimize. `spec` goes to montage.py as json. */
export function montage(spec, tmp) {
  const p = put(tmp, `montage-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(spec));
  return new Promise((resolve, reject) => {
    const c = spawn('python3', [join(HERE, 'montage.py'), p], { stdio: 'inherit' });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`montage.py exited ${code}`))));
  });
}
