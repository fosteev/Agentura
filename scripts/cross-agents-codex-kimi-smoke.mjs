#!/usr/bin/env node
// Opt-in live smoke: bilateral Codex <-> Kimi and nested Codex -> Kimi -> Codex via agentura_agents MCP.
//   node scripts/cross-agents-codex-kimi-smoke.mjs
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const {
  ChildSessionManager,
  ChildAgentsMcpServer,
  ChildAgentStore,
  createProviderRuntimes,
  CHILD_MCP_SERVER,
} = await loadTs('src/agent/children/index.ts');

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-ck-smoke-')));
const cwd = join(tmpRoot, 'ws');
const storeDir = join(tmpRoot, 'store');
mkdirSync(cwd, { recursive: true });
mkdirSync(storeDir, { recursive: true });

const treeEvents = [];
const store = new ChildAgentStore(storeDir);
const runtimes = createProviderRuntimes({
  log: (level, msg) => level !== 'debug' && console.error(`  [${level}] ${msg}`),
});
const manager = new ChildSessionManager({
  store,
  providers: runtimes,
  limits: { maxDepth: 2, maxConcurrentRunning: 3, maxTotalSpawns: 16 },
  onTreeEvent: (rootTreeId, event) => {
    treeEvents.push({ rootTreeId, event });
  },
});

const mcpServer = new ChildAgentsMcpServer(manager);
await mcpServer.start();
console.log(`MCP server listening at 127.0.0.1:${mcpServer.port}`);

const codexRuntime = runtimes.find((r) => r.provider === 'codex');
const kimiRuntime = runtimes.find((r) => r.provider === 'kimi');

async function runRootTurn(adapter, sessionOptions, prompt, label, timeoutMs = 120_000) {
  const session = await adapter.createSession(sessionOptions);
  let text = '';
  const errors = [];
  const toolCalls = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: turn timed out after ${timeoutMs}ms`)), timeoutMs);
    session.events.on((ev) => {
      if (ev.type === 'text.delta') text += ev.text;
      else if (ev.type === 'tool.start') toolCalls.push(ev.name);
      else if (ev.type === 'permission.request') {
        console.log(`  [${label}] permission.request: ${ev.toolName} (${ev.title ?? ''})`);
        session.respondPermission(ev.toolUseId, ev.toolName.includes('agentura_agents') || (ev.title ?? '').includes('agentura_agents') ? 'allow' : 'deny');
      } else if (ev.type === 'question.request') {
        session.respondPermission(ev.toolUseId, 'deny');
      } else if (ev.type === 'error') {
        errors.push(ev.message);
        if (ev.fatal) {
          clearTimeout(timer);
          reject(new Error(`${label} fatal: ${ev.message}`));
        }
      } else if (ev.type === 'turn.result') {
        clearTimeout(timer);
        if (!ev.ok) reject(new Error(`${label} failed: ${ev.errors?.join('; ') || errors.join('; ') || ev.subtype}`));
        else resolve(ev.text || text);
      } else if (ev.type === 'session.closed' && ev.reason === 'error') {
        clearTimeout(timer);
        reject(new Error(`${label} closed with error: ${ev.message}`));
      }
    });
  });

  if (!session.send(prompt)) {
    session.dispose();
    throw new Error(`${label}: session.send returned false`);
  }
  try {
    const reply = await done;
    return { reply, toolCalls };
  } finally {
    session.dispose();
  }
}

let exitCode = 0;
try {
  // Check catalog first
  const probeRoot = manager.createRootBinding({ rootTreeId: 'smoke-probe', cwd, maxAccess: 'read_only' });
  const cat = await manager.catalog(probeRoot.token);
  console.log('Catalog:', JSON.stringify(cat.providers.map((p) => ({
    provider: p.provider,
    status: p.status,
    modelsCount: p.models.length,
    defaultModel: p.defaultModel,
    reason: p.reason,
  }))));
  for (const p of cat.providers) {
    if (p.status !== 'ready') {
      throw new Error(`Provider ${p.provider} not ready: ${p.status} (${p.reason ?? ''})`);
    }
  }

  // Scenario A: Codex -> Kimi (spawn + wait + send + wait)
  console.log('\n=== Scenario A: Codex -> Kimi (+ agent_send) ===');
  const rootA = manager.createRootBinding({ rootTreeId: 'tree-ck', cwd, maxAccess: 'read_only' });
  const resA = await runRootTurn(
    codexRuntime.adapter(),
    {
      cwd,
      codexDefaults: { sandbox: 'readOnly', approval: 'never' },
      hostMcpServers: [{ name: CHILD_MCP_SERVER, url: mcpServer.urlForToken(rootA.token), builtin: true }],
    },
    [
      'You must use ONLY the MCP tools from server agentura_agents (agents_catalog, agent_spawn, agent_wait, agent_send).',
      'Do NOT run shell commands or native spawn_agent.',
      '1. Call agents_catalog.',
      '2. Call agent_spawn with provider="kimi", task="Reply with exact string KIMI_PONG_42 and nothing else.", idempotency_key="ck-spawn-1", policy={"access":"read_only","allowDelegate":false}.',
      '3. Call agent_wait with that agent_id and timeout_ms=60000.',
      '4. Call agent_send on that same agent_id with message="Now reply with exact string KIMI_FOLLOWUP_99 and nothing else.".',
      '5. Call agent_wait on that agent_id and timeout_ms=60000.',
      '6. In your final response, include both exact strings returned by Kimi.',
    ].join('\n'),
    'Scenario A (Codex->Kimi)',
    150_000,
  );
  console.log('Scenario A tools:', resA.toolCalls);
  console.log('Scenario A reply:', resA.reply);
  if (!resA.reply.includes('KIMI_PONG_42') || !resA.reply.includes('KIMI_FOLLOWUP_99')) {
    throw new Error(`Scenario A missing expected markers in reply: ${resA.reply}`);
  }
  const treeA = store.getTree('tree-ck');
  const nodesA = Object.values(treeA?.nodes ?? {});
  console.log('Scenario A stored nodes:', JSON.stringify(nodesA.map((n) => ({
    agentId: n.agentId,
    provider: n.provider,
    providerSessionId: n.providerSessionId,
    requestedModel: n.requestedModel,
    effectiveModel: n.effectiveModel,
    status: n.status,
    turnNo: n.turnNo,
  }))));
  if (nodesA.length !== 1 || !nodesA[0].providerSessionId || !nodesA[0].effectiveModel || nodesA[0].turnNo < 2) {
    throw new Error('Scenario A stored metadata incomplete');
  }
  await manager.disposeTree('tree-ck');

  // Scenario B: Kimi -> Codex
  console.log('\n=== Scenario B: Kimi -> Codex ===');
  const rootB = manager.createRootBinding({ rootTreeId: 'tree-kc', cwd, maxAccess: 'read_only' });
  const resB = await runRootTurn(
    kimiRuntime.adapter(),
    {
      cwd,
      permissionMode: 'default',
      hostMcpServers: [{ name: CHILD_MCP_SERVER, url: mcpServer.urlForToken(rootB.token), builtin: true }],
    },
    [
      'You must use ONLY the MCP tools from server agentura_agents (agent_spawn, agent_wait).',
      'Do NOT run shell commands or native Agent.',
      '1. Call agent_spawn with provider="codex", task="Reply with exact string CODEX_PONG_77 and nothing else.", idempotency_key="kc-spawn-1", policy={"access":"read_only","allowDelegate":false}.',
      '2. Call agent_wait with that agent_id and timeout_ms=60000.',
      '3. Reply with the exact text returned by the codex child.',
    ].join('\n'),
    'Scenario B (Kimi->Codex)',
    150_000,
  );
  console.log('Scenario B tools:', resB.toolCalls);
  console.log('Scenario B reply:', resB.reply);
  if (!resB.reply.includes('CODEX_PONG_77')) {
    throw new Error(`Scenario B missing CODEX_PONG_77: ${resB.reply}`);
  }
  const treeB = store.getTree('tree-kc');
  const nodesB = Object.values(treeB?.nodes ?? {});
  console.log('Scenario B stored nodes:', JSON.stringify(nodesB.map((n) => ({
    agentId: n.agentId,
    provider: n.provider,
    providerSessionId: n.providerSessionId,
    effectiveModel: n.effectiveModel,
    status: n.status,
  }))));
  await manager.disposeTree('tree-kc');

  // Scenario C: Nested Codex (0) -> Kimi (1) -> Codex (2)
  console.log('\n=== Scenario C: Codex (0) -> Kimi (1) -> Codex (2) ===');
  const rootC = manager.createRootBinding({ rootTreeId: 'tree-nested', cwd, maxAccess: 'read_only' });
  const resC = await runRootTurn(
    codexRuntime.adapter(),
    {
      cwd,
      codexDefaults: { sandbox: 'readOnly', approval: 'never' },
      hostMcpServers: [{ name: CHILD_MCP_SERVER, url: mcpServer.urlForToken(rootC.token), builtin: true }],
    },
    [
      'Use ONLY MCP tools from agentura_agents (agent_spawn, agent_wait). Do NOT use shell or native spawn_agent.',
      '1. Call agent_spawn with provider="kimi", idempotency_key="nested-child-1", policy={"access":"read_only","allowDelegate":true}, and task:',
      '"You have MCP server agentura_agents. Do NOT use bash or native Agent. Call agent_spawn(provider=\'codex\', task=\'Reply with exact string GRANDCHILD_OK_314 and nothing else.\', idempotency_key=\'nested-grandchild-1\', policy={\'access\':\'read_only\',\'allowDelegate\':false}), then call agent_wait(timeout_ms=60000) on that grandchild agent_id, and reply with GRANDCHILD_OK_314."',
      '2. Call agent_wait on your kimi child (timeout_ms=120000).',
      '3. Reply with the result string from the child.',
    ].join('\n'),
    'Scenario C (Codex->Kimi->Codex)',
    180_000,
  );
  console.log('Scenario C tools:', resC.toolCalls);
  console.log('Scenario C reply:', resC.reply);
  if (!resC.reply.includes('GRANDCHILD_OK_314')) {
    throw new Error(`Scenario C missing GRANDCHILD_OK_314: ${resC.reply}`);
  }
  const treeC = store.getTree('tree-nested');
  const nodesC = Object.values(treeC?.nodes ?? {});
  console.log('Scenario C stored tree:', JSON.stringify(nodesC.map((n) => ({
    agentId: n.agentId,
    parentId: n.parentId,
    depth: n.depth,
    provider: n.provider,
    effectiveModel: n.effectiveModel,
    status: n.status,
  }))));
  const depth1 = nodesC.find((n) => n.depth === 1 && n.parentId === null && n.provider === 'kimi');
  const depth2 = nodesC.find((n) => n.depth === 2 && n.parentId === depth1?.agentId && n.provider === 'codex');
  if (!depth1 || !depth2) {
    throw new Error('Scenario C missing expected depth 1 -> depth 2 parentId linkage');
  }
  console.log(`Tree events captured: ${treeEvents.length}`);
  await manager.disposeTree('tree-nested');
  console.log('\nALL CROSS-PROVIDER CODEX <-> KIMI LIVE SCENARIOS PASSED.');
} catch (err) {
  exitCode = 1;
  console.error('\nSMOKE FAILED:', err);
} finally {
  await mcpServer.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
  process.exit(exitCode);
}
