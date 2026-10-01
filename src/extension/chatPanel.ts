import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { resolveExecutable } from '../agent/claude/executable';
import { ClaudeAdapter } from '../agent/claude/adapter';
import type { AgentAdapter } from '../agent/types';
import type { LimitsSource } from '../data/limits';
import type { LiveSessions, TranscriptCache } from '../data/sessions';
import { postToWebview } from '../protocol';
import { DEFAULT_THRESHOLDS, thresholdsError } from '../settings';
import type { AccountService } from './account';
import { ChatController } from './chatController';
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
import type { Logger } from './logger';
import { attachMessaging, renderWebview, webviewOptions } from './webviewHost';
import { WorkspaceFiles } from './workspaceFiles';
import { writeImageTemp } from './imageFiles';
import { fileName } from '../shared/files';
import {
  dropAllowed,
  MAX_DROPPED,
  MAX_PICK_BYTES,
  mergePicked,
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
}

export function createAdapter(log: Logger): AgentAdapter {
  const cfg = () => vscode.workspace.getConfiguration('agentura');
  // `.vsix` без бинарника движка: настройка → системный `claude` (с проверкой версии). Найденный путь
  // кэшируется по значению настройки; «не нашли» не кэшируется (поставил claude — следующая вкладка
  // его подхватит без перезагрузки окна), предупреждение — один раз на значение настройки.
  let cached: { setting: string; path: string } | undefined;
  let warnedFor: string | undefined;
  const executablePath = (): string | undefined => {
    const setting = cfg().get<string>('claudeExecutable') ?? '';
    if (cached?.setting === setting) return cached.path;
    const r = resolveExecutable(setting);
    if (r.path) {
      log.info(`claude: ${r.path} ${r.version ?? ''} (${r.source})`);
      cached = { setting, path: r.path };
    } else {
      log.info('claude: системный не найден, остаётся бинарник SDK');
    }
    if (r.problem && warnedFor !== setting) {
      warnedFor = setting;
      log.warn(r.problem);
      void vscode.window.showWarningMessage(`Agentura: ${r.problem}`);
    }
    return r.path;
  };
  return new ClaudeAdapter({
    executablePath,
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
    const editorColumn = (): vscode.ViewColumn =>
      panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
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
          // кривые пороги из settings.json (вкладка настроек такие не пишет) — по умолчанию
          contextThresholds: ((th) => (thresholdsError(th) ? [...DEFAULT_THRESHOLDS] : th))(
            cfg.get<number[]>('contextThresholds', [...DEFAULT_THRESHOLDS]),
          ),
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
          openLabel: 'Добавить',
        });
        return readAttachments(folder.uri.fsPath, (picked ?? []).slice(0, MAX_DROPPED));
      },
      // перетаскивание из проводника и вкладок VS Code (этап 8): uri из webview читает хост
      readUris: async (raw) => {
        const uris: vscode.Uri[] = [];
        const outside: Picked[] = [];
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
            outside.push(rejected(fileName(uri.path) || 'file', 'read'));
            continue;
          }
          // webview недоверенный: строку uri он может прислать и без жеста — читаем только файлы
          // папок воркспейса и открытых вкладок (симлинк — по тому, куда он ведёт)
          if (await dropReadable(uri)) uris.push(uri);
          else {
            log.warn(`перетаскивание: ${uri.scheme} вне рабочей папки и не во вкладке — не читаю`);
            outside.push(rejected(fileName(uri.path) || 'file', 'outside'));
          }
        }
        const read = await readAttachments(folder.uri.fsPath, uris);
        return mergePicked([read, ...outside]);
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
      live: services.live,
      // перед превью правки несохранённые изменения файла в редакторе сохраняются: дифф и сама правка
      // идут по диску, иначе они разошлись бы с тем, что видит человек (автосохранение, B-таблица features.md)
      readText: async (p) => {
        const doc = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.fsPath === p);
        if (doc) await Promise.resolve(doc.save()).catch(() => false);
        return readFile(p, 'utf8').catch(() => undefined);
      },
      // дифф и превью — в группу редактора, не поверх вкладки чата
      openDiff: (d) => services.diffs.open(d, editorColumn()),
      openText: (d) => services.diffs.openText(d, editorColumn()),
      openPreview: (p) => services.previews.open(p, editorColumn()),
      openExternal: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)),
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
    this.disposables.forEach((d) => d.dispose());
    ChatPanel.sessionsChanged(this.services);
  }
}

/** Ключ uri для сравнения с вкладками: путь диска или `scheme://authority/path`. */
function uriKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.with({ query: '', fragment: '' }).toString();
}

/** Uri открытых вкладок редактора (текст, diff, custom editor, notebook). */
function openTabKeys(): Set<string> {
  const out = new Set<string>();
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    const input = tab.input as { uri?: unknown; original?: unknown; modified?: unknown } | undefined;
    for (const u of [input?.uri, input?.original, input?.modified]) {
      if (u instanceof vscode.Uri) out.add(uriKey(u));
    }
  }
  return out;
}

/**
 * Перетащенный uri можно читать (этап 8, приёмка): внутри папки воркспейса той же схемы или файл
 * открытой вкладки. У файла диска то же проверяется и для цели симлинка — ссылка в проекте на
 * `~/.ssh/id_rsa` не читается.
 */
async function dropReadable(uri: vscode.Uri): Promise<boolean> {
  if (openTabKeys().has(uriKey(uri))) return true;
  const remote = uri.scheme !== 'file';
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === uri.scheme && f.uri.authority === uri.authority)
    .map((f) => (remote ? f.uri.path : f.uri.fsPath));
  const path = remote ? uri.path : uri.fsPath;
  if (!dropAllowed(path, roots, remote)) return false;
  if (remote) return true;
  const real = await realpath(path).catch(() => undefined);
  // нет файла — дальше `stat` даст «не прочитать»
  if (real === undefined || real === path) return true;
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
  return dropAllowed(real, realRoots);
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
