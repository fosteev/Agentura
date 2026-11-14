import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { streamLines } from '../../data/jsonlStream';
import { hostStrings } from '../../shared/l10n';
import type { AgentEvent, TokenUsage } from '../types';
import { record } from './protocol';

export const KIMI_WIRE_PROTOCOL = '1.5';
export const KIMI_HISTORY_AGENTS = 30;
export const KIMI_HISTORY_EVENTS = 400;

const SESSION_ID = /^session_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AGENT_ID = /^agent-\d{1,9}$/;
const TASK_ID = /^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOOL_ID = /^tool_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS = 2000;
const MAX_TASK_OUTPUT = 4000;

export function validKimiSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function validKimiAgentId(value: unknown): value is string {
  return value === 'main' || (typeof value === 'string' && AGENT_ID.test(value));
}

export function validKimiTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value) && !AGENT_ID.test(value);
}

export function validKimiToolCallId(value: unknown): value is string {
  return typeof value === 'string' && TOOL_ID.test(value);
}

/** ACP prefix synthetic; durable records contain only the stable raw suffix after the first colon. */
export function rawKimiToolCallId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const colon = value.indexOf(':');
  const raw = colon >= 0 ? value.slice(colon + 1) : value;
  return validKimiToolCallId(raw) ? raw : undefined;
}

export interface KimiStateAgent {
  type: 'main' | 'sub';
  parentAgentId?: string;
  labelParentAgentId?: string;
  profileName?: string;
}

export interface KimiSessionState {
  id: string;
  agents: Map<string, KimiStateAgent>;
}

export function parseKimiState(value: unknown, expectedSessionId?: string): KimiSessionState | undefined {
  const row = record(value);
  if (!row || row.version !== 2 || !validKimiSessionId(row.id)) return undefined;
  if (expectedSessionId && row.id !== expectedSessionId) return undefined;
  const source = record(row.agents);
  const main = record(source?.main);
  if (!source || main?.type !== 'main') return undefined;
  const agents = new Map<string, KimiStateAgent>([['main', { type: 'main' }]]);
  for (const [id, value] of Object.entries(source)) {
    if (id === 'main') continue;
    const item = record(value);
    if (!AGENT_ID.test(id) || item?.type !== 'sub' || agents.size > 1000) return undefined;
    const labels = record(item.labels);
    const parent = validKimiAgentId(item.parentAgentId) ? item.parentAgentId : undefined;
    const labelParent = validKimiAgentId(labels?.parentAgentId) ? labels.parentAgentId : undefined;
    const profileName = typeof labels?.profileName === 'string' ? labels.profileName.slice(0, 200) : undefined;
    agents.set(id, {
      type: 'sub',
      ...(parent ? { parentAgentId: parent } : {}),
      ...(labelParent ? { labelParentAgentId: labelParent } : {}),
      ...(profileName ? { profileName } : {}),
    });
  }
  return { id: row.id, agents };
}

export async function readKimiState(root: string, expectedSessionId?: string): Promise<KimiSessionState | undefined> {
  try {
    const file = await safeKimiFile(root, ['state.json']);
    if (!file || (await stat(file)).size > MAX_STATE_BYTES) return undefined;
    return parseKimiState(JSON.parse(await readFile(file, 'utf8')), expectedSessionId);
  } catch {
    return undefined;
  }
}

export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KIMI_CODE_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.kimi-code');
}

/** Only session directories are enumerated; credentials and global logs are never opened. */
export async function findKimiSessionRoot(sessionId: string, home = kimiHome()): Promise<string | undefined> {
  if (!validKimiSessionId(sessionId)) return undefined;
  const sessions = join(resolve(home), 'sessions');
  try {
    for (const entry of await readdir(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
      const root = join(sessions, entry.name, sessionId);
      const state = await readKimiState(root, sessionId);
      if (state) return await realpath(root);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** State homedir is deliberately ignored: only validated ids below the discovered session root are used. */
async function safeKimiFile(root: string, segments: readonly string[]): Promise<string | undefined> {
  try {
    const realRoot = await realpath(resolve(root));
    const candidate = resolve(realRoot, ...segments);
    if (!inside(realRoot, candidate)) return undefined;
    const path = await realpath(candidate);
    return inside(realRoot, path) ? path : undefined;
  } catch {
    return undefined;
  }
}

interface WireRead {
  records: Record<string, unknown>[];
  supported: boolean;
}

/** Byte-offset JSONL reader. An unterminated final line stays unread until its newline arrives. */
export class KimiWireReader {
  private position = 0;
  private protocol: boolean | undefined;

  constructor(readonly path: string) {}

  get offset(): number {
    return this.position;
  }

  async read(maxBytes?: number): Promise<WireRead> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return { records: [], supported: this.protocol !== false };
    }
    if (size < this.position) {
      this.position = 0;
      this.protocol = undefined;
    }
    const records: Record<string, unknown>[] = [];
    try {
      const end = maxBytes === undefined ? size : Math.min(size, this.position + maxBytes);
      const result = await streamLines(this.path, (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const wrapped = record(parsed);
        const row = record(wrapped?.msg) ?? wrapped;
        if (!row) return;
        if (row.type === 'metadata') {
          this.protocol = compatibleProtocol(row);
          return;
        }
        if (this.protocol === true) records.push(row);
      }, { start: this.position, end });
      this.position = result.offset;
    } catch {
      return { records: [], supported: this.protocol !== false };
    }
    return { records, supported: this.protocol !== false };
  }
}

function compatibleProtocol(row: Record<string, unknown>): boolean {
  if (row.protocol_version !== KIMI_WIRE_PROTOCOL) return false;
  const min = row.min_protocol_version;
  if (typeof min !== 'string' || !/^\d+\.\d+$/.test(min)) return false;
  const [major, minor] = min.split('.').map(Number);
  return major! < 1 || (major === 1 && minor! <= 5);
}

function timeOf(row: Record<string, unknown>, fallback = Date.now()): number {
  return typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : fallback;
}

function stringOf(value: unknown, max = 10_000): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function usageOf(row: unknown): TokenUsage | undefined {
  const usage = record(row);
  if (!usage) return undefined;
  const number = (key: string) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0
    ? usage[key] as number
    : 0;
  return {
    input: number('inputOther'),
    output: number('output'),
    cacheRead: number('inputCacheRead'),
    cacheWrite: number('inputCacheCreation'),
  };
}

function tokenTotal(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const row = record(item);
      return row?.type === 'text' && typeof row.text === 'string' ? row.text : '';
    }).filter(Boolean).join('\n');
  }
  const row = record(value);
  if (!row) return '';
  for (const key of ['output', 'stdout', 'content']) {
    if (typeof row[key] === 'string') return row[key] as string;
    if (Array.isArray(row[key])) return outputText(row[key]);
  }
  return JSON.stringify(value) ?? '';
}

type NodeStatus = 'running' | 'completed' | 'failed' | 'stopped';

interface GraphNode {
  agentId: string;
  taskId: string;
  subagentId?: string;
  engineTaskId?: string;
  rawParentToolCallId?: string;
  anchorId: string;
  parentAgentId?: string;
  parentSubagentId?: string;
  depth: number;
  description: string;
  taskType: string;
  subagentType?: string;
  background: boolean;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  startedAt: number;
  endedAt?: number;
  status: NodeStatus;
  summary?: string;
  totalTokens?: number;
  toolUses: number;
  timelineEvents: number;
  durable: boolean;
  emitted: boolean;
  startEvent?: Extract<AgentEvent, { type: 'agent.start' }>;
  toolName?: string;
}

interface ReaderEntry {
  reader: KimiWireReader;
  active: boolean;
}

export interface KimiSubagentTrackerOptions {
  pollMs?: number;
  maxAgents?: number;
  maxDepth?: number;
  maxEventsPerAgent?: number;
  /** History joins ACP calls first, then emits durable starts with their persisted timestamps. */
  deferAcpStart?: boolean;
  log?: (message: string) => void;
}

/**
 * Read-only live graph. Main stays watched between turns for background work; child readers sleep at
 * terminal and resume at the next durable spawn with the same subagent id and their existing offset.
 */
export class KimiSubagentTracker {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly byRawTool = new Map<string, string>();
  private readonly currentBySubagent = new Map<string, string>();
  private readonly byEngineTask = new Map<string, string>();
  private readonly readers = new Map<string, ReaderEntry>();
  private readonly rootPromise: Promise<string | undefined>;
  private readonly emit: (event: AgentEvent) => void;
  private readonly options: Required<Omit<KimiSubagentTrackerOptions, 'log'>> & Pick<KimiSubagentTrackerOptions, 'log'>;
  private mainReader: KimiWireReader | undefined;
  private mainActive = true;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<number> | undefined;
  private disposed = false;

  constructor(
    root: string | Promise<string | undefined>,
    emit: (event: AgentEvent) => void,
    options: KimiSubagentTrackerOptions = {},
  ) {
    this.rootPromise = Promise.resolve(root);
    this.emit = emit;
    this.options = {
      pollMs: options.pollMs ?? 250,
      maxAgents: options.maxAgents ?? 100,
      maxDepth: options.maxDepth ?? 8,
      maxEventsPerAgent: options.maxEventsPerAgent ?? KIMI_HISTORY_EVENTS,
      deferAcpStart: options.deferAcpStart ?? false,
      log: options.log,
    };
  }

  get activeWatcherCount(): number {
    return (this.mainActive && this.mainReader ? 1 : 0) + [...this.readers.values()].filter((entry) => entry.active).length;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  anchorFor(agentId: string): string | undefined {
    return this.nodes.get(agentId)?.anchorId;
  }

  start(): void {
    if (this.disposed || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.mainActive = false;
    this.readers.clear();
  }

  observeEvent(event: AgentEvent): void {
    if (this.disposed || event.agentId) return;
    if (event.type === 'tool.start') {
      const raw = rawKimiToolCallId(event.toolUseId);
      if (raw) this.byRawTool.set(raw, event.toolUseId);
      if (event.name !== 'Agent' && event.name !== 'AgentSwarm') return;
      this.startAcp(event.toolUseId, event.name, event.input, event.at ?? Date.now());
      return;
    }
    if (event.type === 'tool.result' && event.isError) {
      const node = this.nodes.get(event.toolUseId);
      if (!node || node.durable || (node.toolName !== 'Agent' && node.toolName !== 'AgentSwarm')) return;
      if (!node.emitted) this.emitStart(node, node.startedAt);
      this.endNode(node, 'failed', event.at ?? Date.now(), event.content);
    }
  }

  poll(): Promise<number> {
    if (this.disposed) return Promise.resolve(0);
    if (this.polling) return this.polling;
    const run = this.pollNow().catch((error: unknown) => {
      this.options.log?.(`kimi graph poll failed: ${String(error)}`);
      return 0;
    }).finally(() => (this.polling = undefined));
    this.polling = run;
    return run;
  }

  /** Restore does not invent liveness: without a live engine, unfinished durable nodes are stopped. */
  finishHistory(tasksAlive: boolean): void {
    if (tasksAlive) return;
    for (const node of this.nodes.values()) {
      if (node.status === 'running' && node.emitted) {
        this.endNode(node, 'stopped', node.endedAt ?? node.startedAt);
      }
    }
  }

  historyEvents(events: readonly AgentEvent[]): AgentEvent[] {
    const selected = new Set([...this.nodes.values()]
      .filter((node) => node.emitted)
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-KIMI_HISTORY_AGENTS)
      .map((node) => node.agentId));
    const out: AgentEvent[] = [];
    for (const node of this.nodes.values()) {
      if (!selected.has(node.agentId)) continue;
      const own = events.filter((event) => event.agentId === node.agentId);
      const firstStart = own.findIndex((event) => event.type === 'agent.start');
      const head = firstStart >= 0 ? [own[firstStart]!] : [];
      const tail = own.filter((_, index) => index !== firstStart).slice(-KIMI_HISTORY_EVENTS);
      out.push(...head, ...tail);
    }
    const allowed = new Set(out);
    return events.filter((event) => event.agentId && selected.has(event.agentId) && allowed.has(event));
  }

  private async pollNow(): Promise<number> {
    const root = await this.rootPromise;
    if (!root || this.disposed) return 0;
    let count = 0;
    if (this.mainActive) {
      if (!this.mainReader) {
        const file = await safeKimiFile(root, ['agents', 'main', 'wire.jsonl']);
        if (file) this.mainReader = new KimiWireReader(file);
      }
      if (this.mainReader) {
        const read = await this.mainReader.read();
        if (!read.supported) this.mainActive = false;
        for (const row of read.records) {
          count++;
          await this.applyRecord(root, 'main', row);
        }
      }
    }
    // The durable spawn can be visible just before the child's file is created.
    for (const node of this.nodes.values()) {
      if (node.status === 'running' && node.subagentId && !this.readers.has(node.subagentId)) {
        await this.ensureReader(root, node.subagentId);
      }
    }
    for (const [subagentId, entry] of [...this.readers]) {
      if (!entry.active || this.disposed) continue;
      const read = await entry.reader.read();
      if (!read.supported) {
        entry.active = false;
        continue;
      }
      for (const row of read.records) {
        count++;
        await this.applyRecord(root, subagentId, row);
      }
      const current = this.currentBySubagent.get(subagentId);
      const node = current ? this.nodes.get(current) : undefined;
      if (node?.status !== 'running') entry.active = false;
    }
    return count;
  }

  private startAcp(agentId: string, toolName: 'Agent' | 'AgentSwarm', input: Record<string, unknown>, at: number): void {
    if (this.nodes.has(agentId) || !rawKimiToolCallId(agentId) || this.nodes.size >= this.options.maxAgents) return;
    const resume = validKimiAgentId(input.resume) && input.resume !== 'main' ? input.resume : undefined;
    const prompt = stringOf(input.prompt) ?? stringOf(input.prompt_template);
    const description = stringOf(input.description, 500) ?? prompt?.split('\n')[0]?.slice(0, 200) ?? toolName;
    const subagentType = stringOf(input.subagent_type, 200);
    const model = stringOf(input.model, 200);
    const reasoningEffort = stringOf(input.thinking_effort ?? input.effort, 50);
    const node: GraphNode = {
      agentId,
      taskId: resume ?? agentId,
      ...(resume ? { subagentId: resume } : {}),
      anchorId: agentId,
      depth: 0,
      description,
      taskType: 'subagent',
      ...(subagentType ? { subagentType } : {}),
      background: input.run_in_background === true,
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      startedAt: at,
      status: 'running',
      toolUses: 0,
      timelineEvents: 0,
      durable: false,
      emitted: false,
      toolName,
    };
    this.nodes.set(agentId, node);
    if (resume) this.currentBySubagent.set(resume, agentId);
    if (!this.options.deferAcpStart) this.emitStart(node, at);
  }

  private async applyRecord(root: string, ownerId: string, row: Record<string, unknown>): Promise<void> {
    if (this.disposed) return;
    if (typeof row.agentId === 'string' && row.agentId !== ownerId) return;
    const type = row.type;
    if (type === 'subagent.spawned') return this.spawn(root, ownerId, row);
    if (type === 'subagent.started') {
      const node = this.subagentNode(row.subagentId);
      if (node) this.emitProgress(node, 'started');
      return;
    }
    if (type === 'subagent.completed' || type === 'subagent.failed' || type === 'subagent.cancelled') {
      const node = this.subagentNode(row.subagentId);
      if (!node) return;
      const usage = usageOf(row.usage);
      if (usage) node.totalTokens = tokenTotal(usage);
      const summary = stringOf(row.resultSummary) ?? stringOf(row.error) ?? stringOf(row.message);
      const status: NodeStatus = type === 'subagent.completed' ? 'completed' : type === 'subagent.failed' ? 'failed' : 'stopped';
      this.endNode(node, status, timeOf(row), summary);
      return;
    }
    if (type === 'task.started' || type === 'task.terminated') return this.task(root, ownerId, row, type === 'task.terminated');
    if (ownerId === 'main') return;
    const node = this.subagentNode(ownerId);
    if (!node) return;
    if (type === 'turn.prompt') {
      const input = Array.isArray(row.input) ? row.input : [];
      const prompt = input.map((item) => record(item)?.text)
        .filter((value): value is string => typeof value === 'string').join('\n');
      if (!prompt || node.prompt === prompt) return;
      node.prompt = prompt.slice(0, 10_000);
      // History may read the parent terminal before the child prompt: patch its already collected start,
      // but never emit a new live start after terminal (which would falsely reopen the HUD node).
      if (node.startEvent) node.startEvent.prompt = node.prompt;
      if (node.status === 'running') this.emitStart(node, timeOf(row));
      return;
    }
    if (type === 'usage.record') {
      const usage = usageOf(row.usage);
      if (!usage) return;
      const model = stringOf(row.model, 200);
      if (model) node.model = model;
      // Initial restore reads the parent's terminal record before the child's earlier usage rows.
      if (node.status === 'running') node.totalTokens = (node.totalTokens ?? 0) + tokenTotal(usage);
      this.timeline(node, {
        type: 'usage.message', agentId: node.agentId, messageId: `usage-${timeOf(row)}`,
        model: model ?? node.model ?? '', usage, final: true, at: timeOf(row),
      });
      this.emitProgress(node, 'usage');
      return;
    }
    if (type !== 'context.append_loop_event') return;
    const event = record(row.event);
    if (!event) return;
    if (event.type === 'content.part') return this.contentPart(node, event, timeOf(row));
    if (event.type === 'tool.call') return this.toolCall(node, event, timeOf(row));
    if (event.type === 'tool.result') return this.toolResult(node, event, timeOf(row));
  }

  private async spawn(root: string, ownerId: string, row: Record<string, unknown>): Promise<void> {
    const subagentId = row.subagentId;
    const parentToolCallId = row.parentToolCallId;
    const parentAgentId = row.parentAgentId;
    const engineTaskId = row.taskId;
    if (!validKimiAgentId(subagentId) || subagentId === 'main' || !validKimiToolCallId(parentToolCallId) ||
        parentAgentId !== ownerId || !validKimiTaskId(engineTaskId)) return;
    let node: GraphNode | undefined;
    let parent: GraphNode | undefined;
    if (ownerId === 'main') {
      const agentId = this.byRawTool.get(parentToolCallId);
      node = agentId ? this.nodes.get(agentId) : undefined;
      if (!node) return; // no proven ACP ↔ durable key: do not invent a top-level agent
    } else {
      parent = this.subagentNode(ownerId);
      if (!parent || parent.subagentId === subagentId || this.hasAncestor(parent, subagentId)) return;
      const agentId = parentToolCallId;
      node = this.nodes.get(agentId);
      if (node && node.subagentId && node.subagentId !== subagentId) return;
      if (!node) {
        if (this.nodes.size >= this.options.maxAgents || parent.depth + 1 > this.options.maxDepth) return;
        node = this.blankDurable(agentId, parentToolCallId, parent);
        this.nodes.set(agentId, node);
      }
    }
    if (!node || (node.subagentId && node.subagentId !== subagentId)) return;
    const at = timeOf(row);
    node.subagentId = subagentId;
    node.taskId = subagentId;
    node.engineTaskId = engineTaskId;
    node.rawParentToolCallId = parentToolCallId;
    node.parentSubagentId = ownerId === 'main' ? undefined : ownerId;
    node.parentAgentId = parent?.agentId;
    node.depth = parent ? parent.depth + 1 : 0;
    node.anchorId = parent?.anchorId ?? node.agentId;
    node.description = stringOf(row.description, 500) ?? node.description;
    node.subagentType = stringOf(row.subagentName, 200) ?? node.subagentType;
    node.model = stringOf(row.model, 200) ?? node.model;
    node.reasoningEffort = stringOf(row.thinkingEffort, 50) ?? node.reasoningEffort;
    node.background = row.runInBackground === true;
    node.status = 'running';
    node.startedAt = at;
    node.endedAt = undefined;
    node.summary = undefined;
    node.durable = true;
    this.currentBySubagent.set(subagentId, node.agentId);
    this.byEngineTask.set(engineTaskId, node.agentId);
    this.emitStart(node, at);
    await this.ensureReader(root, subagentId);
  }

  private blankDurable(agentId: string, rawParentToolCallId: string, parent: GraphNode): GraphNode {
    return {
      agentId,
      taskId: agentId,
      rawParentToolCallId,
      anchorId: parent.anchorId,
      parentAgentId: parent.agentId,
      parentSubagentId: parent.subagentId,
      depth: parent.depth + 1,
      description: agentId,
      taskType: 'subagent',
      background: false,
      startedAt: Date.now(),
      status: 'running',
      toolUses: 0,
      timelineEvents: 0,
      durable: true,
      emitted: false,
    };
  }

  private hasAncestor(parent: GraphNode, subagentId: string): boolean {
    let current: GraphNode | undefined = parent;
    const seen = new Set<string>();
    while (current && !seen.has(current.agentId)) {
      if (current.subagentId === subagentId) return true;
      seen.add(current.agentId);
      current = current.parentAgentId ? this.nodes.get(current.parentAgentId) : undefined;
    }
    return seen.size > this.options.maxDepth;
  }

  private async ensureReader(root: string, subagentId: string): Promise<void> {
    const existing = this.readers.get(subagentId);
    if (existing) {
      existing.active = true;
      return;
    }
    const file = await safeKimiFile(root, ['agents', subagentId, 'wire.jsonl']);
    if (!file) return;
    this.readers.set(subagentId, { reader: new KimiWireReader(file), active: true });
  }

  private subagentNode(id: unknown): GraphNode | undefined {
    if (!validKimiAgentId(id) || id === 'main') return undefined;
    const current = this.currentBySubagent.get(id);
    return current ? this.nodes.get(current) : undefined;
  }

  private async task(root: string, ownerId: string, row: Record<string, unknown>, terminated: boolean): Promise<void> {
    const info = record(row.info);
    const taskId = info?.taskId;
    if (!info || !validKimiTaskId(taskId)) return;
    if (info.kind === 'agent') {
      const linked = this.subagentNode(info.agentId);
      const byTask = this.byEngineTask.get(taskId);
      const node = linked ?? (byTask ? this.nodes.get(byTask) : undefined);
      if (!node || node.engineTaskId !== taskId) return;
      if (typeof info.parentToolCallId === 'string' && info.parentToolCallId !== node.rawParentToolCallId) return;
      if (!terminated) {
        this.emitProgress(node, 'running');
        return;
      }
      if (node.status !== 'running') return;
      const summary = await this.taskOutput(root, ownerId, taskId);
      if (this.disposed) return;
      const status = info.status === 'completed' ? 'completed' : info.status === 'failed' ? 'failed' : 'stopped';
      this.endNode(node, status, timeOf(row), summary);
      return;
    }

    let node = this.byEngineTask.has(taskId) ? this.nodes.get(this.byEngineTask.get(taskId)!) : undefined;
    if (!node) {
      if (terminated || this.nodes.size >= this.options.maxAgents) return;
      const rawParent = info.parentToolCallId;
      if (!validKimiToolCallId(rawParent)) return;
      const parent = ownerId === 'main' ? undefined : this.subagentNode(ownerId);
      if (ownerId !== 'main' && !parent) return;
      const anchorId = parent?.anchorId ?? this.byRawTool.get(rawParent);
      if (!anchorId) return;
      const agentId = `task:${taskId}`;
      node = {
        agentId,
        taskId,
        engineTaskId: taskId,
        rawParentToolCallId: rawParent,
        anchorId,
        ...(parent ? { parentAgentId: parent.agentId, parentSubagentId: parent.subagentId } : {}),
        depth: parent ? parent.depth + 1 : 0,
        description: stringOf(info.description, 500) ?? taskId,
        taskType: info.kind === 'shell' || info.kind === 'bash' ? 'local_bash' : stringOf(info.kind, 100) ?? 'task',
        background: true,
        startedAt: typeof info.startedAt === 'number' ? info.startedAt : timeOf(row),
        status: 'running',
        toolUses: 0,
        timelineEvents: 0,
        durable: true,
        emitted: false,
      };
      this.nodes.set(agentId, node);
      this.byEngineTask.set(taskId, agentId);
      this.emitStart(node, node.startedAt);
    }
    if (!terminated || node.status !== 'running') return;
    const summary = await this.taskOutput(root, ownerId, taskId);
    if (this.disposed) return;
    const status = info.status === 'completed' ? 'completed' : info.status === 'failed' ? 'failed' : 'stopped';
    this.endNode(node, status, timeOf(row), summary);
  }

  private async taskOutput(root: string, ownerId: string, taskId: string): Promise<string | undefined> {
    const file = await safeKimiFile(root, ['agents', ownerId, 'tasks', taskId, 'output.log']);
    if (!file) return undefined;
    try {
      if ((await stat(file)).size > MAX_TASK_OUTPUT * 4) return undefined;
      return (await readFile(file, 'utf8')).slice(0, MAX_TASK_OUTPUT).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private contentPart(node: GraphNode, event: Record<string, unknown>, at: number): void {
    const part = record(event.part);
    const messageId = stringOf(event.uuid, 200) ?? `part-${at}`;
    const startedAt = typeof event.startedAt === 'number' ? event.startedAt : at;
    if (part?.type === 'think' && stringOf(part.think)) {
      this.timeline(node, { type: 'thinking.start', agentId: node.agentId, messageId, at: startedAt });
      this.timeline(node, { type: 'thinking.stop', agentId: node.agentId, messageId,
        at: startedAt + Math.max(0, typeof event.durationMs === 'number' ? event.durationMs : 0) });
      return;
    }
    if (part?.type === 'text' && stringOf(part.text)) {
      this.timeline(node, { type: 'text.delta', agentId: node.agentId, messageId, text: part.text as string });
    }
  }

  private toolCall(node: GraphNode, event: Record<string, unknown>, at: number): void {
    const toolUseId = stringOf(event.toolCallId, 256);
    if (!toolUseId || !validKimiToolCallId(toolUseId)) return;
    node.toolUses++;
    this.timeline(node, {
      type: 'tool.start', agentId: node.agentId, toolUseId,
      name: stringOf(event.name, 200) ?? 'tool', input: record(event.args) ?? {}, at,
    });
    this.emitProgress(node, 'tool.call');
  }

  private toolResult(node: GraphNode, event: Record<string, unknown>, at: number): void {
    const toolUseId = stringOf(event.toolCallId, 256);
    if (!toolUseId || !validKimiToolCallId(toolUseId)) return;
    const result = record(event.result);
    const content = outputText(result?.output ?? event.result).slice(0, 4000);
    this.timeline(node, {
      type: 'tool.result', agentId: node.agentId, toolUseId,
      isError: result?.isError === true, content,
      ...(event.result !== undefined ? { result: event.result } : {}), at,
      ...(typeof result?.durationMs === 'number' ? { durationMs: Math.max(0, result.durationMs) } : {}),
    });
  }

  private emitStart(node: GraphNode, at: number): void {
    node.emitted = true;
    const event: Extract<AgentEvent, { type: 'agent.start' }> = {
      type: 'agent.start', agentId: node.agentId, taskId: node.taskId,
      description: node.description, taskType: node.taskType,
      ...(node.subagentType ? { subagentType: node.subagentType } : {}),
      background: node.background,
      ...(node.parentAgentId ? { parentAgentId: node.parentAgentId } : {}),
      ...(node.prompt ? { prompt: node.prompt } : {}),
      ...(node.model ? { model: node.model } : {}),
      ...(node.reasoningEffort ? { reasoningEffort: node.reasoningEffort } : {}),
      at,
    };
    node.startEvent = event;
    this.emit(event);
  }

  private emitProgress(node: GraphNode, status: string): void {
    this.emit({
      type: 'agent.progress', agentId: node.agentId, taskId: node.taskId, status,
      ...(node.description ? { description: node.description } : {}),
      ...(node.totalTokens !== undefined ? { totalTokens: node.totalTokens } : {}),
      toolUses: node.toolUses,
      ...(node.endedAt !== undefined ? { durationMs: Math.max(0, node.endedAt - node.startedAt) } : {}),
    });
  }

  private endNode(node: GraphNode, status: Exclude<NodeStatus, 'running'>, at: number, summary?: string): void {
    if (node.status !== 'running') return;
    node.status = status;
    node.endedAt = at;
    if (summary) node.summary = summary;
    this.emit({
      type: 'agent.end', agentId: node.agentId, taskId: node.taskId, status,
      ...(node.summary ? { summary: node.summary } : {}),
      ...(node.totalTokens !== undefined ? { totalTokens: node.totalTokens } : {}),
      toolUses: node.toolUses,
      durationMs: Math.max(0, at - node.startedAt), at,
    });
  }

  private timeline(node: GraphNode, event: AgentEvent): void {
    if (node.timelineEvents >= this.options.maxEventsPerAgent) return;
    node.timelineEvents++;
    this.emit(event);
  }
}

/** Restore graph events and place every durable tree next to its proven ACP anchor in the correct main turn. */
export async function appendKimiSubagentHistory(
  mainEvents: AgentEvent[],
  root: string,
  options: { tasksAlive?: boolean; log?: (message: string) => void } = {},
): Promise<AgentEvent[]> {
  const graphEvents: AgentEvent[] = [];
  const tracker = new KimiSubagentTracker(root, (event) => graphEvents.push(event), {
    deferAcpStart: true,
    maxEventsPerAgent: Number.MAX_SAFE_INTEGER,
    log: options.log,
  });
  for (const event of mainEvents) tracker.observeEvent(event);
  // A poll can discover a nested reader in its parent's wire; bounded depth prevents recursive persistence.
  for (let i = 0; i <= 10; i++) {
    if (await tracker.poll() === 0) break;
  }
  tracker.finishHistory(options.tasksAlive === true);
  const selected = tracker.historyEvents(graphEvents);
  tracker.dispose();

  const parent = new Map<string, string | undefined>();
  for (const event of selected) {
    if (event.type === 'agent.start') parent.set(event.agentId, event.parentAgentId);
  }
  const anchors = new Map<string, string>();
  const anchorOf = (agentId: string): string | undefined => {
    const cached = anchors.get(agentId);
    if (cached) return cached;
    let current = agentId;
    const seen = new Set<string>();
    while (seen.size <= KIMI_HISTORY_AGENTS && !seen.has(current)) {
      seen.add(current);
      const p = parent.get(current);
      if (!p) {
        const anchor = tracker.anchorFor(current) ?? current;
        anchors.set(agentId, anchor);
        return anchor;
      }
      current = p;
    }
    return undefined;
  };
  const groups = new Map<string, AgentEvent[]>();
  for (const event of selected) {
    if (!event.agentId) continue;
    const anchor = anchorOf(event.agentId);
    if (!anchor) continue;
    groups.set(anchor, [...(groups.get(anchor) ?? []), event]);
  }
  const out = [...mainEvents];
  const inserts = [...groups].sort((a, b) => {
    const ai = out.findIndex((event) => event.type === 'tool.start' && event.toolUseId === a[0]);
    const bi = out.findIndex((event) => event.type === 'tool.start' && event.toolUseId === b[0]);
    return bi - ai;
  });
  for (const [anchor, events] of inserts) {
    const index = out.findIndex((event) => event.type === 'tool.start' && event.toolUseId === anchor);
    if (index >= 0) out.splice(index + 1, 0, ...events);
  }
  return out;
}

function clipped(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

/** Pure bounded Markdown formatter, exported for limit tests without manufacturing large persistence files. */
export function kimiSubagentMarkdown(
  records: readonly Record<string, unknown>[],
  meta: { title: string; taskId: string; maxChars?: number },
): string {
  const t = hostStrings('ru');
  const parts = [`# ${meta.title || meta.taskId} · ${meta.taskId}`, '', t.agentReadOnly, ''];
  let prompted = false;
  for (const row of records.slice(0, MAX_TRANSCRIPT_RECORDS)) {
    if (row.type === 'turn.prompt') {
      const input = Array.isArray(row.input) ? row.input : [];
      const text = input.map((item) => record(item)?.text).filter((v): v is string => typeof v === 'string').join('\n');
      if (text) {
        parts.push(prompted ? t.agentMessage : t.agentPrompt, '', clipped(text, 20_000), '');
        prompted = true;
      }
      continue;
    }
    if (row.type !== 'context.append_loop_event') continue;
    const event = record(row.event);
    if (!event) continue;
    if (event.type === 'content.part') {
      const part = record(event.part);
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(clipped(part.text, 20_000), '');
      if (part?.type === 'think' && typeof part.think === 'string') {
        parts.push(`> ${t.agentThinking} ${clipped(part.think.replace(/\s+/g, ' ').trim(), 400)}`, '');
      }
    } else if (event.type === 'tool.call') {
      const input = clipped(JSON.stringify(record(event.args) ?? {}), 300);
      parts.push(`**${stringOf(event.name, 200) ?? 'tool'}** \`${input}\``, '');
    } else if (event.type === 'tool.result') {
      const result = record(event.result);
      const text = clipped(outputText(result?.output ?? event.result), 3000);
      parts.push(result?.isError === true ? t.agentError : t.agentResult, '', '```', text, '```', '');
    }
  }
  const max = meta.maxChars ?? 200_000;
  const markdown = parts.join('\n');
  return markdown.length > max ? `${markdown.slice(0, Math.max(0, max - 2))}…\n` : markdown;
}

export async function kimiSubagentTranscript(
  root: string,
  taskId: string,
  title: string,
): Promise<string | undefined> {
  if (!validKimiAgentId(taskId) || taskId === 'main') return undefined;
  const file = await safeKimiFile(root, ['agents', taskId, 'wire.jsonl']);
  if (!file) return undefined;
  const read = await new KimiWireReader(file).read(MAX_TRANSCRIPT_BYTES);
  if (!read.supported || !read.records.length) return undefined;
  return kimiSubagentMarkdown(read.records, { title, taskId });
}
