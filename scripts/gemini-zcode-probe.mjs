#!/usr/bin/env node
// Stage 5 probe: verify Gemini CLI (--acp) & ZCode CLI (app-server --stdio) integration
// through ChildSessionManager + ChildAgentsMcpServer without mutating ~/.zcode or ~/.gemini credentials.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadTs } from './lib/load-ts.mjs';

const {
  ChildSessionManager,
  ChildAgentsMcpServer,
  ChildAgentStore,
  createGeminiRuntime,
  createZCodeRuntime,
} = await loadTs('src/agent/children/index.ts');

function snapMtimes(paths) {
  const out = {};
  for (const p of paths) {
    out[p] = existsSync(p) ? statSync(p).mtimeMs : null;
  }
  return out;
}

const watchPaths = [
  join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
  join(homedir(), '.zcode', 'v2', 'credentials.json'),
  join(homedir(), '.zcode', 'v2', 'setting.json'),
  join(homedir(), '.gemini', 'oauth_creds.json'),
  join(homedir(), '.gemini', 'settings.json'),
];
const beforeMtimes = snapMtimes(watchPaths);

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-gz-probe-')));
const cwd = join(tmpRoot, 'ws');
const storeDir = join(tmpRoot, 'store');
mkdirSync(cwd, { recursive: true });
mkdirSync(storeDir, { recursive: true });

class DummySession {
  id = 'dummy-sess';
  events = { on: () => () => {} };
  send() { return true; }
  respondPermission() { return true; }
  answerQuestion() { return true; }
  decidePlan() { return true; }
  async setMode() {}
  async setModel() {}
  async setEffort() {}
  async interrupt() {}
  compact() { return false; }
  async stopTask() {}
  async capabilities() { return { models: [], commands: [] }; }
  async contextUsage() { return undefined; }
  dispose() {}
}

const zcodeNoDelegateReadyRuntime = {
  provider: 'zcode-nodelegate',
  label: 'ZCode (ready capability fixture)',
  adapter: () => ({
    id: 'zcode-nodelegate',
    createSession: async () => new DummySession(),
    resumeSession: async () => new DummySession(),
    listSessions: async () => [],
    loadHistory: async () => ({ events: [], turns: 0, skippedTurns: 0 }),
    renameSession: async () => {},
    accountInfo: async () => ({}),
  }),
  inspect: async () => ({
    status: 'ready',
    models: [{ value: 'agentura-zai-key/glm-5.3', displayName: 'glm-5.3', supportsEffort: false }],
    defaultModel: 'agentura-zai-key/glm-5.3',
    supportedAccess: ['read_only', 'workspace_write', 'full_access'],
    supportsFineGrainedWritePaths: false,
    canDelegateViaMcp: false,
  }),
};

const store = new ChildAgentStore(storeDir);
const manager = new ChildSessionManager({
  store,
  providers: [createGeminiRuntime(), createZCodeRuntime(), zcodeNoDelegateReadyRuntime],
});
const mcpServer = new ChildAgentsMcpServer(manager);
await mcpServer.start();

function parseTool(res) {
  const txt = res?.content?.[0]?.text;
  if (!txt) throw new Error('Empty MCP tool response');
  return JSON.parse(txt);
}

try {
  const rootBinding = manager.createRootBinding({
    rootTreeId: 'gz-probe-tree',
    cwd,
    maxAccess: 'read_only',
  });
  const client = new Client({ name: 'gz-probe', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpServer.urlForToken(rootBinding.token))));

  const catalog = parseTool(await client.callTool({ name: 'agents_catalog', arguments: {} }));
  const gemini = catalog.providers.find((p) => p.provider === 'gemini');
  const zcode = catalog.providers.find((p) => p.provider === 'zcode');

  console.log('GEMINI CATALOG:', JSON.stringify({
    status: gemini?.status,
    defaultModel: gemini?.defaultModel,
    models: gemini?.models?.map((m) => m.value),
    canDelegateViaMcp: gemini?.canDelegateViaMcp,
    reason: gemini?.reason,
  }));
  console.log('ZCODE CATALOG:', JSON.stringify({
    status: zcode?.status,
    defaultModel: zcode?.defaultModel,
    models: zcode?.models?.map((m) => m.value),
    canDelegateViaMcp: zcode?.canDelegateViaMcp,
    reason: zcode?.reason,
  }));

  if (!gemini || !Array.isArray(gemini.models) || !gemini.models.some((m) => m.value === 'gemini-2.5-pro')) {
    throw new Error('Gemini catalog did not load models from gemini --list-models');
  }
  if (!zcode || zcode.canDelegateViaMcp !== false) {
    throw new Error(`Expected zcode canDelegateViaMcp=false, got ${JSON.stringify(zcode)}`);
  }

  if (gemini.status === 'needs_auth') {
    const res = await client.callTool({
      name: 'agent_spawn',
      arguments: { provider: 'gemini', task: 'ping', policy: { access: 'read_only' } },
    });
    const body = parseTool(res);
    console.log('GEMINI SPAWN REJECTION:', JSON.stringify(body));
    const code = body.error?.code ?? body.code;
    if (!res.isError || code !== 'AUTH_REQUIRED') {
      throw new Error(`Expected AUTH_REQUIRED for gemini, got ${JSON.stringify(body)}`);
    }
  }

  if (zcode.status === 'needs_auth') {
    const res = await client.callTool({
      name: 'agent_spawn',
      arguments: { provider: 'zcode', task: 'ping', policy: { access: 'read_only' } },
    });
    const body = parseTool(res);
    console.log('ZCODE SPAWN REJECTION:', JSON.stringify(body));
    const code = body.error?.code ?? body.code;
    if (!res.isError || code !== 'AUTH_REQUIRED') {
      throw new Error(`Expected AUTH_REQUIRED for zcode, got ${JSON.stringify(body)}`);
    }
  }

  const delRes = await client.callTool({
    name: 'agent_spawn',
    arguments: {
      provider: 'zcode-nodelegate',
      task: 'nested',
      policy: { access: 'read_only', allowDelegate: true },
    },
  });
  const delBody = parseTool(delRes);
  console.log('ZCODE allowDelegate=true REJECTION:', JSON.stringify(delBody));
  const delCode = delBody.error?.code ?? delBody.code;
  if (!delRes.isError || delCode !== 'POLICY_UNSUPPORTED_BY_ENGINE') {
    throw new Error(`Expected POLICY_UNSUPPORTED_BY_ENGINE, got ${JSON.stringify(delBody)}`);
  }

  await client.close();

  const afterMtimes = snapMtimes(watchPaths);
  for (const p of watchPaths) {
    if (beforeMtimes[p] !== afterMtimes[p]) {
      throw new Error(`Watched config/db file was mutated: ${p} (${beforeMtimes[p]} -> ${afterMtimes[p]})`);
    }
  }
  console.log('CONFIG_MTIMES_UNCHANGED: OK');
} finally {
  await mcpServer.close().catch(() => {});
  await manager.disposeTree('gz-probe-tree').catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
}
