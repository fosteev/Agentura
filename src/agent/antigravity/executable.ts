import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Минимальная версия `agy`: `agy acp` (ACP-сервер) появился в 1.5.0, контракт снят на 1.5.3. */
export const AGY_MIN_VERSION = '1.5.0';

/** Результат поиска локального Antigravity CLI (`agy`). Версия ниже `AGY_MIN_VERSION` — `problem` без `version`: движок не запускается. */
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

/** `1.5.3` против `1.5.0`: отрицательное — `a` старше `b`. Сравнение по числам, не по строкам (`1.10.0` > `1.9.0`). */
export function compareAgyVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function agyTooOldMessage(found: string): string {
  return `agy ${found} is too old: Agentura needs agy >= ${AGY_MIN_VERSION} (agy acp). Update the Antigravity CLI.`;
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
      if (!version) return undefined;
      // старый agy не запускаем: без `version` локатор не считает его годным, а `problem` называет найденную и минимальную версии
      if (compareAgyVersions(version, AGY_MIN_VERSION) < 0) return { path, source, problem: agyTooOldMessage(version) };
      return { path, version, source };
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
  const found = await Promise.all(agyCandidatePaths(deps).filter(exists).map((path) => check(path, 'system')));
  // подходящий agy важнее первого найденного старого
  return found.find((r) => r?.version) ?? found.find(Boolean) ?? { source: 'none', problem: AGY_NOT_FOUND };
}

export const AGY_NOT_FOUND = 'Antigravity CLI (agy) was not found.';

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** Очищает одну строку вывода `agy` от ANSI-последовательностей и промежуточных кадров `\r`-спиннера. */
export function stripAgySpinnerLine(rawLine: string): string {
  return rawLine.replace(ANSI_ESCAPE_RE, '').replace(/\r$/, '').split('\r').pop() ?? '';
}
