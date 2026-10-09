import { describe, expect, it } from 'vitest';
import { OWN_INSTANCES_KEY, OwnInstanceStore, ownTokenKey, readOwnInstances, workspaceId } from './ownInstances';

function memento() {
  const data: Record<string, unknown> = {};
  return { get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => void (data[k] = v), data };
}
function secrets() {
  const data = new Map<string, string>();
  return { get: async (k: string) => data.get(k), store: async (k: string, v: string) => void data.set(k, v), delete: async (k: string) => void data.delete(k), data };
}
const inst = { id: 'jira-example-test', name: 'Work', baseUrl: 'https://jira.example.test', kind: 'dc' as const };

describe('workspaceId / ключ токена', () => {
  it('sha1 от URI первой папки, без папки — global; токен привязан к воркспейсу и инстансу', () => {
    expect(workspaceId(undefined)).toBe('global');
    expect(workspaceId('file:///a')).toMatch(/^[0-9a-f]{40}$/);
    expect(workspaceId('file:///a')).not.toBe(workspaceId('file:///b'));
    expect(ownTokenKey('ws', 'inst')).toBe('agentura.jira.token.ws.inst');
  });
});

describe('readOwnInstances', () => {
  it('не массив → пусто; битые записи, дубли id, чужие схемы отбрасываются; адрес без хвостовых слэшей', () => {
    expect(readOwnInstances(undefined)).toEqual([]);
    expect(readOwnInstances('x')).toEqual([]);
    const list = readOwnInstances([
      { ...inst, baseUrl: 'https://jira.example.test//' },
      { ...inst },
      { ...inst, id: 'Bad Id' },
      { ...inst, id: 'ftp', baseUrl: 'ftp://x' },
      { ...inst, id: 'k', kind: 'server' },
      { ...inst, id: 'n', name: '  ' },
      null,
      { ...inst, id: 'cloud', kind: 'cloud', email: 'a@b.c', baseUrl: 'https://x.atlassian.net', extra: 1 },
    ]);
    expect(list.map((i) => i.id)).toEqual(['jira-example-test', 'cloud']);
    expect(list[0]!.baseUrl).toBe('https://jira.example.test');
    expect(list[1]).toEqual({ id: 'cloud', name: 'Work', baseUrl: 'https://x.atlassian.net', kind: 'cloud', email: 'a@b.c' });
  });
});

describe('OwnInstanceStore', () => {
  it('add кладёт инстанс в workspaceState, токен — только в secrets; повторный add заменяет', async () => {
    const m = memento();
    const sec = secrets();
    const store = new OwnInstanceStore(m, sec, 'ws1');
    let changes = 0;
    store.onChange(() => changes++);
    await store.add(inst, 'T1');
    await store.add({ ...inst, name: 'Renamed' }, 'T2');
    expect(store.list()).toEqual([{ ...inst, name: 'Renamed' }]);
    expect(JSON.stringify(m.data[OWN_INSTANCES_KEY])).not.toContain('T2');
    expect(await store.token(inst.id)).toBe('T2');
    expect([...sec.data.keys()]).toEqual([ownTokenKey('ws1', inst.id)]);
    expect(changes).toBe(2);
  });

  it('remove убирает инстанс и токен; токены воркспейсов не пересекаются', async () => {
    const sec = secrets();
    const a = new OwnInstanceStore(memento(), sec, 'a');
    const b = new OwnInstanceStore(memento(), sec, 'b');
    await a.add(inst, 'TA');
    await b.add(inst, 'TB');
    await a.remove(inst.id);
    expect(a.list()).toEqual([]);
    expect(await a.token(inst.id)).toBeUndefined();
    expect(await b.token(inst.id)).toBe('TB');
  });
});
