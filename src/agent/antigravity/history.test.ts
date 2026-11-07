import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgyHistory } from './history';

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
});
