import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import {
  AgyParentTranscriptTailer,
  AgySubagentReader,
  MAX_SUBAGENT_EVENTS,
  MAX_SUBAGENT_TIMELINES,
  agySubagentMarkdown,
  agyTranscriptPath,
  isValidAgyUuid,
  nonZeroExitCode,
  normalizeTranscriptArgs,
  parseAgyUserSettingsModel,
  parseCreatedSubagent,
  parseManagedSubagents,
  readParentTranscriptSummary,
  resolveAgySubagentModelEffort,
  unwrapAgySystemMessage,
  withAgySubagentTimelines,
} from './subagents';

const PARENT_UUID = '11111111-2222-4333-8444-555555555555';
const CHILD_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NESTED_UUID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const THIRD_UUID = 'cccccccc-dddd-4eee-8fff-000000000000';

async function ensureBrainTranscript(dataDir: string, uuid: string, lines: unknown[] = []): Promise<string> {
  const dir = path.join(dataDir, 'brain', uuid.toLowerCase(), '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'transcript.jsonl');
  const body = lines.map((l) => JSON.stringify(l) + '\n').join('');
  await writeFile(file, body, 'utf8');
  return file;
}

describe('antigravity subagents: UUID validation & parsers', () => {
  it('validates canonical UUIDs and blocks path traversal in agyTranscriptPath', () => {
    expect(isValidAgyUuid(CHILD_UUID)).toBe(true);
    expect(isValidAgyUuid(CHILD_UUID.toUpperCase())).toBe(true);
    expect(isValidAgyUuid('')).toBe(false);
    expect(isValidAgyUuid('../etc/passwd')).toBe(false);
    expect(isValidAgyUuid(`${CHILD_UUID}/../secret`)).toBe(false);
    expect(isValidAgyUuid('not-a-uuid')).toBe(false);

    expect(agyTranscriptPath('../etc/passwd', '/tmp/agy')).toBeUndefined();
    expect(agyTranscriptPath(CHILD_UUID.toUpperCase(), '/tmp/agy')).toBe(
      path.join('/tmp/agy', 'brain', CHILD_UUID, '.system_generated', 'logs', 'transcript.jsonl'),
    );
  });

  it('extracts conversationId from invoke_subagent output', () => {
    const out = `Created the following subagent:\n{\n  "conversationId": "${CHILD_UUID.toUpperCase()}",\n  "typeName": "research"\n}`;
    expect(parseCreatedSubagent(out)).toBe(CHILD_UUID);
    expect(parseCreatedSubagent('Created the following subagent: {"conversationId":"../bad"}')).toBeUndefined();
    expect(parseCreatedSubagent('some unrelated tool output')).toBeUndefined();
  });

  it('parses manage_subagents list, kill, and kill_all actions', () => {
    const listOut = JSON.stringify({
      subagents: [
        { conversationId: CHILD_UUID.toUpperCase(), state: 'waiting_for_input' },
        { conversationId: NESTED_UUID, state: 'running' },
        { conversationId: '../bad', state: 'waiting_for_input' },
      ],
    });
    expect(parseManagedSubagents({ Action: 'list' }, listOut, false)).toEqual({
      action: 'list',
      waitingIds: [CHILD_UUID],
      killedIds: [],
      killAll: false,
    });

    expect(
      parseManagedSubagents(
        { Action: 'kill', ConversationIds: [CHILD_UUID.toUpperCase(), '../bad', NESTED_UUID] },
        'Killed subagents',
        false,
      ),
    ).toEqual({
      action: 'kill',
      waitingIds: [],
      killedIds: [CHILD_UUID, NESTED_UUID],
      killAll: false,
    });

    expect(parseManagedSubagents({ Action: 'kill_all' }, 'All terminated', false)).toEqual({
      action: 'kill_all',
      waitingIds: [],
      killedIds: [],
      killAll: true,
    });

    // Error results do not report killed/waiting subagents
    expect(parseManagedSubagents({ Action: 'kill_all' }, 'Failed', true)).toEqual({
      action: 'kill_all',
      waitingIds: [],
      killedIds: [],
      killAll: false,
    });
  });

  it('unwraps <SYSTEM_MESSAGE> content and detects non-zero command exit codes', () => {
    const raw =
      '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-12T20:16:47Z sender=11111111-2222-4333-8444-555555555555 priority=MESSAGE_PRIORITY_HIGH content=Проверь файл src/index.ts\nи верни отчёт\n</SYSTEM_MESSAGE>';
    expect(unwrapAgySystemMessage(raw)).toBe('Проверь файл src/index.ts\nи верни отчёт');
    expect(unwrapAgySystemMessage('Plain user prompt')).toBe('Plain user prompt');

    expect(nonZeroExitCode('Command exited with code 0.')).toBe(false);
    expect(nonZeroExitCode('Command exited with code 2.\nError')).toBe(true);
  });
});

describe('antigravity subagents: AgySubagentReader & agySubagentMarkdown', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agy-subagents-test-'));
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('tails transcript.jsonl incrementally by byteOffset (handling partial UTF-8 lines, errors, send_message summary, and multi-round reopen)', async () => {
    const file = await ensureBrainTranscript(tmpDir, CHILD_UUID, []);
    const reader = new AgySubagentReader({
      agentId: 'call_sub_1',
      childUuid: CHILD_UUID,
      dataDir: tmpDir,
      mcpServers: ['hansard_history'],
      parentSessionId: PARENT_UUID,
      description: 'Codebase Researcher',
      subagentType: 'research',
      waitingThresholdMs: 50,
    });

    // Partial line without trailing \n (including split multi-byte UTF-8 Cyrillic characters)
    const step0 = JSON.stringify({
      step_index: 0,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-12T20:00:00Z',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-12T20:00:00Z sender=${PARENT_UUID} content=Проверь историю\n</SYSTEM_MESSAGE>`,
    });
    const buf0 = Buffer.from(step0 + '\n', 'utf8');
    const splitAt = buf0.length - 7; // split right inside UTF-8 tail before newline
    await writeFile(file, buf0.subarray(0, splitAt));

    expect(await reader.poll(1000)).toEqual([]);
    expect(reader.byteOffset).toBe(splitAt);

    // Complete step 0 + write step 1 (PLANNER_RESPONSE with thinking + 2 tool calls including MCP)
    const step1 =
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T20:00:01Z',
        input_tokens: 1200,
        cache_read_tokens: 300,
        output_tokens: 80,
        thinking: 'Ищу в архиве сессий и проверяю команду',
        tool_calls: [
          {
            name: 'call_mcp_tool',
            args: { ServerName: 'hansard_history', ToolName: 'search_past_sessions', Arguments: { query: 'acp' } },
          },
          {
            name: 'run_command',
            args: { CommandLine: 'false' },
          },
        ],
      }) + '\n';
    await appendFile(file, Buffer.concat([buf0.subarray(splitAt), Buffer.from(step1, 'utf8')]));

    const evs1 = await reader.poll(1010);
    const offsetAfterStep1 = reader.byteOffset;
    expect(offsetAfterStep1).toBeGreaterThan(buf0.length);
    expect(evs1.map((e) => e.type)).toEqual([
      'thinking.start',
      'thinking.stop',
      'tool.start',
      'tool.start',
      'agent.progress',
    ]);
    expect(evs1[2]).toMatchObject({
      type: 'tool.start',
      agentId: 'call_sub_1',
      name: 'mcp__hansard_history__search_past_sessions',
      input: { query: 'acp' },
    });
    expect(evs1[4]).toMatchObject({
      type: 'agent.progress',
      agentId: 'call_sub_1',
      taskId: CHILD_UUID,
      lastToolName: 'Bash',
      totalTokens: 1580,
      toolUses: 2,
    });

    // Polling after waitingThresholdMs while tool_calls have no GENERIC emits waiting_for_input once
    const evsWait = await reader.poll(1075);
    expect(evsWait).toHaveLength(1);
    expect(evsWait[0]).toMatchObject({
      type: 'agent.progress',
      agentId: 'call_sub_1',
      taskId: CHILD_UUID,
      status: 'waiting_for_input',
    });
    expect(await reader.poll(1090)).toEqual([]);

    // Step 2 (GENERIC DONE) and Step 3 (GENERIC ERROR)
    await appendFile(
      file,
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-12T20:00:02Z',
        content: 'Found 2 sessions',
      }) +
        '\n' +
        JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'ERROR',
          created_at: '2026-11-12T20:00:03Z',
          content: 'Command exited with code 1.',
        }) +
        '\n',
    );
    const evs2 = await reader.poll(1100);
    expect(evs2).toHaveLength(2);
    expect(evs2[0]).toMatchObject({ type: 'tool.result', agentId: 'call_sub_1', isError: false });
    expect(evs2[1]).toMatchObject({ type: 'tool.result', agentId: 'call_sub_1', isError: true });

    // Step 4: subagent calls send_message to parent — must NOT emit agent.end prematurely!
    await appendFile(
      file,
      JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T20:00:04Z',
        input_tokens: 1500,
        cache_read_tokens: 300,
        output_tokens: 90,
        tool_calls: [
          {
            name: 'send_message',
            args: {
              Recipient: PARENT_UUID,
              Message: 'Детальный отчёт субагента: найдено 2 совпадения в истории.',
            },
          },
        ],
      }) +
        '\n' +
        JSON.stringify({
          step_index: 5,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-12T20:00:05Z',
          content: 'Message sent.',
        }) +
        '\n',
    );
    const evs3 = await reader.poll(1200);
    expect(evs3.some((e) => e.type === 'agent.end')).toBe(false);

    // Step 6: final PLANNER_RESPONSE without tool_calls -> emits agent.end using send_message body over short text
    await appendFile(
      file,
      JSON.stringify({
        step_index: 6,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T20:00:06Z',
        input_tokens: 1600,
        cache_read_tokens: 300,
        output_tokens: 10,
        content: 'Готово.',
      }) + '\n',
    );
    const evs4 = await reader.poll(1300);
    expect(evs4).toHaveLength(1);
    expect(evs4[0]).toMatchObject({
      type: 'agent.end',
      agentId: 'call_sub_1',
      taskId: CHILD_UUID,
      status: 'completed',
      summary: 'Детальный отчёт субагента: найдено 2 совпадения в истории.',
      totalTokens: 1910,
      toolUses: 3,
    });
    expect(reader.isRoundCompleted()).toBe(true);

    // Round 2: new SYSTEM_MESSAGE arrives -> reader automatically reopens agent.start and completes Round 2
    await appendFile(
      file,
      JSON.stringify({
        step_index: 7,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T20:00:10Z',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${PARENT_UUID} content=Уточни второй результат\n</SYSTEM_MESSAGE>`,
      }) +
        '\n' +
        JSON.stringify({
          step_index: 8,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-12T20:00:12Z',
          input_tokens: 1800,
          cache_read_tokens: 300,
          output_tokens: 40,
          content: 'Уточнение по второму результату готово.',
        }) +
        '\n',
    );
    const evs5 = await reader.poll(1500);
    expect(evs5.map((e) => e.type)).toEqual(['agent.start', 'agent.end']);
    expect(evs5[1]).toMatchObject({
      type: 'agent.end',
      agentId: 'call_sub_1',
      status: 'completed',
      summary: 'Уточнение по второму результату готово.',
      totalTokens: 2140,
    });

    // Verify agySubagentMarkdown formatting + path traversal safety
    expect(await agySubagentMarkdown('../etc/passwd', tmpDir)).toBeUndefined();
    expect(await agySubagentMarkdown(THIRD_UUID, tmpDir)).toBeUndefined();

    const md = await agySubagentMarkdown(CHILD_UUID, tmpDir, {
      title: 'Codebase Researcher',
      agentType: 'research',
      lang: 'ru',
      mcpServers: ['hansard_history'],
    });
    expect(md).toBeDefined();
    expect(md).toContain('# Codebase Researcher · research');
    expect(md).toContain(`[Открыть сессию](conversation://${CHILD_UUID})`);
    expect(md).toContain('Проверь историю');
    expect(md).not.toContain('<SYSTEM_MESSAGE>');
    expect(md).toContain('Ищу в архиве сессий и проверяю команду');
    expect(md).toContain('mcp__hansard_history__search_past_sessions');
  });

  it('tracks nested subagents (up to depth 2) and background local_bash tasks inside a subagent', async () => {
    await ensureBrainTranscript(tmpDir, NESTED_UUID, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T20:01:01Z',
        content: 'Nested task',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T20:01:02Z',
        input_tokens: 400,
        cache_read_tokens: 0,
        output_tokens: 20,
        content: 'Nested done',
      },
    ]);

    const bgTaskId = `${CHILD_UUID}/task-7`;
    await ensureBrainTranscript(tmpDir, CHILD_UUID, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T20:01:00Z',
        content: 'Run bg task and nested subagent',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T20:01:00Z',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'npm run watch', toolSummary: 'Watch build' } },
          { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Nested Helper', Prompt: 'Nested task' } },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-12T20:01:01Z',
        content: `Tool is running as a background task with task id: ${bgTaskId}`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-12T20:01:01Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${NESTED_UUID}"\n}`,
      },
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T20:01:03Z',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${bgTaskId} content=Command exited with code 0.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T20:01:04Z',
        input_tokens: 900,
        cache_read_tokens: 0,
        output_tokens: 30,
        content: 'All child work completed',
      },
    ]);

    const reader = new AgySubagentReader({
      agentId: 'top_call',
      childUuid: CHILD_UUID,
      dataDir: tmpDir,
      description: 'Top Worker',
    });

    const events = await reader.poll(2000);
    const starts = events.filter((e) => e.type === 'agent.start') as AgentEventOf<'agent.start'>[];
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      type: 'agent.start',
      agentId: `agy-task:${CHILD_UUID}:task-7`,
      taskId: bgTaskId,
      taskType: 'local_bash',
      parentAgentId: 'top_call',
      description: 'Watch build',
    });
    expect(starts[1]).toMatchObject({
      type: 'agent.start',
      agentId: `agy-sub:${CHILD_UUID}:1:1`,
      taskId: NESTED_UUID,
      taskType: 'subagent',
      parentAgentId: 'top_call',
      description: 'Nested Helper',
    });

    const ends = events.filter((e) => e.type === 'agent.end') as AgentEventOf<'agent.end'>[];
    expect(ends.map((e) => [e.agentId, e.status])).toEqual([
      [`agy-task:${CHILD_UUID}:task-7`, 'completed'],
      ['top_call', 'completed'],
      [`agy-sub:${CHILD_UUID}:1:1`, 'completed'],
    ]);
  });

  it('tails silent reactive parent turns in AgyParentTranscriptTailer without duplicating user turns', async () => {
    const parentFile = await ensureBrainTranscript(tmpDir, PARENT_UUID, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'initial user prompt',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 500,
        cache_read_tokens: 0,
        output_tokens: 20,
        content: 'initial reply',
      },
    ]);

    const tailer = new AgyParentTranscriptTailer(PARENT_UUID, tmpDir);
    const sync = await tailer.syncToEnd();
    expect(sync.maxStepIndex).toBe(1);

    // Late-flushed PLANNER_RESPONSE without SYSTEM_MESSAGE is ignored as user turn tail
    await appendFile(
      parentFile,
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 550,
        cache_read_tokens: 0,
        output_tokens: 10,
        content: 'late user flush',
      }) + '\n',
    );
    const lateRes = await tailer.pollSilentTurn(sync.maxStepIndex, 'gemini-3.8-flash');
    expect(lateRes.events).toEqual([]);
    expect(lateRes.lastStepIndex).toBe(2);

    // Genuine silent reactive turn: SYSTEM_MESSAGE -> PLANNER_RESPONSE (tool) -> GENERIC -> PLANNER_RESPONSE (final)
    await appendFile(
      parentFile,
      JSON.stringify({
        step_index: 3,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T20:05:00Z',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${CHILD_UUID} content=Done\n</SYSTEM_MESSAGE>`,
      }) +
        '\n' +
        JSON.stringify({
          step_index: 4,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-12T20:05:01Z',
          input_tokens: 2000,
          cache_read_tokens: 500,
          output_tokens: 40,
          thinking: 'Проверяю отчёт субагента',
          tool_calls: [{ name: 'read_file', args: { Path: '/work/res.txt' } }],
        }) +
        '\n' +
        JSON.stringify({
          step_index: 5,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-12T20:05:02Z',
          content: 'OK_RESULT',
        }) +
        '\n' +
        JSON.stringify({
          step_index: 6,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-12T20:05:03Z',
          input_tokens: 2200,
          cache_read_tokens: 500,
          output_tokens: 60,
          content: 'Субагент успешно завершил задачу.',
        }) +
        '\n',
    );

    const silentRes = await tailer.pollSilentTurn(lateRes.lastStepIndex, 'gemini-3.8-flash');
    expect(silentRes.completedTurn).toBe(true);
    expect(silentRes.lastStepIndex).toBe(6);
    expect(silentRes.usedTokens).toBe(2760);
    expect(silentRes.events.map((e) => e.type)).toEqual([
      'turn.start',
      'thinking.start',
      'thinking.delta',
      'thinking.stop',
      'tool.start',
      'tool.result',
      'text.delta',
      'context.usage',
      'turn.result',
    ]);
    expect(silentRes.events.at(-1)).toMatchObject({
      type: 'turn.result',
      ok: true,
      subtype: 'end_turn',
      text: 'Субагент успешно завершил задачу.',
    });
  });

  it('enforces MAX_SUBAGENT_TIMELINES and MAX_SUBAGENT_EVENTS in withAgySubagentTimelines', async () => {
    // 1) Event cap per subagent: 300 tool calls (> 400 events) must still keep agent.start and agent.end
    const heavyCalls = Array.from({ length: 260 }, (_, idx) => ({
      name: 'read_file',
      args: { Path: `/work/f_${idx}.ts` },
    }));
    const heavySteps: unknown[] = [
      { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'heavy' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: heavyCalls },
      ...heavyCalls.map((_, idx) => ({
        step_index: 2 + idx,
        type: 'GENERIC',
        status: 'DONE',
        content: 'ok',
      })),
      {
        step_index: 300,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 500,
        output_tokens: 10,
        content: 'heavy finished',
      },
    ];
    await ensureBrainTranscript(tmpDir, CHILD_UUID, heavySteps);

    const baseEvents: AgentEvent[] = [
      { type: 'turn.start', prompt: 'go', at: 1000 },
      {
        type: 'tool.start',
        toolUseId: 'call_heavy',
        name: 'Agent',
        input: { description: 'Heavy', subagent_type: 'research' },
      },
      {
        type: 'tool.result',
        toolUseId: 'call_heavy',
        isError: false,
        content: `Created the following subagent:\n{"conversationId":"${CHILD_UUID}"}`,
      },
      {
        type: 'turn.result',
        ok: true,
        subtype: 'end_turn',
        interrupted: false,
        durationMs: 10,
        apiDurationMs: 0,
        numTurns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        usageKnown: false,
        totalCostUsd: 0,
        permissionDenials: [],
      },
    ];

    const capped = await withAgySubagentTimelines(baseEvents, tmpDir);
    const subEvents = capped.filter((e) => 'agentId' in e && e.agentId === 'call_heavy');
    expect(subEvents.length).toBeLessThanOrEqual(MAX_SUBAGENT_EVENTS);
    expect(subEvents[0]?.type).toBe('agent.start');
    expect(subEvents.at(-1)).toMatchObject({ type: 'agent.end', status: 'completed' });

    // 2) Timeline count cap: 35 subagents -> only last MAX_SUBAGENT_TIMELINES (30) get full transcript reads
    const manyEvents: AgentEvent[] = [{ type: 'turn.start', prompt: 'many', at: 1000 }];
    for (let i = 0; i < 35; i++) {
      const hex = i.toString(16).padStart(12, '0');
      const uuid = `11111111-2222-4333-8444-${hex}`;
      await ensureBrainTranscript(tmpDir, uuid, [
        { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `sub ${i}` },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'read_file', args: { Path: `/work/${i}.txt` } }],
        },
        { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'file content' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: `done ${i}` },
      ]);
      manyEvents.push(
        {
          type: 'tool.start',
          toolUseId: `sub_${i}`,
          name: 'Agent',
          input: { description: `Worker ${i}`, subagent_type: 'self' },
        },
        {
          type: 'tool.result',
          toolUseId: `sub_${i}`,
          isError: false,
          content: `Created the following subagent:\n{"conversationId":"${uuid}"}`,
        },
      );
    }

    const manyOut = await withAgySubagentTimelines(manyEvents, tmpDir);
    // First 5 (0..4) exceed MAX_SUBAGENT_TIMELINES=30: they still get minimal agent.start + agent.end, but no inner tool.start
    for (let i = 0; i < 35 - MAX_SUBAGENT_TIMELINES; i++) {
      const innerTools = manyOut.filter((e) => e.type === 'tool.start' && e.agentId === `sub_${i}`);
      expect(innerTools).toHaveLength(0);
      expect(manyOut.some((e) => e.type === 'agent.start' && e.agentId === `sub_${i}`)).toBe(true);
      expect(manyOut.some((e) => e.type === 'agent.end' && e.agentId === `sub_${i}`)).toBe(true);
    }
    // Recent 30 (5..34) have their inner tool calls reconstructed
    const lastInnerTools = manyOut.filter((e) => e.type === 'tool.start' && e.agentId === 'sub_34');
    expect(lastInnerTools).toHaveLength(1);
  });

  it('decodes oneharness JSON-stringified tool_calls args, resolves model/effort inheritance, and pairs empty ACP tool.result via parent transcript.jsonl', async () => {
    expect(
      normalizeTranscriptArgs({
        Path: '"/work/src/index.ts"',
        StartLine: '10',
        Overwrite: 'true',
        ConversationIds: `["${CHILD_UUID}"]`,
        Arguments: '{"query":"acp"}',
        Message: '"Первая строка\\nВторая обрезана\n<truncated 412 bytes>',
      }),
    ).toEqual({
      Path: '/work/src/index.ts',
      StartLine: 10,
      Overwrite: true,
      ConversationIds: [CHILD_UUID],
      Arguments: { query: 'acp' },
      Message: 'Первая строка\nВторая обрезана…',
    });

    // Plain JS test args remain untouched
    expect(normalizeTranscriptArgs({ CommandLine: 'false' })).toEqual({ CommandLine: 'false' });
    expect(normalizeTranscriptArgs({ id: '123', query: 'acp' })).toEqual({ id: '123', query: 'acp' });
    expect(normalizeTranscriptArgs({ Content: '{"a":1}' })).toEqual({ Content: '{"a":1}' });

    // USER_SETTINGS_CHANGE + model/effort inheritance
    expect(
      parseAgyUserSettingsModel(
        '<USER_SETTINGS_CHANGE>\nModel Selection from None to Gemini 4 Carbon (Medium).\n</USER_SETTINGS_CHANGE>',
      ),
    ).toEqual({ model: 'gemini-4-carbon', effort: 'medium' });
    expect(
      parseAgyUserSettingsModel(
        'Model Selection from Gemini 4 Carbon (Medium) to Claude Sonnet 4.6 (Thinking).',
      ),
    ).toEqual({ model: 'claude-sonnet-4-6' });
    expect(
      parseAgyUserSettingsModel('Model Selection from None to GPT-OSS 120B (Medium).'),
    ).toEqual({ model: 'gpt-oss-120b-medium' });

    expect(resolveAgySubagentModelEffort('inherit', 'gemini-4-carbon', 'medium')).toEqual({
      model: 'gemini-4-carbon',
      reasoningEffort: 'medium',
    });
    expect(resolveAgySubagentModelEffort(undefined, 'gemini-4-argon', 'high')).toEqual({
      model: 'gemini-4-argon',
      reasoningEffort: 'high',
    });
    expect(resolveAgySubagentModelEffort('gemini-3.8-flash-low', 'gemini-4-carbon', 'high')).toEqual({
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
    });
    expect(resolveAgySubagentModelEffort('flash_lite', 'gemini-4-carbon', 'high')).toEqual({
      model: 'flash_lite',
    });
    expect(resolveAgySubagentModelEffort('gpt-oss-120b-medium', 'gemini-4-carbon', 'high')).toEqual({
      model: 'gpt-oss-120b-medium',
    });

    // Real agy acp flow: parent transcript has JSON-stringified args, USER_SETTINGS_CHANGE,
    // GENERIC Created outputs, and full SYSTEM_MESSAGE child report, while ACP tool.result has content: ''
    await ensureBrainTranscript(tmpDir, PARENT_UUID, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content:
          'Запусти субагентов\n\n<USER_SETTINGS_CHANGE>\nModel Selection from None to Gemini 4 Carbon (Medium).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:01Z',
        tool_calls: [
          {
            name: 'invoke_subagent',
            args: {
              Model: '"inherit"',
              Prompt: '"Проверь структуру корня репозитория"',
              Role: '"Repo Structure Inspector"',
              TypeName: '"research"',
            },
          },
          {
            name: 'invoke_subagent',
            args: {
              Model: '"flash"',
              Prompt: '"Проверь git status -sb"',
              Role: '"Git State Checker"',
              TypeName: '"self"',
            },
          },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created the following subagent:\n{"conversationId":"${CHILD_UUID}"}`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created the following subagent:\n{"conversationId":"${NESTED_UUID}"}`,
      },
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:05Z',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-12T22:00:05Z sender=${CHILD_UUID} content=Полный отчёт по структуре проекта без усечения.\n</SYSTEM_MESSAGE>`,
      },
    ]);

    await ensureBrainTranscript(tmpDir, CHILD_UUID, [
      {
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:01Z',
        content: 'Проверь структуру корня репозитория',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:02Z',
        input_tokens: 14_000,
        cache_read_tokens: 1_000,
        output_tokens: 200,
        tool_calls: [
          {
            name: 'read_file',
            args: { Path: '"/work/package.json"' },
          },
          {
            name: 'send_message',
            args: {
              Recipient: `"${PARENT_UUID}"`,
              Message: '"Полный отчёт по структуре\n<truncated 320 bytes>',
            },
          },
        ],
        truncated_fields: ['tool_calls'],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: '{"name":"agentura"}' },
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: 'Message sent.' },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:04Z',
        input_tokens: 15_000,
        cache_read_tokens: 1_000,
        output_tokens: 40,
        content: '',
      },
    ]);

    await ensureBrainTranscript(tmpDir, NESTED_UUID, [
      {
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:01Z',
        content: 'Проверь git status -sb',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-12T22:00:03Z',
        input_tokens: 9_000,
        output_tokens: 120,
        content: 'Ветка main чистая.',
      },
    ]);

    const acpHistoryEvents: AgentEvent[] = [
      { type: 'turn.start', prompt: 'Запусти субагентов', at: 1000 },
      {
        type: 'tool.start',
        toolUseId: 'acp_sub_1',
        name: 'Agent',
        input: {
          description: 'Repo Structure Inspector',
          prompt: 'Проверь структуру корня репозитория',
          subagent_type: 'research',
          model: 'inherit',
        },
      },
      {
        type: 'tool.result',
        toolUseId: 'acp_sub_1',
        isError: false,
        content: '', // real agy acp sends empty output!
      },
      {
        type: 'tool.start',
        toolUseId: 'acp_sub_2',
        name: 'Agent',
        input: {
          description: 'Git State Checker',
          prompt: 'Проверь git status -sb',
          subagent_type: 'self',
          model: 'flash',
        },
      },
      {
        type: 'tool.result',
        toolUseId: 'acp_sub_2',
        isError: false,
        content: '', // real agy acp sends empty output!
      },
    ];

    const capturedMeta: Array<[string, Record<string, unknown>]> = [];
    const enriched = await withAgySubagentTimelines(acpHistoryEvents, tmpDir, undefined, {
      parentSessionId: PARENT_UUID,
      onSubagentMeta: (uuid, meta) => capturedMeta.push([uuid, meta as Record<string, unknown>]),
    });

    const start1 = enriched.find(
      (e) => e.type === 'agent.start' && e.agentId === 'acp_sub_1',
    ) as AgentEventOf<'agent.start'> | undefined;
    const start2 = enriched.find(
      (e) => e.type === 'agent.start' && e.agentId === 'acp_sub_2',
    ) as AgentEventOf<'agent.start'> | undefined;
    expect(start1).toMatchObject({
      taskId: CHILD_UUID,
      subagentType: 'research',
      description: 'Repo Structure Inspector',
      prompt: 'Проверь структуру корня репозитория',
      model: 'gemini-4-carbon',
      reasoningEffort: 'medium',
    });
    expect(start2).toMatchObject({
      taskId: NESTED_UUID,
      subagentType: 'self',
      description: 'Git State Checker',
      prompt: 'Проверь git status -sb',
      model: 'flash',
      reasoningEffort: 'medium',
    });

    // Inner JSON-quoted Read path was decoded to /work/package.json
    expect(
      enriched.find((e) => e.type === 'tool.start' && e.agentId === 'acp_sub_1'),
    ).toMatchObject({
      name: 'Read',
      input: { file_path: '/work/package.json' },
    });

    // Untruncated parent SYSTEM_MESSAGE report overrides truncated child send_message
    expect(
      enriched.find((e) => e.type === 'agent.end' && e.agentId === 'acp_sub_1'),
    ).toMatchObject({
      status: 'completed',
      summary: 'Полный отчёт по структуре проекта без усечения.',
      totalTokens: 16_040,
    });
    expect(capturedMeta).toContainEqual([
      CHILD_UUID,
      {
        description: 'Repo Structure Inspector',
        agentType: 'research',
        model: 'gemini-4-carbon',
        effort: 'medium',
      },
    ]);

    const md = await agySubagentMarkdown(CHILD_UUID, tmpDir, {
      title: 'Repo Structure Inspector',
      agentType: 'research',
      model: 'gemini-4-carbon',
      effort: 'medium',
      lang: 'ru',
    });
    expect(md).toContain('`gemini-4-carbon · effort: medium`');
    expect(md).toContain('/work/package.json');
  });

  it('accepts real agy GENERIC status=RUNNING background tasks and tracks parent task-N wakeups', async () => {
    // 1) Subagent background command with status=RUNNING + parent openCalls alignment with invoke_subagent
    await ensureBrainTranscript(tmpDir, CHILD_UUID, [
      { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'run tests in bg' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: '"npm test"', toolSummary: '"Suite run"', WaitMsBeforeAsync: '500' },
          },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Created At: 2026-11-13T09:24:20+03:00\nTool is running as a background task with task id: ${CHILD_UUID}/task-12\nOnce it finishes, you will receive a message.`,
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Жду фоновый прогон.',
      },
      {
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${CHILD_UUID}/task-12 content=Background task finished with result:\nCommand exited with code 0\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 1000,
        output_tokens: 25,
        content: 'Все тесты зелёные.',
      },
    ]);

    const subReader = new AgySubagentReader({
      agentId: 'sub_bg',
      childUuid: CHILD_UUID,
      dataDir: tmpDir,
    });
    const subEvents = await subReader.poll();
    const bgToolResult = subEvents.find(
      (e) => e.type === 'tool.result' && e.agentId === 'sub_bg',
    ) as AgentEventOf<'tool.result'> | undefined;
    expect(bgToolResult?.isError).toBe(false);
    expect(
      subEvents.find(
        (e) => e.type === 'agent.start' && e.agentId === `agy-task:${CHILD_UUID}:task-12`,
      ),
    ).toMatchObject({
      taskType: 'local_bash',
      description: 'Suite run',
      parentAgentId: 'sub_bg',
    });
    expect(
      subEvents.find(
        (e) => e.type === 'agent.end' && e.agentId === `agy-task:${CHILD_UUID}:task-12`,
      ),
    ).toMatchObject({
      status: 'completed',
    });

    const md = await agySubagentMarkdown(CHILD_UUID, tmpDir, { lang: 'en' });
    expect(md).toContain(`${CHILD_UUID}/task-12`);
    expect(md).not.toContain('Error:');

    // 2) Parent transcript mixing RUNNING run_command + invoke_subagent in one PLANNER_RESPONSE,
    //    plus AgyParentTranscriptTailer tracking task-84 across silent reactive turns
    const parentFile = await ensureBrainTranscript(tmpDir, PARENT_UUID, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'start' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"sleep 5"' } },
          {
            name: 'invoke_subagent',
            args: { TypeName: '"self"', Role: '"Worker"', Prompt: '"Do stage"' },
          },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${PARENT_UUID}/task-2`,
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        content: `Created the following subagent:\n{"conversationId":"${CHILD_UUID}"}`,
      },
    ]);

    const summary = await readParentTranscriptSummary(PARENT_UUID, tmpDir);
    expect(summary?.invokeOutputs).toHaveLength(1);
    expect(summary?.invokeOutputs[0]?.childUuid).toBe(CHILD_UUID);

    // Historical sync with resetPending ignores old task-2 on session resume
    const tailer = new AgyParentTranscriptTailer(PARENT_UUID, tmpDir);
    const initSync = await tailer.syncToEnd({ resetPending: true });
    expect(initSync.maxStepIndex).toBe(3);
    expect(tailer.hasPendingReactiveWork()).toBe(false);

    // Silent reactive turn #1: subagent wakes parent -> parent starts background verification task-84 -> ends turn #1
    await appendFile(
      parentFile,
      [
        {
          step_index: 4,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: '2026-11-13T06:23:47Z',
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${CHILD_UUID} content=Stage done\n</SYSTEM_MESSAGE>`,
        },
        {
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-13T06:24:20Z',
          tool_calls: [
            {
              name: 'run_command',
              args: { CommandLine: '"TZ=UTC npm run check"', toolSummary: '"Full check"' },
            },
          ],
        },
        {
          step_index: 6,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: '2026-11-13T06:24:32Z',
          content: `Tool is running as a background task with task id: ${PARENT_UUID}/task-84`,
        },
        {
          step_index: 7,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-13T06:24:34Z',
          input_tokens: 3000,
          output_tokens: 30,
          content: 'Запустил финальную проверку в фоне.',
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const turn1 = await tailer.pollSilentTurn(initSync.maxStepIndex, 'gemini-4-argon');
    expect(turn1.completedTurn).toBe(true);
    expect(turn1.bgTaskTriggered).toBe(false);
    const bashResult = turn1.events.find(
      (e) => e.type === 'tool.result',
    ) as AgentEventOf<'tool.result'> | undefined;
    expect(bashResult?.isError).toBe(false);
    // Turn #1 ended, but task-84 is still running so parent must keep watching!
    expect(tailer.hasActiveBgTasks()).toBe(true);
    expect(tailer.hasPendingReactiveWork()).toBe(true);

    // 97 seconds later: task-84 finishes and wakes parent for silent reactive turn #2
    await appendFile(
      parentFile,
      [
        {
          step_index: 8,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: '2026-11-13T06:26:09Z',
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${PARENT_UUID}/task-84 content=Background task finished with result:\nCommand exited with code 0\n</SYSTEM_MESSAGE>`,
        },
        {
          step_index: 9,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-13T06:26:12Z',
          input_tokens: 3400,
          output_tokens: 45,
          content: 'Все этапы приняты, проверки зелёные.',
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const turn2 = await tailer.pollSilentTurn(turn1.lastStepIndex, 'gemini-4-argon');
    expect(turn2.completedTurn).toBe(true);
    expect(turn2.bgTaskTriggered).toBe(true);
    expect(turn2.events.at(-1)).toMatchObject({
      type: 'turn.result',
      ok: true,
      text: 'Все этапы приняты, проверки зелёные.',
    });
    expect(tailer.hasActiveBgTasks()).toBe(false);
    expect(tailer.hasPendingReactiveWork()).toBe(false);

    // Direct ACP tool results (Bash + manage_task kill) also register and clear activeBgTasks
    tailer.noteAcpToolResult(
      'Bash',
      { command: 'sleep 30' },
      `Tool is running as a background task with task id: ${PARENT_UUID}/task-99`,
      false,
    );
    expect(tailer.hasActiveBgTasks()).toBe(true);
    tailer.noteAcpToolResult('manage_task', { Action: 'kill', TaskId: `${PARENT_UUID}/task-99` }, 'Killed', false);
    expect(tailer.hasActiveBgTasks()).toBe(false);
  });
});
