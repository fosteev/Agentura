import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JiraError } from '../../data/jira/http';
import { mapIssueDetail, mapWorklog } from '../../data/jira/mappers';
import type { TaskStateMessage } from '../../shared/task';
import type { TaskGroup, TaskMeta } from '../taskGroups';
import type { JiraSource } from './source';
import { MIN_GAP_MS, POLL_MS, SOURCE_TIMEOUT_MS, TaskService, type TaskView } from './taskService';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/jira/issue-dc.json'), 'utf8'));
const issue = mapIssueDetail({ id: 'inst', kind: 'dc' }, fixture.issue, []);
const worklogs = fixture.worklog.worklogs.map((w: unknown) => mapWorklog('dc', w as Record<string, unknown>));
const TASK = 'jira:inst:ABC-123';
const t0 = Date.parse('2026-10-03T00:00:00+0300');

function harness(over: { refresh?: '30s' | 'manual'; humanChanges?: boolean; setting?: string } = {}) {
  let now = t0;
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const calls = { issue: 0, myself: 0 };
  let failWith: unknown;
  const source: JiraSource = {
    kind: 'own',
    instances: () => [{ id: 'inst', name: 'Work', baseUrl: 'https://jira.example.test/jira', kind: 'dc' }],
    issue: async () => {
      calls.issue++;
      if (failWith) throw failWith;
      return { issue, worklogs };
    },
    myself: async () => {
      calls.myself++;
      return { name: 'anna.smirnova', displayName: 'Anna' };
    },
  };
  const state = { source: source as JiraSource | undefined, setting: over.setting ?? 'auto' };
  const meta: TaskMeta = { key: 'ABC-123', instanceId: 'inst', title: 'ABC-123', url: '' };
  const group: TaskGroup = { task: meta, sessions: [], openedAt: {} };
  const updateMeta = vi.fn((_k: string, patch: Partial<TaskMeta>) => void Object.assign(group.task, patch));
  const svc = new TaskService({
    sources: {
      setting: () => state.setting,
      current: () => state.source,
      forInstance: (id) => (state.source?.instances().some((i) => i.id === id) ? state.source : undefined),
    },
    groups: { group: (k) => (k === TASK ? group : undefined), updateMeta },
    settings: () => ({ refresh: over.refresh ?? '30s', humanChanges: over.humanChanges ?? true }),
    messages: { off: 'OFF', noSource: 'NO SOURCE', timeout: 'TIMEOUT', unknownInstance: (id) => `UNKNOWN ${id}` },
    now: () => now,
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        timers.push({ fn, ms, id });
        return id;
      },
      clear: (h) => void timers.splice(0, timers.length, ...timers.filter((t) => t.id !== h)),
    },
  });
  const view = (visible = true, openedAt = 0) => {
    const posts: TaskStateMessage[] = [];
    const v = { visible, openedAt, turns: [] as { start: number; end?: number }[] };
    const tv: TaskView = {
      openedAt: () => v.openedAt,
      visible: () => v.visible,
      turns: () => v.turns,
      post: (m) => void posts.push(m),
    };
    return { tv, posts, v };
  };
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return {
    svc, view, flush, calls, updateMeta, group, timers, state,
    advance: (ms: number) => (now += ms),
    fail: (e: unknown) => (failWith = e),
  };
}

describe('TaskService', () => {
  it('attach: видимая вкладка получает карточку и ленту; метаданные группы обновляются один раз', async () => {
    const h = harness();
    const { tv, posts } = h.view();
    h.svc.attach(TASK, tv);
    // до первого ответа источник уже известен (вкладка при `tasks.card = split` решает по нему, этап 5)
    expect(posts[0]).toMatchObject({ type: 'task.state', taskKey: TASK, source: 'own', fetchedAt: 0 });
    await h.flush();
    const last = posts.at(-1)!;
    expect(last).toMatchObject({ type: 'task.state', taskKey: TASK, source: 'own', fetchedAt: t0 });
    expect(last.card).toMatchObject({ key: 'ABC-123', url: 'https://jira.example.test/jira/browse/ABC-123' });
    expect(last.events.length).toBeGreaterThan(0);
    expect(last.error).toBeUndefined();
    expect(h.updateMeta).toHaveBeenCalledTimes(1);
    expect(h.updateMeta).toHaveBeenCalledWith(TASK, expect.objectContaining({ title: 'Fix export of the report to CSV', status: 'В работе' }));
    h.advance(MIN_GAP_MS + 1);
    await h.svc.refresh(TASK);
    expect(h.updateMeta).toHaveBeenCalledTimes(1); // ничего не поменялось — группа не перезаписывается
  });

  it('невидимая вкладка не опрашивает и не создаёт таймер; становится видимой — загрузка и таймер 30 с', async () => {
    const h = harness();
    const { tv, v, posts } = h.view(false);
    const sub = h.svc.attach(TASK, tv);
    await h.flush();
    expect(h.calls.issue).toBe(0);
    expect(h.timers).toHaveLength(0);
    expect(posts.at(-1)).toMatchObject({ events: [], fetchedAt: 0 });
    v.visible = true;
    sub.update();
    await h.flush();
    expect(h.calls.issue).toBe(1);
    expect(h.timers).toEqual([expect.objectContaining({ ms: POLL_MS })]);
    v.visible = false;
    sub.update();
    expect(h.timers).toHaveLength(0);
  });

  it('тик таймера = загрузка не чаще раза в 5 с; dispose последней вкладки гасит таймер', async () => {
    const h = harness();
    const { tv } = h.view();
    const sub = h.svc.attach(TASK, tv);
    await h.flush();
    h.timers[0]!.fn();
    await h.flush();
    expect(h.calls.issue).toBe(1); // прошло < 5 с
    h.advance(POLL_MS);
    h.timers[0]!.fn();
    await h.flush();
    expect(h.calls.issue).toBe(2);
    sub.dispose();
    expect(h.timers).toHaveLength(0);
  });

  it('manual: один раз при открытии, таймера нет; nudge после хода и ↻ работают', async () => {
    const h = harness({ refresh: 'manual' });
    const { tv } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    expect(h.calls.issue).toBe(1);
    expect(h.timers).toHaveLength(0);
    h.advance(MIN_GAP_MS + 1);
    h.svc.nudge(TASK);
    await h.flush();
    expect(h.calls.issue).toBe(2);
    expect(h.timers).toHaveLength(0);
    h.advance(MIN_GAP_MS + 1);
    await h.svc.refresh(TASK);
    expect(h.calls.issue).toBe(3);
  });

  it('nudge после хода грузит сразу, но не чаще раза в 5 с; невидимая вкладка — не грузит', async () => {
    const h = harness();
    const a = h.view();
    h.svc.attach(TASK, a.tv);
    await h.flush();
    h.svc.nudge(TASK);
    await h.flush();
    expect(h.calls.issue).toBe(1); // сразу после первой загрузки
    h.advance(MIN_GAP_MS + 1);
    h.svc.nudge(TASK);
    await h.flush();
    expect(h.calls.issue).toBe(2);
    a.v.visible = false;
    h.advance(MIN_GAP_MS + 1);
    h.svc.nudge(TASK);
    await h.flush();
    expect(h.calls.issue).toBe(2);
  });

  it('две вкладки одной задачи: одна загрузка, у каждой лента со своим openedAt', async () => {
    const h = harness();
    const a = h.view(true, 0);
    const b = h.view(true, Date.parse('2026-10-01T00:00:00+0300'));
    h.svc.attach(TASK, a.tv);
    h.svc.attach(TASK, b.tv);
    await h.flush();
    expect(h.calls.issue).toBe(1);
    expect(a.posts.at(-1)!.events.length).toBeGreaterThan(b.posts.at(-1)!.events.length);
    expect(b.posts.at(-1)!.events.length).toBeGreaterThan(0);
  });

  it('humanChanges = false: в ленте только свои события', async () => {
    const h = harness({ humanChanges: false });
    const { tv, posts } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    const ev = posts.at(-1)!.events;
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.mine)).toBe(true);
  });

  it('ошибка загрузки: прежняя карточка остаётся, рядом код причины', async () => {
    const h = harness();
    const { tv, posts } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    h.advance(MIN_GAP_MS + 1);
    h.fail(new JiraError(401, 'Not authorized', 'u'));
    await h.svc.refresh(TASK);
    const last = posts.at(-1)!;
    expect(last.error).toEqual({ code: 'auth', message: 'Not authorized' });
    expect(last.card?.key).toBe('ABC-123');
    h.advance(MIN_GAP_MS + 1);
    h.fail(new JiraError(404, 'nf', 'u'));
    await h.svc.refresh(TASK);
    expect(posts.at(-1)!.error?.code).toBe('not-found');
    h.advance(MIN_GAP_MS + 1);
    h.fail(new JiraError(0, 'no conn', 'u', 'network'));
    await h.svc.refresh(TASK);
    expect(posts.at(-1)!.error?.code).toBe('network');
    h.advance(MIN_GAP_MS + 1);
    h.fail(new Error('Jiraffe: unknown instance "inst"'));
    await h.svc.refresh(TASK);
    expect(posts.at(-1)!.error?.code).toBe('unknown-instance');
    h.advance(MIN_GAP_MS + 1);
    h.fail(undefined);
    await h.svc.refresh(TASK);
    expect(posts.at(-1)!.error).toBeUndefined();
  });

  it('нет источника / off / инстанс неизвестен — понятный код сразу, без таймера', async () => {
    const h = harness();
    h.state.source = undefined;
    const { tv, posts } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    expect(posts.at(-1)).toMatchObject({ source: 'none', error: { code: 'no-source', message: 'NO SOURCE' }, events: [] });
    expect(h.timers).toHaveLength(0);

    const off = harness({ setting: 'off' });
    off.state.source = undefined;
    const o = off.view();
    off.svc.attach(TASK, o.tv);
    await off.flush();
    expect(o.posts.at(-1)!.error).toEqual({ code: 'off', message: 'OFF' });

    const unk = harness();
    const u = unk.view();
    unk.svc.attach('jira:other:ABC-1', u.tv);
    await unk.flush();
    expect(u.posts.at(-1)!.error).toEqual({ code: 'unknown-instance', message: 'UNKNOWN other' });
    expect(unk.calls.issue).toBe(0);
  });

  it('reconfigure (источник/настройка изменились): кеш сброшен, видимая вкладка грузит заново', async () => {
    const h = harness();
    const { tv } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    h.svc.reconfigure();
    await h.flush();
    expect(h.calls.issue).toBe(2);
    expect(h.calls.myself).toBe(2);
  });

  it('commentOf / attachmentUrl / issueUrl — из последнего снимка', async () => {
    const h = harness();
    h.svc.attach(TASK, h.view().tv);
    await h.flush();
    expect(h.svc.commentOf(TASK, '50001')).toMatchObject({ author: 'Anna Smirnova' });
    expect(h.svc.commentOf(TASK, 'nope')).toBeUndefined();
    expect(h.svc.attachmentUrl(TASK, '40001')).toMatch(/^https:\/\//);
    expect(h.svc.attachmentUrl(TASK, 'nope')).toBeUndefined();
    expect(h.svc.issueUrl(TASK)).toBe('https://jira.example.test/jira/browse/ABC-123');
  });

  it('contextOf (roadmap 20, «↳ в чат» карточки): контекст задачи из последней загрузки; canWrite — по writer источника', async () => {
    const h = harness();
    expect(h.svc.contextOf(TASK)).toBeUndefined();
    const v = h.view();
    h.svc.attach(TASK, v.tv);
    await h.flush();
    const ctx = h.svc.contextOf(TASK)!;
    expect(ctx.key).toBe('ABC-123');
    expect(ctx.text).toMatch(/^# ABC-123: /);
    expect(ctx.text).toContain('- URL: https://jira.example.test/jira/browse/ABC-123');
    expect(ctx.text).toContain('- Jira: Work');
    const last = v.posts.at(-1)!;
    expect(last.card?.canWrite).toBe(false); // у источника харнесса нет writer
    expect(last.card?.descriptionHtml).toBe(issue.descriptionHtml);
  });

  it('401/403: таймер и nudge больше не грузят (CAPTCHA на DC), ↻ и reconfigure — грузят', async () => {
    const h = harness();
    const { tv, posts } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    h.advance(POLL_MS);
    h.fail(new JiraError(401, 'Not authorized', 'u'));
    h.timers[0]!.fn();
    await h.flush();
    expect(h.calls.issue).toBe(2);
    expect(posts.at(-1)!.error?.code).toBe('auth');
    for (let i = 0; i < 5; i++) {
      h.advance(POLL_MS);
      h.timers[0]!.fn();
      h.svc.nudge(TASK);
      await h.flush();
    }
    expect(h.calls.issue).toBe(2);
    h.fail(undefined);
    await h.svc.refresh(TASK);
    expect(h.calls.issue).toBe(3);
    expect(posts.at(-1)!.error).toBeUndefined();
  });

  it('сбои подряд (429, сеть): автоматические загрузки с удвоением паузы, успех сбрасывает', async () => {
    const h = harness();
    const { tv } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    h.fail(new JiraError(429, 'Too many', 'u'));
    const tick = async () => {
      h.advance(POLL_MS);
      h.timers[0]!.fn();
      await h.flush();
    };
    await tick(); // 1-й сбой
    expect(h.calls.issue).toBe(2);
    await tick(); // пауза 30 с прошла — 2-й сбой
    expect(h.calls.issue).toBe(3);
    await tick(); // пауза 60 с — рано
    expect(h.calls.issue).toBe(3);
    await tick(); // 60 с прошло — 3-й сбой
    expect(h.calls.issue).toBe(4);
    h.fail(undefined);
    for (let i = 0; i < 4; i++) await tick(); // пауза 120 с
    expect(h.calls.issue).toBe(5);
    await tick(); // ошибки нет — обычный опрос
    expect(h.calls.issue).toBe(6);
  });

  it('reconfigure во время загрузки: результат старого источника выброшен, грузится заново', async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const first = h.state.source!;
    h.state.source = {
      ...first,
      issue: () => new Promise((r) => (release = () => r({ issue: { ...issue, summary: 'OLD' }, worklogs }))),
    };
    const { tv, posts } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    h.state.source = first;
    h.svc.reconfigure();
    release();
    await h.flush();
    await h.flush();
    expect(posts.some((p) => p.card?.title === 'OLD')).toBe(false);
    expect(posts.at(-1)!.card?.title).toBe(issue.summary);
  });

  it('длинный текст ошибки источника режется', async () => {
    const h = harness();
    const { tv, posts } = h.view();
    h.fail(new Error('x'.repeat(5_000)));
    h.svc.attach(TASK, tv);
    await h.flush();
    expect(posts.at(-1)!.error!.message.length).toBeLessThanOrEqual(501);
  });

  it('последняя вкладка закрылась — запись забыта; новая вкладка грузит заново', async () => {
    const h = harness();
    const a = h.svc.attach(TASK, h.view().tv);
    await h.flush();
    a.dispose();
    h.svc.attach(TASK, h.view().tv);
    await h.flush();
    expect(h.calls.issue).toBe(2);
  });

  it('settingsChanged (agentura.tasks.*): кеш, окно 5 с и блок после 401 не сбрасываются; manual гасит таймер', async () => {
    let refresh: '30s' | 'manual' = '30s';
    const h = harness();
    (h.svc as unknown as { deps: { settings: () => unknown } }).deps.settings = () => ({ refresh, humanChanges: true });
    const { tv } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    h.svc.settingsChanged();
    await h.flush();
    expect(h.calls.issue).toBe(1);
    h.advance(MIN_GAP_MS + 1);
    h.fail(new JiraError(401, 'no', 'u'));
    await h.svc.refresh(TASK);
    h.advance(POLL_MS);
    h.svc.settingsChanged();
    await h.flush();
    expect(h.calls.issue).toBe(2);
    refresh = 'manual';
    h.svc.settingsChanged();
    expect(h.timers).toHaveLength(0);
  });

  it('источник не отвечает — через SOURCE_TIMEOUT_MS ошибка network, загрузка не висит', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.state.source = { ...h.state.source!, issue: () => new Promise(() => undefined), myself: () => new Promise(() => undefined) };
      const { tv, posts } = h.view();
      h.svc.attach(TASK, tv);
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 1);
      expect(posts.at(-1)!.error).toEqual({ code: 'network', message: 'TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TaskService.afterWrite (инструменты агента, этап 8)', () => {
  it('запись агента — загрузка сразу: мимо окна 5 с, ручного режима и блока после 401; без зрителей — ничего', async () => {
    const h = harness({ refresh: 'manual' });
    const { tv } = h.view();
    h.svc.attach(TASK, tv);
    await h.flush();
    expect(h.calls.issue).toBe(1);
    await h.svc.refresh(TASK); // окно 5 с — кеш
    expect(h.calls.issue).toBe(1);
    await h.svc.afterWrite(TASK);
    expect(h.calls.issue).toBe(2);
    h.fail(new JiraError(401, 'Not authorized', 'u'));
    await h.svc.afterWrite(TASK);
    h.fail(undefined);
    h.svc.nudge(TASK); // после 401 сам не грузит
    await h.flush();
    expect(h.calls.issue).toBe(3);
    await h.svc.afterWrite(TASK);
    expect(h.calls.issue).toBe(4);
    await h.svc.afterWrite('jira:inst:NONE-1');
    expect(h.calls.issue).toBe(4);
  });

  it('загрузка уже идёт (начата до записи) — дождаться её и загрузить заново', async () => {
    const h = harness();
    const { tv } = h.view();
    h.svc.attach(TASK, tv); // первая загрузка в полёте
    expect(h.calls.issue).toBe(1);
    await h.svc.afterWrite(TASK);
    expect(h.calls.issue).toBe(2);
  });
});

