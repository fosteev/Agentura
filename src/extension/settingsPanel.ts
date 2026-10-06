import * as vscode from 'vscode';
import { resolveExecutable } from '../agent/claude/executable';
import { CODEX_NOT_FOUND, resolveCodexExecutable } from '../agent/codex/executable';
import { postToWebview } from '../protocol';
import { hostStrings } from '../shared/l10n';
import type { Logger } from './logger';
import { SettingsController } from './settingsController';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';

export const SETTINGS_VIEW_TYPE = 'agentura.settings';

/** Вкладка «Agentura · настройки»: одна на окно, повторный вызов даёт ей фокус. */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static show(context: vscode.ExtensionContext, log: Logger): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      hostStrings(currentLanguage()).settingsTitle,
      vscode.ViewColumn.Active,
      webviewOptions(context.extensionUri, userFontsDir(context)),
    );
    SettingsPanel.current = new SettingsPanel(panel, context, log);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
  ) {
    const { webview } = panel;
    const controller = new SettingsController({
      config: () => vscode.workspace.getConfiguration('agentura'),
      globalTarget: vscode.ConfigurationTarget.Global,
      post: (m) => postToWebview(webview, m),
      checkEngine: async (path, engine) => {
        // Codex: «не найден» — на языке интерфейса, как в карточке чата; прочие проблемы резолвера английские
        const r =
          engine === 'codex'
            ? await resolveCodexExecutable(path.trim()).then((c) =>
                c.problem === CODEX_NOT_FOUND ? { ...c, problem: hostStrings(currentLanguage()).codexNotFound } : c,
              )
            : await resolveExecutable(path.trim(), { lang: currentLanguage() });
        return {
          ok: r.version !== undefined,
          source: r.source,
          ...(r.path ? { path: r.path } : {}),
          ...(r.version ? { version: r.version } : {}),
          ...(r.problem ? { problem: r.problem } : {}),
        };
      },
      reveal: (target) => {
        void vscode.commands.executeCommand(
          target === 'json' ? 'workbench.action.openSettingsJson' : 'workbench.action.openSettings',
          ...(target === 'json' ? [] : [`@ext:${context.extension.id}`]),
        );
      },
      warn: (m) => log.warn(m),
      addFont: (kind) => void vscode.commands.executeCommand('agentura.addGoogleFont', kind),
      removeFont: (family) => void vscode.commands.executeCommand('agentura.removeGoogleFont', family),
      lang: currentLanguage,
    });
    webview.html = renderWebview(
      webview,
      context.extensionUri,
      'settings',
      hostStrings(currentLanguage()).settingsTitle,
      currentLanguage(),
    );
    this.disposables.push(
      attachMessaging(
        webview,
        'settings',
        String(context.extension.packageJSON.version),
        log,
        (m) => void controller.handle(m).catch((e) => log.error(`${m.type}: ${String(e)}`)),
      ),
      // правка в settings.json (или в UI VS Code) сразу видна во вкладке
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentura')) controller.pushState();
      }),
    );
    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
      this.disposables.forEach((d) => d.dispose());
    });
    log.info('Вкладка настроек открыта');
  }
}
