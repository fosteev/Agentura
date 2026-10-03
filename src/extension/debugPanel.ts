import * as vscode from 'vscode';
import { postToWebview } from '../protocol';
import { STATE_FIXTURES } from './debugStatesData';
import { STATE_NAMES, isStateName, parseFixture, type StateName } from './debugStates';
import type { Logger } from './logger';
import { attachMessaging, currentLanguage, renderWebview, webviewOptions } from './webviewHost';

/**
 * `agentura.debug.showState`: отдельная вкладка с тем же webview чата, но без движка — события
 * фикстуры уходят в него как обычные сообщения хоста (`agent.event`, `diff.preview`, `limits.update`…).
 * Вкладки живых сессий не затрагиваются (у каждой свой `ChatController` и процесс CLI); кнопки
 * карточек в этой вкладке ничего не делают, кроме «Открыть журнал».
 */
export async function showDebugState(
  context: vscode.ExtensionContext,
  log: Logger,
  arg?: unknown,
): Promise<void> {
  let name: StateName | undefined = isStateName(arg) ? arg : undefined;
  if (!name) {
    const picked = await vscode.window.showQuickPick([...STATE_NAMES], {
      placeHolder: 'Какое состояние показать? (отладка, без движка)',
    });
    if (!isStateName(picked)) return;
    name = picked;
  }
  const state = name;
  const panel = vscode.window.createWebviewPanel(
    'agentura.debugState',
    `Agentura · ${state} (отладка)`,
    vscode.ViewColumn.Beside,
    { ...webviewOptions(context.extensionUri), retainContextWhenHidden: true },
  );
  panel.webview.html = renderWebview(panel.webview, context.extensionUri, 'chat', 'Agentura', currentLanguage());
  const version = String(context.extension.packageJSON.version);
  let ready = 0;
  const sub = attachMessaging(panel.webview, 'chat', version, log, (m) => {
    if (m.type === 'ready') {
      ready++;
      if (ready > 1) postToWebview(panel.webview, { type: 'session.reset' });
      for (const msg of parseFixture(STATE_FIXTURES[state], Date.now())) {
        postToWebview(panel.webview, msg);
      }
    } else if (m.type === 'log.show') log.show();
    else log.debug(`[debug:${state}] ${m.type}: в отладочной вкладке не выполняется`);
  });
  panel.onDidDispose(() => sub.dispose());
  log.info(`Отладочная вкладка: состояние ${state}`);
}
