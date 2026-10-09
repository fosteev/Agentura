import * as vscode from 'vscode';
import { setJiraLang } from '../../data/jira/i18n';
import {
  DEFAULT_JIRA_SOURCE,
  DEFAULT_TASK_REFRESH,
  isJiraSource,
  isTaskRefresh,
  type JiraSourceSetting,
  type TaskRefreshMode,
} from '../../settings';
import { hostStrings } from '../../shared/l10n';
import { currentLanguage } from '../webviewHost';
import { registerJiraConnectCommands } from './connectCommands';
import { parseJiraffeApi } from './jiraffeApi';
import { OwnInstanceStore, workspaceId } from './ownInstances';
import { JiraSources, OwnSource } from './source';
import { TaskService } from './taskService';
import type { TaskGroups } from '../taskGroups';

export const JIRAFFE_ID = 'fosteev.jiraffe';

const config = () => vscode.workspace.getConfiguration('agentura');

export function jiraSourceSetting(): JiraSourceSetting {
  const v = config().get<unknown>('jira.source');
  return isJiraSource(v) ? v : DEFAULT_JIRA_SOURCE;
}

export function taskSettings(): { refresh: TaskRefreshMode; humanChanges: boolean } {
  const r = config().get<unknown>('tasks.refresh');
  const h = config().get<unknown>('tasks.humanChanges');
  return { refresh: isTaskRefresh(r) ? r : DEFAULT_TASK_REFRESH, humanChanges: h !== false };
}

export interface JiraRuntime {
  sources: JiraSources;
  own: OwnInstanceStore;
  tasks: TaskService;
  /** Команды подключения и подписки на изменения: положить в `context.subscriptions`. */
  disposables: vscode.Disposable[];
}

/**
 * Источники Jira и сервис задач (roadmap 19, этап 2): свои подключения воркспейса, Jiraffe по его API, пересчёт при
 * смене настройки, установке/удалении расширений и изменении подключений.
 */
export function createJira(context: vscode.ExtensionContext, taskGroups: TaskGroups): JiraRuntime {
  setJiraLang(currentLanguage());
  const own = new OwnInstanceStore(
    context.workspaceState,
    context.secrets,
    workspaceId(vscode.workspace.workspaceFolders?.[0]?.uri.toString()),
  );
  const sources = new JiraSources({
    setting: jiraSourceSetting,
    jiraffeInstalled: () => vscode.extensions.getExtension(JIRAFFE_ID) !== undefined,
    // `activate()` уже активного расширения возвращает его exports; в недоверенном воркспейсе Jiraffe не активируется
    // (exports — undefined), активация может и бросить — оба случая для JiraSources «API нет»
    jiraffeExports: async () => vscode.extensions.getExtension(JIRAFFE_ID)?.activate(),
    own: new OwnSource(own),
    parse: parseJiraffeApi,
  });
  const t = () => hostStrings(currentLanguage());
  const tasks = new TaskService({
    sources,
    groups: taskGroups,
    settings: taskSettings,
    messages: {
      get off() {
        return t().jiraOff;
      },
      get noSource() {
        return t().jiraNoSource;
      },
      get timeout() {
        return t().jiraTimeout;
      },
      unknownInstance: (id) => t().jiraUnknownInstance(id),
    },
  });
  const disposables: vscode.Disposable[] = [
    ...registerJiraConnectCommands(own),
    // всегда (force): переподключение того же инстанса с новым токеном набор id не меняет, а ошибку 401 снять нужно
    { dispose: own.onChange(() => sources.notifyIfChanged(true)) },
    { dispose: sources.onDidChange(() => tasks.reconfigure()) },
    vscode.extensions.onDidChange(() => void sources.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentura.jira')) void sources.refresh().then(() => sources.notifyIfChanged());
      else if (e.affectsConfiguration('agentura.tasks')) tasks.settingsChanged();
    }),
    { dispose: () => sources.dispose() },
    { dispose: () => tasks.dispose() },
  ];
  // первый расчёт не блокирует активацию: Jiraffe активируется в фоне
  void sources.refresh().catch(() => undefined);
  return { sources, own, tasks, disposables };
}
