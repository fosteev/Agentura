import * as vscode from 'vscode';
import { buildWebviewHtml, makeNonce } from './html';
import { stat } from 'node:fs/promises';
import { isFromWebview, postToWebview, type FromWebview, type ToWebview } from '../protocol';
import type { Logger } from './logger';
import { readSettings, resolveLanguage } from '../settings';
import type { UserFonts } from './googleFonts';

/** Папка скачанных шрифтов: `<globalStorage>/fonts`. */
export function userFontsDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'fonts');
}

/** Скачанные шрифты: ставится в `activate`, читается каждой поверхностью при отправке `appearance`. */
let userFonts: UserFonts | undefined;
export function setUserFonts(fonts: UserFonts | undefined): void {
  userFonts = fonts;
}

/** Общая часть обеих поверхностей: настройки webview, HTML, приём сообщений. */
export function webviewOptions(extensionUri: vscode.Uri, fontsDir?: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
      vscode.Uri.joinPath(extensionUri, 'media'),
      ...(fontsDir ? [fontsDir] : []),
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
      uri('media', 'agents-map.css'),
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
  'agentura.ui.fontSize',
];

/** Скачанные шрифты для `appearance`: имена и ссылка на fonts.css (`?v=` — mtime, чтобы webview не держал старый). */
async function userFontsState(webview: vscode.Webview): Promise<Extract<ToWebview, { type: 'appearance' }>['userFonts']> {
  if (!userFonts) return { ui: [], code: [] };
  const list = await userFonts.list();
  const names = (kind: 'ui' | 'code') => list.filter((f) => f.kind === kind).map((f) => f.family);
  const state = { ui: names('ui'), code: names('code') };
  if (list.length === 0) return state;
  try {
    const { mtimeMs } = await stat(userFonts.cssPath);
    const uri = webview.asWebviewUri(vscode.Uri.file(userFonts.cssPath));
    return { ...state, css: `${uri.toString()}?v=${Math.round(mtimeMs)}` };
  } catch {
    return state;
  }
}

/** `isLatest` — запрос ещё последний: чтение шрифтов асинхронное, и устаревшее состояние не должно прийти позже свежего. */
async function postAppearance(webview: vscode.Webview, isLatest: () => boolean, log: Logger): Promise<void> {
  try {
    const v = readSettings(vscode.workspace.getConfiguration('agentura'));
    const userFonts = await userFontsState(webview);
    if (!isLatest()) return;
    postToWebview(webview, {
      type: 'appearance',
      fontInterface: v['font.interface'],
      fontPanels: v['font.panels'],
      fontCode: v['font.code'],
      feedFontSize: v['feed.fontSize'],
      uiFontSize: v['ui.fontSize'],
      userFonts,
    });
  } catch (e) {
    log.warn('appearance: не отправить', e);
  }
}

export function attachMessaging(
  webview: vscode.Webview,
  surface: 'chat' | 'sidebar' | 'settings',
  version: string,
  log: Logger,
  onMessage?: (m: FromWebview) => void,
): vscode.Disposable {
  let ready = false;
  let appearanceSeq = 0;
  const sendAppearance = (): void => {
    const seq = ++appearanceSeq;
    void postAppearance(webview, () => seq === appearanceSeq, log);
  };
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
        sendAppearance();
      }
      onMessage?.(raw);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (ready && APPEARANCE_KEYS.some((k) => e.affectsConfiguration(k))) sendAppearance();
    }),
    // скачали или удалили шрифт — все открытые webview получают новый список и ссылку на css
    userFonts?.onDidChange(() => {
      if (ready) sendAppearance();
    }) ?? { dispose: () => {} },
  );
}
