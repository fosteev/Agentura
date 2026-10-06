import { describe, expect, it } from 'vitest';
import { parseAgyUsage } from './quota';

const REAL =
  'Gemini Models\tWeekly Limit Remaining\t26%\t2026-10-12T16:21:42Z\n' +
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-12T22:43:53Z\n';

describe('parseAgyUsage', () => {
  it('разбирает вывод /usage: по строке на семейство', () => {
    expect(parseAgyUsage(REAL)).toEqual([
      { label: 'Gemini', name: 'Gemini Models', remaining: 26, resetsAt: Date.parse('2026-10-12T16:21:42Z') },
      { label: 'Claude/GPT', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z') },
    ]);
  });

  it('мягкий: CRLF, нет даты, процент не в третьем поле, дробный процент', () => {
    const rows = parseAgyUsage('Gemini Models\r\nPro Models\tWeekly Limit\t12.6 %\r\nOther\tLimit\t7%\r\n');
    expect(rows.map((r) => [r.label, r.remaining])).toEqual([['Pro Models', 13], ['Other', 7]]);
    expect(parseAgyUsage('Other\tLimit\tx\t3%\n')[0]?.remaining).toBe(3);
    expect(parseAgyUsage('Other\tLimit\t12.6%\n')[0]?.remaining).toBe(13);
  });

  it('мусор, пустой вывод и предупреждения — пустой список', () => {
    expect(parseAgyUsage('')).toEqual([]);
    expect(parseAgyUsage('Error: not logged in\nrun agy to sign in\n')).toEqual([]);
  });

  it('запятая в дроби, поля через пробелы, колонка «used» переворачивается в остаток', () => {
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Remaining\t12,4%\n')[0]?.remaining).toBe(12);
    const spaced = parseAgyUsage('Gemini Models    Weekly Limit Remaining    26%    2026-10-12T16:21:42Z\n')[0];
    expect(spaced).toMatchObject({ label: 'Gemini', remaining: 26, resetsAt: Date.parse('2026-10-12T16:21:42Z') });
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Used\t74%\n')[0]?.remaining).toBe(26);
  });

  it('шум с процентом (прогресс, лог) без подписи про лимит и без даты — не квота', () => {
    expect(parseAgyUsage('Downloading update    45%\nfetch\t3%\n')).toEqual([]);
  });

  it('процент зажат в 0…100', () => {
    expect(parseAgyUsage('Gemini\tWeekly Limit Remaining\t140%\n')[0]?.remaining).toBe(100);
  });
});
