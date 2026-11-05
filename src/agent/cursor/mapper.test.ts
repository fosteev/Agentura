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

  it('read: текст файла есть, tool-кадр и tool_ id в ленту не идут', () => {
    const events = mapScenario('read');
    expect(text(events)).toBe('marker-alpha');
    expect(events.some((e) => e.type === 'tool.start' || e.type === 'tool.result')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('tool_');
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
