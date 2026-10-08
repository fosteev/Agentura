import { describe, expect, it } from 'vitest';
import { autoCommentOk, eventLine, eventRefOf, formatSeconds, isAgentToolsSetting, jiraMcpName, jiraToolOf, readAgentTools } from './jiraTools';

describe('jiraTools', () => {
  it('имена MCP-инструментов', () => {
    expect(jiraMcpName('comment')).toBe('mcp__agentura_jira__comment');
    expect(jiraToolOf('mcp__agentura_jira__worklog')).toBe('worklog');
    expect(jiraToolOf('mcp__agentura_jira__delete')).toBeUndefined();
    expect(jiraToolOf('mcp__other__comment')).toBeUndefined();
    // свой MCP-сервер пользователя `jira` — не наши инструменты
    expect(jiraToolOf('mcp__jira__comment')).toBeUndefined();
    expect(jiraToolOf('Bash')).toBeUndefined();
  });

  it('agentTools: мусор — по умолчанию всё включено; запись — ровно три флажка', () => {
    expect(readAgentTools(undefined)).toEqual({ comment: true, transition: true, worklog: true });
    expect(readAgentTools({ transition: false, worklog: 'no' })).toEqual({ comment: true, transition: false, worklog: true });
    expect(isAgentToolsSetting({ comment: true, transition: false, worklog: true })).toBe(true);
    expect(isAgentToolsSetting({ comment: true, transition: false })).toBe(false);
    expect(isAgentToolsSetting({ comment: true, transition: false, worklog: true, extra: true })).toBe(false);
    expect(isAgentToolsSetting([true, true, true])).toBe(false);
  });

  it('строка события в результате: с id и без; чужой текст — нет', () => {
    expect(eventRefOf(`Comment added.\n${eventLine('comment:10234')}`)).toEqual({ kind: 'comment', id: 'comment:10234' });
    expect(eventRefOf(`x\n${eventLine('status')}`)).toEqual({ kind: 'status' });
    expect(eventRefOf('event: field:1')).toBeUndefined();
    expect(eventRefOf('no event here')).toBeUndefined();
  });

  it('formatSeconds', () => {
    expect(formatSeconds(5400)).toBe('1h 30m');
    expect(formatSeconds(3600)).toBe('1h');
    expect(formatSeconds(900)).toBe('15m');
    expect(formatSeconds(45)).toBe('45s');
  });
  it('autoCommentOk: короткий обычный текст — да; длинный и похожий на секрет — нет', () => {
    expect(autoCommentOk('h3. Итог\n* исправлено в abc1234, коммит 0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(autoCommentOk('x'.repeat(2001))).toBe(false);
    for (const bad of [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'AKIAABCDEFGHIJKLMNOP',
      'token ghp_abcdefghijklmnop1234',
      'DB_PASSWORD=hunter2hunter2',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijklmnop',
      'blob ' + 'A'.repeat(60),
    ]) {
      expect(autoCommentOk(bad)).toBe(false);
    }
    expect(autoCommentOk(undefined)).toBe(false);
  });
});
