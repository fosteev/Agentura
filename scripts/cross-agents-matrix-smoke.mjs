#!/usr/bin/env node
// Opt-in live matrix smoke: verify Codex, Kimi, Claude, Antigravity, Cursor both as MCP parent and as child executor.
// Runs only minimal read_only synthetic token tasks in an isolated /tmp workspace (no infinite retries on errors/quotas).
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

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-matrix-smoke-')));
const cwd = join(tmpRoot, 'ws');
const storeDir = join(tmpRoot, 'store');
mkdirSync(cwd, { recursive: true });
mkdirSync(storeDir, { recursive: true });

const store = new ChildAgentStore(storeDir);
const runtimes = createProviderRuntimes({
  log: (level, msg) => {
    if (level === 'error' || level === 'warn') console.error(`  [${level}] ${msg}`);
  },
});

const manager = new ChildSessionManager({
  store,
  providers: runtimes,
  limits: { maxDepth: 2, maxConcurrentRunning: 3, maxTotalSpawns: 24 },
});

const mcpServer = new ChildAgentsMcpServer(manager);
await mcpServer.start();
console.log(`Matrix MCP server at 127.0.0.1:${mcpServer.port}`);

function pickModel(entry, provider) {
  const vals = (entry?.models ?? []).map((m) => m.value);
  if (provider === 'antigravity') {
    return vals.find((v) => v === 'gemini-4-hydrogen-medium')
      ?? vals.find((v) => v === 'gemini-4-hydrogen-high')
      ?? vals.find((v) => v.startsWith('gemini-4-hydrogen'))
      ?? vals.find((v) => !v.startsWith('claude-'))
      ?? null;
  }
  if (provider === 'claude') {
    return vals.find((v) => v.includes('haiku')) ?? entry?.defaultModel ?? null;
  }
  if (provider === 'cursor') {
    return vals.find((v) => v === 'default[]') ?? entry?.defaultModel ?? null;
  }
  return entry?.defaultModel ?? vals[0] ?? null;
}

async function runParentScenario(name, parentRuntime, parentOptions, childProvider, childModel, marker) {
  const treeId = `matrix-${name}`;
  const rootBinding = manager.createRootBinding({ rootTreeId: treeId, cwd, maxAccess: 'read_only' });
  const adapter = parentRuntime.adapter();
  const hostMcpServers = [{ name: CHILD_MCP_SERVER, url: mcpServer.urlForToken(rootBinding.token), builtin: true }];
  const session = await adapter.createSession({ ...parentOptions, cwd, hostMcpServers });

  const toolCalls = [];
  const errors = [];
  let text = '';

  const prompt = [
    'Use ONLY the MCP tools from server agentura_agents (agent_spawn, agent_wait).',
    'Do NOT use native Agent/Task/spawn_agent/invoke_subagent and do NOT run bash/shell commands.',
    `1. Call agent_spawn with provider="${childProvider}"${childModel ? `, model="${childModel}"` : ''}, task="Reply with the exact token ${marker} and nothing else.", idempotency_key="m-${name}", policy={"access":"read_only","allowDelegate":false}.`,
    '2. Call agent_wait with that agent_id and timeout_ms=75000.',
    '3. Repeat the exact token returned by the child in your final message.',
  ].join('\n');

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: timed out`)), 135_000);
    session.events.on((ev) => {
      if (ev.type === 'text.delta') text += ev.text;
      else if (ev.type === 'tool.start') toolCalls.push(ev.name);
      else if (ev.type === 'permission.request') {
        const allow = ev.toolName.includes('agentura_agents') || (ev.title ?? '').includes('agentura_agents');
        session.respondPermission(ev.toolUseId, allow ? 'allow' : 'deny');
      } else if (ev.type === 'question.request') {
        session.respondPermission(ev.toolUseId, 'deny');
      } else if (ev.type === 'error') {
        errors.push(ev.message);
        if (ev.fatal) {
          clearTimeout(timer);
          reject(new Error(ev.message));
        }
      } else if (ev.type === 'turn.result') {
        clearTimeout(timer);
        if (!ev.ok) reject(new Error(ev.errors?.join('; ') || errors.join('; ') || ev.subtype));
        else resolve(ev.text || text);
      } else if (ev.type === 'session.closed' && ev.reason === 'error') {
        clearTimeout(timer);
        reject(new Error(ev.message || 'session.closed error'));
      }
    });
  });

  try {
    if (!session.send(prompt)) throw new Error(`${name}: send returned false`);
    const reply = await done;
    const nodes = Object.values(store.getTree(treeId)?.nodes ?? {});
    const childOk = nodes.some((n) => n.provider === childProvider && n.status === 'completed' && (n.summary || '').includes(marker));
    const replyOk = reply.includes(marker);
    return {
      scenario: name,
      parent: parentRuntime.provider,
      child: childProvider,
      ok: childOk && replyOk,
      tools: toolCalls,
      childStatus: nodes[0]?.status ?? 'none',
      effectiveModel: nodes[0]?.effectiveModel ?? null,
      replySample: reply.slice(0, 120),
    };
  } catch (err) {
    return {
      scenario: name,
      parent: parentRuntime.provider,
      child: childProvider,
      ok: false,
      tools: toolCalls,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    session.dispose();
    await manager.disposeTree(treeId);
  }
}

const results = [];
try {
  const probe = manager.createRootBinding({ rootTreeId: 'matrix-probe', cwd, maxAccess: 'read_only' });
  const catalog = await manager.catalog(probe.token);
  console.log('\nCatalog:');
  for (const p of catalog.providers) {
    console.log(`- ${p.provider}: status=${p.status}, models=${p.models.length}, default=${p.defaultModel}, reason=${p.reason ?? '-'}`);
  }

  const byProvider = new Map(catalog.providers.map((p) => [p.provider, p]));
  const rt = (id) => runtimes.find((r) => r.provider === id);
  const ready = (id) => byProvider.get(id)?.status === 'ready';

  const scenarios = [
    {
      name: 'codex-to-claude',
      parent: 'codex',
      parentOpts: { codexDefaults: { sandbox: 'readOnly', approval: 'never' } },
      child: 'claude',
      marker: 'CLAUDE_CHILD_OK_101',
    },
    {
      name: 'claude-to-codex',
      parent: 'claude',
      parentOpts: { permissionMode: 'default', model: pickModel(byProvider.get('claude'), 'claude') ?? undefined },
      child: 'codex',
      marker: 'CODEX_CHILD_OK_202',
    },
    {
      name: 'codex-to-agy',
      parent: 'codex',
      parentOpts: { codexDefaults: { sandbox: 'readOnly', approval: 'never' } },
      child: 'antigravity',
      marker: 'AGY_CHILD_OK_303',
    },
    {
      name: 'agy-to-kimi',
      parent: 'antigravity',
      parentOpts: { permissionMode: 'default', model: pickModel(byProvider.get('antigravity'), 'antigravity') ?? 'gemini-4-hydrogen-medium' },
      child: 'kimi',
      marker: 'KIMI_FROM_AGY_404',
    },
    {
      name: 'kimi-to-cursor',
      parent: 'kimi',
      parentOpts: { permissionMode: 'default' },
      child: 'cursor',
      marker: 'CURSOR_CHILD_OK_505',
    },
    {
      name: 'cursor-to-codex',
      parent: 'cursor',
      parentOpts: { permissionMode: 'default', model: pickModel(byProvider.get('cursor'), 'cursor') ?? undefined },
      child: 'codex',
      marker: 'CODEX_FROM_CURSOR_606',
    },
  ];

  for (const s of scenarios) {
    if (!ready(s.parent) || !ready(s.child)) {
      results.push({
        scenario: s.name,
        parent: s.parent,
        child: s.child,
        ok: false,
        skipped: true,
        error: `Unready: parent=${byProvider.get(s.parent)?.status ?? 'missing'}, child=${byProvider.get(s.child)?.status ?? 'missing'}`,
      });
      continue;
    }
    const childModel = pickModel(byProvider.get(s.child), s.child);
    console.log(`\nRunning ${s.name} (parent=${s.parent}, child=${s.child}, childModel=${childModel})...`);
    const r = await runParentScenario(s.name, rt(s.parent), s.parentOpts, s.child, childModel, s.marker);
    console.log('Result:', JSON.stringify(r));
    results.push(r);
  }

  console.log('\n=== MATRIX SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await mcpServer.close();
  rmSync(tmpRoot, { recursive: true, force: true });
}
