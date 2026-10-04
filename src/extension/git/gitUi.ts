import * as vscode from 'vscode';
import { DIFF_SCHEME } from '../diffDocuments';
import type { GitPickItem, GitUi } from './gitService';

/** `GitUi` руками VS Code: модалка, QuickPick, поле ввода, дифф, открытие файла. */
export function vscodeGitUi(): GitUi {
  return {
    async confirm(message, detail, action) {
      const picked = await vscode.window.showWarningMessage(
        message,
        { modal: true, ...(detail ? { detail } : {}) },
        action,
      );
      return picked === action;
    },
    async pick<T extends GitPickItem>(items: T[], placeholder: string) {
      type Q = vscode.QuickPickItem & { item?: T };
      const picked = await vscode.window.showQuickPick<Q>(
        items.map((item) =>
          item.separator
            ? { label: item.label, kind: vscode.QuickPickItemKind.Separator }
            : { label: item.label, description: item.description, item },
        ),
        { placeHolder: placeholder, matchOnDescription: true },
      );
      return picked?.item;
    },
    input(prompt, validate) {
      return Promise.resolve(
        vscode.window.showInputBox({ prompt, placeHolder: prompt, validateInput: validate }),
      );
    },
    async diff(left, right, title) {
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    },
    async open(uri) {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    },
    async openRepository() {
      await vscode.commands.executeCommand('git.openRepository');
    },
    // `agentura-diff:` без содержимого — пустой документ (провайдер отдаёт '' по неизвестному uri)
    empty(name) {
      return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/git-empty/after/${name}` });
    },
  };
}
