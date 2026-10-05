import * as vscode from 'vscode';
import { postToWebview, type SessionSummary } from '../protocol';
import { overriddenKeys, readSettings, writeSetting } from '../settings';
import type { AccountService } from './account';
import { ChatPanel } from './chatPanel';
import type { SessionsService } from './sessionsService';
import type { Logger } from './logger';
import type { UsageService } from './usage';
import { hostStrings } from '../shared/l10n';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';

export const SIDEBAR_VIEW_ID = 'agentura.sidebar';

/** Боковая панель: аккаунт и лимиты, список сессий проекта (этап 6). */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private rows: SessionSummary[] = [];
  /**
   * Записей вида от кнопки в полёте. Пока они есть, вид в панель не шлём: ответ на первый из быстрых кликов
   * откатил бы кнопку и следующий клик посчитался бы не от того вида. Шлём один раз — после последней записи.
   */
  private viewWrites = 0;

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
    webview.options = webviewOptions(this.context.extensionUri, userFontsDir(this.context));
    webview.html = renderWebview(webview, this.context.extensionUri, 'sidebar', 'Agentura', currentLanguage());
    const version = String(this.context.extension.packageJSON.version);
    const sub = attachMessaging(webview, 'sidebar', version, this.log, (m) => {
      switch (m.type) {
        case 'session.new':
          void vscode.commands.executeCommand('agentura.newSession');
          break;
        case 'session.resume':
          void vscode.commands.executeCommand('agentura.openSession', m.sessionId, m.provider);
          break;
        case 'session.rename':
          void this.rename(m.sessionId, m.title);
          break;
        case 'settings.open':
          void vscode.commands.executeCommand('agentura.openSettings');
          break;
        case 'settings.set':
          // из боковой панели пишется только вид списка (кнопка в заголовке «Сессии»)
          if (m.key === 'sessionList.view') void this.setListView(m.value);
          break;
        case 'limits.refresh':
          void this.refreshUsage();
          break;
        case 'ready':
          // Опрос лимитов идёт с активации; открытой позже панели отдаём снимок (в кулдауне — из кэша).
          void this.refreshUsage();
          this.pushView();
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          (e.affectsConfiguration('agentura.sessionList') ||
            e.affectsConfiguration('agentura.sidebar')) &&
          this.viewWrites === 0
        )
          this.pushView();
      }),
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

  private pushView(): void {
    const v = readSettings(vscode.workspace.getConfiguration('agentura'));
    this.post({
      type: 'sidebar.view',
      view: v['sessionList.view'],
      context: v['sessionList.context'],
      time: v['sessionList.time'],
      top: v['sidebar.top'],
    });
  }

  private async setListView(value: unknown): Promise<void> {
    // вид перекрыт настройкой рабочей папки: запись в Global ничего не изменит — говорим об этом, а не молчим
    if (
      overriddenKeys(vscode.workspace.getConfiguration('agentura')).includes('sessionList.view')
    ) {
      void vscode.window.showInformationMessage(hostStrings(currentLanguage()).overriddenView);
      if (this.viewWrites === 0) this.pushView(); // кнопка вернётся к фактическому виду
      return;
    }
    this.viewWrites++;
    try {
      const checked = await writeSetting(
        vscode.workspace.getConfiguration('agentura'),
        'sessionList.view',
        value,
        vscode.ConfigurationTarget.Global,
      );
      if (!checked.ok) this.log.warn(`agentura.sessionList.view: ${checked.error}`);
    } catch (e) {
      this.log.warn(`не удалось записать agentura.sessionList.view: ${String(e)}`);
    } finally {
      this.viewWrites--;
    }
    // фактическое значение: запись отклонена или перекрыта настройкой рабочей папки — кнопка вернётся к нему
    if (this.viewWrites === 0) this.pushView();
  }

  private async rename(sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) return;
    try {
      await this.sessions.rename(sessionId, clean);
      ChatPanel.renamed(sessionId, clean);
    } catch (e) {
      this.log.warn(`переименование ${sessionId}: ${String(e)}`);
      void vscode.window.showWarningMessage(hostStrings(currentLanguage()).renameFailed(String(e)));
    }
  }

  /** Кнопка ↻ в боковой панели и команда «Обновить лимиты». */
  async refreshUsage(): Promise<void> {
    const snap = await this.usage.refresh();
    if (snap.error) this.log.warn(`Лимиты не обновились: ${snap.error}`);
    else this.log.info(`Лимиты: данные на ${new Date(snap.updatedAt).toLocaleTimeString(hostStrings(currentLanguage()).locale)}`);
    this.post({ type: 'limits.update', ...snap });
  }
}
