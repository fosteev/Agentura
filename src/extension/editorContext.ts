import * as vscode from 'vscode';
import type { EditorContext } from '../protocol';
import type { WorkspaceFiles } from './workspaceFiles';

const DEBOUNCE_MS = 150;

/**
 * Автоконтекст (A-контекст, B3): открытый файл и выделение активного редактора. Файлы вне
 * воркспейса и игнорируемые (`files.exclude`, `search.exclude`, `.gitignore`) не попадают.
 */
export class EditorContextTracker implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly files: WorkspaceFiles,
    private readonly onChange: (ctx: EditorContext) => void,
  ) {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.publish(), DEBOUNCE_MS);
    };
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(schedule),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) schedule();
      }),
    );
    schedule();
  }

  private async publish(): Promise<void> {
    // Фокус во вкладке чата (webview) обнуляет activeTextEditor — пока рядом виден текстовый
    // редактор, держим прежний контекст: он и должен уйти с сообщением.
    if (!vscode.window.activeTextEditor && vscode.window.visibleTextEditors.length > 0) return;
    this.onChange(await this.current());
  }

  async current(): Promise<EditorContext> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !(await this.files.isIncluded(editor.document.uri))) return {};
    const path = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
    const name = path.split('/').pop() ?? path;
    const ctx: EditorContext = { file: { path, name } };
    const sel = editor.selection;
    if (!sel.isEmpty) {
      // выделение, заканчивающееся в начале строки, эту строку не захватывает
      const endLine =
        sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      ctx.selection = { path, name, startLine: sel.start.line + 1, endLine };
    }
    return ctx;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
  }
}
