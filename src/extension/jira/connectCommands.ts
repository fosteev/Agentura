import * as vscode from 'vscode';
import { createJiraClient } from '../../data/jira/client';
import type { InstanceKind } from '../../data/jira/types';
import { hostStrings } from '../../shared/l10n';
import { canonicalBaseUrl, instanceIdFromUrl } from '../taskLink';
import { currentLanguage } from '../webviewHost';
import type { OwnInstance, OwnInstanceStore } from './ownInstances';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const withProgress = <T>(title: string, task: () => Promise<T>): Thenable<T> =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

/** Шаги «Подключить Jira…» — как `addInstance` Jiraffe 0.7.0 (src/commands/instances.ts), но в рамках воркспейса и без capabilities. */
async function connect(store: OwnInstanceStore): Promise<void> {
  const t = hostStrings(currentLanguage());
  const rawUrl = await vscode.window.showInputBox({
    title: t.jiraConnectUrlTitle,
    prompt: t.jiraConnectUrlPrompt,
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        const u = new URL(canonicalBaseUrl(v));
        return u.protocol === 'https:' || u.protocol === 'http:' ? undefined : t.jiraConnectUrlScheme;
      } catch {
        return t.jiraConnectUrlBad;
      }
    },
  });
  if (!rawUrl) return;
  const baseUrl = canonicalBaseUrl(rawUrl);
  if (
    baseUrl.startsWith('http:') &&
    (await vscode.window.showWarningMessage(t.jiraConnectInsecure(baseUrl), { modal: true }, t.jiraConnectContinue)) !==
      t.jiraConnectContinue
  )
    return;
  const id = instanceIdFromUrl(baseUrl);
  if (
    store.get(id) &&
    (await vscode.window.showWarningMessage(t.jiraConnectReplace(id), { modal: true }, t.jiraConnectReplaceButton)) !==
      t.jiraConnectReplaceButton
  )
    return;

  const guess: InstanceKind = new URL(baseUrl).host.endsWith('.atlassian.net') ? 'cloud' : 'dc';
  const kinds = [
    { label: 'Server / Data Center', description: 'Bearer PAT', instKind: 'dc' as InstanceKind },
    { label: 'Cloud', description: t.jiraConnectKindCloud, instKind: 'cloud' as InstanceKind },
  ].sort((a, b) => Number(b.instKind === guess) - Number(a.instKind === guess));
  const kindPick = await vscode.window.showQuickPick(kinds, { placeHolder: t.jiraConnectKindPlaceholder, ignoreFocusOut: true });
  if (!kindPick) return;
  const kind = kindPick.instKind;

  let email: string | undefined;
  if (kind === 'cloud') {
    email = await vscode.window.showInputBox({
      title: t.jiraConnectEmailTitle,
      prompt: t.jiraConnectEmailPrompt,
      ignoreFocusOut: true,
      validateInput: (v) => (v.includes('@') ? undefined : t.jiraConnectEmailBad),
    });
    if (!email) return;
    email = email.trim();
  }

  const token = await vscode.window.showInputBox({
    title: t.jiraConnectTokenTitle,
    prompt: kind === 'cloud' ? t.jiraConnectTokenPromptCloud : t.jiraConnectTokenPromptDc,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim() ? t.jiraConnectTokenEmpty : /^[\x21-\x7e]+$/.test(v.trim()) ? undefined : t.jiraConnectTokenBad,
  });
  if (!token) return;

  const client = createJiraClient({ id, kind, baseUrl, ...(email ? { email } : {}) }, token.trim());
  let displayName: string;
  try {
    displayName = (await withProgress(t.jiraConnectProgress(baseUrl), () => client.myself())).displayName;
  } catch (e) {
    void vscode.window.showErrorMessage(t.jiraConnectFailed(errText(e)));
    return;
  }

  const name = await vscode.window.showInputBox({
    title: t.jiraConnectNameTitle,
    prompt: t.jiraConnectNamePrompt(displayName),
    value: new URL(baseUrl).host,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : t.jiraConnectNameEmpty),
  });
  if (!name) return;

  const inst: OwnInstance = { id, name: name.trim(), baseUrl, kind, ...(email ? { email } : {}) };
  await store.add(inst, token.trim());
  void vscode.window.showInformationMessage(t.jiraConnected(inst.name));
}

async function pickOwn(store: OwnInstanceStore, placeHolder: string, instanceId?: string): Promise<OwnInstance | undefined> {
  const t = hostStrings(currentLanguage());
  const all = store.list();
  const known = instanceId ? store.get(instanceId) : undefined;
  if (known) return known;
  if (all.length === 0) {
    void vscode.window.showInformationMessage(t.jiraDisconnectNone);
    return undefined;
  }
  if (all.length === 1) return all[0];
  return (await vscode.window.showQuickPick(all.map((i) => ({ label: i.name, description: i.baseUrl, i })), { placeHolder }))?.i;
}

/** «Подключить Jira…», «Отключить Jira…», «Проверить подключение Jira» (решение 4). */
export function registerJiraConnectCommands(store: OwnInstanceStore): vscode.Disposable[] {
  const t = () => hostStrings(currentLanguage());
  return [
    vscode.commands.registerCommand('agentura.jira.connect', () => connect(store)),
    vscode.commands.registerCommand('agentura.jira.disconnect', async (instanceId?: unknown) => {
      const inst = await pickOwn(store, t().jiraDisconnectPick, typeof instanceId === 'string' ? instanceId : undefined);
      if (!inst) return;
      const ok = await vscode.window.showWarningMessage(t().jiraDisconnectConfirm(inst.name), { modal: true }, t().jiraDisconnectButton);
      if (ok !== t().jiraDisconnectButton) return;
      await store.remove(inst.id);
      void vscode.window.showInformationMessage(t().jiraDisconnected(inst.name));
    }),
    vscode.commands.registerCommand('agentura.jira.test', async (instanceId?: unknown) => {
      const inst = await pickOwn(store, t().jiraTestPick, typeof instanceId === 'string' ? instanceId : undefined);
      if (!inst) return;
      try {
        const token = await store.token(inst.id);
        if (!token) throw new Error('token not found in SecretStorage — connect the instance again');
        const me = await createJiraClient(inst, token).myself();
        void vscode.window.showInformationMessage(t().jiraTestOk(inst.name, me.displayName));
      } catch (e) {
        void vscode.window.showErrorMessage(t().jiraTestFailed(inst.name, errText(e)));
      }
    }),
  ];
}
