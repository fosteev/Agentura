import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Первый релиз, чей ACP-контракт подтверждён спайком roadmap 39. */
export const KIMI_MIN_VERSION = '2.6.0';
export const KIMI_NOT_FOUND = 'Kimi Code CLI (kimi) was not found.';

export type KimiExecutableProblem = 'missing' | 'old' | 'wrong';

export interface ResolvedKimiExecutable {
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
  reason?: KimiExecutableProblem;
}

export interface ResolveKimiDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  runVersion?: (path: string) => Promise<string>;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
}

/** `kimi --version` 2.6.0 печатает только версию; слово `kimi` тоже допускается, чужой `git version …` — нет. */
export function parseKimiVersion(output: string): string | undefined {
  return /^(?:(?:kimi(?:\s+code)?(?:\s+cli)?)\s*,?\s*(?:version\s+)?)?v?(\d+\.\d+\.\d+)$/i
    .exec(output.trim())?.[1];
}

export function compareKimiVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function kimiTooOldMessage(found: string): string {
  return `kimi ${found} is too old: Agentura needs kimi >= ${KIMI_MIN_VERSION} (kimi acp). Update Kimi Code CLI.`;
}

function wrongBinaryMessage(path: string, setting: boolean): string {
  return setting
    ? `agentura.kimiExecutable: “${path}” is not Kimi Code CLI (kimi --version).`
    : `${path} is not Kimi Code CLI (kimi --version).`;
}

/** PATH, каталог штатного установщика, ~/.local/bin и Homebrew. Относительные PATH-каталоги не используются. */
export function kimiCandidatePaths(deps: ResolveKimiDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const win = (deps.platform ?? process.platform) === 'win32';
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir && isAbsolute(dir));
  dirs.push(join(home, '.kimi-code', 'bin'), join(home, '.local', 'bin'));
  if (!win) dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  const name = win ? 'kimi.exe' : 'kimi';
  return [...new Set(dirs.map((dir) => join(dir, name)))];
}

function defaultRun(timeoutMs = 5000) {
  return (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let done = false;
      const child = execFile(path, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false }, (error, stdout) => {
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

/** Явная machine-настройка важнее PATH. Старый или чужой бинарник никогда не запускается как `kimi acp`. */
export async function resolveKimiExecutable(
  setting: string,
  deps: ResolveKimiDeps = {},
): Promise<ResolvedKimiExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.runVersion ?? defaultRun(deps.timeoutMs);
  const check = async (path: string, source: 'setting' | 'system'): Promise<ResolvedKimiExecutable> => {
    let version: string | undefined;
    try {
      version = parseKimiVersion(await run(path));
    } catch {
      // wrong ниже
    }
    if (!version) return { path, source, reason: 'wrong', problem: wrongBinaryMessage(path, source === 'setting') };
    if (compareKimiVersions(version, KIMI_MIN_VERSION) < 0) {
      return { path, source, reason: 'old', problem: kimiTooOldMessage(version) };
    }
    return { path, version, source };
  };

  if (setting.trim()) return check(setting.trim(), 'setting');
  const found = await Promise.all(kimiCandidatePaths(deps).filter(exists).map((path) => check(path, 'system')));
  return found.find((r) => r.version) ??
    found.find((r) => r.reason === 'old') ??
    found[0] ?? { source: 'none', reason: 'missing', problem: KIMI_NOT_FOUND };
}
