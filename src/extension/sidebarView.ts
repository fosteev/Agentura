import * as vscode from 'vscode';
import { postToWebview, type SessionSummary } from '../protocol';
import type { AccountService } from './account';
import { ChatPanel } from './chatPanel';
import type { SessionsService } from './sessionsService';
import type { Logger } from './logger';
import type { UsageService } from './usage';
import { attachMessaging, renderWebview, webviewOptions } from './webviewHost';

export const SIDEBAR_VIEW_ID = 'agentura.sidebar';

/** Боковая панель: аккаунт и лимиты, список сессий проекта (этап 6). */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private rows: SessionSummary[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly usage: UsageService,
    private readonly sessions: SessionsService,
    private readonly account: AccountService,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const { webview } = view;
    webview.options = webviewOptions(this.context.extensionUri);
    webview.html = renderWebview(webview, this.context.extensionUri, 'sidebar', 'Agentura');
    const version = String(this.context.extension.packageJSON.version);
    const sub = attachMessaging(webview, 'sidebar', version, this.log, (m) => {
      switch (m.type) {
        case 'session.new':
          void vscode.commands.executeCommand('agentura.newSession');
          break;
        case 'session.resume':
          void vscode.commands.executeCommand('agentura.openSession', m.sessionId);
          break;
        case 'session.rename':
          void this.rename(m.sessionId, m.title);
          break;
        case 'settings.open':
          void vscode.commands.executeCommand('agentura.openSettings');
          break;
        case 'limits.refresh':
          void this.refreshUsage();
          break;
        case 'ready':
          // Опрос лимитов идёт с активации; открытой позже панели отдаём снимок (в кулдауне — из кэша).
          void this.refreshUsage();
          void this.account.get().then((a) => this.post({ type: 'account.info', ...a }));
          void this.sessions
            .refresh()
            .then(() => this.pushSessions())
            .catch((e) => this.log.warn(`список сессий: ${String(e)}`));
          break;
        default:
          break;
      }
    });
    const unsubscribe = [
      this.sessions.onChange((rows) => {
        this.rows = rows;
        this.pushSessions();
      }),
      this.account.onUpdate((a) => this.post({ type: 'account.info', ...a })),
      ChatPanel.onDidChange(() => this.pushSessions()),
    ];
    view.onDidDispose(() => {
      sub.dispose();
      unsubscribe.forEach((u) => ('dispose' in u ? u.dispose() : u()));
      this.view = undefined;
    });
  }

  private post(m: Parameters<typeof postToWebview>[1]): void {
    if (this.view) postToWebview(this.view.webview, m);
  }

  private pushSessions(): void {
    const current = ChatPanel.currentSessionId();
    const project = vscode.workspace.workspaceFolders?.[0]?.name;
    this.post({
      type: 'sessions.update',
      sessions: this.rows,
      ...(current ? { current } : {}),
      ...(project ? { project } : {}),
    });
  }

  private async rename(sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) return;
    try {
      await this.sessions.rename(sessionId, clean);
      ChatPanel.renamed(sessionId, clean);
    } catch (e) {
      this.log.warn(`переименование ${sessionId}: ${String(e)}`);
      void vscode.window.showWarningMessage(
        `Agentura: не удалось переименовать сессию: ${String(e)}`,
      );
    }
  }

  /** Кнопка ↻ в боковой панели и команда «Обновить лимиты». */
  async refreshUsage(): Promise<void> {
    const snap = await this.usage.refresh();
    if (snap.error) this.log.warn(`Лимиты не обновились: ${snap.error}`);
    else this.log.info(`Лимиты: данные на ${new Date(snap.updatedAt).toLocaleTimeString('ru')}`);
    this.post({ type: 'limits.update', ...snap });
  }
}
