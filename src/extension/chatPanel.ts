import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ClaudeAdapter } from '../agent/claude/adapter';
import type { AgentAdapter } from '../agent/types';
import type { LimitsSource } from '../data/limits';
import type { LiveSessions, TranscriptCache } from '../data/sessions';
import { postToWebview } from '../protocol';
import type { AccountService } from './account';
import { ChatController } from './chatController';
import type { DiffDocuments } from './diffDocuments';
import { EditorContextTracker } from './editorContext';
import {
  restoredSessionId,
  routeNew,
  routeOpen,
  routeResume,
  type PanelView,
  type Route,
} from './panelRouting';
import type { SessionMemory } from './sessionMemory';
import type { SessionsService } from './sessionsService';
import type { UsageService } from './usage';
import type { Logger } from './logger';
import { attachMessaging, renderWebview, webviewOptions } from './webviewHost';
import { WorkspaceFiles } from './workspaceFiles';

export const CHAT_VIEW_TYPE = 'agentura.chat';

/** Сколько сессий уходит во вкладку чата (попап и экран empty); весь список — в боковой панели. */
const CHAT_SESSIONS = 8;

/** Общее для всех вкладок окна: адаптер агента, реестр живых сессий, список, аккаунт, память. */
export interface ChatServices {
  adapter: AgentAdapter;
  live: LiveSessions;
  transcripts: TranscriptCache;
  usage: UsageService;
  limits: LimitsSource;
  /** Нативный дифф правок агента (`agentura-diff:`), этап 5. */
  diffs: DiffDocuments;
  /** Список сессий проекта (этап 6). */
  sessions: SessionsService;
  account: AccountService;
  memory: SessionMemory;
}

export function createAdapter(log: Logger): AgentAdapter {
  const cfg = () => vscode.workspace.getConfiguration('agentura');
  return new ClaudeAdapter({
    executablePath: cfg().get<string>('claudeExecutable') || undefined,
    clientApp: 'agentura',
    log: (level, message) => log[level](message),
  });
}

interface OpenOptions {
  resumeId?: string;
  /** Вкладка создаётся без фокуса и не стартует движок, пока не станет видимой (восстановление). */
  lazy?: boolean;
  /** Готовая панель (сериализатор). */
  panel?: vscode.WebviewPanel;
}

/**
 * Вкладки чата: по одной на сессию, их может быть несколько. Сессия, уже открытая во вкладке,
 * показывается, а не поднимается второй раз (`panelRouting.ts`). Вкладки переживают перезагрузку
 * окна: сериализатор панели возобновляет сессию по id из состояния webview.
 */
export class ChatPanel {
  private static readonly panels: ChatPanel[] = [];
  private static lastActive: ChatPanel | undefined;
  private static readonly changed = new vscode.EventEmitter<void>();
  /** Сменилась сессия какой-либо вкладки или фокус — боковая панель обновляет строку `cur`. */
  static readonly onDidChange = ChatPanel.changed.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly controller: ChatController;
  private started = false;
  private lazy = false;

  /** Id сессии активной (или последней активной) вкладки — строка `cur` боковой панели. */
  static currentSessionId(): string | undefined {
    return (
      ChatPanel.panels.find((p) => p.panel.active)?.controller.sessionId ??
      ChatPanel.lastActive?.controller.sessionId
    );
  }

  private static views(): PanelView[] {
    return ChatPanel.panels.map((p) => ({
      sessionId: p.controller.sessionId,
      pristine: p.controller.pristine,
      active: p.panel.active,
    }));
  }

  private static folder(): vscode.WorkspaceFolder | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(
        'Agentura: откройте папку проекта, чтобы начать сессию.',
      );
    }
    return folder;
  }

  private static apply(
    route: Route,
    context: vscode.ExtensionContext,
    log: Logger,
    services: ChatServices,
    open: OpenOptions,
  ): ChatPanel | undefined {
    if (route.kind === 'new') {
      const folder = ChatPanel.folder();
      if (!folder) return undefined;
      const column = ChatPanel.panels.at(-1)?.panel.viewColumn ?? vscode.ViewColumn.Beside;
      const panel =
        open.panel ??
        vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, 'Agentura', column, {
          ...webviewOptions(context.extensionUri),
          retainContextWhenHidden: true,
        });
      return new ChatPanel(panel, context, log, services, folder, open);
    }
    const target = ChatPanel.panels[route.index]!;
    target.panel.reveal();
    if (route.kind === 'reuse' && open.resumeId) void target.controller.resume(open.resumeId);
    return target;
  }

  /** «Открыть чат»: показать активную вкладку или создать новую. */
  static show(
    context: vscode.ExtensionContext,
    log: Logger,
    services: ChatServices,
  ): ChatPanel | undefined {
    return ChatPanel.apply(routeOpen(ChatPanel.views()), context, log, services, {});
  }

  /** «Новая сессия»: пустая вкладка уже есть — показать её, иначе открыть новую. */
  static startNew(context: vscode.ExtensionContext, log: Logger, services: ChatServices): void {
    ChatPanel.apply(routeNew(ChatPanel.views()), context, log, services, {});
  }

  /** Возобновить сессию: открытую — показать, пустую вкладку — занять, иначе новая вкладка. */
  static resume(
    context: vscode.ExtensionContext,
    log: Logger,
    services: ChatServices,
    sessionId: string,
    from?: ChatPanel,
  ): void {
    const fromIndex = from ? ChatPanel.panels.indexOf(from) : undefined;
    const route = routeResume(ChatPanel.views(), sessionId, fromIndex);
    ChatPanel.apply(route, context, log, services, { resumeId: sessionId });
  }

  /** Кнопка `/status` боковой панели: выполнить во вкладке (активной или новой). */
  static runStatus(context: vscode.ExtensionContext, log: Logger, services: ChatServices): void {
    ChatPanel.show(context, log, services)?.controller.runCommand('status');
  }

  /** Сериализатор панели: после «Reload Window» вкладка возвращается и возобновляет свою сессию. */
  static serializer(
    context: vscode.ExtensionContext,
    log: Logger,
    services: ChatServices,
  ): vscode.WebviewPanelSerializer {
    return {
      deserializeWebviewPanel: async (panel, state: unknown) => {
        const id = restoredSessionId(
          state,
          ChatPanel.panels.map((p) => p.controller.sessionId),
          services.memory.openSessions(),
        );
        const visible = panel.visible;
        ChatPanel.apply({ kind: 'new' }, context, log, services, {
          panel,
          ...(id ? { resumeId: id } : {}),
          lazy: !visible,
        });
      },
    };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly services: ChatServices,
    folder: vscode.WorkspaceFolder,
    open: OpenOptions,
  ) {
    const version = String(context.extension.packageJSON.version);
    const files = new WorkspaceFiles(folder.uri);
    panel.webview.options = webviewOptions(context.extensionUri);
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
      listRecent: async () => (await services.sessions.summaries()).slice(0, CHAT_SESSIONS),
      showSessions: () => void vscode.commands.executeCommand('workbench.view.extension.agentura'),
      showLogs: () => log.show(),
      live: services.live,
      // перед превью правки несохранённые изменения файла в редакторе сохраняются: дифф и сама правка
      // идут по диску, иначе они разошлись бы с тем, что видит человек (автосохранение, B-таблица features.md)
      readText: async (p) => {
        const doc = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.fsPath === p);
        if (doc) await Promise.resolve(doc.save()).catch(() => false);
        return readFile(p, 'utf8').catch(() => undefined);
      },
      // дифф — в группу редактора, не поверх вкладки чата
      openDiff: (d) =>
        services.diffs.open(
          d,
          panel.viewColumn === vscode.ViewColumn.One
            ? vscode.ViewColumn.Two
            : vscode.ViewColumn.One,
        ),
      ...(open.resumeId ? { resumeId: open.resumeId } : {}),
      openSession: (id) => ChatPanel.resume(context, log, services, id, this),
      titleOf: async (id) => (await services.sessions.list()).find((r) => r.id === id)?.title,
      onSession: () => ChatPanel.sessionsChanged(services),
      onEngineVersion: (v) => {
        services.account.noteEngine(v);
        services.memory.setEngineVersion(`claude ${v}`);
      },
    });

    ChatPanel.panels.push(this);
    ChatPanel.lastActive = this;
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
      // список сессий — и во вкладку: попап «sessions» и экран empty
      {
        dispose: services.sessions.onChange((rows) =>
          postToWebview(panel.webview, {
            type: 'sessions.update',
            sessions: rows.slice(0, CHAT_SESSIONS),
            ...(this.controller.sessionId ? { current: this.controller.sessionId } : {}),
          }),
        ),
      },
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) ChatPanel.lastActive = this;
        // восстановленная фоновая вкладка: движок стартует, когда её впервые открыли
        if (e.webviewPanel.visible) this.startEngine();
        ChatPanel.sessionsChanged(services);
      }),
      files.watch(),
      new EditorContextTracker(files, (ctx) => this.controller.postEditorContext(ctx)),
      { dispose: () => this.controller.dispose() },
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    if (open.lazy) {
      // историю читаем сразу (дёшево), процесс движка — когда вкладка станет видимой
      this.lazy = true;
      this.controller.start(false);
    } else this.startEngine();
    log.info(
      open.resumeId
        ? `Вкладка чата открыта, возобновляется ${open.resumeId}`
        : 'Вкладка чата открыта',
    );
  }

  private startEngine(): void {
    if (this.started) return;
    this.started = true;
    if (this.lazy) this.controller.wake();
    else this.controller.start(true);
  }

  /** Состав или фокус вкладок изменился: память воркспейса и строка `cur` боковой панели. */
  private static sessionsChanged(services: ChatServices): void {
    const ids = ChatPanel.panels
      .map((p) => p.controller.sessionId)
      .filter((x): x is string => x !== undefined);
    services.memory.setOpenSessions(ids);
    ChatPanel.changed.fire();
  }

  /**
   * Расширение выгружается (закрытие или перезагрузка окна): закрыть процессы движка всех вкладок явно,
   * не полагаясь на то, что CLI сам заметит смерть хоста. Сами вкладки не закрываем — их вернёт сериализатор.
   */
  static stopEngines(): void {
    for (const p of ChatPanel.panels) p.controller.dispose();
  }

  /** Название сессии сменили в списке — вкладка, где она открыта, обновляет заголовок. */
  static renamed(sessionId: string, title: string): void {
    for (const p of ChatPanel.panels) {
      if (p.controller.sessionId === sessionId) p.controller.setTitle(title);
    }
  }

  private dispose(): void {
    const i = ChatPanel.panels.indexOf(this);
    if (i >= 0) ChatPanel.panels.splice(i, 1);
    if (ChatPanel.lastActive === this) ChatPanel.lastActive = ChatPanel.panels.at(-1);
    this.disposables.forEach((d) => d.dispose());
    ChatPanel.sessionsChanged(this.services);
  }
}
