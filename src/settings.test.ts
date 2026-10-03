import { describe, expect, it } from 'vitest';
import {
  nextSessionListMode,
  overriddenKeys,
  readSettings,
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
    expect(validateSetting('feed.style', 'cards')).toEqual({ ok: true, value: 'cards' });
    expect(validateSetting('feed.style', 'grid').ok).toBe(false);
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
        'feed.style': 'grid',
      }),
    );
    expect(v).toMatchObject({
      'sessionList.view': 'compact',
      'sessionList.context': true,
      'sessionList.time': true,
      'sidebar.top': 'detailed',
      'feed.style': 'journal',
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

describe('overriddenKeys', () => {
  it('значение рабочей области перекрывает пользовательское; machine-ключи не считаются', () => {
    const cfg = {
      inspect: (k: string) =>
        k === 'defaultModel' || k === 'claudeExecutable' ? { workspaceValue: 'x' } : {},
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
