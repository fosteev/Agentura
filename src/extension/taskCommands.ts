import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from './logger';
import { hostStrings } from '../shared/l10n';
import { issueContext } from '../data/jira/text';
import { ChatPanel, adapterOf, taskCodeChats, taskCodeDeps, type ChatServices } from './chatPanel';
import {
  HANDOFF_MODEL,
  HANDOFF_SYSTEM,
  HANDOFF_TIMEOUT_MS,
  changesText,
  handoffFile,
  handoffInput,
  handoffNames,
  handoffPrompt,
  mainRepoDir,
  newChatOptions,
  publicNewChatOptions,
  worktreeBranch,
  worktreeCwd,
  worktreeDir,
  worktreeN,
  worktreeRepo,
  type NewChatOptions,
} from './jira/handoff';
import { collectCode } from './jira/taskCode';
import { codeMatchSettings } from './jira/setup';
import { runGit } from './git/gitService';
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

  /** Ошибка одной строкой (stderr git — первая строка). */
  const errLine = (e: unknown): string => {
    const err = e as { stderr?: unknown; message?: unknown } | undefined;
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const msg = stderr || (typeof err?.message === 'string' ? err.message : String(e));
    return msg.split('\n')[0]!.slice(0, 300);
  };

  /**
   * Своя worktree нового чата (roadmap 26, решение 7): репозиторий рабочей папки источника, соседняя с основным
   * репозиторием папка `<repo>-<KEY>-<n>` (из worktree-чата — тоже от основного, Д7), ветка `feature/<KEY>-<n>` от
   * `HEAD` источника. Возвращает рабочую папку чата: та же подпапка, что у источника (есть в worktree), иначе корень.
   * Сбой — ошибка одной строкой и `undefined` (чат не открывается).
   */
  const makeWorktree = async (key: string, cwd: string): Promise<string | undefined> => {
    let gitPath: string;
    let repo: string | undefined;
    try {
      const r = await services.git.rootsFor(cwd);
      gitPath = r.gitPath;
      repo = worktreeRepo(cwd, r.roots);
    } catch (e) {
      void vscode.window.showErrorMessage(t().newChatWorktreeFailed(errLine(e)));
      return undefined;
    }
    if (!repo) {
      void vscode.window.showErrorMessage(t().newChatWorktreeNoRepo);
      return undefined;
    }
    try {
      const common = await runGit(gitPath, ['rev-parse', '--git-common-dir'], repo).catch(() => '');
      const main = mainRepoDir(repo, common);
      const parent = path.dirname(main);
      const name = path.basename(main);
      const dirs = await readdir(parent).catch(() => [] as string[]);
      const out = await runGit(gitPath, ['branch', '--list', '--format=%(refname:short)', `feature/${key}-*`], repo);
      const branches = out.split('\n').map((x) => x.trim()).filter(Boolean);
      const n = worktreeN(name, key, dirs, branches);
      const dir = path.join(parent, worktreeDir(name, key, n));
      await runGit(gitPath, ['worktree', 'add', '-b', worktreeBranch(key, n), dir, 'HEAD'], repo);
      log.info(`agentura.chatForTask: worktree ${dir} (${worktreeBranch(key, n)})`);
      const sub = worktreeCwd(repo, cwd, dir);
      // подпапки может не быть в HEAD (не закоммичена) — тогда корень worktree
      return sub !== dir && (await stat(sub).then((st) => st.isDirectory(), () => false)) ? sub : dir;
    } catch (e) {
      log.warn(`agentura.chatForTask: worktree ${key}`, e);
      void vscode.window.showErrorMessage(t().newChatWorktreeFailed(errLine(e)));
      return undefined;
    }
  };

  /** Итог чата-источника (решение 4): история → вход → Claude `complete`. Сбой — строка причины. */
  const summaryOf = async (from: NonNullable<NewChatOptions['from']>): Promise<{ text: string } | string> => {
    if (!from.id) return t().newChatSummaryNoSession;
    const complete = services.adapter.complete;
    if (!complete) return t().newChatSummaryNoModel;
    try {
      const history = await adapterOf(services, from.provider).loadHistory(from.id, from.cwd);
      const input = handoffInput(history.events);
      if (!input) return t().newChatSummaryEmpty;
      const listed = (await services.sessions.list().catch(() => [])).find((r) => r.id === from.id)?.title;
      const title = listed && listed !== from.id ? listed : from.id;
      const text = await complete.call(services.adapter, from.cwd, {
        system: HANDOFF_SYSTEM,
        prompt: handoffPrompt(title, from.provider, input),
        model: HANDOFF_MODEL,
        timeoutMs: HANDOFF_TIMEOUT_MS,
      });
      if (!text.trim()) return t().newChatSummaryEmpty;
      return { text: handoffFile(title, from.provider, text) };
    } catch (e) {
      log.warn('agentura.chatForTask: итог чата', e);
      return errLine(e);
    }
  };

  /** Изменения задачи (решение 4): итог вкладки «код» по задаче текстом. Сбой — строка причины. */
  const changesOf = async (key: string, taskKey: string, cwd: string): Promise<string | { text: string }> => {
    try {
      const chats = await taskCodeChats(services, taskKey);
      const res = await collectCode(taskCodeDeps(services), { key, cwd, chats, match: codeMatchSettings() });
      if (res.error && !res.repos.length) return res.error;
      return { text: changesText(key, res.repos) };
    } catch (e) {
      log.warn('agentura.chatForTask: изменения задачи', e);
      return errLine(e);
    }
  };

  /**
   * «Чат по задаче…»: ключ или ссылка → инстанс → новая вкладка в группе задачи. С источником Jira карточка
   * тянется и кладётся в поле ввода файлом (`issueContext`, как у Jiraffe); без него (или при ошибке) чат открывается
   * без данных задачи, но привязанным: карточка появится, когда источник заработает.
   * Второй аргумент (roadmap 26, `NewChatOptions`) — новый чат из вкладки чата: движок (нет — движок источника), что
   * передать (контекст задачи, итог чата-источника, изменения задачи), своя worktree, «рядом», первое сообщение
   * (уходит само). Без `from` (не из вкладки чата) итог, изменения, worktree и «рядом» не действуют, а первое сообщение
   * только встаёт в поле ввода. `opts` уже
   * проверены: публичная команда — `publicNewChatOptions`, вкладка чата — `newChatOptions` (Д4 доводки 1).
   */
  const chatForTask = async (arg: unknown, opts: NewChatOptions): Promise<void> => {
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
    const carry = opts.carry ?? { task: true };
    const src = services.jira.forInstance(instanceId);
    // без «контекста задачи» (Д8): Jira не тянем — метаданные из группы (или ключ), источник не обязателен
    if (carry.task && src) {
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
    } else if (carry.task) {
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
    if (carry.task && !body) {
      body = `# ${key}\n\n${meta.url ? `- URL: ${meta.url}\n` : ''}\n(Issue data is not loaded: no Jira source.)\n`;
    }
    const { from } = opts;
    const names = handoffNames(key);
    // своя worktree — до итога: её сбой отменяет чат, итог (до 90 с) тогда не нужен
    let cwd: string | undefined;
    if (from && opts.where === 'worktree') {
      cwd = await makeWorktree(key, from.cwd);
      if (!cwd) return;
    }
    const files: { name: string; text: string }[] = [];
    if (from && (carry.summary || carry.changes)) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: carry.summary ? t().newChatSummaryProgress : t().newChatChangesProgress(key),
        },
        async () => {
          const [summary, changes] = await Promise.all([
            carry.summary ? summaryOf(from) : undefined,
            carry.changes ? changesOf(key, taskKeyOf(instanceId, key), from.cwd) : undefined,
          ]);
          if (typeof summary === 'string') void vscode.window.showWarningMessage(t().newChatSummaryFailed(summary));
          else if (summary) files.push({ name: names.summary, text: summary.text });
          if (typeof changes === 'string') void vscode.window.showWarningMessage(t().newChatChangesFailed(changes));
          else if (changes) files.push({ name: names.changes, text: changes.text });
        },
      );
    }
    const provider = opts.provider ?? from?.provider;
    await ChatPanel.openWithContext(context, log, services, {
      name: names.task,
      context: carry.task ? body : '',
      task: meta,
      session: 'new',
      ...(provider ? { provider } : {}),
      ...(files.length ? { files } : {}),
      // уходит само только из вкладки чата (есть `from`); снаружи — лишь в поле ввода, как у `openWithContext` (Д4)
      ...(opts.prompt ? { prompt: opts.prompt, ...(from ? { autoSend: true } : {}) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(from && opts.beside ? { beside: true } : {}),
    });
  };

  return [
    vscode.commands.registerCommand('agentura.bindTask', bind),
    vscode.commands.registerCommand('agentura.unbindTask', unbind),
    // публичная команда: из аргумента — только движок, первое сообщение и «контекст задачи» (Д4)
    vscode.commands.registerCommand('agentura.chatForTask', (arg?: unknown, raw?: unknown) =>
      chatForTask(arg, publicNewChatOptions(raw)),
    ),
    // вкладка чата зовёт напрямую, с собой как источником (`from`), — не через `executeCommand`
    ChatPanel.setNewTaskChat((taskKey, raw) => chatForTask(taskKey, newChatOptions(raw))),
  ];
}
