import { describe, expect, it } from 'vitest';
import type { LimitWindow } from '../agent/types';
import { deferredNote, leftLabel, limitBanner, limitBlock } from './limitView';

const NOW = new Date(2026, 9, 1, 14, 56).getTime();
const HOUR = 3_600_000;
const five = (percent: number, resetsAt?: number): LimitWindow => ({
  kind: 'five-hour',
  percent,
  ...(resetsAt !== undefined ? { resetsAt } : {}),
});
const week = (percent: number): LimitWindow => ({
  kind: 'weekly',
  percent,
  resetsAt: NOW + 50 * HOUR,
});

describe('limitBlock', () => {
  it('нет упора и окна не полные — нет блокировки', () => {
    expect(limitBlock({ status: 'idle', windows: [five(63, NOW + HOUR)] }, NOW)).toBeUndefined();
  });

  it('окно подписки на 100 % со сбросом в будущем блокирует даже чужую вкладку (лимит общий на аккаунт)', () => {
    const b = limitBlock({ status: 'idle', windows: [five(100, NOW + 2 * HOUR), week(36)] }, NOW);
    expect(b).toMatchObject({ kind: 'five-hour', until: NOW + 2 * HOUR, weekFree: 64, soft: true });
    // по данным подписки — «мягкая»: баннер даёт «Попробовать снова» (данные устарели, докуплен расход)
    expect(limitBanner(b!, NOW).canRetry).toBe(true);
  });

  it('своя сессия упёрлась и окно подписки полное — блокировка «жёсткая», без кнопки повтора', () => {
    const b = limitBlock(
      { status: 'limited', resetsAt: NOW + 2 * HOUR, windows: [five(100, NOW + 2 * HOUR)] },
      NOW,
    );
    expect(b?.soft).toBeUndefined();
    expect(limitBanner(b!, NOW).canRetry).toBe(false);
  });

  it('недельное окно отдельной модели на 100 % чужую вкладку не блокирует', () => {
    const fable: LimitWindow = {
      kind: 'weekly-model',
      model: 'Fable',
      percent: 100,
      resetsAt: NOW + 30 * HOUR,
    };
    expect(limitBlock({ status: 'idle', windows: [fable, week(40)] }, NOW)).toBeUndefined();
  });

  it('«Попробовать снова» снимает блокировку по данным подписки для этого сброса, новое окно — снова блокирует', () => {
    const windows = [five(100, NOW + 2 * HOUR)];
    expect(
      limitBlock({ status: 'idle', windows, dismissed: NOW + 2 * HOUR + 20_000 }, NOW),
    ).toBeUndefined();
    expect(limitBlock({ status: 'idle', windows, dismissed: NOW - 3 * HOUR }, NOW)).toMatchObject({
      kind: 'five-hour',
    });
  });

  it('окно на 100 % без сброса или со сбросом в прошлом — не блокирует (устаревшие данные)', () => {
    expect(limitBlock({ status: 'idle', windows: [five(100)] }, NOW)).toBeUndefined();
    expect(limitBlock({ status: 'idle', windows: [five(100, NOW - 1)] }, NOW)).toBeUndefined();
  });

  it('из нескольких полных окон берётся самое позднее', () => {
    const b = limitBlock(
      {
        status: 'idle',
        windows: [five(100, NOW + HOUR), { ...week(100), resetsAt: NOW + 30 * HOUR }],
      },
      NOW,
    );
    expect(b).toMatchObject({ kind: 'weekly', until: NOW + 30 * HOUR });
    expect(b?.weekFree).toBeUndefined();
  });

  it('свой упор: время сброса из события, окно угадывается по совпадению сброса', () => {
    const b = limitBlock(
      { status: 'limited', resetsAt: NOW + HOUR, windows: [five(90, NOW + HOUR + 30_000)] },
      NOW,
    );
    expect(b).toMatchObject({ kind: 'five-hour', until: NOW + HOUR });
  });

  it('свой упор без времени сброса — блокировка без until; сброс прошёл — снята', () => {
    expect(limitBlock({ status: 'limited', windows: [] }, NOW)).toEqual({ kind: 'unknown' });
    expect(limitBlock({ status: 'limited', resetsAt: NOW - 1, windows: [] }, NOW)).toBeUndefined();
  });
});

describe('тексты', () => {
  it('leftLabel: часы и минуты, как в прототипе «2 ч 04 мин»', () => {
    expect(leftLabel(2 * HOUR + 4 * 60_000)).toBe('2 ч 04 мин');
    expect(leftLabel(37 * 60_000)).toBe('37 мин');
    expect(leftLabel(10_000)).toBe('1 мин');
    expect(leftLabel(0)).toBe('меньше минуты');
  });

  it('баннер пятичасового окна: заголовок, сброс и свободная неделя; без сброса — кнопка повтора', () => {
    const b = limitBanner(
      { kind: 'five-hour', until: NOW + 2 * HOUR + 4 * 60_000, weekFree: 64 },
      NOW,
    );
    expect(b.title).toBe('Лимит 5-часового окна исчерпан.');
    expect(b.detail).toBe('Сброс в 17:00, через 2 ч 04 мин. Недельное окно свободно на 64 %.');
    expect(b.canRetry).toBe(false);
    expect(limitBanner({ kind: 'unknown' }, NOW)).toMatchObject({
      title: 'Лимит подписки исчерпан.',
      canRetry: true,
    });
    expect(
      limitBanner({ kind: 'weekly-model', model: 'Fable', until: NOW + HOUR }, NOW).title,
    ).toBe('Недельный лимит модели Fable исчерпан.');
  });

  it('подпись под полем ввода', () => {
    expect(deferredNote({ kind: 'five-hour', until: NOW + 2 * HOUR + 4 * 60_000 }, NOW)).toBe(
      'отправка отложена до 17:00',
    );
    expect(deferredNote({ kind: 'unknown' }, NOW)).toBe('отправка отложена: лимит исчерпан');
  });
});
