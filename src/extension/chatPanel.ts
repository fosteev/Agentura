import * as vscode from 'vscode';
import type { Logger } from './logger';
import { attachMessaging, renderWebview, webviewOptions } from './webviewHost';

export const CHAT_VIEW_TYPE = 'agentura.chat';

/** Вкладка чата: одна на окно, повторное открытие показывает существующую. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, log: Logger): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      'Agentura',
      vscode.ViewColumn.Beside,
      { ...webviewOptions(context.extensionUri), retainContextWhenHidden: true },
    );
    ChatPanel.current = new ChatPanel(panel, context, log);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
  ) {
    const version = String(context.extension.packageJSON.version);
    panel.webview.html = renderWebview(panel.webview, context.extensionUri, 'chat', 'Agentura');
    this.disposables.push(attachMessaging(panel.webview, 'chat', version, log));
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    log.info('Вкладка чата открыта');
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}
