import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import type { Attachment, FileHit } from '../shared/prompt';
import { excludeGlobs, rankFiles, toHit } from './fileSearch';

/** Файлы воркспейса для «@», «+» и автоконтекста. Исключения: `files.exclude`, `search.exclude`, `.gitignore`. */

const LIST_TTL_MS = 20_000;
const LIST_MAX = 10_000;
const SELECTION_MAX_CHARS = 20_000;

/** Пути (относительно `cwd`), которые git считает игнорируемыми. Не репозиторий или нет git — пусто. */
export function gitIgnored(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (paths.length === 0) return resolve(new Set());
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => resolve(new Set()));
    child.on('close', () => {
      const out = Buffer.concat(chunks).toString('utf8');
      resolve(new Set(out.split('\0').filter(Boolean)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(paths.join('\0') + '\0');
  });
}

export class WorkspaceFiles {
  private listed: { at: number; files: string[] } | undefined;
  private inflight: Promise<string[]> | undefined;
  private readonly ignoreCache = new Map<string, boolean>();

  constructor(private readonly root: vscode.Uri) {}

  /** Сброс кэшей: список — при создании/удалении/переименовании файлов; решения «исключён» — ещё и при смене `.gitignore`/`files.exclude`/`search.exclude`. */
  watch(): vscode.Disposable {
    const dropList = () => (this.listed = undefined);
    const dropAll = () => {
      this.listed = undefined;
      this.ignoreCache.clear();
    };
    const gitignore = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, '**/.gitignore'),
    );
    return vscode.Disposable.from(
      vscode.workspace.onDidCreateFiles(dropList),
      vscode.workspace.onDidDeleteFiles(dropAll),
      vscode.workspace.onDidRenameFiles(dropAll),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) {
          dropAll();
        }
      }),
      gitignore,
      gitignore.onDidCreate(dropAll),
      gitignore.onDidChange(dropAll),
      gitignore.onDidDelete(dropAll),
    );
  }

  private excludePattern(): string {
    const cfg = vscode.workspace.getConfiguration();
    const globs = excludeGlobs(
      cfg.get<Record<string, unknown>>('files.exclude'),
      cfg.get<Record<string, unknown>>('search.exclude'),
    );
    return `{${globs.join(',')}}`;
  }

  private async list(): Promise<string[]> {
    if (this.listed && Date.now() - this.listed.at < LIST_TTL_MS) return this.listed.files;
    this.inflight ??= (async () => {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.root, '**/*'),
        this.excludePattern(),
        LIST_MAX,
      );
      const rel = uris.map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'));
      const ignored = await gitIgnored(this.root.fsPath, rel);
      const files = rel.filter((p) => !ignored.has(p));
      this.listed = { at: Date.now(), files };
      return files;
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async find(query: string): Promise<FileHit[]> {
    return rankFiles(await this.list(), query);
  }

  /** Файл не исключён настройками и `.gitignore` и лежит в воркспейсе (B3: игнорируемые не уходят в контекст). */
  async isIncluded(uri: vscode.Uri): Promise<boolean> {
    if (uri.scheme !== 'file') return false;
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    if (rel === uri.fsPath || rel.startsWith('../')) return false;
    const cached = this.ignoreCache.get(rel);
    if (cached !== undefined) return cached;
    const hit = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root, escapeGlob(rel)),
      this.excludePattern(),
      1,
    );
    let ok = hit.length > 0;
    if (ok) ok = !(await gitIgnored(this.root.fsPath, [rel])).has(rel);
    if (this.ignoreCache.size > 500) this.ignoreCache.clear();
    this.ignoreCache.set(rel, ok);
    return ok;
  }

  /** Диалог выбора файлов и папок («+» → «Файл или папка…»). */
  async pick(): Promise<FileHit[]> {
    const picked = await vscode.window.showOpenDialog({
      defaultUri: this.root,
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
    });
    const out: FileHit[] = [];
    for (const uri of picked ?? []) {
      const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      if (rel === uri.fsPath || rel.startsWith('../')) continue; // вне воркспейса
      const stat = await vscode.workspace.fs.stat(uri);
      out.push(toHit(rel, (stat.type & vscode.FileType.Directory) !== 0));
    }
    return out;
  }

  async readSelection(a: Attachment): Promise<string | undefined> {
    if (a.kind !== 'selection' || a.startLine === undefined) return undefined;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.root, a.path));
    const start = Math.max(0, a.startLine - 1);
    const end = Math.min(doc.lineCount - 1, (a.endLine ?? a.startLine) - 1);
    const text = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).range.end.character));
    return text.length > SELECTION_MAX_CHARS ? `${text.slice(0, SELECTION_MAX_CHARS)}\n…` : text;
  }
}

function escapeGlob(path: string): string {
  return path.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}
