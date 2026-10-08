import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { samePath } from './pathKey';
import * as vscode from 'vscode';
import { EngineLocator } from './engineLocator';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { CODEX_NOT_FOUND, resolveCodexExecutable } from '../agent/codex/executable';
import { AntigravityAdapter } from '../agent/antigravity/adapter';
import { AGY_NOT_FOUND, resolveAgyExecutable } from '../agent/antigravity/executable';
import type { AgyStateStore } from '../agent/antigravity/sessionIndex';
import type { AgentAdapter, AgentProvider, SessionRef } from '../agent/types';
import { readOAuthToken, type LimitsSource } from '../data/limits';
import type { LiveSessions, TranscriptCache } from '../data/sessions';
import { postToWebview } from '../protocol';
import {
  DEFAULT_AGENTS_VIEW,
  DEFAULT_FEED_STYLE,
  DEFAULT_THRESHOLDS,
  isAgentsView,
  isGitLayout,
  DEFAULT_GIT_LAYOUT,
  isTaskCardMode,
  DEFAULT_TASK_CARD,
  readSettings,
  isFeedStyle,
  isComposerLayout,
  DEFAULT_COMPOSER_LAYOUT,
  thresholdsError,
  isProvider,
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
import type { ContextRequest } from './contextRequest';
import { nextTabTask, parseTaskKey, routeTaskOpen, taskChatRows, taskKeyOf, type TabTask, type TaskGroups, type TaskKey, type TaskMeta } from './taskGroups';
import { isTaskRequest, type TaskChatsMessage } from '../shared/task';
import { TaskTab } from './jira/taskTab';
import type { TaskService } from './jira/taskService';
import type { JiraSources } from './jira/source';
import type { SessionMemory } from './sessionMemory';
import type { SessionsService } from './sessionsService';
import type { UsageService } from './usage';
import type { AgyQuotaService } from './agyQuota';
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
  /** Адаптер Codex (лениво); `adapter` — Claude. */
  codexAdapter: () => AgentAdapter;
  /** Адаптер Antigravity (лениво). */
  antigravityAdapter: () => AgentAdapter;
  live: LiveSessions;
  transcripts: TranscriptCache;
  usage: UsageService;
  limits: LimitsSource;
  /** Квота Antigravity (`agy -p "/usage"`, не чаще раза в 10 минут). */
  agyQuota: AgyQuotaService;
  /** Нативный дифф правок агента (`agentura-diff:`), этап 5. */
  diffs: DiffDocuments;
  /** Превью `.html` в соседней вкладке. */
  previews: PreviewPanels;
  /** Список сессий проекта (этап 6). */
  sessions: SessionsService;
  account: AccountService;
  memory: SessionMemory;
  /** Группы чатов по задачам Jira (roadmap 19). */
  taskGroups: TaskGroups;
  /** Карточка задачи и лента изменений для вкладок (этап 2): источник Jira, кеш, опрос. */
  tasks: TaskService;
  /** Источники Jira: Jiraffe и свои подключения (решения 3, 4). */
  jira: JiraSources;
  /** Поиск `claude` (асинхронный, с прогревом). */
  engine: EngineLocator;
  /** Поиск `codex` (без прогрева: нужен только тому, кто выбрал Codex). */
  codexEngine: EngineLocator;
  /** Поиск `agy` (без прогрева, как Codex: `ready()` перед стартом сессии даёт и версию для `session.init`). */
  antigravityEngine: EngineLocator;
  /** Вкладка «git» (roadmap 12): репозитории рабочей папки над API встроенного git. */
  git: GitService;
}

export function createAdapter(
  log: Logger,
  clientVersion?: string,
  state?: AgyStateStore,
): {
  adapter: AgentAdapter;
  /** Codex-адаптер создаётся при первом обращении: пока никто не выбрал Codex, его нет вовсе. */
  codexAdapter: () => AgentAdapter;
  /** Antigravity-адаптер — тоже лениво. */
  antigravityAdapter: () => AgentAdapter;
  engine: EngineLocator;
  codexEngine: EngineLocator;
  antigravityEngine: EngineLocator;
} {
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
  // отдельный локатор: ошибки и кэш «claude» и «codex» не смешиваются
  const codexEngine = new EngineLocator({
    setting: () => cfg().get<string>('codexExecutable') ?? '',
    // «не найден» — текст на языке интерфейса (карточка в ленте); прочие проблемы резолвера остаются английскими
    resolve: async (s) => {
      const r = await resolveCodexExecutable(s);
      return r.problem === CODEX_NOT_FOUND ? { ...r, problem: hostStrings(currentLanguage()).codexNotFound } : r;
    },
    name: 'codex',
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    lang: currentLanguage,
  });
  // версия `agy` для `session.init.engineVersion`: запоминаем из успешного поиска (адаптер читает её лениво)
  let agyVersion: string | undefined;
  const antigravityEngine = new EngineLocator({
    setting: () => cfg().get<string>('antigravityExecutable') ?? '',
    resolve: async (s) => {
      const r = await resolveAgyExecutable(s);
      if (r.version) agyVersion = r.version;
      return r.problem === AGY_NOT_FOUND ? { ...r, problem: hostStrings(currentLanguage()).antigravityNotFound } : r;
    },
    name: 'agy',
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    lang: currentLanguage,
  });
  const adapter = new ClaudeAdapter({
    executablePath: () => engine.path(),
    clientApp: 'agentura',
    log: (level, message) => log[level](message),
    lang: currentLanguage,
    // Remote Control (roadmap 17): токен — при каждом включении и обновлении JWT, настройки — на лету
    remote: {
      readToken: () => readOAuthToken(),
      namePrefix: () => cfg().get<string>('remoteControlNamePrefix') ?? '',
      allowBypass: () => cfg().get<boolean>('allowBypassPermissions', false),
    },
  });
  let codex: AgentAdapter | undefined;
  const codexAdapter = (): AgentAdapter =>
    (codex ??= new CodexAdapter({
      executablePath: () => codexEngine.path(),
      log: (level, message) => log[level](message),
      ...(clientVersion ? { clientVersion } : {}),
    }));
  let agy: AgentAdapter | undefined;
  const antigravityAdapter = (): AgentAdapter =>
    (agy ??= new AntigravityAdapter({
      executablePath: () => antigravityEngine.path(),
      engineVersion: () => agyVersion,
      log: (level, message) => log[level](message),
      ...(state ? { state } : {}),
    }));
  return { adapter, codexAdapter, antigravityAdapter, engine, codexEngine, antigravityEngine };
}

/** `agentura.defaultProvider` (application-scope: из настроек рабочей папки не читается); кривое значение — `claude`. */
function defaultProvider(): AgentProvider {
  const v = vscode.workspace.getConfiguration('agentura').get<unknown>('defaultProvider');
  return isProvider(v) ? v : 'claude';
}

interface OpenOptions {
  resumeId?: string;
  /** Движок возобновляемой сессии; нет — `claude`. */
  provider?: AgentProvider;
  /** Вкладка создаётся без фокуса и не стартует движок, пока не станет видимой (восстановление). */
  lazy?: boolean;
  /** Готовая панель (сериализатор). */
  panel?: vscode.WebviewPanel;
  /** Колонка для новой/показываемой вкладки (сплит `tasks.card = split`: чат рядом с карточкой Jiraffe). */
  column?: vscode.ViewColumn;
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
  /** Движок сессии вкладки: живёт в контроллере (меняется выбором в пустой вкладке). */
  private get provider(): AgentProvider {
    return this.controller.provider;
  }
  private started = false;
  private lazy = false;
  /** Задача (`openWithContext`, «Привязать к задаче»): первая сессия вкладки входит в её группу. */
  private pendingTask: TabTask | undefined;
  /** Группа, в которую вход вкладки уже состоит (для `/clear`: новая сессия остаётся в ней). */
  private member: TabTask | undefined;
  private readonly taskTab: TaskTab;
  /** Вкладка графа агентов этой вкладки чата (roadmap 11, этап 2): одна на чат. */
  private readonly graph: ChatGraphSlot;

  /** Id сессии активной (или последней активной) вкладки — строка `cur` боковой панели. */
  static currentSessionId(): string | undefined {
    return (
      ChatPanel.panels.find((p) => p.panel.active)?.controller.sessionId ??
      ChatPanel.lastActive?.controller.sessionId
    );
  }

  /** Движок активной (или последней активной) вкладки — «текущий» для лимитов боковой панели. */
  static currentProvider(): AgentProvider | undefined {
    const p = ChatPanel.panels.find((x) => x.panel.active) ?? ChatPanel.lastActive;
    return p?.provider;
  }

  private static views(): PanelView[] {
    return ChatPanel.panels.map((p) => ({
      sessionId: p.controller.sessionId,
      provider: p.provider,
      // вкладка, ждущая задачу (контекст уже в поле ввода), — не пустая: ни чужой сессии, ни другой задаче её не отдаём
      pristine: p.controller.pristine && !p.pendingTask,
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
      const column = open.column ?? ChatPanel.panels.at(-1)?.panel.viewColumn ?? vscode.ViewColumn.Beside;
      const panel =
        open.panel ??
        vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, 'Agentura', column, {
          ...webviewOptions(context.extensionUri, userFontsDir(context)),
          retainContextWhenHidden: true,
        });
      return new ChatPanel(panel, context, log, services, folder, open);
    }
    const target = ChatPanel.panels[route.index]!;
    target.panel.reveal(open.column);
    if (route.kind === 'reuse' && open.resumeId) {
      void target.controller.resume(open.resumeId, true, open.provider ?? 'claude');
    }
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
    session: string | SessionRef,
    from?: ChatPanel,
    column?: vscode.ViewColumn,
  ): ChatPanel | undefined {
    // без провайдера — `claude` (старые вызовы: боковая панель, команда, память воркспейса)
    const ref: SessionRef = typeof session === 'string' ? { provider: 'claude', id: session } : session;
    const fromIndex = from ? ChatPanel.panels.indexOf(from) : undefined;
    const route = routeResume(ChatPanel.views(), ref, fromIndex);
    return ChatPanel.apply(route, context, log, services, {
      resumeId: ref.id,
      provider: ref.provider,
      ...(column ? { column } : {}),
    });
  }

  /**
   * Чат с контекстом снаружи (`agentura.openWithContext`, «Открыть в Agentura» в Jiraffe). Есть задача (`task` или
   * `sessionKey` вида `jiraffe:<инстанс>:<KEY>`) — чат входит в её группу: `session` = id возобновляет этот чат,
   * `'new'` открывает новую вкладку, без поля — последний чат группы (если есть). Чат попадает в группу, когда
   * движок пришлёт id сессии (`onSession`). Без задачи — всегда новая вкладка. `prompt` — в поле ввода, если оно пустое.
   */
  static async openWithContext(
    context: vscode.ExtensionContext,
    log: Logger,
    services: ChatServices,
    req: ContextRequest,
  ): Promise<void> {
    const legacy = parseTaskKey(req.sessionKey);
    const meta: TaskMeta | undefined =
      req.task ??
      (legacy ? { key: legacy.key, instanceId: legacy.instanceId, title: legacy.key, url: '' } : undefined);
    const taskKey = meta ? taskKeyOf(meta.instanceId, meta.key) : undefined;
    // `tasks.card = split` и источник Jiraffe: карточка Jiraffe открывается в активной колонке, чат — справа от неё
    const column = taskKey && meta ? await ChatPanel.openCardBeside(services, taskKey) : undefined;
    if (taskKey && meta) {
      const route = routeTaskOpen(services.taskGroups.group(taskKey), await services.sessions.list(), req.session);
      if (route.kind === 'resume') {
        services.taskGroups.updateMeta(taskKey, meta);
        const panel = ChatPanel.resume(context, log, services, route.ref, undefined, column);
        if (panel && req.prompt) panel.controller.prefill(req.prompt);
        return;
      }
      // вкладка этой задачи ещё не отправила ни одного сообщения (повторный клик, `'new'`) — она и есть новый чат
      const waiting = ChatPanel.panels.find((p) => !p.controller.sessionId && p.pendingTask?.taskKey === taskKey);
      if (waiting) {
        waiting.panel.reveal(column);
        if (req.prompt) waiting.controller.prefill(req.prompt);
        return;
      }
    }
    const panel = ChatPanel.apply(routeNew(ChatPanel.views()), context, log, services, column ? { column } : {});
    if (!panel) return;
    if (taskKey && meta) panel.bind(taskKey, meta);
    panel.controller.attachFiles([
      { name: req.name, path: req.name, kind: 'text', data: req.context, size: req.context.length },
    ]);
    if (req.prompt) panel.controller.prefill(req.prompt);
  }

  /**
   * Сплит (`agentura.tasks.card = split`, roadmap 19, этап 5): при источнике Jiraffe открыть его карточку задачи в активной
   * колонке и вернуть `Beside` — туда пойдёт чат. Иное значение настройки, не Jiraffe, нет `openIssue` или сбой — `undefined`
   * (чат открывается как обычно, карточка остаётся вкладкой «задача» панели).
   */
  private static async openCardBeside(services: ChatServices, taskKey: TaskKey): Promise<vscode.ViewColumn | undefined> {
    const mode = readSettings(vscode.workspace.getConfiguration('agentura'))['tasks.card'];
    if (mode !== 'split') return undefined;
    const parsed = parseTaskKey(taskKey);
    const src = services.tasks.sourceFor(taskKey);
    if (!parsed || src?.kind !== 'jiraffe' || !src.openIssue) return undefined;
    try {
      await src.openIssue(parsed.instanceId, parsed.key, false);
      return vscode.ViewColumn.Beside;
    } catch {
      return undefined;
    }
  }

  /**
   * Привязать чат к задаче. Сессия уже есть — входит в группу сразу; иначе — когда движок пришлёт её id.
   * Заголовок вкладки получает ключ задачи в обоих случаях.
   */
  bind(taskKey: TaskKey, meta: TaskMeta): void {
    const id = this.controller.sessionId;
    if (id) {
      this.services.taskGroups.add(taskKey, meta, { provider: this.provider, id }, Date.now());
      this.pendingTask = undefined;
      this.member = { taskKey, meta };
    } else {
      this.pendingTask = { taskKey, meta };
      this.member = undefined;
    }
    this.controller.setTask(meta.key);
    this.syncTask();
    ChatPanel.sessionsChanged(this.services);
  }

  /** Ключ задачи вкладки (группа или ожидание первой сессии); нет — чат вне задач. */
  get task(): string | undefined {
    return this.controller.task;
  }

  /** Снять привязку: из группы, из ожидания и из заголовка. */
  unbind(): void {
    const id = this.controller.sessionId;
    if (id) this.services.taskGroups.remove(id);
    this.pendingTask = undefined;
    this.member = undefined;
    this.controller.setTask(undefined);
    this.syncTask();
    ChatPanel.sessionsChanged(this.services);
  }

  /** Вкладка для команд «Привязать к задаче» / «Отвязать»: активная, иначе последняя активная. */
  static target(): ChatPanel | undefined {
    return ChatPanel.panels.find((p) => p.panel.active) ?? ChatPanel.lastActive;
  }

  /** Вкладка, в которой открыта сессия `id` (строка списка в боковой панели). */
  static panelOf(id: string): ChatPanel | undefined {
    return ChatPanel.panels.find((p) => p.controller.sessionId === id);
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
        const ref = restoredSessionId(
          state,
          ChatPanel.panels.map((p) =>
            p.controller.sessionId ? { provider: p.provider, id: p.controller.sessionId } : undefined,
          ),
          services.memory.openSessions(),
        );
        const visible = panel.visible;
        ChatPanel.apply({ kind: 'new' }, context, log, services, {
          panel,
          ...(ref ? { resumeId: ref.id, provider: ref.provider } : {}),
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
      // возобновляемая сессия — своего движка; новая вкладка — `agentura.defaultProvider`
      provider: open.provider ?? defaultProvider(),
      adapterFor: (p) =>
        p === 'codex' ? services.codexAdapter() : p === 'antigravity' ? services.antigravityAdapter() : services.adapter,
      engineFor: (p) =>
        p === 'codex' ? services.codexEngine : p === 'antigravity' ? services.antigravityEngine : undefined,
      // только User (`Global`): настройка application-scope; отказ (политика, битый settings.json) — в журнал.
      // `claude` — значение по умолчанию: ключ убираем, а не пишем его явно
      rememberProvider: (p) => {
        void Promise.resolve()
          .then(() =>
            vscode.workspace
              .getConfiguration('agentura')
              .update('defaultProvider', p === 'claude' ? undefined : p, vscode.ConfigurationTarget.Global),
          )
          .catch((e: unknown) => log.warn(`agentura.defaultProvider не записан: ${String(e)}`));
        // движок вкладки сменился (контроллер ставит его сразу после): боковая панель перечитывает `currentProvider`
        queueMicrotask(() => ChatPanel.changed.fire());
      },
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
          taskCard: ((v) => (isTaskCardMode(v) ? v : DEFAULT_TASK_CARD))(cfg.get<unknown>('tasks.card')),
          defaultPermissionMode: cfg.get<string>('defaultPermissionMode'),
          defaultEffort: cfg.get<string>('defaultEffort'),
          remoteControl: cfg.get<boolean>('remoteControl', false),
        };
      },
      usage: services.usage,
      agyQuota: services.agyQuota,
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
      openSession: (id, provider) => ChatPanel.resume(context, log, services, { provider, id }, this),
      // общий список сайдбара (Claude, Codex, Antigravity); беседа agy, которой в нём ещё нет, — из списка её адаптера
      titleOf: async (id, p) => {
        const listed = (await services.sessions.list()).find((r) => r.id === id)?.title;
        if (p !== 'antigravity') return listed;
        // у беседы agy без заголовка и превью адаптер подставляет id — такой заголовок не показываем
        if (listed) return listed !== id ? listed : undefined;
        const row = (await services.antigravityAdapter().listSessions(folder.uri.fsPath)).find((r) => r.id === id);
        return row && row.title !== id ? row.title : undefined;
      },
      onSession: (id, why) => {
        // /clear — новая сессия остаётся в группе задачи; сбой возобновления — нет (`nextTabTask`)
        const next = nextTabTask(
          { ...(this.pendingTask ? { pending: this.pendingTask } : {}), ...(this.member ? { member: this.member } : {}) },
          { ...(id ? { id } : {}), clear: why === 'clear' },
          (sid) => services.taskGroups.groupOf(sid),
        );
        if (next.join && id) {
          // метаданные группы свежее запомненных вкладкой (опрос обновил статус/название, пока шёл прежний чат)
          const meta = services.taskGroups.group(next.join.taskKey)?.task ?? next.join.meta;
          services.taskGroups.add(next.join.taskKey, meta, { provider: this.provider, id }, Date.now());
        }
        this.pendingTask = next.pending;
        this.member = next.member;
        this.controller.setTask((next.pending ?? next.member)?.meta.key);
        this.syncTask();
        this.graph.claimPending();
        ChatPanel.sessionsChanged(services);
      },
      onEvent: (e) => this.taskTab.onAgentEvent(e),
      openGraph: (agentId) => this.graph.show(agentId),
      graphSnapshot: (m) => this.graph.snapshot(m),
      onEngineVersion: (v) => {
        services.account.noteEngine(v);
        services.memory.setEngineVersion(`claude ${v}`);
      },
    });

    // карточка и лента задачи: подписка на `TaskService`, пока вкладка в группе (или ждёт её)
    this.taskTab = new TaskTab({
      service: services.tasks,
      groups: services.taskGroups,
      sessionId: () => this.controller.sessionId,
      pending: () => this.pendingTask?.taskKey,
      visible: () => panel.visible,
      turns: () => this.controller.turns(),
      post: (m) => postToWebview(panel.webview, m),
      prefill: (text) => this.controller.prefill(text),
      openUrl: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)),
      connect: () => void vscode.commands.executeCommand('agentura.jira.connect'),
    });
    // возобновляемая сессия (клик в списке, Reload Window) из группы задачи — ключ задачи в заголовке сразу
    if (open.resumeId) {
      const g = services.taskGroups.groupOf(open.resumeId);
      this.member = g ? { taskKey: g.taskKey, meta: g.group.task } : undefined;
      this.controller.setTask(g?.group.task.key);
    }

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
        // «＋ новый чат» блока «Чаты по задаче» — как «＋» группы в боковой панели; ключ из webview недоверенный
        if (m.type === 'task.newChat') {
          if (parseTaskKey(m.taskKey)) void vscode.commands.executeCommand('agentura.chatForTask', m.taskKey);
          return;
        }
        // чат из того же блока: только сессия группы задачи этой вкладки
        if (m.type === 'task.openChat') {
          const key = this.taskTab.taskKey;
          const g = key ? services.taskGroups.group(key) : undefined;
          const ref = g?.sessions.find((x) => x.id === m.sessionId);
          if (ref && ref.id !== this.controller.sessionId) ChatPanel.resume(context, log, services, ref);
          return;
        }
        // запросы вкладки задачи — сервису задач, сессия движка не нужна
        if (isTaskRequest(m)) {
          this.taskTab.handle(m);
          return;
        }
        // 'ready' уже обработан в attachMessaging (init); остальное — контроллеру
        void this.controller.handle(m).catch((e) => log.error(`${m.type}: ${String(e)}`));
        if (m.type === 'ready') {
          // webview чата пересоздан — он не помнит, что граф открыт
          this.graph.chatReady();
          git.refresh();
          this.taskTab.resend();
          void this.pushTaskChats(true);
        }
      }),
      git,
      // автоопрос лимитов (раз в `usagePollMinutes`) доходит и до открытого чата
      {
        dispose: services.usage.onUpdate((snap) =>
          postToWebview(panel.webview, { type: 'limits.update', ...snap }),
        ),
      },
      // свежая квота agy доходит до открытых чатов (на движке agy её рисует HUD)
      {
        dispose: services.agyQuota.onUpdate((snap) =>
          postToWebview(panel.webview, { type: 'quota.update', rows: snap.rows, updatedAt: snap.updatedAt }),
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
          void this.pushTaskChats();
        }),
      },
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) ChatPanel.lastActive = this;
        // восстановленная фоновая вкладка: движок стартует, когда её впервые открыли
        if (e.webviewPanel.visible) this.startEngine();
        this.syncTask();
        ChatPanel.sessionsChanged(services);
      }),
      // метаданные и состав групп изменились (привязка из сайдбара, опрос): вкладка перепроверяет свою задачу
      { dispose: services.taskGroups.onChange(() => this.syncTask()) },
      { dispose: () => this.taskTab.dispose() },
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

  /** Привязка/группа/видимость вкладки изменились: задача для `TaskTab` и список «Чаты по задаче». */
  private syncTask(): void {
    this.taskTab.sync();
    void this.pushTaskChats();
  }

  private lastChats = '';

  /** Чаты группы задачи вкладки → блок «Чаты по задаче»; без изменений не шлёт (`force` — webview пересоздан). */
  private async pushTaskChats(force = false): Promise<void> {
    const taskKey = this.taskTab.taskKey;
    const group = taskKey ? this.services.taskGroups.group(taskKey) : undefined;
    const rows = group ? await this.services.sessions.summaries().catch(() => []) : [];
    const msg: TaskChatsMessage = {
      type: 'task.chats',
      ...(taskKey ? { taskKey } : {}),
      chats: taskChatRows(group, rows, this.controller.sessionId),
    };
    const json = JSON.stringify(msg);
    if (!force && json === this.lastChats) return;
    this.lastChats = json;
    postToWebview(this.panel.webview, msg);
  }

  /** Состав или фокус вкладок изменился: память воркспейса и строка `cur` боковой панели. */
  private static sessionsChanged(services: ChatServices): void {
    const refs = ChatPanel.panels.flatMap((p): SessionRef[] => {
      const id = p.controller.sessionId;
      return id === undefined ? [] : [{ provider: p.provider, id }];
    });
    services.memory.setOpenSessions(refs);
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
