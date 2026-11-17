import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSession, EffortLevel } from '../types';
import {
  buildExplicitChildPrompt,
  GitWorktreeManager,
  type WorktreeManager,
  WriteOwnershipRegistry,
} from './ownership';
import {
  buildChildSessionOptions,
  decideChildPermission,
  validateChildPolicy,
} from './policy';
import { ChildAgentStore } from './store';
import {
  CHILD_MCP_SERVER,
  ChildAgentError,
  DEFAULT_TREE_LIMITS,
  type AgentSendArgs,
  type AgentSendResult,
  type AgentSpawnArgs,
  type AgentSpawnResult,
  type AgentStopArgs,
  type AgentStopResult,
  type AgentsCatalogResult,
  type AgentWaitArgs,
  type AgentWaitResult,
  type ChildAccessMode,
  type ChildPolicy,
  type ChildStatus,
  type ChildStatusView,
  type HostMcpServerConfig,
  type ProviderInspectResult,
  type ProviderRuntime,
  type SessionBinding,
  type StoredChildNode,
  type StoredTranscriptStep,
  type TreeLimits,
  type TreeLimitsRemaining,
} from './types';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isTerminalStatus(status: ChildStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'idle' ||
    status === 'unknown_after_restart'
  );
}

interface ActiveSessionEntry {
  session: AgentSession;
  cleanupWorktree?: () => Promise<void>;
  currentPrompt: string;
  textDelta: string;
  steps: StoredTranscriptStep[];
  turnNo: number;
  toolUses: number;
  tokens: number;
}

export interface ChildSessionManagerOptions {
  providers?: ProviderRuntime[];
  store?: ChildAgentStore;
  limits?: TreeLimits;
  catalogCacheTtlMs?: number;
  spawnTimeoutMs?: number;
  ownershipRegistry?: WriteOwnershipRegistry;
  worktreeManager?: WorktreeManager;
  mcpUrlForToken?: (token: string) => string;
  onTreeEvent?: (rootTreeId: string, event: AgentEvent) => void;
}

export class ChildSessionManager {
  private readonly providers = new Map<string, ProviderRuntime>();
  private readonly store: ChildAgentStore;
  private readonly limits: TreeLimits;
  private readonly catalogCacheTtlMs: number;
  private readonly spawnTimeoutMs: number;
  private readonly ownershipRegistry: WriteOwnershipRegistry;
  private readonly worktreeManager: WorktreeManager;
  private readonly mcpUrlForToken?: (token: string) => string;
  private mcpUrlProvider?: (token: string) => string;
  private readonly onTreeEvent?: (rootTreeId: string, event: AgentEvent) => void;

  private readonly bindings = new Map<string, SessionBinding>();
  private readonly bindingsById = new Map<string, SessionBinding>();
  private readonly activeSessions = new Map<string, ActiveSessionEntry>();
  private readonly waitingCallers = new Set<string>();
  private readonly waitResolvers = new Map<string, Set<() => void>>();
  private readonly inspectCache = new Map<string, { result: ProviderInspectResult; timestamp: number }>();
  private readonly treeListeners = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(options: ChildSessionManagerOptions = {}) {
    this.store = options.store ?? new ChildAgentStore();
    this.limits = options.limits ?? DEFAULT_TREE_LIMITS;
    this.catalogCacheTtlMs = options.catalogCacheTtlMs ?? 15_000;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 30_000;
    this.ownershipRegistry = options.ownershipRegistry ?? new WriteOwnershipRegistry();
    this.worktreeManager = options.worktreeManager ?? new GitWorktreeManager();
    this.mcpUrlForToken = options.mcpUrlForToken;
    this.onTreeEvent = options.onTreeEvent;

    if (options.providers) {
      for (const p of options.providers) {
        this.providers.set(p.provider, p);
      }
    }

    this.store.loadAll();
  }

  setMcpUrlProvider(fn: (token: string) => string): void {
    if (!this.mcpUrlForToken) this.mcpUrlProvider = fn;
  }

  private resolveMcpUrl(token: string): string | undefined {
    return this.mcpUrlForToken?.(token) ?? this.mcpUrlProvider?.(token);
  }

  registerProvider(runtime: ProviderRuntime): void {
    this.providers.set(runtime.provider, runtime);
  }

  getBinding(token: string): SessionBinding | undefined {
    return this.bindings.get(token);
  }

  createRootBinding(params: {
    rootTreeId: string;
    cwd: string;
    maxAccess: ChildAccessMode;
    allowBypassPermissions?: boolean;
  }): SessionBinding {
    const token = randomBytes(32).toString('hex');
    const bindingId = randomUUID();
    const binding: SessionBinding = {
      token,
      bindingId,
      rootTreeId: params.rootTreeId,
      agentId: null,
      depth: 0,
      cwd: params.cwd,
      maxAccess: params.maxAccess,
      allowBypassPermissions: params.allowBypassPermissions,
    };

    this.bindings.set(token, binding);
    this.bindingsById.set(bindingId, binding);

    let tree = this.store.getTree(params.rootTreeId);
    if (!tree) {
      const now = Date.now();
      tree = {
        rootTreeId: params.rootTreeId,
        createdAt: now,
        updatedAt: now,
        rootCwd: params.cwd,
        totalSpawns: 0,
        nodes: {},
      };
      this.store.saveTree(tree);
    }

    return binding;
  }

  updateRootBinding(
    token: string,
    updates: {
      maxAccess?: ChildAccessMode;
      cwd?: string;
      allowBypassPermissions?: boolean;
    },
  ): void {
    const binding = this.bindings.get(token);
    if (!binding || binding.agentId !== null) {
      throw new ChildAgentError('AUTH_REQUIRED', 'Only root binding can be updated');
    }
    if (updates.maxAccess !== undefined) binding.maxAccess = updates.maxAccess;
    if (updates.cwd !== undefined) binding.cwd = updates.cwd;
    if (updates.allowBypassPermissions !== undefined) {
      binding.allowBypassPermissions = updates.allowBypassPermissions;
    }
  }

  private requireBinding(token: string): SessionBinding {
    const binding = this.bindings.get(token);
    if (!binding) {
      throw new ChildAgentError('AUTH_REQUIRED', 'Invalid or expired binding token');
    }
    return binding;
  }

  private emitTreeEvent(rootTreeId: string, event: AgentEvent): void {
    try {
      this.onTreeEvent?.(rootTreeId, event);
    } catch {
      // Listener errors must not crash manager
    }
    const listeners = this.treeListeners.get(rootTreeId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Listener errors must not crash manager
        }
      }
    }
  }

  subscribeTree(rootTreeId: string, listener: (event: AgentEvent) => void): () => void {
    let set = this.treeListeners.get(rootTreeId);
    if (!set) {
      set = new Set();
      this.treeListeners.set(rootTreeId, set);
    }
    set.add(listener);
    return () => {
      const curr = this.treeListeners.get(rootTreeId);
      if (!curr) return;
      curr.delete(listener);
      if (curr.size === 0) this.treeListeners.delete(rootTreeId);
    };
  }

  linkSessionToTree(provider: string, sessionId: string, rootTreeId: string): void {
    this.store.linkSessionToTree(provider, sessionId, rootTreeId);
  }

  findTreeIdBySession(provider: string, sessionId: string): string | undefined {
    return this.store.findTreeIdBySession(provider, sessionId);
  }

  private async getOrInspect(provider: string, cwd: string): Promise<ProviderInspectResult> {
    const runtime = this.providers.get(provider);
    if (!runtime) {
      throw new ChildAgentError('UNKNOWN_PROVIDER', `Unknown provider: ${provider}`);
    }

    const cacheKey = `${provider}:${cwd}`;
    const cached = this.inspectCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.catalogCacheTtlMs) {
      return cached.result;
    }

    const result = await runtime.inspect(cwd);
    this.inspectCache.set(cacheKey, { result, timestamp: now });
    return result;
  }

  private findNodeAndVerifyAccess(caller: SessionBinding, targetAgentId: string): StoredChildNode {
    const tree = this.store.getTree(caller.rootTreeId);
    const node = tree?.nodes[targetAgentId];

    if (!node) {
      const foreignTreeId = this.store.findTreeIdByAgent(targetAgentId);
      if (foreignTreeId && foreignTreeId !== caller.rootTreeId) {
        throw new ChildAgentError(
          'FORBIDDEN_FOREIGN_TREE',
          `Agent "${targetAgentId}" belongs to another tree`,
        );
      }
      throw new ChildAgentError('AGENT_NOT_FOUND', `Agent "${targetAgentId}" not found`);
    }

    // If caller is child agent, it may only access itself or its descendants
    if (caller.agentId !== null) {
      if (caller.agentId !== targetAgentId) {
        let isDescendant = false;
        let curr: string | null = node.parentId;
        while (curr) {
          if (curr === caller.agentId) {
            isDescendant = true;
            break;
          }
          curr = tree?.nodes[curr]?.parentId ?? null;
        }
        if (!isDescendant) {
          throw new ChildAgentError(
            'FORBIDDEN_FOREIGN_TREE',
            `Agent "${targetAgentId}" is outside caller subtree`,
          );
        }
      }
    }

    return node;
  }

  private toStatusView(node: StoredChildNode): ChildStatusView {
    return {
      agent_id: node.agentId,
      parent_id: node.parentId,
      root_id: node.rootTreeId,
      depth: node.depth,
      provider: node.provider,
      provider_session_id: node.providerSessionId,
      requested_model: node.requestedModel,
      effective_model: node.effectiveModel,
      reasoning_effort: node.reasoningEffort,
      status: node.status,
      policy: node.policy,
      prompt: node.prompt,
      summary: node.summary,
      error: node.error,
      last_tool: node.lastTool,
      started_at: node.startedAt,
      ended_at: node.endedAt,
      turn_count: node.turnNo,
      tool_uses: node.toolUses,
      total_tokens: node.tokens,
    };
  }

  private wakeWaiters(agentId: string): void {
    const waiters = this.waitResolvers.get(agentId);
    if (waiters) {
      for (const wake of waiters) {
        wake();
      }
      this.waitResolvers.delete(agentId);
    }
  }

  // --- 1. agents_catalog ---
  async catalog(bindingToken: string): Promise<AgentsCatalogResult> {
    const caller = this.requireBinding(bindingToken);
    const providersList: AgentsCatalogResult['providers'] = [];

    for (const [provider, runtime] of this.providers.entries()) {
      try {
        const inspectResult = await this.getOrInspect(provider, caller.cwd);
        providersList.push({
          provider,
          label: runtime.label,
          status: inspectResult.status,
          models: inspectResult.models,
          defaultModel: inspectResult.defaultModel,
          reason: inspectResult.reason,
          supportedAccess: inspectResult.supportedAccess,
          supportsFineGrainedWritePaths: inspectResult.supportsFineGrainedWritePaths,
          canDelegateViaMcp: inspectResult.canDelegateViaMcp,
        });
      } catch (err) {
        providersList.push({
          provider,
          label: runtime.label,
          status: 'unavailable',
          models: [],
          reason: String(err),
          supportedAccess: ['read_only'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: false,
        });
      }
    }

    const tree = this.store.getTree(caller.rootTreeId);
    let activeRunning = 0;
    if (tree) {
      for (const node of Object.values(tree.nodes)) {
        if (node.status === 'starting' || node.status === 'running') {
          activeRunning++;
        }
      }
    }

    const limits: TreeLimitsRemaining = {
      depth: caller.depth,
      maxDepth: this.limits.maxDepth,
      activeRunning,
      maxConcurrentRunning: this.limits.maxConcurrentRunning,
      totalSpawns: tree?.totalSpawns ?? 0,
      maxTotalSpawns: this.limits.maxTotalSpawns,
    };

    return { providers: providersList, limits };
  }

  // --- 2. agent_spawn ---
  async spawn(bindingToken: string, args: AgentSpawnArgs): Promise<AgentSpawnResult> {
    const caller = this.requireBinding(bindingToken);

    if (args.fork_turns !== undefined && args.fork_turns !== 'none') {
      throw new ChildAgentError(
        'FORK_TURNS_UNSUPPORTED',
        'fork_turns="all" is not supported for cross-provider child agents',
      );
    }

    let tree = this.store.getTree(caller.rootTreeId);
    if (!tree) {
      const now = Date.now();
      tree = {
        rootTreeId: caller.rootTreeId,
        createdAt: now,
        updatedAt: now,
        rootCwd: caller.cwd,
        totalSpawns: 0,
        nodes: {},
      };
      this.store.saveTree(tree);
    }

    // Idempotency check
    const fingerprint = sha256(
      JSON.stringify([
        args.provider,
        args.task,
        args.model ?? null,
        args.reasoning_effort ?? null,
        args.context ?? null,
        args.policy ?? null,
        args.title ?? null,
      ]),
    );

    if (args.idempotency_key) {
      const existing = Object.values(tree.nodes).find(
        (n) => n.callerBindingId === caller.bindingId && n.idempotencyKey === args.idempotency_key,
      );
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          return {
            agent_id: existing.agentId,
            status: existing.status,
            provider: existing.provider,
            requested_model: existing.requestedModel,
            effective_model: existing.effectiveModel,
            parent_id: existing.parentId,
            root_id: existing.rootTreeId,
            depth: existing.depth,
            policy: existing.policy,
          };
        }
        throw new ChildAgentError(
          'IDEMPOTENCY_CONFLICT',
          `Conflicting parameters for existing idempotency key "${args.idempotency_key}"`,
          { idempotencyKey: args.idempotency_key },
        );
      }
    }

    const childDepth = caller.depth + 1;
    if (childDepth > this.limits.maxDepth) {
      throw new ChildAgentError(
        'MAX_DEPTH_EXCEEDED',
        `Max depth limit (${this.limits.maxDepth}) exceeded (requested depth: ${childDepth})`,
      );
    }

    if (tree.totalSpawns >= this.limits.maxTotalSpawns) {
      throw new ChildAgentError(
        'MAX_SPAWNS_EXCEEDED',
        `Max total spawns limit (${this.limits.maxTotalSpawns}) reached for this tree`,
      );
    }

    // Check concurrency: ancestors of new child and nodes in agent_wait DO NOT consume a parallel slot
    const ancestorsOfNewChild = new Set<string>();
    let currParent = caller.agentId;
    while (currParent) {
      ancestorsOfNewChild.add(currParent);
      currParent = tree.nodes[currParent]?.parentId ?? null;
    }

    let activeParallel = 0;
    for (const node of Object.values(tree.nodes)) {
      if (
        (node.status === 'starting' || node.status === 'running') &&
        !this.waitingCallers.has(node.agentId) &&
        !ancestorsOfNewChild.has(node.agentId)
      ) {
        activeParallel++;
      }
    }

    if (activeParallel >= this.limits.maxConcurrentRunning) {
      throw new ChildAgentError(
        'MAX_CONCURRENT_EXCEEDED',
        `Max concurrent running agents limit (${this.limits.maxConcurrentRunning}) reached`,
      );
    }

    const providerRuntime = this.providers.get(args.provider);
    if (!providerRuntime) {
      throw new ChildAgentError('UNKNOWN_PROVIDER', `Unknown provider: ${args.provider}`);
    }

    const inspectResult = await this.getOrInspect(args.provider, caller.cwd);
    if (inspectResult.status === 'unavailable') {
      throw new ChildAgentError(
        'PROVIDER_UNAVAILABLE',
        inspectResult.reason || `Provider ${args.provider} is unavailable`,
      );
    }
    if (inspectResult.status === 'needs_auth') {
      throw new ChildAgentError(
        'AUTH_REQUIRED',
        inspectResult.reason || `Provider ${args.provider} requires authentication`,
      );
    }
    if (inspectResult.status === 'unsupported') {
      throw new ChildAgentError(
        'PROVIDER_UNAVAILABLE',
        inspectResult.reason || `Provider ${args.provider} is unsupported`,
      );
    }

    let requestedModel: string | null = null;
    if (args.model !== undefined && args.model !== null && args.model !== '') {
      const match = inspectResult.models.find((m) => m.value === args.model);
      if (!match) {
        const available = inspectResult.models.map((m) => m.value);
        throw new ChildAgentError(
          'UNKNOWN_MODEL',
          `Unknown model "${args.model}" for provider "${args.provider}". Available models: ${available.join(', ')}`,
          { availableModels: available },
        );
      }
      requestedModel = match.value;
    }

    let reasoningEffort: string | null = null;
    if (args.reasoning_effort !== undefined && args.reasoning_effort !== null && args.reasoning_effort !== '') {
      const targetModel = requestedModel || inspectResult.defaultModel;
      const modelOpt = inspectResult.models.find((m) => m.value === targetModel);
      if (!modelOpt?.supportsEffort || !modelOpt.effortLevels?.includes(args.reasoning_effort as EffortLevel)) {
        throw new ChildAgentError(
          'UNSUPPORTED_EFFORT',
          `Reasoning effort "${args.reasoning_effort}" is unsupported for model "${targetModel}"`,
        );
      }
      reasoningEffort = String(args.reasoning_effort);
    }

    const policy: ChildPolicy = {
      access: args.policy?.access ?? 'read_only',
      isolation: args.policy?.isolation ?? 'shared',
      writePaths: args.policy?.writePaths,
      allowDelegate: args.policy?.allowDelegate,
    };

    validateChildPolicy(policy, caller.maxAccess, caller.allowBypassPermissions, inspectResult);

    const childAgentId = `child_${randomUUID()}`;
    let childCwd = caller.cwd;
    let cleanupWorktree: (() => Promise<void>) | undefined;
    let isolationDir: string | undefined;

    if (policy.isolation === 'worktree') {
      const wt = await this.worktreeManager.create(caller.cwd, childAgentId);
      childCwd = wt.worktreePath;
      cleanupWorktree = wt.cleanup;
      isolationDir = wt.worktreePath;
    } else if (policy.access === 'workspace_write' || policy.access === 'full_access') {
      this.ownershipRegistry.acquire(childAgentId, childCwd, policy.writePaths);
    }

    let fullPrompt: string;
    try {
      fullPrompt = await buildExplicitChildPrompt(childCwd, args.task, args.context);
    } catch (err) {
      if (policy.isolation === 'worktree') {
        await cleanupWorktree?.();
      } else {
        this.ownershipRegistry.release(childAgentId);
      }
      throw err;
    }

    let hostMcpServers: HostMcpServerConfig[] | undefined;
    let childToken: string | undefined;
    if (policy.allowDelegate !== false && childDepth < this.limits.maxDepth) {
      childToken = randomBytes(32).toString('hex');
      const childBinding: SessionBinding = {
        token: childToken,
        bindingId: randomUUID(),
        rootTreeId: caller.rootTreeId,
        agentId: childAgentId,
        depth: childDepth,
        cwd: childCwd,
        maxAccess: policy.access,
        allowBypassPermissions: caller.allowBypassPermissions,
      };
      this.bindings.set(childToken, childBinding);
      this.bindingsById.set(childBinding.bindingId, childBinding);

      const mcpUrl = this.resolveMcpUrl(childToken);
      if (mcpUrl) {
        hostMcpServers = [
          {
            name: CHILD_MCP_SERVER,
            url: mcpUrl,
            builtin: true,
          },
        ];
      }
    }

    const firstLine = args.task.trim().split('\n')[0] ?? '';
    const nodeTitle = args.title?.trim() || firstLine.slice(0, 80) || 'Task';

    const now = Date.now();
    const storedNode: StoredChildNode = {
      agentId: childAgentId,
      parentId: caller.agentId,
      rootTreeId: caller.rootTreeId,
      depth: childDepth,
      title: nodeTitle,
      provider: args.provider,
      requestedModel,
      effectiveModel: null,
      reasoningEffort,
      prompt: fullPrompt,
      context: args.context,
      policy,
      status: 'starting',
      childToken,
      startedAt: now,
      turnNo: 1,
      toolUses: 0,
      tokens: 0,
      idempotencyKey: args.idempotency_key,
      callerBindingId: caller.bindingId,
      requestFingerprint: fingerprint,
      isolationDir,
    };

    tree.totalSpawns++;
    this.store.saveNode(caller.rootTreeId, storedNode);

    this.emitTreeEvent(caller.rootTreeId, {
      type: 'agent.start',
      agentId: childAgentId,
      taskId: childAgentId,
      description: nodeTitle,
      taskType: 'managed_agent',
      subagentType: args.provider,
      background: true,
      prompt: fullPrompt,
      model: requestedModel ?? undefined,
      provider: args.provider,
      requestedModel,
      reasoningEffort: reasoningEffort ?? undefined,
      parentAgentId: caller.agentId ?? undefined,
      at: now,
    });

    const sessionModel =
      requestedModel ??
      (args.provider === 'antigravity' ? inspectResult.defaultModel : null);
    const sessionOptions = buildChildSessionOptions(
      args.provider,
      policy,
      childCwd,
      sessionModel,
      reasoningEffort,
      hostMcpServers,
    );

    let session: AgentSession;
    try {
      const adapter = providerRuntime.adapter();
      session = await Promise.race([
        adapter.createSession(sessionOptions),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`createSession timed out after ${this.spawnTimeoutMs}ms`)), this.spawnTimeoutMs),
        ),
      ]);
    } catch (err) {
      if (policy.isolation === 'worktree') {
        await cleanupWorktree?.();
      } else {
        this.ownershipRegistry.release(childAgentId);
      }
      storedNode.status = 'failed';
      storedNode.error = `Failed to create session: ${String(err)}`;
      storedNode.endedAt = Date.now();
      this.store.saveNode(caller.rootTreeId, storedNode);
      this.emitTreeEvent(caller.rootTreeId, {
        type: 'agent.end',
        agentId: childAgentId,
        taskId: childAgentId,
        status: 'failed',
        summary: storedNode.error,
        at: storedNode.endedAt,
      });
      this.wakeWaiters(childAgentId);
      throw new ChildAgentError('PROVIDER_UNAVAILABLE', storedNode.error);
    }

    const activeEntry: ActiveSessionEntry = {
      session,
      cleanupWorktree,
      currentPrompt: fullPrompt,
      textDelta: '',
      steps: [],
      turnNo: 1,
      toolUses: 0,
      tokens: 0,
    };
    this.activeSessions.set(childAgentId, activeEntry);

    storedNode.status = 'running';
    this.store.saveNode(caller.rootTreeId, storedNode);

    this.attachSessionListeners(caller.rootTreeId, childAgentId, session, policy, childCwd, activeEntry);

    // Send the first prompt non-blockingly
    session.send(fullPrompt);

    return {
      agent_id: childAgentId,
      status: 'running',
      provider: args.provider,
      requested_model: requestedModel,
      effective_model: storedNode.effectiveModel,
      parent_id: caller.agentId,
      root_id: caller.rootTreeId,
      depth: childDepth,
      policy,
    };
  }

  private attachSessionListeners(
    rootTreeId: string,
    childAgentId: string,
    session: AgentSession,
    policy: ChildPolicy,
    childCwd: string,
    activeEntry: ActiveSessionEntry,
  ): void {
    session.events.on((event) => {
      const tree = this.store.getTree(rootTreeId);
      const node = tree?.nodes[childAgentId];
      if (!node) return;

      switch (event.type) {
        case 'session.init': {
          node.providerSessionId = event.sessionId;
          node.effectiveModel = event.model;
          this.store.saveNode(rootTreeId, node);
          this.emitTreeEvent(rootTreeId, {
            type: 'agent.start',
            agentId: childAgentId,
            taskId: childAgentId,
            description: node.title,
            taskType: 'managed_agent',
            subagentType: node.provider,
            background: true,
            prompt: node.prompt,
            model: event.model,
            provider: node.provider,
            requestedModel: node.requestedModel,
            reasoningEffort: node.reasoningEffort ?? undefined,
            parentAgentId: node.parentId ?? undefined,
          });
          break;
        }

        case 'text.delta': {
          activeEntry.textDelta += event.text;
          this.emitTreeEvent(rootTreeId, { ...event, agentId: childAgentId });
          break;
        }

        case 'tool.start': {
          activeEntry.toolUses++;
          node.toolUses = activeEntry.toolUses;
          node.lastTool = event.name;
          this.store.saveNode(rootTreeId, node);
          this.emitTreeEvent(rootTreeId, { ...event, agentId: childAgentId });
          break;
        }

        case 'tool.result':
        case 'thinking.start':
        case 'thinking.delta':
        case 'thinking.stop':
        case 'agent.progress': {
          this.emitTreeEvent(rootTreeId, { ...event, agentId: childAgentId });
          break;
        }

        case 'permission.request': {
          const decision = decideChildPermission(
            { toolName: event.toolName, title: event.title, input: event.input, blockedPath: event.blockedPath },
            policy,
            childCwd,
          );
          session.respondPermission(event.toolUseId, decision);
          break;
        }

        case 'question.request': {
          if (!session.respondPermission(event.toolUseId, 'deny')) {
            session.answerQuestion(event.toolUseId, {});
          }
          break;
        }

        case 'plan.request': {
          session.decidePlan(event.toolUseId, {
            approve: false,
            feedback: 'Interactive plan approval is unavailable in headless child session; return your result directly.',
            interrupt: false,
          });
          break;
        }

        case 'turn.result': {
          if (node.status === 'running' || node.status === 'starting') {
            const summary = event.text || activeEntry.textDelta;
            node.status = event.ok ? 'completed' : 'failed';
            node.summary = summary;
            node.endedAt = Date.now();
            if (event.usage) {
              activeEntry.tokens += event.usage.output + event.usage.input;
              node.tokens = activeEntry.tokens;
            }

            activeEntry.steps.push({
              turnNo: activeEntry.turnNo,
              prompt: activeEntry.currentPrompt,
              at: node.endedAt,
              text: summary,
              summary,
            });
            this.store.saveTranscript(rootTreeId, childAgentId, activeEntry.steps);
            this.store.saveNode(rootTreeId, node);

            this.ownershipRegistry.release(childAgentId);

            this.emitTreeEvent(rootTreeId, {
              type: 'agent.end',
              agentId: childAgentId,
              taskId: childAgentId,
              status: node.status,
              summary,
              totalTokens: node.tokens,
              toolUses: node.toolUses,
              at: node.endedAt,
            });

            this.wakeWaiters(childAgentId);
          }
          break;
        }

        case 'error': {
          if (event.fatal && (node.status === 'running' || node.status === 'starting')) {
            node.status = 'failed';
            node.error = event.message;
            node.endedAt = Date.now();
            this.store.saveNode(rootTreeId, node);
            this.ownershipRegistry.release(childAgentId);

            this.emitTreeEvent(rootTreeId, {
              type: 'agent.end',
              agentId: childAgentId,
              taskId: childAgentId,
              status: 'failed',
              summary: event.message,
              at: node.endedAt,
            });

            this.wakeWaiters(childAgentId);
          }
          break;
        }

        case 'session.closed': {
          if (event.reason !== 'disposed' && (node.status === 'running' || node.status === 'starting')) {
            node.status = 'failed';
            node.error = event.message || `Session closed with reason: ${event.reason}`;
            node.endedAt = Date.now();
            this.store.saveNode(rootTreeId, node);
            this.ownershipRegistry.release(childAgentId);

            this.emitTreeEvent(rootTreeId, {
              type: 'agent.end',
              agentId: childAgentId,
              taskId: childAgentId,
              status: 'failed',
              summary: node.error,
              at: node.endedAt,
            });

            this.wakeWaiters(childAgentId);
          }
          break;
        }
      }
    });
  }

  // --- 3. agent_status ---
  async status(bindingToken: string, args?: { agent_id?: string }): Promise<ChildStatusView | ChildStatusView[]> {
    const caller = this.requireBinding(bindingToken);

    if (args?.agent_id) {
      const node = this.findNodeAndVerifyAccess(caller, args.agent_id);
      return this.toStatusView(node);
    }

    const tree = this.store.getTree(caller.rootTreeId);
    if (!tree) return [];

    const result: ChildStatusView[] = [];
    for (const node of Object.values(tree.nodes)) {
      if (caller.agentId === null) {
        result.push(this.toStatusView(node));
      } else {
        // Child caller: only self and descendants
        if (node.agentId === caller.agentId) {
          result.push(this.toStatusView(node));
        } else {
          let curr: string | null = node.parentId;
          while (curr) {
            if (curr === caller.agentId) {
              result.push(this.toStatusView(node));
              break;
            }
            curr = tree.nodes[curr]?.parentId ?? null;
          }
        }
      }
    }

    return result;
  }

  // --- 4. agent_wait ---
  async wait(bindingToken: string, args: AgentWaitArgs): Promise<AgentWaitResult> {
    const caller = this.requireBinding(bindingToken);

    const targetIds = args.agent_ids && args.agent_ids.length > 0
      ? args.agent_ids
      : args.agent_id
        ? [args.agent_id]
        : [];

    if (targetIds.length === 0) {
      throw new ChildAgentError('INVALID_ARGUMENTS', 'At least one agent_id must be provided to agent_wait');
    }

    let timeoutMs = args.timeout_ms ?? 30_000;
    timeoutMs = Math.max(100, Math.min(120_000, timeoutMs));

    // Verify all targets and check for cycle/self wait
    for (const id of targetIds) {
      this.findNodeAndVerifyAccess(caller, id);
      if (id === caller.agentId) {
        throw new ChildAgentError('INVALID_ARGUMENTS', 'Cannot wait on self');
      }

      // Check if id is an ancestor of caller
      let curr = caller.agentId;
      const tree = this.store.getTree(caller.rootTreeId);
      while (curr) {
        if (curr === id) {
          throw new ChildAgentError('INVALID_ARGUMENTS', 'Cannot wait on ancestor (deadlock prevention)');
        }
        curr = tree?.nodes[curr]?.parentId ?? null;
      }
    }

    if (caller.agentId !== null) {
      this.waitingCallers.add(caller.agentId);
    }

    const checkFinished = (): boolean => {
      const tree = this.store.getTree(caller.rootTreeId);
      if (!tree) return true;
      return targetIds.every((id) => {
        const node = tree.nodes[id];
        return !node || isTerminalStatus(node.status);
      });
    };

    try {
      if (!checkFinished()) {
        await new Promise<void>((resolve) => {
          const onWake = () => {
            if (checkFinished()) {
              clearTimeout(timer);
              cleanupWaiters();
              resolve();
            }
          };

          const cleanupWaiters = () => {
            for (const id of targetIds) {
              const set = this.waitResolvers.get(id);
              if (set) {
                set.delete(onWake);
                if (set.size === 0) this.waitResolvers.delete(id);
              }
            }
          };

          const timer = setTimeout(() => {
            cleanupWaiters();
            resolve();
          }, timeoutMs);

          for (const id of targetIds) {
            let set = this.waitResolvers.get(id);
            if (!set) {
              set = new Set();
              this.waitResolvers.set(id, set);
            }
            set.add(onWake);
          }
        });
      }
    } finally {
      if (caller.agentId !== null) {
        this.waitingCallers.delete(caller.agentId);
      }
    }

    const tree = this.store.getTree(caller.rootTreeId);
    const views: ChildStatusView[] = targetIds.map((id) => {
      const node = tree?.nodes[id];
      if (!node) {
        throw new ChildAgentError('AGENT_NOT_FOUND', `Agent "${id}" not found`);
      }
      return this.toStatusView(node);
    });

    const timedOut = !views.every((v) => isTerminalStatus(v.status));
    return {
      timed_out: timedOut,
      agents: views,
    };
  }

  // --- 5. agent_send ---
  async send(bindingToken: string, args: AgentSendArgs): Promise<AgentSendResult> {
    const caller = this.requireBinding(bindingToken);
    const node = this.findNodeAndVerifyAccess(caller, args.agent_id);

    // Only ancestor or root can send
    if (caller.agentId !== null) {
      const tree = this.store.getTree(caller.rootTreeId);
      let isAncestor = false;
      let curr = node.parentId;
      while (curr) {
        if (curr === caller.agentId) {
          isAncestor = true;
          break;
        }
        curr = tree?.nodes[curr]?.parentId ?? null;
      }
      if (!isAncestor) {
        throw new ChildAgentError('FORBIDDEN_FOREIGN_TREE', `Caller is not an ancestor of agent "${args.agent_id}"`);
      }
    }

    if (args.idempotency_key) {
      const sendFingerprint = sha256(JSON.stringify([args.message, args.context ?? null]));
      const existing = node.sendIdempotency?.[args.idempotency_key];
      if (existing) {
        if (existing.fingerprint === sendFingerprint) {
          return {
            agent_id: node.agentId,
            status: 'running',
            turn_count: existing.turnCount,
          };
        }
        throw new ChildAgentError(
          'IDEMPOTENCY_CONFLICT',
          `Conflicting parameters for existing send idempotency key "${args.idempotency_key}"`,
          { idempotencyKey: args.idempotency_key },
        );
      }
    }

    if (node.status === 'starting' || node.status === 'running') {
      throw new ChildAgentError('AGENT_BUSY', `Agent "${args.agent_id}" is currently busy with an ongoing turn`);
    }

    if (node.status === 'stopped' || node.status === 'unknown_after_restart') {
      throw new ChildAgentError(
        'AGENT_NOT_SENDABLE',
        `Agent "${args.agent_id}" is in state "${node.status}" and cannot accept messages`,
      );
    }

    // Check concurrency slot
    const tree = this.store.getTree(caller.rootTreeId);
    if (tree) {
      const ancestors = new Set<string>();
      let curr = node.parentId;
      while (curr) {
        ancestors.add(curr);
        curr = tree.nodes[curr]?.parentId ?? null;
      }

      let activeParallel = 0;
      for (const n of Object.values(tree.nodes)) {
        if (
          n.agentId !== node.agentId &&
          (n.status === 'starting' || n.status === 'running') &&
          !this.waitingCallers.has(n.agentId) &&
          !ancestors.has(n.agentId)
        ) {
          activeParallel++;
        }
      }

      if (activeParallel >= this.limits.maxConcurrentRunning) {
        throw new ChildAgentError(
          'MAX_CONCURRENT_EXCEEDED',
          `Max concurrent running agents limit (${this.limits.maxConcurrentRunning}) reached`,
        );
      }
    }

    const targetCwd = node.isolationDir || caller.cwd;
    let writeLocked = false;
    if (node.policy.isolation === 'shared' && (node.policy.access === 'workspace_write' || node.policy.access === 'full_access')) {
      this.ownershipRegistry.acquire(node.agentId, targetCwd, node.policy.writePaths);
      writeLocked = true;
    }

    let fullPrompt: string;
    try {
      fullPrompt = await buildExplicitChildPrompt(targetCwd, args.message, args.context);
    } catch (err) {
      if (writeLocked) {
        this.ownershipRegistry.release(node.agentId);
      }
      throw err;
    }

    let active = this.activeSessions.get(node.agentId);
    if (!active) {
      if (!node.providerSessionId) {
        if (writeLocked) this.ownershipRegistry.release(node.agentId);
        throw new ChildAgentError('AGENT_NOT_SENDABLE', 'Cannot resume session without provider session id');
      }
      const providerRuntime = this.providers.get(node.provider);
      if (!providerRuntime) {
        if (writeLocked) this.ownershipRegistry.release(node.agentId);
        throw new ChildAgentError('UNKNOWN_PROVIDER', `Unknown provider: ${node.provider}`);
      }

      let hostMcpServers: HostMcpServerConfig[] | undefined;
      if (node.policy.allowDelegate !== false && node.depth < this.limits.maxDepth) {
        let childToken = node.childToken;
        if (!childToken || !this.bindings.get(childToken)) {
          childToken = randomBytes(32).toString('hex');
          const childBinding: SessionBinding = {
            token: childToken,
            bindingId: randomUUID(),
            rootTreeId: caller.rootTreeId,
            agentId: node.agentId,
            depth: node.depth,
            cwd: targetCwd,
            maxAccess: node.policy.access,
            allowBypassPermissions: caller.allowBypassPermissions,
          };
          this.bindings.set(childToken, childBinding);
          this.bindingsById.set(childBinding.bindingId, childBinding);
          node.childToken = childToken;
        }

        const mcpUrl = this.resolveMcpUrl(childToken);
        if (mcpUrl) {
          hostMcpServers = [
            {
              name: CHILD_MCP_SERVER,
              url: mcpUrl,
              builtin: true,
            },
          ];
        }
      }

      const sessionOptions = buildChildSessionOptions(
        node.provider,
        node.policy,
        targetCwd,
        node.requestedModel,
        node.reasoningEffort,
        hostMcpServers,
      );

      let resumed: AgentSession;
      try {
        const adapter = providerRuntime.adapter();
        resumed = await adapter.resumeSession(node.providerSessionId, sessionOptions);
      } catch (err) {
        if (writeLocked) this.ownershipRegistry.release(node.agentId);
        throw new ChildAgentError('PROVIDER_UNAVAILABLE', `Failed to resume session: ${String(err)}`);
      }

      active = {
        session: resumed,
        currentPrompt: fullPrompt,
        textDelta: '',
        steps: this.store.getTranscript(caller.rootTreeId, node.agentId) ?? [],
        turnNo: node.turnNo,
        toolUses: node.toolUses,
        tokens: node.tokens,
      };
      this.activeSessions.set(node.agentId, active);
      this.attachSessionListeners(caller.rootTreeId, node.agentId, resumed, node.policy, targetCwd, active);
    }

    active.currentPrompt = fullPrompt;
    active.textDelta = '';
    active.turnNo++;

    node.status = 'running';
    node.turnNo = active.turnNo;
    node.endedAt = undefined;

    if (args.idempotency_key) {
      const sendFingerprint = sha256(JSON.stringify([args.message, args.context ?? null]));
      if (!node.sendIdempotency) node.sendIdempotency = {};
      node.sendIdempotency[args.idempotency_key] = {
        fingerprint: sendFingerprint,
        turnCount: node.turnNo,
      };
    }

    this.store.saveNode(caller.rootTreeId, node);

    this.emitTreeEvent(caller.rootTreeId, {
      type: 'agent.start',
      agentId: node.agentId,
      taskId: node.agentId,
      description: node.title,
      taskType: 'managed_agent',
      subagentType: node.provider,
      background: true,
      prompt: fullPrompt,
      model: node.effectiveModel || node.requestedModel || undefined,
      provider: node.provider,
      requestedModel: node.requestedModel,
      reasoningEffort: node.reasoningEffort ?? undefined,
      parentAgentId: node.parentId ?? undefined,
      at: Date.now(),
    });

    active.session.send(fullPrompt);

    return {
      agent_id: node.agentId,
      status: 'running',
      turn_count: node.turnNo,
    };
  }

  // --- 6. agent_stop ---
  async stop(bindingToken: string, args: AgentStopArgs): Promise<AgentStopResult> {
    const caller = this.requireBinding(bindingToken);
    const node = this.findNodeAndVerifyAccess(caller, args.agent_id);

    // Only ancestor or root can stop
    if (caller.agentId !== null) {
      const tree = this.store.getTree(caller.rootTreeId);
      let isAncestor = false;
      let curr = node.parentId;
      while (curr) {
        if (curr === caller.agentId) {
          isAncestor = true;
          break;
        }
        curr = tree?.nodes[curr]?.parentId ?? null;
      }
      if (!isAncestor && caller.agentId !== args.agent_id) {
        throw new ChildAgentError('FORBIDDEN_FOREIGN_TREE', `Caller cannot stop foreign agent "${args.agent_id}"`);
      }
    }

    return this.stopSubtree(caller.rootTreeId, args.agent_id);
  }

  private async stopSubtree(rootTreeId: string, agentId: string): Promise<AgentStopResult> {
    const tree = this.store.getTree(rootTreeId);
    if (!tree) {
      return { stopped_ids: [], already_terminal: true };
    }

    // Collect agentId and all its descendants
    const targetIds = [agentId];
    const toCheck = [agentId];
    while (toCheck.length > 0) {
      const parent = toCheck.shift();
      for (const n of Object.values(tree.nodes)) {
        if (n.parentId === parent) {
          targetIds.push(n.agentId);
          toCheck.push(n.agentId);
        }
      }
    }

    const stoppedIds: string[] = [];
    const now = Date.now();

    for (const id of targetIds) {
      const n = tree.nodes[id];
      if (!n) continue;

      const active = this.activeSessions.get(id);

      if (isTerminalStatus(n.status)) {
        if (active) {
          try {
            active.session.dispose();
          } catch {
            // ignore
          }
          try {
            await active.cleanupWorktree?.();
          } catch {
            // ignore
          }
          this.activeSessions.delete(id);
        }
        this.ownershipRegistry.release(id);
        continue;
      }

      if (active || n.status === 'starting' || n.status === 'running') {
        if (active) {
          try {
            await active.session.interrupt();
          } catch {
            // ignore
          }
          try {
            active.session.dispose();
          } catch {
            // ignore
          }
          try {
            await active.cleanupWorktree?.();
          } catch {
            // ignore
          }
          this.activeSessions.delete(id);
        }

        this.ownershipRegistry.release(id);

        n.status = 'stopped';
        n.endedAt = now;
        this.store.saveNode(rootTreeId, n);

        this.emitTreeEvent(rootTreeId, {
          type: 'agent.end',
          agentId: id,
          taskId: id,
          status: 'stopped',
          summary: 'Stopped by request',
          at: now,
        });

        this.wakeWaiters(id);
        stoppedIds.push(id);
      }
    }

    if (stoppedIds.length === 0) {
      return { stopped_ids: [], already_terminal: true };
    }

    return { stopped_ids: stoppedIds, already_terminal: false };
  }

  // --- Host / UI methods ---
  hasManagedAgent(rootTreeId: string, agentId: string): boolean {
    const tree = this.store.getTree(rootTreeId);
    return Boolean(tree?.nodes[agentId]);
  }

  async stopFromHost(rootTreeId: string, agentId: string): Promise<AgentStopResult> {
    return this.stopSubtree(rootTreeId, agentId);
  }

  async disposeTree(rootTreeId: string): Promise<void> {
    const tree = this.store.getTree(rootTreeId);
    if (!tree) return;

    for (const id of Object.keys(tree.nodes)) {
      await this.stopSubtree(rootTreeId, id);
    }

    // Clean up bindings for this tree
    for (const [token, binding] of this.bindings.entries()) {
      if (binding.rootTreeId === rootTreeId) {
        this.bindings.delete(token);
        this.bindingsById.delete(binding.bindingId);
      }
    }
  }

  renderTranscript(rootTreeId: string, agentId: string): string | undefined {
    const tree = this.store.getTree(rootTreeId);
    const node = tree?.nodes[agentId];
    if (!node) return undefined;

    const steps = this.store.getTranscript(rootTreeId, agentId) ?? [];

    const lines: string[] = [
      `# Child Agent Transcript: ${node.agentId}`,
      '',
      `- **Provider:** ${node.provider}`,
      `- **Status:** ${node.status}`,
      `- **Requested Model:** ${node.requestedModel || 'default'}`,
      `- **Effective Model:** ${node.effectiveModel || 'unknown'}`,
      `- **Access Mode:** ${node.policy.access}`,
      `- **Isolation:** ${node.policy.isolation ?? 'shared'}`,
      `- **Started:** ${new Date(node.startedAt).toISOString()}`,
    ];

    if (node.endedAt) {
      lines.push(`- **Ended:** ${new Date(node.endedAt).toISOString()}`);
    }
    if (node.error) {
      lines.push(`- **Error:** ${node.error}`);
    }

    lines.push('', '## Initial Task Prompt', '', node.prompt, '');

    if (steps.length > 0) {
      lines.push('## Turns');
      for (const step of steps) {
        lines.push('', `### Turn ${step.turnNo}`, '');
        if (step.prompt) {
          lines.push('**Input:**', step.prompt, '');
        }
        if (step.text) {
          lines.push('**Output:**', step.text, '');
        }
      }
    } else if (node.summary) {
      lines.push('## Result Summary', '', node.summary, '');
    }

    return lines.join('\n');
  }

  restoredEvents(rootTreeId: string): AgentEvent[] {
    const tree = this.store.getTree(rootTreeId);
    if (!tree) return [];

    const events: AgentEvent[] = [];
    for (const node of Object.values(tree.nodes)) {
      events.push({
        type: 'agent.start',
        agentId: node.agentId,
        taskId: node.agentId,
        description: node.title,
        taskType: 'managed_agent',
        subagentType: node.provider,
        background: true,
        prompt: node.prompt,
        model: node.effectiveModel || node.requestedModel || undefined,
        provider: node.provider,
        requestedModel: node.requestedModel,
        reasoningEffort: node.reasoningEffort || undefined,
        parentAgentId: node.parentId || undefined,
        at: node.startedAt,
      });

      if (isTerminalStatus(node.status)) {
        events.push({
          type: 'agent.end',
          agentId: node.agentId,
          taskId: node.agentId,
          status: node.status === 'unknown_after_restart' ? 'failed' : (node.status as 'completed' | 'failed' | 'stopped'),
          summary: node.summary || node.error,
          totalTokens: node.tokens,
          toolUses: node.toolUses,
          at: node.endedAt || node.startedAt,
        });
      }
    }

    return events;
  }
}
