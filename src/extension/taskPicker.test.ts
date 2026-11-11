import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueDetail } from '../data/jira/types';
import type { SessionSummary } from '../protocol';
import type { JiraSource } from './jira/source';
import { TaskPicker, type TaskPickerDeps } from './taskPicker';
import type { TaskGroup } from './taskGroups';

const instance = {
  id: 'jira-example',
  name: 'Jira',
  baseUrl: 'https://jira.example',
  kind: 'dc' as const,
};
const issue: IssueDetail = {
  instanceId: instance.id,
  key: 'P7-1',
  summary: 'Issue one',
  type: 'Task',
  status: 'Testing',
  statusCategory: 'indeterminate',
  updated: '',
  created: '',
  descriptionHtml: '<p>Description</p>',
  comments: [],
  attachments: [],
  history: [],
  components: [],
  labels: [],
  fixVersions: [],
  watchers: [],
  timetracking: {},
};
const row: SessionSummary = {
  id: 'c1',
  title: 'Existing chat',
  provider: 'codex',
  turns: 1,
  state: 'idle',
  updatedAt: 10,
};
const group: TaskGroup = {
  task: {
    key: 'P7-1',
    instanceId: instance.id,
    title: 'Issue one',
    url: 'https://jira.example/browse/P7-1',
  },
  sessions: [{ id: 'c1', provider: 'codex' }],
  openedAt: {},
};
function setup(existing = true) {
  const load = vi.fn(async () => ({ issue, worklogs: [] }));
  const source = { issue: load } as unknown as JiraSource;
  const deps: TaskPickerDeps = {
    sources: {
      refresh: vi.fn(async () => {}),
      allInstances: vi.fn(() => [instance]),
      forInstance: vi.fn(() => source),
    },
    groups: {
      group: vi.fn((key) => (key === 'jira:jira-example:P7-1' && existing ? group : undefined)),
    },
    sessions: vi.fn(async () => [row]),
    archived: vi.fn(() => true),
    hasOpen: vi.fn(() => false),
    open: vi.fn(() => true),
    create: vi.fn(async () => true),
  };
  return { deps, load, picker: new TaskPicker(deps, 100) };
}
afterEach(() => vi.useRealTimers());
describe('sidebar task lookup and actions', () => {
  it('normalizes URLs, finds archived chats and opens without creating', async () => {
    const { picker, deps, load } = setup();
    const result = await picker.find(1, 'https://jira.example/browse/p7-1?focused=2');
    expect(load).toHaveBeenCalledWith(instance.id, 'P7-1');
    expect(result).toMatchObject({
      kind: 'found',
      existing: true,
      taskKey: 'jira:jira-example:P7-1',
      chats: [{ id: 'c1', archived: true }],
    });
    expect(await picker.act({ requestId: 1, mode: 'open' })).toBeUndefined();
    expect(deps.open).toHaveBeenCalledWith(
      'jira:jira-example:P7-1',
      expect.objectContaining({ id: 'c1', provider: 'codex' }),
    );
    expect(deps.create).not.toHaveBeenCalled();
  });
  it('does not send requests to an unconnected host or context path', async () => {
    const { picker, load } = setup();
    for (const url of [
      'https://evil.example/browse/P7-1',
      'https://jira.example/other/browse/P7-1',
    ]) {
      expect(await picker.find(1, url)).toEqual({ kind: 'error', code: 'no-source' });
    }
    expect(load).not.toHaveBeenCalled();
  });
  it('asks for the instance on an ambiguous key, matches the configured instance id', async () => {
    const { picker, deps, load } = setup();
    vi.mocked(deps.sources.allInstances).mockReturnValue([
      instance,
      { ...instance, id: 'other', baseUrl: 'https://other.example' },
    ]);
    expect(await picker.find(1, 'P7-1')).toMatchObject({ kind: 'instances' });
    expect(load).not.toHaveBeenCalled();
    expect(await picker.find(2, 'P7-1', 'other')).toMatchObject({
      kind: 'found',
      existing: false,
      taskKey: 'jira:other:P7-1',
      chats: [],
    });
    expect(load).toHaveBeenCalledWith('other', 'P7-1');
  });
  it('reports invalid input and failed access without retaining a previous result', async () => {
    const { picker, load } = setup();
    await picker.find(1, 'P7-1');
    expect(await picker.find(2, 'garbage')).toEqual({ kind: 'error', code: 'invalid' });
    expect(await picker.act({ requestId: 1, mode: 'open' })).toBe('stale');
    load.mockRejectedValue(new Error('private server error'));
    expect(await picker.find(3, 'P7-1')).toEqual({ kind: 'error', code: 'unavailable' });
  });
  it('an unsent open task counts as existing and is revealed without a session id', async () => {
    const { picker, deps } = setup(false);
    vi.mocked(deps.hasOpen).mockReturnValue(true);
    expect(await picker.find(1, 'P7-1')).toMatchObject({
      kind: 'found',
      existing: true,
      chats: [],
    });
    expect(await picker.act({ requestId: 1, mode: 'open' })).toBeUndefined();
    expect(deps.open).toHaveBeenCalledWith('jira:jira-example:P7-1', undefined);
    expect(deps.create).not.toHaveBeenCalled();
  });
  it('rejects foreign sessions, wrong engines and removed membership', async () => {
    const { picker, deps } = setup();
    await picker.find(1, 'P7-1');
    expect(
      await picker.act({ requestId: 1, mode: 'open', sessionId: 'other', provider: 'codex' }),
    ).toBe('stale');
    expect(
      await picker.act({ requestId: 1, mode: 'open', sessionId: 'c1', provider: 'claude' }),
    ).toBe('stale');
    vi.mocked(deps.groups.group).mockReturnValue(undefined);
    expect(await picker.act({ requestId: 1, mode: 'open' })).toBe('stale');
    expect(deps.open).not.toHaveBeenCalled();
  });
  it('rechecks membership after async session refresh', async () => {
    const { picker, deps } = setup();
    await picker.find(1, 'P7-1');
    let finish!: (rows: SessionSummary[]) => void;
    vi.mocked(deps.sessions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const action = picker.act({ requestId: 1, mode: 'open', sessionId: 'c1', provider: 'codex' });
    vi.mocked(deps.groups.group).mockReturnValue(undefined);
    finish([row]);
    expect(await action).toBe('stale');
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('explicit new chat carries context and provider into the same task; repeated submission is rejected', async () => {
    const { picker, deps } = setup();
    await picker.find(1, 'P7-1');
    const action = {
      requestId: 1,
      mode: 'create' as const,
      provider: 'codex' as const,
      prompt: 'Review',
    };
    const first = picker.act(action);
    expect(await picker.act(action)).toBe('stale');
    expect(await first).toBeUndefined();
    expect(await picker.act(action)).toBe('stale');
    expect(deps.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'P7-1', instanceId: instance.id }),
      expect.stringContaining('Description'),
      'codex',
      'Review',
    );
  });
  it('late lookup cannot overwrite a newer result', async () => {
    const { picker, load, deps } = setup();
    let finish!: (value: { issue: IssueDetail; worklogs: [] }) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = picker.find(1, 'P7-1');
    await Promise.resolve();
    await picker.find(2, 'P7-2');
    finish({ issue, worklogs: [] });
    expect(await first).toMatchObject({ code: 'stale' });
    await picker.act({ requestId: 2, mode: 'create', provider: 'claude' });
    expect(deps.create).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'P7-2' }),
      expect.any(String),
      'claude',
      undefined,
    );
  });
  it('timeout and cancel make late responses ineligible for actions', async () => {
    vi.useFakeTimers();
    const { picker, load } = setup();
    let finish!: (value: { issue: IssueDetail; worklogs: [] }) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const request = picker.find(1, 'P7-1');
    await vi.advanceTimersByTimeAsync(101);
    expect(await request).toEqual({ kind: 'error', code: 'timeout' });
    finish({ issue, worklogs: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(await picker.act({ requestId: 1, mode: 'open' })).toBe('stale');
    await picker.find(2, 'P7-1');
    picker.cancel();
    expect(await picker.act({ requestId: 2, mode: 'open' })).toBe('stale');
  });
  it('create failure keeps the dialog retryable', async () => {
    const { picker, deps } = setup(false);
    await picker.find(1, 'P7-1');
    vi.mocked(deps.create).mockResolvedValue(false);
    expect(await picker.act({ requestId: 1, mode: 'create', provider: 'cursor' })).toBe('failed');
    vi.mocked(deps.create).mockResolvedValue(true);
    expect(await picker.act({ requestId: 1, mode: 'create', provider: 'cursor' })).toBeUndefined();
  });
});
