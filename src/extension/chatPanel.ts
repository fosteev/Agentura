import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { samePath } from './pathKey';
import * as vscode from 'vscode';
import { EngineLocator } from './engineLocator';
import { ClaudeAdapter } from '../agent/claude/adapter';
import type { AgentAdapter } from '../agent/types';
import type { LimitsSource } from '../data/limits';
import type { LiveSessions, TranscriptCache } from '../data/sessions';
import { postToWebview } from '../protocol';
import {
  DEFAULT_AGENTS_VIEW,
  DEFAULT_FEED_STYLE,
  DEFAULT_THRESHOLDS,
  isAgentsView,
  isGitLayout,
  DEFAULT_GIT_LAYOUT,
  isFeedStyle,
  isComposerLayout,
  DEFAULT_COMPOSER_LAYOUT,
  thresholdsError,
} from '../settings';
import type { AccountService } from './account';
import { ChatController } from './chatController';
import { AgentsGraphPanel, ChatGraphSlot, graphSerializer } from './agentsGraphPanel';
import type { DiffDocuments } from './diffDocuments';
import type { PreviewPanels } from './previewPanels';
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
import type { GitService } from './git/gitService';
import { isGitRequest } from '../shared/git';
import type { Logger } from './logger';
import { hostStrings } from '../shared/l10n';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';
import { WorkspaceFiles } from './workspaceFiles';
import { writeImageTemp } from './imageFiles';
import { fileName } from '../shared/files';
import type { FileHit } from '../shared/prompt';
import { toHit } from './fileSearch';
import {
  MAX_DROPPED,
  MAX_PICK_BYTES,
  mergePicked,
  modelPath,
  parseUriList,
  readAttachment,
  rejected,
  workspaceTarget,
  writeAttachmentTemp,
  type Picked,
} from './attachFiles';

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
  /** Превью `.html` в соседней вкладке. */
  previews: PreviewPanels;
  /** Список сессий проекта (этап 6). */
  sessions: SessionsService;
  account: AccountService;
  memory: SessionMemory;
  /** Поиск `claude` (асинхронный, с прогревом). */
  engine: EngineLocator;
  /** Вкладка «git» (roadmap 12): репозитории рабочей папки над API встроенного git. */
  git: GitService;
}

export function createAdapter(log: Logger): { adapter: AgentAdapter; engine: EngineLocator } {
  const cfg = () => vscode.workspace.getConfiguration('agentura');
  // `.vsix` без бинарника движка: настройка → системный `claude` (с проверкой версии). Поиск асинхронный
  // (`EngineLocator`): прогрев при активации, первый запуск движка ждёт его результат, а не поток хоста.
  const engine = new EngineLocator({
    setting: () => cfg().get<string>('claudeExecutable') ?? '',
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    notify: (m) => void vscode.window.showWarningMessage(`Agentura: ${m}`),
    lang: currentLanguage,
  });
  const adapter = new ClaudeAdapter({
    executablePath: () => engine.path(),
    clientApp: 'agentura',
    log: (level, message) => log[level](message),
    lang: currentLanguage,
  });
  return { adapter, engine };
}

interface OpenOptions {
  resumeId?: string;
  /** Вкладка создаётся без фокуса и не стартует движок, пока не станет видимой (восстановление). */
  lazy?: boolean;
  /** Готовая панель (сериализатор). */
  panel?: vscode.WebviewPanel;
}

/** Открытый документ с несохранёнными изменениями по пути файла (сравнение — `samePath`: `fsPath`, Windows). */
function dirtyDocument(path: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.isDirty && samePath(d.uri.fsPath, path));
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
  /** Вкладка графа агентов этой вкладки чата (roadmap 11, этап 2): одна на чат. */
  private readonly graph: ChatGraphSlot;

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
      void vscode.window.showWarningMessage(hostStrings(currentLanguage()).openFolder);
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
          ...webviewOptions(context.extensionUri, userFontsDir(context)),
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

  /** Сериализатор вкладки графа агентов: к вкладке чата той же сессии или закрыть (`graphSerializer`). */
  static graphSerializer(context: vscode.ExtensionContext, log: Logger): vscode.WebviewPanelSerializer {
    return graphSerializer(context, log, () => ChatPanel.panels.map((p) => p.graph));
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
    const editorColumn = (): vscode.ViewColumn =>
      panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    panel.webview.options = webviewOptions(context.extensionUri, userFontsDir(context));
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.svg'),
    };
    this.controller = new ChatController({
      lang: currentLanguage(),
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
          // кривые пороги из settings.json (вкладка настроек такие не пишет) — по умолчанию
          contextThresholds: ((th) => (thresholdsError(th) ? [...DEFAULT_THRESHOLDS] : th))(
            cfg.get<number[]>('contextThresholds', [...DEFAULT_THRESHOLDS]),
          ),
          feedStyle: ((v) => (isFeedStyle(v) ? v : DEFAULT_FEED_STYLE))(cfg.get<unknown>('feed.style')),
          composerLayout: ((v) => (isComposerLayout(v) ? v : DEFAULT_COMPOSER_LAYOUT))(
            cfg.get<unknown>('composer.layout'),
          ),
          agentsView: ((v) => (isAgentsView(v) ? v : DEFAULT_AGENTS_VIEW))(cfg.get<unknown>('agents.view')),
          gitLayout: ((v) => (isGitLayout(v) ? v : DEFAULT_GIT_LAYOUT))(cfg.get<unknown>('git.layout')),
          defaultPermissionMode: cfg.get<string>('defaultPermissionMode'),
          defaultEffort: cfg.get<string>('defaultEffort'),
        };
      },
      usage: services.usage,
      observeLimits: (windows) => services.limits.observeEngine(windows),
      findFiles: (q) => files.find(q),
      pickFiles: () => files.pick(),
      // «+» (этапы 4 и 8): любые файлы — картинки, текст, pdf; тип решает содержимое
      pickAttachments: async () => {
        const picked = await vscode.window.showOpenDialog({
          defaultUri: folder.uri,
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: hostStrings(currentLanguage()).addLabel,
        });
        return readAttachments(folder.uri.fsPath, (picked ?? []).slice(0, MAX_DROPPED));
      },
      // перетаскивание из проводника и вкладок VS Code (этап 8): uri из webview читает хост.
      // Читаем любой путь — решение владельца 2026-10-01; webview может запросить чтение произвольного
      // файла. Остаются: схема, только обычные файлы, лимиты размера по stat, 128 МБ на действие.
      // Папка не читается — уходит чипом-ссылкой (этап 8b).
      readUris: async (raw) => {
        const uris: vscode.Uri[] = [];
        const folders: FileHit[] = [];
        const rejects: Picked[] = [];
        for (const u of parseUriList(raw)) {
          let uri: vscode.Uri;
          try {
            uri = vscode.Uri.parse(u, true);
          } catch {
            log.warn('перетаскивание: не uri');
            continue;
          }
          // только файлы диска (в удалённом окне — схема папки)
          if (uri.scheme !== 'file' && uri.scheme !== folder.uri.scheme) {
            log.warn(`перетаскивание: схема ${uri.scheme} не поддержана`);
            rejects.push(rejected(fileName(uri.path) || 'file', 'read'));
            continue;
          }
          const st = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(
            (x) => x,
            () => undefined,
          );
          if (st && (st.type & vscode.FileType.Directory) !== 0) {
            const p = uri.scheme === 'file' ? uri.fsPath : uri.path;
            folders.push(
              toHit(
                modelPath(folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.path, p),
                true,
              ),
            );
          } else uris.push(uri);
        }
        const read = await readAttachments(folder.uri.fsPath, uris);
        return { ...mergePicked([read, ...rejects]), ...(folders.length ? { folders } : {}) };
      },
      // просмотр миниатюры: временный файл в storage расширения (не в рабочей папке), вкладка редактора
      openImage: async (img) => {
        const dir = vscode.Uri.joinPath(context.globalStorageUri, 'images').fsPath;
        const path = await writeImageTemp(dir, img);
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path), editorColumn());
      },
      // чип файла в ленте (этап 8): из рабочей папки — сам файл, иначе — копия в storage расширения
      openFile: async (f) => {
        const inside = workspaceTarget(folder.uri.fsPath, f.path);
        let target: vscode.Uri | undefined;
        if (inside) {
          const exists = await Promise.resolve(
            vscode.workspace.fs.stat(vscode.Uri.file(inside)),
          ).then(
            () => true,
            () => false,
          );
          if (exists) target = vscode.Uri.file(inside);
        }
        if (!target && f.data) {
          const dir = vscode.Uri.joinPath(context.globalStorageUri, 'attachments').fsPath;
          target = vscode.Uri.file(await writeAttachmentTemp(dir, { ...f, data: f.data }));
        }
        if (!target && isAbsolute(f.path)) target = vscode.Uri.file(f.path);
        if (!target) {
          log.warn(`файл не открыт: ${f.path} — нет ни файла, ни копии`);
          return;
        }
        await vscode.commands.executeCommand('vscode.open', target, editorColumn());
      },
      readSelection: (a) => files.readSelection(a),
      listRecent: async () => (await services.sessions.summaries()).slice(0, CHAT_SESSIONS),
      showSessions: () => void vscode.commands.executeCommand('workbench.view.extension.agentura'),
      showLogs: () => log.show(),
      engine: { ready: () => services.engine.ready() },
      openSettings: () => void vscode.commands.executeCommand('agentura.openSettings'),
      live: services.live,
      // превью — по тексту из редактора, если там несохранённые правки: именно он попадёт на диск.
      // Сохраняет файл `saveFile` — когда человек разрешил правку, а не когда показана карточка
      readText: async (p) => {
        const doc = dirtyDocument(p);
        if (doc) return doc.getText();
        return readFile(p, 'utf8').catch(() => undefined);
      },
      saveFile: async (p) => {
        await Promise.resolve(dirtyDocument(p)?.save()).catch(() => false);
      },
      // дифф и превью — в группу редактора, не поверх вкладки чата
      openDiff: (d) => services.diffs.open(d, editorColumn()),
      openChanges: (title, files) => services.diffs.openChanges(title, files, editorColumn()),
      openText: (d) => services.diffs.openText(d, editorColumn()),
      openPreview: (p) => services.previews.open(p, editorColumn()),
      openExternal: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)),
      ...(open.resumeId ? { resumeId: open.resumeId } : {}),
      openSession: (id) => ChatPanel.resume(context, log, services, id, this),
      titleOf: async (id) => (await services.sessions.list()).find((r) => r.id === id)?.title,
      onSession: () => {
        this.graph.claimPending();
        ChatPanel.sessionsChanged(services);
      },
      openGraph: (agentId) => this.graph.show(agentId),
      graphSnapshot: (m) => this.graph.snapshot(m),
      onEngineVersion: (v) => {
        services.account.noteEngine(v);
        services.memory.setEngineVersion(`claude ${v}`);
      },
    });

    this.graph = new ChatGraphSlot(
      {
        sessionId: () => this.controller.sessionId,
        post: (m) => postToWebview(panel.webview, m),
        // действия графа — тому же контроллеру, что и сообщения webview этой вкладки
        handle: (m) => this.controller.handle(m),
      },
      () => AgentsGraphPanel.create(context, log),
    );
    ChatPanel.panels.push(this);
    ChatPanel.lastActive = this;
    panel.webview.html = renderWebview(panel.webview, context.extensionUri, 'chat', 'Agentura', currentLanguage());
    // вкладка «git»: снимок на каждое изменение репозиториев рабочей папки (cwd панели)
    const git = services.git.attach(folder.uri.fsPath, (m) => postToWebview(panel.webview, m));
    this.disposables.push(
      attachMessaging(panel.webview, 'chat', version, log, (m) => {
        // действия вкладки «git» — сервису, сессия движка для них не нужна
        if (isGitRequest(m)) {
          void git.handle(m).catch((e) => log.error(`${m.type}: ${String(e)}`));
          return;
        }
        // 'ready' уже обработан в attachMessaging (init); остальное — контроллеру
        void this.controller.handle(m).catch((e) => log.error(`${m.type}: ${String(e)}`));
        if (m.type === 'ready') {
          // webview чата пересоздан — он не помнит, что граф открыт
          this.graph.chatReady();
          git.refresh();
        }
      }),
      git,
      // автоопрос лимитов (раз в `usagePollMinutes`) доходит и до открытого чата
      {
        dispose: services.usage.onUpdate((snap) =>
          postToWebview(panel.webview, { type: 'limits.update', ...snap }),
        ),
      },
      // список сессий — и во вкладку: попап «sessions» и экран empty
      {
        dispose: services.sessions.onChange((rows) => {
          const id = this.controller.sessionId;
          postToWebview(panel.webview, {
            type: 'sessions.update',
            sessions: rows.slice(0, CHAT_SESSIONS),
            ...(id ? { current: id } : {}),
          });
          // без названия список подставляет id сессии — такое во вкладку не тянем
          const title = id ? rows.find((r) => r.id === id)?.title : undefined;
          if (title && title !== id) this.controller.syncTitle(title);
        }),
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
    this.graph.claimPending();
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

  /** Настройки `agentura.*` изменились: открытые вкладки чата получают свежие `chat.info`. */
  static settingsChanged(): void {
    for (const p of ChatPanel.panels) p.controller.pushInfo();
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
    // граф показывает данные этой вкладки — без неё ему нечего показывать
    this.graph.close();
    this.disposables.forEach((d) => d.dispose());
    ChatPanel.sessionsChanged(this.services);
  }
}

/** Прочитать выбранные или перетащенные файлы через `workspace.fs` (этап 8 roadmap 0.2). */
async function readAttachments(cwd: string, uris: readonly vscode.Uri[]): Promise<Picked> {
  const out: Picked[] = [];
  let budget = MAX_PICK_BYTES;
  for (const uri of uris) {
    const st = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(
      (x) => x,
      () => undefined,
    );
    const name = fileName(uri.path) || 'file';
    const isDir = st ? (st.type & vscode.FileType.Directory) !== 0 : false;
    // только обычные файлы: у `/dev/zero` размер 0, а чтение бесконечно, FIFO вешает хост
    if (st && !isDir && (st.type & vscode.FileType.File) === 0) {
      out.push(rejected(name, 'read'));
      continue;
    }
    // всё «+»/перетаскивание читается в память и уходит одним сообщением — общий потолок до чтения
    if (st && !isDir && st.size > budget) {
      out.push(rejected(name, 'total'));
      continue;
    }
    if (st && !isDir) budget -= st.size;
    out.push(
      await readAttachment(cwd, {
        fsPath: uri.scheme === 'file' ? uri.fsPath : uri.path,
        ...(st ? { size: st.size } : {}),
        isDir,
        read: () => Promise.resolve(vscode.workspace.fs.readFile(uri)),
      }),
    );
  }
  return mergePicked(out);
}
