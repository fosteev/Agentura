import * as vscode from 'vscode';
import type { TaskPicker } from './taskPicker';
import { postToWebview, type EngineLimitsSummary, type SessionSummary } from '../protocol';
import { isProvider, overriddenKeys, readSettings, writeSetting, type AgentProvider } from '../settings';
import type { AccountService } from './account';
import { ChatPanel } from './chatPanel';
import type { SessionsService } from './sessionsService';
import type { Logger } from './logger';
import type { UsageService } from './usage';
import type { AgyQuotaService } from './agyQuota';
import type { CodexLimitsService } from './codexLimits';
import type { EngineLocator } from './engineLocator';
import { KimiCatalogError, loadKimiModels } from '../agent/kimi/models';
import { summarizeAgy, summarizeCodex } from './engineLimits';
import type { ArchivedSessions } from './archive';
import { decorateSessions, parseTaskKey, type TaskGroups } from './taskGroups';
import { hostStrings } from '../shared/l10n';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';

/** Источники лимитов не-Claude движков (roadmap 18) и их локаторы. */
export interface SidebarEngines {
  codexLimits: CodexLimitsService;
  agyQuota: AgyQuotaService;
  codexEngine: EngineLocator;
  antigravityEngine: EngineLocator;
  kimiEngine: EngineLocator;
}

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
  taskPicker?: TaskPicker;
  private pickerRequest = 0;
  private pickerBusy = false;
  /** Только наличие/версия/вход Kimi; windows, email, plan и quota не выдумываются. */
  private kimiSummary: EngineLimitsSummary | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly usage: UsageService,
    private readonly sessions: SessionsService,
    private readonly account: AccountService,
    private readonly taskGroups: TaskGroups,
    private readonly archive: ArchivedSessions,
    private readonly engines: SidebarEngines,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const { webview } = view;
    webview.options = webviewOptions(this.context.extensionUri, userFontsDir(this.context));
    webview.html = renderWebview(webview, this.context.extensionUri, 'sidebar', 'Agentura', currentLanguage());
    const version = String(this.context.extension.packageJSON.version);
    const sub = attachMessaging(webview, 'sidebar', version, this.log, (m) => {
      switch (m.type) {
        case 'task.picker.find': {
          const request = ++this.pickerRequest;
          void this.taskPicker?.find(m.requestId, m.query, m.instanceId).then(result => {
            if (request === this.pickerRequest) this.post({ type: 'task.picker.result', requestId: m.requestId, result });
          });
          break;
        }
        case 'task.picker.cancel':
          this.pickerRequest++;
          this.taskPicker?.cancel();
          break;
        case 'task.picker.act':
          if (!this.pickerBusy && this.taskPicker) {
            this.pickerBusy = true;
            const request = this.pickerRequest;
            void this.taskPicker.act(m).then(error => {
              if (request === this.pickerRequest && this.view === view)
                this.post({ type: 'task.picker.done', requestId: m.requestId, ...(error ? { error } : {}) });
            })
              .finally(() => { this.pickerBusy = false; });
          }
          break;
        case 'task.connect':
          void vscode.commands.executeCommand('agentura.jira.connect');
          break;
        case 'session.new':
          void vscode.commands.executeCommand('agentura.newSession');
          break;
        case 'task.newChat':
          // ключ из webview недоверенный: не ключ группы — молча игнор (иначе chatForTask спросил бы ключ в поле ввода)
          if (parseTaskKey(m.taskKey)) void vscode.commands.executeCommand('agentura.chatForTask', m.taskKey);
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
          void this.refreshUsage(true);
          break;
        case 'sidebar.hideEngine':
          void this.hideEngine(m.engine);
          break;
        case 'engine.login':
          void this.openLogin(m.engine);
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
      this.taskGroups.onChange(() => this.pushSessions()),
      this.archive.onChange(() => this.pushSessions()),
      this.account.onUpdate((a) => this.post({ type: 'account.info', ...a })),
      this.engines.codexLimits.onUpdate(() => void this.pushEngineLimits()),
      this.engines.agyQuota.onUpdate(() => void this.pushEngineLimits()),
      ChatPanel.onDidChange(() => this.pushSessions()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          (e.affectsConfiguration('agentura.sessionList') ||
            e.affectsConfiguration('agentura.sidebar') ||
            e.affectsConfiguration('agentura.tasks.sidebar')) &&
          this.viewWrites === 0
        )
          this.pushView();
        // движок вернули в панель — его лимиты могли не опрашиваться, не ждём следующего опроса
        if (e.affectsConfiguration('agentura.sidebar.limitsHidden') || e.affectsConfiguration('agentura.kimiExecutable'))
          void this.refreshUsage();
      }),
    ];
    view.onDidDispose(() => {
      sub.dispose();
      unsubscribe.forEach((u) => ('dispose' in u ? u.dispose() : u()));
      this.pickerRequest++;
      this.taskPicker?.cancel();
      this.view = undefined;
    });
  }

  private post(m: Parameters<typeof postToWebview>[1]): void {
    if (this.view) postToWebview(this.view.webview, m);
  }

  private pushSessions(): void {
    const current = ChatPanel.currentSessionId();
    const provider = ChatPanel.currentProvider();
    const project = vscode.workspace.workspaceFolders?.[0]?.name;
    const groups = this.taskGroups.groups();
    const archived = this.archive.ids();
    // метки задач — по всем строкам; группы (и их счётчики) — только по неархивным
    const labelled = decorateSessions(this.rows, groups).sessions;
    const { tasks } = decorateSessions(
      this.rows.filter((r) => !archived.has(r.id)),
      groups,
    );
    const sessions = labelled.map((r): SessionSummary => (archived.has(r.id) ? { ...r, archived: true } : r));
    this.post({
      type: 'sessions.update',
      sessions,
      ...(tasks.length ? { tasks } : {}),
      ...(current ? { current } : {}),
      ...(project ? { project } : {}),
      ...(provider ? { currentProvider: provider } : {}),
    });
  }

  promptNewChat(): void {
    const cfg = vscode.workspace.getConfiguration('agentura');
    if (this.view?.visible && readSettings(cfg)['jira.source'] !== 'off') {
      this.post({ type: 'task.picker.toggle' });
    } else {
      void vscode.commands.executeCommand('agentura.newSession');
    }
  }

  private pushView(): void {
    const v = readSettings(vscode.workspace.getConfiguration('agentura'));
    this.post({
      type: 'sidebar.view',
      view: v['sessionList.view'],
      context: v['sessionList.context'],
      time: v['sessionList.time'],
      limits: v['sidebar.limits'],
      hidden: v['sidebar.limitsHidden'],
      tasks: v['tasks.sidebar'],
    });
  }

  private async hideEngine(engine: AgentProvider): Promise<void> {
    if (!isProvider(engine)) return;
    const cfg = vscode.workspace.getConfiguration('agentura');
    if (overriddenKeys(cfg).includes('sidebar.limitsHidden')) {
      void vscode.window.showInformationMessage(hostStrings(currentLanguage()).overriddenView);
      if (this.viewWrites === 0) this.pushView();
      return;
    }
    const current = readSettings(cfg)['sidebar.limitsHidden'];
    if (current.includes(engine)) return;
    const next = [...current, engine];
    this.viewWrites++;
    try {
      const checked = await writeSetting(
        cfg,
        'sidebar.limitsHidden',
        next,
        vscode.ConfigurationTarget.Global,
      );
      if (!checked.ok) this.log.warn(`agentura.sidebar.limitsHidden: ${checked.error}`);
    } catch (e) {
      this.log.warn(`не удалось записать agentura.sidebar.limitsHidden: ${String(e)}`);
    } finally {
      this.viewWrites--;
    }
    if (this.viewWrites === 0) this.pushView();
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

  /**
   * «войти» у движка без входа: терминал, в котором сразу запущен найденный исполняемый файл (путь из настройки
   * тоже), без shell и кавычек — `codex login` / `agy|kimi acp --login`. Не нашли — команда по имени из PATH.
   */
  private async openLogin(engine: 'codex' | 'antigravity' | 'kimi'): Promise<void> {
    const loc = engine === 'codex'
      ? this.engines.codexEngine
      : engine === 'antigravity'
        ? this.engines.antigravityEngine
        : this.engines.kimiEngine;
    const name = engine === 'codex' ? 'codex' : engine === 'antigravity' ? 'agy' : 'kimi';
    // Старый/чужой явный путь имеет path, но не version: login запускаем только у проверенного Kimi.
    const located = await loc.locate(true).catch(() => undefined);
    const exe = (located?.path && (engine !== 'kimi' || located.version) ? located.path : undefined) ?? name;
    const args = engine === 'codex' ? ['login'] : ['acp', '--login'];
    vscode.window.createTerminal({ name: [name, ...args].join(' '), shellPath: exe, shellArgs: args }).show();
  }

  /** Сводка Codex и Antigravity → `engines.limits`; не установленный движок приходит как `missing`. */
  private async pushEngineLimits(): Promise<void> {
    const { codexLimits, agyQuota, codexEngine, antigravityEngine } = this.engines;
    const [codexVersion, agy] = await Promise.all([
      codexEngine.locate(true).then((r) => (r.path && r.version ? `codex ${r.version}` : undefined), () => undefined),
      antigravityEngine.locate(true).then(
        (r) => ({ installed: !!r.path && !!r.version, version: r.path && r.version ? `agy ${r.version}` : undefined }),
        () => ({ installed: false, version: undefined }),
      ),
    ]);
    this.post({
      type: 'engines.limits',
      engines: [
        summarizeCodex(codexLimits.snapshot, codexVersion),
        summarizeAgy(agyQuota.snapshot, agy.installed, agy.version),
        ...(this.kimiSummary ? [this.kimiSummary] : []),
      ],
    });
  }

  /** Kimi: resolver различает missing/old; только явный auth-отказ CLI даёт signedOut. Без ACP session. */
  private async refreshKimi(): Promise<void> {
    const located = await this.engines.kimiEngine.locate(true).catch(() => undefined);
    const base = { engine: 'kimi' as const, windows: [], updatedAt: Date.now() };
    if (!located) {
      this.kimiSummary = { ...base, state: 'error', error: 'kimi executable lookup failed' };
      return;
    }
    if (!located.path || !located.version) {
      this.kimiSummary = {
        ...base,
        state: located.path ? 'error' : 'missing',
        ...(located.problem ? { error: located.problem } : {}),
      };
      return;
    }
    const version = `kimi ${located.version}`;
    try {
      await loadKimiModels(located.path);
      this.kimiSummary = { ...base, state: 'ok', version };
    } catch (error) {
      const signedOut = error instanceof KimiCatalogError && error.signedOut;
      this.kimiSummary = {
        ...base,
        state: signedOut ? 'signedOut' : 'error',
        version,
        ...(!signedOut ? { error: error instanceof Error ? error.message : String(error) } : {}),
      };
    }
  }

  /** Кнопка ↻ в боковой панели и команда «Обновить лимиты». Claude, Codex и Antigravity — параллельно. */
  async refreshUsage(force = false): Promise<void> {
    const { codexLimits, agyQuota, antigravityEngine } = this.engines;
    // скрытые в панели движки не опрашиваем; Claude опрашивается всегда — его лимиты нужны и шапке чата
    const hidden = readSettings(vscode.workspace.getConfiguration('agentura'))['sidebar.limitsHidden'];
    const codex = hidden.includes('codex') ? undefined : codexLimits.refresh();
    // agy — только установленный: `AgyQuotaService` ищет его громко, и без agy каждый опрос писал бы «не найден»
    const agy = hidden.includes('antigravity')
      ? undefined
      : antigravityEngine.available().then((ok) => (ok ? agyQuota.refresh(force) : undefined));
    const kimi = hidden.includes('kimi') ? undefined : this.refreshKimi();
    const others = Promise.allSettled([codex, agy, kimi]).then(() => this.pushEngineLimits());
    const snap = await this.usage.refresh();
    if (snap.error) this.log.warn(`Лимиты не обновились: ${snap.error}`);
    else this.log.info(`Лимиты: данные на ${new Date(snap.updatedAt).toLocaleTimeString(hostStrings(currentLanguage()).locale)}`);
    this.post({ type: 'limits.update', ...snap });
    await others;
  }
}
