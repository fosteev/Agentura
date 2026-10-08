import * as vscode from 'vscode';
import type { Logger } from './logger';
import { hostStrings } from '../shared/l10n';
import { issueContext } from '../data/jira/text';
import { ChatPanel, type ChatServices } from './chatPanel';
import { parseTaskKey, taskKeyOf, type TaskGroups, type TaskMeta } from './taskGroups';
import { bareMeta, baseUrlOfIssueUrl, parseIssueInput, sessionIdOf, type IssueInput } from './taskLink';
import { currentLanguage } from './webviewHost';

/**
 * Инстансы, о которых Agentura знает: подключения источников (Jiraffe, свои) и группы задач — id → адрес
 * (у мигрированных групп адрес может быть пустым; непустой из источника важнее).
 */
export function knownInstances(
  groups: TaskGroups,
  sources: { allInstances(): { id: string; baseUrl: string }[] },
): { instanceId: string; baseUrl: string }[] {
  const seen = new Map<string, string>();
  for (const i of sources.allInstances()) seen.set(i.id, i.baseUrl);
  for (const g of Object.values(groups.groups())) {
    const base = g.task.url ? baseUrlOfIssueUrl(g.task.url) : '';
    if (!seen.get(g.task.instanceId)) seen.set(g.task.instanceId, base);
  }
  return [...seen].map(([instanceId, baseUrl]) => ({ instanceId, baseUrl }));
}

/**
 * Инстанс по вводу человека: из ссылки, из ключа группы или выбор среди известных. `undefined` — отмена или
 * предупреждение уже показано.
 */
async function resolveInstance(
  parsed: IssueInput,
  services: ChatServices,
): Promise<{ instanceId: string; baseUrl: string } | undefined> {
  const t = hostStrings(currentLanguage());
  if (parsed.kind === 'link') return { instanceId: parsed.instanceId, baseUrl: parsed.baseUrl };
  const known = knownInstances(services.taskGroups, services.jira);
  if (parsed.kind === 'taskKey') {
    return { instanceId: parsed.instanceId, baseUrl: known.find((i) => i.instanceId === parsed.instanceId)?.baseUrl ?? '' };
  }
  if (known.length === 0) {
    void vscode.window.showWarningMessage(t.bindTaskNoInstance);
    return undefined;
  }
  if (known.length === 1) return known[0]!;
  return (
    await vscode.window.showQuickPick(
      known.map((i) => ({ label: i.instanceId, description: i.baseUrl, i })),
      { placeHolder: t.bindTaskPickInstance },
    )
  )?.i;
}

/**
 * «Привязать вкладку к задаче…» / «Отвязать от задачи». Аргумент — id сессии (строка списка в боковой панели);
 * без него — активная вкладка. Jira не запрашивается: название задачи — её ключ, пока источник Jira его не обновил.
 */
export function registerTaskCommands(
  context: vscode.ExtensionContext,
  log: Logger,
  services: ChatServices,
): vscode.Disposable[] {
  const t = () => hostStrings(currentLanguage());

  const bind = async (arg?: unknown): Promise<void> => {
    const sessionId = sessionIdOf(arg);
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
    const inst = await resolveInstance(parsed, services);
    if (!inst) return;
    const { instanceId, baseUrl } = inst;
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
    const sessionId = sessionIdOf(arg);
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

  /**
   * «Чат по задаче…»: ключ или ссылка → инстанс → новая вкладка в группе задачи. С источником Jira карточка
   * тянется и кладётся в поле ввода файлом (`issueContext`, как у Jiraffe); без него (или при ошибке) чат открывается
   * без данных задачи, но привязанным: карточка появится, когда источник заработает.
   */
  const chatForTask = async (arg?: unknown): Promise<void> => {
    // аргумент — ключ группы `jira:<инстанс>:<KEY>` («＋» у группы в сайдбаре, блок «Чаты по задаче»): без вопросов
    const text =
      typeof arg === 'string' && parseTaskKey(arg)
        ? arg
        : await vscode.window.showInputBox({ prompt: t().bindTaskPrompt, ignoreFocusOut: true });
    if (text === undefined) return;
    const parsed = parseIssueInput(text);
    if (!parsed) {
      void vscode.window.showWarningMessage(t().bindTaskBad);
      return;
    }
    const inst = await resolveInstance(parsed, services);
    if (!inst) return;
    const key = parsed.key;
    const { instanceId } = inst;
    let baseUrl = inst.baseUrl;
    const known = services.taskGroups.group(taskKeyOf(instanceId, key))?.task;
    let meta: TaskMeta = known ?? bareMeta(key, instanceId, baseUrl ? `${baseUrl}/browse/${key}` : '');
    let body = '';
    const src = services.jira.forInstance(instanceId);
    if (src) {
      try {
        const { issue } = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t().chatForTaskProgress(key) },
          () => src.issue(instanceId, key),
        );
        const ref = src.instances().find((i) => i.id === instanceId);
        baseUrl = ref?.baseUrl ?? baseUrl;
        const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${key}` : meta.url;
        meta = { key, instanceId, title: issue.summary, status: issue.status, statusCategory: issue.statusCategory, url };
        body = issueContext({ instanceName: ref?.name ?? instanceId, issue }, url);
      } catch (e) {
        log.warn(`agentura.chatForTask: ${key}`, e);
        void vscode.window.showWarningMessage(t().chatForTaskFailed(key, e instanceof Error ? e.message : String(e)));
      }
    } else {
      // без источника чат не открываем — предлагаем подключить (решение владельца 2026-10-08)
      const pick = await vscode.window.showWarningMessage(
        t().chatForTaskNoSource(key),
        t().chatForTaskConnect,
        t().chatForTaskJiraffe,
      );
      if (pick === t().chatForTaskConnect) void vscode.commands.executeCommand('agentura.jira.connect');
      else if (pick === t().chatForTaskJiraffe)
        void vscode.commands.executeCommand('workbench.extensions.search', '@id:fosteev.jiraffe');
      return;
    }
    if (!body) body = `# ${key}\n\n${meta.url ? `- URL: ${meta.url}\n` : ''}\n(Issue data is not loaded: no Jira source.)\n`;
    await ChatPanel.openWithContext(context, log, services, { name: `${key}.md`, context: body, task: meta, session: 'new' });
  };

  return [
    vscode.commands.registerCommand('agentura.bindTask', bind),
    vscode.commands.registerCommand('agentura.unbindTask', unbind),
    vscode.commands.registerCommand('agentura.chatForTask', chatForTask),
  ];
}
