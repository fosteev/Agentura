import * as path from 'node:path';
import * as vscode from 'vscode';
import type { OpenDiff } from './chatController';

/** Схема виртуальных документов диффа: левая сторона — файл до правки, правая — после. */
export const DIFF_SCHEME = 'agentura-diff';
/** Сколько пар документов держать в памяти (стороны — файлы целиком). */
const MAX_PAIRS = 40;

/**
 * Нативный дифф правок агента (этап 5): `TextDocumentContentProvider` над `agentura-diff:` и
 * `vscode.diff`. URI — `agentura-diff:/<ключ>/before|after/<имя файла>`: имя в конце даёт
 * подсветку по расширению; ключ правки и стадии (`<toolUseId>-proposed|applied`) не меняет
 * содержимое под одним URI, поэтому `onDidChange` не нужен.
 */
export class DiffDocuments implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly keys: string[] = [];

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  async open(d: OpenDiff, column?: vscode.ViewColumn): Promise<void> {
    const name = path.basename(d.filePath) || 'file';
    const key = encodeURIComponent(d.key);
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/before/${name}` });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/after/${name}` });
    if (!this.keys.includes(key)) {
      this.keys.push(key);
      while (this.keys.length > MAX_PAIRS) {
        const old = this.keys.shift()!;
        for (const k of [...this.docs.keys()]) if (k.includes(`/${old}/`)) this.docs.delete(k);
      }
    }
    this.docs.set(left.toString(), d.before);
    this.docs.set(right.toString(), d.after);
    const what = d.stage === 'proposed' ? 'предложенная правка' : 'правка агента';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name}: ${what}`, {
      preview: true,
      ...(column !== undefined ? { viewColumn: column } : {}),
    });
  }
}
