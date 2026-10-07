import * as vscode from 'vscode';
import { ChatPanel, createAdapter, type ChatServices } from './chatPanel';
import { Logger } from './logger';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './sidebarView';
import { LimitsSource, startLimitsPolling } from '../data/limits';
import { LiveSessions, TranscriptCache } from '../data/sessions';
import { UsageService } from './usage';
import { AgyQuotaService } from './agyQuota';
import { CodexLimitsService } from './codexLimits';
import { DiffDocuments } from './diffDocuments';
import { PreviewPanels } from './previewPanels';
import { AccountService } from './account';
import { SessionMemory } from './sessionMemory';
import { SessionsService } from './sessionsService';
import { showDebugState } from './debugPanel';
import { SettingsPanel } from './settingsPanel';
import { AGENTS_GRAPH_VIEW_TYPE } from './agentsGraphPanel';
import { AGENTS_VIEWS, COMPOSER_LAYOUTS, FEED_STYLES, GIT_LAYOUTS, SIDEBAR_LIMITS_MODES, isProvider, readSettings, writeSetting, type SettingKey } from '../settings';
import { hostStrings } from '../shared/l10n';
import { currentLanguage, setUserFonts, userFontsDir } from './webviewHost';
import { UserFonts } from './googleFonts';
import { addGoogleFont } from './googleFontsCommand';
import { WorkspaceFiles } from './workspaceFiles';
import { GitService, countLines, runGit } from './git/gitService';
import { getGitApi } from './git/gitApi';
import { vscodeGitUi } from './git/gitUi';
import type { AgentProvider, CompletionRequest } from '../agent/types';

/** Что активация отдаёт интеграционным тестам (только при запуске из исходников). */
export interface TestApi {
  WorkspaceFiles: typeof WorkspaceFiles;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const log = new Logger('Agentura');
  context.subscriptions.push(log);
  log.info(`Agentura ${String(context.extension.packageJSON.version)} активирована`);
  // отладочные команды видны в палитре только при запуске из исходников (Extension Development Host)
  void vscode.commands.executeCommand(
    'setContext',
    'agentura.debug',
    context.extensionMode === vscode.ExtensionMode.Development,
  );

  // Лимиты: /api/oauth/usage (токен Claude Code), запас — rate_limit_event движка (этап 2).
  const limits = new LimitsSource({
    readKeychain: () =>
      vscode.workspace.getConfiguration('agentura').get<boolean>('limits.readKeychain', true),
    userAgent: `Agentura/${String(context.extension.packageJSON.version)}`,
    lang: currentLanguage,
  });
  const usage = new UsageService(limits.fetch);
  const { adapter, codexAdapter, antigravityAdapter, engine, codexEngine, antigravityEngine } = createAdapter(
    log,
    String(context.extension.packageJSON.version),
    context.globalState,
  );
  engine.warm();
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = folder?.uri.fsPath ?? '';
  const live = new LiveSessions();
  const transcripts = new TranscriptCache();
  const memory = new SessionMemory(context.workspaceState);

  // шрифты, скачанные из Google Fonts: папка данных расширения; сеть — только по команде
  const userFonts = new UserFonts({
    dir: userFontsDir(context).fsPath,
    fetch: (url, init) => fetch(url, init),
    warn: (m) => log.warn(m),
  });
  setUserFonts(userFonts);
  context.subscriptions.push({ dispose: () => setUserFonts(undefined) });

  const sessions = new SessionsService({
    adapter,
    // треды Codex проекта (`thread/list`): процесс запускается, только если `codex` найден
    codex: { adapter: codexAdapter, available: () => codexEngine.available() },
    // беседы Antigravity: база и индекс бесед; без `agy` (или без `node:sqlite` — тогда индекс) строк нет, ошибок тоже
    antigravity: { adapter: antigravityAdapter, available: () => antigravityEngine.available() },
    cwd,
    live,
    cache: transcripts,
    log: { debug: (m) => log.debug(m), warn: (m) => log.warn(m) },
  });
  const account = new AccountService({
    accountInfo: async () => {
      // без `claude` временный процесс не запускаем: у SDK в `.vsix` своего бинарника нет
      const ready = await engine.ready();
      if (!ready.ok) throw new Error(ready.problem);
      return adapter.accountInfo(cwd || process.cwd());
    },
    readPlan: () => limits.readPlan(),
    lang: currentLanguage,
    ...(memory.engineVersion() ? { savedEngine: memory.engineVersion()! } : {}),
  });
  if (folder) {
    sessions.start();
    context.subscriptions.push(
      { dispose: () => sessions.dispose() },
      // смена статуса живой сессии (ход идёт, ждёт ответа) — строка списка меняется сразу
      { dispose: live.onChange(() => sessions.schedule()) },
    );
  }

  const agyQuota = new AgyQuotaService(() => antigravityEngine.path());
  const codexLimits = new CodexLimitsService(async () => ((await codexEngine.available()) ? codexEngine.path() : undefined));
  const sidebar = new SidebarProvider(context, log, usage, sessions, account, {
    codexLimits,
    agyQuota,
    codexEngine,
    antigravityEngine,
  });
  const pollMinutes = () =>
    vscode.workspace.getConfiguration('agentura').get<number>('usagePollMinutes', 15);
  context.subscriptions.push(startLimitsPolling(() => sidebar.refreshUsage(), pollMinutes));

  const services: ChatServices = {
    adapter,
    codexAdapter,
    antigravityAdapter,
    live,
    transcripts,
    usage,
    limits,
    agyQuota,
    diffs: new DiffDocuments(),
    previews: new PreviewPanels(),
    sessions,
    account,
    memory,
    engine,
    codexEngine,
    antigravityEngine,
    git: new GitService({
      loadApi: getGitApi,
      ui: vscodeGitUi(),
      lang: currentLanguage,
      log,
      run: runGit,
      countLines,
      // ✦ сообщение коммита: одноразовый запрос движка, без транскрипта
      ...(adapter.complete
        ? { complete: (cwd: string, r: CompletionRequest) => adapter.complete!(cwd, r) }
        : {}),
    }),
  };

  /** Быстрый выбор сессии проекта: «Возобновить сессию» из палитры. */
  const pickSession = async (): Promise<void> => {
    const rows = await sessions.summaries();
    const t = hostStrings(currentLanguage());
    if (rows.length === 0) {
      void vscode.window.showInformationMessage(t.noSessions);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      rows.map((r) => ({
        label: r.title,
        // у треда Codex и беседы Antigravity ходов и стоимости нет: метка движка вместо них
        description:
          r.provider === 'codex'
            ? 'Codex'
            : r.provider === 'antigravity'
              ? 'Antigravity'
              : `${t.turns(r.turns)}${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(2)}` : ''}`,
        detail: new Date(r.updatedAt).toLocaleString(t.locale),
        id: r.id,
        provider: r.provider ?? ('claude' as const),
      })),
      { placeHolder: t.pickSessionPlaceholder, matchOnDetail: true },
    );
    if (picked) ChatPanel.resume(context, log, services, { provider: picked.provider, id: picked.id });
  };

  // настройка задана в воркспейсе — запись в Global её не перебьёт: пишем туда, где она задана
  const writeWhereSet = async (key: SettingKey, value: string): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('agentura');
    const set = cfg.inspect(key);
    const target =
      set?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : set?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await writeSetting(cfg, key, value, target);
  };

  const pickAgentsView = async (): Promise<void> => {
    const t = hostStrings(currentLanguage());
    const cfg = vscode.workspace.getConfiguration('agentura');
    const current = readSettings(cfg)['agents.view'];
    const picked = await vscode.window.showQuickPick(
      AGENTS_VIEWS.map((id) => ({
        label: `${id === current ? '$(check) ' : ''}${t.agentsViews[id]?.[0] ?? id}`,
        description: id === current ? t.feedStyleCurrent : '',
        detail: t.agentsViews[id]?.[1] ?? '',
        id,
      })),
      { placeHolder: t.agentsViewPlaceholder },
    );
    if (!picked) return;
    try {
      await writeWhereSet('agents.view', picked.id);
    } catch (e) {
      log.warn('agentura.agentsView: не записать agents.view', e);
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const pickGitLayout = async (): Promise<void> => {
    const t = hostStrings(currentLanguage());
    const cfg = vscode.workspace.getConfiguration('agentura');
    const current = readSettings(cfg)['git.layout'];
    const picked = await vscode.window.showQuickPick(
      GIT_LAYOUTS.map((id) => ({
        label: `${id === current ? '$(check) ' : ''}${t.gitLayouts[id]?.[0] ?? id}`,
        description: id === current ? t.feedStyleCurrent : '',
        detail: t.gitLayouts[id]?.[1] ?? '',
        id,
      })),
      { placeHolder: t.gitLayoutPlaceholder },
    );
    if (!picked) return;
    try {
      await writeWhereSet('git.layout', picked.id);
    } catch (e) {
      log.warn('agentura.gitLayout: не записать git.layout', e);
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const pickComposerLayout = async (): Promise<void> => {
    const t = hostStrings(currentLanguage());
    const cfg = vscode.workspace.getConfiguration('agentura');
    const current = readSettings(cfg)['composer.layout'];
    const picked = await vscode.window.showQuickPick(
      COMPOSER_LAYOUTS.map((id) => ({
        label: `${id === current ? '$(check) ' : ''}${t.composerLayouts[id]?.[0] ?? id}`,
        description: id === current ? t.feedStyleCurrent : '',
        detail: t.composerLayouts[id]?.[1] ?? '',
        id,
      })),
      { placeHolder: t.composerLayoutPlaceholder },
    );
    if (!picked) return;
    try {
      await writeWhereSet('composer.layout', picked.id);
    } catch (e) {
      log.warn('agentura.composerLayout: не записать composer.layout', e);
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const pickSidebarLimits = async (): Promise<void> => {
    const t = hostStrings(currentLanguage());
    const cfg = vscode.workspace.getConfiguration('agentura');
    const current = readSettings(cfg)['sidebar.limits'];
    const picked = await vscode.window.showQuickPick(
      SIDEBAR_LIMITS_MODES.map((id) => ({
        label: `${id === current ? '$(check) ' : ''}${t.sidebarLimitsViews[id]?.[0] ?? id}`,
        description: id === current ? t.feedStyleCurrent : '',
        detail: t.sidebarLimitsViews[id]?.[1] ?? '',
        id,
      })),
      { placeHolder: t.sidebarLimitsPlaceholder },
    );
    if (!picked) return;
    try {
      await writeWhereSet('sidebar.limits', picked.id);
    } catch (e) {
      log.warn('agentura.sidebarLimits: не записать sidebar.limits', e);
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const pickFeedStyle = async (): Promise<void> => {
    const t = hostStrings(currentLanguage());
    const cfg = vscode.workspace.getConfiguration('agentura');
    const current = readSettings(cfg)['feed.style'];
    const picked = await vscode.window.showQuickPick(
      FEED_STYLES.map((id) => ({
        label: `${id === current ? '$(check) ' : ''}${t.feedStyles[id]?.[0] ?? id}`,
        description: id === current ? t.feedStyleCurrent : '',
        detail: t.feedStyles[id]?.[1] ?? '',
        id,
      })),
      { placeHolder: t.feedStylePlaceholder },
    );
    if (!picked) return;
    try {
      await writeWhereSet('feed.style', picked.id);
    } catch (e) {
      log.warn('agentura.feedStyle: не записать feed.style', e);
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  context.subscriptions.push(
    services.diffs.register(),
    services.previews,
    services.git,
    { dispose: () => ChatPanel.stopEngines() },
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar),
    vscode.window.registerWebviewPanelSerializer(
      'agentura.chat',
      ChatPanel.serializer(context, log, services),
    ),
    // граф агентов (roadmap 11): после перезагрузки окна — к своей вкладке чата или закрыть
    vscode.window.registerWebviewPanelSerializer(
      AGENTS_GRAPH_VIEW_TYPE,
      ChatPanel.graphSerializer(context, log),
    ),
    vscode.commands.registerCommand('agentura.open', () => ChatPanel.show(context, log, services)),
    vscode.commands.registerCommand('agentura.newSession', () =>
      ChatPanel.startNew(context, log, services),
    ),
    vscode.commands.registerCommand('agentura.openLast', async () => {
      const last = (await sessions.summaries())[0];
      if (last) ChatPanel.resume(context, log, services, { provider: last.provider ?? 'claude', id: last.id });
      else ChatPanel.startNew(context, log, services);
    }),
    vscode.commands.registerCommand('agentura.resumeSession', () => pickSession()),
    // служебная: клик по строке списка в боковой панели (в палитру не выносится)
    vscode.commands.registerCommand('agentura.openSession', (id: unknown, provider?: unknown) => {
      if (typeof id !== 'string') return;
      // нет поля provider (старые вызовы, строки списка Claude) — `claude`
      const p: AgentProvider = isProvider(provider) ? provider : 'claude';
      ChatPanel.resume(context, log, services, { provider: p, id });
    }),
    vscode.commands.registerCommand('agentura.showStatus', () =>
      ChatPanel.runStatus(context, log, services),
    ),
    vscode.commands.registerCommand('agentura.openSettings', () =>
      SettingsPanel.show(context, log),
    ),
    // правка настроек (UI, settings.json, вкладка настроек) доходит до открытых вкладок чата
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentura')) ChatPanel.settingsChanged();
      if (e.affectsConfiguration('agentura.language')) {
        const t = hostStrings(currentLanguage());
        const reload = t.reloadButton;
        void vscode.window
          .showInformationMessage(t.languageReload, reload)
          .then((pick) => {
            if (pick === reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
      }
    }),
    vscode.commands.registerCommand('agentura.feedStyle', () => pickFeedStyle()),
    vscode.commands.registerCommand('agentura.composerLayout', () => pickComposerLayout()),
    vscode.commands.registerCommand('agentura.sidebarLimits', () => pickSidebarLimits()),
    vscode.commands.registerCommand('agentura.agentsView', () => pickAgentsView()),
    vscode.commands.registerCommand('agentura.gitLayout', () => pickGitLayout()),
    // второй аргумент — назначение из вкладки настроек (`fonts.add`); из палитры приходит пустым
    vscode.commands.registerCommand('agentura.addGoogleFont', (kind?: unknown) =>
      addGoogleFont(
        { fonts: userFonts, log, write: writeWhereSet },
        kind === 'ui' || kind === 'code' || kind === 'panels' ? kind : undefined,
      ),
    ),
    // служебная: ✕ в карточке скачанного шрифта (в палитру не выносится)
    vscode.commands.registerCommand('agentura.removeGoogleFont', async (family: unknown) => {
      if (typeof family !== 'string') return;
      try {
        await userFonts.remove(family);
      } catch (e) {
        log.warn(`agentura.removeGoogleFont: ${family}`, e);
      }
    }),
    vscode.commands.registerCommand('agentura.showLogs', () => log.show()),
    // отладка: фикстуры состояний в отдельной вкладке без движка (этап 7)
    vscode.commands.registerCommand('agentura.debug.showState', (name?: unknown) =>
      showDebugState(context, log, name),
    ),
    vscode.commands.registerCommand('agentura.refreshUsage', () => sidebar.refreshUsage()),
  );
  // в тестовом режиме (`extensionTestsPath`) — тоже: так запускается интеграционный набор
  return context.extensionMode !== vscode.ExtensionMode.Production ? { WorkspaceFiles } : undefined;
}

export function deactivate(): void {}
