import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { Logger } from './logger';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './sidebarView';
import { stubUsageFetcher, UsageService } from './usage';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Agentura');
  context.subscriptions.push(log);
  log.info(`Agentura ${String(context.extension.packageJSON.version)} активирована`);

  const stub = (name: string) => () => {
    log.info(`Команда ${name}: появится на этапе сессий`);
    void vscode.window.showInformationMessage(`Agentura: «${name}» пока не реализована.`);
  };

  const sidebar = new SidebarProvider(context, log, new UsageService(stubUsageFetcher));

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
