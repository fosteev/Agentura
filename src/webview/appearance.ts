import type { ToWebview } from '../protocol';
import { DEFAULT_FEED_FONT_SIZE, isFeedFontSize } from '../settings';
import { onHostMessage } from './vscode';

export type Appearance = Extract<ToWebview, { type: 'appearance' }>;

/**
 * Имя шрифта из настройки → стек `font-family`: шрифт, затем `fallback` (шрифт VS Code), если его нет в системе.
 * Одно имя берётся в кавычки; список через запятую или имя в кавычках — как есть. Пусто или мусор — `undefined`.
 */
export function fontStack(name: string, fallback: string): string | undefined {
  const n = name.trim();
  if (!n || /[;{}<>\\]/.test(n)) return undefined;
  return `${/[,'"]/.test(n) ? n : `"${n}"`}, ${fallback}`;
}

/** CSS-переменные корня: пусто (`undefined`) — убрать, остаются значения из tokens.css. */
export function appearanceVars(m: Appearance): Record<string, string | undefined> {
  const size = isFeedFontSize(m.feedFontSize) ? m.feedFontSize : DEFAULT_FEED_FONT_SIZE;
  return {
    '--font': fontStack(m.fontInterface, 'var(--font-vscode)'),
    '--mono': fontStack(m.fontCode, 'var(--mono-vscode)'),
    '--feed-zoom':
      size === DEFAULT_FEED_FONT_SIZE ? undefined : String(size / DEFAULT_FEED_FONT_SIZE),
  };
}

export function applyAppearance(m: Appearance, root: HTMLElement = document.documentElement): void {
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
