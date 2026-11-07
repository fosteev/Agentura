import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent, TaskTools, TaskToolsSpec } from '../types';
import { CodexJiraTools } from './jiraTools';
import { codexJiraName } from './jiraTools';

function setup() {
  let spec: TaskToolsSpec | undefined = { issue: 'A-1', instance: 'Jira', instanceId: 'one', tools: ['comment', 'transition', 'worklog'] };
  let changed = () => {};
  const run = vi.fn(async () => ({ text: 'ok' }));
  const tools: TaskTools = { spec: () => spec, run, onDidChange: (fn) => { changed = fn; return () => {}; } };
  const events: AgentEvent[] = [];
  const broker = new CodexJiraTools(tools, (e) => events.push(e), 'test:');
  const defs = broker.register();
  let n = 0;
  const params = (tool = 'comment', args: Record<string, unknown> = { text: 'done' }) => ({ threadId: 'thread', turnId: 'turn', callId: String(++n), namespace: null, tool: codexJiraName(tool as 'comment'), arguments: args });
  const call = (p = params()) => broker.call(p, 'thread', 'turn');
  const permission = () => [...events].reverse().find((e) => e.type === 'permission.request');
  return { broker, defs, run, events, params, call, permission, change: (next?: TaskToolsSpec) => { spec = next; changed(); } };
}

describe('Codex Jira host writes', () => {
  it('registers only enabled tools, auto comments and deduplicates call IDs', async () => {
    const t = setup();
    expect(t.defs.map((d) => d.name)).toEqual(['agentura_jira_comment', 'agentura_jira_transition', 'agentura_jira_worklog']);
    const p = t.params();
    expect(await t.call(p)).toMatchObject({ success: true });
    expect(await t.call(p)).toMatchObject({ success: true });
    expect(t.run).toHaveBeenCalledTimes(1);
  });
  it.each(['transition', 'worklog'])('requires one-time approval for %s and strips model usage', async (name) => {
    const t = setup();
    const pending = t.call(t.params(name, { to: 'Done', minutes: 5, aiTokens: 123 }));
    expect(t.run).not.toHaveBeenCalled();
    const e = t.permission()!;
    expect(e.canAlwaysAllow).toBe(false);
    expect(t.broker.respond(e.toolUseId, 'allow')).toBe(true);
    expect(await pending).toMatchObject({ success: true });
    expect(t.run).toHaveBeenCalledWith(name, { to: 'Done', minutes: 5 });
  });
  it.each([{ text: 'x'.repeat(2001) }, { text: 'done', issue: 'B-2' }, { text: 'token=abcdefghijk' }])('asks for sensitive/foreign comment', async (args) => {
    const t = setup(); const pending = t.call(t.params('comment', args));
    expect(t.run).not.toHaveBeenCalled();
    t.broker.respond(t.permission()!.toolUseId, 'deny');
    expect(await pending).toMatchObject({ success: false });
  });
  it('rate limits automatic comments', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.call();
    const p = t.call();
    expect(t.run).toHaveBeenCalledTimes(3);
    t.broker.cancel(); expect(await p).toMatchObject({ success: false });
  });
  it.each(['rebind', 'close', 'stop'])('revokes pending writes on %s', async (how) => {
    const t = setup(); const p = t.call(t.params('transition', { to: 'Done' }));
    const id = t.permission()!.toolUseId;
    if (how === 'rebind') t.change({ issue: 'A-1', instance: 'Jira', instanceId: 'two', tools: ['transition'] });
    else if (how === 'close') t.broker.close(); else t.broker.cancel();
    expect(await p).toMatchObject({ success: false });
    expect(t.broker.respond(id, 'allow')).toBe(false); expect(t.run).not.toHaveBeenCalled();
  });
  it('rejects changed/disabled registration and stale thread requests', async () => {
    const t = setup();
    expect(await t.call({ ...t.params(), threadId: 'other' })).toMatchObject({ success: false });
    t.change(); expect(await t.call()).toMatchObject({ success: false }); expect(t.run).not.toHaveBeenCalled();
  });
  it('does not retry an uncertain exception or accept allow-always', async () => {
    const t = setup(); t.run.mockRejectedValue(new Error('timeout'));
    const p = t.params(); expect(await t.call(p)).toMatchObject({ success: false }); await t.call(p);
    expect(t.run).toHaveBeenCalledTimes(1);
    const pending = t.call(t.params('worklog', { minutes: 1 }));
    t.broker.respond(t.permission()!.toolUseId, 'allow-always'); expect(await pending).toMatchObject({ success: false });
  });
  it('does not write after allow followed immediately by Stop', async () => {
    const t = setup(); const pending = t.call(t.params('transition', { to: 'Done' }));
    t.broker.respond(t.permission()!.toolUseId, 'allow'); t.broker.cancel();
    expect(await pending).toMatchObject({ success: false }); expect(t.run).not.toHaveBeenCalled();
  });
  it.each(['mcp__agentura_jira__comment', 'agentura_jira_delete', 'mcp__jira__comment'])('rejects unregistered name %s', async (tool) => {
    const t = setup();
    expect(await t.call({ ...t.params(), tool })).toMatchObject({ success: false });
    expect(t.run).not.toHaveBeenCalled();
  });
  it('does not serve unregistered resumed tools', async () => {
    const t = setup(); const b = new CodexJiraTools(undefined, () => {}, 'resume:');
    expect(await b.call(t.params(), 'thread', 'turn')).toMatchObject({ success: false });
  });
});
