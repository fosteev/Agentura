import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapIssueDetail, mapWorklog } from '../../data/jira/mappers';
import { FROM_CHAT_SLACK_MS, TurnLog, buildSnapshot, eventsSince, formatDuration, meRef, type TurnSpan } from './taskEvents';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/jira/issue-dc.json'), 'utf8'));
const issue = mapIssueDetail({ id: 'inst', kind: 'dc' }, fixture.issue, []);
const worklogs = fixture.worklog.worklogs.map((w: unknown) => mapWorklog('dc', w as Record<string, unknown>));
const instance = { id: 'inst', name: 'Work', baseUrl: 'https://jira.example.test/jira/' };
const at = (s: string): number => Date.parse(s);
const snap = (name: string | undefined) =>
  buildSnapshot({ instance, issue, worklogs, me: name ? meRef({ name, displayName: name }) : undefined });
const NOW = at('2026-10-03T00:00:00+0300');
const opts = { now: NOW };

describe('buildSnapshot (фикстура DC)', () => {
  const s = snap('anna.smirnova');

  it('карточка: поля, ссылка из baseUrl, описание и комментарии текстом, вложения со ссылкой', () => {
    expect(s.card).toMatchObject({
      key: 'ABC-123',
      instanceId: 'inst',
      instanceName: 'Work',
      status: 'В работе',
      statusCategory: 'indeterminate',
      url: 'https://jira.example.test/jira/browse/ABC-123',
    });
    expect(s.card.description).not.toMatch(/<[a-z]/);
    expect(s.card.comments.map((c) => [c.id, c.author, c.mine])).toEqual([
      ['50000', 'Ivan Petrov', false],
      ['50001', 'Anna Smirnova', true],
    ]);
    expect(s.card.comments[1]!.text).not.toMatch(/<[a-z]/);
    expect(s.card.attachments[0]).toMatchObject({ id: '40001', filename: 'report.png' });
    expect(s.card.attachments[0]!.url).toMatch(/^https:\/\//);
  });

  it('вложение с не-http адресом получает пустую ссылку (чип не откроется)', () => {
    const bad = buildSnapshot({
      instance,
      issue: { ...issue, attachments: [{ ...issue.attachments[0]!, contentUrl: 'javascript:alert(1)' }] },
      worklogs: [],
      me: undefined,
    });
    expect(bad.card.attachments[0]!.url).toBe('');
  });

  it('changes: статус, поле, комментарий, ворклог; шум changelog (WorklogId) не попал', () => {
    const kinds = new Set(s.changes.map((c) => c.kind));
    expect(kinds).toEqual(new Set(['status', 'field', 'comment', 'worklog']));
    expect(s.changes.some((c) => /worklogid/i.test(c.field ?? ''))).toBe(false);
    const st = s.changes.find((c) => c.kind === 'status' && c.from === 'Release testing');
    expect(st).toMatchObject({ field: 'status', from: 'Release testing', to: 'In Progress', author: 'Anna Smirnova', mine: true });
    expect(st!.text).toBe('status: Release testing → In Progress');
    const w = s.changes.find((c) => c.kind === 'worklog')!;
    expect(w).toMatchObject({ id: 'worklog:60000', author: 'Ivan Petrov', mine: false, text: '40m · Investigation and fix' });
  });

  it('«я» неизвестен (myself не ответил) — ничьи изменения не mine', () => {
    expect(snap(undefined).changes.every((c) => !c.mine)).toBe(true);
  });
});

describe('eventsSince', () => {
  const s = snap('anna.smirnova');
  // ход агента: 14:12:00–14:13:30 по Москве 2 октября; в нём комментарий Анны (14:12:56) и перевод статуса (14:13:01)
  const turn: TurnSpan = { start: at('2026-10-02T14:12:00+0300'), end: at('2026-10-02T14:13:30+0300') };

  it('openedAt = 0 — с начала; новые сверху', () => {
    const ev = eventsSince(s, 0, [], opts);
    expect(ev.length).toBe(s.changes.length);
    const times = ev.map((e) => e.at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('только то, что произошло после openedAt', () => {
    const ev = eventsSince(s, at('2026-10-01T00:00:00+0300'), [], opts);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.at > at('2026-10-01T00:00:00+0300'))).toBe(true);
    expect(ev.some((e) => e.id === 'comment:50000')).toBe(false); // комментарий Ивана июля
    expect(ev.map((e) => e.id)).toContain('comment:50001');
  });

  it('статус и комментарий агента в ходе сессии — fromThisChat; без хода — нет', () => {
    const inTurn = eventsSince(s, 0, [turn], opts);
    const status = inTurn.find((e) => e.kind === 'status' && e.to === 'In Progress' && e.from === 'Release testing')!;
    const comment = inTurn.find((e) => e.id === 'comment:50001')!;
    expect(status).toMatchObject({ mine: true, fromThisChat: true, duringTurn: true });
    expect(comment).toMatchObject({ mine: true, fromThisChat: true, duringTurn: true });
    const noTurn = eventsSince(s, 0, [], opts);
    expect(noTurn.find((e) => e.id === 'comment:50001')).toMatchObject({ mine: true, fromThisChat: false, duringTurn: false });
  });

  it('комментарий человека в ходе: не mine, не «из чата», но duringTurn (плашка «пока агент работал»)', () => {
    const human = snap('someone.else');
    const ev = eventsSince(human, 0, [turn], opts).find((e) => e.id === 'comment:50001')!;
    expect(ev).toMatchObject({ mine: false, fromThisChat: false, duringTurn: true });
  });

  it('запас 60 с после конца хода: запись доезжает с задержкой', () => {
    const early: TurnSpan = { start: turn.start, end: at('2026-10-02T14:12:20+0300') }; // комментарий через 36 с после конца
    const e1 = eventsSince(s, 0, [early], opts).find((e) => e.id === 'comment:50001')!;
    expect(e1).toMatchObject({ fromThisChat: true, duringTurn: false });
    const far: TurnSpan = { start: turn.start, end: at('2026-10-02T14:12:56+0300') - FROM_CHAT_SLACK_MS - 5_000 };
    expect(eventsSince(s, 0, [far], opts).find((e) => e.id === 'comment:50001')!.fromThisChat).toBe(false);
  });

  it('идущий ход (end нет) покрывает всё до now', () => {
    const open: TurnSpan = { start: turn.start };
    expect(eventsSince(s, 0, [open], opts).find((e) => e.id === 'comment:50001')!.duringTurn).toBe(true);
  });

  it('ворклог: kind worklog, чужой — не из чата', () => {
    const ev = eventsSince(s, 0, [turn], opts).find((e) => e.kind === 'worklog')!;
    expect(ev).toMatchObject({ mine: false, fromThisChat: false });
  });

  it('humanChanges = false оставляет только свои события; limit режет хвост', () => {
    const mine = eventsSince(s, 0, [], { ...opts, humanChanges: false });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.mine)).toBe(true);
    expect(eventsSince(s, 0, [], { ...opts, limit: 3 })).toHaveLength(3);
  });
});

describe('мелочи', () => {
  it('formatDuration', () => {
    expect([10, 2400, 5400, 7200, 3660].map(formatDuration)).toEqual(['<1m', '40m', '1h 30m', '2h', '1h 1m']);
  });

  it('meRef: Cloud — accountId, DC — name, нет ни того ни другого — без id', () => {
    expect(meRef({ accountId: 'acc', displayName: 'A' })).toEqual({ id: 'acc', displayName: 'A' });
    expect(meRef({ name: 'ivan', displayName: 'I' })).toEqual({ id: 'ivan', displayName: 'I' });
    expect(meRef({ displayName: 'X' })).toEqual({ displayName: 'X' });
  });

  it('TurnLog: старт/конец, повторный старт внутри хода игнорируется, clear', () => {
    const l = new TurnLog();
    l.start(10);
    l.start(20);
    expect(l.turns()).toEqual([{ start: 10 }]);
    l.end(30);
    l.end(40);
    l.start(50);
    expect(l.turns()).toEqual([{ start: 10, end: 30 }, { start: 50 }]);
    l.turns()[0]!.end = 999; // копия
    expect(l.turns()[0]!.end).toBe(30);
    l.clear();
    expect(l.turns()).toEqual([]);
  });
});

describe('buildSnapshot: недоверенный ввод (чужое расширение)', () => {
  it('не те типы и лишние длины — без падения, строки и числа на месте', () => {
    const bad = {
      ...issue,
      key: 'ABC-1',
      summary: { evil: true },
      statusCategory: 'weird',
      descriptionHtml: 42,
      comments: [{ id: 7, author: { name: ['x'] }, created: null, bodyHtml: '<b>hi</b>' }],
      attachments: 'nope',
      history: [{ created: '2026-10-01T00:00:00.000+0000', items: [{ field: 'status', from: 1, to: 'Done' }] },
        { created: '2026-10-01T00:00:00.000+0000', items: [{ field: 'status', from: 'Done', to: 'Open' }] }],
    } as never;
    const s = buildSnapshot({ instance, issue: bad, worklogs: [{ id: 'w', timeSpentSec: 'x' }] as never, me: undefined });
    expect(s.card).toMatchObject({ title: '', statusCategory: 'new', description: '', attachments: [] });
    expect(s.card.comments[0]).toMatchObject({ id: '', author: '', at: 0, text: 'hi' });
    const ids = s.changes.filter((c) => c.id.startsWith('hist:')).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(s.changes.find((c) => c.kind === 'status')?.from).toBeNull();
    expect(s.changes.find((c) => c.kind === 'worklog')?.text).toBe('<1m');
  });
});
