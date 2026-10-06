import { describe, expect, it, vi } from 'vitest';
import { EngineLocator } from '../../extension/engineLocator';
import { AGY_NOT_FOUND, agyCandidatePaths, parseAgyVersion, resolveAgyExecutable } from './executable';

const base = { env: { PATH: '/a:/b' }, home: '/h', platform: 'darwin' as const };

describe('agy executable', () => {
  it('версия из вывода; настройка важнее PATH', async () => {
    expect(parseAgyVersion('1.2.17\n')).toBe('1.2.17');
    expect(parseAgyVersion('broken')).toBeUndefined();
    await expect(
      resolveAgyExecutable('/custom/agy', { ...base, runVersion: async () => '1.2.17' }),
    ).resolves.toMatchObject({ path: '/custom/agy', version: '1.2.17', source: 'setting' });
  });

  it('кандидаты: абсолютные PATH, ~/.local/bin, Homebrew', async () => {
    const candidates = agyCandidatePaths({ ...base, env: { PATH: '.:bin:/a' } });
    expect(candidates).toEqual(['/a/agy', '/h/.local/bin/agy', '/opt/homebrew/bin/agy', '/usr/local/bin/agy']);
    const found = await resolveAgyExecutable('', {
      ...base,
      exists: (p) => p === '/h/.local/bin/agy',
      runVersion: async () => '1.2.17',
    });
    expect(found).toMatchObject({ path: '/h/.local/bin/agy', source: 'system' });
    expect(agyCandidatePaths({ ...base, platform: 'win32' })[0]).toMatch(/agy\.exe$/);
  });

  it('ошибки про agy: не найден и не запускается', async () => {
    await expect(resolveAgyExecutable('', { ...base, exists: () => false })).resolves.toEqual({
      source: 'none',
      problem: AGY_NOT_FOUND,
    });
    const broken = await resolveAgyExecutable('/bad/agy', {
      ...base,
      runVersion: async () => {
        throw new Error('EACCES');
      },
    });
    expect(broken.problem).toMatch(/antigravityExecutable.*does not run \(agy --version\)/);
  });

  it('EngineLocator с резолвером agy: своё имя в журнале и своя ошибка', async () => {
    const info = vi.fn();
    const found = new EngineLocator({
      setting: () => '',
      resolve: () => Promise.resolve({ path: '/a/agy', version: '1.2.17', source: 'system' }),
      name: 'agy',
      info,
      warn: vi.fn(),
    });
    expect(await found.path()).toBe('/a/agy');
    expect(info).toHaveBeenCalledWith('agy: /a/agy 1.2.17 (system)');
    const missing = new EngineLocator({
      setting: () => '',
      resolve: (s) => resolveAgyExecutable(s, { ...base, exists: () => false }),
      name: 'agy',
      notFound: AGY_NOT_FOUND,
      info,
      warn: vi.fn(),
    });
    expect(await missing.ready()).toEqual({ ok: false, problem: AGY_NOT_FOUND });
  });
});
