import * as vscode from 'vscode';
import { buildWebviewHtml, makeNonce } from './html';
import { isFromWebview, postToWebview, type FromWebview } from '../protocol';
import type { Logger } from './logger';

/** Общая часть обеих поверхностей: настройки webview, HTML, приём сообщений. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
}

export function renderWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  surface: 'chat' | 'sidebar',
  title: string,
): string {
  const uri = (...p: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p)).toString();
  return buildWebviewHtml({
    title,
    cspSource: webview.cspSource,
    nonce: makeNonce(),
    scriptUri: uri('dist', 'webview', `${surface}.js`),
    styleUris: [
      uri('media', 'tokens.css'),
      uri('media', 'hud.css'),
      uri('media', 'agents.css'),
      uri('media', 'webview.css'),
    ],
  });
}

export function attachMessaging(
  webview: vscode.Webview,
  surface: 'chat' | 'sidebar',
  version: string,
  log: Logger,
  onMessage?: (m: FromWebview) => void,
): vscode.Disposable {
  return webview.onDidReceiveMessage((raw: unknown) => {
    if (!isFromWebview(raw)) {
      log.warn(`[${surface}] неизвестное сообщение от webview`, raw);
      return;
    }
    log.debug(`[${surface}] ← ${raw.type}`);
    if (raw.type === 'ready') postToWebview(webview, { type: 'init', surface, version });
    onMessage?.(raw);
  });
}
