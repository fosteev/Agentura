import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { CodexLaunchRecords, LAUNCH_TOOL } from './launchRecords';

const dirs: string[] = [];
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentura-launch-')); dirs.push(dir);
  return { dir, store: new CodexLaunchRecords(dir) };
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const request = (task = 'a', turn = 'turn') => ({ threadId: 'root', turnId: turn, callId: task, tool: LAUNCH_TOOL,
  arguments: { task_name: task, prompt: `Task ${task}\nKeep exact text.`, fork_turns: 'none', model: null, reasoning_effort: null } });
const start = (id: string): AgentEvent => ({ type: 'agent.start', agentId: id, taskId: id,
  description: id, taskType: 'subagent', background: false, model: 'actual-model' });
const activity = (id: string, path: string) => ({ type: 'subAgentActivity', kind: 'started', agentThreadId: id, agentPath: path });

describe('parent launch declarations', () => {
  it('persists exact text privately, matches reverse starts and survives reopening', () => {
    const { store, dir } = setup();
    expect(store.call(request('a'), 'root', 'turn').success).toBe(true);
    expect(store.call(request('b'), 'root', 'turn').success).toBe(true);
    const reopened = new CodexLaunchRecords(dir); reopened.load('root');
    reopened.observe('turn', activity('child-b', '/root/b'));
    reopened.observe('turn', activity('child-a', '/root/a'));
    expect(reopened.enrich(start('child-a'))).toMatchObject({ model: 'actual-model',
      launchRecord: { prompt: request('a').arguments.prompt, source: 'parent', model: null, forkTurns: 'none' } });
    expect(reopened.enrich(start('child-b'))).toMatchObject({ launchRecord: { taskName: 'b' } });
    expect(reopened.enrich(start('child-a'))).not.toHaveProperty('prompt');
    const folder = join(dir, readdirSync(dir)[0]!);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toHaveLength(2);
    expect(statSync(join(folder, readdirSync(folder)[0]!)).mode & 0o777).toBe(0o600);
  });

  it('is idempotent, rejects conflicting declarations and stale/foreign requests', () => {
    const { store } = setup(); const r = request();
    expect(store.call(r, 'root', 'turn').success).toBe(true);
    expect(store.call(r, 'root', 'turn').success).toBe(true);
    expect(store.call({ ...r, arguments: { ...r.arguments, prompt: 'changed' } }, 'root', 'turn').success).toBe(false);
    for (const patch of [{ threadId: 'child' }, { turnId: 'old' }, { namespace: 'other' }, { arguments: null },
      { arguments: { ...r.arguments, task_name: '../escape' } }, { arguments: { ...r.arguments, fork_turns: 'maybe' } }])
      expect(store.call({ ...r, ...patch }, 'root', 'turn').success).toBe(false);
  });

  it('does not match another turn, nested agent, unregistered or ambiguous name', () => {
    const { store } = setup(); store.call(request(), 'root', 'turn');
    store.observe('other', activity('other-turn', '/root/a'));
    store.observe('turn', activity('nested', '/root/parent/a'));
    store.observe('turn', activity('missing', '/root/b'));
    for (const id of ['other-turn', 'nested', 'missing']) expect(store.enrich(start(id))).not.toHaveProperty('launchRecord');
    expect(store.call(request('b'), 'root', 'turn').success).toBe(false);
    store.observe('turn', activity('first', '/root/a'));
    expect(store.enrich(start('first'))).toHaveProperty('launchRecord');
    expect(store.observe('turn', activity('second', '/root/a'))).toEqual([
      expect.objectContaining({ agentId: 'first', launchRecord: null }),
    ]);
    expect(store.enrich(start('first'))).toHaveProperty('launchRecord', null);
    expect(store.enrich(start('second'))).toHaveProperty('launchRecord', null);
  });

  it('does not confirm failed storage and ignores corrupt records', () => {
    const { store, dir } = setup(); store.call(request(), 'root', 'turn');
    const folder = join(dir, readdirSync(dir)[0]!);
    writeFileSync(join(folder, readdirSync(folder)[0]!), '{broken');
    const reopened = new CodexLaunchRecords(dir); reopened.load('root');
    reopened.observe('turn', activity('a', '/root/a'));
    expect(reopened.enrich(start('a'))).not.toHaveProperty('launchRecord');
    const bad = join(dir, 'not-a-directory'); writeFileSync(bad, '');
    expect(new CodexLaunchRecords(bad).call(request(), 'root', 'turn').success).toBe(false);
  });
});
