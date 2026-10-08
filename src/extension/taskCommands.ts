import * as vscode from 'vscode';
import { hostStrings } from '../shared/l10n';
import { ChatPanel, type ChatServices } from './chatPanel';
import { taskKeyOf, type TaskGroups, type TaskMeta } from './taskGroups';
import { bareMeta, baseUrlOfIssueUrl, parseIssueInput } from './taskLink';
import { currentLanguage } from './webviewHost';

/** Инстансы, о которых Agentura уже знает по группам: id → адрес (может быть пустым у мигрированных). */
function knownInstances(groups: TaskGroups): { instanceId: string; baseUrl: string }[] {
  const seen = new Map<string, string>();
  for (const g of Object.values(groups.groups())) {
    const base = g.task.url ? baseUrlOfIssueUrl(g.task.url) : '';
    if (!seen.get(g.task.instanceId)) seen.set(g.task.instanceId, base);
  }
  return [...seen].map(([instanceId, baseUrl]) => ({ instanceId, baseUrl }));
}

/**
 * «Привязать вкладку к задаче…» / «Отвязать от задачи». Аргумент — id сессии (строка списка в боковой панели);
 * без него — активная вкладка. Jira не запрашивается: название задачи — её ключ, пока источник Jira его не обновил.
 */
export function registerTaskCommands(services: ChatServices): vscode.Disposable[] {
  const t = () => hostStrings(currentLanguage());

  const bind = async (arg?: unknown): Promise<void> => {
    const sessionId = typeof arg === 'string' ? arg : undefined;
    const panel = sessionId ? ChatPanel.panelOf(sessionId) : ChatPanel.target();
    if (!panel && !sessionId) {
      void vscode.window.showWarningMessage(t().bindTaskNoTab);
      return;
    }
    const text = await vscode.window.showInputBox({ prompt: t().bindTaskPrompt, ignoreFocusOut: true });
    if (text === undefined) return;
    const parsed = parseIssueInput(text);
    if (!parsed) {
      void vscode.window.showWarningMessage(t().bindTaskBad);
      return;
    }
    const groups = services.taskGroups;
    let instanceId: string;
    let baseUrl: string;
    if (parsed.kind === 'link') {
      ({ instanceId, baseUrl } = parsed);
    } else if (parsed.kind === 'taskKey') {
      instanceId = parsed.instanceId;
      baseUrl = knownInstances(groups).find((i) => i.instanceId === instanceId)?.baseUrl ?? '';
    } else {
      const known = knownInstances(groups);
      if (known.length === 0) {
        void vscode.window.showWarningMessage(t().bindTaskNoInstance);
        return;
      }
      const pick =
        known.length === 1
          ? known[0]!
          : (
              await vscode.window.showQuickPick(
                known.map((i) => ({ label: i.instanceId, description: i.baseUrl, i })),
                { placeHolder: t().bindTaskPickInstance },
              )
            )?.i;
      if (!pick) return;
      ({ instanceId, baseUrl } = pick);
    }
    const key = parsed.key;
    const taskKey = taskKeyOf(instanceId, key);
    const meta: TaskMeta =
      groups.group(taskKey)?.task ?? bareMeta(key, instanceId, baseUrl ? `${baseUrl}/browse/${key}` : '');
    if (panel) panel.bind(taskKey, meta);
    else if (sessionId) {
      // сессия без открытой вкладки (строка списка): в группу напрямую, вкладка получит ключ при открытии
      groups.add(taskKey, meta, { provider: services.sessions.providerOf(sessionId), id: sessionId }, Date.now());
    }
    void vscode.window.showInformationMessage(t().taskBound(key));
  };

  const unbind = (arg?: unknown): void => {
    const sessionId = typeof arg === 'string' ? arg : undefined;
    const panel = sessionId ? ChatPanel.panelOf(sessionId) : ChatPanel.target();
    if (!panel && !sessionId) {
      void vscode.window.showWarningMessage(t().bindTaskNoTab);
      return;
    }
    // ключ в заголовке вкладки — и группа, и ожидание задачи; без вкладки — только группа
    const bound = panel ? panel.task !== undefined : !!services.taskGroups.groupOf(sessionId!);
    if (!bound) {
      void vscode.window.showInformationMessage(t().taskNotBound);
      return;
    }
    if (panel) panel.unbind();
    else services.taskGroups.remove(sessionId!);
    void vscode.window.showInformationMessage(t().taskUnbound);
  };

  return [
    vscode.commands.registerCommand('agentura.bindTask', bind),
    vscode.commands.registerCommand('agentura.unbindTask', unbind),
  ];
}
