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
});
