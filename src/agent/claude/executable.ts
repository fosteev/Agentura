import { execFile } from 'node:child_process';
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
  runVersion?: (path: string) => Promise<string>;
  /** Таймаут `--version` на одного кандидата, мс (по умолчанию 5000). */
  timeoutMs?: number;
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

/** Папки, где обычно лежит `claude`: PATH, затем установщик и менеджеры пакетов. */
function candidateDirs(env: NodeJS.ProcessEnv, home: string, win: boolean): string[] {
  // Относительные элементы PATH («.», «bin») не берём: они резолвятся от cwd хоста, а не от системы.
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d && isAbsolute(d));
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'));
  if (win) {
    // npm-установка кладёт обёртку в `%APPDATA%\npm`; PATH там обычно уже есть, но не всегда у GUI-процесса
    const appData = env.APPDATA;
    if (appData && isAbsolute(appData)) dirs.push(join(appData, 'npm'));
  } else dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs;
}

/**
 * Где искать `claude`. На Windows — только `claude.exe`: npm-обёртку `claude.cmd` SDK запускает без оболочки,
 * а Node (≥ 18.20.2) такой запуск `.cmd` отклоняет (EINVAL) — движок не поднялся бы.
 */
export function candidatePaths(deps: ResolveDeps = {}): string[] {
  const win = (deps.platform ?? process.platform) === 'win32';
  const name = win ? 'claude.exe' : 'claude';
  const dirs = candidateDirs(deps.env ?? process.env, deps.home ?? homedir(), win);
  return [...new Set(dirs.map((d) => join(d, name)))];
}

/** npm-обёртки `claude.cmd` на Windows: найдены — подсказка поставить `claude.exe` вместо «не найден». */
function windowsWrappers(deps: ResolveDeps, exists: (p: string) => boolean): string[] {
  if ((deps.platform ?? process.platform) !== 'win32') return [];
  const dirs = candidateDirs(deps.env ?? process.env, deps.home ?? homedir(), true);
  return [...new Set(dirs.map((d) => join(d, 'claude.cmd')))].filter((p) => exists(p));
}

/** `.cmd`/`.bat`: на Windows SDK их не запустит (нужна оболочка), Agentura их не принимает. */
export function isShellScript(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(path.trim());
}

/** Подсказка для npm-обёртки на Windows. */
const CMD_PROBLEM = (path: string) =>
  `${path} — npm-обёртка, движок через неё не запускается. Установите Claude Code нативным установщиком (claude.exe) или укажите путь к claude.exe в agentura.claudeExecutable.`;

/**
 * `claude --version` с жёстким таймаутом: по истечении процесс убивается (SIGKILL), а промис отклоняется
 * сразу, не дожидаясь закрытия потоков (их мог унаследовать дочерний процесс). Без оболочки.
 */
export function defaultRun(timeoutMs = 5000) {
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
        reject(new Error(`${path} --version: нет ответа за ${timeoutMs} мс`));
      }, timeoutMs);
    });
}

/**
 * Какой `claude` запускать. Настройка важнее поиска; найденный бинарь проверяется `--version`.
 * `.vsix` 0.1 собран без бинарника движка (213 МБ), поэтому нужен системный `claude`.
 */
export async function resolveExecutable(
  setting: string,
  deps: ResolveDeps = {},
): Promise<ResolvedExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.runVersion ?? defaultRun(deps.timeoutMs);
  const check = async (
    path: string,
    source: 'setting' | 'system',
  ): Promise<ResolvedExecutable | undefined> => {
    let out: string;
    try {
      out = await run(path);
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
    if (isShellScript(setting, deps.platform ?? process.platform))
      return { path: setting.trim(), source: 'setting', problem: CMD_PROBLEM(setting.trim()) };
    const found = await check(setting.trim(), 'setting');
    return (
      found ?? {
        path: setting.trim(),
        source: 'setting',
        problem: `agentura.claudeExecutable: «${setting.trim()}» не запускается (claude --version).`,
      }
    );
  }
  // кандидаты проверяются параллельно (у каждого свой таймаут), выбор — по порядку списка
  const found = await Promise.all(
    candidatePaths(deps)
      .filter((c) => exists(c))
      .map((c) => check(c, 'system')),
  );
  const first = found.find((r) => r !== undefined);
  if (first) return first;
  const wrapper = windowsWrappers(deps, exists)[0];
  if (wrapper) return { source: 'none', problem: CMD_PROBLEM(wrapper) };
  return {
    source: 'none',
    problem:
      'Не найден Claude Code (claude). Установите его и выполните вход (claude → /login) либо укажите путь в настройке agentura.claudeExecutable.',
  };
}
