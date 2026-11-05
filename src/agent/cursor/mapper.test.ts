import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { CursorMapper } from './mapper';
import { modelsFrom } from './protocol';

interface Row {
  dir: 'in' | 'out';
  scenario: string;
  msg: {
    method?: string;
    result?: unknown;
    params?: { update?: unknown };
  };
}

const rows: Row[] = readFileSync(new URL('../../../test/fixtures/cursor/acp-pong.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Row);

function mapScenario(name: string): AgentEvent[] {
  const mapper = new CursorMapper();
  const events: AgentEvent[] = [];
  for (const row of rows) {
    if (row.scenario !== name || row.dir !== 'out') continue;
    if (row.msg.method === 'session/update') events.push(...mapper.applyUpdate(row.msg.params?.update));
    const reason = (row.msg.result as { stopReason?: unknown } | undefined)?.stopReason;
    if (typeof reason === 'string') events.push(...mapper.finish(row.msg.result, 0, 0));
  }
  return events;
}

const text = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.text : '')).join('');

describe('Cursor mapper на фикстуре acp-pong', () => {
  it('pong: в text.delta только agent_message_chunk, мысли не попадают', () => {
    const events = mapScenario('pong');
    expect(text(events)).toBe('pong');
    expect(text(events)).not.toContain('user wants');
    expect(events.some((e) => e.type === 'thinking.delta' || e.type === 'thinking.start')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn.result', ok: true, subtype: 'end_turn', interrupted: false });
  });

  it('read: tool.start/tool.result с kind и id кадра, текст хода отдельно', () => {
    const events = mapScenario('read');
    expect(text(events)).toBe('marker-alpha');
    const start = events.find((e) => e.type === 'tool.start');
    const result = events.find((e) => e.type === 'tool.result');
    expect(start).toMatchObject({
      type: 'tool.start',
      toolUseId: 'tool_f50f0096-32f9-48c7-9713-e5d7d293d24',
      name: 'read',
      input: { path: '<WORK>/note.txt' },
    });
    expect(result).toMatchObject({
      type: 'tool.result',
      toolUseId: 'tool_f50f0096-32f9-48c7-9713-e5d7d293d24',
      isError: false,
      content: 'marker-alpha\n',
    });
    expect(events.some((e) => e.type === 'tool.progress')).toBe(false);
    expect(text(events)).not.toContain('marker-alpha\n');
  });

  it('plan с entries, user_message_chunk и команды не становятся текстом хода', () => {
    const planUpdate = rows.find(
      (r) => r.dir === 'out' && r.msg.params?.update && (r.msg.params.update as { sessionUpdate?: string }).sessionUpdate === 'plan',
    );
    expect(new CursorMapper().applyUpdate(planUpdate?.msg.params?.update)).toEqual([]);
    const user = rows.find(
      (r) =>
        r.dir === 'out' &&
        (r.msg.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'user_message_chunk',
    );
    expect(new CursorMapper().applyUpdate(user?.msg.params?.update)).toEqual([]);
    const commands = rows.find(
      (r) =>
        (r.msg.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'available_commands_update',
    );
    expect(new CursorMapper().applyUpdate(commands?.msg.params?.update)).toEqual([]);

    const joined = rows
      .filter((r) => r.dir === 'out')
      .flatMap((r) => {
        const mapper = new CursorMapper();
        return r.msg.method === 'session/update' ? mapper.applyUpdate(r.msg.params?.update) : [];
      });
    const all = text(joined);
    expect(all).not.toContain('Reply with exactly one word');
    expect(all).not.toContain('_commandsCount');
    expect(all).not.toContain('The user wants');
    expect(new CursorMapper().applyUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toEqual([]);
  });

  it('write: имя — kind, input добирается со следующего кадра, diff не роняет ход', () => {
    const events = mapScenario('write');
    const search = events.filter(
      (e) => e.type === 'tool.start' && e.toolUseId === 'tool_511c906c-3b4b-4d2e-a402-c9d460e73e4',
    );
    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject({ name: 'search', input: { pattern: '*' } });
    const edit = events.find(
      (e) => e.type === 'tool.result' && e.toolUseId === 'tool_82c32e54-52a3-4778-a16a-cb6bac523ed',
    );
    expect(edit).toMatchObject({ isError: false });
    expect(edit && edit.type === 'tool.result' ? edit.content : '').toContain('written');
    const names = events.filter((e) => e.type === 'tool.start').map((e) => (e.type === 'tool.start' ? e.name : ''));
    expect(names).not.toContain('Find');
    expect(names).not.toContain('Edit File');
  });

  it('plan: createPlan по _toolName, entries плана в ленту не идут', () => {
    const events = mapScenario('plan');
    const names = events.filter((e) => e.type === 'tool.start').map((e) => (e.type === 'tool.start' ? e.name : ''));
    expect(names).toContain('createPlan');
    expect(names).not.toContain('other');
    expect(events.some((e) => e.type === 'plan.request')).toBe(false);
  });

  it('неизвестный kind — одна карточка с сырым именем; без id карточки нет', () => {
    const mapper = new CursorMapper();
    expect(
      mapper.applyUpdate({ sessionUpdate: 'tool_call', kind: 'read', status: 'pending', rawInput: { path: 'a' } }),
    ).toEqual([]);
    const start = mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_x',
      title: 'Nope',
      kind: 'explode',
      status: 'pending',
      rawInput: { a: 1 },
    });
    expect(start).toEqual([{ type: 'tool.start', toolUseId: 'tool_x', name: 'explode', input: { a: 1 } }]);
    const done = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool_x',
      status: 'completed',
      rawOutput: { content: 'ok' },
    });
    expect(done[0]).toMatchObject({ type: 'tool.result', toolUseId: 'tool_x', isError: false, content: 'ok' });

    const replay = new CursorMapper().applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'replay-1-1',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'a' },
    });
    expect(replay).toMatchObject([{ type: 'tool.start', toolUseId: 'replay-1-1', name: 'read' }]);
  });

  it('execute: ненулевой exitCode — tool.result с ошибкой', () => {
    const mapper = new CursorMapper();
    mapper.applyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_e',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'false' },
    });
    const done = mapper.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool_e',
      status: 'completed',
      rawOutput: { exitCode: 1, stdout: '', stderr: 'no' },
    });
    expect(done[0]).toMatchObject({ type: 'tool.result', isError: true, content: 'no' });
  });

  it('модели из session/new — два образца, сентинел _modelsCount не модель', () => {
    const created = rows.find((r) => r.scenario === 'new' && r.dir === 'out');
    const models = modelsFrom(created?.msg.result);
    expect(models.map((m) => m.value)).toEqual([
      'default[]',
      'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
    ]);
    expect(models).toHaveLength(2);
    expect(JSON.stringify(models)).not.toContain('_modelsCount');
    expect(modelsFrom({ models: { availableModels: [{ _modelsCount: 47 }] } })).toEqual([]);
  });

  it('cancelled — ход прерван; Stop до старта даёт turn.start и interrupted', () => {
    const mapper = new CursorMapper();
    expect(mapper.finish({ stopReason: 'cancelled' }, 0, 10)).toMatchObject([
      { type: 'turn.result', ok: false, interrupted: true, subtype: 'cancelled' },
    ]);
    expect(mapper.interruptBeforeStart('hello').map((e) => e.type)).toEqual(['turn.start', 'turn.result']);
    expect(mapper.interruptBeforeStart('hello')[1]).toMatchObject({ interrupted: true, ok: false });
  });
});
