import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { previewHtml } from './previewHtml';

const RERENDER_DELAY_MS = 150;

interface Entry {
  panel: vscode.WebviewPanel;
  watcher: vscode.FileSystemWatcher;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Превью `.html` в соседней вкладке (артефакты): файл читается с диска и перерисовывается при изменении.
 * Сообщения webview расширением не слушаются — превью изолировано намеренно.
 */
export class PreviewPanels implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();

  async open(file: string, column: vscode.ViewColumn): Promise<void> {
    const exists = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!exists) {
      void vscode.window.showWarningMessage(`Agentura: файла нет — ${file}`);
      return;
    }
    const known = this.entries.get(file);
    if (known) {
      known.panel.reveal(column, true);
      await this.render(file, known.panel);
      return;
    }
    const dir = path.dirname(file);
    const base = path.basename(file);
    const panel = vscode.window.createWebviewPanel(
      'agentura.preview',
      `превью · ${base}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(dir),
          ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
        ],
      },
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), base),
    );
    const entry: Entry = { panel, watcher, timer: undefined };
    const schedule = (): void => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void this.render(file, panel), RERENDER_DELAY_MS);
    };
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    panel.onDidDispose(() => {
      clearTimeout(entry.timer);
      watcher.dispose();
      this.entries.delete(file);
    });
    this.entries.set(file, entry);
    await this.render(file, panel);
  }

  private async render(file: string, panel: vscode.WebviewPanel): Promise<void> {
    const src = await readFile(file, 'utf8').catch(() => undefined);
    if (src === undefined) return;
    const dir = path.dirname(file);
    panel.webview.html = previewHtml(src, {
      cspSource: panel.webview.cspSource,
      baseHref: panel.webview.asWebviewUri(vscode.Uri.file(`${dir}/`)).toString(),
    });
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) {
      clearTimeout(e.timer);
      e.watcher.dispose();
      e.panel.dispose();
    }
    this.entries.clear();
  }
}
