import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXT_ID = 'fost.agentura';

async function waitFor(cond: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`Не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const chatTabs = (): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('agentura.chat'),
    );

export const tests: Record<string, () => Promise<void>> = {
  async 'расширение найдено и активируется'() {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `расширение ${EXT_ID} не найдено`);
    await ext.activate();
    assert.equal(ext.isActive, true);
  },

  async 'команды зарегистрированы'() {
    const all = await vscode.commands.getCommands(true);
    const pkg = vscode.extensions.getExtension(EXT_ID)!.packageJSON as {
      contributes: { commands: { command: string }[] };
    };
    for (const { command } of pkg.contributes.commands) {
      assert.ok(all.includes(command), `команда ${command} не зарегистрирована`);
    }
    assert.ok(all.includes('agentura.debug.showState'));
  },

  async 'боковая панель Agentura регистрируется'() {
    // контейнер и вид объявлены в package.json; провайдер зарегистрирован при активации —
    // команда фокуса вида существует только у зарегистрированного вида
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('agentura.sidebar.focus'), 'вид agentura.sidebar не зарегистрирован');
    await vscode.commands.executeCommand('agentura.sidebar.focus');
  },

  async 'agentura.open создаёт вкладку чата'() {
    const before = chatTabs().length;
    await vscode.commands.executeCommand('agentura.open');
    await waitFor(() => chatTabs().length > before, 'вкладка agentura.chat');
    assert.ok(chatTabs().length > before);
  },

  async 'повторный agentura.open не плодит вкладки пустых сессий'() {
    const n = chatTabs().length;
    await vscode.commands.executeCommand('agentura.open');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(chatTabs().length, n);
  },
};
