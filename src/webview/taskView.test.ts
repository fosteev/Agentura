import { describe, expect, it } from 'vitest';
import type { ChatState } from './chatState';
import type { TaskEvent, TaskStateMessage } from '../shared/task';
import {
  agoLabel,
  descriptionLong,
  eventActor,
  eventText,
  humanPrompts,
  initials,
  issueKeyOf,
  actionErrorText,
  fileExt,
  latestSeen,
  parseDuration,
  sizeLabel,
  timeProgress,
  todayIso,
  waitingWhat,
  taskDefaultView,
  taskPanelShown,
  unseenCount,
  visibleEvents,
} from './taskView';

const ev = (o: Partial<TaskEvent> & Pick<TaskEvent, 'id' | 'kind' | 'at'>): TaskEvent => ({
  author: 'Ольга К.',
  mine: false,
  fromThisChat: false,
  duringTurn: false,
  text: '',
  ...o,
});
const st = (o: Partial<TaskStateMessage> = {}): TaskStateMessage => ({
  type: 'task.state',
  taskKey: 'jira:i:A-1',
  events: [],
  fetchedAt: 1,
  source: 'jiraffe',
  ...o,
});

describe('taskPanelShown', () => {
  it('tab и split — у любого чата по задаче', () => {
    expect(taskPanelShown('tab', st())).toBe(true);
    expect(taskPanelShown('split', st({ source: 'jiraffe' }))).toBe(true);
    expect(taskPanelShown('split', st({ source: 'own' }))).toBe(true);
    expect(taskPanelShown('split', st({ source: 'none' }))).toBe(true);
    expect(taskPanelShown('tab', undefined)).toBe(false);
    expect(taskPanelShown('tab', st({ taskKey: undefined as unknown as string }))).toBe(false);
  });
});

describe('taskDefaultView', () => {
  it('split с Jiraffe — «изменения», остальное — «комментарии»', () => {
    expect(taskDefaultView('split', st({ source: 'jiraffe' }))).toBe('changes');
    expect(taskDefaultView('split', st({ source: 'own' }))).toBe('comments');
    expect(taskDefaultView('tab', st({ source: 'jiraffe' }))).toBe('comments');
  });
});

describe('лента: новое, плашки', () => {
  const a = ev({ id: '1', kind: 'status', at: 100, mine: true, fromThisChat: true });
  const h = ev({ id: '2', kind: 'comment', at: 200, commentId: 'c2', duringTurn: true });
  const h2 = ev({ id: '3', kind: 'comment', at: 300, commentId: 'c3', duringTurn: true, author: 'И. Петров' });
  const late = ev({ id: '4', kind: 'comment', at: 400, commentId: 'c4', duringTurn: false });

  it('unseenCount считает строго новее отметки; Infinity — «ещё не загружалось»', () => {
    expect(unseenCount([a, h, h2], 150)).toBe(2);
    expect(unseenCount([a, h, h2], 300)).toBe(0);
    expect(unseenCount([a, h], Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('humanPrompts: комментарий не-mine внутри хода, без уже отправленных, новые сверху, не больше лимита', () => {
    expect(humanPrompts([h2, h, a, late], new Set()).map((e) => e.commentId)).toEqual(['c3', 'c2']);
    expect(humanPrompts([h2, h], new Set(['c3'])).map((e) => e.commentId)).toEqual(['c2']);
    expect(humanPrompts([h2, h], new Set(), 1)).toHaveLength(1);
    expect(humanPrompts([{ ...h, mine: true }], new Set())).toEqual([]);
  });

  it('visibleEvents: humanChanges=false оставляет только свои; latestSeen — события и комментарии карточки', () => {
    expect(visibleEvents(st({ events: [a, h] })).map((e) => e.id)).toEqual(['1', '2']);
    expect(visibleEvents(st({ events: [a, h], humanChanges: false })).map((e) => e.id)).toEqual(['1']);
    expect(latestSeen(st({ events: [a, h] }))).toBe(200);
    expect(latestSeen(undefined)).toBe(0);
    const card = { comments: [{ at: 900 }] } as unknown as TaskStateMessage['card'];
    expect(latestSeen(st({ events: [a], ...(card ? { card } : {}) }))).toBe(900);
  });

  it('eventActor и eventText', () => {
    expect(eventActor(a)).toBe('agent');
    expect(eventActor({ ...a, fromThisChat: false })).toBe('self');
    expect(eventActor(h)).toBe('human');
    expect(eventText(ev({ id: 's', kind: 'status', at: 1, from: 'В работе', to: 'Тестирование' }))).toEqual({
      label: 'статус',
      text: 'В работе → ',
      strong: 'Тестирование',
    });
    expect(eventText(ev({ id: 'w', kind: 'worklog', at: 1, text: '1h · работа' })).strong).toBe('1h · работа');
    expect(eventText(ev({ id: 'c', kind: 'comment', at: 1, text: 'x'.repeat(300) })).text.length).toBeLessThan(250);
  });
});

describe('мелочи', () => {
  it('issueKeyOf, initials, sizeLabel, descriptionLong', () => {
    expect(issueKeyOf('jira:inst:NEWMFC-1482')).toBe('NEWMFC-1482');
    expect(issueKeyOf('jira:ho:st:A-1')).toBe('A-1');
    expect(initials('Ольга К.')).toBe('ОК');
    expect(initials('  ')).toBe('?');
    expect(initials('anna')).toBe('A');
    expect(sizeLabel(148 * 1024)).toBe('148 КБ');
    expect(sizeLabel(2.5 * 1024 * 1024)).toBe('2.5 МБ');
    expect(sizeLabel(0)).toBe('');
    expect(descriptionLong('коротко')).toBe(false);
    expect(descriptionLong('a\n'.repeat(5))).toBe(true);
    expect(descriptionLong('x'.repeat(241))).toBe(true);
  });

  it('agoLabel', () => {
    const now = 10_000_000;
    expect(agoLabel(0, now)).toBe('не загружено');
    expect(agoLabel(now - 5000, now)).toBe('только что');
    expect(agoLabel(now - 5 * 60_000, now)).toBe('5 мин назад');
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe('3 ч назад');
    expect(agoLabel(now - 2 * 86_400_000 - 1, now)).toBe('2 дн назад');
  });
});

describe('parseDuration', () => {
  it('1h 30m, 45m, 2h, 1.5h, 1,5h → секунды; мусор, без единицы, меньше минуты и больше суток — undefined', () => {
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('45m')).toBe(2700);
    expect(parseDuration(' 2H ')).toBe(7200);
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('1,5h')).toBe(5400);
    expect(parseDuration('24h')).toBe(86_400);
    for (const bad of ['', 'abc', '90', '1h 1h', '25h', '0m', '1d', '1h30', '-1h']) expect(parseDuration(bad), bad).toBeUndefined();
  });
});

describe('мелочи вкладки «задача»', () => {
  it('todayIso — местная дата YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 9, 8, 23, 59))).toBe('2026-10-08');
    expect(todayIso(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
  it('timeProgress: доля от оценки, не больше 100; оценки нет — undefined', () => {
    expect(timeProgress({ originalSec: 21_600, spentSec: 7200 })).toBe(33);
    expect(timeProgress({ originalSec: 3600, spentSec: 7200 })).toBe(100);
    expect(timeProgress({ spentSec: 7200 })).toBeUndefined();
  });
  it('fileExt: расширение крупно, иначе FILE', () => {
    expect(fileExt('terminal.log')).toBe('LOG');
    expect(fileExt('Makefile')).toBe('FILE');
    expect(fileExt('.env')).toBe('FILE');
    expect(fileExt('a.verylongext')).toBe('FILE');
  });
  it('actionErrorText: no-writer — подсказка, остальное — текст источника', () => {
    expect(actionErrorText('no-writer')).toContain('обновите Jiraffe');
    expect(actionErrorText('Jira: 400')).toBe('Не вышло: Jira: 400');
  });
  it('waitingWhat: разрешение, вопрос, план; без ожидания — undefined', () => {
    const base = { rows: [], nextId: 1 } as unknown as ChatState;
    expect(waitingWhat(base)).toBeUndefined();
    const perm = { id: 1, kind: 'perm', toolUseId: 'p', toolName: 'Bash', input: { command: 'git push' }, description: 'git push' };
    expect(waitingWhat({ ...base, rows: [perm] } as unknown as ChatState)).toBe('git push');
    const ask = { id: 2, kind: 'question', toolUseId: 'q', questions: [{ question: 'Какую ветку?', options: [] }], picks: {}, custom: {}, state: 'pending' };
    expect(waitingWhat({ ...base, rows: [ask] } as unknown as ChatState)).toBe('Какую ветку?');
    const plan = { id: 3, kind: 'plan', toolUseId: 'pl', plan: 'x', state: 'pending' };
    expect(waitingWhat({ ...base, rows: [plan] } as unknown as ChatState)).toBe('решение по плану');
  });
});
