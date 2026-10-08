import { describe, expect, it } from 'vitest';
import { instanceIdFromUrl, parseIssueInput } from './taskLink';

describe('parseIssueInput', () => {
  it('ключ', () => {
    expect(parseIssueInput(' newmfc-1482 ')).toEqual({ kind: 'key', key: 'NEWMFC-1482' });
    expect(parseIssueInput('привет NEWMFC-1')).toBeUndefined();
    expect(parseIssueInput('')).toBeUndefined();
  });
  it('ссылка: инстанс как у Jiraffe (host+path → kebab), context path сохраняется', () => {
    expect(parseIssueInput('https://jira.sccloud.ru/browse/NEWMFC-1482?focused=1')).toEqual({
      kind: 'link',
      key: 'NEWMFC-1482',
      instanceId: 'jira-sccloud-ru',
      baseUrl: 'https://jira.sccloud.ru',
      url: 'https://jira.sccloud.ru/browse/NEWMFC-1482',
    });
    expect(parseIssueInput('https://h.test/jira/browse/K-1')).toMatchObject({ instanceId: 'h-test-jira', baseUrl: 'https://h.test/jira' });
    expect(parseIssueInput('https://x.atlassian.net/jira/software/projects/K/boards/1?selectedIssue=K-7')).toMatchObject({
      key: 'K-7',
      instanceId: 'x-atlassian-net',
    });
    expect(parseIssueInput('https://h.test/dashboard')).toBeUndefined();
  });
  it('ключ группы', () => {
    expect(parseIssueInput('jiraffe:a-b:K-1')).toMatchObject({ kind: 'taskKey', taskKey: 'jira:a-b:K-1', instanceId: 'a-b', key: 'K-1' });
  });
  it('instanceIdFromUrl', () => {
    expect(instanceIdFromUrl('https://Jira.Example.com:8443/')).toBe('jira-example-com-8443');
  });
});
