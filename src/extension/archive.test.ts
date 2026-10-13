import { describe, expect, it } from 'vitest';
import type { MementoLike } from './sessionMemory';
import { ArchivedSessions } from './archive';

function memento(init: Record<string, unknown> = {}): MementoLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: <T>(k: string) => data[k] as T | undefined,
    update: async (k, v) => {
      if (v === undefined) delete data[k];
      else data[k] = v;
    },
  };
}

describe('ArchivedSessions', () => {
  it('add / has / remove, новые id в конце', () => {
    const state = memento();
    const a = new ArchivedSessions(state);
    expect(a.has('s1')).toBe(false);
    a.add('s1');
    a.add('s2');
    expect(a.has('s1')).toBe(true);
    expect([...a.ids()]).toEqual(['s1', 's2']);
    expect(state.data['agentura.archivedSessions']).toEqual(['s1', 's2']);
    a.remove('s1');
    expect(a.has('s1')).toBe(false);
    expect([...a.ids()]).toEqual(['s2']);
  });

  it('повторный add не дублирует и не шлёт onChange', () => {
    const a = new ArchivedSessions(memento());
    let calls = 0;
    a.onChange(() => calls++);
    a.add('s1');
    a.add('s1');
    expect([...a.ids()]).toEqual(['s1']);
    expect(calls).toBe(1);
  });

  it('remove без записи ничего не делает; пустой архив не хранится', () => {
    const state = memento();
    const a = new ArchivedSessions(state);
    let calls = 0;
    a.onChange(() => calls++);
    a.remove('nope');
    expect(calls).toBe(0);
    a.add('s1');
    a.remove('s1');
    expect(calls).toBe(2);
    expect('agentura.archivedSessions' in state.data).toBe(false);
  });

  it('onChange: отписка и устойчивость к ошибке слушателя', () => {
    const a = new ArchivedSessions(memento());
    let calls = 0;
    a.onChange(() => {
      throw new Error('boom');
    });
    const off = a.onChange(() => calls++);
    a.add('s1');
    expect(calls).toBe(1);
    off();
    a.add('s2');
    expect(calls).toBe(1);
  });

  it('читает сохранённое, битые значения отбрасывает', () => {
    const a = new ArchivedSessions(memento({ 'agentura.archivedSessions': ['s1', 5, '', 's2'] }));
    expect([...a.ids()]).toEqual(['s1', 's2']);
    expect(new ArchivedSessions(memento({ 'agentura.archivedSessions': 'x' })).ids().size).toBe(0);
  });
});
