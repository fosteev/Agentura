import type { ToWebview } from '../protocol';
import { DEFAULT_FEED_FONT_SIZE, isFeedFontSize } from '../settings';
import { GENERIC_FONTS, userFonts } from './fonts';
import { onHostMessage } from './vscode';

export type Appearance = Extract<ToWebview, { type: 'appearance' }>;

/**
 * Имя шрифта из настройки → стек `font-family`: шрифт, затем `fallback` (шрифт VS Code), если его нет в системе.
 * Одно имя берётся в кавычки (кроме родовых `system-ui`, `monospace`…); список через запятую или имя в кавычках — как есть. Пусто или мусор — `undefined`.
 */
export function fontStack(name: string, fallback: string): string | undefined {
  const n = name.trim();
  if (!n || /[;{}<>\\]/.test(n)) return undefined;
  // родовое имя в кавычках — уже имя семейства, а не системный шрифт
  const head = /[,'"]/.test(n) || GENERIC_FONTS.includes(n) ? n : `"${n}"`;
  return `${head}, ${fallback}`;
}

/** CSS-переменные корня: пусто (`undefined`) — убрать, остаются значения из tokens.css. */
export function appearanceVars(m: Appearance): Record<string, string | undefined> {
  const size = isFeedFontSize(m.feedFontSize) ? m.feedFontSize : DEFAULT_FEED_FONT_SIZE;
  return {
    '--font': fontStack(m.fontInterface, 'var(--font-vscode)'),
    '--mono': fontStack(m.fontCode, 'var(--mono-vscode)'),
    // нет — панели берут свой прежний шрифт (var(--panel-font, …) в webview.css)
    '--panel-font': fontStack(m.fontPanels, 'var(--font-vscode)'),
    '--feed-zoom':
      size === DEFAULT_FEED_FONT_SIZE ? undefined : String(size / DEFAULT_FEED_FONT_SIZE),
  };
}

/** Один `<link id="user-fonts">` на страницу: ставится, перенаправляется на новый css или снимается. */
export function applyUserFontsLink(css: string | undefined, doc: Document = document): void {
  const link = doc.getElementById('user-fonts');
  if (!css) {
    link?.remove();
    return;
  }
  if (link) {
    if (link.getAttribute('href') !== css) link.setAttribute('href', css);
    return;
  }
  const el = doc.createElement('link');
  el.id = 'user-fonts';
  el.rel = 'stylesheet';
  el.href = css;
  doc.head.append(el);
}

export function applyAppearance(m: Appearance, root: HTMLElement = document.documentElement): void {
  userFonts.value = { ui: m.userFonts.ui, code: m.userFonts.code };
  applyUserFontsLink(m.userFonts.css, root.ownerDocument);
  // через CSSOM: CSP вебвью запрещает inline-стили в разметке, но не style.setProperty
  for (const [prop, value] of Object.entries(appearanceVars(m))) {
    if (value === undefined) root.style.removeProperty(prop);
    else root.style.setProperty(prop, value);
  }
}

/** Шрифты и размер ленты от хоста (`appearance`) — общий слушатель для всех поверхностей. */
export function installAppearance(): void {
  onHostMessage((m) => {
    if (m.type === 'appearance') applyAppearance(m);
  });
}
