import { describe, expect, it } from 'vitest';
import {
  KIMI_MIN_VERSION,
  KIMI_NOT_FOUND,
  compareKimiVersions,
  kimiCandidatePaths,
  parseKimiVersion,
  resolveKimiExecutable,
} from './executable';

const base = { env: { PATH: '/a:/b' }, home: '/h', platform: 'darwin' as const };

describe('kimi executable', () => {
  it('accepts the real version form and gives the machine setting priority', async () => {
    expect(parseKimiVersion('2.6.0\n')).toBe('2.6.0');
    expect(parseKimiVersion('Kimi Code CLI 2.7.1')).toBe('2.7.1');
    expect(parseKimiVersion('git version 2.50.1')).toBeUndefined();
    expect(parseKimiVersion('broken')).toBeUndefined();
    await expect(resolveKimiExecutable('/custom/kimi', { ...base, runVersion: async () => '2.6.0' }))
      .resolves.toMatchObject({ path: '/custom/kimi', version: '2.6.0', source: 'setting' });
  });

  it('searches PATH, ~/.kimi-code/bin, ~/.local/bin and Homebrew', async () => {
    expect(kimiCandidatePaths({ ...base, env: { PATH: '.:bin:/a' } })).toEqual([
      '/a/kimi',
      '/h/.kimi-code/bin/kimi',
      '/h/.local/bin/kimi',
      '/opt/homebrew/bin/kimi',
      '/usr/local/bin/kimi',
    ]);
    const found = await resolveKimiExecutable('', {
      ...base,
      exists: (path) => path === '/h/.kimi-code/bin/kimi',
      runVersion: async () => '2.6.0',
    });
    expect(found).toMatchObject({ path: '/h/.kimi-code/bin/kimi', source: 'system' });
    expect(kimiCandidatePaths({ ...base, platform: 'win32' })[0]).toMatch(/kimi\.exe$/);
  });

  it('distinguishes missing, old and wrong binaries', async () => {
    await expect(resolveKimiExecutable('', { ...base, exists: () => false })).resolves.toMatchObject({
      source: 'none', reason: 'missing', problem: KIMI_NOT_FOUND,
    });
    const old = await resolveKimiExecutable('/old/kimi', { ...base, runVersion: async () => '2.5.9' });
    expect(old).toMatchObject({ reason: 'old', path: '/old/kimi' });
    expect(old.version).toBeUndefined();
    expect(old.problem).toMatch(/2\.5\.9.*2\.6\.0/);
    const wrong = await resolveKimiExecutable('/bad/kimi', { ...base, runVersion: async () => 'git version 2.50.1' });
    expect(wrong).toMatchObject({ reason: 'wrong', path: '/bad/kimi' });
    expect(wrong.problem).toMatch(/kimiExecutable.*not Kimi Code CLI/);
    expect(KIMI_MIN_VERSION).toBe('2.6.0');
    expect(compareKimiVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(compareKimiVersions('2.6.0', '2.6.0')).toBe(0);
  });

  it('an old or wrong PATH binary does not hide a valid installation', async () => {
    const outputs: Record<string, string> = {
      '/a/kimi': 'git version 2.50.1',
      '/h/.kimi-code/bin/kimi': '2.5.0',
      '/h/.local/bin/kimi': '2.6.0',
    };
    const found = await resolveKimiExecutable('', {
      ...base,
      exists: (path) => path in outputs,
      runVersion: async (path) => outputs[path] ?? '',
    });
    expect(found).toMatchObject({ path: '/h/.local/bin/kimi', version: '2.6.0' });
  });
});
