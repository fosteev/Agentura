/**
 * Поверхность чата (roadmap 19, этап 7): всё, что `ChatPanel` знает о своём webview. Обычная вкладка — своя
 * `WebviewPanel` (`panelSurface`); чат вкладки задачи — внутренняя вкладка общей `WebviewPanel` (`TaskTabPanel`),
 * у фонового чата сообщения в webview не уходят, а «видима» и «в фокусе» — только у показанной внутренней вкладки.
 */
import * as vscode from 'vscode';
import { postToWebview, type FromWebview, type ToWebview } from '../protocol';
import type { Logger } from './logger';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';

export interface ChatSurface {
  /** Сообщение в webview; фоновая внутренняя вкладка его глушит (контроллер перешлёт состояние при возврате). */
  post(m: ToWebview): void;
  /** Заголовок чата: у своей вкладки — заголовок вкладки, у внутренней — сводный заголовок вкладки задачи. */
  setTitle(title: string): void;
  readonly visible: boolean;
  readonly active: boolean;
  /** Чат показан в своей вкладке редактора (у вкладки задачи — его внутренняя вкладка выбрана), видна она или нет. */
  readonly shown: boolean;
  readonly viewColumn: vscode.ViewColumn | undefined;
  /** Показать чат: вкладку редактора и, у вкладки задачи, его внутреннюю вкладку. */
  reveal(column?: vscode.ViewColumn): void;
  /** Только внутренняя вкладка, без показа вкладки редактора (восстановление); у своей вкладки — ничего. */
  select(): void;
  /** Видимость или фокус чата изменились (в том числе переключение внутренних вкладок). */
  onDidChangeViewState(cb: () => void): vscode.Disposable;
  /** Сообщения webview этого чата (у вкладки задачи — пока он показан; на показ — синтетический `ready`). */
  onMessage(cb: (m: FromWebview) => void): vscode.Disposable;
  /** Чат закрыт: вкладка редактора или внутренняя вкладка. */
  onDidDispose(cb: () => void): vscode.Disposable;
  /** Ключ задачи вкладки задачи, в которой живёт чат; нет — своя вкладка редактора. */
  readonly taskTab?: string;
  /** Статус, название или сессия чата сменились: вкладка задачи перерисовывает внутренние вкладки. */
  changed(): void;
}

/** Вкладка редактора под один чат: поведение до этапа 7. */
export function panelSurface(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  log: Logger,
): ChatSurface {
  const version = String(context.extension.packageJSON.version);
  panel.webview.options = webviewOptions(context.extensionUri, userFontsDir(context));
  panel.iconPath = chatIcon(context);
  panel.webview.html = renderWebview(panel.webview, context.extensionUri, 'chat', 'Agentura', currentLanguage());
  return {
    post: (m) => postToWebview(panel.webview, m),
    setTitle: (t) => (panel.title = t),
    get visible() {
      return panel.visible;
    },
    get active() {
      return panel.active;
    },
    shown: true,
    get viewColumn() {
      return panel.viewColumn;
    },
    reveal: (column) => panel.reveal(column),
    select: () => {},
    onDidChangeViewState: (cb) => panel.onDidChangeViewState(() => cb()),
    onMessage: (cb) => attachMessaging(panel.webview, 'chat', version, log, cb),
    onDidDispose: (cb) => panel.onDidDispose(cb),
    changed: () => {},
  };
}

export function chatIcon(context: vscode.ExtensionContext): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.svg'),
  };
}
