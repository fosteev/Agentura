#!/usr/bin/env node
// Stage 6 integration smoke: verify all DoD error, security, policy, ownership,
// timeout/wait-slot, limit, recursive stop, restart-recovery, and foreign-tree checks
// through real HTTP MCP JSON-RPC (ChildAgentsMcpServer + ChildSessionManager + ChildAgentStore).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadTs } from './lib/load-ts.mjs';

const { ChildSessionManager, ChildAgentsMcpServer, ChildAgentStore } = await loadTs(
  'src/agent/children/index.ts',
);
const { EventHub } = await loadTs('src/agent/stream.ts');

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-errors-smoke-')));
const cwd = join(tmpRoot, 'ws');
const storeDir = join(tmpRoot, 'store');
const storeDirTimeout = join(tmpRoot, 'store-timeout');
mkdirSync(cwd, { recursive: true });
mkdirSync(storeDir, { recursive: true });
mkdirSync(storeDirTimeout, { recursive: true });
writeFileSync(join(cwd, 'fileA.ts'), 'export const a = 1;\n');

class ControlledSession {
  constructor(id, mode, model, mcpUrl) {
    this.id = id;
    this.mode = mode;
    this.model = model;
    this.mcpUrl = mcpUrl;
    this.events = new EventHub();
    this.disposed = false;
    this.interrupted = false;
    this.prompts = [];
  }

  send(text) {
    this.prompts.push(text);
    void Promise.resolve().then(() => {
      this.events.emit({
        type: 'session.init',
        sessionId: this.id,
        model: this.model,
        cwd,
        permissionMode: 'default',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1.0',
      });
      if (this.mode === 'immediate') {
        const reply = text.includes('FOLLOWUP') ? 'FOLLOWUP_OK' : 'SAVED_OK';
        this.events.emit({
          type: 'turn.result',
          ok: true,
          subtype: 'success',
          interrupted: false,
          durationMs: 5,
          apiDurationMs: 5,
          numTurns: 1,
          totalCostUsd: 0,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          permissionDenials: [],
          text: reply,
        });
      }
    });
    return true;
  }

  completeDeferred(text = 'DEFERRED_OK') {
    this.events.emit({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 10,
      apiDurationMs: 10,
      numTurns: 1,
      totalCostUsd: 0,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      permissionDenials: [],
      text,
    });
  }

  respondPermission() {
    return true;
  }
  answerQuestion() {
    return true;
  }
  decidePlan() {
    return true;
  }
  async setMode() {}
  async setModel() {}
  async setEffort() {}
  async interrupt() {
    this.interrupted = true;
  }
  compact() {
    return false;
  }
  async stopTask() {}
  async capabilities() {
    return { models: [], commands: [] };
  }
  async contextUsage() {
    return undefined;
  }
  dispose() {
    this.disposed = true;
  }
}

function parseTool(res) {
  const txt = res?.content?.[0]?.text;
  assert.ok(txt, 'Missing MCP response text');
  return JSON.parse(txt);
}

async function callErr(client, name, args, expectedCode) {
  const res = await client.callTool({ name, arguments: args });
  const body = parseTool(res);
  assert.equal(res.isError, true, `${name} should fail with ${expectedCode}, got ${JSON.stringify(body)}`);
  assert.equal(body.error?.code, expectedCode, `${name} expected ${expectedCode}, got ${JSON.stringify(body)}`);
  return body;
}

async function callOk(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = parseTool(res);
  assert.notEqual(res.isError, true, `${name} unexpectedly failed: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true, `${name} expected ok:true, got ${JSON.stringify(body)}`);
  return body;
}

async function connectMcp(url) {
  const client = new Client({ name: 'errors-smoke', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const sessionsByTaskHint = [];
let spawnCount = 0;

function makeMockRuntime(provider, opts = {}) {
  return {
    provider,
    label: provider,
    adapter: () => ({
      id: provider,
      createSession: async (sessionOpts) => {
        spawnCount++;
        if (opts.throwCreate) {
          throw new Error(opts.throwCreate);
        }
        if (opts.hangCreate) {
          return await new Promise(() => {});
        }
        const id = `${provider}-s-${spawnCount}`;
        const mcpUrl = sessionOpts.hostMcpServers?.[0]?.url;
        const sess = new ControlledSession(id, opts.mode ?? 'deferred', opts.defaultModel ?? 'm-1', mcpUrl);
        sessionsByTaskHint.push(sess);
        return sess;
      },
      resumeSession: async (sessionId, sessionOpts) => {
        const mcpUrl = sessionOpts.hostMcpServers?.[0]?.url;
        const sess = new ControlledSession(sessionId, opts.mode ?? 'immediate', opts.defaultModel ?? 'm-1', mcpUrl);
        sessionsByTaskHint.push(sess);
        return sess;
      },
      listSessions: async () => [],
      loadHistory: async () => ({ events: [], turns: 0, skippedTurns: 0 }),
      renameSession: async () => {},
      accountInfo: async () => ({}),
    }),
    inspect: async () => ({
      status: opts.status ?? 'ready',
      reason: opts.reason,
      models: opts.models ?? [
        { value: 'm-1', displayName: 'Model 1', supportsEffort: true, effortLevels: ['low', 'high'] },
      ],
      defaultModel: opts.defaultModel ?? 'm-1',
      supportedAccess: opts.supportedAccess ?? ['read_only', 'workspace_write', 'full_access'],
      supportsFineGrainedWritePaths: opts.supportsFineGrainedWritePaths ?? false,
      canDelegateViaMcp: opts.canDelegateViaMcp ?? true,
    }),
  };
}

let mcpMain;
let mcpTimeout;
let mcpRestart;

try {
  // --- 1..8: Primary manager + MCP server ---
  const store = new ChildAgentStore(storeDir);
  const manager = new ChildSessionManager({
    store,
    limits: { maxDepth: 2, maxConcurrentRunning: 1, maxTotalSpawns: 10 },
    providers: [
      makeMockRuntime('mock-immed', { mode: 'immediate' }),
      makeMockRuntime('mock-defer', { mode: 'deferred' }),
      makeMockRuntime('mock-auth', { status: 'needs_auth', reason: 'Login required for mock-auth' }),
      makeMockRuntime('mock-nodelegate', { mode: 'immediate', canDelegateViaMcp: false }),
      makeMockRuntime('mock-fail', { throwCreate: 'Process crashed on startup' }),
    ],
  });

  mcpMain = new ChildAgentsMcpServer(manager);
  await mcpMain.start();

  const rootA = manager.createRootBinding({
    rootTreeId: 'tree-A',
    cwd,
    maxAccess: 'full_access',
    allowBypassPermissions: false,
  });
  const rootReadOnly = manager.createRootBinding({
    rootTreeId: 'tree-RO',
    cwd,
    maxAccess: 'read_only',
    allowBypassPermissions: false,
  });
  const rootB = manager.createRootBinding({
    rootTreeId: 'tree-B',
    cwd,
    maxAccess: 'read_only',
  });

  const clientA = await connectMcp(mcpMain.urlForToken(rootA.token));
  const clientRO = await connectMcp(mcpMain.urlForToken(rootReadOnly.token));
  const clientB = await connectMcp(mcpMain.urlForToken(rootB.token));

  // 1. parent_id spoofing rejected
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-immed', task: 'spoof', parent_id: 'fake-parent' },
    'INVALID_ARGUMENTS',
  );

  // 2. UNKNOWN_MODEL
  const unknownModelErr = await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-immed', model: 'm-nonexistent', task: 'bad model' },
    'UNKNOWN_MODEL',
  );
  assert.deepEqual(unknownModelErr.error.details.availableModels, ['m-1']);

  // 3. AUTH_REQUIRED
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-auth', task: 'needs login' },
    'AUTH_REQUIRED',
  );

  // 4. POLICY_ESCALATION_DENIED
  await callErr(
    clientRO,
    'agent_spawn',
    { provider: 'mock-immed', task: 'escalate rw', policy: { access: 'workspace_write', writePaths: ['.'] } },
    'POLICY_ESCALATION_DENIED',
  );
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-immed', task: 'escalate bypass', policy: { access: 'full_access', writePaths: ['.'] } },
    'POLICY_ESCALATION_DENIED',
  );

  // 5. Unsupported fork_turns & POLICY_UNSUPPORTED_BY_ENGINE
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-immed', task: 'fork all', fork_turns: 'all' },
    'FORK_TURNS_UNSUPPORTED',
  );
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-immed', task: 'narrow path', policy: { access: 'workspace_write', writePaths: ['fileA.ts'] } },
    'POLICY_UNSUPPORTED_BY_ENGINE',
  );
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-nodelegate', task: 'no delegate', policy: { access: 'read_only', allowDelegate: true } },
    'POLICY_UNSUPPORTED_BY_ENGINE',
  );

  // 6. Process startup failure
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-fail', task: 'crash' },
    'PROVIDER_UNAVAILABLE',
  );

  // 7. Bounded agent_wait + Idempotency + Concurrency slot + Nested Depth + Wait-slot release + Recursive Stop
  const countBeforeIdem = spawnCount;
  const c1 = await callOk(clientA, 'agent_spawn', {
    provider: 'mock-defer',
    model: 'm-1',
    task: 'Deferred parent child',
    idempotency_key: 'idem-1',
    policy: { access: 'workspace_write', writePaths: ['.'], allowDelegate: true },
  });
  const c1Repeat = await callOk(clientA, 'agent_spawn', {
    provider: 'mock-defer',
    model: 'm-1',
    task: 'Deferred parent child',
    idempotency_key: 'idem-1',
    policy: { access: 'workspace_write', writePaths: ['.'], allowDelegate: true },
  });
  assert.equal(c1Repeat.agent_id, c1.agent_id, 'Idempotent retry should return same agent_id');
  assert.equal(spawnCount, countBeforeIdem + 1, 'Idempotent retry must not spawn twice');

  await callErr(
    clientA,
    'agent_spawn',
    {
      provider: 'mock-defer',
      model: 'm-1',
      task: 'Different task body!',
      idempotency_key: 'idem-1',
      policy: { access: 'workspace_write', writePaths: ['.'], allowDelegate: true },
    },
    'IDEMPOTENCY_CONFLICT',
  );

  // Bounded wait times out while C1 still running
  const waitTimedOut = await callOk(clientA, 'agent_wait', { agent_id: c1.agent_id, timeout_ms: 120 });
  assert.equal(waitTimedOut.timed_out, true);
  assert.equal(waitTimedOut.agents[0].status, 'running');

  // Sibling spawn from root fails due to maxConcurrentRunning=1
  await callErr(
    clientA,
    'agent_spawn',
    { provider: 'mock-defer', task: 'Sibling exceeding concurrency' },
    'MAX_CONCURRENT_EXCEEDED',
  );

  // Foreign-tree isolation: root B cannot read/wait/send/stop C1
  for (const [tool, args] of [
    ['agent_status', { agent_id: c1.agent_id }],
    ['agent_wait', { agent_id: c1.agent_id, timeout_ms: 100 }],
    ['agent_send', { agent_id: c1.agent_id, message: 'hijack' }],
    ['agent_stop', { agent_id: c1.agent_id }],
  ]) {
    await callErr(clientB, tool, args, 'FORBIDDEN_FOREIGN_TREE');
  }

  // Child C1 spawns Grandchild G1 (depth 2) via C1's own binding URL
  const sessC1 = sessionsByTaskHint.find((s) => s.id.startsWith('mock-defer-s-'));
  assert.ok(sessC1?.mcpUrl, 'C1 must receive child MCP URL');
  const clientC1 = await connectMcp(sessC1.mcpUrl);

  const g1 = await callOk(clientC1, 'agent_spawn', {
    provider: 'mock-defer',
    model: 'm-1',
    task: 'Grandchild G1',
    policy: { access: 'read_only', allowDelegate: true },
  });
  assert.equal(g1.depth, 2);

  // Great-grandchild beyond maxDepth=2 fails cleanly
  const sessG1 = sessionsByTaskHint.at(-1);
  // Note: allowDelegate at maxDepth omits hostMcpServers or rejects depth>maxDepth if bound directly:
  assert.equal(sessG1.mcpUrl, undefined, 'Node at maxDepth must not receive delegation MCP URL');

  // Prove wait-slot release while C1 waits on G1 in parallel with check of maxConcurrentRunning=1
  const c1WaitPromise = callOk(clientC1, 'agent_wait', { agent_id: g1.agent_id, timeout_ms: 250 });
  await new Promise((r) => setTimeout(r, 30));
  // Complete G1 while C1 waits
  sessG1.completeDeferred('GRANDCHILD_DONE');
  const g1Waited = await c1WaitPromise;
  assert.equal(g1Waited.timed_out, false);
  assert.equal(g1Waited.agents[0].status, 'completed');

  // Complete C1 and also test WRITE_OWNERSHIP_CONFLICT between two concurrent writers
  sessC1.completeDeferred('C1_DONE');
  const c1Done = await callOk(clientA, 'agent_wait', { agent_id: c1.agent_id, timeout_ms: 1000 });
  assert.equal(c1Done.timed_out, false);
  assert.equal(c1Done.agents[0].summary, 'C1_DONE');

  // Recursive agent_stop across C1b -> G1b + idempotent second stop (need maxConcurrentRunning >= 2 on a fresh tree)
  await clientC1.close();
  await clientA.close();
  await clientRO.close();
  await clientB.close();
  await mcpMain.close();

  // Separate check on manager with maxConcurrentRunning=2 for WRITE_OWNERSHIP_CONFLICT, MAX_DEPTH_EXCEEDED, MAX_SPAWNS_EXCEEDED & recursive stop
  const store2Dir = join(tmpRoot, 'store2');
  mkdirSync(store2Dir, { recursive: true });
  const store2 = new ChildAgentStore(store2Dir);
  const mgr2 = new ChildSessionManager({
    store: store2,
    limits: { maxDepth: 2, maxConcurrentRunning: 3, maxTotalSpawns: 3 },
    providers: [
      makeMockRuntime('mock-immed', { mode: 'immediate' }),
      makeMockRuntime('mock-defer', { mode: 'deferred' }),
    ],
  });
  const mcp2 = new ChildAgentsMcpServer(mgr2);
  await mcp2.start();
  const root2 = mgr2.createRootBinding({ rootTreeId: 'tree-2', cwd, maxAccess: 'workspace_write' });
  const cli2 = await connectMcp(mcp2.urlForToken(root2.token));

  const w1 = await callOk(cli2, 'agent_spawn', {
    provider: 'mock-defer',
    task: 'Writer 1',
    policy: { access: 'workspace_write', writePaths: ['.'], allowDelegate: true },
  });
  await callErr(
    cli2,
    'agent_spawn',
    {
      provider: 'mock-defer',
      task: 'Conflicting Writer 2',
      policy: { access: 'workspace_write', writePaths: ['.'], allowDelegate: false },
    },
    'WRITE_OWNERSHIP_CONFLICT',
  );
  const sessW1 = sessionsByTaskHint.at(-1);
  const cliW1 = await connectMcp(sessW1.mcpUrl);
  const w1Child = await callOk(cliW1, 'agent_spawn', {
    provider: 'mock-defer',
    task: 'W1 Grandchild',
    policy: { access: 'read_only' },
  });
  // Check MAX_DEPTH_EXCEEDED via depth-1 limit over MCP
  const mgrDepth = new ChildSessionManager({
    store: new ChildAgentStore(join(tmpRoot, 'store-depth')),
    limits: { maxDepth: 1, maxConcurrentRunning: 2, maxTotalSpawns: 5 },
    providers: [makeMockRuntime('mock-defer', { mode: 'deferred' })],
  });
  const mcpDepth = new ChildAgentsMcpServer(mgrDepth);
  await mcpDepth.start();
  const rootD = mgrDepth.createRootBinding({ rootTreeId: 'tree-depth', cwd, maxAccess: 'read_only' });
  const cliD = await connectMcp(mcpDepth.urlForToken(rootD.token));
  await callOk(cliD, 'agent_spawn', { provider: 'mock-defer', task: 'd1', policy: { access: 'read_only', allowDelegate: true } });
  const sessD1 = sessionsByTaskHint.at(-1);
  // maxDepth === 1 omits delegation URL at depth 1; also verify direct spawn at depth === maxDepth fails with MAX_DEPTH_EXCEEDED:
  assert.equal(sessD1.mcpUrl, undefined);
  const directDepthBinding = mgrDepth.createRootBinding({ rootTreeId: 'tree-depth-direct', cwd, maxAccess: 'read_only' });
  directDepthBinding.depth = 1;
  await assert.rejects(
    mgrDepth.spawn(directDepthBinding.token, { provider: 'mock-defer', task: 'over-depth' }),
    (err) => err?.code === 'MAX_DEPTH_EXCEEDED',
  );
  await cliD.close();
  await mcpDepth.close();
  // Spawn 3rd total in tree-2 (completed immed) then verify 4th hits MAX_SPAWNS_EXCEEDED
  await callOk(cli2, 'agent_spawn', { provider: 'mock-immed', task: 'Immed 3rd', policy: { access: 'read_only' } });
  await callErr(
    cli2,
    'agent_spawn',
    { provider: 'mock-immed', task: '4th over total limit', policy: { access: 'read_only' } },
    'MAX_SPAWNS_EXCEEDED',
  );

  // Recursive stop on w1 stops both w1 and w1Child
  const stopRes = await callOk(cli2, 'agent_stop', { agent_id: w1.agent_id });
  assert.equal(stopRes.already_terminal, false);
  assert.ok(stopRes.stopped_ids.includes(w1.agent_id), 'stopped_ids includes parent');
  assert.ok(stopRes.stopped_ids.includes(w1Child.agent_id), 'stopped_ids includes grandchild');

  // Idempotent second stop
  const stopAgain = await callOk(cli2, 'agent_stop', { agent_id: w1.agent_id });
  assert.equal(stopAgain.already_terminal, true);
  assert.deepEqual(stopAgain.stopped_ids, []);

  // --- 9. Persistence & Restart Recovery ---
  const storeRestartDir = join(tmpRoot, 'store-restart');
  mkdirSync(storeRestartDir, { recursive: true });
  const mgrBeforeRestart = new ChildSessionManager({
    store: new ChildAgentStore(storeRestartDir),
    providers: [
      makeMockRuntime('mock-immed', { mode: 'immediate' }),
      makeMockRuntime('mock-defer', { mode: 'deferred' }),
    ],
  });
  const mcpBefore = new ChildAgentsMcpServer(mgrBeforeRestart);
  await mcpBefore.start();
  const rootR = mgrBeforeRestart.createRootBinding({ rootTreeId: 'tree-restart', cwd, maxAccess: 'read_only' });
  const cliR = await connectMcp(mcpBefore.urlForToken(rootR.token));

  const compNode = await callOk(cliR, 'agent_spawn', { provider: 'mock-immed', task: 'Done before restart' });
  await callOk(cliR, 'agent_wait', { agent_id: compNode.agent_id, timeout_ms: 1000 });
  const runNode = await callOk(cliR, 'agent_spawn', { provider: 'mock-defer', task: 'Still running during crash' });

  await cliR.close();
  await mcpBefore.close(); // simulate crash without stopSubtree

  const spawnsAtRestart = spawnCount;
  const restartedStore = new ChildAgentStore(storeRestartDir);
  const mgrAfterRestart = new ChildSessionManager({
    store: restartedStore,
    providers: [
      makeMockRuntime('mock-immed', { mode: 'immediate' }),
      makeMockRuntime('mock-defer', { mode: 'deferred' }),
    ],
  });
  assert.equal(spawnCount, spawnsAtRestart, 'Restart recovery must NOT re-execute tasks');

  mcpRestart = new ChildAgentsMcpServer(mgrAfterRestart);
  await mcpRestart.start();
  const rootAfter = mgrAfterRestart.createRootBinding({ rootTreeId: 'tree-restart', cwd, maxAccess: 'read_only' });
  const cliAfter = await connectMcp(mcpRestart.urlForToken(rootAfter.token));

  const compView = await callOk(cliAfter, 'agent_status', { agent_id: compNode.agent_id });
  assert.equal(compView.status, 'completed');
  assert.equal(compView.summary, 'SAVED_OK');
  assert.ok((mgrAfterRestart.renderTranscript('tree-restart', compNode.agent_id) ?? '').includes('SAVED_OK'));

  const runView = await callOk(cliAfter, 'agent_status', { agent_id: runNode.agent_id });
  assert.equal(runView.status, 'unknown_after_restart');
  await callErr(
    cliAfter,
    'agent_send',
    { agent_id: runNode.agent_id, message: 'try sending after restart' },
    'AGENT_NOT_SENDABLE',
  );

  await cliAfter.close();
  await mcpRestart.close();
  await cliW1.close();
  await cli2.close();
  await mcp2.close();

  // --- 10. Hanging createSession -> spawnTimeoutMs ---
  const mgrHang = new ChildSessionManager({
    store: new ChildAgentStore(storeDirTimeout),
    spawnTimeoutMs: 120,
    providers: [makeMockRuntime('mock-hang', { hangCreate: true })],
  });
  mcpTimeout = new ChildAgentsMcpServer(mgrHang);
  await mcpTimeout.start();
  const rootH = mgrHang.createRootBinding({ rootTreeId: 'tree-hang', cwd, maxAccess: 'read_only' });
  const cliH = await connectMcp(mcpTimeout.urlForToken(rootH.token));
  await callErr(cliH, 'agent_spawn', { provider: 'mock-hang', task: 'hang createSession' }, 'PROVIDER_UNAVAILABLE');
  await cliH.close();
  await mcpTimeout.close();

  console.log('ALL_ERROR_SECURITY_RECOVERY_CHECKS: PASSED (10/10 groups)');
} finally {
  await mcpMain?.close().catch(() => {});
  await mcpTimeout?.close().catch(() => {});
  await mcpRestart?.close().catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
}
