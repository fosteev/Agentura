import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelOption,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
} from '../types';
import { ChildSessionManager } from './manager';
import { ChildAgentsMcpServer } from './mcpServer';
import { ChildAgentStore } from './store';
import type { ProviderInspectResult, ProviderRuntime } from './types';

class FakeAgentSession implements AgentSession {
  readonly id = 'sess-mcp';
  readonly events = new EventHub<AgentEvent>();
  promptSent?: string;
  isDisposed = false;

  constructor(private readonly deferTurn = false) {}

  send(text: string): boolean {
    this.promptSent = text;
    this.events.emit({
      type: 'session.init',
      sessionId: 'sess-mcp-init',
      model: 'gpt-4o',
      cwd: '/workspace',
      permissionMode: 'plan',
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: '1.0',
    });
    if (!this.deferTurn) {
      this.events.emit({
        type: 'turn.result',
        ok: true,
        subtype: 'success',
        interrupted: false,
        durationMs: 5,
        apiDurationMs: 5,
        numTurns: 1,
        totalCostUsd: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        permissionDenials: [],
        text: 'Result from child MCP session',
      });
    }
    return true;
  }

  respondPermission(): boolean {
    return true;
  }
  answerQuestion(): boolean {
    return true;
  }
  decidePlan(): boolean {
    return true;
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async interrupt(): Promise<void> {}
  compact(): boolean {
    return true;
  }
  async stopTask(): Promise<void> {}
  async capabilities(): Promise<SessionCapabilities> {
    return { models: [], commands: [] };
  }
  async contextUsage(): Promise<undefined> {
    return undefined;
  }
  dispose(): void {
    this.isDisposed = true;
  }
}

class FakeProviderAdapter implements AgentAdapter {
  readonly id = 'fake-adapter';
  deferNextTurn = false;
  lastSessionOptions?: unknown;
  async createSession(options: unknown): Promise<AgentSession> {
    this.lastSessionOptions = options;
    const defer = this.deferNextTurn;
    this.deferNextTurn = false;
    return new FakeAgentSession(defer);
  }
  async resumeSession(): Promise<AgentSession> {
    return new FakeAgentSession(this.deferNextTurn);
  }
  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }
  async loadHistory(): Promise<SessionHistory> {
    return { events: [], turns: 0, skippedTurns: 0 };
  }
  async renameSession(): Promise<void> {}
  async accountInfo(): Promise<AccountInfo> {
    return {};
  }
}

interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parseResult(res: ToolCallResult): Record<string, unknown> {
  const item = res.content[0];
  if (!item) throw new Error('Missing content in tool response');
  return JSON.parse(item.text) as Record<string, unknown>;
}

describe('ChildAgentsMcpServer', () => {
  let tmpDir: string;
  let storeDir: string;
  let workspaceDir: string;
  let mcpServer: ChildAgentsMcpServer;
  let manager: ChildSessionManager;
  let fakeAdapter: FakeProviderAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentura-mcp-test-'));
    storeDir = join(tmpDir, 'store');
    workspaceDir = join(tmpDir, 'ws');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'fileA.ts'), 'content A');

    const models: ModelOption[] = [
      { value: 'gpt-4o', displayName: 'GPT-4o', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
    ];

    const inspectResult: ProviderInspectResult = {
      status: 'ready',
      models,
      defaultModel: 'gpt-4o',
      supportedAccess: ['read_only', 'workspace_write', 'full_access'],
      supportsFineGrainedWritePaths: true,
      canDelegateViaMcp: true,
    };

    fakeAdapter = new FakeProviderAdapter();
    const runtime: ProviderRuntime = {
      provider: 'codex',
      label: 'Codex',
      adapter: () => fakeAdapter,
      inspect: async () => inspectResult,
    };

    const store = new ChildAgentStore(storeDir);
    manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    mcpServer = new ChildAgentsMcpServer(manager);
    await mcpServer.start();
  });

  afterEach(async () => {
    await mcpServer.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('connects via StreamableHTTPClientTransport and executes all 6 tools', async () => {
    const root = manager.createRootBinding({
      rootTreeId: 'tree-mcp-integration',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const url = mcpServer.urlForToken(root.token);
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });

    await client.connect(transport);

    // 1. listTools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('agents_catalog');
    expect(toolNames).toContain('agent_spawn');
    expect(toolNames).toContain('agent_status');
    expect(toolNames).toContain('agent_wait');
    expect(toolNames).toContain('agent_send');
    expect(toolNames).toContain('agent_stop');

    // 2. agents_catalog
    const catalogRes = (await client.callTool({ name: 'agents_catalog', arguments: {} })) as unknown as ToolCallResult;
    expect(catalogRes.isError).toBeFalsy();
    const catalogData = parseResult(catalogRes) as { ok: boolean; providers: { provider: string }[] };
    expect(catalogData.ok).toBe(true);
    expect(catalogData.providers[0]?.provider).toBe('codex');

    // 3. agent_spawn
    const spawnRes = (await client.callTool({
      name: 'agent_spawn',
      arguments: {
        provider: 'codex',
        task: 'Write greeting via MCP',
      },
    })) as unknown as ToolCallResult;
    expect(spawnRes.isError).toBeFalsy();
    const spawnData = parseResult(spawnRes) as { ok: boolean; agent_id: string };
    expect(spawnData.ok).toBe(true);
    expect(spawnData.agent_id).toBeDefined();
    const childId = spawnData.agent_id;

    // 4. agent_status
    const statusRes = (await client.callTool({
      name: 'agent_status',
      arguments: { agent_id: childId },
    })) as unknown as ToolCallResult;
    expect(statusRes.isError).toBeFalsy();
    const statusData = parseResult(statusRes) as { ok: boolean; agent_id: string };
    expect(statusData.ok).toBe(true);
    expect(statusData.agent_id).toBe(childId);

    // 5. agent_wait
    const waitRes = (await client.callTool({
      name: 'agent_wait',
      arguments: { agent_id: childId },
    })) as unknown as ToolCallResult;
    expect(waitRes.isError).toBeFalsy();
    const waitData = parseResult(waitRes) as { ok: boolean; agents: { status: string; summary: string }[] };
    expect(waitData.ok).toBe(true);
    expect(waitData.agents[0]?.status).toBe('completed');
    expect(waitData.agents[0]?.summary).toBe('Result from child MCP session');

    // 6. agent_send
    const sendRes = (await client.callTool({
      name: 'agent_send',
      arguments: { agent_id: childId, message: 'follow-up turn' },
    })) as unknown as ToolCallResult;
    expect(sendRes.isError).toBeFalsy();
    const sendData = parseResult(sendRes) as { ok: boolean; status: string; turn_count: number };
    expect(sendData.ok).toBe(true);
    expect(sendData.status).toBe('running');
    expect(sendData.turn_count).toBe(2);

    // 7. agent_stop on already-completed agent is safe and preserves completed status
    const stopDoneRes = (await client.callTool({
      name: 'agent_stop',
      arguments: { agent_id: childId },
    })) as unknown as ToolCallResult;
    expect(stopDoneRes.isError).toBeFalsy();
    const stopDoneData = parseResult(stopDoneRes) as { ok: boolean; stopped_ids: string[]; already_terminal: boolean };
    expect(stopDoneData.ok).toBe(true);
    expect(stopDoneData.already_terminal).toBe(true);
    expect(stopDoneData.stopped_ids).toEqual([]);

    const statusAfterStop = (await client.callTool({
      name: 'agent_status',
      arguments: { agent_id: childId },
    })) as unknown as ToolCallResult;
    const statusAfterStopData = parseResult(statusAfterStop) as { status: string };
    expect(statusAfterStopData.status).toBe('completed');

    // 8. agent_spawn a deferred long-running child (verify auto-wired hostMcpServers) and stop it
    fakeAdapter.deferNextTurn = true;
    const spawn2Res = (await client.callTool({
      name: 'agent_spawn',
      arguments: {
        provider: 'codex',
        task: 'Deferred long task',
      },
    })) as unknown as ToolCallResult;
    expect(spawn2Res.isError).toBeFalsy();
    const child2Id = (parseResult(spawn2Res) as { agent_id: string }).agent_id;
    const passedOpts = fakeAdapter.lastSessionOptions as { hostMcpServers?: { name: string; url: string }[] };
    expect(passedOpts.hostMcpServers?.[0]?.name).toBe('agentura_agents');
    expect(passedOpts.hostMcpServers?.[0]?.url).toContain(`127.0.0.1:${mcpServer.port}/mcp/`);

    const stopRunningRes = (await client.callTool({
      name: 'agent_stop',
      arguments: { agent_id: child2Id },
    })) as unknown as ToolCallResult;
    expect(stopRunningRes.isError).toBeFalsy();
    const stopRunningData = parseResult(stopRunningRes) as { ok: boolean; stopped_ids: string[]; already_terminal: boolean };
    expect(stopRunningData.ok).toBe(true);
    expect(stopRunningData.already_terminal).toBe(false);
    expect(stopRunningData.stopped_ids).toContain(child2Id);

    // 9. Idempotent second stop on stopped agent
    const stopRepeatRes = (await client.callTool({
      name: 'agent_stop',
      arguments: { agent_id: child2Id },
    })) as unknown as ToolCallResult;
    const stopRepeatData = parseResult(stopRepeatRes) as { ok: boolean; stopped_ids: string[]; already_terminal: boolean };
    expect(stopRepeatData.ok).toBe(true);
    expect(stopRepeatData.already_terminal).toBe(true);
    expect(stopRepeatData.stopped_ids).toEqual([]);

    await client.close();
  });

  it('returns 401 on missing or invalid token and rejects parent_id in agent_spawn', async () => {
    // 1. Missing or invalid token HTTP check
    const invalidUrl = `http://127.0.0.1:${mcpServer.port}/mcp/non-existent-token`;
    const res = await fetch(invalidUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);

    // 2. 404 for unknown path
    const notFoundRes = await fetch(`http://127.0.0.1:${mcpServer.port}/unknown-path`);
    expect(notFoundRes.status).toBe(404);

    // 3. Reject parent_id in agent_spawn arguments
    const root = manager.createRootBinding({
      rootTreeId: 'tree-mcp-sec',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const url = mcpServer.urlForToken(root.token);
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });
    await client.connect(transport);

    const forgedRes = (await client.callTool({
      name: 'agent_spawn',
      arguments: {
        provider: 'codex',
        task: 'Spoof attempt',
        parent_id: 'forged_parent_123',
      },
    })) as unknown as ToolCallResult;

    expect(forgedRes.isError).toBe(true);
    const errData = parseResult(forgedRes) as { ok: boolean; error: { code: string; message: string } };
    expect(errData.ok).toBe(false);
    expect(errData.error.code).toBe('INVALID_ARGUMENTS');
    expect(errData.error.message).toContain('parent_id is not allowed');

    await client.close();
  });
});
