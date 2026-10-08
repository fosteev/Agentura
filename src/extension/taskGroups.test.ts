import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../protocol';
import type { MementoLike } from './sessionMemory';
import {
  TaskGroups,
  decorateSessions,
  nextTabTask,
  parseTaskKey,
  routeTaskOpen,
  taskKeyOf,
  taskMeta,
  taskSessionRows,
  type TaskMeta,
} from './taskGroups';

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

const meta = (key = 'NEWMFC-1', extra: Partial<TaskMeta> = {}): TaskMeta => ({
  key,
  instanceId: 'jira-x',
  title: key,
  url: '',
  ...extra,
});
const K1 = taskKeyOf('jira-x', 'NEWMFC-1');
const K2 = taskKeyOf('jira-x', 'NEWMFC-2');

describe('parseTaskKey', () => {
  it('принимает jira: и старый jiraffe:, нормализует регистр', () => {
    expect(parseTaskKey('jira:jira-x:newmfc-1')).toEqual({ taskKey: K1, instanceId: 'jira-x', key: 'NEWMFC-1' });
    expect(parseTaskKey('jiraffe:Jira-X:NEWMFC-1')?.taskKey).toBe(K1);
  });
  it('мусор — undefined', () => {
    for (const v of ['', 'jira:x', 'jira:a:b:K-1', 'foo:a:K-1', 'jira:a:1-1', 5, undefined, 'jira::K-1'])
      expect(parseTaskKey(v)).toBeUndefined();
  });
});

describe('taskMeta', () => {
  it('нет статуса и пустое название — ключ', () => {
    expect(taskMeta({ key: 'K-1', instanceId: 'a', title: '  ' })).toEqual({ key: 'K-1', instanceId: 'a', title: 'K-1', url: '' });
  });
});

describe('TaskGroups', () => {
  it('add: создаёт группу, повторный add сохраняет openedAt и обновляет метаданные', () => {
    const g = new TaskGroups(memento());
    g.add(K1, meta(), { provider: 'claude', id: 's1' }, 100);
    g.add(K1, meta('NEWMFC-1', { title: 'Новое', status: 'Open' }), { provider: 'claude', id: 's1' }, 999);
    // «голые» метаданные хорошее название не затирают
    g.add(K1, meta(), { provider: 'codex', id: 's2' }, 200);
    const grp = g.group(K1)!;
    expect(grp.sessions).toEqual([
      { provider: 'claude', id: 's1' },
      { provider: 'codex', id: 's2' },
    ]);
    expect(grp.openedAt).toEqual({ s1: 100, s2: 200 });
    expect(grp.task).toMatchObject({ title: 'Новое', status: 'Open' });
    expect(g.groupOf('s2')?.taskKey).toBe(K1);
    expect(g.groupOf('нет')).toBeUndefined();
  });

  it('add: ключ не своей задачи и битый id не пишутся', () => {
    const m = memento();
    const g = new TaskGroups(m);
    g.add(K2, meta(), { provider: 'claude', id: 's1' }, 1);
    g.add(K1, meta(), { provider: 'claude', id: '__proto__' }, 1);
    g.add(K1, meta(), { provider: 'claude', id: 'x'.repeat(201) }, 1);
    expect(m.data['agentura.taskGroups']).toBeUndefined();
  });

  it('сессия входит максимум в одну группу; пустая группа исчезает', () => {
    const g = new TaskGroups(memento());
    g.add(K1, meta(), { provider: 'claude', id: 's1' }, 1);
    g.add(K2, meta('NEWMFC-2'), { provider: 'claude', id: 's1' }, 5);
    expect(g.group(K1)).toBeUndefined();
    expect(g.group(K2)?.openedAt.s1).toBe(5);
  });

  it('remove и updateMeta; onChange уведомляет', () => {
    const g = new TaskGroups(memento());
    let n = 0;
    const off = g.onChange(() => n++);
    g.add(K1, meta(), { provider: 'claude', id: 's1' }, 1);
    g.add(K1, meta(), { provider: 'claude', id: 's2' }, 2);
    g.updateMeta(K1, { title: 'T', key: 'HACK-1' });
    expect(g.group(K1)?.task).toMatchObject({ title: 'T', key: 'NEWMFC-1' });
    g.remove('s1');
    expect(g.group(K1)?.sessions).toEqual([{ provider: 'claude', id: 's2' }]);
    g.remove('нет');
    expect(n).toBe(4);
    off();
    g.remove('s2');
    expect(g.groups()).toEqual({});
    expect(n).toBe(4);
  });

  it('мусор в хранилище игнорируется', () => {
    const m = memento({
      'agentura.taskGroups': {
        a: 'x',
        b: { task: { key: 'плохо' }, sessions: [] },
        // ключ не совпадает с задачей внутри — не группа
        [K2]: { task: meta(), sessions: [{ provider: 'claude', id: 's2' }] },
        [K1]: { task: meta(), sessions: [{ provider: 'gpt', id: 'x' }, { provider: 'claude', id: 's1' }, 5] },
      },
    });
    const g = new TaskGroups(m);
    expect(Object.keys(g.groups())).toEqual([K1]);
    expect(g.group(K1)?.sessions).toEqual([{ provider: 'claude', id: 's1' }]);
    expect(g.group(K1)?.openedAt).toEqual({ s1: 0 });
  });

  it('миграция keyedSessions → taskGroups: jiraffe: переезжают, чужие ключи и мусор — нет', () => {
    const m = memento({
      'agentura.keyedSessions': {
        'jiraffe:jira-x:NEWMFC-1': { provider: 'claude', id: 's1' },
        'jiraffe:jira-x:NEWMFC-2': { provider: 'codex', id: 's2' },
        'jiraffe:jira-x:BAD': { provider: 'claude', id: 's3' },
        'jiraffe:jira-x:NEWMFC-3': 'мусор',
        'other:key': { provider: 'claude', id: 's4' },
      },
    });
    const g = new TaskGroups(m);
    expect(g.group(K1)).toEqual({
      task: { key: 'NEWMFC-1', instanceId: 'jira-x', title: 'NEWMFC-1', url: '' },
      sessions: [{ provider: 'claude', id: 's1' }],
      openedAt: { s1: 0 },
    });
    expect(g.group(K2)?.sessions).toEqual([{ provider: 'codex', id: 's2' }]);
    expect(Object.keys(g.groups())).toHaveLength(2);
    expect(m.data['agentura.keyedSessions']).toEqual({ 'other:key': { provider: 'claude', id: 's4' } });
    // повторный запуск ничего не меняет
    new TaskGroups(m);
    expect(Object.keys(new TaskGroups(m).groups())).toHaveLength(2);
  });

  it('миграция: старый ключ удаляется целиком, когда чужих нет; существующие группы не затираются', () => {
    const m = memento({
      'agentura.keyedSessions': { 'jiraffe:jira-x:NEWMFC-1': { provider: 'claude', id: 's9' } },
      'agentura.taskGroups': {
        [K1]: { task: meta('NEWMFC-1', { title: 'Есть' }), sessions: [{ provider: 'claude', id: 's1' }], openedAt: { s1: 7 } },
      },
    });
    const g = new TaskGroups(m);
    expect(m.data['agentura.keyedSessions']).toBeUndefined();
    expect(g.group(K1)?.task.title).toBe('Есть');
    expect(g.group(K1)?.sessions.map((s) => s.id)).toEqual(['s1', 's9']);
    expect(g.group(K1)?.openedAt).toEqual({ s1: 7, s9: 0 });
  });
});

const row = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: `чат ${id}`,
  turns: 1,
  state: 'idle',
  updatedAt,
  ...extra,
});

describe('taskSessions и маршрут openWithContext', () => {
  const g = new TaskGroups(memento());
  g.add(K1, meta(), { provider: 'claude', id: 's1' }, 1);
  g.add(K1, meta(), { provider: 'codex', id: 's2' }, 2);
  g.add(K1, meta(), { provider: 'claude', id: 'unsent' }, 3);
  const rows = [row('s1', 100, { state: 'live' }), row('s2', 300, { provider: 'codex' }), row('other', 999)];
  const group = g.group(K1);

  it('taskSessionRows: только чаты группы из списка, новые сверху, live', () => {
    expect(taskSessionRows(group, rows)).toEqual([
      { id: 's2', provider: 'codex', title: 'чат s2', updatedAt: 300, live: false },
      { id: 's1', provider: 'claude', title: 'чат s1', updatedAt: 100, live: true },
    ]);
    expect(taskSessionRows(undefined, rows)).toEqual([]);
  });

  it('session: id — возобновить его', () => {
    expect(routeTaskOpen(group, rows, 's1')).toEqual({ kind: 'resume', ref: { provider: 'claude', id: 's1' } });
  });
  it("session: 'new' — новая вкладка", () => {
    expect(routeTaskOpen(group, rows, 'new')).toEqual({ kind: 'new' });
  });
  it('session не задан — последний чат группы; группы или чатов в списке нет — новая', () => {
    expect(routeTaskOpen(group, rows, undefined)).toEqual({ kind: 'resume', ref: { provider: 'codex', id: 's2' } });
    expect(routeTaskOpen(group, [], undefined)).toEqual({ kind: 'new' });
    expect(routeTaskOpen(undefined, rows, undefined)).toEqual({ kind: 'new' });
  });
  it('id не из группы — как не заданный, чужую сессию не открываем', () => {
    expect(routeTaskOpen(group, rows, 'other')).toEqual({ kind: 'resume', ref: { provider: 'codex', id: 's2' } });
  });
});

describe('decorateSessions', () => {
  it('метка task у строк и список групп только с сессиями из списка', () => {
    const g = new TaskGroups(memento());
    g.add(K1, meta('NEWMFC-1', { title: 'Фикс', status: 'Open', statusCategory: 'new' }), { provider: 'claude', id: 's1' }, 1);
    g.add(K2, meta('NEWMFC-2'), { provider: 'claude', id: 'gone' }, 1);
    const { sessions, tasks } = decorateSessions([row('s1', 1), row('s0', 2)], g.groups());
    expect(sessions[0]?.task).toEqual({ key: 'NEWMFC-1', title: 'Фикс', status: 'Open', statusCategory: 'new' });
    expect(sessions[1]).not.toHaveProperty('task');
    expect(tasks).toEqual([
      { taskKey: K1, meta: expect.objectContaining({ key: 'NEWMFC-1' }), sessionIds: ['s1'] },
    ]);
  });
});

describe('nextTabTask (/clear во вкладке задачи)', () => {
  const task = { taskKey: 'jira:inst:ABC-1', meta: { key: 'ABC-1', instanceId: 'inst', title: 'T', url: '' } };
  const none = () => undefined;

  it('/clear: задача из группы переходит в ожидание, ключ вкладки не снимается', () => {
    expect(nextTabTask({ member: task }, { clear: true }, none)).toEqual({ pending: task });
  });

  it('следом пришёл id новой сессии: она входит в ту же группу', () => {
    const afterClear = nextTabTask({ member: task }, { clear: true }, none);
    const joined = nextTabTask(afterClear, { id: 'new-sess' }, none);
    expect(joined.join).toEqual(task);
    expect(joined.member).toEqual(task);
    expect(joined.pending).toBeUndefined();
  });

  it('/clear во вкладке вне задачи ничего не привязывает', () => {
    expect(nextTabTask({}, { clear: true }, none)).toEqual({});
  });

  it('сбой возобновления (id нет, не /clear): группу не наследуем, ожидание сохраняется', () => {
    expect(nextTabTask({ member: task }, {}, none)).toEqual({});
    expect(nextTabTask({ pending: task }, {}, none)).toEqual({ pending: task });
  });

  it('id без ожидания: вкладка узнаёт группу сессии', () => {
    const group = { task: task.meta, sessions: [], openedAt: {} };
    expect(nextTabTask({}, { id: 's1' }, (id) => (id === 's1' ? { taskKey: task.taskKey, group } : undefined))).toEqual({
      member: { taskKey: task.taskKey, meta: task.meta },
    });
    expect(nextTabTask({}, { id: 's2' }, none)).toEqual({});
  });
});
