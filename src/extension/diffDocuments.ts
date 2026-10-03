import * as path from 'node:path';
import * as vscode from 'vscode';
import type { OpenDiff } from './chatController';
import { hostStrings } from '../shared/l10n';
import { currentLanguage } from './webviewHost';

/** Схема виртуальных документов диффа: левая сторона — файл до правки, правая — после. */
export const DIFF_SCHEME = 'agentura-diff';
/** Сколько пар документов держать в памяти (стороны — файлы целиком). */
const MAX_PAIRS = 40;
/** djb2 — короткий ключ мульти-диффа по ключам файлов. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Фокус группы редактора по колонке — перед `vscode.changes`, который колонку не принимает. */
const FOCUS_GROUP: Partial<Record<number, string>> = {
  1: 'workbench.action.focusFirstEditorGroup',
  2: 'workbench.action.focusSecondEditorGroup',
  3: 'workbench.action.focusThirdEditorGroup',
};

/**
 * Нативный дифф правок агента (этап 5): `TextDocumentContentProvider` над `agentura-diff:` и
 * `vscode.diff`. URI — `agentura-diff:/<ключ>/before|after/<имя файла>`: имя в конце даёт
 * подсветку по расширению; ключ правки и стадии (`<toolUseId>-proposed|applied`) не меняет
 * содержимое под одним URI. `onDidChange` нужен только тексту (`openText`): транскрипт идущего
 * агента открывают повторно под тем же URI.
 */
export class DiffDocuments implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly keys: string[] = [];
  /** Транскрипт идущего агента открывают повторно — содержимое под тем же URI обновляется. */
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
      this.changed,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  /**
   * Текст документом только для чтения (транскрипт субагента): та же схема, что у диффа, —
   * виртуальный документ VS Code не даёт редактировать. Повторное открытие обновляет текст.
   */
  async openText(
    d: { key: string; name: string; text: string },
    column?: vscode.ViewColumn,
  ): Promise<void> {
    const key = encodeURIComponent(d.key);
    const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/text/${d.name}` });
    this.remember(key);
    this.docs.set(uri.toString(), d.text);
    this.changed.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      ...(column !== undefined ? { viewColumn: column } : {}),
    });
  }

  private remember(key: string): void {
    if (this.keys.includes(key)) return;
    this.keys.push(key);
    while (this.keys.length > MAX_PAIRS) {
      const old = this.keys.shift()!;
      for (const k of [...this.docs.keys()]) if (k.includes(`/${old}/`)) this.docs.delete(k);
    }
  }

  async open(d: OpenDiff, column?: vscode.ViewColumn): Promise<void> {
    const name = path.basename(d.filePath) || 'file';
    const key = encodeURIComponent(d.key);
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/before/${name}` });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/after/${name}` });
    this.remember(key);
    this.docs.set(left.toString(), d.before);
    this.docs.set(right.toString(), d.after);
    const title = hostStrings(currentLanguage()).diffTitle(
      name,
      d.stage === 'proposed' ? 'proposed' : 'applied',
    );
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: true,
      ...(column !== undefined ? { viewColumn: column } : {}),
    });
  }

  /**
   * Мульти-дифф (`vscode.changes`): аргументы — заголовок и `[ресурс, до, после][]`; ресурс — настоящий файл
   * (подпись в редакторе), стороны — `agentura-diff:`. Все файлы — под одним ключом (`/<ключ>/<i>/…`): лимит
   * `MAX_PAIRS` считает мульти-дифф одной парой и не вытесняет его же документы, пока VS Code их не прочёл;
   * индекс `i` разводит файлы с одинаковым именем. `vscode.changes` не берёт колонку — сначала фокус группы.
   */
  async openChanges(title: string, files: OpenDiff[], column?: vscode.ViewColumn): Promise<void> {
    // ключ — от ключей всех файлов: другой набор правок не попадёт под URI, уже прочитанные VS Code
    const key = encodeURIComponent(`changes-${files.length}-${hash(files.map((d) => d.key).join('|'))}`);
    this.remember(key);
    const resources = files.map((d, i) => {
      const name = path.basename(d.filePath) || 'file';
      const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/${i}/before/${name}` });
      const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/${i}/after/${name}` });
      this.docs.set(left.toString(), d.before);
      this.docs.set(right.toString(), d.after);
      return [vscode.Uri.file(d.filePath), left, right];
    });
    if (column !== undefined) await vscode.commands.executeCommand(FOCUS_GROUP[column] ?? FOCUS_GROUP[1]!);
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }
}
