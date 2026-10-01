import { describe, expect, it } from 'vitest';
import { parseVersion, resolveExecutable, versionAtLeast } from './executable';

const base = { env: { PATH: '/a:/b' }, home: '/h', platform: 'darwin' as const };

describe('executable', () => {
  it('parseVersion и versionAtLeast', () => {
    expect(parseVersion('2.1.285 (Claude Code)')).toBe('2.1.285');
    expect(parseVersion('boom')).toBeUndefined();
    expect(versionAtLeast('2.1.285', '2.1.285')).toBe(true);
    expect(versionAtLeast('2.1.300', '2.1.285')).toBe(true);
    expect(versionAtLeast('2.0.999', '2.1.285')).toBe(false);
    expect(versionAtLeast('10.0.0', '2.1.285')).toBe(true);
  });

  it('настройка важнее поиска', () => {
    const r = resolveExecutable('/x/claude', {
      ...base,
      runVersion: () => '2.1.290 (Claude Code)',
    });
    expect(r).toMatchObject({ path: '/x/claude', version: '2.1.290', source: 'setting' });
    expect(r.problem).toBeUndefined();
  });

  it('настройка указывает на неработающий файл', () => {
    const r = resolveExecutable('/x/claude', {
      ...base,
      runVersion: () => {
        throw new Error('ENOENT');
      },
    });
    expect(r.path).toBe('/x/claude');
    expect(r.problem).toMatch(/не запускается/);
  });

  it('ищет по PATH, берёт первый рабочий', () => {
    const r = resolveExecutable('', {
      ...base,
      exists: (p) => p === '/b/claude' || p === '/h/.local/bin/claude',
      runVersion: () => '2.1.285 (Claude Code)',
    });
    expect(r).toMatchObject({ path: '/b/claude', source: 'system' });
  });

  it('относительные элементы PATH пропускаются', () => {
    const seen: string[] = [];
    const r = resolveExecutable('', {
      ...base,
      env: { PATH: ['.', 'bin', '', '/a'].join(':') },
      exists: (p) => (seen.push(p), true),
      runVersion: (p) => (p.startsWith('/') ? '2.1.285 (Claude Code)' : 'boom'),
    });
    expect(r).toMatchObject({ path: '/a/claude', source: 'system' });
    expect(seen.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('старая версия — путь есть, проблема заполнена', () => {
    const r = resolveExecutable('', {
      ...base,
      exists: (p) => p === '/a/claude',
      runVersion: () => '2.0.1 (Claude Code)',
    });
    expect(r.path).toBe('/a/claude');
    expect(r.problem).toMatch(/2\.1\.285/);
  });

  it('не нашли — source none и подсказка', () => {
    const r = resolveExecutable('', { ...base, exists: () => false });
    expect(r.source).toBe('none');
    expect(r.path).toBeUndefined();
    expect(r.problem).toMatch(/Не найден/);
  });
});
