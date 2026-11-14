import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { KimiMapper } from './mapper';

interface Frame {
  dir: string;
  scenario: string;
  msg: {
    method?: string;
    result?: { stopReason?: string };
    params?: { update?: unknown };
  };
}

function frames(name: string): Frame[] {
  return readFileSync(join(__dirname, '../../../test/fixtures/kimi', name), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Frame);
}

function updates(name: string, scenario: string): unknown[] {
  return frames(name)
    .filter((frame) => frame.dir === 'out' && frame.scenario === scenario && frame.msg.method === 'session/update')
    .map((frame) => frame.msg.params?.update);
}

function resultOf(name: string, scenario: string): unknown {
  return frames(name).find((frame) => frame.scenario === scenario && frame.msg.result?.stopReason)?.msg.result;
}

function replay(name: string, scenario: string): { events: AgentEvent[]; result: AgentEvent[] } {
  const mapper = new KimiMapper();
  const events = mapper.startTurn(scenario, 1000);
  for (const update of updates(name, scenario)) events.push(...mapper.applyUpdate(update, 1100));
  const result = mapper.finish(resultOf(name, scenario), 1000, 1500);
  return { events, result };
}

describe('KimiMapper real fixtures', () => {
  it('maps text, thoughts, title and context; turn usage remains unknown', () => {
    const { events, result } = replay('acp-basic.ndjson', 'stream');
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'turn.start', 'thinking.start', 'thinking.delta', 'thinking.stop',
      'text.delta', 'session.title',
    ]));
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join(''))
      .toBe('STREAM_MARKER_101');
    expect(events.find((event) => event.type === 'session.title')).toMatchObject({
      title: 'Return exactly STREAM_MARKER_101. Do not use tools.',
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'turn.result', ok: true, subtype: 'end_turn', text: 'STREAM_MARKER_101', usageKnown: false,
    });
  });

  it('maps usage_update to the existing context.usage event', () => {
    const mapper = new KimiMapper();
    expect(mapper.applyUpdate({ sessionUpdate: 'usage_update', used: 19219, size: 1048576 })).toEqual([{
      type: 'context.usage', usedTokens: 19219, maxTokens: 1048576,
      percentage: 19219 / 1048576 * 100, source: 'engine',
    }]);
    expect(mapper.applyUpdate({ sessionUpdate: 'usage_update', used: -1, size: 0 })).toEqual([]);
  });

  it('starts lazy/canonical Read once and preserves raw string output', () => {
    const { events } = replay('acp-basic.ndjson', 'tool-read');
    expect(events.filter((event) => event.type === 'tool.start')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.start')).toMatchObject({
      toolUseId: '1:tool_vLw7WXVtrnTkRFZWshD0CL7P', name: 'Read', input: { file_path: 'note.txt' },
    });
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
      isError: false,
      content: '1\tMARKER_READ_731\n2\tMARKER_GREP_ALPHA\n3\tMARKER_GREP_BETA',
      result: '1\tMARKER_READ_731\n2\tMARKER_GREP_ALPHA\n3\tMARKER_GREP_BETA',
    });
  });

  it('emits progress only for a changed canonical update after start', () => {
    const mapper = new KimiMapper();
    mapper.startTurn('read', 1000);
    expect(mapper.applyUpdate({
      sessionUpdate: 'tool_call', toolCallId: 'r', title: 'Read', kind: 'read', status: 'pending',
    }, 1010)).toEqual([]);
    expect(mapper.applyUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'r', title: 'Reading a.txt', kind: 'read',
      status: 'in_progress', rawInput: { path: 'a.txt' },
    }, 1020).map((event) => event.type)).toEqual(['tool.start']);
    expect(mapper.applyUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'r', title: 'Reading a.txt', kind: 'read',
      status: 'in_progress', rawInput: { path: 'a.txt', offset: 2 },
    }, 1030)).toEqual([{ type: 'tool.progress', toolUseId: 'r', name: 'Read', elapsedMs: 10 }]);
  });

  it('retains the in-progress Edit diff until the terminal frame', () => {
    const { events } = replay('acp-basic.ndjson', 'edit');
    expect(events.filter((event) => event.type === 'tool.start')).toHaveLength(1);
    const result = events.find((event) => event.type === 'tool.result') as AgentEventOf<'tool.result'>;
    expect(result).toMatchObject({
      isError: false,
      content: 'Replaced 1 occurrence in out.txt',
      result: {
        filePath: '<WORK>/out.txt', type: 'update', originalFile: 'WRITE_MARKER_505',
        oldString: 'WRITE_MARKER_505', newString: 'EDIT_MARKER_606',
      },
    });
    const patch = (result.result as { structuredPatch: { lines: string[] }[] }).structuredPatch;
    expect(patch.flatMap((hunk) => hunk.lines)).toContain('+EDIT_MARKER_606');
  });

  it('does not synthesize a Write diff and preserves failed raw errors', () => {
    const write = replay('acp-basic.ndjson', 'write').events.find((event) => event.type === 'tool.result');
    expect(write).toMatchObject({ content: 'Wrote 17 bytes to out.txt', result: 'Wrote 17 bytes to out.txt' });
    expect((write as AgentEventOf<'tool.result'>).result).not.toHaveProperty('structuredPatch');

    const denied = replay('acp-basic.ndjson', 'permission-deny').events.find((event) => event.type === 'tool.result');
    expect(denied).toMatchObject({
      isError: true,
      content: 'Tool "Bash" was not run because the user rejected the approval request.',
    });
  });

  it('ignores unknown updates and tools without dropping the turn', () => {
    const mapper = new KimiMapper();
    mapper.startTurn('unknown', 1000);
    expect(mapper.applyUpdate({ sessionUpdate: 'future_update', value: 1 })).toEqual([]);
    const started = mapper.applyUpdate({
      sessionUpdate: 'tool_call', toolCallId: 'future', title: 'FutureTool', status: 'in_progress',
      rawInput: { nested: { value: 1 } },
    });
    expect(started[0]).toMatchObject({ type: 'tool.start', name: 'FutureTool' });
    const finished = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'future', status: 'completed', rawOutput: { odd: true },
    });
    expect(finished[0]).toMatchObject({ type: 'tool.result', content: '{"odd":true}' });
    expect(mapper.finish({ stopReason: 'end_turn' }, 1000)[0]).toMatchObject({ ok: true });
  });

  it('maps cancelled and RPC-failed turns without invented usage', () => {
    const cancelled = replay('acp-basic.ndjson', 'cancel-stream').result[0];
    expect(cancelled).toMatchObject({ subtype: 'cancelled', interrupted: true, ok: false, usageKnown: false });
    const mapper = new KimiMapper();
    mapper.startTurn('error', 1000);
    expect(mapper.failOpen(1000, 1200, 'raw RPC error')[0]).toMatchObject({
      subtype: 'error', ok: false, errors: ['raw RPC error'], usageKnown: false,
    });
  });
});
