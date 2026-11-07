import { describe, expect, it } from 'vitest';
import { parseAgyUsage } from './quota';

const REAL_OLD =
  'Gemini Models\tWeekly Limit Remaining\t26%\t2026-10-12T16:21:42Z\n' +
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-12T22:43:53Z\n';

const REAL_153 =
  'Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-12T16:21:42Z\n' +
  'Gemini Models\tFive Hour Limit Remaining\t97%\t2026-10-12T16:21:42Z\n' +
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-12T22:43:53Z\n' +
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-12T22:43:53Z\n' +
  'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t66%\t2026-10-12T16:21:42Z\n';

describe('parseAgyUsage', () => {
  it('разбирает 5-оконный вывод agy 1.5.3 с разделением 5ч/7д и Argon', () => {
    expect(parseAgyUsage(REAL_153)).toEqual([
      { label: 'Gemini 7д', name: 'Gemini Models', remaining: 99, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' },
      { label: 'Gemini 5ч', name: 'Gemini Models', remaining: 97, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'fiveHour' },
      { label: 'Claude/GPT 7д', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z'), window: 'weekly' },
      { label: 'Claude/GPT 5ч', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z'), window: 'fiveHour' },
      { label: 'Gemini 4 Argon 7д', name: 'Gemini 4 Argon', remaining: 66, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' },
    ]);
  });

  it('сохраняет обратную совместимость со старым 2-строчным выводом', () => {
    expect(parseAgyUsage(REAL_OLD)).toEqual([
      { label: 'Gemini 7д', name: 'Gemini Models', remaining: 26, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' },
      { label: 'Claude/GPT 7д', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z'), window: 'weekly' },
    ]);
  });

  it('мягкий: CRLF, нет даты, процент не в третьем поле, дробный процент', () => {
    const rows = parseAgyUsage('Gemini Models\r\nPro Models\tWeekly Limit\t12.6 %\r\nOther\tLimit\t7%\r\n');
    expect(rows.map((r) => [r.label, r.remaining, r.window])).toEqual([['Pro Models 7д', 13, 'weekly'], ['Other', 7, undefined]]);
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
    expect(spaced).toMatchObject({ label: 'Gemini 7д', remaining: 26, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' });
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Used\t74%\n')[0]?.remaining).toBe(26);
  });

  it('шум с процентом (прогресс, лог) без подписи про лимит и без даты — не квота', () => {
    expect(parseAgyUsage('Downloading update    45%\nfetch\t3%\n')).toEqual([]);
  });

  it('процент зажат в 0…100', () => {
    expect(parseAgyUsage('Gemini\tWeekly Limit Remaining\t140%\n')[0]?.remaining).toBe(100);
  });
});
