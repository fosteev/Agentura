import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StoredChildNode, StoredTranscriptStep, StoredTree } from './types';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = join(filePath, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore unlink error
    }
    throw err;
  }
}

export class ChildAgentStore {
  private readonly trees = new Map<string, StoredTree>();
  private readonly sessionIndex = new Map<string, string>();

  constructor(
    readonly storageDir: string = join(homedir(), '.local', 'share', 'agentura', 'child-agents'),
  ) {}

  private sessionKey(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
  }

  private sessionIndexPath(): string {
    return join(this.storageDir, 'session-index.json');
  }

  private loadSessionIndex(): void {
    this.sessionIndex.clear();
    const indexPath = this.sessionIndexPath();
    if (!existsSync(indexPath)) return;
    try {
      const raw = readFileSync(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v) {
          this.sessionIndex.set(k, v);
        }
      }
    } catch {
      // ignore corrupted session index
    }
  }

  private saveSessionIndex(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.sessionIndex.entries()) {
      obj[k] = v;
    }
    atomicWriteJson(this.sessionIndexPath(), obj);
  }

  linkSessionToTree(provider: string, sessionId: string, rootTreeId: string): void {
    if (!provider || !sessionId || !rootTreeId) return;
    const key = this.sessionKey(provider, sessionId);
    if (this.sessionIndex.get(key) === rootTreeId) return;
    this.sessionIndex.set(key, rootTreeId);
    this.saveSessionIndex();
  }

  findTreeIdBySession(provider: string, sessionId: string): string | undefined {
    if (!provider || !sessionId) return undefined;
    return this.sessionIndex.get(this.sessionKey(provider, sessionId));
  }

  loadAll(): void {
    this.trees.clear();
    this.loadSessionIndex();
    if (!existsSync(this.storageDir)) return;

    let files: string[];
    try {
      files = readdirSync(this.storageDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const fullPath = join(this.storageDir, file);

      try {
        const raw = readFileSync(fullPath, 'utf8');
        const tree = JSON.parse(raw) as StoredTree;
        if (!tree || typeof tree.rootTreeId !== 'string' || !tree.nodes) continue;

        let modified = false;
        const now = Date.now();

        for (const node of Object.values(tree.nodes)) {
          if (node.status === 'starting' || node.status === 'running') {
            node.status = 'unknown_after_restart';
            node.endedAt = now;
            node.error = 'Host restarted while child agent was running; outcome is unknown and task was not re-executed.';
            modified = true;
          } else if (node.status === 'idle') {
            node.status = 'completed';
            node.endedAt = now;
            modified = true;
          }
        }

        this.trees.set(tree.rootTreeId, tree);

        if (modified) {
          atomicWriteJson(fullPath, tree);
        }
      } catch {
        // Damaged file must not prevent opening other records
      }
    }
  }

  getTree(rootTreeId: string): StoredTree | undefined {
    return this.trees.get(rootTreeId);
  }

  findTreeIdByAgent(agentId: string): string | undefined {
    for (const tree of this.trees.values()) {
      if (tree.nodes[agentId]) {
        return tree.rootTreeId;
      }
    }
    return undefined;
  }

  saveTree(tree: StoredTree): void {
    this.trees.set(tree.rootTreeId, tree);
    const fileName = `${sha256(tree.rootTreeId)}.json`;
    const fullPath = join(this.storageDir, fileName);
    atomicWriteJson(fullPath, tree);
  }

  saveNode(rootTreeId: string, node: StoredChildNode): void {
    let tree = this.trees.get(rootTreeId);
    const now = Date.now();
    if (!tree) {
      tree = {
        rootTreeId,
        createdAt: now,
        updatedAt: now,
        rootCwd: '',
        totalSpawns: 0,
        nodes: {},
      };
      this.trees.set(rootTreeId, tree);
    }
    tree.nodes[node.agentId] = node;
    tree.updatedAt = now;
    this.saveTree(tree);
  }

  saveTranscript(rootTreeId: string, agentId: string, steps: StoredTranscriptStep[]): void {
    const dir = join(this.storageDir, sha256(rootTreeId));
    const filePath = join(dir, `${agentId}.json`);
    atomicWriteJson(filePath, steps);
  }

  getTranscript(rootTreeId: string, agentId: string): StoredTranscriptStep[] | undefined {
    const dir = join(this.storageDir, sha256(rootTreeId));
    const filePath = join(dir, `${agentId}.json`);
    if (!existsSync(filePath)) return undefined;

    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as StoredTranscriptStep[];
    } catch {
      return undefined;
    }
  }

  deleteTree(rootTreeId: string): void {
    this.trees.delete(rootTreeId);
    let indexChanged = false;
    for (const [k, v] of this.sessionIndex.entries()) {
      if (v === rootTreeId) {
        this.sessionIndex.delete(k);
        indexChanged = true;
      }
    }
    if (indexChanged) this.saveSessionIndex();
    const filePath = join(this.storageDir, `${sha256(rootTreeId)}.json`);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}
