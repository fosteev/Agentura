// Запись в копии клиента Jiraffe (этап 8 roadmap 19): комментарий, переходы, ворклог — пути, тела, разбор ответа.
import { describe, expect, it } from 'vitest';
import { createJiraClient, localDate, mapTransitions, startedWithOffset } from './client';

type Call = { url: string; method: string; body?: unknown };

function client(reply: (c: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) };
    calls.push(c);
    const r = reply(c);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(text || null, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const c = createJiraClient({ id: 'i', kind: 'dc', baseUrl: 'https://jira.example.test/jira' }, 'tok', { fetchImpl });
  return { c, calls };
}

describe('JiraClient: запись', () => {
  it('addComment — POST /issue/{key}/comment {body}, id из ответа', async () => {
    const { c, calls } = client(() => ({ status: 201, body: { id: 10234, body: 'x' } }));
    expect(await c.addComment('NEWMFC-1482', 'h3. Итог\n* пункт')).toEqual({ id: '10234' });
    expect(calls).toEqual([
      { url: 'https://jira.example.test/jira/rest/api/2/issue/NEWMFC-1482/comment', method: 'POST', body: { body: 'h3. Итог\n* пункт' } },
    ]);
  });

  it('transitions — GET с expand, обязательные поля без значения по умолчанию → requiresFields', async () => {
    const { c, calls } = client(() => ({
      body: {
        transitions: [
          { id: '11', name: 'В работу', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
          {
            id: '31',
            name: 'Готово',
            to: { name: 'Done', statusCategory: { key: 'done' } },
            fields: { resolution: { required: true, name: 'Resolution' }, comment: { required: false } },
          },
          { id: '41', name: 'Закрыть', to: { name: 'Closed', statusCategory: { key: 'done' } }, fields: { resolution: { required: true, hasDefaultValue: true } } },
        ],
      },
    }));
    expect(await c.transitions('ABC-1')).toEqual([
      { id: '11', name: 'В работу', to: { name: 'In Progress', category: 'indeterminate' }, requiresFields: false },
      { id: '31', name: 'Готово', to: { name: 'Done', category: 'done' }, requiresFields: true },
      { id: '41', name: 'Закрыть', to: { name: 'Closed', category: 'done' }, requiresFields: false },
    ]);
    expect(calls[0]!.url).toBe('https://jira.example.test/jira/rest/api/2/issue/ABC-1/transitions?expand=transitions.fields');
    expect(mapTransitions(undefined)).toEqual([]);
  });

  it('transition — POST {transition:{id}}, 204 без тела', async () => {
    const { c, calls } = client(() => ({ status: 204 }));
    await c.transition('ABC-1', '11');
    expect(calls).toEqual([{ url: 'https://jira.example.test/jira/rest/api/2/issue/ABC-1/transitions', method: 'POST', body: { transition: { id: '11' } } }]);
  });

  it('addWorklog — adjustEstimate=leave, timeSpentSeconds; пустой комментарий не уходит', async () => {
    const { c, calls } = client(() => ({ status: 201, body: { id: 5 } }));
    expect(await c.addWorklog('ABC-1', { started: '2026-10-05T12:00:00.000+0300', timeSpentSec: 3600, comment: '' })).toEqual({ id: '5' });
    expect(calls[0]).toEqual({
      url: 'https://jira.example.test/jira/rest/api/2/issue/ABC-1/worklog?adjustEstimate=leave',
      method: 'POST',
      body: { started: '2026-10-05T12:00:00.000+0300', timeSpentSeconds: 3600 },
    });
  });

  it('startedWithOffset — полдень с локальным смещением без двоеточия; localDate — локальная дата', () => {
    expect(startedWithOffset('2026-10-04')).toMatch(/^2026-10-04T12:00:00\.000[+-]\d{4}$/);
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
