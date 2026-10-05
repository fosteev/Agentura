import { describe, expect, it } from 'vitest';
import { codexCandidatePaths, parseCodexVersion, resolveCodexExecutable } from './executable';

const base = { env: { PATH: '/a:/b' }, home: '/h', platform: 'darwin' as const };

describe('Codex executable', () => {
  it('проверяет codex --version и берёт явную настройку раньше PATH', async () => {
    expect(parseCodexVersion('codex-cli 0.160.0')).toBe('0.160.0');
    expect(parseCodexVersion('broken')).toBeUndefined();
    await expect(
      resolveCodexExecutable('/custom/codex', {
        ...base,
        runVersion: async () => 'codex-cli 0.160.0',
      }),
    ).resolves.toMatchObject({ path: '/custom/codex', version: '0.160.0', source: 'setting' });
  });

  it('ищет только абсолютные PATH-кандидаты и не фиксирует минимальную версию', async () => {
    const candidates = codexCandidatePaths({ ...base, env: { PATH: '.:bin:/a' } });
    expect(candidates).toContain('/a/codex');
    expect(candidates).not.toContain('codex');
    expect(candidates.every((p) => p.startsWith('/'))).toBe(true);
    const result = await resolveCodexExecutable('', {
      ...base,
      exists: (path) => path === '/b/codex',
      runVersion: async () => 'codex-cli 0.1.0',
    });
    expect(result).toMatchObject({ path: '/b/codex', version: '0.1.0', source: 'system' });
  });

  it('даёт различимые ошибки для отсутствующего и сломанного пути', async () => {
    await expect(
      resolveCodexExecutable('', { ...base, exists: () => false }),
    ).resolves.toMatchObject({
      source: 'none',
      problem: expect.stringMatching(/not found/),
    });
    await expect(
      resolveCodexExecutable('/broken/codex', {
        ...base,
        runVersion: async () => Promise.reject(new Error('ENOENT')),
      }),
    ).resolves.toMatchObject({
      source: 'setting',
      path: '/broken/codex',
      problem: expect.stringMatching(/does not run/),
    });
  });

  it('Windows: npm-обёртка codex.cmd не принимается — подсказка вместо «не найден»', async () => {
    const win = { env: { PATH: 'C:\\npm' }, home: 'C:\\Users\\u', platform: 'win32' as const };
    await expect(
      resolveCodexExecutable('C:\\npm\\codex.cmd', { ...win, runVersion: async () => 'codex-cli 0.160.0' }),
    ).resolves.toMatchObject({ source: 'setting', problem: expect.stringMatching(/npm wrapper/) });
    const r = await resolveCodexExecutable('', {
      ...win,
      exists: (p) => p.endsWith('codex.cmd'),
      runVersion: async () => 'codex-cli 0.160.0',
    });
    expect(r).toMatchObject({ source: 'none', problem: expect.stringMatching(/npm wrapper/) });
  });
});
