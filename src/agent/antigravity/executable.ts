import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Результат поиска локального Antigravity CLI (`agy`). Минимальную версию не фиксируем: протокол снят на 1.2.17. */
export interface ResolvedAgyExecutable {
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
}

export interface ResolveAgyDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  runVersion?: (path: string) => Promise<string>;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
}

/** `1.2.17` или `agy 1.2.17` → `1.2.17`. */
export function parseAgyVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Где искать `agy`: PATH, затем `~/.local/bin` (туда ставит установщик), Homebrew. */
export function agyCandidatePaths(deps: ResolveAgyDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const win = (deps.platform ?? process.platform) === 'win32';
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir && isAbsolute(dir));
  dirs.push(join(deps.home ?? homedir(), '.local', 'bin'));
  if (!win) dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  const name = win ? 'agy.exe' : 'agy';
  return [...new Set(dirs.map((dir) => join(dir, name)))];
}

function defaultRun(timeoutMs = 5000) {
  return (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let done = false;
      const child = execFile(path, ['--version'], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout);
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(new Error(`${path} --version: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
}

/** Настройка важнее PATH; проверяем только реальным `agy --version`. Ошибки — про agy, не про другие движки. */
export async function resolveAgyExecutable(
  setting: string,
  deps: ResolveAgyDeps = {},
): Promise<ResolvedAgyExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.runVersion ?? defaultRun(deps.timeoutMs);
  const check = async (path: string, source: 'setting' | 'system'): Promise<ResolvedAgyExecutable | undefined> => {
    try {
      const version = parseAgyVersion(await run(path));
      return version ? { path, version, source } : undefined;
    } catch {
      return undefined;
    }
  };
  if (setting.trim()) {
    return (
      (await check(setting.trim(), 'setting')) ?? {
        path: setting.trim(),
        source: 'setting',
        problem: `agentura.antigravityExecutable: “${setting.trim()}” does not run (agy --version).`,
      }
    );
  }
  const found = (await Promise.all(agyCandidatePaths(deps).filter(exists).map((path) => check(path, 'system')))).find(Boolean);
  return found ?? { source: 'none', problem: AGY_NOT_FOUND };
}

export const AGY_NOT_FOUND = 'Antigravity CLI (agy) was not found.';
