import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../protocol';
import {
  costLabel,
  dayLabel,
  groupByDay,
  limitRows,
  resetWhen,
  rowClass,
  subLabel,
  tokensLabel,
  untilLabel,
  whenLabel,
} from './sessionsView';

// 1 октября 2026, 15:00 (четверг)
const NOW = new Date(2026, 9, 1, 15, 0).getTime();
/** `days` календарных дней назад, в `h:m`. */
const ago = (days: number, h = 12, m = 0) => new Date(2026, 9, 1 - days, h, m).getTime();
const row = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'x',
  title: 'сессия',
  turns: 3,
  state: 'idle',
  updatedAt: NOW,
  ...over,
});

describe('дни и время', () => {
  it('заголовки дней: сегодня, вчера, дата, дата с годом', () => {
    expect(dayLabel(ago(0, 1), NOW)).toBe('Сегодня');
    expect(dayLabel(ago(1, 23), NOW)).toBe('Вчера');
    expect(dayLabel(ago(8), NOW)).toBe('23 сентября');
    expect(dayLabel(new Date(2025, 11, 31, 10).getTime(), NOW)).toBe('31 декабря 2025');
  });

  it('справа: сейчас у идущей, время за сегодня/вчера, день недели за неделю, иначе дата', () => {
    expect(whenLabel(row({ state: 'live' }), NOW)).toBe('сейчас');
    expect(whenLabel(row({ state: 'waiting' }), NOW)).toBe('сейчас');
    expect(whenLabel(row({ updatedAt: ago(0, 13, 5) }), NOW)).toBe('13:05');
    expect(whenLabel(row({ updatedAt: ago(1, 18, 2) }), NOW)).toBe('18:02');
    expect(whenLabel(row({ updatedAt: ago(3) }), NOW)).toBe('ПН'.toLowerCase()); // 28 сентября — понедельник
    expect(whenLabel(row({ updatedAt: ago(8) }), NOW)).toBe('23.09');
  });

  it('группировка по дням сохраняет порядок', () => {
    const g = groupByDay(
      [
        row({ id: 'a', updatedAt: ago(0) }),
        row({ id: 'b', updatedAt: ago(0, 9) }),
        row({ id: 'c', updatedAt: ago(1) }),
      ],
      NOW,
    );
    expect(g.map((x) => [x.day, x.rows.map((r) => r.id)])).toEqual([
      ['Сегодня', ['a', 'b']],
      ['Вчера', ['c']],
    ]);
  });
});

describe('подпись строки', () => {
  it('ходы · стоимость · контекст', () => {
    expect(subLabel(row({ turns: 14, costUsd: 1.84, contextTokens: 131_000 }))).toBe(
      '14 ходов · $1.84 · 131k',
    );
    expect(subLabel(row({ turns: 1, costUsd: 0.004 }))).toBe('1 ход · $0.004');
  });

  it('стоимости нет — «—»; оценка без части моделей — с пометкой', () => {
    expect(costLabel({})).toBe('—');
    expect(costLabel({ costUsd: 2, costPartial: true })).toBe('$2.00 ≈ не все модели');
    expect(subLabel(row({ turns: 2 }))).toBe('2 хода · —');
  });

  it('тег состояния: ждёт ответа, ошибка, лимит', () => {
    expect(subLabel(row({ turns: 3, costUsd: 0.42, state: 'waiting' }))).toBe(
      '3 хода · $0.42 · ждёт ответа',
    );
    expect(subLabel(row({ costUsd: 1, state: 'error' }))).toContain('ошибка движка');
    expect(subLabel(row({ costUsd: 1, state: 'limit' }))).toContain('лимит исчерпан');
  });

  it('классы строки: cur, live, wait, err', () => {
    expect(rowClass(row({ state: 'live' }), true)).toBe('s cur live');
    expect(rowClass(row({ state: 'waiting' }), false)).toBe('s wait');
    expect(rowClass(row({ state: 'limit' }), false)).toBe('s err');
    expect(rowClass(row(), false)).toBe('s');
  });

  it('токены: 950, 131k, 1.2M', () => {
    expect([tokensLabel(950), tokensLabel(131_400), tokensLabel(1_200_000)]).toEqual([
      '950',
      '131k',
      '1.2M',
    ]);
    // не «1000k»: колонка контекста рассчитана на 8 символов (`1.2M ctx`)
    expect([tokensLabel(999_499), tokensLabel(999_600)]).toEqual(['999k', '1M']);
  });
});

describe('лимиты', () => {
  it('сброс: сегодня, в ближайшие дни, далеко; обратный отсчёт', () => {
    expect(resetWhen(ago(0, 17), NOW)).toBe('в 17:00');
    expect(resetWhen(new Date(2026, 9, 2, 9).getTime(), NOW)).toBe('в пятницу, 09:00');
    expect(resetWhen(new Date(2026, 9, 20, 9).getTime(), NOW)).toBe('20 октября, 09:00');
    expect(untilLabel(2 * 3_600_000 + 8 * 60_000)).toBe('2 ч 08 мин');
    expect(untilLabel(45 * 60_000)).toBe('45 мин');
    expect(untilLabel(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 дн 4 ч');
  });

  it('строки: 5 часов, неделя, недельное окно модели дополнительной строкой; неактивное — «0 %» без сброса', () => {
    const rows = limitRows(
      [
        {
          kind: 'weekly-model',
          model: 'Fable',
          percent: 12,
          resetsAt: new Date(2026, 9, 3, 9).getTime(),
        },
        { kind: 'weekly', percent: 34, resetsAt: new Date(2026, 9, 3, 9).getTime() },
        { kind: 'five-hour', percent: 62, resetsAt: new Date(2026, 9, 1, 17).getTime() },
      ],
      NOW,
    );
    expect(rows.map((r) => [r.label, r.percent])).toEqual([
      ['Окно 5 часов', 62],
      ['Неделя', 34],
      ['Неделя · Fable', 12],
    ]);
    expect(rows[0]!.note).toBe('сброс в 17:00 · через 2 ч 00 мин');
    expect(rows[1]!.note).toBe('сброс в субботу, 09:00');
    const idle = limitRows([{ kind: 'five-hour', percent: 0 }], NOW)[0]!;
    expect(idle).toMatchObject({ percent: 0, note: '', full: false });
    expect(
      limitRows([{ kind: 'five-hour', percent: 100, resetsAt: NOW + 60_000 }], NOW)[0]!.full,
    ).toBe(true);
  });
});
