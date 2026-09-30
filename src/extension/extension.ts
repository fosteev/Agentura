import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { Logger } from './logger';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './sidebarView';
import { LimitsSource, startLimitsPolling } from '../data/limits';
import { UsageService } from './usage';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Agentura');
  context.subscriptions.push(log);
  log.info(`Agentura ${String(context.extension.packageJSON.version)} активирована`);

  const stub = (name: string) => () => {
    log.info(`Команда ${name}: появится на этапе сессий`);
    void vscode.window.showInformationMessage(`Agentura: «${name}» пока не реализована.`);
  };

  // Лимиты: /api/oauth/usage (токен Claude Code), запас — rate_limit_event движка (этап 2).
  const limits = new LimitsSource({
    readKeychain: () =>
      vscode.workspace.getConfiguration('agentura').get<boolean>('limits.readKeychain', true),
    userAgent: `Agentura/${String(context.extension.packageJSON.version)}`,
  });
  const sidebar = new SidebarProvider(context, log, new UsageService(limits.fetch));
  const pollMinutes = () =>
    vscode.workspace.getConfiguration('agentura').get<number>('usagePollMinutes', 15);
  context.subscriptions.push(startLimitsPolling(() => sidebar.refreshUsage(), pollMinutes));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar),
    vscode.commands.registerCommand('agentura.open', () => ChatPanel.show(context, log)),
    vscode.commands.registerCommand('agentura.newSession', () => ChatPanel.show(context, log)),
    vscode.commands.registerCommand('agentura.openLast', () => ChatPanel.show(context, log)),
    vscode.commands.registerCommand('agentura.resumeSession', stub('Возобновить сессию')),
    vscode.commands.registerCommand('agentura.showLogs', () => log.show()),
    vscode.commands.registerCommand('agentura.refreshUsage', () => sidebar.refreshUsage()),
  );
}

export function deactivate(): void {}
