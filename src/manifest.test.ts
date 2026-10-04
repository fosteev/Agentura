import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS_VIEWS, DEFAULT_AGENTS_VIEW } from './settings';

const root = join(__dirname, '..');
const read = (f: string): unknown => JSON.parse(readFileSync(join(root, f), 'utf8'));

/** Все `%ключ%` из манифеста. */
function refs(n: unknown, out: string[] = []): string[] {
  if (typeof n === 'string') {
    const m = /^%(.+)%$/.exec(n);
    if (m) out.push(m[1]!);
  } else if (Array.isArray(n)) n.forEach((v) => refs(v, out));
  else if (n && typeof n === 'object') Object.values(n).forEach((v) => refs(v, out));
  return out;
}

describe('package.nls', () => {
  const used = refs(read('package.json')).sort();
  const en = read('package.nls.json') as Record<string, string>;
  const ru = read('package.nls.ru.json') as Record<string, string>;

  it('каждый %ключ% манифеста есть в обоих файлах, лишних нет', () => {
    expect(used.length).toBeGreaterThan(30);
    expect(Object.keys(en).sort()).toEqual([...new Set(used)]);
    expect(Object.keys(ru).sort()).toEqual([...new Set(used)]);
  });

  it('в английском нет кириллицы, в русском нет пустых значений', () => {
    expect(Object.values(en).filter((v) => /[А-Яа-яЁё]/.test(v))).toEqual([]);
    expect(Object.values(ru).filter((v) => !v.trim())).toEqual([]);
  });

  it('в package.json не осталось русских текстов', () => {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    expect(raw).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('agentura.agents.view', () => {
  const pkg = read('package.json') as {
    contributes: {
      configuration: { properties: Record<string, { enum?: string[]; enumDescriptions?: string[]; default?: string }> };
      commands: { command: string }[];
    };
  };
  const prop = pkg.contributes.configuration.properties['agentura.agents.view']!;

  it('enum и значение по умолчанию совпадают с настройкой в коде, у каждого значения есть описание', () => {
    expect(prop.enum).toEqual([...AGENTS_VIEWS]);
    expect(prop.default).toBe(DEFAULT_AGENTS_VIEW);
    expect(prop.enumDescriptions).toHaveLength(AGENTS_VIEWS.length);
  });

  it('команда выбора вида объявлена', () => {
    expect(pkg.contributes.commands.map((c) => c.command)).toContain('agentura.agentsView');
  });
});
