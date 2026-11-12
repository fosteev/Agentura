import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { AgyAcpMapper, toolInput, toolName, usageOf } from './acpMapper';

describe('AgyAcpMapper', () => {
  it('usageOf extracts tokens and thoughtTokens', () => {
    expect(usageOf(undefined)).toBeUndefined();
    expect(usageOf({})).toBeUndefined();

    const u = usageOf({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedReadTokens: 200,
        cachedWriteTokens: 10,
        thoughtTokens: 25,
        totalTokens: 350,
      },
    });
    expect(u).toEqual({
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 10,
      thinking: 25,
    });
  });

  it('turn flow: startTurn -> text chunk -> finish', () => {
    const mapper = new AgyAcpMapper();
    const t0 = 1000;
    const start = mapper.startTurn('hello', t0);
    expect(start).toEqual([{ type: 'turn.start', prompt: 'hello', at: t0 }]);

    const deltas = mapper.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'world' },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ type: 'text.delta', text: 'world' });

    const finish = mapper.finish(
      {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0 },
      },
      t0,
      1500,
    );
    expect(finish).toHaveLength(1);
    expect(finish[0]).toMatchObject({
      type: 'turn.result',
      ok: true,
      subtype: 'end_turn',
      interrupted: false,
      durationMs: 500,
      text: 'world',
      usageKnown: true,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('thinking flow: thought chunk -> message chunk closes thinking', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('think', 1000);

    const thought = mapper.applyUpdate(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'deep thought' },
      },
      1100,
    );
    expect(thought).toHaveLength(2);
    expect(thought[0]).toMatchObject({ type: 'thinking.start', at: 1100 });
    expect(thought[1]).toMatchObject({ type: 'thinking.delta', text: 'deep thought' });

    const msg = mapper.applyUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer' },
      },
      1200,
    );
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({ type: 'thinking.stop', at: 1200 });
    expect(msg[1]).toMatchObject({ type: 'text.delta', text: 'answer' });
  });

  it('session_info_update produces session.title', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('test');
    const events = mapper.applyUpdate({
      sessionUpdate: 'session_info_update',
      title: 'New Conversation Title',
    });
    expect(events).toEqual([{ type: 'session.title', title: 'New Conversation Title' }]);
  });

  it('tool updates: start and completed / failed results', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('run command', 1000);

    // in_progress -> tool.start (mapped to Bash)
    const start = mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      name: 'run_command',
      rawInput: { CommandLine: 'echo 42' },
      status: 'in_progress',
    });
    expect(start).toEqual([
      {
        type: 'tool.start',
        toolUseId: 'call_1',
        name: 'Bash',
        input: { command: 'echo 42' },
      },
    ]);

    // pending status does not duplicate tool.start or finish
    const pending = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'pending',
    });
    expect(pending).toEqual([]);

    // completed -> tool.result
    const finish = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: { output: '42\n', exit_code: 0 },
    });
    expect(finish).toEqual([
      {
        type: 'tool.result',
        toolUseId: 'call_1',
        isError: false,
        content: '42\n',
        result: { output: '42\n', exit_code: 0 },
      },
    ]);

    // completed with exit_code != 0 -> isError: true
    mapper.startTurn('run error', 2000);
    mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_2',
      name: 'run_command',
      rawInput: { CommandLine: 'false' },
      status: 'in_progress',
    });
    const errorFinish = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_2',
      status: 'completed',
      rawOutput: { output: 'command failed', exit_code: 1 },
    });
    expect(errorFinish[0]).toMatchObject({
      type: 'tool.result',
      toolUseId: 'call_2',
      isError: true,
      content: 'command failed',
    });
  });

  it('diff content mapping for edit tools with structuredPatch', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('edit file', 1000);
    const start = mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_edit',
      name: 'edit_file',
      args: { Path: '/test.txt', Target: 'hello', Replacement: 'world' },
      status: 'in_progress',
    });
    expect(start[0]).toMatchObject({
      type: 'tool.start',
      name: 'Edit',
      input: { file_path: '/test.txt', old_string: 'hello', new_string: 'world' },
    });

    const res = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_edit',
      status: 'completed',
      content: [{ type: 'diff', path: '/test.txt', newText: 'world\n', oldText: 'hello\n' }],
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      type: 'tool.result',
      toolUseId: 'call_edit',
      isError: false,
      content: '/test.txt\nworld',
      result: {
        filePath: '/test.txt',
        type: 'update',
        originalFile: 'hello\n',
        oldString: 'hello\n',
        newString: 'world\n',
      },
    });
    const patch = (res[0] as { result?: { structuredPatch: unknown[] } }).result?.structuredPatch;
    expect(Array.isArray(patch)).toBe(true);
    expect(patch?.length).toBeGreaterThan(0);
  });

  it('tool name helper checks name, kind, title', () => {
    expect(toolName({ name: 'read_file' })).toBe('read_file');
    expect(toolName({ kind: 'execute' })).toBe('execute');
    expect(toolName({ title: 'Run bash' })).toBe('Run bash');
    expect(toolName({})).toBe('tool');
  });

  it('tool input helper checks rawInput or args', () => {
    expect(toolInput({ rawInput: { a: 1 } })).toEqual({ a: 1 });
    expect(toolInput({ args: { b: 2 } })).toEqual({ b: 2 });
    expect(toolInput({})).toEqual({});
  });

  it('failOpen, abandon and interruptBeforeStart', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('prompt');
    const fail = mapper.failOpen(1000, 1100, 'boom');
    expect(fail).toMatchObject([
      {
        type: 'turn.result',
        ok: false,
        subtype: 'error',
        interrupted: false,
        durationMs: 100,
        errors: ['boom'],
      },
    ]);

    mapper.startTurn('prompt 2');
    const ab = mapper.abandon(2000, 2200);
    expect(ab).toMatchObject([
      {
        type: 'turn.result',
        ok: false,
        subtype: 'cancelled',
        interrupted: true,
        durationMs: 200,
      },
    ]);

    const before = mapper.interruptBeforeStart('queued prompt', 3000);
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ type: 'turn.start', prompt: 'queued prompt' });
    expect(before[1]).toMatchObject({
      type: 'turn.result',
      ok: false,
      subtype: 'interrupted',
      interrupted: true,
      numTurns: 0,
    });
  });

  it('replaying fixture frames through AgyAcpMapper', () => {
    const fixturePath = join(__dirname, '../../../test/fixtures/antigravity/acp-pong.ndjson');
    const lines = readFileSync(fixturePath, 'utf8').trim().split('\n');
    const mapper = new AgyAcpMapper();
    const collected: AgentEvent[] = [];

    let promptStarted = false;
    for (const line of lines) {
      const entry = JSON.parse(line);
      const msg = entry.msg;
      if (entry.dir === 'in' && msg.method === 'session/prompt') {
        const textBlock = msg.params?.prompt?.find((p: { type: string; text?: string }) => p.type === 'text');
        collected.push(...mapper.startTurn(textBlock?.text ?? ''));
        promptStarted = true;
      } else if (entry.dir === 'out' && msg.method === 'session/update' && promptStarted) {
        collected.push(...mapper.applyUpdate(msg.params?.update));
      } else if (entry.dir === 'out' && msg.result && promptStarted) {
        collected.push(...mapper.finish(msg.result, 0, 100));
        promptStarted = false;
      }
    }

    const types = collected.map((e) => e.type);
    expect(types).toContain('turn.start');
    expect(types).toContain('text.delta');
    expect(types).toContain('session.title');
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.result');
    expect(types).toContain('turn.result');
  });

  it('api_retry before answer closes open thinking and strips Go/HTTP URLs and socket addresses', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('explain', 1000);

    mapper.applyUpdate(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
      1050,
    );

    const retryEvents = mapper.applyUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '\n⚠ API error (attempt 1): Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 192.168.1.42:54321->142.250.74.106:443: read: connection reset by peer\n',
        },
      },
      1100,
    );

    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]).toMatchObject({ type: 'thinking.stop', at: 1100 });
    expect(retryEvents[1]).toEqual({
      type: 'error',
      fatal: false,
      code: 'api_retry',
      message: 'Повтор запроса к API (попытка 1) · connection reset by peer',
    });
    expect((retryEvents[1] as Extract<AgentEvent, { type: 'error' }>).message).not.toContain('https://');
    expect((retryEvents[1] as Extract<AgentEvent, { type: 'error' }>).message).not.toContain('192.168.');

    const answer = mapper.applyUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Готово.' },
      },
      1200,
    );
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({ type: 'text.delta', text: 'Готово.' });

    const done = mapper.finish({ stopReason: 'end_turn' }, 1000, 1300);
    expect(done[0]).toMatchObject({ type: 'turn.result', text: 'Готово.' });
  });

  it('api_retry supports EN locale and extracts compact timeout / TLS / EOF / HTTP status details', () => {
    const mapper = new AgyAcpMapper({ lang: () => 'en' });
    mapper.startTurn('check', 1000);

    const cases: Array<[string, string]> = [
      [
        '\n⚠ API error (attempt 1): Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": dial tcp 142.250.74.106:443: i/o timeout\n',
        'Retrying API request (attempt 1) · i/o timeout',
      ],
      [
        '\n⚠ API error (attempt 2): Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": net/http: TLS handshake timeout\n',
        'Retrying API request (attempt 2) · TLS handshake timeout',
      ],
      [
        '\n⚠ API error (attempt 3): Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF\n',
        'Retrying API request (attempt 3) · EOF',
      ],
      [
        '\n⚠ API error (attempt 4): googleapi: Error 429: Resource has been exhausted (e.g. check quota)., rateLimitExceeded\n',
        'Retrying API request (attempt 4) · HTTP 429',
      ],
      [
        '\n⚠ API error (attempt 5): Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected HTTP 503 Service Unavailable\n',
        'Retrying API request (attempt 5) · HTTP 503',
      ],
    ];

    for (const [raw, expected] of cases) {
      const evs = mapper.applyUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: raw },
      });
      expect(evs).toEqual([{ type: 'error', fatal: false, code: 'api_retry', message: expected }]);
    }

    const done = mapper.finish({ stopReason: 'end_turn' }, 1000, 1500);
    expect((done[0] as Extract<AgentEvent, { type: 'turn.result' }>).text).toBeUndefined();
  });

  it('api_retry between stream chunks (separate and consolidated) splits messageId and keeps turn.result.text clean', () => {
    // 1. Separate chunks: text -> attempt 1 -> attempt 2 -> text
    const separate = new AgyAcpMapper();
    separate.startTurn('stream', 1000);

    const first = separate.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Первая часть. ' },
    });
    const r1 = separate.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\n⚠ API error (attempt 1): Post "https://daily-cloudcode-pa.googleapis.com/v1": EOF\n' },
    });
    const r2 = separate.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\n⚠ API error (attempt 2): Post "https://daily-cloudcode-pa.googleapis.com/v1": i/o timeout\n' },
    });
    const second = separate.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Вторая часть.' },
    });
    const sepDone = separate.finish({ stopReason: 'end_turn' }, 1000, 2000);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const id1 = (first[0] as Extract<AgentEvent, { type: 'text.delta' }>).messageId;
    const id2 = (second[0] as Extract<AgentEvent, { type: 'text.delta' }>).messageId;
    expect(id1).not.toBe(id2);
    expect(r1).toEqual([
      { type: 'error', fatal: false, code: 'api_retry', message: 'Повтор запроса к API (попытка 1) · EOF' },
    ]);
    expect(r2).toEqual([
      { type: 'error', fatal: false, code: 'api_retry', message: 'Повтор запроса к API (попытка 2) · i/o timeout' },
    ]);
    expect(sepDone[0]).toMatchObject({ type: 'turn.result', text: 'Первая часть. Вторая часть.' });

    // 2. Consolidated chunk (e.g. session/load replay)
    const consolidated = new AgyAcpMapper();
    consolidated.startTurn('replay', 1000);
    const events = consolidated.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'До сбоя.\n⚠ API error (attempt 1): Post "https://daily-cloudcode-pa.googleapis.com/v1": EOF\nПосле сбоя.',
      },
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'text.delta', text: 'До сбоя.' });
    expect(events[1]).toEqual({
      type: 'error',
      fatal: false,
      code: 'api_retry',
      message: 'Повтор запроса к API (попытка 1) · EOF',
    });
    expect(events[2]).toMatchObject({ type: 'text.delta', text: 'После сбоя.' });
    expect((events[0] as Extract<AgentEvent, { type: 'text.delta' }>).messageId).not.toBe(
      (events[2] as Extract<AgentEvent, { type: 'text.delta' }>).messageId,
    );

    const consDone = consolidated.finish({ stopReason: 'end_turn' }, 1000, 1500);
    expect(consDone[0]).toMatchObject({ type: 'turn.result', text: 'До сбоя.После сбоя.' });
  });

  it('normal response containing ⚠ without API error template passes through unchanged', () => {
    const mapper = new AgyAcpMapper();
    mapper.startTurn('warn', 1000);

    const text = '⚠ Внимание: проверьте конфиг!\n⚠ API error: без номера попытки';
    const events = mapper.applyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
    expect(events).toEqual([{ type: 'text.delta', messageId: 'a1', text }]);

    const done = mapper.finish({ stopReason: 'end_turn' }, 1000, 1200);
    expect(done[0]).toMatchObject({ type: 'turn.result', text });
  });

  it('passes mcpServers to mapAgyTool for eager MCP and maps invoke_subagent to Agent', () => {
    const mapper = new AgyAcpMapper({
      mcpServers: ['gemini-api_gemini-api-docs', 'hansard_history'],
    });
    mapper.startTurn('check', 1000);

    const mcpEvents = mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp',
      name: 'mcp_hansard_history_search_past_sessions',
      rawInput: { query: 'roadmap 38' },
      status: 'in_progress',
    });
    expect(mcpEvents).toEqual([
      {
        type: 'tool.start',
        toolUseId: 'tc-mcp',
        name: 'mcp__hansard_history__search_past_sessions',
        input: { query: 'roadmap 38' },
      },
    ]);

    const subEvents = mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sub',
      name: 'invoke_subagent',
      rawInput: { TypeName: 'self', Role: 'Stage 3 Coder', Prompt: 'Do work' },
      status: 'in_progress',
    });
    expect(subEvents).toEqual([
      {
        type: 'tool.start',
        toolUseId: 'tc-sub',
        name: 'Agent',
        input: { description: 'Stage 3 Coder', prompt: 'Do work', subagent_type: 'self' },
      },
    ]);
  });
});
