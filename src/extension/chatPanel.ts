import * as vscode from 'vscode';
import { ClaudeAdapter } from '../agent/claude/adapter';
import type { AgentAdapter } from '../agent/types';
import type { LimitsSource } from '../data/limits';
import { TranscriptCache, listSessionRows, toSummary, type LiveSessions } from '../data/sessions';
import { postToWebview } from '../protocol';
import { ChatController } from './chatController';
import { EditorContextTracker } from './editorContext';
import type { UsageService } from './usage';
import type { Logger } from './logger';
import { attachMessaging, renderWebview, webviewOptions } from './webviewHost';
import { WorkspaceFiles } from './workspaceFiles';

export const CHAT_VIEW_TYPE = 'agentura.chat';

/** Общее для всех вкладок окна: адаптер агента и реестр живых сессий. */
export interface ChatServices {
  adapter: AgentAdapter;
  live: LiveSessions;
  transcripts: TranscriptCache;
  usage: UsageService;
  limits: LimitsSource;
}

export function createAdapter(log: Logger): AgentAdapter {
  const cfg = () => vscode.workspace.getConfiguration('agentura');
  return new ClaudeAdapter({
    executablePath: cfg().get<string>('claudeExecutable') || undefined,
    clientApp: 'agentura',
    log: (level, message) => log[level](message),
  });
}

/** Вкладка чата: одна на окно, повторное открытие показывает существующую. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly controller: ChatController;

  static show(context: vscode.ExtensionContext, log: Logger, services: ChatServices): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(
        'Agentura: откройте папку проекта, чтобы начать сессию.',
      );
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      'Agentura',
      vscode.ViewColumn.Beside,
      { ...webviewOptions(context.extensionUri), retainContextWhenHidden: true },
    );
    ChatPanel.current = new ChatPanel(panel, context, log, services, folder);
  }

  /** Команда «Новая сессия»: открыть вкладку и начать сессию заново. */
  static startNew(context: vscode.ExtensionContext, log: Logger, services: ChatServices): void {
    const existing = ChatPanel.current;
    ChatPanel.show(context, log, services);
    if (existing) existing.controller.newSession(true);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
    services: ChatServices,
    folder: vscode.WorkspaceFolder,
  ) {
    const version = String(context.extension.packageJSON.version);
    const files = new WorkspaceFiles(folder.uri);
    this.controller = new ChatController({
      adapter: services.adapter,
      cwd: folder.uri.fsPath,
      project: folder.name,
      post: (m) => postToWebview(panel.webview, m),
      setTitle: (t) => (panel.title = t),
      log,
      settings: () => {
        const cfg = vscode.workspace.getConfiguration('agentura');
        return {
          defaultModel: cfg.get<string>('defaultModel') || undefined,
          allowBypass: cfg.get<boolean>('allowBypassPermissions', false),
          contextThresholds: cfg.get<number[]>('contextThresholds', [120000, 150000]),
        };
      },
      usage: services.usage,
      observeLimits: (windows) => services.limits.observeEngine(windows),
      findFiles: (q) => files.find(q),
      pickFiles: () => files.pick(),
      readSelection: (a) => files.readSelection(a),
      listRecent: async () =>
        (
          await listSessionRows(services.adapter, {
            cwd: folder.uri.fsPath,
            live: services.live,
            cache: services.transcripts,
            onError: (id, e) => log.debug(`транскрипт ${id}: ${String(e)}`),
          })
        )
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
          .map(toSummary),
      showSessions: () => void vscode.commands.executeCommand('workbench.view.extension.agentura'),
      live: services.live,
    });

    panel.webview.html = renderWebview(panel.webview, context.extensionUri, 'chat', 'Agentura');
    this.disposables.push(
      attachMessaging(panel.webview, 'chat', version, log, (m) => {
        // 'ready' уже обработан в attachMessaging (init); остальное — контроллеру
        void this.controller.handle(m).catch((e) => log.error(`${m.type}: ${String(e)}`));
      }),
      // автоопрос лимитов (раз в `usagePollMinutes`) доходит и до открытого чата
      {
        dispose: services.usage.onUpdate((snap) =>
          postToWebview(panel.webview, { type: 'limits.update', ...snap }),
        ),
      },
      files.watch(),
      new EditorContextTracker(files, (ctx) => this.controller.postEditorContext(ctx)),
      { dispose: () => this.controller.dispose() },
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.controller.start();
    log.info('Вкладка чата открыта');
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}
