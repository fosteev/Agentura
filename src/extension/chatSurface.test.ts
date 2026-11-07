import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Logger } from './logger';

vi.mock('vscode', () => ({ Uri: { joinPath: (...parts: string[]) => parts.join('/') } }));
vi.mock('./webviewHost', () => ({
  webviewOptions: () => ({}), userFontsDir: () => 'fonts',
  renderWebview: () => '', currentLanguage: () => 'ru', attachMessaging: vi.fn(),
}));
const { chatIcon, panelSurface } = await import('./chatSurface');
const context = { extensionUri: process.cwd(), extension: { packageJSON: { version: 'test' } } } as unknown as vscode.ExtensionContext;

describe('значок вкладки чата', () => {
  it.each(['claude', 'codex', 'cursor', 'antigravity'] as const)('%s: локальные ресурсы обеих тем и возврат к Agentura', (provider) => {
    const panel = { webview: {}, iconPath: undefined } as unknown as vscode.WebviewPanel;
    const surface = panelSurface(panel, context, {} as Logger);
    expect(panel.iconPath).toEqual(chatIcon(context));
    surface.setSessionProvider!(provider);
    const icon = chatIcon(context, provider);
    expect(panel.iconPath).toEqual(icon);
    for (const path of [icon.light, icon.dark]) {
      expect(String(path)).toContain('/media/brands/');
      expect(existsSync(String(path))).toBe(true);
    }
    if (provider === 'codex') expect(icon.dark).not.toBe(icon.light);
    surface.setSessionProvider!(undefined);
    expect(panel.iconPath).toEqual(chatIcon(context));
  });
});
