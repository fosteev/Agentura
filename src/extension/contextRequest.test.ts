import { describe, expect, it } from 'vitest';
import { contextRequest, MAX_CONTEXT_CHARS } from './contextRequest';

describe('contextRequest', () => {
  it('без контекста — отказ', () => {
    expect(contextRequest(undefined)).toBeUndefined();
    expect(contextRequest('text')).toBeUndefined();
    expect(contextRequest({ context: '  ' })).toBeUndefined();
    expect(contextRequest({ context: 1 })).toBeUndefined();
  });

  it('имя — один сегмент пути, по умолчанию context.md', () => {
    expect(contextRequest({ context: 'x' })).toEqual({ name: 'context.md', context: 'x' });
    expect(contextRequest({ context: 'x', name: '../a/b.md' })?.name).toBe('.._a_b.md');
    expect(contextRequest({ context: 'x', name: '..' })?.name).toBe('context.md');
    expect(contextRequest({ context: 'x', name: 'GARM-710.md' })?.name).toBe('GARM-710.md');
  });

  it('ключ сессии — только непустая строка; контекст обрезается', () => {
    expect(contextRequest({ context: 'x', sessionKey: '' })).not.toHaveProperty('sessionKey');
    expect(contextRequest({ context: 'x', sessionKey: 5 })).not.toHaveProperty('sessionKey');
    // длинный ключ не режется: `jiraffe:<длинный инстанс>:NEWMFC-1482` → `…:NEWMFC-14` был бы другой задачей
    expect(contextRequest({ context: 'x', sessionKey: `jiraffe:${'a'.repeat(190)}:K-1482` })).not.toHaveProperty('sessionKey');
    expect(contextRequest({ context: 'x', sessionKey: 'jiraffe:a:K-1' })?.sessionKey).toBe(
      'jiraffe:a:K-1',
    );
    expect(contextRequest({ context: 'y'.repeat(MAX_CONTEXT_CHARS + 5) })?.context).toHaveLength(
      MAX_CONTEXT_CHARS,
    );
  });

  it('prompt — только непустая строка', () => {
    expect(contextRequest({ context: 'x', prompt: ' ' })).not.toHaveProperty('prompt');
    expect(contextRequest({ context: 'x', prompt: 'https://j.test/browse/K-1 ' })?.prompt).toBe(
      'https://j.test/browse/K-1 ',
    );
  });

  it('task — проверенные метаданные задачи; мусор отбрасывается', () => {
    const r = contextRequest({
      context: 'x',
      task: {
        key: 'newmfc-1482',
        instanceId: 'JIRA-X-RU',
        title: ' Заголовок ',
        status: 'In Progress',
        statusCategory: 'indeterminate',
        url: 'https://jira.x.ru/browse/NEWMFC-1482',
      },
    });
    expect(r?.task).toEqual({
      key: 'NEWMFC-1482',
      instanceId: 'jira-x-ru',
      title: 'Заголовок',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      url: 'https://jira.x.ru/browse/NEWMFC-1482',
    });
    const bad = (task: unknown) => contextRequest({ context: 'x', task });
    expect(bad(undefined)).not.toHaveProperty('task');
    expect(bad('K-1')).not.toHaveProperty('task');
    expect(bad({ key: 'не ключ', instanceId: 'a' })).not.toHaveProperty('task');
    expect(bad({ key: 'K-1', instanceId: 'a:b' })).not.toHaveProperty('task');
    expect(bad({ key: 'K-1', instanceId: 'a', statusCategory: 'x' })?.task).toEqual({
      key: 'K-1',
      instanceId: 'a',
      title: 'K-1',
      url: '',
    });
    // не http(s) — ссылки нет; длинные поля режутся
    const t = bad({ key: 'K-1', instanceId: 'a', title: 'я'.repeat(900), url: 'javascript:alert(1)' })?.task;
    expect(t?.url).toBe('');
    expect(t?.title).toHaveLength(500);
  });

  it('session — непустая строка; длиннее 200 — отбрасывается (обрезанный id — чужой чат)', () => {
    expect(contextRequest({ context: 'x', session: 'new' })?.session).toBe('new');
    expect(contextRequest({ context: 'x', session: ' ' })).not.toHaveProperty('session');
    expect(contextRequest({ context: 'x', session: 7 })).not.toHaveProperty('session');
    expect(contextRequest({ context: 'x', session: 'a'.repeat(500) })).not.toHaveProperty('session');
  });
});
