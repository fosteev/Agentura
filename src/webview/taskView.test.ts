import { describe, expect, it } from 'vitest';
import type { TaskEvent, TaskStateMessage } from '../shared/task';
import {
  agoLabel,
  descriptionLong,
  eventActor,
  eventText,
  humanPrompts,
  initials,
  issueKeyOf,
  latestSeen,
  sizeLabel,
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
  it('panel и split — у любого чата по задаче; strip — никогда', () => {
    expect(taskPanelShown('panel', st())).toBe(true);
    expect(taskPanelShown('strip', st())).toBe(false);
    expect(taskPanelShown('split', st({ source: 'jiraffe' }))).toBe(true);
    expect(taskPanelShown('split', st({ source: 'own' }))).toBe(true);
    expect(taskPanelShown('split', st({ source: 'none' }))).toBe(true);
    expect(taskPanelShown('panel', undefined)).toBe(false);
    expect(taskPanelShown('panel', st({ taskKey: undefined as unknown as string }))).toBe(false);
  });
});

describe('taskDefaultView', () => {
  it('split с Jiraffe — «изменения», остальное — «карточка»', () => {
    expect(taskDefaultView('split', st({ source: 'jiraffe' }))).toBe('changes');
    expect(taskDefaultView('split', st({ source: 'own' }))).toBe('card');
    expect(taskDefaultView('panel', st({ source: 'jiraffe' }))).toBe('card');
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
