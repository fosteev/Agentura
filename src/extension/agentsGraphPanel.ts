import * as vscode from 'vscode';
import { postToWebview, type FromWebview } from '../protocol';
import { hostStrings } from '../shared/l10n';
import { AgentsGraphLink, PendingGraphs, graphStateSession, type GraphChat } from './agentsGraphLink';
import type { Logger } from './logger';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';

export const AGENTS_GRAPH_VIEW_TYPE = 'agentura.agentsGraph';

/** Сколько восстановленный после перезагрузки окна граф ждёт свою вкладку чата, прежде чем закрыться. */
export const GRAPH_RESTORE_MS = 15_000;

/**
 * Вкладка «Агенты · <сессия>» (roadmap 11, этап 2): граф агентов одной вкладки чата, рядом с ней.
 * Своих данных нет — снимок присылает чат (`AgentsGraphLink`); жизнью вкладки управляет `ChatPanel`
 * (открыть / показать / закрыть вместе с чатом / восстановить после перезагрузки окна).
 */
export class AgentsGraphPanel {
  /** Новая вкладка графа рядом с активной (вкладкой чата). */
  static create(context: vscode.ExtensionContext, log: Logger): AgentsGraphPanel {
    const panel = vscode.window.createWebviewPanel(
      AGENTS_GRAPH_VIEW_TYPE,
      hostStrings(currentLanguage()).agentsGraphTitle(),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      webviewOptions(context.extensionUri, userFontsDir(context)),
    );
    return new AgentsGraphPanel(panel, context, log);
  }

  /** Вкладка, восстановленная сериализатором после перезагрузки окна. */
  static restore(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
  ): AgentsGraphPanel {
    return new AgentsGraphPanel(panel, context, log);
  }

  /** Вкладку закрыли (человек или чат): владелец отвязывает граф. */
  onClose: (() => void) | undefined;
  private readonly link: AgentsGraphLink;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
  ) {
    const { webview } = panel;
    const lang = currentLanguage();
    webview.options = webviewOptions(context.extensionUri, userFontsDir(context));
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.svg'),
    };
    this.link = new AgentsGraphLink(
      {
        post: (m) => postToWebview(webview, m),
        setTitle: (t) => {
          const title = hostStrings(lang).agentsGraphTitle(t);
          if (panel.title !== title) panel.title = title;
        },
        warn: (m) => log.warn(m),
      },
      panel.visible,
    );
    webview.html = renderWebview(
      webview,
      context.extensionUri,
      'agents',
      hostStrings(lang).agentsGraphTitle(),
      lang,
    );
    this.disposables.push(
      attachMessaging(webview, 'agents', String(context.extension.packageJSON.version), log, (m) =>
        this.link.fromGraph(m),
      ),
      panel.onDidChangeViewState((e) => this.link.setVisible(e.webviewPanel.visible)),
    );
    panel.onDidDispose(() => this.disposeAll(), null, this.disposables);
  }

  get bound(): boolean {
    return this.link.bound;
  }

  /** Привязать к вкладке чата: чат начинает слать снимки. */
  bind(chat: GraphChat): void {
    this.link.bind(chat);
  }

  /** Показать вкладку (не перенося в другую группу) и выбрать агента. */
  reveal(agentId?: string): void {
    this.panel.reveal(undefined, false);
    this.link.focusAgent(agentId);
  }

  snapshot(m: Extract<FromWebview, { type: 'agents.snapshot' }>): void {
    this.link.snapshot(m);
  }

  /** Webview чата пересоздан. */
  chatReady(): void {
    this.link.chatReady();
  }

  /** Закрыть вкладку (закрыли чат, не дождались чата после перезагрузки). */
  close(): void {
    if (!this.disposed) this.panel.dispose();
  }

  private disposeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.link.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.onClose?.();
  }
}

/** Восстановленные после перезагрузки окна графы, чья вкладка чата ещё не появилась. */
const pending = new PendingGraphs<AgentsGraphPanel>();

/**
 * Граф одной вкладки чата: открыть или показать, принять восстановленный, переслать снимок, закрыть вместе с
 * чатом. Вкладка чата держит один такой слот.
 */
export class ChatGraphSlot {
  private graph: AgentsGraphPanel | undefined;

  constructor(
    readonly chat: GraphChat,
    private readonly create: () => AgentsGraphPanel,
  ) {}

  get open(): boolean {
    return this.graph !== undefined;
  }

  /** «↗ граф», «карта агентов» при `graph`: открыть граф или показать открытый, выбрать агента. */
  show(agentId?: string): void {
    if (!this.graph) this.attach(this.create());
    this.graph?.reveal(agentId);
  }

  attach(graph: AgentsGraphPanel): void {
    this.graph = graph;
    graph.onClose = () => {
      if (this.graph === graph) this.graph = undefined;
    };
    graph.bind(this.chat);
  }

  /** Вкладка получила сессию (открыта, возобновлена): забрать восстановленный граф этой сессии. */
  claimPending(): void {
    const id = this.chat.sessionId();
    if (!id || this.graph) return;
    const graph = pending.claim(id);
    if (graph) this.attach(graph);
  }

  snapshot(m: Extract<FromWebview, { type: 'agents.snapshot' }>): void {
    this.graph?.snapshot(m);
  }

  /** Webview чата пересоздан: снова сказать ему, что граф открыт. */
  chatReady(): void {
    this.graph?.chatReady();
  }

  /** Вкладку чата закрыли: граф показывает её данные — закрыть и его. */
  close(): void {
    this.graph?.close();
  }
}

/**
 * Сериализатор вкладки графа: после «Reload Window» граф возвращается к вкладке чата с той же сессией
 * (id — из состояния webview графа). Чата с ней нет и за `GRAPH_RESTORE_MS` не появилось, или сессии у графа не
 * было — вкладка закрывается: пустой граф или граф чужой сессии хуже, чем никакого.
 */
export function graphSerializer(
  context: vscode.ExtensionContext,
  log: Logger,
  slots: () => readonly ChatGraphSlot[],
): vscode.WebviewPanelSerializer {
  return {
    deserializeWebviewPanel: async (panel, state: unknown) => {
      const graph = AgentsGraphPanel.restore(panel, context, log);
      const id = graphStateSession(state);
      if (!id) {
        graph.close();
        return;
      }
      const slot = slots().find((s) => !s.open && s.chat.sessionId() === id);
      if (slot) {
        slot.attach(graph);
        return;
      }
      pending.add(id, graph);
      const timer = setTimeout(() => {
        if (!pending.remove(graph)) return;
        log.info(`граф агентов ${id.slice(0, 8)}: вкладка чата не восстановлена — граф закрыт`);
        graph.close();
      }, GRAPH_RESTORE_MS);
      graph.onClose = () => {
        clearTimeout(timer);
        pending.remove(graph);
      };
    },
  };
}
