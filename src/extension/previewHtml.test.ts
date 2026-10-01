import { describe, expect, it } from 'vitest';
import { previewHtml } from './previewHtml';

const o = { cspSource: 'vscode-webview://x', baseHref: 'vscode-webview://x/p/' };
const META = 'http-equiv="Content-Security-Policy"';

describe('previewHtml', () => {
  it('вставляет CSP и base сразу после <head>', () => {
    const out = previewHtml('<html><head><title>t</title></head><body></body></html>', o);
    expect(out.indexOf('<head><meta')).toBeGreaterThan(0);
    expect(out).toContain(META);
    expect(out).toContain('<base href="vscode-webview://x/p/"><title>t</title>');
    expect(out).toContain("default-src 'none'; img-src vscode-webview://x https: data: blob:");
    expect(out).toContain('connect-src vscode-webview://x"');
  });

  it('<HEAD lang> — регистронезависимо, атрибуты головы сохраняются', () => {
    const out = previewHtml('<HTML><HEAD lang="ru"><title>t</title></HEAD></HTML>', o);
    expect(out).toContain('<HEAD lang="ru"><meta');
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it('<header> не принимается за <head>', () => {
    const out = previewHtml('<header>x</header>', o);
    expect(out.startsWith('<meta')).toBe(true);
    expect(out.endsWith('<header>x</header>')).toBe(true);
  });

  it('без head — в начало документа', () => {
    const out = previewHtml('<p>привет</p>', o);
    expect(out.startsWith(`<meta ${META}`)).toBe(true);
    expect(out.endsWith('<base href="vscode-webview://x/p/"><p>привет</p>')).toBe(true);
  });

  it('без head, с doctype — после doctype', () => {
    const out = previewHtml('<!DOCTYPE html>\n<p>x</p>', o);
    expect(out.startsWith(`<!DOCTYPE html><meta ${META}`)).toBe(true);
    expect(out.endsWith('<base href="vscode-webview://x/p/">\n<p>x</p>')).toBe(true);
  });

  it('атрибуты экранированы', () => {
    const out = previewHtml('<head></head>', { cspSource: 'a"b', baseHref: 'x"><script>' });
    expect(out).toContain('<base href="x&quot;>&lt;script>">');
    expect(out).toContain('img-src a&quot;b ');
    expect(out).not.toContain('"><script>');
  });
});
