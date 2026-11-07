import { describe, expect, it, vi } from 'vitest';
import { EngineLocator } from '../../extension/engineLocator';
import {
  AGY_MIN_VERSION,
  AGY_NOT_FOUND,
  agyCandidatePaths,
  compareAgyVersions,
  parseAgyVersion,
  resolveAgyExecutable,
} from './executable';

const base = { env: { PATH: '/a:/b' }, home: '/h', platform: 'darwin' as const };

describe('agy executable', () => {
  it('версия из вывода; настройка важнее PATH', async () => {
    expect(parseAgyVersion('1.5.3\n')).toBe('1.5.3');
    expect(parseAgyVersion('broken')).toBeUndefined();
    await expect(
      resolveAgyExecutable('/custom/agy', { ...base, runVersion: async () => '1.5.3' }),
    ).resolves.toMatchObject({ path: '/custom/agy', version: '1.5.3', source: 'setting' });
  });

  it('кандидаты: абсолютные PATH, ~/.local/bin, Homebrew', async () => {
    const candidates = agyCandidatePaths({ ...base, env: { PATH: '.:bin:/a' } });
    expect(candidates).toEqual(['/a/agy', '/h/.local/bin/agy', '/opt/homebrew/bin/agy', '/usr/local/bin/agy']);
    const found = await resolveAgyExecutable('', {
      ...base,
      exists: (p) => p === '/h/.local/bin/agy',
      runVersion: async () => '1.5.3',
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

  it('сравнение версий по числам: 1.10.0 новее 1.9.0, минимум 1.5.0', () => {
    expect(AGY_MIN_VERSION).toBe('1.5.0');
    expect(compareAgyVersions('1.5.3', '1.5.0')).toBeGreaterThan(0);
    expect(compareAgyVersions('1.5.0', '1.5.0')).toBe(0);
    expect(compareAgyVersions('1.4.9', '1.5.0')).toBeLessThan(0);
    expect(compareAgyVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareAgyVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('agy старше 1.5.0: problem с найденной и минимальной версией, без version (движок не стартует)', async () => {
    const old = await resolveAgyExecutable('/old/agy', { ...base, runVersion: async () => 'agy 1.2.17\n' });
    expect(old).toMatchObject({ path: '/old/agy', source: 'setting' });
    expect(old.version).toBeUndefined();
    expect(old.problem).toMatch(/1\.2\.17/);
    expect(old.problem).toMatch(/1\.5\.0/);
    const edge = await resolveAgyExecutable('/edge/agy', { ...base, runVersion: async () => '1.4.9' });
    expect(edge.problem).toMatch(/1\.4\.9.*1\.5\.0/);
    await expect(resolveAgyExecutable('/min/agy', { ...base, runVersion: async () => '1.5.0' })).resolves.toMatchObject({
      version: '1.5.0',
    });
    const system = await resolveAgyExecutable('', {
      ...base,
      exists: (p) => p === '/h/.local/bin/agy',
      runVersion: async () => '1.3.0',
    });
    expect(system).toMatchObject({ path: '/h/.local/bin/agy', source: 'system' });
    expect(system.problem).toMatch(/1\.3\.0/);
  });

  it('старый agy в PATH не заслоняет подходящий в другом каталоге', async () => {
    const versions: Record<string, string> = { '/a/agy': '1.2.17', '/h/.local/bin/agy': '1.5.3' };
    const found = await resolveAgyExecutable('', {
      ...base,
      exists: (p) => p in versions,
      runVersion: async (p) => versions[p] ?? '',
    });
    expect(found).toMatchObject({ path: '/h/.local/bin/agy', version: '1.5.3', source: 'system' });
    expect(found.problem).toBeUndefined();
  });

  it('EngineLocator не запускает старый agy: ready() отдаёт problem, path() пуст', async () => {
    const locator = new EngineLocator({
      setting: () => '',
      resolve: (s) => resolveAgyExecutable(s, { ...base, exists: () => true, runVersion: async () => '1.2.17' }),
      name: 'agy',
      info: vi.fn(),
      warn: vi.fn(),
    });
    expect(await locator.path()).toBeUndefined();
    const ready = await locator.ready();
    expect(ready.ok).toBe(false);
    expect(ready.ok === false && ready.problem).toMatch(/1\.2\.17.*1\.5\.0/);
  });

  it('EngineLocator с резолвером agy: своё имя в журнале и своя ошибка', async () => {
    const info = vi.fn();
    const found = new EngineLocator({
      setting: () => '',
      resolve: () => Promise.resolve({ path: '/a/agy', version: '1.5.3', source: 'system' }),
      name: 'agy',
      info,
      warn: vi.fn(),
    });
    expect(await found.path()).toBe('/a/agy');
    expect(info).toHaveBeenCalledWith('agy: /a/agy 1.5.3 (system)');
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
