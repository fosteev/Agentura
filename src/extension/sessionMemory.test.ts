import { describe, expect, it } from 'vitest';
import { SessionMemory, type MementoLike } from './sessionMemory';

function memento(): MementoLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: <T>(k: string) => data[k] as T | undefined,
    update: async (k, v) => {
      data[k] = v;
    },
  };
}

describe('SessionMemory', () => {
  it('открытые сессии: без дублей; мусор в состоянии игнорируется', () => {
    const m = memento();
    const mem = new SessionMemory(m);
    expect(mem.openSessions()).toEqual([]);
    mem.setOpenSessions(['a', 'b', 'a']);
    expect(mem.openSessions()).toEqual(['a', 'b']);
    m.data['agentura.openSessions'] = 'не массив';
    expect(mem.openSessions()).toEqual([]);
  });

  it('версия движка', () => {
    const mem = new SessionMemory(memento());
    mem.setEngineVersion('claude 2.1.285');
    expect(mem.engineVersion()).toBe('claude 2.1.285');
  });
});
