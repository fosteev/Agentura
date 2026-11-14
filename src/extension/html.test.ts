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
  it('bootShell и bootResume: статичная заглушка загрузки без inline style и атрибут холодного resume', () => {
    const o = { title: 'A', cspSource: 'x', nonce: 'n', scriptUri: 's', styleUris: [] };
    const ruHtml = buildWebviewHtml({ ...o, lang: 'ru', bootShell: true, bootResume: true });
    expect(ruHtml).toContain('<html lang="ru" data-boot-resume="1">');
    expect(ruHtml).toContain('class="boot-load" role="status" aria-live="polite" aria-busy="true"');
    expect(ruHtml).toContain('Загружаю чат…');
    expect(ruHtml).not.toContain('style=');
    const enHtml = buildWebviewHtml({ ...o, lang: 'en', bootShell: true });
    expect(enHtml).not.toContain('data-boot-resume');
    expect(enHtml).toContain('Loading chat…');
  });
});
