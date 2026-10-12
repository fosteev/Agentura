import { describe, expect, it } from 'vitest';
import {
  nextSessionListMode,
  overriddenKeys,
  readSettings,
  readTaskCardMode,
  resolveLanguage,
  resolveDefaultEffort,
  resolveDefaultMode,
  thresholdsError,
  validateSetting,
  writeSetting,
  type ConfigLike,
} from './settings';

const cfgOf = (values: Record<string, unknown>) => ({ get: <T>(k: string) => values[k] as T });

describe('thresholdsError', () => {
  it('жёлтый < оранжевый < 200 000', () => {
    expect(thresholdsError([120_000, 150_000])).toBeUndefined();
    expect(thresholdsError([1, 199_999])).toBeUndefined();
  });
  it('жёлтый не ниже оранжевого — ошибка', () => {
    expect(thresholdsError([150_000, 150_000])).toMatch(/ниже оранжевого/);
    expect(thresholdsError([160_000, 150_000])).toMatch(/ниже оранжевого/);
  });
  it('оранжевый на 200 000 и выше — ошибка', () => {
    expect(thresholdsError([120_000, 200_000])).toMatch(/200/);
    expect(thresholdsError([120_000, 250_000])).toMatch(/200/);
  });
  it('нечисла, дроби, нули и не пара', () => {
    expect(thresholdsError([NaN, 10])).toBeDefined();
    expect(thresholdsError(['1', 2])).toBeDefined();
    expect(thresholdsError([1.5, 3])).toBeDefined();
    expect(thresholdsError([0, 3])).toBeDefined();
    expect(thresholdsError([1, 2, 3])).toBeDefined();
    expect(thresholdsError(undefined)).toBeDefined();
  });
});

describe('validateSetting', () => {
  it('режим и effort — только из списка', () => {
    expect(validateSetting('defaultPermissionMode', 'plan')).toEqual({ ok: true, value: 'plan' });
    expect(validateSetting('defaultPermissionMode', 'default').ok).toBe(false);
    expect(validateSetting('defaultEffort', '')).toEqual({ ok: true, value: '' });
    expect(validateSetting('defaultEffort', 'xhigh').ok).toBe(true);
    expect(validateSetting('defaultEffort', 'ultra').ok).toBe(false);
  });
  it('строки обрезаются, булевы — только булевы', () => {
    expect(validateSetting('claudeExecutable', '  /bin/claude ')).toEqual({
      ok: true,
      value: '/bin/claude',
    });
    expect(validateSetting('allowBypassPermissions', 'true').ok).toBe(false);
  });
  it('Codex: путь обрезается, движок по умолчанию — только claude|codex', () => {
    expect(validateSetting('codexExecutable', ' /bin/codex ')).toEqual({ ok: true, value: '/bin/codex' });
    expect(validateSetting('codexExecutable', 1).ok).toBe(false);
    expect(validateSetting('defaultProvider', 'codex')).toEqual({ ok: true, value: 'codex' });
    expect(validateSetting('defaultProvider', 'antigravity')).toEqual({ ok: true, value: 'antigravity' });
    expect(validateSetting('antigravityExecutable', ' /bin/agy ')).toEqual({ ok: true, value: '/bin/agy' });
    expect(validateSetting('antigravityExecutable', 1).ok).toBe(false);
    expect(validateSetting('defaultProvider', 'gpt').ok).toBe(false);
  });
  it('опрос лимитов — целое не меньше 5', () => {
    expect(validateSetting('usagePollMinutes', 5).ok).toBe(true);
    expect(validateSetting('usagePollMinutes', 4).ok).toBe(false);
    expect(validateSetting('usagePollMinutes', 1440).ok).toBe(true);
    // больше суток: setTimeout в Node переполняется (2^31 мс) и опрос шёл бы без паузы
    expect(validateSetting('usagePollMinutes', 40_000).ok).toBe(false);
    expect(validateSetting('usagePollMinutes', 7.5).ok).toBe(false);
    expect(validateSetting('usagePollMinutes', '10').ok).toBe(false);
  });
  it('пороги проверяются целиком', () => {
    expect(validateSetting('contextThresholds', [100, 200]).ok).toBe(true);
    expect(validateSetting('contextThresholds', [200, 100]).ok).toBe(false);
  });
});

describe('sessionList', () => {
  it('вид — только detailed, compact, dense; кнопка ходит по кругу; колонки — булевы', () => {
    expect(validateSetting('sessionList.view', 'dense')).toEqual({ ok: true, value: 'dense' });
    expect(validateSetting('sessionList.view', 'tree').ok).toBe(false);
    expect(validateSetting('sessionList.time', false)).toEqual({ ok: true, value: false });
    expect(validateSetting('sessionList.context', 'on').ok).toBe(false);
    expect(nextSessionListMode('detailed')).toBe('compact');
    expect(nextSessionListMode('compact')).toBe('dense');
    expect(nextSessionListMode('dense')).toBe('detailed');
  });
  it('вид верха боковой панели — detailed, compact, dense', () => {
    expect(validateSetting('sidebar.top', 'dense')).toEqual({ ok: true, value: 'dense' });
    expect(validateSetting('sidebar.top', 'mini').ok).toBe(false);
    expect(validateSetting('sidebar.limits', 'table')).toEqual({ ok: true, value: 'table' });
    expect(validateSetting('sidebar.limits', 'grid').ok).toBe(false);
    expect(validateSetting('tasks.sidebar', 'section')).toEqual({ ok: true, value: 'section' });
    expect(validateSetting('tasks.sidebar', 'tree').ok).toBe(false);
    expect(validateSetting('tasks.card', 'split')).toEqual({ ok: true, value: 'split' });
    expect(validateSetting('tasks.card', 'tab')).toEqual({ ok: true, value: 'tab' });
    // режимы roadmap 19 больше не записываются (читаются как `tab` — readTaskCardMode)
    expect(validateSetting('tasks.card', 'panel').ok).toBe(false);
    expect(validateSetting('tasks.card', 'strip').ok).toBe(false);
    expect(validateSetting('tasks.tab', 'task')).toEqual({ ok: true, value: 'task' });
    expect(validateSetting('tasks.tab', 'chat')).toEqual({ ok: true, value: 'chat' });
    expect(validateSetting('tasks.tab', 'panel').ok).toBe(false);
    expect(validateSetting('jira.source', 'own')).toEqual({ ok: true, value: 'own' });
    expect(validateSetting('jira.source', 'cloud').ok).toBe(false);
    expect(validateSetting('tasks.refresh', 'manual')).toEqual({ ok: true, value: 'manual' });
    expect(validateSetting('tasks.refresh', '5s').ok).toBe(false);
    expect(validateSetting('tasks.humanChanges', false)).toEqual({ ok: true, value: false });
    expect(validateSetting('tasks.humanChanges', 'no').ok).toBe(false);
    // инструменты Jira агента (этап 8): ровно три флажка
    expect(validateSetting('jira.agentTools', { comment: false, transition: true, worklog: true })).toEqual({
      ok: true,
      value: { comment: false, transition: true, worklog: true },
    });
    expect(validateSetting('jira.agentTools', { comment: false }).ok).toBe(false);
    expect(validateSetting('jira.agentTools', true).ok).toBe(false);
    expect(validateSetting('feed.style', 'cards')).toEqual({ ok: true, value: 'cards' });
    expect(validateSetting('feed.style', 'grid').ok).toBe(false);
    for (const v of ['list', 'tree', 'lanes', 'cards', 'graph']) {
      expect(validateSetting('agents.view', v)).toEqual({ ok: true, value: v });
    }
    expect(validateSetting('agents.view', 'grid').ok).toBe(false);
    expect(validateSetting('agents.view', 3).ok).toBe(false);
    for (const v of ['stack', 'picker', 'unified']) {
      expect(validateSetting('git.layout', v)).toEqual({ ok: true, value: v });
    }
    expect(validateSetting('git.layout', 'grid').ok).toBe(false);
    expect(validateSetting('git.layout', 1).ok).toBe(false);
  });
});

describe('MCP и скиллы (roadmap 21)', () => {
  it('validateSetting: три флажка — только boolean, feedStatus — failures|start|off', () => {
    for (const k of ['mcp.feedLabels', 'mcp.composerButton', 'mcp.panelTab'] as const) {
      expect(validateSetting(k, false)).toEqual({ ok: true, value: false });
      expect(validateSetting(k, 'yes').ok).toBe(false);
    }
    for (const v of ['failures', 'start', 'off']) {
      expect(validateSetting('mcp.feedStatus', v)).toEqual({ ok: true, value: v });
    }
    expect(validateSetting('mcp.feedStatus', 'always').ok).toBe(false);
    expect(validateSetting('mcp.feedStatus', true).ok).toBe(false);
  });
  it('readSettings: по умолчанию всё включено и failures; мусор — по умолчанию, false — выключено', () => {
    expect(readSettings(cfgOf({}))).toMatchObject({
      'mcp.feedLabels': true,
      'mcp.composerButton': true,
      'mcp.panelTab': true,
      'mcp.feedStatus': 'failures',
    });
    expect(
      readSettings(
        cfgOf({ 'mcp.feedLabels': false, 'mcp.composerButton': 'x', 'mcp.panelTab': false, 'mcp.feedStatus': 'loud' }),
      ),
    ).toMatchObject({
      'mcp.feedLabels': false,
      'mcp.composerButton': true,
      'mcp.panelTab': false,
      'mcp.feedStatus': 'failures',
    });
    expect(readSettings(cfgOf({ 'mcp.feedStatus': 'off' }))['mcp.feedStatus']).toBe('off');
  });
});

describe('шрифты и размер ленты', () => {
  it('validateSetting: имя шрифта обрезается, без ; { } < >', () => {
    expect(validateSetting('font.code', '  JetBrains Mono ')).toEqual({
      ok: true,
      value: 'JetBrains Mono',
    });
    expect(validateSetting('font.interface', '')).toEqual({ ok: true, value: '' });
    expect(validateSetting('font.panels', ' Inter ')).toEqual({ ok: true, value: 'Inter' });
    expect(validateSetting('font.code', 'a; color: red').ok).toBe(false);
    expect(validateSetting('font.code', 5).ok).toBe(false);
  });
  it('validateSetting: размер — целое 10…20', () => {
    expect(validateSetting('feed.fontSize', 15)).toEqual({ ok: true, value: 15 });
    expect(validateSetting('feed.fontSize', 9).ok).toBe(false);
    expect(validateSetting('feed.fontSize', 21).ok).toBe(false);
    expect(validateSetting('feed.fontSize', 13.5).ok).toBe(false);
    expect(validateSetting('feed.fontSize', '14').ok).toBe(false);
    expect(validateSetting('ui.fontSize', 16)).toEqual({ ok: true, value: 16 });
    expect(validateSetting('ui.fontSize', 21).ok).toBe(false);
  });
  it('readSettings: мусор → пусто и 13', () => {
    expect(readSettings(cfgOf({ 'feed.fontSize': 99, 'font.code': 1 }))).toMatchObject({
      'feed.fontSize': 13,
      'ui.fontSize': 13,
      'font.code': '',
      'font.interface': '',
    });
    expect(readSettings(cfgOf({ 'feed.fontSize': 16 }))['feed.fontSize']).toBe(16);
    expect(readSettings(cfgOf({ 'ui.fontSize': 15 }))['ui.fontSize']).toBe(15);
  });
});

describe('язык интерфейса', () => {
  it('validateSetting: auto, ru, en', () => {
    expect(validateSetting('language', 'en')).toEqual({ ok: true, value: 'en' });
    expect(validateSetting('language', 'de').ok).toBe(false);
  });
  it('resolveLanguage', () => {
    expect(resolveLanguage('auto', 'ru')).toBe('ru');
    expect(resolveLanguage('auto', 'ru-RU')).toBe('ru');
    expect(resolveLanguage('auto', 'en-US')).toBe('en');
    expect(resolveLanguage('auto', 'de')).toBe('en');
    expect(resolveLanguage('en', 'ru')).toBe('en');
    expect(resolveLanguage('ru', 'en')).toBe('ru');
    expect(resolveLanguage(42, 'ru')).toBe('ru');
    expect(resolveLanguage(undefined, 'fr')).toBe('en');
  });
  it('readSettings: мусор → auto', () => {
    expect(readSettings(cfgOf({ language: 'xx' })).language).toBe('auto');
    expect(readSettings(cfgOf({ language: 'en' })).language).toBe('en');
  });
  it('readSettings: tasks.card — старые panel/strip читаются как tab (roadmap 20, решение 10)', () => {
    expect(readSettings(cfgOf({ 'tasks.card': 'panel' }))['tasks.card']).toBe('tab');
    expect(readSettings(cfgOf({ 'tasks.card': 'strip' }))['tasks.card']).toBe('tab');
    expect(readSettings(cfgOf({ 'tasks.card': 'split' }))['tasks.card']).toBe('split');
    expect(readSettings(cfgOf({ 'tasks.card': 7 }))['tasks.card']).toBe('tab');
    expect(readTaskCardMode('strip')).toBe('tab');
    expect(readTaskCardMode(undefined)).toBe('tab');
  });
});

describe('resolveDefaultMode / resolveDefaultEffort', () => {
  it('manual → default, acceptEdits и plan как есть', () => {
    expect(resolveDefaultMode('manual', false)).toBe('default');
    expect(resolveDefaultMode('acceptEdits', false)).toBe('acceptEdits');
    expect(resolveDefaultMode('plan', true)).toBe('plan');
    expect(resolveDefaultMode(undefined, false)).toBe('default');
  });
  it('bypass — только при allowBypassPermissions', () => {
    expect(resolveDefaultMode('bypassPermissions', false)).toBe('default');
    expect(resolveDefaultMode('bypassPermissions', true)).toBe('bypassPermissions');
  });
  it('effort: пусто и мусор — не задавать', () => {
    expect(resolveDefaultEffort('')).toBeUndefined();
    expect(resolveDefaultEffort('x')).toBeUndefined();
    expect(resolveDefaultEffort('max')).toBe('max');
  });
});

describe('composer.layout', () => {
  it('validateSetting: шесть раскладок, остальное — отказ', () => {
    for (const v of ['classic', 'card', 'statusline', 'gauges', 'minimal', 'shell']) {
      expect(validateSetting('composer.layout', v)).toEqual({ ok: true, value: v });
    }
    expect(validateSetting('composer.layout', 'grid').ok).toBe(false);
    expect(validateSetting('composer.layout', 1).ok).toBe(false);
  });
  it('readSettings: мусор и пусто — classic, нормальное значение читается', () => {
    expect(readSettings(cfgOf({ 'composer.layout': 'rows' }))['composer.layout']).toBe('classic');
    expect(readSettings(cfgOf({}))['composer.layout']).toBe('classic');
    expect(readSettings(cfgOf({ 'composer.layout': 'shell' }))['composer.layout']).toBe('shell');
  });
});

describe('readSettings', () => {
  it('мусор из settings.json заменяется значениями по умолчанию', () => {
    const v = readSettings(
      cfgOf({
        defaultPermissionMode: 'x',
        defaultEffort: 5,
        contextThresholds: 'a',
        usagePollMinutes: 'z',
        'sessionList.view': 'tree',
        'sessionList.context': 'x',
        'sidebar.top': 'mini',
        'sidebar.limits': 'grid',
        'tasks.sidebar': 'tree',
        'tasks.card': 'grid',
        'tasks.tab': 'split',
        'jira.source': 'x',
        'tasks.refresh': '1s',
        'feed.style': 'grid',
        'agents.view': 'map',
        'git.layout': 'rows',
      }),
    );
    expect(v).toMatchObject({
      'sessionList.view': 'compact',
      'sessionList.context': true,
      'sessionList.time': true,
      'sidebar.top': 'detailed',
      'sidebar.limits': 'active',
      'tasks.sidebar': 'groups',
      'tasks.card': 'tab',
      'tasks.tab': 'chat',
      'jira.source': 'auto',
      'tasks.refresh': '30s',
      'tasks.humanChanges': true,
      'jira.agentTools': { comment: true, transition: true, worklog: true },
      'feed.style': 'journal',
      'agents.view': 'list',
      'git.layout': 'stack',
      defaultPermissionMode: 'manual',
      defaultEffort: '',
      contextThresholds: [120_000, 150_000],
      usagePollMinutes: 15,
      allowBypassPermissions: false,
      'limits.readKeychain': true,
    });
  });
  it('кривые, но числовые пороги показываются как есть (ошибку покажет поле)', () => {
    expect(readSettings(cfgOf({ contextThresholds: [300, 100] })).contextThresholds).toEqual([
      300, 100,
    ]);
  });
});

describe('readSettings: движок', () => {
  it('по умолчанию claude; мусор заменяется значением по умолчанию', () => {
    expect(readSettings(cfgOf({})).defaultProvider).toBe('claude');
    expect(readSettings(cfgOf({ defaultProvider: 'codex' })).defaultProvider).toBe('codex');
    expect(readSettings(cfgOf({ defaultProvider: 'antigravity' })).defaultProvider).toBe('antigravity');
    expect(readSettings(cfgOf({ antigravityExecutable: '/x/agy' })).antigravityExecutable).toBe('/x/agy');
    expect(readSettings(cfgOf({ defaultProvider: 5 })).defaultProvider).toBe('claude');
    expect(readSettings(cfgOf({ codexExecutable: '/x/codex' })).codexExecutable).toBe('/x/codex');
  });
});

describe('overriddenKeys', () => {
  it('значение рабочей области перекрывает пользовательское; machine-ключи не считаются', () => {
    const cfg = {
      inspect: (k: string) =>
        k === 'defaultModel' || k === 'claudeExecutable' || k === 'codexExecutable' || k === 'antigravityExecutable' ? { workspaceValue: 'x' } : {},
    };
    expect(overriddenKeys(cfg)).toEqual(['defaultModel']);
  });
  it('вид списка сессий перекрывается настройкой рабочей области или папки', () => {
    const only = (i: object) => ({ inspect: (k: string) => (k === 'sessionList.view' ? i : {}) });
    expect(overriddenKeys(only({ workspaceValue: 'dense' }))).toEqual(['sessionList.view']);
    expect(overriddenKeys(only({ workspaceFolderValue: 'detailed' }))).toEqual([
      'sessionList.view',
    ]);
    expect(overriddenKeys(only({ globalValue: 'dense' }))).toEqual([]);
  });
});

describe('writeSetting', () => {
  const GLOBAL = Symbol('global');
  const mock = () => {
    const calls: [string, unknown, unknown][] = [];
    const cfg: ConfigLike = {
      get: () => undefined,
      update: async (k, v, t) => void calls.push([k, v, t]),
    };
    return { cfg, calls };
  };

  it('пишет в Global — и обычные, и machine-настройки', async () => {
    const { cfg, calls } = mock();
    await writeSetting(cfg, 'defaultModel', ' opus ', GLOBAL);
    await writeSetting(cfg, 'allowBypassPermissions', true, GLOBAL);
    await writeSetting(cfg, 'claudeExecutable', '/x/claude', GLOBAL);
    expect(calls).toEqual([
      ['defaultModel', 'opus', GLOBAL],
      ['allowBypassPermissions', true, GLOBAL],
      ['claudeExecutable', '/x/claude', GLOBAL],
    ]);
  });

  it('невалидное значение не пишется', async () => {
    const { cfg, calls } = mock();
    const r = await writeSetting(cfg, 'contextThresholds', [150_000, 120_000], GLOBAL);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('ошибки по языку', () => {
  it('validateSetting и thresholdsError отдают английский текст', () => {
    expect(validateSetting('usagePollMinutes', 1)).toEqual({ ok: false, error: 'Не меньше 5.' });
    expect(validateSetting('usagePollMinutes', 1, 'en')).toEqual({ ok: false, error: 'At least 5.' });
    expect(thresholdsError([100, 50], 'en')).toBe('The yellow threshold must be below the orange one.');
    expect(thresholdsError([100, 300_000], 'en')).toMatch(/below 200,000/);
  });
});
