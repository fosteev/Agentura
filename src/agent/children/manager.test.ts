import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../stream';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ModelOption,
  PermissionDecision,
  PlanDecision,
  ResumeOptions,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
} from '../types';
import { ChildSessionManager } from './manager';
import type { WorktreeManager } from './ownership';
import { ChildAgentStore } from './store';
import {
  ChildAgentError,
  type ChildAccessMode,
  type ChildStatusView,
  type ProviderInspectResult,
  type ProviderRuntime,
  type SessionBinding,
} from './types';

class FakeAgentSession implements AgentSession {
  readonly id: string;
  readonly events = new EventHub<AgentEvent>();
  promptSent?: string;
  isDisposed = false;
  isInterrupted = false;
  permissionDecisions: { toolUseId: string; decision: PermissionDecision }[] = [];
  questionAnswers: { toolUseId: string; answers: Record<string, string> }[] = [];
  planDecisions: { toolUseId: string; decision: PlanDecision }[] = [];

  constructor(
    id: string,
    private readonly onSend?: (session: FakeAgentSession, text: string) => void,
  ) {
    this.id = id;
  }

  send(text: string): boolean {
    if (this.isDisposed) return false;
    this.promptSent = text;
    if (this.onSend) {
      this.onSend(this, text);
    }
    return true;
  }

  respondPermission(toolUseId: string, decision: PermissionDecision): boolean {
    this.permissionDecisions.push({ toolUseId, decision });
    this.events.emit({
      type: 'permission.resolved',
      toolUseId,
      decision: decision === 'deny' ? 'deny' : 'allow',
      by: 'user',
    });
    return true;
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    this.questionAnswers.push({ toolUseId, answers });
    return true;
  }

  decidePlan(toolUseId: string, decision: PlanDecision): boolean {
    this.planDecisions.push({ toolUseId, decision });
    return true;
  }

  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async interrupt(): Promise<void> {
    this.isInterrupted = true;
  }
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
  sessions: FakeAgentSession[] = [];
  createSessionHook?: (options: SessionOptions) => Promise<FakeAgentSession> | FakeAgentSession;
  onSendBehavior?: (session: FakeAgentSession, text: string) => void;

  async createSession(options: SessionOptions): Promise<AgentSession> {
    if (this.createSessionHook) {
      const s = await this.createSessionHook(options);
      this.sessions.push(s);
      return s;
    }

    const s = new FakeAgentSession(`fake-sess-${this.sessions.length + 1}`, (sess, text) => {
      this.onSendBehavior?.(sess, text);
    });
    this.sessions.push(s);
    return s;
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    void options;
    const existing = this.sessions.find((s) => s.id === sessionId);
    if (existing) return existing;
    const s = new FakeAgentSession(sessionId, (sess, text) => {
      this.onSendBehavior?.(sess, text);
    });
    this.sessions.push(s);
    return s;
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
  async complete(): Promise<string> {
    return '';
  }
}

function createFakeProviderRuntime(
  provider: string,
  options: {
    status?: 'ready' | 'needs_auth' | 'unavailable' | 'unsupported';
    models?: ModelOption[];
    defaultModel?: string;
    reason?: string;
    supportedAccess?: ChildAccessMode[];
    supportsFineGrainedWritePaths?: boolean;
    canDelegateViaMcp?: boolean;
    adapter?: FakeProviderAdapter;
  } = {},
): { runtime: ProviderRuntime; adapter: FakeProviderAdapter } {
  const adapter = options.adapter ?? new FakeProviderAdapter();
  const models: ModelOption[] = options.models ?? [
    { value: 'gpt-4o', displayName: 'GPT-4o', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
    { value: 'claude-3-5-sonnet', displayName: 'Sonnet 3.5' },
  ];

  const inspectResult: ProviderInspectResult = {
    status: options.status ?? 'ready',
    models,
    defaultModel: options.defaultModel ?? models[0]?.value,
    reason: options.reason,
    supportedAccess: options.supportedAccess ?? ['read_only', 'workspace_write', 'full_access'],
    supportsFineGrainedWritePaths: options.supportsFineGrainedWritePaths ?? true,
    canDelegateViaMcp: options.canDelegateViaMcp ?? true,
  };

  const runtime: ProviderRuntime = {
    provider,
    label: provider.toUpperCase(),
    adapter: () => adapter,
    inspect: async () => inspectResult,
  };

  return { runtime, adapter };
}

describe('ChildSessionManager', () => {
  let tmpDir: string;
  let storeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentura-child-test-'));
    storeDir = join(tmpDir, 'store');
    workspaceDir = join(tmpDir, 'ws');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(tmpDir, 'dummy.txt'), 'root');
    writeFileSync(join(workspaceDir, 'fileA.ts'), 'content A');
    writeFileSync(join(workspaceDir, 'fileB.ts'), 'content B');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1) agents_catalog: returns verified models, statuses and remaining limits', async () => {
    const { runtime: codexRuntime } = createFakeProviderRuntime('codex');
    const { runtime: kimiRuntime } = createFakeProviderRuntime('kimi', {
      status: 'needs_auth',
      reason: 'API key not configured',
    });

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [codexRuntime, kimiRuntime],
    });

    const rootBinding = manager.createRootBinding({
      rootTreeId: 'tree-1',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const catalog = await manager.catalog(rootBinding.token);
    expect(catalog.providers).toHaveLength(2);

    const codex = catalog.providers.find((p) => p.provider === 'codex');
    expect(codex?.status).toBe('ready');
    expect(codex?.models).toHaveLength(2);
    expect(codex?.models[0]?.value).toBe('gpt-4o');

    const kimi = catalog.providers.find((p) => p.provider === 'kimi');
    expect(kimi?.status).toBe('needs_auth');
    expect(kimi?.reason).toBe('API key not configured');

    expect(catalog.limits.depth).toBe(0);
    expect(catalog.limits.maxDepth).toBe(2);
    expect(catalog.limits.activeRunning).toBe(0);
    expect(catalog.limits.maxConcurrentRunning).toBe(3);
    expect(catalog.limits.totalSpawns).toBe(0);
    expect(catalog.limits.maxTotalSpawns).toBe(16);
  });

  it('2) checks model existence, effort and auth status', async () => {
    const { runtime: codexRuntime } = createFakeProviderRuntime('codex');
    const { runtime: authRuntime } = createFakeProviderRuntime('unauthed', { status: 'needs_auth' });

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [codexRuntime, authRuntime],
    });

    const rootBinding = manager.createRootBinding({
      rootTreeId: 'tree-err',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    // UNKNOWN_MODEL
    await expect(
      manager.spawn(rootBinding.token, {
        provider: 'codex',
        task: 'test',
        model: 'non-existent-model',
      }),
    ).rejects.toThrowError(ChildAgentError);

    // UNSUPPORTED_EFFORT
    await expect(
      manager.spawn(rootBinding.token, {
        provider: 'codex',
        task: 'test',
        model: 'claude-3-5-sonnet', // supportsEffort is undefined/false
        reasoning_effort: 'high',
      }),
    ).rejects.toThrowError(ChildAgentError);

    // AUTH_REQUIRED
    await expect(
      manager.spawn(rootBinding.token, {
        provider: 'unauthed',
        task: 'test',
      }),
    ).rejects.toThrowError(ChildAgentError);
  });

  it('3) non-blocking spawn + status + wait with completion and timeout', async () => {
    const { runtime, adapter } = createFakeProviderRuntime('codex');

    let activeSessionInstance: FakeAgentSession | undefined;
    adapter.onSendBehavior = (session) => {
      activeSessionInstance = session;
      // Emit session.init
      session.events.emit({
        type: 'session.init',
        sessionId: 'codex-sess-1',
        model: 'gpt-4o-2024-11-20',
        cwd: workspaceDir,
        permissionMode: 'plan',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1.0',
      });
      // Do NOT complete yet!
    };

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-async',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    // Spawn returns immediately with status running
    const spawnRes = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'Long running task',
    });

    expect(spawnRes.agent_id).toBeDefined();
    expect(spawnRes.status).toBe('running');

    // Check status immediately
    const statusView = (await manager.status(root.token, { agent_id: spawnRes.agent_id })) as ChildStatusView;
    expect(statusView.status).toBe('running');
    expect(statusView.effective_model).toBe('gpt-4o-2024-11-20');

    // agent_wait with small timeout (100ms) should time out
    const waitTimeoutRes = await manager.wait(root.token, {
      agent_id: spawnRes.agent_id,
      timeout_ms: 100,
    });
    expect(waitTimeoutRes.timed_out).toBe(true);
    expect(waitTimeoutRes.agents[0]?.status).toBe('running');

    // Now emit turn.result from session
    activeSessionInstance?.events.emit({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 50,
      apiDurationMs: 40,
      numTurns: 1,
      totalCostUsd: 0.01,
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      permissionDenials: [],
      text: 'Task completed successfully!',
    });

    // Next wait should succeed immediately
    const waitDoneRes = await manager.wait(root.token, {
      agent_id: spawnRes.agent_id,
      timeout_ms: 1000,
    });
    expect(waitDoneRes.timed_out).toBe(false);
    expect(waitDoneRes.agents[0]?.status).toBe('completed');
    expect(waitDoneRes.agents[0]?.summary).toBe('Task completed successfully!');
  });

  it('4) idempotency: duplicate key with same args returns existing; different args throws IDEMPOTENCY_CONFLICT', async () => {
    const { runtime } = createFakeProviderRuntime('codex');
    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-idem',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const first = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'Build report',
      idempotency_key: 'key-123',
    });

    // Exact duplicate
    const second = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'Build report',
      idempotency_key: 'key-123',
    });

    expect(second.agent_id).toBe(first.agent_id);

    // Conflicting duplicate
    await expect(
      manager.spawn(root.token, {
        provider: 'codex',
        task: 'Different task',
        idempotency_key: 'key-123',
      }),
    ).rejects.toThrowError(ChildAgentError);
  });

  it('5) agent_send: send follow-up to completed agent; AGENT_BUSY if running; AGENT_NOT_SENDABLE if stopped', async () => {
    const { runtime, adapter } = createFakeProviderRuntime('codex');

    adapter.onSendBehavior = (sess) => {
      sess.events.emit({
        type: 'session.init',
        sessionId: 'codex-sess-send',
        model: 'gpt-4o',
        cwd: workspaceDir,
        permissionMode: 'plan',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1.0',
      });
      // Finish turn 1
      sess.events.emit({
        type: 'turn.result',
        ok: true,
        subtype: 'success',
        interrupted: false,
        durationMs: 10,
        apiDurationMs: 10,
        numTurns: 1,
        totalCostUsd: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        permissionDenials: [],
        text: 'Turn 1 done',
      });
    };

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-send',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const spawn = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'Turn 1 prompt',
    });

    // Wait until completed
    await manager.wait(root.token, { agent_id: spawn.agent_id });

    // Send turn 2
    adapter.onSendBehavior = (sess) => {
      void sess;
      // Leave in running state!
    };

    const sendRes = await manager.send(root.token, {
      agent_id: spawn.agent_id,
      message: 'Turn 2 prompt',
    });
    expect(sendRes.status).toBe('running');
    expect(sendRes.turn_count).toBe(2);

    // Attempting send while running -> AGENT_BUSY
    await expect(
      manager.send(root.token, {
        agent_id: spawn.agent_id,
        message: 'Turn 3 while busy',
      }),
    ).rejects.toThrowError(ChildAgentError);

    // Stop agent
    await manager.stop(root.token, { agent_id: spawn.agent_id });

    // Attempting send to stopped agent -> AGENT_NOT_SENDABLE
    await expect(
      manager.send(root.token, {
        agent_id: spawn.agent_id,
        message: 'Turn 3 after stop',
      }),
    ).rejects.toThrowError(ChildAgentError);
  });

  it('6) nested delegation: root (0) -> child (1) -> grandchild (2) with maxConcurrentRunning: 1 does not deadlock', async () => {
    const { runtime, adapter } = createFakeProviderRuntime('codex');

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
      limits: { maxDepth: 2, maxConcurrentRunning: 1, maxTotalSpawns: 10 },
      mcpUrlForToken: (token) => `http://127.0.0.1:9999/mcp/${token}`,
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-nested',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    let childAgentId = '';
    let grandchildSession: FakeAgentSession | undefined;

    // Simulate child agent execution
    adapter.onSendBehavior = (session) => {
      // Find out if this is child or grandchild
      if (!childAgentId) {
        // This is child
        session.events.emit({
          type: 'session.init',
          sessionId: 'child-sess',
          model: 'gpt-4o',
          cwd: workspaceDir,
          permissionMode: 'plan',
          tools: [],
          slashCommands: [],
          skills: [],
          agents: [],
          apiKeySource: 'none',
          engineVersion: '1.0',
        });
      } else {
        // This is grandchild
        grandchildSession = session;
        session.events.emit({
          type: 'session.init',
          sessionId: 'grandchild-sess',
          model: 'gpt-4o',
          cwd: workspaceDir,
          permissionMode: 'plan',
          tools: [],
          slashCommands: [],
          skills: [],
          agents: [],
          apiKeySource: 'none',
          engineVersion: '1.0',
        });
      }
    };

    const childSpawn = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'I am child agent',
    });
    childAgentId = childSpawn.agent_id;

    // Find the binding generated for the child
    const childTree = store.getTree(root.rootTreeId);
    expect(childTree?.nodes[childAgentId]?.depth).toBe(1);

    // Retrieve child binding token
    let childToken = '';
    const internalBindings = (manager as unknown as { bindings: Map<string, SessionBinding> }).bindings;
    for (const [t, b] of internalBindings.entries()) {
      if (b.agentId === childAgentId) {
        childToken = t;
        break;
      }
    }
    expect(childToken).toBeTruthy();

    // Now child enters agent_wait (or spawns grandchild while running)
    // Because child is ancestor of grandchild, active concurrency check allows it even with maxConcurrentRunning = 1!
    const grandchildSpawn = await manager.spawn(childToken, {
      provider: 'codex',
      task: 'I am grandchild agent',
    });
    const grandchildAgentId = grandchildSpawn.agent_id;
    expect(grandchildAgentId).toBeDefined();

    // Grandchild has depth 2
    expect(store.getTree(root.rootTreeId)?.nodes[grandchildAgentId]?.depth).toBe(2);

    // Retrieve grandchild binding token
    let grandchildToken = '';
    for (const [t, b] of internalBindings.entries()) {
      if (b.agentId === grandchildAgentId) {
        grandchildToken = t;
        break;
      }
    }

    // Grandchild cannot delegate further (depth 2 + 1 > maxDepth 2) -> MAX_DEPTH_EXCEEDED
    if (grandchildToken) {
      await expect(
        manager.spawn(grandchildToken, {
          provider: 'codex',
          task: 'Great-grandchild spawn attempt',
        }),
      ).rejects.toThrowError(ChildAgentError);
    }

    // Complete grandchild
    grandchildSession?.events.emit({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 10,
      apiDurationMs: 10,
      numTurns: 1,
      totalCostUsd: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      permissionDenials: [],
      text: 'Grandchild done',
    });

    const waitGc = await manager.wait(childToken, { agent_id: grandchildAgentId });
    expect(waitGc.agents[0]?.status).toBe('completed');
  });

  it('7) enforces maxConcurrentRunning and maxTotalSpawns on horizontal fan-out', async () => {
    const { runtime } = createFakeProviderRuntime('codex');
    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
      limits: { maxDepth: 2, maxConcurrentRunning: 2, maxTotalSpawns: 3 },
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-limits',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    // Spawn 1 & 2 (occupies 2 running slots)
    await manager.spawn(root.token, { provider: 'codex', task: 'worker 1' });
    await manager.spawn(root.token, { provider: 'codex', task: 'worker 2' });

    // Spawn 3 -> MAX_CONCURRENT_EXCEEDED
    await expect(
      manager.spawn(root.token, { provider: 'codex', task: 'worker 3' }),
    ).rejects.toThrowError(ChildAgentError);
  });

  it('8) permissions & policies: escalation denial, engine capability check, permission interception', async () => {
    const { runtime } = createFakeProviderRuntime('codex', {
      supportedAccess: ['read_only', 'workspace_write'],
      supportsFineGrainedWritePaths: false,
    });

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    // Root with read_only
    const rootReadOnly = manager.createRootBinding({
      rootTreeId: 'tree-ro',
      cwd: workspaceDir,
      maxAccess: 'read_only',
    });

    // Escalation: requesting workspace_write from read_only parent -> POLICY_ESCALATION_DENIED
    await expect(
      manager.spawn(rootReadOnly.token, {
        provider: 'codex',
        task: 'write attempt',
        policy: { access: 'workspace_write' },
      }),
    ).rejects.toThrowError(ChildAgentError);

    // Root with workspace_write
    const rootWrite = manager.createRootBinding({
      rootTreeId: 'tree-rw',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    // Narrow writePaths on engine without supportsFineGrainedWritePaths in shared workspace -> POLICY_UNSUPPORTED_BY_ENGINE
    await expect(
      manager.spawn(rootWrite.token, {
        provider: 'codex',
        task: 'narrow write attempt',
        policy: {
          access: 'workspace_write',
          isolation: 'shared',
          writePaths: ['fileA.ts'],
        },
      }),
    ).rejects.toThrowError(ChildAgentError);

    // fork_turns: "all" is rejected
    await expect(
      manager.spawn(rootWrite.token, {
        provider: 'codex',
        task: 'fork attempt',
        fork_turns: 'all',
      }),
    ).rejects.toThrowError(ChildAgentError);
  });

  it('9) write ownership registry: conflicts in shared workspace vs disjoint writePaths or worktree', async () => {
    const { runtime } = createFakeProviderRuntime('codex', {
      supportsFineGrainedWritePaths: true,
    });

    let worktreeCreated = false;
    const fakeWorktreeManager: WorktreeManager = {
      create: async (_cwd, id) => {
        void id;
        worktreeCreated = true;
        writeFileSync(join(tmpDir, 'dummy.txt'), 'wt');
        return {
          worktreePath: workspaceDir,
          cleanup: async () => {},
        };
      },
    };

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
      worktreeManager: fakeWorktreeManager,
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-own',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    // Writer 1 writes to fileA.ts
    const w1 = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'writer 1',
      policy: { access: 'workspace_write', writePaths: ['fileA.ts'] },
    });

    // Writer 2 writes to disjoint fileB.ts -> succeeds!
    const w2 = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'writer 2',
      policy: { access: 'workspace_write', writePaths: ['fileB.ts'] },
    });

    expect(w1.agent_id).toBeDefined();
    expect(w2.agent_id).toBeDefined();

    // Writer 3 writes to fileA.ts -> WRITE_OWNERSHIP_CONFLICT!
    await expect(
      manager.spawn(root.token, {
        provider: 'codex',
        task: 'writer 3 conflicting',
        policy: { access: 'workspace_write', writePaths: ['fileA.ts'] },
      }),
    ).rejects.toThrowError(ChildAgentError);

    // Writer 4 uses isolation: "worktree" -> succeeds without shared lock!
    const w4 = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'writer 4 worktree',
      policy: { access: 'workspace_write', isolation: 'worktree', writePaths: ['fileA.ts'] },
    });
    expect(w4.agent_id).toBeDefined();
    expect(worktreeCreated).toBe(true);
  });

  it('10) agent_stop: recursively stops parent and child; idempotent second stop', async () => {
    const { runtime } = createFakeProviderRuntime('codex');
    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-stop',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const spawn1 = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'parent task',
    });

    // Retrieve child token to spawn a grandchild
    let childToken = '';
    const internalBindings = (manager as unknown as { bindings: Map<string, SessionBinding> }).bindings;
    for (const [t, b] of internalBindings.entries()) {
      if (b.agentId === spawn1.agent_id) {
        childToken = t;
        break;
      }
    }

    const spawn2 = await manager.spawn(childToken, {
      provider: 'codex',
      task: 'child task',
    });

    // Stop parent -> both parent and child are stopped!
    const stopRes1 = await manager.stop(root.token, { agent_id: spawn1.agent_id });
    expect(stopRes1.already_terminal).toBe(false);
    expect(stopRes1.stopped_ids).toContain(spawn1.agent_id);
    expect(stopRes1.stopped_ids).toContain(spawn2.agent_id);

    // Second stop on already stopped agent -> safe and idempotent
    const stopRes2 = await manager.stop(root.token, { agent_id: spawn1.agent_id });
    expect(stopRes2.already_terminal).toBe(true);
    expect(stopRes2.stopped_ids).toHaveLength(0);
  });

  it('11) cross-session isolation: tree B cannot inspect or modify tree A agents', async () => {
    const { runtime } = createFakeProviderRuntime('codex');
    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const treeA = manager.createRootBinding({
      rootTreeId: 'tree-A',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const treeB = manager.createRootBinding({
      rootTreeId: 'tree-B',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const agentA = await manager.spawn(treeA.token, {
      provider: 'codex',
      task: 'task A',
    });

    // Tree B tries to status, wait, send or stop agent A -> FORBIDDEN_FOREIGN_TREE
    await expect(
      manager.status(treeB.token, { agent_id: agentA.agent_id }),
    ).rejects.toThrowError(ChildAgentError);

    await expect(
      manager.wait(treeB.token, { agent_id: agentA.agent_id }),
    ).rejects.toThrowError(ChildAgentError);

    await expect(
      manager.send(treeB.token, { agent_id: agentA.agent_id, message: 'hi' }),
    ).rejects.toThrowError(ChildAgentError);

    await expect(
      manager.stop(treeB.token, { agent_id: agentA.agent_id }),
    ).rejects.toThrowError(ChildAgentError);
  });

  it('12) crash & timeout handling: unexpected session.closed/error fails agent and wakes waiters', async () => {
    const { runtime, adapter } = createFakeProviderRuntime('codex');
    let sessionInstance: FakeAgentSession | undefined;

    adapter.onSendBehavior = (session) => {
      sessionInstance = session;
    };

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const root = manager.createRootBinding({
      rootTreeId: 'tree-crash',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const spawn = await manager.spawn(root.token, {
      provider: 'codex',
      task: 'crash test',
    });

    // Start wait in background
    const waitPromise = manager.wait(root.token, { agent_id: spawn.agent_id, timeout_ms: 5000 });

    // Crash the session
    sessionInstance?.events.emit({
      type: 'session.closed',
      reason: 'error',
      message: 'Subprocess crashed with SIGKILL',
    });

    const waitRes = await waitPromise;
    expect(waitRes.timed_out).toBe(false);
    expect(waitRes.agents[0]?.status).toBe('failed');
    expect(waitRes.agents[0]?.error).toContain('Subprocess crashed');
  });

  it('13) persistence and host restart: restores running as unknown_after_restart without relaunching', async () => {
    const { runtime, adapter } = createFakeProviderRuntime('codex');

    let createSessionCalls = 0;
    adapter.createSessionHook = () => {
      createSessionCalls++;
      const s = new FakeAgentSession(`sess-${createSessionCalls}`);
      return s;
    };

    const store = new ChildAgentStore(storeDir);
    const manager1 = new ChildSessionManager({
      store,
      providers: [runtime],
    });

    const root = manager1.createRootBinding({
      rootTreeId: 'tree-persist',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const spawn = await manager1.spawn(root.token, {
      provider: 'codex',
      task: 'Task that was running when power was cut',
    });

    expect(createSessionCalls).toBe(1);

    // Simulate complete host restart: new manager with same store directory
    const store2 = new ChildAgentStore(storeDir);
    const manager2 = new ChildSessionManager({
      store: store2,
      providers: [runtime],
    });

    // No extra createSession calls should have occurred!
    expect(createSessionCalls).toBe(1);

    const reloadedTree = store2.getTree('tree-persist');
    expect(reloadedTree).toBeDefined();

    const node = reloadedTree?.nodes[spawn.agent_id];
    expect(node?.status).toBe('unknown_after_restart');
    expect(node?.error).toContain('Host restarted while child agent was running');

    const transcript = manager2.renderTranscript('tree-persist', spawn.agent_id);
    expect(transcript).toContain('# Child Agent Transcript');
    expect(transcript).toContain('unknown_after_restart');

    const events = manager2.restoredEvents('tree-persist');
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      events.some(
        (e) => e.type === 'agent.end' && (e as Extract<AgentEvent, { type: 'agent.end' }>).status === 'failed',
      ),
    ).toBe(true);

    // Foreign root without live binding for tree-persist still gets FORBIDDEN_FOREIGN_TREE on persisted agentId
    const foreignRoot = manager2.createRootBinding({
      rootTreeId: 'tree-foreign-after-restart',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });
    await expect(
      manager2.status(foreignRoot.token, { agent_id: spawn.agent_id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_FOREIGN_TREE' });
  });

  it('14) completed node preserves status on stop/disposeTree and agent_send supports idempotency_key', async () => {
    const { runtime, adapter } = createFakeProviderRuntime('codex');
    let sendCount = 0;
    adapter.onSendBehavior = (sess) => {
      sendCount++;
      sess.events.emit({
        type: 'session.init',
        sessionId: 'sess-completed-preserve',
        model: 'gpt-4o',
        cwd: workspaceDir,
        permissionMode: 'default',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1.0',
      });
      sess.events.emit({
        type: 'turn.result',
        ok: true,
        subtype: 'success',
        interrupted: false,
        durationMs: 10,
        apiDurationMs: 10,
        numTurns: 1,
        totalCostUsd: 0,
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
        permissionDenials: [],
        text: `Output #${sendCount}`,
      });
    };

    const store = new ChildAgentStore(storeDir);
    const manager = new ChildSessionManager({ store, providers: [runtime] });
    const root = manager.createRootBinding({
      rootTreeId: 'tree-preserve-send-idem',
      cwd: workspaceDir,
      maxAccess: 'workspace_write',
    });

    const spawned = await manager.spawn(root.token, { provider: 'codex', task: 'initial' });
    await manager.wait(root.token, { agent_id: spawned.agent_id });

    // agent_send with idempotency_key
    const s1 = await manager.send(root.token, {
      agent_id: spawned.agent_id,
      message: 'followup',
      idempotency_key: 'send-key-1',
    });
    const s2 = await manager.send(root.token, {
      agent_id: spawned.agent_id,
      message: 'followup',
      idempotency_key: 'send-key-1',
    });
    expect(s1.turn_count).toBe(2);
    expect(s2.turn_count).toBe(2);
    expect(sendCount).toBe(2); // did not re-send!

    await expect(
      manager.send(root.token, {
        agent_id: spawned.agent_id,
        message: 'different-followup',
        idempotency_key: 'send-key-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // stop & disposeTree on completed node closes active session without clobbering status/summary
    const stopRes = await manager.stop(root.token, { agent_id: spawned.agent_id });
    expect(stopRes).toEqual({ stopped_ids: [], already_terminal: true });

    const viewBeforeDispose = (await manager.status(root.token, { agent_id: spawned.agent_id })) as ChildStatusView;
    expect(viewBeforeDispose.status).toBe('completed');
    expect(viewBeforeDispose.summary).toBe('Output #2');

    await manager.disposeTree('tree-preserve-send-idem');
    const savedNode = store.getTree('tree-preserve-send-idem')?.nodes[spawned.agent_id];
    expect(savedNode?.status).toBe('completed');
    expect(savedNode?.summary).toBe('Output #2');
    expect(adapter.sessions[0]?.isDisposed).toBe(true);
  });
});
