import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { parseCursorVersion } from './protocol';

/** `problem` резолвера, когда Cursor CLI не найден (хост подменяет текст локализованным). */
export const CURSOR_NOT_FOUND = 'Cursor CLI (agent) was not found.';

export interface ResolvedCursorExecutable {
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
}

export interface ResolveCursorDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** stdout команды. Бросок — бинарник не ответил. */
  run?: (path: string, args: readonly string[]) => Promise<string>;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
}

function candidateDirs(env: NodeJS.ProcessEnv, home: string, win: boolean): string[] {
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir && isAbsolute(dir));
  dirs.push(join(home, '.local', 'bin'));
  if (win) {
    const appData = env.APPDATA;
    if (appData && isAbsolute(appData)) dirs.push(join(appData, 'npm'));
  } else dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs;
}

/**
 * Где искать `agent`. На Windows — только `agent.exe`: `.cmd`/`.bat` без оболочки не запускаем
 * (`shell: true` для движка не включаем).
 */
export function cursorCandidatePaths(deps: ResolveCursorDeps = {}): string[] {
  const win = (deps.platform ?? process.platform) === 'win32';
  const name = win ? 'agent.exe' : 'agent';
  return [
    ...new Set(
      candidateDirs(deps.env ?? process.env, deps.home ?? homedir(), win).map((dir) => join(dir, name)),
    ),
  ];
}

/** `.cmd`/`.bat` на Windows не принимаем, даже если путь задан явно. */
export function isCursorShellScript(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(path.trim());
}

const shellProblem = (path: string) =>
  `${path} is a Windows shell script (.cmd/.bat). Agentura starts Cursor only as agent.exe, without a shell.`;

function defaultRun(timeoutMs = 5000) {
  return (path: string, args: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      let done = false;
      const child = execFile(
        path,
        [...args],
        { encoding: 'utf8', windowsHide: true, shell: false },
        (error, stdout) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(stdout);
        },
      );
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(new Error(`${path} ${args.join(' ')}: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
}

/**
 * Настройка важнее PATH. Имя `agent` принимаем только если `--version` или `about`
 * печатает штамп Cursor (`2026.11.05-86047df`). Чужой `agent` — «не найден», процесс `acp` не стартует.
 */
export async function resolveCursorExecutable(
  setting: string,
  deps: ResolveCursorDeps = {},
): Promise<ResolvedCursorExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? defaultRun(deps.timeoutMs);
  const platform = deps.platform ?? process.platform;
  const identify = async (path: string): Promise<string | undefined> => {
    for (const args of [['--version'], ['about']] as const) {
      try {
        const version = parseCursorVersion(await run(path, args));
        if (version) return version;
      } catch {
        // следующая команда: `--version` чужого бинарника может упасть, `about` — нет
      }
    }
    return undefined;
  };
  const check = async (
    path: string,
    source: 'setting' | 'system',
  ): Promise<ResolvedCursorExecutable | undefined> => {
    const version = await identify(path);
    return version ? { path, version, source } : undefined;
  };
  if (setting.trim()) {
    const path = setting.trim();
    if (isCursorShellScript(path, platform)) return { path, source: 'setting', problem: shellProblem(path) };
    return (
      (await check(path, 'setting')) ?? {
        path,
        source: 'setting',
        problem: `agentura.cursorExecutable: “${path}” is not the Cursor CLI (agent --version / agent about).`,
      }
    );
  }
  const candidates = cursorCandidatePaths(deps).filter(exists);
  const found = (await Promise.all(candidates.map((path) => check(path, 'system')))).find(Boolean);
  if (found) return found;
  return { source: 'none', problem: CURSOR_NOT_FOUND };
}
