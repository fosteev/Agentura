// Fixture data for the README screenshots: one story for every frame, English only.
// Story: project `queue` (electronic queue), task "Fix the board counter blink on reconnect".

export const PROJECT = 'queue';
export const CWD = '/w/queue';
export const PROMPT = 'Fix the board counter blink on reconnect';
export const MODEL = 'claude-sonnet-5-5';

const MIN = 60_000;

const MODELS = [
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true },
  { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportsEffort: true },
  { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
];

export const capabilities = { models: MODELS, commands: [] };

const FILES = {
  counter: `${CWD}/board/src/Counter.tsx`,
  counterTest: `${CWD}/board/src/__tests__/Counter.test.tsx`,
  backoff: `${CWD}/ws-client/src/backoff.ts`,
  reconnect: `${CWD}/ws-client/src/reconnect.ts`,
  readme: `${CWD}/ws-client/README.md`,
  reconnectTest: `${CWD}/ws-client/src/__tests__/reconnect.test.ts`,
};

const patch = (add, del) => [
  { oldStart: 12, oldLines: del + 3, newStart: 12, newLines: add + 3, lines: [
    ' const Counter = () => {',
    ...Array.from({ length: del }, (_, i) => `-  old line ${i}`),
    ...Array.from({ length: add }, (_, i) => `+  new line ${i}`),
    ' };',
  ] },
];

let seq = 0;
const uid = (p) => `${p}_${String(++seq).padStart(4, '0')}`;

/** One tool call: start + result, `at` offsets in ms from `t`. */
function tool(t, name, input, content, extra = {}) {
  const id = uid('toolu');
  const agent = extra.agentId ? { agentId: extra.agentId } : {};
  return [
    { type: 'tool.start', toolUseId: id, name, input, at: t, ...agent },
    { type: 'tool.result', toolUseId: id, isError: !!extra.isError, content, result: extra.result,
      at: t + (extra.ms ?? 400), durationMs: extra.ms ?? 400, ...agent },
  ];
}

const text = (t, s, agentId) => ({ type: 'text.delta', messageId: uid('msg'), text: s, ...(agentId ? { agentId } : {}), at: t });

const usage = (t, input, output, cacheRead, cacheWrite) => ({
  type: 'usage.message', messageId: uid('msg'), model: MODEL, final: true, at: t,
  usage: { input, output, cacheRead, cacheWrite, cacheWrite5m: cacheWrite, cacheWrite1h: 0 },
});

const init = (title) => [
  { type: 'session.init', sessionId: 's1', model: MODEL, cwd: CWD, permissionMode: 'default', tools: [],
    slashCommands: [], skills: [], agents: [], apiKeySource: 'none', engineVersion: '2.1.285', effort: 'high' },
  { type: 'session.title', title },
];

const limitUpdate = () => ({
  type: 'limit.update', source: 'engine', status: 'allowed',
  windows: [
    { kind: 'five-hour', percent: 34, resetsAt: Date.now() + 2 * 3600_000 + 8 * MIN },
    { kind: 'weekly', percent: 52, resetsAt: Date.now() + 3 * 86400_000 },
  ],
});

/** Finished turn: reads, two edits, a new file, a test run, a final answer. */
export function finishedTurn() {
  seq = 0;
  const t0 = Date.now() - 2 * MIN;
  const ev = [...init('Fix board counter blink')];
  ev.push({ type: 'turn.start', prompt: PROMPT, at: t0 });
  ev.push(text(t0 + 2000, 'The counter drops to zero on every reconnect, so the board flashes. Let me see how it reads its state.'));
  ev.push(...tool(t0 + 4000, 'Read', { file_path: FILES.counter }, '1\timport { useSnapshot } from "./snapshot";\n2\t', { ms: 30 }));
  ev.push(...tool(t0 + 6000, 'Grep', { pattern: 'onOpen|reset\\(', path: `${CWD}/ws-client/src` }, 'ws-client/src/reconnect.ts', { ms: 60, result: { numFiles: 3 } }));
  ev.push(...tool(t0 + 8000, 'Read', { file_path: FILES.reconnect }, '1\texport function onOpen() {\n2\t', { ms: 25 }));
  ev.push(text(t0 + 12_000, 'Found it: `onOpen` clears the counter before the first snapshot arrives. I will read from the last snapshot instead and back off between reconnect attempts.'));
  ev.push(...tool(t0 + 15_000, 'Edit', { file_path: FILES.counter, old_string: 'a', new_string: 'b' }, 'The file has been updated.', { ms: 40, result: { structuredPatch: patch(6, 2) } }));
  ev.push(...tool(t0 + 18_000, 'Write', { file_path: FILES.backoff, content: 'x' }, 'File created.', { ms: 35, result: { type: 'create', content: Array.from({ length: 40 }, () => 'x').join('\n') } }));
  ev.push(...tool(t0 + 21_000, 'Edit', { file_path: FILES.reconnect, old_string: 'a', new_string: 'b' }, 'The file has been updated.', { ms: 40, result: { structuredPatch: patch(27, 7) } }));
  ev.push(...tool(t0 + 25_000, 'Bash', { command: 'npm test -- Counter reconnect', description: 'Run the affected tests' }, 'Test Files  2 passed (2)\n     Tests  14 passed (14)', { ms: 6400 }));
  ev.push(usage(t0 + 40_000, 12, 2100, 61_000, 9_800));
  ev.push({ type: 'context.usage', usedTokens: 71_800, maxTokens: 200_000, source: 'usage', percentage: 36 });
  ev.push(text(t0 + 41_000, 'Fixed. The board no longer blinks on reconnect:\n\n- `Counter` now reads the last snapshot, so the number stays put until fresh data arrives\n- `reconnect` retries with exponential backoff (new `backoff.ts`)\n- Both packages pass their tests: 14 passed\n\nThe `.env.local` change in `board` is not mine, I left it alone.'));
  ev.push({
    type: 'turn.result', ok: true, subtype: 'success', interrupted: false, durationMs: 44_000, apiDurationMs: 38_000,
    numTurns: 6, usage: { input: 12, output: 2100, cacheRead: 61_000, cacheWrite: 9_800 }, costUsd: 0.31,
    totalCostUsd: 0.31, model: MODEL, contextWindow: 200_000, stopReason: 'end_turn', permissionDenials: [],
  });
  ev.push(limitUpdate());
  return ev;
}

/** Mid-turn: a background test watcher, three subagents (one done, one running, one failed). */
export function runningTurn() {
  seq = 0;
  const t0 = Date.now() - 75_000;
  const ev = [...init('Fix board counter blink')];
  ev.push({ type: 'turn.start', prompt: PROMPT, at: t0 });
  ev.push(text(t0 + 2000, 'I will split the investigation: one agent finds every reader of the counter, one audits the reconnect callers, one runs the ws-client tests. The test watcher keeps running in the background.'));
  const bg = uid('toolu');
  ev.push({ type: 'tool.start', toolUseId: bg, name: 'Bash', input: { command: 'npm test -- --watch', description: 'Test watcher', run_in_background: true }, at: t0 + 4000 });
  ev.push({ type: 'agent.start', agentId: bg, taskId: 'bg1', description: 'Test watcher', taskType: 'local_bash', background: true, at: t0 + 4000 });
  ev.push({ type: 'tool.result', toolUseId: bg, isError: false, content: 'Command running in background with ID: bg1.', at: t0 + 4300, durationMs: 300 });

  const sub = (name, kind, desc, prompt, bgFlag, at) => {
    const id = uid('toolu');
    ev.push({ type: 'tool.start', toolUseId: id, name: 'Agent', input: { description: desc, subagent_type: kind, prompt, run_in_background: bgFlag }, at });
    ev.push({ type: 'agent.start', agentId: id, taskId: name, description: desc, taskType: 'local_agent', background: bgFlag, subagentType: kind, prompt, at });
    return id;
  };
  const a = sub('a1', 'Explore', 'Find every reader of the counter', 'List every component that reads the queue counter and say where its value comes from.', false, t0 + 6000);
  const b = sub('a2', 'Explore', 'Audit reconnect callers', 'Find every caller of reconnect() in ws-client and board and note what state they reset.', false, t0 + 6500);
  const c = sub('a3', 'general-purpose', 'Run ws-client tests', 'Run the ws-client test suite and report failures with the first stack frame.', false, t0 + 7000);

  ev.push(...tool(t0 + 9000, 'Grep', { pattern: 'useCounter', path: `${CWD}/board/src` }, 'board/src/Counter.tsx\nboard/src/Header.tsx', { agentId: a, ms: 70, result: { numFiles: 2 } }));
  ev.push(...tool(t0 + 14_000, 'Read', { file_path: FILES.counter }, '1\timport { useSnapshot } from "./snapshot";', { agentId: a, ms: 25 }));
  ev.push({ type: 'agent.progress', agentId: a, taskId: 'a1', description: 'Reading Counter.tsx', lastToolName: 'Read', totalTokens: 9_400, toolUses: 2, durationMs: 14_000 });
  ev.push(text(t0 + 24_000, 'Two readers: Counter.tsx and Header.tsx. Both take the value from the live socket and fall back to zero.', a));
  ev.push({ type: 'agent.end', agentId: a, taskId: 'a1', status: 'completed', summary: 'Two readers, both fall back to zero on a closed socket.', totalTokens: 11_200, toolUses: 3, durationMs: 18_000, at: t0 + 24_000 });
  ev.push({ type: 'tool.result', toolUseId: a, isError: false, content: 'Two readers, both fall back to zero on a closed socket.', at: t0 + 24_100 });

  ev.push(...tool(t0 + 11_000, 'Grep', { pattern: 'reconnect\\(', path: CWD }, 'ws-client/src/reconnect.ts\nboard/src/useSocket.ts', { agentId: b, ms: 90, result: { numFiles: 2 } }));
  ev.push(...tool(t0 + 30_000, 'Read', { file_path: `${CWD}/board/src/useSocket.ts` }, '1\texport function useSocket() {', { agentId: b, ms: 25 }));
  ev.push({ type: 'agent.progress', agentId: b, taskId: 'a2', description: 'Reading useSocket.ts', lastToolName: 'Read', totalTokens: 15_300, toolUses: 4, durationMs: 60_000 });

  ev.push(...tool(t0 + 12_000, 'Bash', { command: 'npm test --workspace ws-client' }, 'ECONNREFUSED 127.0.0.1:8080', { agentId: c, ms: 8000, isError: true }));
  ev.push({ type: 'agent.end', agentId: c, taskId: 'a3', status: 'failed', summary: 'ECONNREFUSED 127.0.0.1:8080: tests need the dev server', totalTokens: 6_100, toolUses: 2, durationMs: 22_000, at: t0 + 29_000 });
  ev.push({ type: 'tool.result', toolUseId: c, isError: true, content: 'ECONNREFUSED 127.0.0.1:8080: tests need the dev server', at: t0 + 29_100 });
  ev.push({ type: 'agent.progress', agentId: bg, taskId: 'bg1', description: 'Test watcher', lastToolName: 'Bash', totalTokens: 0, toolUses: 0, durationMs: 70_000 });
  ev.push({ type: 'context.usage', usedTokens: 58_200, maxTokens: 200_000, source: 'usage', percentage: 29 });
  ev.push(limitUpdate());
  return ev;
}

/** Git data: three repositories, the agent touched files in two of them. */
const gf = (path, status, add, del) => ({ path, status, add, del });
const glog = (rows) => rows.map(([hash, subject, unpushed], i) => ({ hash, subject, at: Date.now() - 3600e3 * (i + 1) * 5, unpushed }));

export const gitSnapshot = { state: 'ok', repos: [
  { root: `${CWD}/board`, rel: 'board', name: 'board', branch: 'fix/board-blink', upstream: 'origin/fix/board-blink', ahead: 1, behind: 0, published: true,
    unstaged: [gf('.env.local', 'M', 1, 1)],
    staged: [gf('src/__tests__/Counter.test.tsx', 'A', 31, 0), gf('src/Counter.tsx', 'M', 6, 2)],
    log: glog([['7be04d1', 'Counter reads snapshot', 1], ['19d07fe', 'Ticket list virtualized', 0]]) },
  { root: `${CWD}/ws-client`, rel: 'ws-client', name: 'ws-client', branch: 'fix/reconnect', published: false,
    unstaged: [gf('README.md', 'M', 12, 0), gf('src/__tests__/reconnect.test.ts', 'M', 18, 4)],
    staged: [gf('src/backoff.ts', 'A', 40, 0), gf('src/reconnect.ts', 'M', 27, 7)],
    log: glog([['c81e0b4', 'Reconnect on close code 1006', 0]]) },
  { root: `${CWD}/infra`, rel: 'infra', name: 'infra', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 3, published: true,
    unstaged: [], staged: [], log: [] },
] };

/** Turn for the git frames: the agent edits files in both packages. */
export function gitTurn() {
  seq = 0;
  const t0 = Date.now() - 10 * MIN;
  const ev = [...init('Fix board counter blink'), { type: 'turn.start', prompt: PROMPT, at: t0 }];
  Object.values(FILES).forEach((p, i) => {
    ev.push(...tool(t0 + 3000 + i * 3000, i % 2 ? 'Write' : 'Edit',
      i % 2 ? { file_path: p, content: 'x' } : { file_path: p, old_string: 'a', new_string: 'b' }, 'ok',
      { ms: 30, result: i % 2 ? { type: 'create', content: 'x\ny' } : { structuredPatch: patch(3 + i, 1 + i) } }));
  });
  ev.push(text(t0 + 24_000, 'Done: the counter keeps its last snapshot and the client backs off between reconnects.'));
  ev.push({ type: 'turn.result', ok: true, subtype: 'success', interrupted: false, durationMs: 26_000, apiDurationMs: 20_000,
    numTurns: 5, usage: { input: 10, output: 1500, cacheRead: 40_000, cacheWrite: 6_000 }, costUsd: 0.22, totalCostUsd: 0.22,
    model: MODEL, contextWindow: 200_000, permissionDenials: [] });
  ev.push({ type: 'context.usage', usedTokens: 46_000, maxTokens: 200_000, source: 'usage', percentage: 23 });
  return ev;
}

const ago = (m) => Date.now() - m * MIN;

export const sessions = [
  { id: 's1', title: 'Fix board counter blink', turns: 4, costUsd: 0.31, state: 'live', updatedAt: ago(1), contextTokens: 72_000 },
  { id: 's2', title: 'Kiosk: ticket printer retries', turns: 7, costUsd: 1.84, state: 'idle', updatedAt: ago(14), contextTokens: 131_000 },
  { id: 's3', title: 'Operator desk: keyboard shortcuts', turns: 3, costUsd: 0.42, state: 'idle', updatedAt: ago(95), contextTokens: 48_000 },
  { id: 's4', title: 'Migrate queue events to Postgres', turns: 12, costUsd: 4.7, state: 'idle', updatedAt: ago(5 * 60), contextTokens: 118_000 },
  { id: 's5', title: 'Why does the sound alert skip tickets', turns: 2, costUsd: 0.12, state: 'idle', updatedAt: ago(7 * 60), contextTokens: 22_000 },
  { id: 's6', title: 'Release notes for 2.4', turns: 5, costUsd: 0.66, state: 'idle', updatedAt: ago(26 * 60), contextTokens: 61_000 },
  { id: 's7', title: 'Load test the ticket API', turns: 9, costUsd: 2.35, state: 'limit', updatedAt: ago(28 * 60), contextTokens: 144_000 },
  { id: 's8', title: 'Refactor service-window settings', turns: 6, costUsd: 0.98, state: 'idle', updatedAt: ago(50 * 60), contextTokens: 83_000 },
  { id: 's9', title: 'Fix timezone in the daily report', turns: 3, costUsd: 0.27, state: 'idle', updatedAt: ago(52 * 60), contextTokens: 35_000 },
];

export const account = { email: 'user@example.com', plan: 'Max 5x', login: 'via CLI · ok', engine: 'claude 2.1.285' };

export const limits = () => ({
  windows: [
    { kind: 'five-hour', percent: 34, resetsAt: Date.now() + 2 * 3600_000 + 8 * MIN },
    { kind: 'weekly', percent: 52, resetsAt: Date.now() + 3 * 86400_000 },
    { kind: 'weekly-model', model: 'Opus', percent: 18, resetsAt: Date.now() + 3 * 86400_000 },
  ],
  updatedAt: Date.now(),
});

// ---- Jira task fixture (roadmap 19): chats of one task, its card and change feed --------------------------------

export const TASK_KEY = 'jira:inst:QUE-214';
const taskUrl = (k) => `https://jira.example.com/browse/${k}`;
export const taskMeta = (key, title, status, statusCategory) => ({ key, instanceId: 'inst', title, status, statusCategory, url: taskUrl(key) });

export const taskGroups = [
  { taskKey: TASK_KEY, meta: taskMeta('QUE-214', 'Board counter blinks to zero after a reconnect', 'In Progress', 'indeterminate'), sessionIds: ['s1', 's3'] },
  { taskKey: 'jira:inst:QUE-198', meta: taskMeta('QUE-198', 'Kiosk: ticket printer does not retry on paper-out', 'To Do', 'new'), sessionIds: ['s2'] },
];

/** Sessions of the sidebar with the task marks (`task` is what the "section" layout shows on the row). */
export const taskSessions = sessions.map((s) => {
  const g = taskGroups.find((x) => x.sessionIds.includes(s.id));
  return g ? { ...s, task: { key: g.meta.key, title: g.meta.title, status: g.meta.status, statusCategory: g.meta.statusCategory } } : s;
});

/** The finished turn plus the agent's own comment on the task (shown as a `jira · comment QUE-214` row). */
export function taskTurn() {
  const ev = finishedTurn();
  const at = ev.find((e) => e.type === 'turn.start').at + 38_000;
  const i = ev.findIndex((e) => e.type === 'usage.message');
  ev.splice(i, 0, ...tool(at, 'mcp__agentura_jira__comment', { text: 'Fixed: the counter keeps the last snapshot on reconnect, retries back off exponentially. Tests: 14 passed.' },
    'Comment added to QUE-214 (id 10234).\nevent: comment:10234', { ms: 700 }));
  return ev;
}

const HOUR = 3_600_000;
export function taskCard() {
  const now = Date.now();
  return {
    key: 'QUE-214', instanceId: 'inst', instanceName: 'Jira DC', title: 'Board counter blinks to zero after a reconnect',
    type: 'Bug', status: 'In Progress', statusCategory: 'indeterminate', assignee: 'You', priority: 'High', url: taskUrl('QUE-214'),
    updatedAt: now - 3 * MIN,
    description: 'After the socket reconnects the queue board shows 0 for a second or two and then the real number. Looks like the counter is reset in onOpen before the first snapshot arrives.\nSeen on the lobby board, 2.4.1.',
    attachments: [
      { id: 'a1', filename: 'board-blink.mp4', size: 2_400_000, mimeType: 'video/mp4', url: 'https://x/a1' },
      { id: 'a2', filename: 'console.log', size: 38_000, mimeType: 'text/plain', url: 'https://x/a2' },
    ],
    comments: [
      { id: 'c1', author: 'Maria K.', mine: false, at: now - 5 * HOUR, text: 'Reproduced on the lobby board, it happens on every Wi-Fi drop.' },
      { id: 'c2', author: 'You', mine: true, at: now - 4 * MIN, text: 'Fixed: the counter keeps the last snapshot on reconnect, retries back off exponentially. Tests: 14 passed.' },
    ],
  };
}

export function taskEvents() {
  const now = Date.now();
  return [
    { id: 'comment:10236', kind: 'comment', at: now - 2 * MIN, author: 'Oleg P.', mine: false, fromThisChat: false, duringTurn: true, commentId: '10236',
      text: 'Please also check the second board in the hall, it blinks the same way.' },
    { id: 'comment:10234', kind: 'comment', at: now - 4 * MIN, author: 'You', mine: true, fromThisChat: true, duringTurn: true, commentId: '10234',
      text: 'Fixed: the counter keeps the last snapshot on reconnect, retries back off exponentially. Tests: 14 passed.' },
    { id: 'hist:1:0', kind: 'status', at: now - 40 * MIN, author: 'You', mine: true, fromThisChat: false, duringTurn: false, field: 'status', from: 'To Do', to: 'In Progress',
      text: 'status: To Do → In Progress' },
  ];
}

export const taskState = () => ({ type: 'task.state', taskKey: TASK_KEY, card: taskCard(), events: taskEvents(), fetchedAt: Date.now() - 20_000, source: 'own' });
export const taskChatRows = () => ({
  type: 'task.chats', taskKey: TASK_KEY,
  chats: [
    { id: 's1', title: 'Fix board counter blink', updatedAt: ago(1), state: 'live', current: true },
    { id: 's3', title: 'Hall board: same blink', provider: 'codex', updatedAt: ago(95), state: 'idle', current: false },
  ],
});
export const tabChats = () => ({
  type: 'tab.chats', taskKey: TASK_KEY,
  chats: [
    { id: 't1', title: 'Fix board counter blink', provider: 'claude', status: 'working', active: true },
    { id: 't2', title: 'Hall board: same blink', provider: 'codex', status: 'idle', active: false },
    { id: 't3', title: '', provider: 'claude', status: 'idle', active: false },
  ],
  persist: { taskKey: TASK_KEY, chats: [{ provider: 'claude', id: 's1' }, { provider: 'codex', id: 's3' }], active: 's1' },
});
export const integrations = { jiraffe: { state: 'ready', version: '0.8.0', instances: [{ id: 'inst', name: 'Jira DC', baseUrl: 'https://jira.example.com', kind: 'dc' }] },
  own: [{ id: 'cloud', name: 'Team Cloud', baseUrl: 'https://example.atlassian.net', kind: 'cloud' }], active: 'jiraffe', writes: true };
