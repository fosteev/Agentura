// Скопировано из fosteev/jiraffe 0.7.0 test/mappers.issue.test.ts (без sanitize). Правки: фикстура читается через fs, без дозапроса эпика.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJiraClient } from './client';
import { epicFieldOf, mapEpic, mapHistory, mapIssueDetail, mapWorklog } from './mappers';
import type { Instance } from './types';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/jira/issue-dc.json'), 'utf8'));
const raw = fixture.issue as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const dc: Pick<Instance, 'id' | 'kind' | 'epicLinkField' | 'caps'> = {
  id: 'i1', kind: 'dc', caps: { tempo: true, epicLinkField: 'customfield_10100', checkedAt: '2026-01-01T00:00:00Z' },
};
const watchers = fixture.watchers.watchers.map((w: { name: string; displayName: string }) => ({ id: w.name, name: w.displayName }));

describe('mapIssueDetail (фикстура DC)', () => {
  const d = mapIssueDetail(dc, raw, watchers);

  it('основные поля', () => {
    expect(d).toMatchObject({
      instanceId: 'i1', key: 'ABC-123', summary: 'Fix export of the report to CSV', type: 'Задача',
      status: 'В работе', statusCategory: 'indeterminate', priority: 'Medium',
      assignee: { id: 'ivan.petrov', name: 'Ivan Petrov' }, reporter: { id: 'ivan.petrov', name: 'Ivan Petrov' },
      labels: ['backend', 'urgent'], components: ['API'], fixVersions: [{ id: '20001', name: '1.7.0' }],
      created: '2026-07-17T08:51:23.135+0300',
    });
    expect(d.due).toBeUndefined();
    expect(d.watchers).toHaveLength(2);
  });

  it('эпик из Epic Link (caps) и из переопределения инстанса', () => {
    expect(d.epic).toEqual({ key: 'ABC-100' });
    expect(mapIssueDetail({ ...dc, epicLinkField: 'customfield_99999' }, raw).epic).toBeUndefined(); // переопределение главнее caps
    expect(mapIssueDetail({ ...dc, caps: { ...dc.caps!, epicLinkField: null } }, raw).epic).toBeUndefined();
  });

  it('время: remaining/spent из timetracking', () => {
    expect(d.timetracking).toEqual({ remainingSec: 0, spentSec: 2400 });
  });

  it('описание — rendered HTML; комментарии — rendered по id, автор по name', () => {
    expect(d.descriptionHtml).toContain('<h2>');
    expect(d.comments).toHaveLength(2);
    expect(d.comments[0]).toMatchObject({ id: '50000', author: { id: 'ivan.petrov' }, bodyHtml: '<p>Looks reproducible, taking it.</p>' });
    expect(d.comments[1]!.bodyHtml).toContain('<ol>');
  });

  it('описание без renderedFields — экранированный plain, а не «не заполнено»', () => {
    const d2 = mapIssueDetail(dc, { ...raw, renderedFields: undefined, fields: { ...raw.fields, description: 'a <b>\nb' } });
    expect(d2.descriptionHtml).toBe('<p>a &lt;b&gt;<br>b</p>');
  });
  it('вложения: contentUrl и thumbnailUrl', () => {
    expect(d.attachments).toEqual([expect.objectContaining({ id: '40001', filename: 'report.png', size: 20480, mimeType: 'image/png', contentUrl: expect.stringContaining('/secure/attachment/40001/'), thumbnailUrl: expect.stringContaining('thumb') })]);
  });

  it('история: «было → стало», новые сверху, шум (WorklogId, timespent) вычищен', () => {
    const fields = d.history.flatMap((h) => h.items.map((i) => i.field));
    expect(fields).not.toContain('WorklogId');
    expect(fields).not.toContain('timespent');
    const times = d.history.map((h) => Date.parse(h.created));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const status = d.history.flatMap((h) => h.items).find((i) => i.field === 'status' && i.from === 'Open');
    expect(status).toEqual({ field: 'status', from: 'Open', to: 'In Progress' });
    const fix = d.history.flatMap((h) => h.items).find((i) => i.field === 'Fix Version');
    expect(fix).toEqual({ field: 'Fix Version', from: null, to: '1.7.0' });
  });

  it('worklog: секунды, автор, комментарий', () => {
    const w = mapWorklog('dc', fixture.worklog.worklogs[0]);
    expect(w).toMatchObject({ id: '60000', timeSpentSec: 2400, comment: 'Investigation and fix', author: { id: 'ivan.petrov' } });
    expect(w.started).toBe('2026-07-17T12:00:00.000+0300');
  });

  it('фикстура обезличена', () => {
    // Белый список вместо перечня настоящих имён: в фикстуре только example.test, ключи ABC и три выдуманных человека.
    const s = JSON.stringify(fixture);
    const hosts = new Set([...s.matchAll(/https?:\/\/([^/"\\:]+)/g)].map((m) => m[1]));
    expect([...hosts].every((h) => h!.endsWith('example.test'))).toBe(true);
    expect(s).not.toMatch(/@(?!example\.test)[\w.-]+\.\w+/);
    expect(new Set([...s.matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)].map((m) => m[1]))).toEqual(new Set(['ABC']));
    const names = new Set([...s.matchAll(/"displayName":"([^"]*)"/g)].map((m) => m[1]));
    expect([...names].every((n) => ['Ivan Petrov', 'Anna Smirnova', 'Oleg Sidorov'].includes(n!))).toBe(true);
  });
});

describe('контракт эпика', () => {
  it('DC: instance.epicLinkField ?? caps.epicLinkField; Cloud — null (поле не используется)', () => {
    expect(epicFieldOf({ kind: 'dc', epicLinkField: 'cf_1', caps: { tempo: false, epicLinkField: 'cf_2', checkedAt: '' } })).toBe('cf_1');
    expect(epicFieldOf({ kind: 'dc', caps: { tempo: false, epicLinkField: 'cf_2', checkedAt: '' } })).toBe('cf_2');
    expect(epicFieldOf({ kind: 'dc' })).toBeNull();
    expect(epicFieldOf({ kind: 'cloud', caps: { tempo: false, epicLinkField: 'cf_2', checkedAt: '' } })).toBeNull();
  });

  it('Cloud: parent с hierarchyLevel 1 — эпик (с названием), родитель подзадачи — нет', () => {
    const epic = { parent: { key: 'ABC-1', fields: { summary: 'Epic S', issuetype: { name: 'Epic', hierarchyLevel: 1 } } } };
    const sub = { parent: { key: 'ABC-2', fields: { summary: 'Task S', issuetype: { name: 'Task', hierarchyLevel: 0 } } } };
    expect(mapEpic('cloud', null, epic)).toEqual({ key: 'ABC-1', summary: 'Epic S' });
    expect(mapEpic('cloud', null, sub)).toBeUndefined();
    expect(mapEpic('cloud', null, {})).toBeUndefined();
    // на Cloud кастомное поле не смотрим, даже если его передали
    expect(mapEpic('cloud', 'customfield_10014', { customfield_10014: 'ABC-9' })).toBeUndefined();
  });
});

describe('mapHistory', () => {
  it('запись только из шума отбрасывается', () => {
    const h = mapHistory('dc', { histories: [{ created: '2026-01-01T00:00:00.000+0000', author: { name: 'a', displayName: 'A' }, items: [{ field: 'timespent', toString: '60' }] }] });
    expect(h).toEqual([]);
  });
});

describe('JiraClient: карточка', () => {
  function client(route: (u: URL) => { status?: number; body: unknown } | undefined, kind: 'dc' | 'cloud' = 'dc') {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      const r = route(new URL(u));
      return r ? new Response(JSON.stringify(r.body), { status: r.status ?? 200 }) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { c: createJiraClient({ id: 'i1', kind, baseUrl: 'https://h.example', email: 'a@b.c' }, 'tok', { fetchImpl }), urls };
  }

  it('issueDetail: expand=renderedFields,changelog, watchers, worklog; название эпика DC не дозапрашивается', async () => {
    const { c, urls } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/ABC-123') return { body: raw };
      if (u.pathname.endsWith('/watchers')) return { body: fixture.watchers };
      if (u.pathname.endsWith('/worklog')) return { body: fixture.worklog };
      return undefined;
    });
    const { issue, worklogs } = await c.issueDetail('ABC-123', dc);
    const main = urls.map((x) => new URL(x)).find((u) => u.pathname === '/rest/api/2/issue/ABC-123')!;
    expect(main.searchParams.get('expand')).toBe('renderedFields,changelog');
    expect(issue.epic).toEqual({ key: 'ABC-100' });
    expect(issue.watchers).toHaveLength(2);
    expect(worklogs).toHaveLength(1);
  });

  it('watchers и worklog: 403 — пустой список, а не ошибка карточки; эпик без названия', async () => {
    const { c } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/ABC-123') return { body: raw };
      if (u.pathname.endsWith('/watchers') || u.pathname.endsWith('/worklog')) return { status: 403, body: { errorMessages: ['no'] } };
      return { status: 500, body: {} };
    });
    const { issue, worklogs, worklogError } = await c.issueDetail('ABC-123', dc);
    expect(issue.watchers).toEqual([]);
    expect(worklogs).toEqual([]);
    expect(worklogError).toBeUndefined();
    expect(issue.epic).toEqual({ key: 'ABC-100' });
  });

  it('watchers и worklog: 500 — карточка есть, журнал пуст с текстом ошибки; ошибка самой задачи — ошибка карточки', async () => {
    const { c } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/ABC-123') return { body: raw };
      return { status: 500, body: { errorMessages: ['boom'] } };
    });
    const r = await c.issueDetail('ABC-123', dc);
    expect(r.issue.watchers).toEqual([]);
    expect(r.worklogs).toEqual([]);
    expect(r.worklogError).toBeTruthy();
    expect(r.worklogError).not.toContain('tok');
    const { c: c2 } = client(() => ({ status: 500, body: {} }));
    await expect(c2.issueDetail('ABC-123', dc)).rejects.toThrow();
  });

  it('Cloud: эпик из parent, дозапроса эпика нет, watchers по accountId', async () => {
    const cloudRaw = { key: 'X-2', fields: { summary: 's', issuetype: { name: 'Task' }, status: { name: 'To Do', statusCategory: { key: 'new' } }, parent: { key: 'X-1', fields: { summary: 'Epic', issuetype: { hierarchyLevel: 1 } } }, comment: { comments: [] } } };
    const { c, urls } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/X-2') return { body: cloudRaw };
      if (u.pathname.endsWith('/watchers')) return { body: { watchers: [{ accountId: 'acc1', displayName: 'Anna' }] } };
      if (u.pathname.endsWith('/worklog')) return { body: { worklogs: [] } };
      return undefined;
    }, 'cloud');
    const { issue } = await c.issueDetail('X-2', { id: 'c', kind: 'cloud' });
    expect(issue.epic).toEqual({ key: 'X-1', summary: 'Epic' });
    expect(issue.watchers).toEqual([{ id: 'acc1', name: 'Anna' }]);
    expect(urls.some((u) => u.includes('/issue/X-1'))).toBe(false);
  });
});

describe('JiraClient.myself', () => {
  const run = (kind: 'dc' | 'cloud', body: object) => {
    const fetchImpl = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    return createJiraClient({ id: 'i', kind, baseUrl: 'https://h.example', email: 'a@b.c' }, 'tok', { fetchImpl }).myself();
  };

  it('DC — id = name, Cloud — id = accountId; email приходит, наружу отдаёт уже слой источника', async () => {
    expect(await run('dc', { name: 'ivan', displayName: 'Ivan', emailAddress: 'i@example.test' })).toMatchObject({ id: 'ivan', name: 'ivan', displayName: 'Ivan' });
    expect(await run('cloud', { accountId: 'acc1', displayName: 'Anna' })).toMatchObject({ id: 'acc1', displayName: 'Anna' });
  });
});
