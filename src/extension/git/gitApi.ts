import * as vscode from 'vscode';
import type { API, GitExtension } from './git';

/** API встроенного git или почему его нет. */
export type GitApiResult =
  | { api: API }
  | { reason: 'missing' | 'disabled' | 'error'; message?: string; extension?: GitExtension };

/**
 * API встроенного расширения `vscode.git` (версия 1). Жёсткой зависимости в `package.json` нет: расширение
 * активируется здесь лениво, при первой вкладке чата. Выключено (`git.enabled: false`) — причина и сам
 * `GitExtension`, чтобы подписаться на `onDidChangeEnablement`.
 */
export async function getGitApi(): Promise<GitApiResult> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return { reason: 'missing' };
  try {
    const git = ext.isActive ? ext.exports : await ext.activate();
    if (!git.enabled) return { reason: 'disabled', extension: git };
    return { api: git.getAPI(1) };
  } catch (e) {
    return { reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
