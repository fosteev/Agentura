import { execFile } from 'node:child_process';
import { existsSync, promises as fsPromises, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  ChildAgentError,
  type ChildContextSpec,
} from './types';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 64 * 1024; // 64 KB
const MAX_TOTAL_CONTEXT_FILES_SIZE = 200 * 1024; // 200 KB

export function resolveInsideWorkspace(cwd: string, relOrAbsPath: string): string {
  if (typeof relOrAbsPath !== 'string' || !relOrAbsPath.trim()) {
    throw new ChildAgentError('INVALID_ARGUMENTS', 'Path must be a non-empty string');
  }

  // Check for control characters and NUL bytes
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(relOrAbsPath)) {
    throw new ChildAgentError('INVALID_ARGUMENTS', 'Path contains invalid control characters');
  }

  const rawSegments = relOrAbsPath.split(/[/\\]/);
  if (rawSegments.includes('.git')) {
    throw new ChildAgentError('INVALID_ARGUMENTS', 'Access to .git is forbidden');
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch (err) {
    throw new ChildAgentError('INVALID_ARGUMENTS', `Workspace cwd cannot be resolved: ${String(err)}`);
  }

  const normalized = normalize(relOrAbsPath);
  if (normalized === '.' || normalized === '') {
    return canonicalCwd;
  }

  const absPath = isAbsolute(normalized) ? normalized : resolve(canonicalCwd, normalized);

  let real: string;
  if (existsSync(absPath)) {
    try {
      real = realpathSync(absPath);
    } catch (err) {
      throw new ChildAgentError('INVALID_ARGUMENTS', `Failed to resolve realpath for ${relOrAbsPath}: ${String(err)}`);
    }
  } else {
    // Traverse up to find existing ancestor
    let curr = absPath;
    const tail: string[] = [];
    while (!existsSync(curr)) {
      const parent = dirname(curr);
      if (parent === curr) break;
      tail.unshift(basename(curr));
      curr = parent;
    }
    if (!existsSync(curr)) {
      throw new ChildAgentError('INVALID_ARGUMENTS', `Path base does not exist: ${relOrAbsPath}`);
    }
    const realParent = realpathSync(curr);
    real = resolve(realParent, ...tail);
  }

  if (real !== canonicalCwd && !real.startsWith(canonicalCwd + sep)) {
    throw new ChildAgentError('INVALID_ARGUMENTS', `Path ${relOrAbsPath} escapes workspace ${cwd}`);
  }

  const relFromCwd = relative(canonicalCwd, real);
  const segments = relFromCwd.split(sep);
  if (segments.includes('.git')) {
    throw new ChildAgentError('INVALID_ARGUMENTS', 'Access to .git is forbidden');
  }

  return real;
}

export function pathsConflict(canonicalCwd: string, pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  if (pathA === canonicalCwd || pathB === canonicalCwd) return true;
  if (pathA.startsWith(pathB + sep) || pathB.startsWith(pathA + sep)) return true;
  return false;
}

interface HeldEntry {
  workspaceRoot: string;
  paths: string[];
}

export class WriteOwnershipRegistry {
  private readonly holders = new Map<string, HeldEntry>();

  acquire(agentId: string, workspaceRoot: string, writePaths: string[] | undefined): string[] {
    if (!writePaths || writePaths.length === 0) {
      throw new ChildAgentError(
        'INVALID_ARGUMENTS',
        'writePaths is required for shared workspace write access (use ["."] for exclusive workspace write)',
      );
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(workspaceRoot);
    } catch (err) {
      throw new ChildAgentError('INVALID_ARGUMENTS', `Invalid workspace root: ${String(err)}`);
    }

    const canonicalPaths = writePaths.map((p) => {
      try {
        return resolveInsideWorkspace(canonicalCwd, p);
      } catch (err) {
        if (err instanceof ChildAgentError) throw err;
        throw new ChildAgentError('INVALID_ARGUMENTS', `Invalid write path: ${p} (${String(err)})`);
      }
    });

    // Check conflicts with active holders in the same workspace
    for (const [heldAgentId, entry] of this.holders.entries()) {
      if (heldAgentId === agentId) continue;
      if (entry.workspaceRoot !== canonicalCwd) continue;

      for (const reqPath of canonicalPaths) {
        for (const heldPath of entry.paths) {
          if (pathsConflict(canonicalCwd, reqPath, heldPath)) {
            throw new ChildAgentError(
              'WRITE_OWNERSHIP_CONFLICT',
              `Write path "${reqPath}" conflicts with active agent "${heldAgentId}" holding "${heldPath}"`,
              {
                conflictingAgentId: heldAgentId,
                conflictingPath: heldPath,
                requestedPath: reqPath,
              },
            );
          }
        }
      }
    }

    this.holders.set(agentId, {
      workspaceRoot: canonicalCwd,
      paths: canonicalPaths,
    });

    return canonicalPaths;
  }

  release(agentId: string): void {
    this.holders.delete(agentId);
  }

  getHeldPaths(agentId: string): string[] | undefined {
    return this.holders.get(agentId)?.paths;
  }

  clear(): void {
    this.holders.clear();
  }
}

export interface WorktreeManager {
  create(workspaceRoot: string, agentId: string): Promise<{ worktreePath: string; cleanup: () => Promise<void> }>;
}

export class GitWorktreeManager implements WorktreeManager {
  async create(workspaceRoot: string, agentId: string): Promise<{ worktreePath: string; cleanup: () => Promise<void> }> {
    const canonicalCwd = realpathSync(workspaceRoot);
    const parentDir = dirname(canonicalCwd);
    const wtName = `.agentura-wt-${agentId}-${Date.now()}`;
    const worktreePath = resolve(parentDir, wtName);

    await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: canonicalCwd,
    });

    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: canonicalCwd,
        });
      } catch {
        // Ignore best-effort cleanup errors
      }
    };

    return { worktreePath, cleanup };
  }
}

export async function buildExplicitChildPrompt(
  cwd: string,
  task: string,
  context?: ChildContextSpec,
): Promise<string> {
  const sections: string[] = [];

  const trimmedTask = task.trim();
  if (!trimmedTask) {
    throw new ChildAgentError('INVALID_ARGUMENTS', 'Task must not be empty');
  }
  sections.push(`# Task\n\n${trimmedTask}`);

  if (context?.notes && context.notes.trim()) {
    sections.push(`# Notes\n\n${context.notes.trim()}`);
  }

  if (context?.selectedText && context.selectedText.trim()) {
    sections.push(`# Selected Text\n\n${context.selectedText.trim()}`);
  }

  if (context?.files && context.files.length > 0) {
    const fileBlocks: string[] = [];
    let totalSize = 0;

    for (const fileSpec of context.files) {
      if (!fileSpec.path || !fileSpec.path.trim()) {
        throw new ChildAgentError('INVALID_CONTEXT', 'File path in context cannot be empty');
      }

      let absPath: string;
      try {
        absPath = resolveInsideWorkspace(cwd, fileSpec.path);
      } catch (err) {
        throw new ChildAgentError('INVALID_CONTEXT', `Invalid file path in context "${fileSpec.path}": ${String(err)}`);
      }

      if (!existsSync(absPath)) {
        throw new ChildAgentError('INVALID_CONTEXT', `Context file not found: ${fileSpec.path}`);
      }

      let buf: Buffer;
      try {
        buf = await fsPromises.readFile(absPath);
      } catch (err) {
        throw new ChildAgentError('INVALID_CONTEXT', `Cannot read context file "${fileSpec.path}": ${String(err)}`);
      }

      if (buf.length > MAX_FILE_SIZE) {
        throw new ChildAgentError(
          'INVALID_CONTEXT',
          `Context file "${fileSpec.path}" size (${buf.length} bytes) exceeds limit (${MAX_FILE_SIZE} bytes)`,
        );
      }

      if (buf.includes(0)) {
        throw new ChildAgentError('INVALID_CONTEXT', `Context file "${fileSpec.path}" contains binary NUL bytes`);
      }

      let text = buf.toString('utf8');
      let rangeInfo = '';

      if (fileSpec.startLine !== undefined || fileSpec.endLine !== undefined) {
        const lines = text.split('\n');
        const start = fileSpec.startLine !== undefined ? Math.max(1, fileSpec.startLine) : 1;
        const end = fileSpec.endLine !== undefined ? Math.min(lines.length, fileSpec.endLine) : lines.length;

        if (start > end) {
          throw new ChildAgentError(
            'INVALID_CONTEXT',
            `Invalid line range for ${fileSpec.path}: startLine (${start}) > endLine (${end})`,
          );
        }

        rangeInfo = ` (lines ${start}-${end})`;
        text = lines.slice(start - 1, end).join('\n');
      }

      const block = `## File: ${fileSpec.path}${rangeInfo}\n\`\`\`\n${text}\n\`\`\``;
      totalSize += Buffer.byteLength(block, 'utf8');

      if (totalSize > MAX_TOTAL_CONTEXT_FILES_SIZE) {
        throw new ChildAgentError(
          'INVALID_CONTEXT',
          `Total context files size exceeds limit (${MAX_TOTAL_CONTEXT_FILES_SIZE} bytes)`,
        );
      }

      fileBlocks.push(block);
    }

    if (fileBlocks.length > 0) {
      sections.push(`# Referenced Files\n\n${fileBlocks.join('\n\n')}`);
    }
  }

  return sections.join('\n\n');
}
