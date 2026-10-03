import { describe, expect, it } from 'vitest';
import { en } from './strings.en';
import { ui } from './strings';

const CYR = /[А-Яа-яЁё]/;
/** Названия языков пишутся на своём языке (решение roadmap 07): единственное исключение. */
const ALLOWED = new Set(['settings.language.options.ru']);

type Node = unknown;

/** Все строки словаря; функции вызываются с аргументами по arity. */
function strings(n: Node, path: string, out: [string, string][]): void {
  if (typeof n === 'string') {
    out.push([path, n]);
  } else if (typeof n === 'function') {
    const f = n as (...a: unknown[]) => unknown;
    const variants: unknown[][] =
      f.length === 0
        ? [[]]
        : f.length === 1
          ? [[1], [2], [5], ['x'], [[1]], [[1, 2]], [[]]]
          : f.length === 2
            ? [[1, 'x'], ['x', 'y'], [1, 2], ['x', true], [['a'], 'x']]
            : [[1, 'x', 'y'], ['x', 'y', 'z']];
    for (const args of variants) {
      let r: unknown;
      try {
        r = f(...args);
      } catch {
        continue; // сигнатура не под эти аргументы — другой вариант подойдёт
      }
      if (typeof r === 'string') out.push([`${path}(${JSON.stringify(args)})`, r]);
    }
  } else if (Array.isArray(n)) {
    n.forEach((v, i) => strings(v, `${path}.${i}`, out));
  } else if (n && typeof n === 'object') {
    for (const [k, v] of Object.entries(n)) strings(v, path ? `${path}.${k}` : k, out);
  }
}

function keys(n: Node, path = ''): string[] {
  if (Array.isArray(n)) return n.flatMap((v, i) => keys(v, `${path}.${i}`));
  if (n && typeof n === 'object') {
    return Object.entries(n).flatMap(([k, v]) => keys(v, path ? `${path}.${k}` : k));
  }
  return [path + (typeof n === 'function' ? `()${(n as { length: number }).length}` : '')];
}

describe('словари ui', () => {
  it('в английском нет кириллицы', () => {
    const all: [string, string][] = [];
    strings(en, '', all);
    expect(all.length).toBeGreaterThan(500);
    const bad = all.filter(([p, v]) => CYR.test(v) && !ALLOWED.has(p));
    expect(bad).toEqual([]);
  });

  it('в jsdom без lang подхватывается русский', () => {
    expect(ui.hud.sessionsTitle).toBe('Сессии');
  });

  it('набор ключей и арность функций совпадают с русским', async () => {
    // ru не экспортируется: в тестах без <html lang> `ui` и есть русский словарь
    expect(keys(en).sort()).toEqual(keys(ui).sort());
  });

  it('английские plural и дата', () => {
    expect(en.empty.turns(1)).toBe('1 turn');
    expect(en.empty.turns(2)).toBe('2 turns');
    expect(en.time.dayMonth(23, 8)).toBe('September 23');
    expect(en.time.dayMonth(23, 8, 2025)).toBe('September 23, 2025');
  });
});
