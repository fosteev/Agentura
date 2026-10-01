/** Превью `.html` в webview: в документ вставляются CSP и `<base>`, остальное — как есть. Без `vscode`. */

export interface PreviewHtmlOptions {
  cspSource: string;
  baseHref: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function previewHtml(source: string, o: PreviewHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `img-src ${o.cspSource} https: data: blob:`,
    `media-src ${o.cspSource} https: data: blob:`,
    `style-src ${o.cspSource} 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com`,
    `font-src ${o.cspSource} data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net`,
    `script-src ${o.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com`,
    `connect-src ${o.cspSource}`,
  ].join('; ');
  const inject = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}"><base href="${escapeAttr(o.baseHref)}">`;
  // после `<head…>`; головы нет — после `<!doctype>` (вставка перед ним включила бы quirks mode)
  const head = /<head(?=[\s>])[^>]*>/i.exec(source) ?? /^\s*<!doctype[^>]*>/i.exec(source);
  if (!head) return inject + source;
  const at = head.index + head[0].length;
  return source.slice(0, at) + inject + source.slice(at);
}
