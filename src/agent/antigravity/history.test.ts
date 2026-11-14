import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEventOf } from '../types';
import { buildAgyHistory, withAgySubagentTimelines } from './history';

describe('antigravity history: buildAgyHistory', () => {
  it('builds turns from user_message_chunk and tool updates', () => {
    const updates = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'turn 1 prompt' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        name: 'run_command',
        status: 'completed',
        rawInput: { CommandLine: 'echo 1' },
        rawOutput: { output: '1\n', exit_code: 0 },
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done 1' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'turn 2 prompt' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done 2' } },
    ];

    const result = {
      sessionId: 'sess-1',
      configOptions: [{ id: 'model', currentValue: 'gemini-3.8-flash' }],
      modes: { currentModeId: 'default' },
    };

    const history = buildAgyHistory(updates, result, { now: () => 1000 });
    expect(history.turns).toBe(2);
    expect(history.skippedTurns).toBe(0);
    expect(history.model).toBeUndefined();
    expect(history.mode).toBeUndefined();

    const types = history.events.map((e) => e.type);
    expect(types).toEqual([
      'turn.start',
      'tool.start',
      'tool.result',
      'text.delta',
      'turn.result',
      'turn.start',
      'text.delta',
      'turn.result',
    ]);

    const toolStart = history.events.find((e) => e.type === 'tool.start');
    expect(toolStart).toMatchObject({
      type: 'tool.start',
      toolUseId: 'call_1',
      name: 'Bash',
      input: { command: 'echo 1' },
    });

    const toolResult = history.events.find((e) => e.type === 'tool.result');
    expect(toolResult).toMatchObject({
      type: 'tool.result',
      toolUseId: 'call_1',
      isError: false,
      content: '1\n',
    });
  });

  it('live: true leaves the last turn open without turn.result', () => {
    const updates = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'in progress turn' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } },
    ];

    const history = buildAgyHistory(updates, {}, { live: true, now: () => 1000 });
    const types = history.events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'text.delta']);
  });

  it('does not mistake load process mode for saved session mode', () => {
    const updates = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'plan something' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the plan' } },
    ];

    const result = {
      modes: { currentModeId: 'plan' },
    };

    const history = buildAgyHistory(updates, result);
    expect(history.mode).toBeUndefined();
  });

  it('reconstructs full history from acp-pong.ndjson load scenario', () => {
    const fixturePath = join(__dirname, '../../../test/fixtures/antigravity/acp-pong.ndjson');
    const lines = readFileSync(fixturePath, 'utf8').trim().split('\n');

    const updates: unknown[] = [];
    let loadResult: unknown = {};

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.scenario === 'load') {
        if (entry.dir === 'out' && entry.msg.method === 'session/update') {
          updates.push(entry.msg.params?.update);
        } else if (entry.dir === 'out' && entry.msg.result) {
          loadResult = entry.msg.result;
        }
      }
    }

    expect(updates.length).toBeGreaterThan(10);
    const history = buildAgyHistory(updates, loadResult);
    expect(history.model).toBeUndefined();
    expect(history.mode).toBeUndefined();
    expect(history.turns).toBeGreaterThan(0);
    expect(history.events.length).toBeGreaterThan(20);

    // Verify tools were mapped
    const toolStarts = history.events.filter((e) => e.type === 'tool.start');
    expect(toolStarts.length).toBeGreaterThan(0);
    const toolNames = toolStarts.map((t) => (t as { name: string }).name);
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');
    expect(toolNames).toContain('Edit');
    expect(toolNames).toContain('Bash');

    // Verify diff results exist
    const toolResults = history.events.filter((e) => e.type === 'tool.result');
    const withDiff = toolResults.filter((r) => {
      const res = (r as { result?: Record<string, unknown> }).result;
      return res && Array.isArray(res.structuredPatch);
    });
    expect(withDiff.length).toBeGreaterThan(0);
  });

  it('reconstructs subagent timelines, nested subagents, multi-round send_message, kill, and tasksAlive vs stopped', async () => {
    const tmpDir = await mkdtemp(join(os.tmpdir(), 'agy-history-subagents-'));
    const childCompleted = 'aaaaaaaa-1111-4222-8333-444444444444';
    const childRunning = 'bbbbbbbb-1111-4222-8333-444444444444';
    const childKilled = 'cccccccc-1111-4222-8333-444444444444';

    try {
      const writeBrain = async (uuid: string, steps: unknown[]) => {
        const dir = join(tmpDir, 'brain', uuid, '.system_generated', 'logs');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'transcript.jsonl'),
          steps.map((s) => JSON.stringify(s) + '\n').join(''),
          'utf8',
        );
      };

      // childCompleted: 2 rounds (initial + follow-up via send_message)
      await writeBrain(childCompleted, [
        { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Round 1 prompt' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 300,
          output_tokens: 20,
          tool_calls: [{ name: 'read_file', args: { Path: '/work/a.ts' } }],
        },
        { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'export const a = 1;' },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 400,
          output_tokens: 25,
          content: 'Round 1 summary',
        },
        { step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Round 2 follow-up' },
        {
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 500,
          output_tokens: 30,
          content: 'Round 2 final summary',
        },
      ]);

      // childRunning: still open (waiting on GENERIC)
      await writeBrain(childRunning, [
        { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Long task' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        },
      ]);

      // childKilled: open in transcript, killed by parent manage_subagents(kill)
      await writeBrain(childKilled, [
        { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Doomed task' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 60' } }],
        },
      ]);

      const updates = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'orchestrate subagents' } },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub_done',
          name: 'invoke_subagent',
          status: 'completed',
          rawInput: { TypeName: 'research', Role: 'Explorer', Prompt: 'Round 1 prompt' },
          rawOutput: { output: `Created the following subagent:\n{"conversationId":"${childCompleted}"}` },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub_msg',
          name: 'send_message',
          status: 'completed',
          rawInput: { Recipient: childCompleted, Message: 'Round 2 follow-up' },
          rawOutput: { output: 'Sent' },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub_open',
          name: 'invoke_subagent',
          status: 'completed',
          rawInput: { TypeName: 'self', Role: 'Tester', Prompt: 'Long task' },
          rawOutput: { output: `Created the following subagent:\n{"conversationId":"${childRunning}"}` },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub_kill',
          name: 'invoke_subagent',
          status: 'completed',
          rawInput: { TypeName: 'self', Role: 'Temp Worker', Prompt: 'Doomed task' },
          rawOutput: { output: `Created the following subagent:\n{"conversationId":"${childKilled}"}` },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'mgr_kill',
          name: 'manage_subagents',
          status: 'completed',
          rawInput: { Action: 'kill', ConversationIds: [childKilled] },
          rawOutput: { output: 'Killed' },
        },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Orchestration dispatched.' } },
      ];

      const base = buildAgyHistory(updates, {});

      // 1) Closed session (tasksAlive: false): childRunning gets closed as 'stopped'
      const closedEvents = await withAgySubagentTimelines(base.events, tmpDir, undefined, {
        live: false,
        tasksAlive: false,
      });
      const closedEnds = closedEvents.filter((e) => e.type === 'agent.end') as AgentEventOf<'agent.end'>[];
      expect(closedEnds.map((e) => [e.agentId, e.status])).toEqual([
        ['sub_done', 'completed'],
        ['sub_open', 'stopped'],
        ['sub_kill', 'stopped'],
      ]);
      expect(closedEnds.find((e) => e.agentId === 'sub_done')?.summary).toBe('Round 2 final summary');

      // 2) Live session (tasksAlive: true): childRunning remains open (no agent.end), childKilled is 'stopped'
      const liveEvents = await withAgySubagentTimelines(base.events, tmpDir, undefined, {
        tasksAlive: true,
      });
      const liveEnds = liveEvents.filter((e) => e.type === 'agent.end') as AgentEventOf<'agent.end'>[];
      expect(liveEnds.map((e) => [e.agentId, e.status])).toEqual([
        ['sub_done', 'completed'],
        ['sub_kill', 'stopped'],
      ]);
      expect(liveEvents.some((e) => e.type === 'agent.start' && e.agentId === 'sub_open')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
