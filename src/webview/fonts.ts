/**
 * Шрифты для выбора во вкладке настроек. Список системных шрифтов webview не получить, поэтому — популярные
 * кандидаты, из которых показываются установленные (проверка шириной текста на canvas), плюс шрифты из расширения
 * (`media/fonts`, `scripts/fonts.json`) — они есть всегда и идут в списке первыми после системного.
 */
import { BUNDLED_CODE_FONTS, BUNDLED_UI_FONTS } from './bundledFonts';

const BUNDLED = new Set([...BUNDLED_UI_FONTS, ...BUNDLED_CODE_FONTS]);
const merge = (...lists: readonly (readonly string[])[]): readonly string[] => [...new Set(lists.flat())];

/** Интерфейсные из системы; в общем списке впереди `system-ui` — системный шрифт ОС (родовое имя CSS, без кавычек). */
const SYSTEM_UI_FONTS = [
  'Inter',
  'SF Pro Text',
  'Helvetica Neue',
  'Avenir Next',
  'Segoe UI',
  'Roboto',
  'Open Sans',
  'Noto Sans',
  'Ubuntu',
  'IBM Plex Sans',
  'Source Sans 3',
  'Geist',
  'Atkinson Hyperlegible',
  'OpenDyslexic',
  'Verdana',
  'Arial',
  'Georgia',
] as const;

const SYSTEM_CODE_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Cascadia Code',
  'Consolas',
  'Source Code Pro',
  'IBM Plex Mono',
  'Iosevka',
  'Hack',
  'Roboto Mono',
  'Ubuntu Mono',
  'Geist Mono',
  'Victor Mono',
  'Commit Mono',
  'Monaspace Neon',
  'Berkeley Mono',
  'DejaVu Sans Mono',
  'Courier New',
] as const;

export const UI_FONTS = merge(['system-ui'], BUNDLED_UI_FONTS, SYSTEM_UI_FONTS);
export const CODE_FONTS = merge(BUNDLED_CODE_FONTS, SYSTEM_CODE_FONTS);

/** Родовые имена CSS: в стеке `font-family` пишутся без кавычек и всегда «установлены». */
export const GENERIC_FONTS: readonly string[] = [
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'sans-serif',
  'serif',
  'monospace',
];

const SAMPLE = 'mmmmmmmmmmlli10WQ@#';
const BASES = ['monospace', 'sans-serif', 'serif'] as const;
const cache = new Map<string, boolean>();

/**
 * Установлен ли шрифт: ширина образца со шрифтом отличается от ширины родового запасного хотя бы для одного
 * из трёх. Родовые и шрифты из расширения — всегда. Без canvas (тесты) — считаем установленным, решит запасной шрифт в стеке.
 */
export function isInstalled(name: string, ctx?: CanvasRenderingContext2D | null): boolean {
  if (GENERIC_FONTS.includes(name) || BUNDLED.has(name)) return true;
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const c = ctx === undefined ? canvas() : ctx;
  if (!c) return true;
  const width = (family: string) => {
    c.font = `32px ${family}`;
    return c.measureText(SAMPLE).width;
  };
  const yes = BASES.some((b) => width(`"${name}", ${b}`) !== width(b));
  cache.set(name, yes);
  return yes;
}

let ctx2d: CanvasRenderingContext2D | null | undefined;
function canvas(): CanvasRenderingContext2D | null {
  if (ctx2d === undefined) {
    try {
      ctx2d = document.createElement('canvas').getContext('2d');
    } catch {
      ctx2d = null;
    }
  }
  return ctx2d;
}

/** Установленные из кандидатов, порядок списка сохраняется. */
export function installedFonts(candidates: readonly string[]): string[] {
  return candidates.filter((f) => isInstalled(f));
}
