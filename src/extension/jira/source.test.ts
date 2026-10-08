import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createJiraClient } from '../../data/jira/client';
import { JIRA_SOURCES, type JiraSourceSetting } from '../../settings';
import { parseJiraffeApi, type JiraffeApi } from './jiraffeApi';
import { OwnInstanceStore, type OwnInstance } from './ownInstances';
import { isIsoDate, JiraSources, JiraffeSource, OwnSource, normalizeIssueKey, resolveSourceKind } from './source';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/jira/issue-dc.json'), 'utf8'));

describe('resolveSourceKind: четыре значения настройки × Jiraffe есть/нет × свои есть/нет', () => {
  const cases: [JiraSourceSetting, boolean, boolean, 'jiraffe' | 'own' | undefined][] = [
    ['auto', true, true, 'jiraffe'],
    ['auto', true, false, 'jiraffe'],
    ['auto', false, true, 'own'],
    ['auto', false, false, undefined],
    ['jiraffe', true, true, 'jiraffe'],
    ['jiraffe', true, false, 'jiraffe'],
    ['jiraffe', false, true, undefined],
    ['jiraffe', false, false, undefined],
    ['own', true, true, 'own'],
    ['own', false, true, 'own'],
    ['own', true, false, undefined],
    ['own', false, false, undefined],
    ['off', true, true, undefined],
    ['off', true, false, undefined],
    ['off', false, true, undefined],
    ['off', false, false, undefined],
  ];
  it.each(cases)('%s, Jiraffe=%s, свои=%s → %s', (setting, jiraffe, own, want) => {
    expect(resolveSourceKind(setting, { jiraffe, own })).toBe(want);
  });

  it('все значения настройки покрыты таблицей', () => {
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(JIRA_SOURCES));
  });
});

describe('parseJiraffeApi', () => {
  const api = (over: object = {}) => ({
    apiVersion: 1,
    instances: () => [],
    issue: async () => ({}),
    myself: async () => ({ displayName: 'x' }),
    openIssue: async () => undefined,
    onDidChangeInstances: () => ({ dispose() {} }),
    ...over,
  });

  it('форма v1 принимается, v2+ тоже (подмножество v1)', () => {
    expect(parseJiraffeApi(api())).toBeDefined();
    expect(parseJiraffeApi(api({ apiVersion: 2 }))).toBeDefined();
  });

  it('exports undefined (недоверенный воркспейс / старый Jiraffe), apiVersion < 1, нет метода — API нет', () => {
    expect(parseJiraffeApi(undefined)).toBeUndefined();
    expect(parseJiraffeApi(null)).toBeUndefined();
    expect(parseJiraffeApi({})).toBeUndefined();
    expect(parseJiraffeApi(api({ apiVersion: 0 }))).toBeUndefined();
    expect(parseJiraffeApi(api({ apiVersion: '1' }))).toBeUndefined();
    expect(parseJiraffeApi(api({ issue: undefined }))).toBeUndefined();
  });
});

describe('normalizeIssueKey', () => {
  it('тримит и поднимает регистр; не ключ — ошибка', () => {
    expect(normalizeIssueKey(' abc-12 ')).toBe('ABC-12');
    expect(() => normalizeIssueKey('../x')).toThrow(/invalid issue key/);
    expect(() => normalizeIssueKey(5)).toThrow();
  });
});

function fakeJiraffe(over: Partial<JiraffeApi> = {}): JiraffeApi & { fire(): void; calls: unknown[][] } {
  const listeners = new Set<() => unknown>();
  const calls: unknown[][] = [];
  return {
    apiVersion: 1,
    instances: () => [{ id: 'jf', name: 'JF', baseUrl: 'https://jf.example', kind: 'dc' }],
    issue: async (...a) => {
      calls.push(['issue', ...a]);
      return { issue: { key: 'A-1' } as never, worklogs: [] };
    },
    myself: async () => ({ name: 'ivan', displayName: 'Ivan' }),
    openIssue: async (...a) => void calls.push(['open', ...a]),
    onDidChangeInstances: (l) => {
      listeners.add(l);
      return { dispose: () => void listeners.delete(l) };
    },
    ...over,
    fire: () => listeners.forEach((l) => l()),
    calls,
  };
}

function memento(init: Record<string, unknown> = {}) {
  const data = { ...init };
  return { get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => void (data[k] = v), data };
}
function secrets() {
  const data = new Map<string, string>();
  return { get: async (k: string) => data.get(k), store: async (k: string, v: string) => void data.set(k, v), delete: async (k: string) => void data.delete(k), data };
}

const ownInst: OwnInstance = { id: 'own', name: 'Own', baseUrl: 'https://own.example', kind: 'dc' };

function ownStore(withInstance = true) {
  const store = new OwnInstanceStore(memento(), secrets(), 'ws');
  return { store, ready: withInstance ? store.add(ownInst, 'tok') : Promise.resolve() };
}

function manager(opts: {
  setting?: JiraSourceSetting;
  installed?: boolean;
  exports?: unknown | (() => never);
  own?: boolean;
}) {
  const { store, ready } = ownStore(opts.own ?? false);
  let setting = opts.setting ?? 'auto';
  const exportsCalls = vi.fn(async () => {
    if (typeof opts.exports === 'function') return (opts.exports as () => never)();
    return opts.exports;
  });
  const m = new JiraSources({
    setting: () => setting,
    jiraffeInstalled: () => opts.installed ?? true,
    jiraffeExports: exportsCalls,
    own: new OwnSource(store),
    parse: parseJiraffeApi,
  });
  return { m, store, ready, exportsCalls, setSetting: (s: JiraSourceSetting) => (setting = s) };
}

describe('JiraSources', () => {
  it('auto: Jiraffe с API → источник jiraffe; свои — запасной', async () => {
    const jf = fakeJiraffe();
    const { m, ready } = manager({ exports: jf, own: true });
    await ready;
    await m.refresh();
    expect(m.current()?.kind).toBe('jiraffe');
    expect(m.jiraffeStatus()).toMatchObject({ state: 'ready', instances: 1, apiVersion: 1 });
  });

  it('старый Jiraffe (exports без API) или недоверенный воркспейс (undefined): auto падает на свои, jiraffe — недоступен', async () => {
    for (const exp of [undefined, {}, { apiVersion: 0 }]) {
      const a = manager({ exports: exp, own: true });
      await a.ready;
      await a.m.refresh();
      expect(a.m.jiraffeStatus().state).toBe('no-api');
      expect(a.m.current()?.kind).toBe('own');
      const b = manager({ exports: exp, own: true, setting: 'jiraffe' });
      await b.ready;
      await b.m.refresh();
      expect(b.m.current()).toBeUndefined();
    }
  });

  it('активация Jiraffe бросила — как «API нет»', async () => {
    const { m } = manager({
      exports: () => {
        throw new Error('boom');
      },
    });
    await m.refresh();
    expect(m.jiraffeStatus().state).toBe('no-api');
    expect(m.current()).toBeUndefined();
  });

  it('Jiraffe не установлен: absent, активация не вызывается', async () => {
    const { m, exportsCalls } = manager({ installed: false });
    await m.refresh();
    expect(m.jiraffeStatus().state).toBe('absent');
    expect(exportsCalls).not.toHaveBeenCalled();
  });

  it('own и off не трогают Jiraffe (не активируют расширение)', async () => {
    for (const setting of ['own', 'off'] as const) {
      const { m, exportsCalls, ready } = manager({ setting, exports: fakeJiraffe(), own: true });
      await ready;
      await m.refresh();
      expect(exportsCalls).not.toHaveBeenCalled();
    }
  });

  it('auto → own: Jiraffe больше не «ready» со старыми инстансами, а inactive; обратно — снова ready', async () => {
    const { m, ready, setSetting } = manager({ setting: 'auto', exports: fakeJiraffe(), own: true });
    await ready;
    await m.refresh();
    expect(m.jiraffeStatus()).toMatchObject({ state: 'ready', instances: 1 });
    setSetting('own');
    await m.refresh();
    expect(m.jiraffeStatus()).toEqual({ state: 'inactive', instances: 0 });
    setSetting('auto');
    await m.refresh();
    expect(m.jiraffeStatus().state).toBe('ready');
  });

  it('jiraffeInstances и activeKind — данные для страницы настроек', async () => {
    const { m, ready, setSetting } = manager({ exports: fakeJiraffe(), own: true });
    await ready;
    expect(m.activeKind()).toBe('own'); // до refresh Jiraffe ещё нет
    await m.refresh();
    expect(m.jiraffeInstances().map((i) => i.id)).toEqual(['jf']);
    expect(m.activeKind()).toBe('jiraffe');
    setSetting('own');
    await m.refresh();
    expect(m.jiraffeInstances()).toEqual([]);
    expect(m.activeKind()).toBe('own');
    setSetting('off');
    expect(m.activeKind()).toBeUndefined();
  });

  it('смена настройки и onDidChangeInstances Jiraffe дают onDidChange; без изменений — тишина', async () => {
    const jf = fakeJiraffe();
    const { m, setSetting } = manager({ exports: jf });
    const changed = vi.fn();
    m.onDidChange(changed);
    await m.refresh();
    expect(changed).toHaveBeenCalledTimes(1);
    await m.refresh();
    expect(changed).toHaveBeenCalledTimes(1);
    setSetting('off');
    await m.refresh();
    expect(changed).toHaveBeenCalledTimes(2);
    setSetting('auto');
    await m.refresh();
    changed.mockClear();
    jf.fire();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('forInstance при auto: инстанса нет в Jiraffe, но есть среди своих — свой источник; при явном jiraffe подмены нет', async () => {
    const jf = fakeJiraffe();
    const a = manager({ exports: jf, own: true });
    await a.ready;
    await a.m.refresh();
    expect(a.m.forInstance('jf')?.kind).toBe('jiraffe');
    expect(a.m.forInstance('own')?.kind).toBe('own');
    expect(a.m.forInstance('nope')).toBeUndefined();
    a.setSetting('jiraffe');
    expect(a.m.forInstance('own')).toBeUndefined();
    expect(a.m.allInstances().map((i) => i.id)).toEqual(['jf']);
    a.setSetting('auto');
    expect(a.m.allInstances().map((i) => i.id)).toEqual(['jf', 'own']);
  });
});

describe('JiraffeSource', () => {
  it('ключ нормализуется до вызова API; чужой ключ не доходит', async () => {
    const jf = fakeJiraffe();
    const src = new JiraffeSource(jf);
    await src.issue('jf', ' a-1 ');
    await src.openIssue('jf', 'a-1', true);
    expect(jf.calls).toEqual([['issue', 'jf', 'A-1'], ['open', 'jf', 'A-1', true]]);
    await expect(src.issue('jf', 'x/../y')).rejects.toThrow(/invalid issue key/);
    expect(src.instances()).toEqual([{ id: 'jf', name: 'JF', baseUrl: 'https://jf.example', kind: 'dc' }]);
  });

  it('instances() чужого расширения: бросил / не массив / мусорные записи — без падения, только валидное', () => {
    const jf = fakeJiraffe();
    const throwing = new JiraffeSource({ ...jf, instances: () => { throw new Error('boom'); } });
    expect(throwing.instances()).toEqual([]);
    const notArray = new JiraffeSource({ ...jf, instances: () => 'x' as never });
    expect(notArray.instances()).toEqual([]);
    const junk = new JiraffeSource({
      ...jf,
      instances: () =>
        [null, { id: 1 }, { id: 'a', baseUrl: 'javascript:x' }, { id: 'b', name: {}, baseUrl: 'https://b.example', kind: 'zzz' }] as never,
    });
    expect(junk.instances()).toEqual([{ id: 'b', name: 'b', baseUrl: 'https://b.example', kind: 'dc' }]);
  });
});

describe('JiraffeSource: запись (API v2, этап 8)', () => {
  const v2 = (calls: unknown[][], over: Partial<JiraffeApi> = {}) =>
    fakeJiraffe({
      apiVersion: 2,
      addComment: async (...a) => {
        calls.push(['comment', ...a]);
        return { id: '77' };
      },
      transitions: async (...a) => {
        calls.push(['transitions', ...a]);
        return [
          { id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' }, requiresFields: false },
          { id: 5 as never, name: 'junk', to: {} as never, requiresFields: false },
          { id: '31', name: 'Done', to: { name: 'Done', category: 'zzz' as never }, requiresFields: true },
        ];
      },
      transition: async (...a) => void calls.push(['transition', ...a]),
      logWork: async (...a) => {
        calls.push(['logWork', ...a]);
        return { via: 'jira', id: '9' };
      },
      ...over,
    });

  it('v1 — источник только читает; v2 без одного из методов — тоже', () => {
    expect(new JiraffeSource(fakeJiraffe()).writer).toBeUndefined();
    expect(new JiraffeSource(v2([], { logWork: undefined })).writer).toBeUndefined();
    expect(new JiraffeSource(v2([], { apiVersion: 3 })).writer).toBeDefined();
  });

  it('ключ нормализуется, тело и ворклог проверяются до вызова; ответы чужого расширения — по форме', async () => {
    const calls: unknown[][] = [];
    const w = new JiraffeSource(v2(calls)).writer!;
    expect(await w.addComment('jf', ' a-1 ', 'h3. Итог')).toEqual({ id: '77' });
    await expect(w.addComment('jf', 'A-1', '   ')).rejects.toThrow(/empty/);
    await expect(w.addComment('jf', 'A-1', 'x'.repeat(32_001))).rejects.toThrow(/32000/);
    expect(await w.transitions('jf', 'a-1')).toEqual([
      { id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' }, requiresFields: false },
      { id: '31', name: 'Done', to: { name: 'Done', category: 'indeterminate' }, requiresFields: true },
    ]);
    await w.transition('jf', 'a-1', '11');
    expect(await w.logWork('jf', 'a-1', { seconds: 5400, date: '2026-10-05', comment: '' })).toEqual({ id: '9' });
    await expect(w.logWork('jf', 'A-1', { seconds: 0, date: '2026-10-05', comment: '' })).rejects.toThrow(/seconds/);
    await expect(w.logWork('jf', 'A-1', { seconds: 60, date: '2026-02-31', comment: '' })).rejects.toThrow(/invalid date/);
    await expect(w.addComment('jf', 'x/../y', 'a')).rejects.toThrow(/invalid issue key/);
    expect(calls).toEqual([
      ['comment', 'jf', 'A-1', 'h3. Итог'],
      ['transitions', 'jf', 'A-1'],
      ['transition', 'jf', 'A-1', '11'],
      ['logWork', 'jf', 'A-1', { seconds: 5400, started: '2026-10-05' }],
    ]);
  });

  it('ворклог в Tempo — id не отдаётся (это не id ворклога Jira в ленте); отказ Jiraffe — как есть', async () => {
    const tempo = new JiraffeSource(v2([], { logWork: async () => ({ via: 'tempo', id: 't-1' }) })).writer!;
    expect(await tempo.logWork('jf', 'A-1', { seconds: 60, date: '2026-10-05', comment: 'x' })).toEqual({});
    const busy = new JiraffeSource(
      v2([], { addComment: async () => Promise.reject(new Error('Jiraffe: comment for A-1 is already being sent')) }),
    ).writer!;
    await expect(busy.addComment('jf', 'A-1', 'x')).rejects.toThrow(/already being sent/);
  });

  it('JiraSources.canWrite: текущий источник с записью', async () => {
    const a = manager({ exports: v2([]) });
    await a.m.refresh();
    expect(a.m.canWrite()).toBe(true);
    const b = manager({ exports: fakeJiraffe() });
    await b.m.refresh();
    expect(b.m.canWrite()).toBe(false);
    const c = manager({ installed: false });
    await c.m.refresh();
    expect(c.m.canWrite()).toBe(false);
    const d = manager({ installed: false, own: true });
    await d.ready;
    await d.m.refresh();
    expect(d.m.canWrite()).toBe(true);
  });
});

describe('isIsoDate', () => {
  it('только существующая дата YYYY-MM-DD', () => {
    expect(isIsoDate('2026-10-05')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    for (const d of ['2026-02-31', '2026-13-01', '2026-1-5', '2026-10-05T00:00', 20261005, undefined]) expect(isIsoDate(d)).toBe(false);
  });
});

describe('OwnSource', () => {
  const routes = (u: URL) => {
    if (u.pathname === '/rest/api/2/issue/ABC-123') return fixture.issue;
    if (u.pathname.endsWith('/watchers')) return fixture.watchers;
    if (u.pathname.endsWith('/worklog')) return fixture.worklog;
    if (u.pathname === '/rest/api/2/myself') return { name: 'ivan.petrov', displayName: 'Ivan Petrov', emailAddress: 'secret@example.test' };
    return undefined;
  };
  const fetchImpl = (async (u: string) => {
    const body = routes(new URL(u));
    return body ? new Response(JSON.stringify(body)) : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  async function setup(inst: OwnInstance = ownInst) {
    const { store } = ownStore(false);
    await store.add(inst, 'tok');
    return new OwnSource(store, (i, token) => createJiraClient(i, token, { fetchImpl }));
  }

  it('issue: карточка и ворклоги из REST; myself DC — name без email', async () => {
    const src = await setup();
    const { issue, worklogs } = await src.issue('own', 'abc-123');
    expect(issue.key).toBe('ABC-123');
    expect(worklogs).toHaveLength(1);
    expect(await src.myself('own')).toEqual({ name: 'ivan.petrov', displayName: 'Ivan Petrov' });
  });

  it('Cloud: myself отдаёт accountId', async () => {
    const cloudFetch = (async () => new Response(JSON.stringify({ accountId: 'acc1', displayName: 'Anna', emailAddress: 'a@b.c' }))) as unknown as typeof fetch;
    const { store } = ownStore(false);
    await store.add({ id: 'c', name: 'C', baseUrl: 'https://x.atlassian.net', kind: 'cloud', email: 'a@b.c' }, 'tok');
    const src = new OwnSource(store, (i, token) => createJiraClient(i, token, { fetchImpl: cloudFetch }));
    expect(await src.myself('c')).toEqual({ accountId: 'acc1', displayName: 'Anna' });
  });

  it('нет инстанса / нет токена / плохой ключ — reject, запрос не уходит', async () => {
    const src = await setup();
    await expect(src.issue('missing', 'ABC-1')).rejects.toThrow(/unknown instance/);
    await expect(src.issue('own', '???')).rejects.toThrow(/invalid issue key/);
    const sec = secrets();
    const store = new OwnInstanceStore(memento({ 'agentura.jira.instances': [ownInst] }), sec, 'ws');
    await expect(new OwnSource(store).issue('own', 'ABC-1')).rejects.toThrow(/token not found/);
  });
});

describe('OwnSource: запись (этап 8)', () => {
  type Call = { method: string; path: string; query: string; body?: unknown };
  async function setup() {
    const calls: Call[] = [];
    const fetchImpl = (async (u: string, init: RequestInit = {}) => {
      const url = new URL(u);
      calls.push({
        method: init.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.pathname.endsWith('/transitions') && (init.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            transitions: [
              { id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
              { id: '31', name: 'Resolve', to: { name: 'Done', statusCategory: { key: 'done' } }, fields: { resolution: { required: true } } },
            ],
          }),
        );
      }
      if (url.pathname.endsWith('/comment')) return new Response(JSON.stringify({ id: '100' }), { status: 201 });
      if (url.pathname.endsWith('/worklog')) return new Response(JSON.stringify({ id: '200' }), { status: 201 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { store } = ownStore(false);
    await store.add(ownInst, 'tok');
    return { calls, w: new OwnSource(store, (i, token) => createJiraClient(i, token, { fetchImpl })).writer };
  }

  it('комментарий, переход по свежему списку, ворклог — стандартный worklog Jira в полдень дня', async () => {
    const { calls, w } = await setup();
    expect(await w.addComment('own', 'abc-1', '*жирный*')).toEqual({ id: '100' });
    await w.transition('own', 'ABC-1', '11');
    expect(await w.logWork('own', 'ABC-1', { seconds: 3600, date: '2026-10-05', comment: 'сделал' })).toEqual({ id: '200' });
    expect(calls.map((c) => `${c.method} ${c.path}${c.query}`)).toEqual([
      'POST /rest/api/2/issue/ABC-1/comment',
      'GET /rest/api/2/issue/ABC-1/transitions?expand=transitions.fields',
      'POST /rest/api/2/issue/ABC-1/transitions',
      'POST /rest/api/2/issue/ABC-1/worklog?adjustEstimate=leave',
    ]);
    expect(calls[0]!.body).toEqual({ body: '*жирный*' });
    expect(calls[2]!.body).toEqual({ transition: { id: '11' } });
    const wl = calls[3]!.body as { started: string; timeSpentSeconds: number; comment: string };
    expect(wl.timeSpentSeconds).toBe(3600);
    expect(wl.comment).toBe('сделал');
    expect(wl.started).toMatch(/^2026-10-05T12:00:00\.000[+-]\d{4}$/);
  });

  it('переход не из списка или с обязательными полями — отказ без записи', async () => {
    const { calls, w } = await setup();
    await expect(w.transition('own', 'ABC-1', '99')).rejects.toThrow(/not available/);
    await expect(w.transition('own', 'ABC-1', '31')).rejects.toThrow(/requires screen fields/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
