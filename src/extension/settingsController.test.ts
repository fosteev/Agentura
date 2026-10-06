import { describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../protocol';
import type { ConfigLike } from '../settings';
import { SettingsController, type SettingsDeps } from './settingsController';

const GLOBAL = 1; // ConfigurationTarget.Global

function setup(values: Record<string, unknown> = {}, over: Partial<SettingsDeps> = {}) {
  const store = { ...values };
  const updates: { key: string; value: unknown; target: unknown }[] = [];
  const posted: ToWebview[] = [];
  const config: ConfigLike = {
    get: <T>(k: string) => store[k] as T,
    update: async (key, value, target) => {
      updates.push({ key, value, target });
      store[key] = value;
    },
  };
  const deps: SettingsDeps = {
    config: () => config,
    globalTarget: GLOBAL,
    post: (m) => posted.push(m),
    checkEngine: vi.fn(() =>
      Promise.resolve({
        ok: true,
        source: 'system' as const,
        path: '/b/claude',
        version: '2.1.285',
      }),
    ),
    reveal: vi.fn(),
    warn: vi.fn(),
    ...over,
  };
  return { c: new SettingsController(deps), updates, posted, deps };
}

describe('SettingsController', () => {
  it('ready: отдаёт текущие значения', async () => {
    const { c, posted } = setup({ defaultModel: 'opus', allowBypassPermissions: true });
    await c.handle({ type: 'ready' });
    expect(posted).toEqual([
      expect.objectContaining({
        type: 'settings.state',
        values: expect.objectContaining({ defaultModel: 'opus', allowBypassPermissions: true }),
        overridden: [],
      }),
    ]);
  });

  it('settings.set: запись в Global (machine-настройка и обычная), затем свежее состояние', async () => {
    const { c, updates, posted } = setup();
    await c.handle({ type: 'settings.set', key: 'allowBypassPermissions', value: true });
    await c.handle({ type: 'settings.set', key: 'defaultEffort', value: 'high' });
    expect(updates).toEqual([
      { key: 'allowBypassPermissions', value: true, target: GLOBAL },
      { key: 'defaultEffort', value: 'high', target: GLOBAL },
    ]);
    const last = posted.at(-1);
    expect(last).toMatchObject({
      type: 'settings.state',
      values: { allowBypassPermissions: true, defaultEffort: 'high' },
    });
  });

  it('режим «без разрешений» по умолчанию не пишется, пока bypass не разрешён', async () => {
    const off = setup();
    await off.c.handle({
      type: 'settings.set',
      key: 'defaultPermissionMode',
      value: 'bypassPermissions',
    });
    expect(off.updates).toEqual([]);
    expect(off.posted).toEqual([
      expect.objectContaining({ type: 'settings.error', key: 'defaultPermissionMode' }),
    ]);

    const on = setup({ allowBypassPermissions: true });
    await on.c.handle({
      type: 'settings.set',
      key: 'defaultPermissionMode',
      value: 'bypassPermissions',
    });
    expect(on.updates).toEqual([
      { key: 'defaultPermissionMode', value: 'bypassPermissions', target: GLOBAL },
    ]);
  });

  it('невалидные пороги: запись не идёт, ошибка уходит в поле', async () => {
    const { c, updates, posted } = setup();
    await c.handle({ type: 'settings.set', key: 'contextThresholds', value: [150_000, 120_000] });
    await c.handle({ type: 'settings.set', key: 'contextThresholds', value: [120_000, 200_000] });
    expect(updates).toEqual([]);
    expect(posted).toEqual([
      expect.objectContaining({ type: 'settings.error', key: 'contextThresholds' }),
      expect.objectContaining({ type: 'settings.error', key: 'contextThresholds' }),
    ]);
  });

  it('чужой ключ из webview не пишется', async () => {
    const { c, updates, deps } = setup();
    await c.handle({ type: 'settings.set', key: 'editor.fontSize' as never, value: 99 });
    expect(updates).toEqual([]);
    expect(deps.warn).toHaveBeenCalled();
  });

  it('сбой записи — ошибка у поля, не исключение', async () => {
    const { c, posted } = setup(
      {},
      {
        config: () => ({
          get: () => undefined,
          update: () => Promise.reject(new Error('read-only')),
        }),
      },
    );
    await c.handle({ type: 'settings.set', key: 'defaultModel', value: 'x' });
    expect(posted[0]).toMatchObject({ type: 'settings.error', key: 'defaultModel' });
  });

  it('checkEngine: тот же поиск, что при старте, результат в webview', async () => {
    const { c, posted, deps } = setup();
    await c.handle({ type: 'settings.checkEngine', path: '' });
    expect(deps.checkEngine).toHaveBeenCalledWith('', 'claude');
    expect(posted[0]).toMatchObject({
      type: 'settings.engine',
      result: { ok: true, version: '2.1.285' },
    });
  });

  it('checkEngine: для Antigravity проверяет agy и помечает ответ', async () => {
    const { c, posted, deps } = setup();
    await c.handle({ type: 'settings.checkEngine', path: '/x/agy', engine: 'antigravity' });
    expect(deps.checkEngine).toHaveBeenCalledWith('/x/agy', 'antigravity');
    expect(posted[0]).toMatchObject({ type: 'settings.engine', engine: 'antigravity' });
  });

  it('checkEngine: исключение проверки — ответ с ошибкой, кнопка не остаётся в «проверяю»', async () => {
    const { c, posted, deps } = setup();
    vi.mocked(deps.checkEngine).mockRejectedValueOnce(new Error('boom'));
    await c.handle({ type: 'settings.checkEngine', path: '/x/agy', engine: 'antigravity' });
    expect(posted[0]).toMatchObject({ type: 'settings.engine', engine: 'antigravity', result: { ok: false } });
  });

  it('checkEngine: ответ устаревшей проверки не перебивает последнюю', async () => {
    const slow = { ok: false, source: 'setting' as const, problem: 'старая' };
    const fast = { ok: true, source: 'system' as const, path: '/b/claude', version: '2.1.285' };
    const { c, posted } = setup(
      {},
      {
        checkEngine: (path: string) =>
          path === '/old'
            ? new Promise((r) => setTimeout(() => r(slow), 20))
            : Promise.resolve(fast),
      },
    );
    await Promise.all([
      c.handle({ type: 'settings.checkEngine', path: '/old' }),
      c.handle({ type: 'settings.checkEngine', path: '' }),
    ]);
    expect(posted).toEqual([{ type: 'settings.engine', result: fast }]);
  });

  it('reveal: ui и json', async () => {
    const { c, deps } = setup();
    await c.handle({ type: 'settings.reveal', target: 'json' });
    await c.handle({ type: 'settings.reveal', target: 'ui' });
    expect(deps.reveal).toHaveBeenNthCalledWith(1, 'json');
    expect(deps.reveal).toHaveBeenNthCalledWith(2, 'ui');
  });

  it('fonts.add / fonts.remove: передаёт хосту kind и имя; мусор — нет', async () => {
    const addFont = vi.fn();
    const removeFont = vi.fn();
    const { c } = setup({}, { addFont, removeFont });
    await c.handle({ type: 'fonts.add', kind: 'code' });
    await c.handle({ type: 'fonts.add', kind: 'ui' });
    await c.handle({ type: 'fonts.add', kind: 'panels' });
    await c.handle({ type: 'fonts.remove', family: 'Onest' });
    await c.handle({ type: 'fonts.remove', family: 5 as unknown as string });
    expect(addFont.mock.calls).toEqual([['code'], ['ui'], ['panels']]);
    expect(removeFont.mock.calls).toEqual([['Onest']]);
  });

  it('pushState после правки снаружи (onDidChangeConfiguration) показывает новое значение', () => {
    const { c, posted } = setup({ usagePollMinutes: 30 });
    c.pushState();
    expect(posted[0]).toMatchObject({ values: { usagePollMinutes: 30 } });
  });
});
