import type { AgentAdapter, EffortLevel, ModelOption } from '../types';

export const CHILD_MCP_SERVER = 'agentura_agents';

export type ChildAccessMode = 'read_only' | 'workspace_write' | 'full_access';

export type ChildIsolationMode = 'shared' | 'worktree';

export interface ChildPolicy {
  access: ChildAccessMode;
  writePaths?: string[];
  isolation?: ChildIsolationMode;
  allowDelegate?: boolean;
}

export type ChildStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unknown_after_restart';

export type ChildErrorCode =
  | 'UNKNOWN_PROVIDER'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_EFFORT'
  | 'POLICY_ESCALATION_DENIED'
  | 'POLICY_UNSUPPORTED_BY_ENGINE'
  | 'WRITE_OWNERSHIP_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MAX_DEPTH_EXCEEDED'
  | 'MAX_CONCURRENT_EXCEEDED'
  | 'MAX_SPAWNS_EXCEEDED'
  | 'FORBIDDEN_FOREIGN_TREE'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_BUSY'
  | 'AGENT_NOT_SENDABLE'
  | 'INVALID_CONTEXT'
  | 'FORK_TURNS_UNSUPPORTED'
  | 'INVALID_ARGUMENTS';

export class ChildAgentError extends Error {
  constructor(
    readonly code: ChildErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ChildAgentError';
  }
}

export interface ChildContextFileSpec {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ChildContextSpec {
  selectedText?: string;
  files?: ChildContextFileSpec[];
  notes?: string;
}

export interface TreeLimits {
  maxDepth: number;
  maxConcurrentRunning: number;
  maxTotalSpawns: number;
}

export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxDepth: 2,
  maxConcurrentRunning: 3,
  maxTotalSpawns: 16,
};

export interface HostMcpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  builtin?: boolean;
}

export interface ProviderInspectResult {
  status: 'ready' | 'needs_auth' | 'unavailable' | 'unsupported';
  models: ModelOption[];
  defaultModel?: string | null;
  reason?: string;
  supportedAccess: ChildAccessMode[];
  supportsFineGrainedWritePaths: boolean;
  canDelegateViaMcp: boolean;
}

export interface ProviderRuntime {
  readonly provider: string;
  readonly label: string;
  adapter(): AgentAdapter;
  inspect(cwd: string): Promise<ProviderInspectResult>;
}

export interface TreeLimitsRemaining {
  depth: number;
  maxDepth: number;
  activeRunning: number;
  maxConcurrentRunning: number;
  totalSpawns: number;
  maxTotalSpawns: number;
}

export interface ProviderCatalogItem {
  provider: string;
  label: string;
  status: 'ready' | 'needs_auth' | 'unavailable' | 'unsupported';
  models: ModelOption[];
  defaultModel?: string | null;
  reason?: string;
  supportedAccess: ChildAccessMode[];
  supportsFineGrainedWritePaths: boolean;
  canDelegateViaMcp: boolean;
}

export interface AgentsCatalogResult {
  providers: ProviderCatalogItem[];
  limits: TreeLimitsRemaining;
}

export interface AgentSpawnArgs {
  provider: string;
  task: string;
  model?: string | null;
  reasoning_effort?: EffortLevel | string | null;
  context?: ChildContextSpec;
  policy?: Partial<ChildPolicy>;
  title?: string;
  idempotency_key?: string;
  fork_turns?: 'none' | 'all' | string;
}

export interface AgentSpawnResult {
  agent_id: string;
  status: ChildStatus;
  provider: string;
  requested_model: string | null;
  effective_model: string | null;
  parent_id: string | null;
  root_id: string;
  depth: number;
  policy: ChildPolicy;
}

export interface ChildStatusView {
  agent_id: string;
  parent_id: string | null;
  root_id: string;
  depth: number;
  provider: string;
  provider_session_id?: string;
  requested_model: string | null;
  effective_model: string | null;
  reasoning_effort?: string | null;
  status: ChildStatus;
  policy: ChildPolicy;
  prompt?: string;
  summary?: string;
  error?: string;
  last_tool?: string;
  started_at: number;
  ended_at?: number;
  turn_count: number;
  tool_uses: number;
  total_tokens: number;
}

export interface AgentWaitArgs {
  agent_ids?: string[];
  agent_id?: string;
  timeout_ms?: number;
}

export interface AgentWaitResult {
  timed_out: boolean;
  agents: ChildStatusView[];
}

export interface AgentSendArgs {
  agent_id: string;
  message: string;
  context?: ChildContextSpec;
  idempotency_key?: string;
}

export interface AgentSendResult {
  agent_id: string;
  status: 'running';
  turn_count: number;
}

export interface AgentStopArgs {
  agent_id: string;
}

export interface AgentStopResult {
  stopped_ids: string[];
  already_terminal: boolean;
}

export interface StoredTranscriptStep {
  turnNo: number;
  prompt: string;
  at: number;
  text?: string;
  toolUses?: { name: string; isError?: boolean }[];
  summary?: string;
  error?: string;
}

export interface StoredChildNode {
  agentId: string;
  parentId: string | null;
  rootTreeId: string;
  depth: number;
  title: string;
  provider: string;
  providerSessionId?: string;
  requestedModel: string | null;
  effectiveModel: string | null;
  reasoningEffort?: string | null;
  prompt: string;
  context?: ChildContextSpec;
  policy: ChildPolicy;
  status: ChildStatus;
  summary?: string;
  error?: string;
  lastTool?: string;
  childToken?: string;
  startedAt: number;
  endedAt?: number;
  turnNo: number;
  toolUses: number;
  tokens: number;
  idempotencyKey?: string;
  callerBindingId: string;
  requestFingerprint?: string;
  sendIdempotency?: Record<string, { fingerprint: string; turnCount: number }>;
  isolationDir?: string;
}

export interface StoredTree {
  rootTreeId: string;
  createdAt: number;
  updatedAt: number;
  rootCwd: string;
  totalSpawns: number;
  nodes: Record<string, StoredChildNode>;
}

export interface SessionBinding {
  token: string;
  bindingId: string;
  rootTreeId: string;
  agentId: string | null;
  depth: number;
  cwd: string;
  maxAccess: ChildAccessMode;
  allowBypassPermissions?: boolean;
}
