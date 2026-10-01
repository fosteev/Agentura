import * as vscode from 'vscode';
import { ChatPanel, createAdapter, type ChatServices } from './chatPanel';
import { Logger } from './logger';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './sidebarView';
import { LimitsSource, startLimitsPolling } from '../data/limits';
import { LiveSessions, TranscriptCache } from '../data/sessions';
import { UsageService } from './usage';
import { DiffDocuments } from './diffDocuments';
import { PreviewPanels } from './previewPanels';
import { AccountService } from './account';
import { SessionMemory } from './sessionMemory';
import { SessionsService } from './sessionsService';
import { showDebugState } from './debugPanel';
import { SettingsPanel } from './settingsPanel';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Agentura');
  context.subscriptions.push(log);
  log.info(`Agentura ${String(context.extension.packageJSON.version)} активирована`);

  // Лимиты: /api/oauth/usage (токен Claude Code), запас — rate_limit_event движка (этап 2).
  const limits = new LimitsSource({
    readKeychain: () =>
      vscode.workspace.getConfiguration('agentura').get<boolean>('limits.readKeychain', true),
    userAgent: `Agentura/${String(context.extension.packageJSON.version)}`,
  });
  const usage = new UsageService(limits.fetch);
  const adapter = createAdapter(log);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = folder?.uri.fsPath ?? '';
  const live = new LiveSessions();
  const transcripts = new TranscriptCache();
  const memory = new SessionMemory(context.workspaceState);

  const sessions = new SessionsService({
    adapter,
    cwd,
    live,
    cache: transcripts,
    log: { debug: (m) => log.debug(m), warn: (m) => log.warn(m) },
  });
  const account = new AccountService({
    accountInfo: () => adapter.accountInfo(cwd || process.cwd()),
    readPlan: () => limits.readPlan(),
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

  const sidebar = new SidebarProvider(context, log, usage, sessions, account);
  const pollMinutes = () =>
    vscode.workspace.getConfiguration('agentura').get<number>('usagePollMinutes', 15);
  context.subscriptions.push(startLimitsPolling(() => sidebar.refreshUsage(), pollMinutes));

  const services: ChatServices = {
    adapter,
    live,
    transcripts,
    usage,
    limits,
    diffs: new DiffDocuments(),
    previews: new PreviewPanels(),
    sessions,
    account,
    memory,
  };

  /** Быстрый выбор сессии проекта: «Возобновить сессию» из палитры. */
  const pickSession = async (): Promise<void> => {
    const rows = await sessions.summaries();
    if (rows.length === 0) {
      void vscode.window.showInformationMessage('Agentura: в этом проекте пока нет сессий.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      rows.map((r) => ({
        label: r.title,
        description: `${r.turns} ${r.turns === 1 ? 'ход' : 'ходов'}${
          r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(2)}` : ''
        }`,
        detail: new Date(r.updatedAt).toLocaleString('ru'),
        id: r.id,
      })),
      { placeHolder: 'Какую сессию возобновить?', matchOnDetail: true },
    );
    if (picked) ChatPanel.resume(context, log, services, picked.id);
  };

  context.subscriptions.push(
    services.diffs.register(),
    services.previews,
    { dispose: () => ChatPanel.stopEngines() },
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar),
    vscode.window.registerWebviewPanelSerializer(
      'agentura.chat',
      ChatPanel.serializer(context, log, services),
    ),
    vscode.commands.registerCommand('agentura.open', () => ChatPanel.show(context, log, services)),
    vscode.commands.registerCommand('agentura.newSession', () =>
      ChatPanel.startNew(context, log, services),
    ),
    vscode.commands.registerCommand('agentura.openLast', async () => {
      const last = (await sessions.summaries())[0];
      if (last) ChatPanel.resume(context, log, services, last.id);
      else ChatPanel.startNew(context, log, services);
    }),
    vscode.commands.registerCommand('agentura.resumeSession', () => pickSession()),
    // служебная: клик по строке списка в боковой панели (в палитру не выносится)
    vscode.commands.registerCommand('agentura.openSession', (id: unknown) => {
      if (typeof id === 'string') ChatPanel.resume(context, log, services, id);
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
    }),
    vscode.commands.registerCommand('agentura.showLogs', () => log.show()),
    // отладка: фикстуры состояний в отдельной вкладке без движка (этап 7)
    vscode.commands.registerCommand('agentura.debug.showState', (name?: unknown) =>
      showDebugState(context, log, name),
    ),
    vscode.commands.registerCommand('agentura.refreshUsage', () => sidebar.refreshUsage()),
  );
}

export function deactivate(): void {}
