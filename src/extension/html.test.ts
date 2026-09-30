import { describe, expect, it } from 'vitest';
import { buildWebviewHtml, makeNonce } from './html';

describe('buildWebviewHtml', () => {
  it('CSP с nonce, без inline-скриптов', () => {
    const nonce = makeNonce();
    const html = buildWebviewHtml({
      title: 'Agentura',
      cspSource: 'vscode-webview://x',
      nonce,
      scriptUri: 'vscode-webview://x/chat.js',
      styleUris: ['vscode-webview://x/tokens.css'],
    });
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script type="module" nonce="${nonce}" src=`);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
