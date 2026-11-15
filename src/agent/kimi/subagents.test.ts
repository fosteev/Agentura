import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { agentGraphView } from '../../webview/agentViews';
import { graphLayout } from '../../webview/agentsGraph/layout';
import { graphModel } from '../../webview/agentsGraph/model';
import { agentDetail, agentMapView } from '../../webview/agentsView';
import { applyHud, initialHud } from '../../webview/hudState';
import { KimiAdapter } from './adapter';
import { createFakeKimiServer } from './fakeServer';
import { buildKimiHistory } from './history';
import {
  KimiSubagentTracker,
  KimiWireReader,
  appendKimiSubagentHistory,
  findKimiSessionRoot,
  hasKimiSessionActivity,
  kimiSubagentMarkdown,
  kimiSubagentTranscript,
  parseKimiState,
  rawKimiToolCallId,
  validKimiAgentId,
  validKimiSessionId,
  validKimiTaskId,
} from './subagents';

const FIXTURES = join(__dirname, '../../../test/fixtures/kimi');
const GRAPH = join(FIXTURES, 'graph');
const BASE_ID = 'session_958f96d9-4d41-4c03-a823-da95a32e43b1';
const NESTED_ID = 'session_4ed9dfe6-3fec-4809-9953-3fafc715408a';

interface Frame {
  dir: string;
  scenario: string;
  msg: { method?: string; params?: { update?: unknown }; result?: unknown };
}

async function replay(name: 'base' | 'nested-resume'): Promise<Frame[]> {
  return (await readFile(join(GRAPH, name, 'acp-replay.ndjson'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Frame);
}

async function mainHistory(name: 'base' | 'nested-resume'): Promise<AgentEvent[]> {
  const frames = await replay(name);
  const updates = frames.filter((frame) => frame.dir === 'out' && frame.msg.method === 'session/update')
    .map((frame) => frame.msg.params?.update);
  const result = frames.find((frame) => frame.msg.result)?.msg.result;
  return buildKimiHistory(updates, result, { now: () => 1000 }).events;
}

async function restored(name: 'base' | 'nested-resume', tasksAlive = false): Promise<AgentEvent[]> {
  return appendKimiSubagentHistory(await mainHistory(name), join(GRAPH, name), { tasksAlive });
}

function graph(events: AgentEvent[], turn?: number): ReturnType<typeof graphModel> & { hud: ReturnType<typeof initialHud> } {
  const hud = events.reduce((state, event) => applyHud(state, event, 5000), initialHud());
  const latest = Math.max(5000, ...hud.agents.map((agent) => agent.endedAt ?? agent.startedAt)) + 1000;
  const snapshot = agentGraphView(hud, { state: 'idle' });
  return { ...graphModel(snapshot, { now: latest, hasSession: true, ...(turn !== undefined ? { turn } : {}) }), hud };
}

function start(toolUseId: string, name = 'Agent', input: Record<string, unknown> = {}): AgentEvent {
  return { type: 'tool.start', toolUseId, name, input, at: 1000 };
}

async function wireLines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).trimEnd().split('\n');
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout: ${what}`);
}

describe('Kimi wire reader and safe persistence paths', () => {
  it('keeps byte offset and an incomplete final line until its newline arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-wire-'));
    const file = join(dir, 'wire.jsonl');
    try {
      const lines = await wireLines(join(FIXTURES, 'wire-background-child.ndjson'));
      const whole = `${lines.slice(0, 4).join('\n')}\n`;
      const partial = lines[4]!.slice(0, 80);
      await writeFile(file, whole + partial);
      const reader = new KimiWireReader(file);
      const first = await reader.read();
      expect(first.supported).toBe(true);
      expect(first.records.map((row) => row.type)).toEqual([
        'turn.prompt', 'context.append_loop_event', 'usage.record',
      ]);
      expect(reader.offset).toBe(Buffer.byteLength(whole));
      expect((await reader.read()).records).toEqual([]);
      expect(reader.offset).toBe(Buffer.byteLength(whole));

      await appendFile(file, `${lines[4]!.slice(80)}\n${lines[5]}\n`);
      const second = await reader.read();
      expect(second.records.map((row) => row.type)).toEqual([
        'context.append_loop_event', 'context.append_loop_event',
      ]);
      expect(reader.offset).toBe(Buffer.byteLength(await readFile(file)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid ids, traversal, state/version mismatch and symlink escape softly', async () => {
    expect(validKimiSessionId(BASE_ID)).toBe(true);
    expect(validKimiSessionId('../credentials')).toBe(false);
    expect(validKimiAgentId('agent-0')).toBe(true);
    expect(validKimiAgentId('agent-0/../main')).toBe(false);
    expect(validKimiTaskId('agent-lowt8fos')).toBe(true);
    expect(validKimiTaskId('agent-0')).toBe(false);
    expect(rawKimiToolCallId('synthetic:tool_ABC')).toBe('tool_ABC');
    expect(rawKimiToolCallId('synthetic:../../tool_ABC')).toBeUndefined();
    const state = JSON.parse(await readFile(join(GRAPH, 'base/state.json'), 'utf8')) as unknown;
    expect(parseKimiState(state, BASE_ID)?.agents.get('agent-1')?.profileName).toBe('coder');
    expect(parseKimiState(state, NESTED_ID)).toBeUndefined();
    expect(parseKimiState({ ...(state as object), version: 3 }, BASE_ID)).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-path-'));
    try {
      const root = join(dir, 'root');
      await mkdir(join(root, 'agents/agent-0'), { recursive: true });
      await writeFile(join(dir, 'outside.jsonl'), '{}\n');
      await symlink(join(dir, 'outside.jsonl'), join(root, 'agents/agent-0/wire.jsonl'));
      expect(await kimiSubagentTranscript(root, '../agent-0', 'bad')).toBeUndefined();
      expect(await kimiSubagentTranscript(root, 'agent-0', 'escape')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not map records after an unsupported protocol metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-version-'));
    const file = join(dir, 'wire.jsonl');
    try {
      await writeFile(file, [
        { type: 'metadata', protocol_version: '2.0', min_protocol_version: '2.0' },
        { type: 'usage.record', agentId: 'agent-0', usage: { output: 1 } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      const read = await new KimiWireReader(file).read();
      expect(read).toEqual({ records: [], supported: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Kimi durable graph → panel and AgentsGraph', () => {
  it('restores parallel agents with prompts, token totals and summaries from graph/base', async () => {
    const events = await restored('base');
    const all = graph(events);
    const parallel = all.hud.agents.filter((agent) => agent.description.startsWith('Return parallel'));
    const view = graph(events, parallel[0]?.turnNo);
    expect(parallel).toHaveLength(2);
    expect(parallel.map((agent) => agent.status)).toEqual(['completed', 'completed']);
    expect(parallel.map((agent) => agent.summary)).toEqual(['PAR_A_MARKER_1103', 'PAR_B_MARKER_1104']);
    expect(parallel.map((agent) => agent.tokens)).toEqual([9801, 9794]);
    expect(parallel.map((agent) => agent.subagentType)).toEqual(['explore', 'explore']);
    expect(view.layout.agents).toHaveLength(2);
    expect(graphLayout(view.layout, 1200, 700).edges.map((edge) => edge.from)).toEqual(['main', 'main']);
    expect(view.nodes.find((node) => node.title === 'Return parallel marker A')).toMatchObject({
      status: 'ok', tokens: '9.8k',
    });
  });

  it('uses durable nested parent, restores resume as a running-then-completed call without losing timeline', async () => {
    const events = await restored('nested-resume');
    const view = graph(events);
    const outerId = '5:tool_KQ14pyIBiHm0khrHCvqtqSgc';
    const nested = view.hud.agents.find((agent) => agent.agentId === 'tool_d7FS3K9gwCob94h7qlq6xWhM');
    const outer = view.hud.agents.find((agent) => agent.agentId === outerId);
    const resumed = view.hud.agents.filter((agent) => agent.taskId === 'agent-0');
    expect(nested).toMatchObject({
      parentAgentId: outerId, status: 'completed', summary: 'NESTED_MARKER_842', tokens: 9807,
    });
    expect(nested?.prompt).toContain('Return exactly NESTED_MARKER_842');
    expect(outer).toMatchObject({ subagentType: 'nester', summary: 'OUTER_MARKER_841 NESTED_MARKER_842' });
    expect(nested?.parentAgentId).not.toBe('main');
    expect(nested?.parentAgentId).not.toBe('agent-1');
    expect(resumed).toHaveLength(2);
    expect(resumed.map((agent) => agent.status)).toEqual(['completed', 'completed']);
    expect(resumed.map((agent) => agent.summary)).toEqual(['RESUME_BASE_MARKER_1601', 'RESUME_OK_MARKER_1602']);
    expect(resumed[1]?.segs.length).toBeGreaterThanOrEqual(2);
    expect(view.layout.agents.find((agent) => agent.id === nested?.agentId)).toMatchObject({
      parentId: outerId, depth: 1,
    });
    expect(graphLayout(view.layout, 1400, 700).edges.find((edge) => edge.id === nested?.agentId)?.from).toBe(outerId);

    const panel = agentMapView(view.hud, {
      selected: nested!.agentId, working: false, waiting: false, now: 1794548960000, hasSession: true,
    });
    expect(panel.detail).toMatchObject({ taskId: 'agent-2', transcript: true, summary: 'NESTED_MARKER_842' });
    expect(panel.rows.find((row) => row.agentId === nested?.agentId)?.depth).toBe(2);
  });

  it('live resume uses a new ACP call for the same subagent and preserves the earlier node timeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-resume-'));
    try {
      const root = join(dir, 'session');
      await mkdir(join(root, 'agents/main'), { recursive: true });
      await mkdir(join(root, 'agents/agent-0'), { recursive: true });
      const main = await wireLines(join(GRAPH, 'nested-resume/agents/main/wire.jsonl'));
      const child = await wireLines(join(GRAPH, 'nested-resume/agents/agent-0/wire.jsonl'));
      await writeFile(join(root, 'agents/main/wire.jsonl'), `${main.slice(0, 8).join('\n')}\n`);
      await writeFile(join(root, 'agents/agent-0/wire.jsonl'), `${child.slice(0, 6).join('\n')}\n`);
      const events: AgentEvent[] = [];
      const tracker = new KimiSubagentTracker(root, (event) => events.push(event));
      const first = start('1:tool_YxcmEMYZzJ3KaLQFCyEr7slB', 'Agent', {
        description: 'Return requested marker', prompt: 'base', subagent_type: 'explore',
      });
      tracker.observeEvent(first);
      await tracker.poll();
      const second = start('3:tool_8ZGWTXIWiBXO8KmxXB7ScEFM', 'Agent', {
        description: 'Resume requested marker', prompt: 'resume', resume: 'agent-0',
      });
      tracker.observeEvent(second);
      const running = graph([first, ...events]).hud.agents;
      expect(running).toHaveLength(2);
      expect(running[0]).toMatchObject({ status: 'completed', summary: 'RESUME_BASE_MARKER_1601' });
      expect(running[0]?.segs.length).toBeGreaterThan(0);
      expect(running[1]).toMatchObject({ status: 'running', taskId: 'agent-0' });
      expect(running[1]?.endedAt).toBeUndefined();

      await appendFile(join(root, 'agents/main/wire.jsonl'), `${main.slice(8, 12).join('\n')}\n`);
      await appendFile(join(root, 'agents/agent-0/wire.jsonl'), `${child.slice(6, 11).join('\n')}\n`);
      await tracker.poll();
      const done = graph([first, ...events]).hud.agents;
      expect(done.map((agent) => agent.taskId)).toEqual(['agent-0', 'agent-0']);
      expect(done[1]).toMatchObject({ status: 'completed', summary: 'RESUME_OK_MARKER_1602' });
      expect(done[0]?.segs.length).toBeGreaterThan(0);
      expect(done[1]?.segs.length).toBeGreaterThan(0);
      tracker.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps background agent and its live Bash call after main turn, then closes terminal watchers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-background-'));
    try {
      const root = join(dir, 'session');
      await mkdir(join(root, 'agents/main'), { recursive: true });
      await mkdir(join(root, 'agents/agent-0'), { recursive: true });
      const mainLines = await wireLines(join(FIXTURES, 'wire-background-main.ndjson'));
      await writeFile(join(root, 'agents/main/wire.jsonl'), `${mainLines.slice(0, 15).join('\n')}\n`);
      await cp(join(FIXTURES, 'wire-background-child.ndjson'), join(root, 'agents/agent-0/wire.jsonl'));
      const events: AgentEvent[] = [];
      const tracker = new KimiSubagentTracker(root, (event) => events.push(event));
      const toolCall = start('0:tool_yC6qdFrdpHIPzw81IFl6xEwL', 'Agent', {
        description: 'Run background marker', prompt: 'Use Bash', run_in_background: true, subagent_type: 'coder',
      });
      tracker.observeEvent(toolCall);
      await tracker.poll();
      expect(events.some((event) => event.type === 'agent.start' && event.taskId === 'agent-0')).toBe(true);
      expect(events.some((event) => event.type === 'tool.start' && event.agentId && event.name === 'Bash')).toBe(true);
      expect(tracker.activeWatcherCount).toBe(2);

      const aliveHistory = await appendKimiSubagentHistory([toolCall], root, { tasksAlive: true });
      const stoppedHistory = await appendKimiSubagentHistory([toolCall], root, { tasksAlive: false });
      expect(graph(aliveHistory).hud.agents[0]).toMatchObject({ status: 'running', background: true });
      expect(graph(stoppedHistory).hud.agents[0]).toMatchObject({ status: 'stopped', background: true });

      const result: AgentEvent = {
        type: 'turn.result', ok: true, subtype: 'end_turn', interrupted: false,
        durationMs: 1, apiDurationMs: 0, numTurns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        totalCostUsd: 0, permissionDenials: [],
      };
      const afterMain = graph([toolCall, ...events, result]).hud.agents.find((agent) => agent.taskId === 'agent-0');
      expect(afterMain).toMatchObject({ status: 'running', background: true, calls: 1 });
      expect(agentDetail(afterMain!, Date.now()).meta.some((row) => row.value === '1')).toBe(true);

      await appendFile(join(root, 'agents/main/wire.jsonl'), `${mainLines.slice(15, 17).join('\n')}\n`);
      await tracker.poll();
      const done = graph([toolCall, ...events, result]).hud.agents.find((agent) => agent.taskId === 'agent-0');
      expect(done).toMatchObject({ status: 'completed', summary: 'BG_WAIT_MARKER_1701', calls: 1 });
      expect(done?.tokens).toBeGreaterThan(0);
      expect(tracker.activeWatcherCount).toBe(1);
      tracker.dispose();
      expect(tracker.activeWatcherCount).toBe(0);
      expect(await tracker.poll()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses bounded task output as the terminal summary when subagent resultSummary is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-task-output-'));
    try {
      const root = join(dir, 'session');
      await mkdir(join(root, 'agents/main/tasks/agent-e1ss9zma'), { recursive: true });
      await mkdir(join(root, 'agents/agent-0'), { recursive: true });
      const lines = await wireLines(join(FIXTURES, 'wire-background-main.ndjson'));
      await writeFile(join(root, 'agents/main/wire.jsonl'), `${[...lines.slice(0, 15), lines[16]].join('\n')}\n`);
      await writeFile(join(root, 'agents/main/tasks/agent-e1ss9zma/output.log'), 'BG_WAIT_MARKER_1701\n');
      await cp(join(FIXTURES, 'wire-background-child.ndjson'), join(root, 'agents/agent-0/wire.jsonl'));
      const events = await appendKimiSubagentHistory([start('0:tool_yC6qdFrdpHIPzw81IFl6xEwL', 'Agent', {
        description: 'Run background marker', run_in_background: true,
      })], root, { tasksAlive: true });
      expect(graph(events).hud.agents[0]).toMatchObject({
        status: 'completed', summary: 'BG_WAIT_MARKER_1701', taskId: 'agent-0',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tracks background Bash tasksAlive and terminal output independently of the main turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-shell-'));
    try {
      const root = join(dir, 'session');
      await mkdir(join(root, 'agents/main/tasks/agent-shell1'), { recursive: true });
      const metadata = { type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' };
      const info = {
        taskId: 'agent-shell1', description: 'sleep', status: 'running', detached: true,
        startedAt: 1000, endedAt: null, kind: 'shell', parentToolCallId: 'tool_shell',
      };
      await writeFile(join(root, 'agents/main/wire.jsonl'),
        `${[metadata, { type: 'task.started', agentId: 'main', info, time: 1001 }].map((row) => JSON.stringify(row)).join('\n')}\n`);
      await writeFile(join(root, 'agents/main/tasks/agent-shell1/output.log'), 'SHELL_DONE\n');
      const call = start('1:tool_shell', 'Bash', { command: 'sleep 1' });
      const alive = await appendKimiSubagentHistory([call], root, { tasksAlive: true });
      expect(graph(alive).hud.agents[0]).toMatchObject({
        status: 'running', taskType: 'local_bash', background: true, taskId: 'agent-shell1',
      });
      await appendFile(join(root, 'agents/main/wire.jsonl'), `${JSON.stringify({
        type: 'task.terminated', agentId: 'main', time: 2000,
        info: { ...info, status: 'completed', endedAt: 2000 },
      })}\n`);
      const done = await appendKimiSubagentHistory([call], root);
      expect(graph(done).hud.agents[0]).toMatchObject({ status: 'completed', summary: 'SHELL_DONE' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips orphan, cycle and unknown records instead of fabricating links', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-orphan-'));
    try {
      const root = join(dir, 'session');
      const metadata = { type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' };
      const spawned = (subagentId: string, parentAgentId: string, parentToolCallId: string, taskId: string) => ({
        type: 'subagent.spawned', subagentId, parentAgentId, parentToolCallId, taskId,
        description: subagentId, runInBackground: false,
      });
      const writeWire = async (agent: string, rows: unknown[]) => {
        await mkdir(join(root, 'agents', agent), { recursive: true });
        await writeFile(join(root, 'agents', agent, 'wire.jsonl'),
          `${[metadata, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`);
      };
      await writeWire('main', [
        { type: 'future.unknown', value: 1 },
        spawned('agent-9', 'main', 'tool_orphan', 'agent-orphan'),
        spawned('agent-0', 'main', 'tool_parent', 'agent-task0'),
      ]);
      await writeWire('agent-0', [
        spawned('agent-1', 'agent-0', 'tool_child', 'agent-task1'),
        spawned('agent-0', 'agent-0', 'tool_self', 'agent-self'),
        { type: 'another.unknown' },
      ]);
      await writeWire('agent-1', [spawned('agent-0', 'agent-1', 'tool_cycle', 'agent-cycle')]);
      const events: AgentEvent[] = [];
      const tracker = new KimiSubagentTracker(root, (event) => events.push(event));
      tracker.observeEvent(start('1:tool_parent'));
      for (let i = 0; i < 4; i++) await tracker.poll();
      const ids = events.filter((event) => event.type === 'agent.start').map((event) => event.agentId);
      expect(ids).toContain('1:tool_parent');
      expect(ids).toContain('tool_child');
      expect(ids).not.toContain('tool_orphan');
      expect(ids).not.toContain('tool_self');
      expect(ids).not.toContain('tool_cycle');
      tracker.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('failed AgentSwarm is terminal and never becomes a pretend running swarm', async () => {
    const events: AgentEvent[] = [];
    const tracker = new KimiSubagentTracker(Promise.resolve(undefined), (event) => events.push(event));
    const call = start('0:tool_swarm', 'AgentSwarm', {
      description: 'Rejected swarm', prompt_template: '{{item}}', items: ['a'], subagent_type: 'explore',
    });
    tracker.observeEvent(call);
    tracker.observeEvent({
      type: 'tool.result', toolUseId: '0:tool_swarm', isError: true, content: 'Swarm mode is off', at: 1001,
    });
    const agents = graph([call, ...events]).hud.agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ status: 'failed', summary: 'Swarm mode is off' });
    expect(events.some((event) => event.type === 'agent.end' && event.status === 'failed')).toBe(true);
    tracker.dispose();
  });
});

describe('Kimi history limits and read-only transcripts', () => {
  it('bounds restored graph to last 30 agents and last 400 events while retaining agent.start', async () => {
    const events: AgentEvent[] = [];
    const tracker = new KimiSubagentTracker(Promise.resolve(undefined), (event) => events.push(event), {
      deferAcpStart: true,
    });
    for (let i = 0; i < 31; i++) {
      const id = `${i}:tool_${i}`;
      tracker.observeEvent(start(id, 'AgentSwarm', { description: `rejected-${i}` }));
      tracker.observeEvent({ type: 'tool.result', toolUseId: id, isError: true, content: 'off', at: 1000 + i });
    }
    const limited = tracker.historyEvents(events);
    const ids = new Set(limited.map((event) => event.agentId));
    expect(ids.size).toBe(30);
    expect(ids.has('0:tool_0')).toBe(false);
    expect(ids.has('30:tool_30')).toBe(true);
    tracker.dispose();

    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-limit-'));
    try {
      const root = join(dir, 'session');
      await mkdir(join(root, 'agents/main'), { recursive: true });
      await mkdir(join(root, 'agents/agent-0'), { recursive: true });
      const metadata = { type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' };
      const spawn = {
        type: 'subagent.spawned', subagentId: 'agent-0', parentAgentId: 'main',
        parentToolCallId: 'tool_many', taskId: 'agent-many', description: 'many', runInBackground: false,
      };
      await writeFile(join(root, 'agents/main/wire.jsonl'), `${[metadata, spawn].map((row) => JSON.stringify(row)).join('\n')}\n`);
      const usage = Array.from({ length: 450 }, (_, i) => ({
        type: 'usage.record', agentId: 'agent-0', model: 'model', time: 1000 + i,
        usage: { inputOther: 1, output: 1 },
      }));
      await writeFile(join(root, 'agents/agent-0/wire.jsonl'),
        `${[metadata, ...usage].map((row) => JSON.stringify(row)).join('\n')}\n`);
      const restoredEvents = await appendKimiSubagentHistory([start('1:tool_many')], root);
      expect(restoredEvents.some((event) => event.type === 'agent.start')).toBe(true);
      expect(restoredEvents.filter((event) => event.agentId === '1:tool_many')).toHaveLength(401);
      expect(restoredEvents.filter((event) => event.type === 'usage.message')).toHaveLength(199);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('formats real child wire as bounded read-only Markdown', async () => {
    const root = join(GRAPH, 'base');
    const markdown = await kimiSubagentTranscript(root, 'agent-0', 'Foreground');
    expect(markdown).toContain('FG_MARKER_1101');
    expect(markdown).toContain('Foreground · agent-0');
    expect(await kimiSubagentTranscript(root, 'agent-0/../../main', 'bad')).toBeUndefined();

    const records = await new KimiWireReader(join(FIXTURES, 'wire-background-child.ndjson')).read();
    const clipped = kimiSubagentMarkdown(records.records, { title: 'Background', taskId: 'agent-0', maxChars: 500 });
    expect(clipped.length).toBeLessThanOrEqual(502);
    expect(clipped.endsWith('…\n')).toBe(true);
  });

  it('adapter loadHistory joins replay and persistence; agentTranscript uses the same read-only root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-home-'));
    try {
      const home = join(dir, 'home');
      const root = join(home, 'sessions/wd_test', BASE_ID);
      await mkdir(dirname(root), { recursive: true });
      await cp(join(GRAPH, 'base'), root, { recursive: true });
      expect(await findKimiSessionRoot(BASE_ID, home)).toBe(await import('node:fs/promises').then((fs) => fs.realpath(root)));

      const server = createFakeKimiServer(BASE_ID);
      const frames = await replay('base');
      server.handle('session/load', (params) => {
        for (const frame of frames) {
          if (frame.dir === 'out' && frame.msg.method === 'session/update') {
            server.update(String(params.sessionId), frame.msg.params?.update);
          }
        }
        return frames.find((frame) => frame.msg.result)?.msg.result;
      });
      const adapter = new KimiAdapter({ executablePath: '/bin/kimi', spawn: () => server, env: { KIMI_CODE_HOME: home } });
      const history = await adapter.loadHistory(BASE_ID, '/work');
      expect(graph(history.events).hud.agents).toHaveLength(5);
      expect(graph(history.events).hud.agents.filter((agent) => agent.status === 'completed')).toHaveLength(4);
      expect(graph(history.events).hud.agents.find((agent) => agent.status === 'failed')?.summary).toContain('Swarm mode is off');
      expect(server.methods()).not.toContain('session/delete');
      const transcript = await adapter.agentTranscript(BASE_ID, '/work', 'agent-0', 'Foreground');
      expect(transcript).toContain('FG_MARKER_1101');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('live adapter emits ACP-linked durable graph after the main turn and disposes its watcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-live-'));
    const sessionId = 'session_live_123';
    try {
      const home = join(dir, 'home');
      const root = join(home, 'sessions/wd_test', sessionId);
      await mkdir(join(root, 'agents/main'), { recursive: true });
      await mkdir(join(root, 'agents/agent-0'), { recursive: true });
      await writeFile(join(root, 'state.json'), JSON.stringify({
        id: sessionId, version: 2, agents: { main: { type: 'main' }, 'agent-0': { type: 'sub' } },
      }));
      await cp(join(FIXTURES, 'wire-background-main.ndjson'), join(root, 'agents/main/wire.jsonl'));
      await cp(join(FIXTURES, 'wire-background-child.ndjson'), join(root, 'agents/agent-0/wire.jsonl'));
      const server = createFakeKimiServer(sessionId);
      server.handle('session/prompt', () => {
        server.update(sessionId, {
          sessionUpdate: 'tool_call', toolCallId: '0:tool_yC6qdFrdpHIPzw81IFl6xEwL', title: 'Agent', status: 'in_progress',
          rawInput: { description: 'Run background marker', prompt: 'Use Bash', run_in_background: true, subagent_type: 'coder' },
        });
        return { stopReason: 'end_turn' };
      });
      const adapter = new KimiAdapter({
        executablePath: '/bin/kimi', spawn: () => server, env: { KIMI_CODE_HOME: home }, subagentPollMs: 5, graceMs: 20,
      });
      const session = await adapter.createSession({ cwd: '/work' });
      const events: AgentEvent[] = [];
      session.events.on((event) => events.push(event));
      await session.capabilities();
      session.send('background');
      await until(() => events.some((event) => event.type === 'agent.end'), 'durable background completion');
      const agentId = '0:tool_yC6qdFrdpHIPzw81IFl6xEwL';
      const latestStart = events.filter((event) => event.type === 'agent.start' && event.agentId === agentId).at(-1);
      expect(latestStart).toMatchObject({
        taskId: 'agent-0', background: true, subagentType: 'coder', prompt: expect.stringContaining('Use Bash'),
      });
      expect(events.some((event) => event.type === 'tool.start' && event.agentId === agentId && event.name === 'Bash')).toBe(true);
      expect(events.find((event) => event.type === 'agent.end')).toMatchObject({
        agentId, status: 'completed', summary: 'BG_WAIT_MARKER_1701',
      });
      session.dispose();
      expect(events.at(-1)?.type).toBe('session.closed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hasKimiSessionActivity detects presence or absence of non-metadata wire activity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-kimi-act-'));
    try {
      const sessionId = 'session_a6b9fb6b-7f7d-404e-9cd1-777777777777';
      const root = join(dir, 'sessions/wd_act', sessionId);
      await mkdir(join(root, 'agents/main'), { recursive: true });
      await writeFile(join(root, 'state.json'), JSON.stringify({
        version: 2, id: sessionId, agents: { main: { type: 'main' } },
      }));

      // No wire.jsonl yet
      expect(await hasKimiSessionActivity(sessionId, { KIMI_CODE_HOME: dir })).toBe(false);

      // Wire.jsonl with only metadata
      const wirePath = join(root, 'agents/main/wire.jsonl');
      const meta = JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' });
      await writeFile(wirePath, meta + '\n');
      expect(await hasKimiSessionActivity(sessionId, { KIMI_CODE_HOME: dir })).toBe(false);

      // Wire.jsonl with metadata + real event
      const event = JSON.stringify({ type: 'context.append_loop_event', time: 1000 });
      await appendFile(wirePath, event + '\n');
      expect(await hasKimiSessionActivity(sessionId, { KIMI_CODE_HOME: dir })).toBe(true);

      // Invalid or non-existent session id
      expect(await hasKimiSessionActivity('bad-session-id', { KIMI_CODE_HOME: dir })).toBe(false);
      expect(await hasKimiSessionActivity('session_00000000-0000-0000-0000-000000000000', { KIMI_CODE_HOME: dir })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
