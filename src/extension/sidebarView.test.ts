import { describe, expect, it, vi } from 'vitest';
import type { EngineLimitsSummary, FromWebview } from '../protocol';
import { KimiCatalogError } from '../agent/kimi/models';

const h = vi.hoisted(() => ({
  message: undefined as ((m: FromWebview) => void) | undefined,
  createTerminal: vi.fn(),
  loadModels: vi.fn(async () => []),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
  window: { createTerminal: h.createTerminal },
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

function setup(kimiResult: { path?: string; version?: string; problem?: string } = { path: '/x/kimi', version: '2.6.0' }) {
  h.message = undefined;
  h.createTerminal.mockReset();
  h.createTerminal.mockReturnValue({ show: vi.fn() });
  h.loadModels.mockReset();
  h.loadModels.mockResolvedValue([]);
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
