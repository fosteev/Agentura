import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_VIEWS,
  COMPOSER_LAYOUTS,
  DEFAULT_AGENTS_VIEW,
  DEFAULT_COMPOSER_LAYOUT, DEFAULT_GIT_LAYOUT,
  DEFAULT_SIDEBAR_LIMITS,
  GIT_LAYOUTS,
  DEFAULT_JIRA_SOURCE,
  DEFAULT_TASK_REFRESH,
  JIRA_SOURCES,
  TASK_REFRESH_MODES,
  SIDEBAR_LIMITS_MODES,
} from './settings';

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

describe('agentura.git.layout', () => {
  const pkg = read('package.json') as {
    contributes: {
      configuration: { properties: Record<string, { enum?: string[]; enumDescriptions?: string[]; default?: string }> };
      commands: { command: string }[];
    };
  };
  const prop = pkg.contributes.configuration.properties['agentura.git.layout']!;

  it('enum и значение по умолчанию совпадают с настройкой в коде, у каждого значения есть описание', () => {
    expect(prop.enum).toEqual([...GIT_LAYOUTS]);
    expect(prop.default).toBe(DEFAULT_GIT_LAYOUT);
    expect(prop.enumDescriptions).toHaveLength(GIT_LAYOUTS.length);
  });

  it('команда выбора раскладки объявлена', () => {
    expect(pkg.contributes.commands.map((c) => c.command)).toContain('agentura.gitLayout');
  });
});

describe('agentura.composer.layout', () => {
  const pkg = read('package.json') as {
    contributes: {
      configuration: { properties: Record<string, { enum?: string[]; enumDescriptions?: string[]; default?: string }> };
      commands: { command: string }[];
    };
  };
  const prop = pkg.contributes.configuration.properties['agentura.composer.layout']!;

  it('enum и значение по умолчанию совпадают с настройкой в коде, у каждого значения есть описание', () => {
    expect(prop.enum).toEqual([...COMPOSER_LAYOUTS]);
    expect(prop.default).toBe(DEFAULT_COMPOSER_LAYOUT);
    expect(prop.enumDescriptions).toHaveLength(COMPOSER_LAYOUTS.length);
  });

  it('команда выбора раскладки объявлена', () => {
    expect(pkg.contributes.commands.map((c) => c.command)).toContain('agentura.composerLayout');
  });
});

describe('agentura.sidebar.limits', () => {
  const pkg = read('package.json') as {
    contributes: {
      configuration: { properties: Record<string, { enum?: string[]; enumDescriptions?: string[]; default?: string }> };
      commands: { command: string }[];
    };
  };
  const prop = pkg.contributes.configuration.properties['agentura.sidebar.limits']!;

  it('enum и значение по умолчанию совпадают с настройкой в коде, у каждого значения есть описание', () => {
    expect(prop.enum).toEqual([...SIDEBAR_LIMITS_MODES]);
    expect(prop.default).toBe(DEFAULT_SIDEBAR_LIMITS);
    expect(prop.enumDescriptions).toHaveLength(SIDEBAR_LIMITS_MODES.length);
  });

  it('команда выбора вида объявлена', () => {
    expect(pkg.contributes.commands.map((c) => c.command)).toContain('agentura.sidebarLimits');
  });
});

describe('настройки Jira (roadmap 19, этап 2)', () => {
  const pkg = read('package.json') as {
    contributes: {
      configuration: {
        properties: Record<string, { type?: string; enum?: string[]; enumDescriptions?: string[]; default?: unknown }>;
      };
      commands: { command: string }[];
    };
  };
  const props = pkg.contributes.configuration.properties;

  it('agentura.jira.source и agentura.tasks.refresh: enum и значение по умолчанию совпадают с кодом, у значений есть описания', () => {
    expect(props['agentura.jira.source']!.enum).toEqual([...JIRA_SOURCES]);
    expect(props['agentura.jira.source']!.default).toBe(DEFAULT_JIRA_SOURCE);
    expect(props['agentura.jira.source']!.enumDescriptions).toHaveLength(JIRA_SOURCES.length);
    expect(props['agentura.tasks.refresh']!.enum).toEqual([...TASK_REFRESH_MODES]);
    expect(props['agentura.tasks.refresh']!.default).toBe(DEFAULT_TASK_REFRESH);
    expect(props['agentura.tasks.refresh']!.enumDescriptions).toHaveLength(TASK_REFRESH_MODES.length);
  });

  it('agentura.tasks.humanChanges — boolean, по умолчанию true', () => {
    expect(props['agentura.tasks.humanChanges']).toMatchObject({ type: 'boolean', default: true });
  });

  it('команды подключения Jira и «Чат по задаче…» объявлены', () => {
    const ids = pkg.contributes.commands.map((c) => c.command);
    for (const c of ['agentura.jira.connect', 'agentura.jira.disconnect', 'agentura.jira.test', 'agentura.chatForTask']) {
      expect(ids).toContain(c);
    }
  });
});
