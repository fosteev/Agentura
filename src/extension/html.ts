export interface WebviewHtmlOptions {
  title: string;
  lang: 'ru' | 'en';
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUris: string[];
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** HTML оболочки webview: CSP с nonce, внешний модульный скрипт, без inline-скриптов. */
export function buildWebviewHtml(o: WebviewHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${o.cspSource}`,
    `font-src ${o.cspSource}`,
    `img-src ${o.cspSource} data:`,
    `script-src 'nonce-${o.nonce}'`,
  ].join('; ');
  const styles = o.styleUris
    .map((u) => `<link rel="stylesheet" href="${escapeAttr(u)}">`)
    .join('\n');
  return `<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(o.title)}</title>
${styles}
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${o.nonce}" src="${escapeAttr(o.scriptUri)}"></script>
</body>
</html>`;
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
