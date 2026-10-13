import * as vscode from 'vscode';
import { hostStrings } from '../shared/l10n';
import type { ChatServices } from './chatPanel';
import { sessionIdOf } from './taskLink';
import { currentLanguage } from './webviewHost';

/**
 * «В архив» / «Вернуть из архива» из контекстного меню строки боковой панели. Аргумент — контекст строки
 * (`sessionId`); без id команда молча ничего не делает. Файлы сессий и вкладки не трогаются.
 */
export function registerArchiveCommands(services: Pick<ChatServices, 'archive'>): vscode.Disposable[] {
  const t = () => hostStrings(currentLanguage());

  const archive = async (arg?: unknown): Promise<void> => {
    const id = sessionIdOf(arg);
    if (!id) return;
    services.archive.add(id);
    const pick = await vscode.window.showInformationMessage(t().archived, t().archiveUndo);
    if (pick === t().archiveUndo) services.archive.remove(id);
  };

  const unarchive = (arg?: unknown): void => {
    const id = sessionIdOf(arg);
    if (!id) return;
    services.archive.remove(id);
    void vscode.window.showInformationMessage(t().unarchived);
  };

  return [
    vscode.commands.registerCommand('agentura.archiveSession', archive),
    vscode.commands.registerCommand('agentura.unarchiveSession', unarchive),
  ];
}
