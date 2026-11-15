import { describe, expect, it, vi } from 'vitest';
import type { EngineLimitsSummary, FromWebview } from '../protocol';
import { KimiCatalogError } from '../agent/kimi/models';

const h = vi.hoisted(() => ({
  message: undefined as ((m: FromWebview) => void) | undefined,
  createTerminal: vi.fn(),
  loadModels: vi.fn(async () => []),
  executeCommand: vi.fn(),
  showInformationMessage: vi.fn(),
  configValues: {} as Record<string, unknown>,
  inspectValues: {} as Record<string, unknown>,
  configUpdate: vi.fn(async () => undefined),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (k: string) => h.configValues[k],
      inspect: (k: string) => h.inspectValues[k],
      update: h.configUpdate,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
  window: {
    createTerminal: h.createTerminal,
    showInformationMessage: h.showInformationMessage,
  },
  commands: {
    executeCommand: h.executeCommand,
  },
  ConfigurationTarget: {
    Global: 1,
  },
}));
vi.mock('./webviewHost', () => ({
  webviewOptions: () => ({}), userFontsDir: () => undefined, renderWebview: () => '', currentLanguage: () => 'ru',
  attachMessaging: (_w: unknown, _s: string, _v: string, _l: unknown, cb: (m: FromWebview) => void) => {
    h.message = cb;
    return { dispose: () => undefined };
  },
}));
vi.mock('./chatPanel', () => ({
  ChatPanel: {
    onDidChange: () => () => undefined,
    currentSessionId: () => undefined,
    currentProvider: () => undefined,
  },
}));
vi.mock('../agent/kimi/models', async (actual) => ({
  ...await actual<typeof import('../agent/kimi/models')>(),
  loadKimiModels: h.loadModels,
}));

import { SidebarProvider, type SidebarEngines } from './sidebarView';

function setup(
  opts?:
    | { kimiResult?: { path?: string; version?: string; problem?: string }; visible?: boolean }
    | { path?: string; version?: string; problem?: string },
) {
  let kimiResult: { path?: string; version?: string; problem?: string } = { path: '/x/kimi', version: '2.6.0' };
  let visible = true;
  if (opts !== undefined) {
    if ('visible' in opts) {
      visible = opts.visible ?? true;
      if (opts.kimiResult) kimiResult = opts.kimiResult;
    } else {
      kimiResult = opts as { path?: string; version?: string; problem?: string };
    }
  }
  h.message = undefined;
  h.createTerminal.mockReset();
  h.createTerminal.mockReturnValue({ show: vi.fn() });
  h.loadModels.mockReset();
  h.loadModels.mockResolvedValue([]);
  h.executeCommand.mockReset();
  h.showInformationMessage.mockReset();
  h.configUpdate.mockReset();
  const posted: { type: string; engines?: EngineLimitsSummary[] }[] = [];
  const engine = (result: object) => ({
    locate: vi.fn(async () => result), available: vi.fn(async () => false),
  });
  const engines: SidebarEngines = {
    codexEngine: engine({}) as never,
    antigravityEngine: engine({}) as never,
    kimiEngine: engine(kimiResult) as never,
    codexLimits: { snapshot: { state: 'missing', windows: [], updatedAt: 0 }, refresh: vi.fn(async () => undefined), onUpdate: () => () => undefined } as never,
    agyQuota: { snapshot: { rows: [], updatedAt: 0 }, refresh: vi.fn(async () => undefined), onUpdate: () => () => undefined } as never,
  };
  const provider = new SidebarProvider(
    { extensionUri: {}, extension: { packageJSON: { version: 'test' } } } as never,
    { warn: vi.fn(), info: vi.fn() } as never,
    { refresh: vi.fn(async () => ({ windows: [], updatedAt: 0 })) } as never,
    { onChange: () => () => undefined } as never,
    { onUpdate: () => () => undefined } as never,
    { groups: () => [], onChange: () => () => undefined } as never,
    { ids: () => new Set(), onChange: () => () => undefined } as never,
    engines,
  );
  provider.resolveWebviewView({
    visible,
    webview: { postMessage: (m: { type: string; engines?: EngineLimitsSummary[] }) => { posted.push(m); return Promise.resolve(true); } },
    onDidDispose: () => undefined,
  } as never);
  return { provider, posted, kimiEngine: engines.kimiEngine };
}

describe('SidebarProvider: Kimi', () => {
  it('engine.login открывает найденный kimi с acp --login, без shell', async () => {
    setup();
    h.message!({ type: 'engine.login', engine: 'kimi' });
    await vi.waitFor(() => expect(h.createTerminal).toHaveBeenCalled());
    expect(h.createTerminal).toHaveBeenCalledWith({
      name: 'kimi acp --login', shellPath: '/x/kimi', shellArgs: ['acp', '--login'],
    });
  });

  it('signed out — только явный auth-ответ CLI; есть login surface, но нет email/plan/quota', async () => {
    const t = setup();
    h.loadModels.mockRejectedValue(new KimiCatalogError(true));
    await t.provider.refreshUsage();
    const kimi = t.posted.filter((m) => m.type === 'engines.limits').at(-1)?.engines?.find((e) => e.engine === 'kimi');
    expect(kimi).toMatchObject({ engine: 'kimi', state: 'signedOut', version: 'kimi 2.6.0', windows: [] });
    expect(kimi).not.toHaveProperty('email');
    expect(kimi).not.toHaveProperty('plan');
  });

  it('old/missing resolver не маскируется под успешный вход', async () => {
    const old = setup({ path: '/old/kimi', problem: 'kimi 2.5.9 is too old: needs 2.6.0' });
    await old.provider.refreshUsage();
    expect(old.posted.filter((m) => m.type === 'engines.limits').at(-1)?.engines?.find((e) => e.engine === 'kimi'))
      .toMatchObject({ state: 'error', error: expect.stringContaining('2.6.0') });
    const missing = setup({});
    await missing.provider.refreshUsage();
    expect(missing.posted.filter((m) => m.type === 'engines.limits').at(-1)?.engines?.find((e) => e.engine === 'kimi'))
      .toMatchObject({ state: 'missing', windows: [] });
  });
});

describe('SidebarProvider: promptNewChat', () => {
  it('при видимой панели и активной Jira (jira.source != off) шлёт task.picker.toggle', () => {
    h.configValues = { 'jira.source': 'auto' };
    const t = setup({ visible: true });
    t.provider.promptNewChat();
    expect(t.posted).toContainEqual({ type: 'task.picker.toggle' });
    expect(h.executeCommand).not.toHaveBeenCalledWith('agentura.newSession');
  });

  it('при скрытой панели вызывает agentura.newSession', () => {
    h.configValues = { 'jira.source': 'auto' };
    const t = setup({ visible: false });
    t.provider.promptNewChat();
    expect(t.posted.filter((m) => m.type === 'task.picker.toggle')).toHaveLength(0);
    expect(h.executeCommand).toHaveBeenCalledWith('agentura.newSession');
  });

  it('при jira.source: off вызывает agentura.newSession даже если панель видима', () => {
    h.configValues = { 'jira.source': 'off' };
    const t = setup({ visible: true });
    t.provider.promptNewChat();
    expect(t.posted.filter((m) => m.type === 'task.picker.toggle')).toHaveLength(0);
    expect(h.executeCommand).toHaveBeenCalledWith('agentura.newSession');
  });
});

describe('SidebarProvider: sidebar.hideEngine', () => {
  it('добавляет движок в sidebar.limitsHidden через writeSetting в Global', async () => {
    h.configValues = { 'sidebar.limitsHidden': ['claude'] };
    h.inspectValues = {};
    setup();
    h.message!({ type: 'sidebar.hideEngine', engine: 'codex' });
    await vi.waitFor(() => expect(h.configUpdate).toHaveBeenCalled());
    expect(h.configUpdate).toHaveBeenCalledWith(
      'sidebar.limitsHidden',
      ['claude', 'codex'],
      1,
    );
  });

  it('не дублирует движок, если он уже в sidebar.limitsHidden', async () => {
    h.configValues = { 'sidebar.limitsHidden': ['codex'] };
    h.inspectValues = {};
    setup();
    h.message!({ type: 'sidebar.hideEngine', engine: 'codex' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.configUpdate).not.toHaveBeenCalled();
  });

  it('при перекрытии sidebar.limitsHidden в workspace показывает предупреждение overriddenView и не пишет в Global', async () => {
    h.configValues = { 'sidebar.limitsHidden': [] };
    h.inspectValues = { 'sidebar.limitsHidden': { workspaceValue: ['claude'] } };
    setup();
    h.message!({ type: 'sidebar.hideEngine', engine: 'codex' });
    await vi.waitFor(() => expect(h.showInformationMessage).toHaveBeenCalled());
    expect(h.configUpdate).not.toHaveBeenCalled();
  });
});
