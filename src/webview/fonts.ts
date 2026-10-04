/**
 * Шрифты для выбора во вкладке настроек. Список системных шрифтов webview не получить, поэтому — популярные
 * кандидаты, из которых показываются установленные (проверка шириной текста на canvas).
 */

/** Интерфейсные; `system-ui` — системный шрифт ОС (родовое имя CSS, без кавычек). */
export const UI_FONTS = [
  'system-ui',
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

export const CODE_FONTS = [
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
 * из трёх. Без canvas (тесты) — считаем установленным, решит запасной шрифт в стеке.
 */
export function isInstalled(name: string, ctx?: CanvasRenderingContext2D | null): boolean {
  if (GENERIC_FONTS.includes(name)) return true;
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
