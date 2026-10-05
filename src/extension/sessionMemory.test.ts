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
  it('открытые сессии: хранит provider, мигрирует строки в Claude и игнорирует мусор', () => {
    const m = memento();
    const mem = new SessionMemory(m);
    expect(mem.openSessions()).toEqual([]);
    mem.setOpenSessions([
      { provider: 'claude', id: 'a' },
      { provider: 'codex', id: 'a' },
      { provider: 'claude', id: 'a' },
    ]);
    expect(mem.openSessions()).toEqual([
      { provider: 'claude', id: 'a' },
      { provider: 'codex', id: 'a' },
    ]);
    m.data['agentura.openSessions'] = ['legacy'];
    expect(mem.openSessions()).toEqual([{ provider: 'claude', id: 'legacy' }]);
    m.data['agentura.openSessions'] = 'не массив';
    expect(mem.openSessions()).toEqual([]);
  });

  it('версия движка', () => {
    const mem = new SessionMemory(memento());
    mem.setEngineVersion('claude 2.1.285');
    expect(mem.engineVersion()).toBe('claude 2.1.285');
  });
});
