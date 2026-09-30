import * as vscode from 'vscode';
import { postToWebview } from '../protocol';
import type { Logger } from './logger';
import type { UsageService } from './usage';
import { attachMessaging, renderWebview, webviewOptions } from './webviewHost';

export const SIDEBAR_VIEW_ID = 'agentura.sidebar';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly usage: UsageService,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const { webview } = view;
    webview.options = webviewOptions(this.context.extensionUri);
    webview.html = renderWebview(webview, this.context.extensionUri, 'sidebar', 'Agentura');
    const version = String(this.context.extension.packageJSON.version);
    const sub = attachMessaging(webview, 'sidebar', version, this.log, (m) => {
      if (m.type === 'session.new') void vscode.commands.executeCommand('agentura.newSession');
      if (m.type === 'limits.refresh') void this.refreshUsage();
      // Опрос лимитов идёт с активации; открытой позже панели отдаём снимок (в кулдауне — из кэша).
      if (m.type === 'ready') void this.refreshUsage();
    });
    view.onDidDispose(() => {
      sub.dispose();
      this.view = undefined;
    });
  }

  /** Кнопка ↻ в боковой панели и команда «Обновить лимиты». */
  async refreshUsage(): Promise<void> {
    const snap = await this.usage.refresh();
    if (snap.error) this.log.warn(`Лимиты не обновились: ${snap.error}`);
    else this.log.info(`Лимиты: данные на ${new Date(snap.updatedAt).toLocaleTimeString('ru')}`);
    if (this.view) postToWebview(this.view.webview, { type: 'limits.update', ...snap });
  }
}
