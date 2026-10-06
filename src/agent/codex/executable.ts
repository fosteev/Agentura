import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** `problem` резолвера, когда `codex` не найден вообще (хост подменяет его локализованным текстом). */
export const CODEX_NOT_FOUND = 'Codex CLI (codex) was not found.';

/** Результат поиска локального Codex CLI. Минимальную версию намеренно не фиксируем: app-server experimental. */
export interface ResolvedCodexExecutable {
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
}

export interface ResolveCodexDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  runVersion?: (path: string) => Promise<string>;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
}

/** `codex-cli 0.160.0` → `0.160.0`. */
export function parseCodexVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
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
 * Где искать `codex`. На Windows — только `codex.exe`: npm-обёртку `codex.cmd` без оболочки Node не запустит
 * (EINVAL, Node ≥ 18.20.2), а `shell: true` для движка не включаем — тот же подход, что у Claude.
 */
export function codexCandidatePaths(deps: ResolveCodexDeps = {}): string[] {
  const win = (deps.platform ?? process.platform) === 'win32';
  const name = win ? 'codex.exe' : 'codex';
  return [
    ...new Set(
      candidateDirs(deps.env ?? process.env, deps.home ?? homedir(), win).map((dir) =>
        join(dir, name),
      ),
    ),
  ];
}

/** `.cmd`/`.bat`: на Windows без оболочки не запускаются, Agentura их не принимает. */
export function isCodexShellScript(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(path.trim());
}

const wrapperProblem = (path: string) =>
  `${path} is an npm wrapper (.cmd) that cannot be started without a shell. ` +
  'Set agentura.codexExecutable to codex.exe (inside the npm package: node_modules/@openai/codex/vendor/…/codex.exe).';

/** npm-обёртки `codex.cmd` на Windows: найдены — подсказка вместо «не найден». */
function windowsWrappers(deps: ResolveCodexDeps, exists: (p: string) => boolean): string[] {
  if ((deps.platform ?? process.platform) !== 'win32') return [];
  const dirs = candidateDirs(deps.env ?? process.env, deps.home ?? homedir(), true);
  return [...new Set(dirs.map((d) => join(d, 'codex.cmd')))].filter((p) => exists(p));
}

function defaultRun(timeoutMs = 5000) {
  return (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let done = false;
      const child = execFile(
        path,
        ['--version'],
        { encoding: 'utf8', windowsHide: true },
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
        reject(new Error(`${path} --version: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
}

/** Настройка важнее PATH; проверяем только реальным `codex --version`. */
export async function resolveCodexExecutable(
  setting: string,
  deps: ResolveCodexDeps = {},
): Promise<ResolvedCodexExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.runVersion ?? defaultRun(deps.timeoutMs);
  const check = async (
    path: string,
    source: 'setting' | 'system',
  ): Promise<ResolvedCodexExecutable | undefined> => {
    try {
      const version = parseCodexVersion(await run(path));
      return version ? { path, version, source } : undefined;
    } catch {
      return undefined;
    }
  };
  if (setting.trim()) {
    if (isCodexShellScript(setting, deps.platform ?? process.platform))
      return { path: setting.trim(), source: 'setting', problem: wrapperProblem(setting.trim()) };
    return (
      (await check(setting.trim(), 'setting')) ?? {
        path: setting.trim(),
        source: 'setting',
        problem: `agentura.codexExecutable: “${setting.trim()}” does not run (codex --version).`,
      }
    );
  }
  const candidates = codexCandidatePaths(deps).filter(exists);
  const found = (await Promise.all(candidates.map((path) => check(path, 'system')))).find(Boolean);
  if (found) return found;
  const wrapper = windowsWrappers(deps, exists)[0];
  if (wrapper) return { source: 'none', problem: wrapperProblem(wrapper) };
  return { source: 'none', problem: CODEX_NOT_FOUND };
}
