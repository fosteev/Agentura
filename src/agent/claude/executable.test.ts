import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  candidatePaths,
  defaultRun,
  isShellScript,
  parseVersion,
  resolveExecutable,
  versionAtLeast,
} from './executable';

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

  it('настройка важнее поиска', async () => {
    const r = await resolveExecutable('/x/claude', {
      ...base,
      runVersion: () => Promise.resolve('2.1.290 (Claude Code)'),
    });
    expect(r).toMatchObject({ path: '/x/claude', version: '2.1.290', source: 'setting' });
    expect(r.problem).toBeUndefined();
  });

  it('настройка указывает на неработающий файл', async () => {
    const r = await resolveExecutable('/x/claude', {
      ...base,
      runVersion: () => Promise.reject(new Error('ENOENT')),
    });
    expect(r.path).toBe('/x/claude');
    expect(r.problem).toMatch(/не запускается/);
  });

  it('ищет по PATH, берёт первый рабочий', async () => {
    const r = await resolveExecutable('', {
      ...base,
      exists: (p) => p === '/b/claude' || p === '/h/.local/bin/claude',
      runVersion: () => Promise.resolve('2.1.285 (Claude Code)'),
    });
    expect(r).toMatchObject({ path: '/b/claude', source: 'system' });
  });

  it('относительные элементы PATH пропускаются', async () => {
    const seen: string[] = [];
    const r = await resolveExecutable('', {
      ...base,
      env: { PATH: ['.', 'bin', '', '/a'].join(':') },
      exists: (p) => (seen.push(p), true),
      runVersion: (p) => Promise.resolve(p.startsWith('/') ? '2.1.285 (Claude Code)' : 'boom'),
    });
    expect(r).toMatchObject({ path: '/a/claude', source: 'system' });
    expect(seen.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('старая версия — путь есть, проблема заполнена', async () => {
    const r = await resolveExecutable('', {
      ...base,
      exists: (p) => p === '/a/claude',
      runVersion: () => Promise.resolve('2.0.1 (Claude Code)'),
    });
    expect(r.path).toBe('/a/claude');
    expect(r.problem).toMatch(/2\.1\.285/);
  });

  it('не нашли — source none и подсказка', async () => {
    const r = await resolveExecutable('', { ...base, exists: () => false });
    expect(r.source).toBe('none');
    expect(r.path).toBeUndefined();
    expect(r.problem).toMatch(/Не найден/);
  });

  it('кандидаты по платформе: Windows — только claude.exe, остальные — claude', () => {
    const win = candidatePaths({
      // пути в стиле хоста тестов: `isAbsolute` и `join` берутся из его `node:path`
      env: { PATH: '/win/bin', APPDATA: '/win/u/AppData/Roaming' },
      home: '/win/u',
      platform: 'win32',
    });
    const names = win.map((p) => p.split(/[\\/]/).pop());
    expect(new Set(names)).toEqual(new Set(['claude.exe']));
    expect(win.some((p) => p.includes('npm'))).toBe(true);
    const mac = candidatePaths({ ...base });
    expect(mac.every((p) => p.endsWith('/claude'))).toBe(true);
    expect(mac).toContain('/opt/homebrew/bin/claude');
    expect(win.some((p) => p.includes('homebrew'))).toBe(false);
  });

  it('Windows: npm-обёртка .cmd не годится — подсказка про claude.exe, а не «не найден»', async () => {
    const win = {
      env: { PATH: '/win/bin' },
      home: '/win/u',
      platform: 'win32' as const,
      runVersion: () => Promise.resolve('2.1.285 (Claude Code)'),
    };
    const found = await resolveExecutable('', { ...win, exists: (p) => p.endsWith('claude.cmd') });
    expect(found.path).toBeUndefined();
    expect(found.problem).toMatch(/npm-обёртка.*claude\.exe/);
    const setting = await resolveExecutable('C:\\x\\CLAUDE.CMD', { ...win, exists: () => true });
    expect(setting.version).toBeUndefined();
    expect(setting.problem).toMatch(/npm-обёртка/);
    expect(isShellScript('C:\\x\\claude.exe', 'win32')).toBe(false);
    expect(isShellScript('/x/claude.cmd', 'darwin')).toBe(false);
  });

  it('кандидаты проверяются параллельно, выбор — по порядку списка, а не по скорости ответа', async () => {
    const r = await resolveExecutable('', {
      ...base,
      exists: () => true,
      runVersion: (p) =>
        p === '/a/claude'
          ? new Promise((resolve) => setTimeout(() => resolve('2.1.285 (Claude Code)'), 20))
          : Promise.resolve('2.1.285 (Claude Code)'),
    });
    expect(r.path).toBe('/a/claude');
  });

  it('реальный запуск: несуществующий путь из настройки', async () => {
    const r = await resolveExecutable('/nonexistent/claude', { timeoutMs: 200 });
    expect(r.problem).toMatch(/не запускается/);
  });

  it('реальный запуск: зависший кандидат убивается по таймауту, промис не ждёт его потоков', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentura-exe-'));
    const script = join(dir, 'claude');
    // внук держит stdout открытым: таймаут `execFile` ждал бы закрытия потоков
    writeFileSync(script, '#!/bin/sh\nsleep 5 &\nsleep 5\n');
    chmodSync(script, 0o755);
    const started = Date.now();
    try {
      await expect(defaultRun(200)(script)).rejects.toThrow(/нет ответа/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
