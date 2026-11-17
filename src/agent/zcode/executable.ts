import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export const ZCODE_MIN_VERSION = '0.17.1';
export const ZCODE_NOT_FOUND = 'ZCode CLI (zcode) was not found.';

export type ZCodeExecutableProblem = 'missing' | 'old' | 'wrong';

export interface ResolvedZCodeExecutable {
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
  reason?: ZCodeExecutableProblem;
}

export interface ZCodeDoctorInfo {
  cliName?: string;
  version?: string;
  packaging?: string;
  node?: string;
  platform?: string;
}

export interface ResolveZCodeDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  runDoctorOrVersion?: (path: string) => Promise<string>;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
}

export function parseZCodeDoctor(output: string): ZCodeDoctorInfo | undefined {
  try {
    const parsed = JSON.parse(output) as {
      cli?: { name?: unknown; version?: unknown };
      runtime?: { node?: unknown; platform?: unknown };
      packaging?: { default?: unknown };
    };
    if (!parsed || typeof parsed !== 'object') return undefined;
    const cliName = typeof parsed.cli?.name === 'string' ? parsed.cli.name : undefined;
    const version = typeof parsed.cli?.version === 'string' ? parsed.cli.version : undefined;
    if (!version) return undefined;
    return {
      ...(cliName ? { cliName } : {}),
      version,
      ...(typeof parsed.packaging?.default === 'string' ? { packaging: parsed.packaging.default } : {}),
      ...(typeof parsed.runtime?.node === 'string' ? { node: parsed.runtime.node } : {}),
      ...(typeof parsed.runtime?.platform === 'string' ? { platform: parsed.runtime.platform } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Принимает JSON от `zcode doctor --json` или строку от `zcode version` (напр. `0.17.1`). */
export function parseZCodeVersion(output: string): string | undefined {
  const doc = parseZCodeDoctor(output);
  if (doc) {
    if (doc.cliName && doc.cliName !== 'zcode') return undefined;
    return doc.version;
  }
  return /^(?:zcode(?:\s+cli)?\s+)?v?(\d+\.\d+\.\d+)$/i.exec(output.trim())?.[1];
}

export function compareZCodeVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function zcodeTooOldMessage(found: string): string {
  return `zcode ${found} is too old: Agentura needs zcode >= ${ZCODE_MIN_VERSION} (zcode app-server --stdio).`;
}

function wrongBinaryMessage(path: string, setting: boolean): string {
  return setting
    ? `agentura.zcodeExecutable: “${path}” is not ZCode CLI (zcode doctor --json).`
    : `${path} is not ZCode CLI (zcode doctor --json).`;
}

export function zcodeCandidatePaths(deps: ResolveZCodeDeps = {}): string[] {
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
  const name = win ? 'zcode.exe' : 'zcode';
  return [...new Set(dirs.map((dir) => join(dir, name)))];
}

function defaultRun(timeoutMs = 5000) {
  return (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let done = false;
      const child = execFile(
        path,
        ['doctor', '--json'],
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
        reject(new Error(`${path} doctor --json: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
}

export function runZCodeDoctor(executable: string, cwd?: string, timeoutMs = 6000): Promise<ZCodeDoctorInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['doctor', '--json'],
      { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const info = parseZCodeDoctor(stdout);
        if (!info || (info.cliName && info.cliName !== 'zcode')) {
          reject(new Error('zcode doctor --json did not return valid ZCode metadata.'));
          return;
        }
        resolve(info);
      },
    );
  });
}

export async function resolveZCodeExecutable(
  setting: string,
  deps: ResolveZCodeDeps = {},
): Promise<ResolvedZCodeExecutable> {
  const exists = deps.exists ?? existsSync;
  const run = deps.runDoctorOrVersion ?? defaultRun(deps.timeoutMs);
  const check = async (path: string, source: 'setting' | 'system'): Promise<ResolvedZCodeExecutable> => {
    let version: string | undefined;
    try {
      version = parseZCodeVersion(await run(path));
    } catch {
      // wrong ниже
    }
    if (!version) {
      return { path, source, reason: 'wrong', problem: wrongBinaryMessage(path, source === 'setting') };
    }
    if (compareZCodeVersions(version, ZCODE_MIN_VERSION) < 0) {
      return { path, source, reason: 'old', problem: zcodeTooOldMessage(version) };
    }
    return { path, version, source };
  };

  if (setting.trim()) return check(setting.trim(), 'setting');
  const found = await Promise.all(zcodeCandidatePaths(deps).filter(exists).map((p) => check(p, 'system')));
  return (
    found.find((r) => r.version) ??
    found.find((r) => r.reason === 'old') ??
    found[0] ?? { source: 'none', reason: 'missing', problem: ZCODE_NOT_FOUND }
  );
}
