import * as vscode from 'vscode';

/** Логгер поверх LogOutputChannel: уровни и фильтр по уровню даёт сам VS Code («Установить уровень журнала»). */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name = 'Agentura') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args);
  }
  error(message: string | Error, ...args: unknown[]): void {
    this.channel.error(message, ...args);
  }

  show(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
