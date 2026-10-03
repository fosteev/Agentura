import { describe, expect, it } from 'vitest';
import { buildWebviewHtml, makeNonce } from './html';

describe('buildWebviewHtml', () => {
  it('CSP с nonce, без inline-скриптов', () => {
    const nonce = makeNonce();
    const html = buildWebviewHtml({
      title: 'Agentura',
      lang: 'ru',
      cspSource: 'vscode-webview://x',
      nonce,
      scriptUri: 'vscode-webview://x/chat.js',
      styleUris: ['vscode-webview://x/tokens.css'],
    });
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script type="module" nonce="${nonce}" src=`);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
  it('lang попадает в <html lang>', () => {
    const o = { title: 'A', cspSource: 'x', nonce: 'n', scriptUri: 's', styleUris: [] };
    expect(buildWebviewHtml({ ...o, lang: 'en' })).toContain('<html lang="en">');
    expect(buildWebviewHtml({ ...o, lang: 'ru' })).toContain('<html lang="ru">');
  });
});
