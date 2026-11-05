import { describe, expect, it } from 'vitest';
import { CURSOR_NOT_FOUND, cursorCandidatePaths, resolveCursorExecutable } from './executable';

const base = { env: { PATH: '/a:/b' }, home: '/h', platform: 'darwin' as const };
const STAMP = '2026.11.05-86047df';

describe('Cursor executable', () => {
  it('принимает agent, если --version печатает штамп Cursor, и берёт настройку раньше PATH', async () => {
    const calls: string[][] = [];
    await expect(
      resolveCursorExecutable('/custom/agent', {
        ...base,
        run: async (path, args) => {
          calls.push([path, ...args]);
          return STAMP;
        },
      }),
    ).resolves.toMatchObject({ path: '/custom/agent', version: STAMP, source: 'setting' });
    expect(calls).toEqual([['/custom/agent', '--version']]);
  });

  it('если --version молчит, опознаёт Cursor по about', async () => {
    const calls: string[][] = [];
    const result = await resolveCursorExecutable('/custom/agent', {
      ...base,
      run: async (path, args) => {
        calls.push([path, ...args]);
        if (args[0] === '--version') return 'huh';
        return `Cursor Agent\nCLI Version ${STAMP}\n`;
      },
    });
    expect(result).toMatchObject({ path: '/custom/agent', version: STAMP, source: 'setting' });
    expect(calls.map((c) => c[1])).toEqual(['--version', 'about']);
  });

  it('чужой agent в PATH — не найден, acp не запускается', async () => {
    const result = await resolveCursorExecutable('', {
      ...base,
      exists: (path) => path === '/a/agent',
      run: async () => 'agent 1.2.3',
    });
    expect(result).toEqual({ source: 'none', problem: CURSOR_NOT_FOUND });
    expect(cursorCandidatePaths({ ...base, env: { PATH: '.:bin:/a' } })).toContain('/a/agent');
    expect(cursorCandidatePaths({ ...base, env: { PATH: '.:bin:/a' } })).not.toContain('agent');
  });

  it('явный путь без штампа Cursor — ошибка, не «запускай как есть»', async () => {
    await expect(
      resolveCursorExecutable('/opt/agent', { ...base, run: async () => 'npm agent 9' }),
    ).resolves.toMatchObject({
      source: 'setting',
      path: '/opt/agent',
      problem: expect.stringMatching(/not the Cursor CLI/),
    });
  });

  it('Windows: .cmd и .bat не принимаются', async () => {
    const win = { env: { PATH: 'C:\\npm' }, home: 'C:\\Users\\u', platform: 'win32' as const };
    await expect(
      resolveCursorExecutable('C:\\npm\\agent.cmd', {
        ...win,
        run: async () => STAMP,
      }),
    ).resolves.toMatchObject({ source: 'setting', problem: expect.stringMatching(/\.cmd\/\.bat/) });
    await expect(
      resolveCursorExecutable('C:\\npm\\agent.bat', { ...win, run: async () => STAMP }),
    ).resolves.toMatchObject({ source: 'setting', problem: expect.stringMatching(/\.cmd\/\.bat/) });
    const paths = cursorCandidatePaths({ ...win, exists: () => true });
    expect(paths.some((p) => p.endsWith('agent.exe'))).toBe(true);
    expect(paths.some((p) => /\.(cmd|bat)$/i.test(p))).toBe(false);
  });
});
