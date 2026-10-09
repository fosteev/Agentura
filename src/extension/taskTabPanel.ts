/**
 * Вкладка на задачу (`agentura.tasks.tab = task`, roadmap 19, этап 7, вариант Б): одна `WebviewPanel` на задачу,
 * её чаты — внутренние вкладки под полоской задачи. Каждый чат — обычный `ChatPanel` со своим `ChatController`;
 * вкладка даёт ему поверхность (`ChatSurface`), а мультиплексирует их `TabSlots`.
 */
import * as vscode from 'vscode';
import { postToWebview } from '../protocol';
import type { Logger } from './logger';
import { chatIcon, type ChatSurface } from './chatSurface';
import { TabSlots, type SlotInfo } from './tabSlots';
import { hostStrings } from '../shared/l10n';
import { parseTaskKey, type TaskKey } from './taskGroups';
import { attachMessaging, currentLanguage, renderWebview, userFontsDir, webviewOptions } from './webviewHost';

export class TaskTabPanel {
  private static readonly tabs: TaskTabPanel[] = [];
  private readonly slots: TabSlots;
  private readonly disposables: vscode.Disposable[] = [];

  /** Открытая вкладка задачи `taskKey`. */
  static forTask(taskKey: TaskKey): TaskTabPanel | undefined {
    return TaskTabPanel.tabs.find((t) => t.taskKey === taskKey);
  }

  /** Новая вкладка задачи: своя `WebviewPanel` или готовая (сериализатор). */
  static create(
    context: vscode.ExtensionContext,
    log: Logger,
    taskKey: TaskKey,
    column: vscode.ViewColumn,
    panel?: vscode.WebviewPanel,
  ): TaskTabPanel {
    const p =
      panel ??
      vscode.window.createWebviewPanel('agentura.chat', 'Agentura', column, {
        ...webviewOptions(context.extensionUri, userFontsDir(context)),
        retainContextWhenHidden: true,
      });
    return new TaskTabPanel(p, context, log, taskKey);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
    readonly taskKey: TaskKey,
  ) {
    const version = String(context.extension.packageJSON.version);
    panel.webview.options = webviewOptions(context.extensionUri, userFontsDir(context));
    panel.iconPath = chatIcon(context);
    panel.webview.html = renderWebview(panel.webview, context.extensionUri, 'chat', 'Agentura', currentLanguage());
    this.slots = new TabSlots(taskKey, {
      post: (m) => postToWebview(panel.webview, m),
      setTitle: (t) => (panel.title = t),
      displayKey: parseTaskKey(taskKey)?.key ?? taskKey,
      // «＋» — как «＋» группы в боковой панели: контекст задачи из источника, чат придёт сюда же (`ChatPanel.apply`)
      onNew: () => void vscode.commands.executeCommand('agentura.chatForTask', taskKey),
      onEmpty: () => panel.dispose(),
      // «×» чата с идущим ходом или ждущим ответа — модальный вопрос (решение владельца 2026-10-08)
      confirmClose: async (title) => {
        const t = hostStrings(currentLanguage());
        const button = t.closeBusyChatButton;
        const pick = await vscode.window.showWarningMessage(t.closeBusyChat(title), { modal: true, detail: t.closeBusyChatDetail }, button);
        return pick === button;
      },
    });
    TaskTabPanel.tabs.push(this);
    this.disposables.push(
      attachMessaging(panel.webview, 'chat', version, log, (m) => this.slots.receive(m)),
      panel.onDidChangeViewState(() => this.slots.viewChanged()),
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Чат во вкладке (не показан, пока не вызван `reveal` его поверхности). */
  addSurface(describe: () => SlotInfo | undefined): ChatSurface {
    const id = this.slots.add(describe);
    const { panel, slots } = this;
    const taskKey = this.taskKey;
    return {
      post: (m) => slots.post(id, m),
      setTitle: () => slots.refresh(),
      get visible() {
        return panel.visible && slots.isActive(id);
      },
      get active() {
        return panel.active && slots.isActive(id);
      },
      get shown() {
        return slots.isActive(id);
      },
      get viewColumn() {
        return panel.viewColumn;
      },
      reveal: (column) => {
        slots.activate(id);
        panel.reveal(column);
      },
      select: () => slots.activate(id),
      onDidChangeViewState: (cb) => slots.onView(id, cb),
      onMessage: (cb) => slots.onMessage(id, cb),
      onDidDispose: (cb) => slots.onGone(id, cb),
      taskTab: taskKey,
      changed: () => slots.refresh(),
    };
  }

  private dispose(): void {
    const i = TaskTabPanel.tabs.indexOf(this);
    if (i >= 0) TaskTabPanel.tabs.splice(i, 1);
    this.slots.disposeAll();
    this.disposables.forEach((d) => d.dispose());
  }
}
