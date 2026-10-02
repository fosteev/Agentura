import { describe, expect, it } from 'vitest';
import { hostStrings } from './l10n';

const CYR = /[А-Яа-яЁё]/;

const ARGS: unknown[][] = [
  [],
  [1],
  [2],
  ['x'],
  [1, 2],
  ['x', 'proposed'],
  ['x', 'applied'],
  [1, 2, 3],
  [1, 2, undefined],
  ['a', 'b', 'c'],
];

/** Все строки словаря; функции вызываются с набором аргументов по arity. */
function strings(n: unknown, out: string[]): void {
  if (typeof n === 'string') out.push(n);
  else if (typeof n === 'function') {
    const f = n as (...a: unknown[]) => unknown;
    for (const args of ARGS.filter((a) => a.length === f.length)) {
      const r = f(...args);
      if (typeof r === 'string') out.push(r);
    }
  }
}

function keys(d: object): string[] {
  return Object.entries(d)
    .map(([k, v]) => k + (typeof v === 'function' ? `()${(v as { length: number }).length}` : ''))
    .sort();
}

describe('словарь хоста', () => {
  const ru = hostStrings('ru');
  const en = hostStrings('en');

  it('в английском нет кириллицы', () => {
    const all: string[] = [];
    for (const v of Object.values(en)) strings(v, all);
    expect(all.length).toBeGreaterThan(40);
    expect(all.filter((s) => CYR.test(s))).toEqual([]);
  });

  it('набор ключей и арность функций совпадают', () => {
    expect(keys(en)).toEqual(keys(ru));
  });

  it('язык выбирает словарь', () => {
    expect(hostStrings('ru').reloadButton).toBe('Перезагрузить');
    expect(hostStrings('en').reloadButton).toBe('Reload');
    expect(en.turns(1)).toBe('1 turn');
    expect(ru.turns(2)).toBe('2 ходов');
  });
});
