/** Инструменты Jira для агента (roadmap 19, этап 8) на фейковом источнике: набор, вызовы, ошибки, обновление карточки. */
import { describe, expect, it, vi } from 'vitest';
import type { TransitionInfo } from '../../data/jira/types';
import { DEFAULT_AGENT_TOOLS, eventRefOf, type AgentToolsSetting } from '../../shared/jiraTools';
import { maybeSaved } from '../../data/jira/http';
import { AgentJiraTools, pickTransition } from './agentTools';
import type { JiraSource, JiraWriter } from './source';

const TASK = 'jira:inst:NEWMFC-1482';

const TRANSITIONS: TransitionInfo[] = [
  { id: '11', name: 'Start progress', to: { name: 'In Progress', category: 'indeterminate' }, requiresFields: false },
  { id: '21', name: 'Review', to: { name: 'Code Review', category: 'indeterminate' }, requiresFields: false },
  { id: '31', name: 'Resolve', to: { name: 'Done', category: 'done' }, requiresFields: true },
];

function setup(opts: { kind?: 'own' | 'jiraffe'; writes?: boolean; settings?: AgentToolsSetting; task?: string | undefined; tokens?: number } = {}) {
  const calls: unknown[][] = [];
  const writer: JiraWriter = {
    addComment: vi.fn(async (...a: unknown[]) => {
      calls.push(['comment', ...a]);
      return { id: '10234' };
    }),
    transitions: vi.fn(async () => TRANSITIONS),
    transition: vi.fn(async (...a: unknown[]) => void calls.push(['transition', ...a])),
    logWork: vi.fn(async (...a: unknown[]) => {
      calls.push(['logWork', ...a]);
      return { id: '5' };
    }),
  };
  const source: JiraSource = {
    kind: opts.kind ?? 'own',
    instances: () => [{ id: 'inst', name: 'Jira DC', baseUrl: 'https://jira.example', kind: 'dc' }],
    issue: async () => Promise.reject(new Error('not used')),
    myself: async () => ({ displayName: 'Me' }),
    ...(opts.writes === false ? {} : { writer }),
  };
  let settings = opts.settings ?? DEFAULT_AGENT_TOOLS;
  let task: string | undefined = 'task' in opts ? opts.task : TASK;
  const afterWrite = vi.fn();
  const forInstance = vi.fn((id: string) => (id === 'inst' ? source : undefined));
  const tools = new AgentJiraTools({
    taskKey: () => task,
    sources: { forInstance },
    settings: () => settings,
    afterWrite,
    today: () => '2026-10-08',
    ...('tokens' in opts ? { aiTokens: () => opts.tokens } : {}),
  });
  return {
    tools,
    calls,
    writer,
    afterWrite,
    setTask: (t: string | undefined) => (task = t),
    setSettings: (s: AgentToolsSetting) => (settings = s),
  };
}

describe('AgentJiraTools.spec', () => {
  it('чат в задаче, источник пишет — ключ задачи, имя инстанса и включённые инструменты', () => {
    expect(setup().tools.spec()).toEqual({ issue: 'NEWMFC-1482', instance: 'Jira DC', tools: ['comment', 'transition', 'worklog'] });
    expect(setup({ settings: { comment: true, transition: false, worklog: true } }).tools.spec()?.tools).toEqual(['comment', 'worklog']);
  });

  it('нет задачи, источник только читает (Jiraffe v1), неизвестный инстанс или всё выключено — инструментов нет', () => {
    expect(setup({ task: undefined }).tools.spec()).toBeUndefined();
    expect(setup({ writes: false }).tools.spec()).toBeUndefined();
    expect(setup({ task: 'jira:other:A-1' }).tools.spec()).toBeUndefined();
    expect(setup({ settings: { comment: false, transition: false, worklog: false } }).tools.spec()).toBeUndefined();
  });

  it('changed() сообщает подписчикам только о другом наборе', () => {
    const s = setup();
    const l = vi.fn();
    s.tools.onDidChange(l);
    s.tools.changed();
    expect(l).not.toHaveBeenCalled();
    s.setTask(undefined);
    s.tools.changed();
    s.tools.changed();
    expect(l).toHaveBeenCalledTimes(1);
    s.setTask(TASK);
    s.setSettings({ comment: true, transition: true, worklog: false });
    s.tools.changed();
    expect(l).toHaveBeenCalledTimes(2);
  });
});

describe('AgentJiraTools.run', () => {
  it('comment: в задачу чата, строка события с id, карточка обновляется сразу', async () => {
    const s = setup();
    const r = await s.tools.run('comment', { text: 'h3. Итог\n* готово' });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Comment added to NEWMFC-1482 (id 10234).');
    expect(eventRefOf(r.text)).toEqual({ kind: 'comment', id: 'comment:10234' });
    expect(s.calls).toEqual([['comment', 'inst', 'NEWMFC-1482', 'h3. Итог\n* готово']]);
    expect(s.afterWrite).toHaveBeenCalledWith(TASK);
  });

  it('другая задача того же инстанса — пишется, но карточку чата не трогает', async () => {
    const s = setup();
    const r = await s.tools.run('comment', { text: 'x', issue: 'abc-7' });
    expect(r.text).toContain('ABC-7');
    expect(s.calls).toEqual([['comment', 'inst', 'ABC-7', 'x']]);
    expect(s.afterWrite).not.toHaveBeenCalled();
  });

  it('transition: по статусу, названию перехода или id; без совпадения — список выполнимых; с полями экрана — отказ', async () => {
    const s = setup();
    const r = await s.tools.run('transition', { to: 'in progress' });
    expect(r.text).toContain('NEWMFC-1482 moved to "In Progress" (transition "Start progress").');
    expect(eventRefOf(r.text)).toEqual({ kind: 'status' });
    await s.tools.run('transition', { to: '21' });
    expect(s.calls).toEqual([
      ['transition', 'inst', 'NEWMFC-1482', '11'],
      ['transition', 'inst', 'NEWMFC-1482', '21'],
    ]);
    const miss = await s.tools.run('transition', { to: 'Closed' });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain('Available: "In Progress" (transition "Start progress", id 11); "Code Review"');
    expect(miss.text).not.toContain('"Done"');
    const fields = await s.tools.run('transition', { to: 'Done' });
    expect(fields.isError).toBe(true);
    expect(fields.text).toMatch(/requires screen fields/);
    expect(s.calls).toHaveLength(2);
  });

  it('worklog: aiTokens — число агента важнее, иначе токены чата; нет расхода — поля нет; мусор — отказ', async () => {
    const s = setup({ tokens: 120_000 });
    await s.tools.run('worklog', { minutes: 10 });
    await s.tools.run('worklog', { minutes: 10, aiTokens: 777 });
    expect((await s.tools.run('worklog', { minutes: 10, aiTokens: -5 })).isError).toBe(true);
    expect((await s.tools.run('worklog', { minutes: 10, aiTokens: 1.5 })).isError).toBe(true);
    expect(s.calls.map((c) => (c[3] as { aiTokens?: number }).aiTokens)).toEqual([120_000, 777]);
    const none = setup({ tokens: 0 });
    await none.tools.run('worklog', { minutes: 10 });
    expect(none.calls[0]![3]).not.toHaveProperty('aiTokens');
  });

  it('worklog: минуты → секунды, дата по умолчанию — сегодня, будущее и мусор — отказ', async () => {
    const s = setup();
    const r = await s.tools.run('worklog', { minutes: 90, comment: '  ревью  ' });
    expect(r.text).toContain('Logged 1h 30m on NEWMFC-1482 for 2026-10-08 (worklog 5).');
    expect(eventRefOf(r.text)).toEqual({ kind: 'worklog', id: 'worklog:5' });
    await s.tools.run('worklog', { minutes: 15, date: '2026-10-01' });
    expect(s.calls).toEqual([
      ['logWork', 'inst', 'NEWMFC-1482', { seconds: 5400, date: '2026-10-08', comment: 'ревью' }],
      ['logWork', 'inst', 'NEWMFC-1482', { seconds: 900, date: '2026-10-01', comment: '' }],
    ]);
    for (const args of [{ minutes: 0 }, { minutes: 1.5 }, { minutes: '60' }, { minutes: 2000 }, { minutes: 10, date: '2026-10-09' }, { minutes: 10, date: 'вчера' }]) {
      const bad = await s.tools.run('worklog', args);
      expect(bad.isError).toBe(true);
    }
    expect(s.calls).toHaveLength(2);
  });

  it('выключенный инструмент, чат без задачи, пустой текст, чужой ключ — ошибка модели, в Jira ничего', async () => {
    const off = setup({ settings: { comment: true, transition: false, worklog: true } });
    expect((await off.tools.run('transition', { to: 'Done' })).text).toMatch(/turned off/);
    const none = setup({ task: undefined });
    expect((await none.tools.run('comment', { text: 'x' })).text).toMatch(/not attached/);
    const s = setup();
    expect((await s.tools.run('comment', { text: '  ' })).isError).toBe(true);
    expect((await s.tools.run('comment', { text: 'x', issue: '../evil' })).text).toMatch(/invalid issue key/);
    expect(s.calls).toEqual([]);
  });

  it('ошибка источника — текстом модели как есть (в том числе «already being sent» Jiraffe)', async () => {
    const s = setup({ kind: 'jiraffe' });
    vi.mocked(s.writer.addComment).mockRejectedValueOnce(new Error('Jiraffe: comment for NEWMFC-1482 is already being sent'));
    const r = await s.tools.run('comment', { text: 'x' });
    expect(r).toEqual({ text: 'Error: Jiraffe: comment for NEWMFC-1482 is already being sent', isError: true });
    expect(s.afterWrite).not.toHaveBeenCalled();
  });

  it('своё подключение: вторая запись того же вида в ту же задачу, пока первая идёт, — отказ', async () => {
    const s = setup();
    let release: () => void = () => undefined;
    vi.mocked(s.writer.addComment).mockImplementationOnce(() => new Promise((r) => (release = () => r({ id: '1' }))));
    const first = s.tools.run('comment', { text: 'a' });
    const second = await s.tools.run('comment', { text: 'b' });
    expect(second.text).toMatch(/already being sent/);
    // другой вид — не мешает
    expect((await s.tools.run('worklog', { minutes: 5 })).isError).toBeUndefined();
    release();
    expect((await first).isError).toBeUndefined();
    expect((await s.tools.run('comment', { text: 'c' })).isError).toBeUndefined();
  });

  it('своё подключение: после «запись могла сохраниться» повтор того же вида один раз отклоняется, следующий проходит', async () => {
    const s = setup();
    vi.mocked(s.writer.addComment).mockRejectedValueOnce(new Error(`No response from https://j: timed out; ${maybeSaved()}`));
    expect((await s.tools.run('comment', { text: 'a' })).isError).toBe(true);
    // другой вид — не мешает
    expect((await s.tools.run('worklog', { minutes: 5 })).isError).toBeUndefined();
    const again = await s.tools.run('comment', { text: 'a' });
    expect(again).toMatchObject({ isError: true });
    expect(again.text).toMatch(/may have been saved; check the issue, then call again/);
    expect(vi.mocked(s.writer.addComment)).toHaveBeenCalledTimes(1);
    expect((await s.tools.run('comment', { text: 'a' })).isError).toBeUndefined();
    // обычная ошибка (400) повтор не блокирует
    vi.mocked(s.writer.addComment).mockRejectedValueOnce(new Error('Jira 400: bad'));
    expect((await s.tools.run('comment', { text: 'b' })).isError).toBe(true);
    expect((await s.tools.run('comment', { text: 'b' })).isError).toBeUndefined();
  });
});

describe('pickTransition', () => {
  it('id, затем название перехода, затем целевой статус; без регистра', () => {
    expect(pickTransition(TRANSITIONS, '31')?.id).toBe('31');
    expect(pickTransition(TRANSITIONS, 'REVIEW')?.id).toBe('21');
    expect(pickTransition(TRANSITIONS, 'code review')?.id).toBe('21');
    expect(pickTransition(TRANSITIONS, ' ')).toBeUndefined();
  });
});
