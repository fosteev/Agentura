import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentLaunchRecord } from '../types';
import type { DynamicToolSpec, Thread } from './protocol';

export const LAUNCH_TOOL = 'agentura_record_agent_launch';
export const launchTool: DynamicToolSpec = {
  type: 'function', name: LAUNCH_TOOL,
  description: 'Before each direct child spawn_agent call, record its exact message and task_name here. ' +
    'Wait for success before spawning. Use the same message and parameters in spawn_agent. ' +
    'Use a unique task_name within the current turn. This only records intent; it does NOT launch an agent. ' +
    'Pass null for omitted model/effort, and the actual fork_turns default (all). ' +
    'If recording fails, report that and continue the user task; do not claim the launch was recorded. ' +
    'Only the main agent may call this tool, not its children.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['task_name', 'prompt', 'fork_turns', 'model', 'reasoning_effort'],
    properties: {
      task_name: { type: 'string', pattern: '^[a-z0-9_]+$', maxLength: 100 },
      prompt: { type: 'string', minLength: 1, maxLength: 200000 },
      fork_turns: { type: 'string', enum: ['all', 'none'] },
      model: { type: ['string', 'null'], maxLength: 200 },
      reasoning_effort: { type: ['string', 'null'], maxLength: 100 },
    },
  },
};

interface Stored extends AgentLaunchRecord { threadId: string; turnId: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (turn: string, name: string) => hash(JSON.stringify([turn, name]));
const result = (text: string, success = false) => ({ contentItems: [{ type: 'inputText', text }], success });
const nullableString = (v: unknown, max: number) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= max);
function validArgs(a: Record<string, unknown>): boolean {
  return typeof a['task_name'] === 'string' && /^[a-z0-9_]{1,100}$/.test(a['task_name']) &&
    typeof a['prompt'] === 'string' && !!a['prompt'].trim() && a['prompt'].length <= 200000 &&
    (a['fork_turns'] === 'all' || a['fork_turns'] === 'none') &&
    nullableString(a['model'], 200) && nullableString(a['reasoning_effort'], 100) &&
    Object.keys(a).every((k) => ['task_name', 'prompt', 'fork_turns', 'model', 'reasoning_effort'].includes(k));
}

/** Parent declarations, never substituted for native Codex metadata. No prompt text in logs. */
export class CodexLaunchRecords {
  private threadId = '';
  private readonly records = new Map<string, Stored>();
  private readonly children = new Map<string, string>();
  private readonly ambiguous = new Set<string>();
  private readonly starts = new Map<string, Extract<AgentEvent, { type: 'agent.start' }>>();
  constructor(private readonly directory = join(homedir(), '.local', 'share', 'agentura', 'agent-launches')) {}

  load(threadId: string): void {
    if (this.threadId === threadId) return;
    this.threadId = threadId;
    this.records.clear();
    this.children.clear();
    this.ambiguous.clear();
    this.starts.clear();
    const dir = join(this.directory, hash(threadId));
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Stored;
        if (r.threadId !== threadId || typeof r.turnId !== 'string' || r.source !== 'parent' ||
            !Number.isFinite(r.recordedAt) || !validArgs({ task_name: r.taskName, prompt: r.prompt,
              fork_turns: r.forkTurns, model: r.model, reasoning_effort: r.reasoningEffort })) continue;
        if (file === `${key(r.turnId, r.taskName)}.json`) this.records.set(key(r.turnId, r.taskName), r);
      } catch { /* A damaged record must not prevent opening the conversation. */ }
    }
  }

  call(params: unknown, threadId: string, turnId: string | undefined) {
    if (!params || typeof params !== 'object') return result('Invalid launch record request.');
    const p = params as Record<string, unknown>;
    if (!threadId || !turnId || p['threadId'] !== threadId || p['turnId'] !== turnId ||
        typeof p['callId'] !== 'string' || p['tool'] !== LAUNCH_TOOL ||
        (p['namespace'] !== undefined && p['namespace'] !== null)) return result('Invalid or stale launch record request.');
    const a = p['arguments'];
    if (!a || typeof a !== 'object' || Array.isArray(a) || !validArgs(a as Record<string, unknown>))
      return result('Invalid launch record arguments.');
    const args = a as { task_name: string; prompt: string; fork_turns: 'all' | 'none'; model: string | null; reasoning_effort: string | null };
    try {
      this.load(threadId);
      const id = key(turnId, args.task_name);
      const previous = this.records.get(id);
      if (previous) {
        const same = previous.prompt === args.prompt && previous.forkTurns === args.fork_turns &&
          previous.model === args.model && previous.reasoningEffort === args.reasoning_effort;
        return result(same ? 'Launch intent already recorded.' : 'Conflicting record. Use a unique task_name for a new launch.', same);
      }
      if ([...this.children.values()].includes(id)) return result('Agent already started. Only pre-launch records are accepted.');
      const record: Stored = { source: 'parent', threadId, turnId, taskName: args.task_name, prompt: args.prompt,
        forkTurns: args.fork_turns, model: args.model, reasoningEffort: args.reasoning_effort, recordedAt: Date.now() };
      const dir = join(this.directory, hash(threadId));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = join(dir, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        linkSync(temp, join(dir, `${id}.json`)); // Atomic, refuses to overwrite another writer's record.
      } finally { if (existsSync(temp)) unlinkSync(temp); }
      this.records.set(id, record);
      return result('Launch intent saved. Now spawn the child with exactly these arguments. This is a parent declaration, not a verified Codex launch.', true);
    } catch { return result('Could not save launch intent. No successful registration was confirmed.'); }
  }

  observe(turnId: string, item: unknown): AgentEvent[] {
    if (!item || typeof item !== 'object') return [];
    const i = item as Record<string, unknown>;
    if (i['type'] !== 'subAgentActivity' || i['kind'] !== 'started' ||
        typeof i['agentPath'] !== 'string' || typeof i['agentThreadId'] !== 'string') return [];
    const match = /^\/root\/([a-z0-9_]+)$/.exec(i['agentPath']);
    if (match && !this.children.has(i['agentThreadId'])) {
      const id = key(turnId, match[1]!);
      if ([...this.children.values()].includes(id)) {
        this.ambiguous.add(id);
        this.children.set(i['agentThreadId'], id);
        return [...this.starts.values()].filter((e) => this.children.get(e.agentId) === id)
          .map((e) => ({ ...e, launchRecord: null }));
      }
      this.children.set(i['agentThreadId'], id);
    }
    return [];
  }

  restore(thread: Thread): void {
    this.load(thread.id);
    for (const turn of thread.turns ?? []) for (const item of turn.items) this.observe(turn.id, item);
  }

  enrich(event: AgentEvent): AgentEvent {
    if (event.type !== 'agent.start') return event;
    this.starts.set(event.agentId, event);
    const id = this.children.get(event.agentId);
    if (id && this.ambiguous.has(id)) return { ...event, launchRecord: null };
    const r = id && !this.ambiguous.has(id) ? this.records.get(id) : undefined;
    if (!r) return event;
    const launchRecord: AgentLaunchRecord = { source: 'parent', taskName: r.taskName, prompt: r.prompt,
      forkTurns: r.forkTurns, model: r.model, reasoningEffort: r.reasoningEffort, recordedAt: r.recordedAt };
    return { ...event, launchRecord };
  }
}
