import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLED_CODE_FONTS, BUNDLED_UI_FONTS } from './bundledFonts';
import { CODE_FONTS, UI_FONTS, isInstalled } from './fonts';

/** Canvas, на котором любой шрифт меряется как запасной, — «не установлен». */
const noFonts = { font: '', measureText: () => ({ width: 100 }) } as unknown as CanvasRenderingContext2D;

describe('шрифты из расширения', () => {
  it('всегда «установлены», без проверки canvas', () => {
    for (const f of [...BUNDLED_UI_FONTS, ...BUNDLED_CODE_FONTS]) expect(isInstalled(f, noFonts)).toBe(true);
    expect(isInstalled('Nonexistent Font 42', noFonts)).toBe(false);
  });

  it('в списках выбора — сразу после системного, без повторов', () => {
    expect(UI_FONTS.slice(0, 1 + BUNDLED_UI_FONTS.length)).toEqual(['system-ui', ...BUNDLED_UI_FONTS]);
    expect(CODE_FONTS.slice(0, BUNDLED_CODE_FONTS.length)).toEqual([...BUNDLED_CODE_FONTS]);
    expect(new Set(UI_FONTS).size).toBe(UI_FONTS.length);
    expect(new Set(CODE_FONTS).size).toBe(CODE_FONTS.length);
  });

  it('fonts.css и bundledFonts.ts собраны из одного scripts/fonts.json', () => {
    const list = JSON.parse(readFileSync('scripts/fonts.json', 'utf8')) as { ui: string[]; code: string[] };
    expect(BUNDLED_UI_FONTS).toEqual(list.ui);
    expect(BUNDLED_CODE_FONTS).toEqual(list.code);
    const css = readFileSync('media/fonts/fonts.css', 'utf8');
    for (const f of [...list.ui, ...list.code]) expect(css).toContain(`font-family: "${f}"`);
  });
});
