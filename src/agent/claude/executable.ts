import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Минимальная версия движка: та, на которой прогонялись фикстуры и сценарии (SDK 0.3.285 ↔ CLI 2.1.285). */
export const MIN_ENGINE_VERSION = '2.1.285';

export interface ResolvedExecutable {
  /** Путь к `claude`; `undefined` — не нашли (SDK попробует свой бинарник, в `.vsix` его нет). */
  path?: string;
  version?: string;
  /** Что показать пользователю, если всё плохо. */
  problem?: string;
  /** Откуда взяли: настройка или поиск. */
  source: 'setting' | 'system' | 'none';
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** Вывод `claude --version`; бросает, если не запустился. */
  runVersion?: (path: string) => string;
  home?: string;
  platform?: NodeJS.Platform;
}

/** `2.1.285 (Claude Code)` → `2.1.285`. */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** true, если a >= b (по числовым компонентам). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Места, где обычно лежит `claude`: PATH, затем установщик и менеджеры пакетов. */
export function candidatePaths(deps: ResolveDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const win = (deps.platform ?? process.platform) === 'win32';
  const name = win ? 'claude.exe' : 'claude';
  // Относительные элементы PATH («.», «bin») не берём: они резолвятся от cwd хоста, а не от системы.
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d && isAbsolute(d));
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'));
  if (!win) dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return [...new Set(dirs.map((d) => join(d, name)))];
}

const defaultRun = (path: string): string =>
  execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 });

/**
 * Какой `claude` запускать. Настройка важнее поиска; найденный бинарь проверяется `--version`.
 * `.vsix` 0.1 собран без бинарника движка (213 МБ), поэтому нужен системный `claude`.
 */
export function resolveExecutable(setting: string, deps: ResolveDeps = {}): ResolvedExecutable {
  const exists = deps.exists ?? existsSync;
  const run = deps.runVersion ?? defaultRun;
  const check = (path: string, source: 'setting' | 'system'): ResolvedExecutable | undefined => {
    let out: string;
    try {
      out = run(path);
    } catch {
      return undefined;
    }
    const version = parseVersion(out);
    if (!version) return undefined;
    const result: ResolvedExecutable = { path, version, source };
    if (!versionAtLeast(version, MIN_ENGINE_VERSION)) {
      result.problem = `Agentura проверена на Claude Code ${MIN_ENGINE_VERSION}+, найден ${version} (${path}). Обновите: claude update.`;
    }
    return result;
  };

  if (setting.trim()) {
    const found = check(setting.trim(), 'setting');
    return (
      found ?? {
        path: setting.trim(),
        source: 'setting',
        problem: `agentura.claudeExecutable: «${setting.trim()}» не запускается (claude --version).`,
      }
    );
  }
  for (const candidate of candidatePaths(deps)) {
    if (!exists(candidate)) continue;
    const found = check(candidate, 'system');
    if (found) return found;
  }
  return {
    source: 'none',
    problem:
      'Не найден Claude Code (claude). Установите его и выполните вход (claude → /login) либо укажите путь в настройке agentura.claudeExecutable.',
  };
}
