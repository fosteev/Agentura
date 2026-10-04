import * as vscode from 'vscode';
import { buildWebviewHtml, makeNonce } from './html';
import { isFromWebview, postToWebview, type FromWebview } from '../protocol';
import type { Logger } from './logger';
import { readSettings, resolveLanguage } from '../settings';

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

/** Язык интерфейса: `agentura.language`, а для `auto` — язык VS Code. Один источник для всех поверхностей. */
export function currentLanguage(): 'ru' | 'en' {
  return resolveLanguage(
    vscode.workspace.getConfiguration('agentura').get<unknown>('language'),
    vscode.env.language,
  );
}

export function renderWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  surface: 'chat' | 'sidebar' | 'settings',
  title: string,
  lang: 'ru' | 'en',
): string {
  const uri = (...p: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p)).toString();
  return buildWebviewHtml({
    title,
    lang,
    cspSource: webview.cspSource,
    nonce: makeNonce(),
    scriptUri: uri('dist', 'webview', `${surface}.js`),
    styleUris: [
      uri('media', 'fonts', 'fonts.css'),
      uri('media', 'tokens.css'),
      uri('media', 'hud.css'),
      uri('media', 'agents.css'),
      uri('media', 'changes.css'),
      uri('media', 'feed.css'),
      uri('media', 'attach.css'),
      uri('media', 'webview.css'),
      uri('media', 'tooltip.css'),
      ...(surface === 'settings' ? [uri('media', 'settings.css')] : []),
    ],
  });
}

/** Ключи, от которых зависит сообщение `appearance`. */
const APPEARANCE_KEYS = [
  'agentura.font.interface',
  'agentura.font.panels',
  'agentura.font.code',
  'agentura.feed.fontSize',
];

function postAppearance(webview: vscode.Webview): void {
  const v = readSettings(vscode.workspace.getConfiguration('agentura'));
  postToWebview(webview, {
    type: 'appearance',
    fontInterface: v['font.interface'],
    fontPanels: v['font.panels'],
    fontCode: v['font.code'],
    feedFontSize: v['feed.fontSize'],
  });
}

export function attachMessaging(
  webview: vscode.Webview,
  surface: 'chat' | 'sidebar' | 'settings',
  version: string,
  log: Logger,
  onMessage?: (m: FromWebview) => void,
): vscode.Disposable {
  let ready = false;
  return vscode.Disposable.from(
    webview.onDidReceiveMessage((raw: unknown) => {
      if (!isFromWebview(raw)) {
        log.warn(`[${surface}] неизвестное сообщение от webview`, raw);
        return;
      }
      log.debug(`[${surface}] ← ${raw.type}`);
      if (raw.type === 'ready') {
        ready = true;
        postToWebview(webview, { type: 'init', surface, version });
        postAppearance(webview);
      }
      onMessage?.(raw);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (ready && APPEARANCE_KEYS.some((k) => e.affectsConfiguration(k))) postAppearance(webview);
    }),
  );
}
