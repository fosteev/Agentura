import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export const GEMINI_MIN_VERSION = '0.1.0';
export const GEMINI_NOT_FOUND = 'Gemini CLI (gemini) was not found.';

export type GeminiExecutableProblem = 'missing' | 'old' | 'wrong';

export interface ResolvedGeminiExecutable {
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
  reason?: GeminiExecutableProblem;
}

export interface ResolveGeminiDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  runVersion?: (path: string) => Promise<string>;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
}

/** `0.67.0` или `gemini 0.67.0` → `0.67.0`. */
export function parseGeminiVersion(output: string): string | undefined {
  return /^(?:(?:gemini(?:\s+cli)?)\s*,?\s*(?:version\s+)?)?v?(\d+\.\d+\.\d+)$/i
    .exec(output.trim())?.[1];
}

export function compareGeminiVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function geminiTooOldMessage(found: string): string {
  return `gemini ${found} is too old: Agentura needs gemini >= ${GEMINI_MIN_VERSION} (gemini --acp).`;
}

function wrongBinaryMessage(path: string, setting: boolean): string {
  return setting
    ? `agentura.geminiExecutable: “${path}” is not Gemini CLI (gemini --version).`
    : `${path} is not Gemini CLI (gemini --version).`;
}

export function geminiCandidatePaths(deps: ResolveGeminiDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const win = (deps.platform ?? process.platform) === 'win32';
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir && isAbsolute(dir));
  dirs.push(join(home, '.local', 'bin'));
  if (win) {
    const appData = env.APPDATA;
    if (appData && isAbsolute(appData)) dirs.push(join(appData, 'npm'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  const name = win ? 'gemini.exe' : 'gemini';
  return [...new Set(dirs.map((dir) => join(dir, name)))];
}

function defaultRun(timeoutMs = 5000) {
  return (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let done = false;
      const child = execFile(
        path,
        ['--version'],
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
        reject(new Error(`${path} --version: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
}

export async function resolveGeminiExecutable(
  setting: string,
  deps: ResolveGeminiDeps = {},
): Promise<ResolvedGeminiExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.runVersion ?? defaultRun(deps.timeoutMs);
  const check = async (path: string, source: 'setting' | 'system'): Promise<ResolvedGeminiExecutable> => {
    let version: string | undefined;
    try {
      version = parseGeminiVersion(await run(path));
    } catch {
      // wrong ниже
    }
    if (!version) {
      return { path, source, reason: 'wrong', problem: wrongBinaryMessage(path, source === 'setting') };
    }
    if (compareGeminiVersions(version, GEMINI_MIN_VERSION) < 0) {
      return { path, source, reason: 'old', problem: geminiTooOldMessage(version) };
    }
    return { path, version, source };
  };

  if (setting.trim()) return check(setting.trim(), 'setting');
  const found = await Promise.all(geminiCandidatePaths(deps).filter(exists).map((p) => check(p, 'system')));
  return (
    found.find((r) => r.version) ??
    found.find((r) => r.reason === 'old') ??
    found[0] ?? { source: 'none', reason: 'missing', problem: GEMINI_NOT_FOUND }
  );
}
