import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CODE_FONTS, BUNDLED_UI_FONTS } from './bundledFonts';
import { codeFonts, isInstalled, uiFonts, userFonts } from './fonts';

/** Canvas, на котором любой шрифт меряется как запасной, — «не установлен». */
const noFonts = { font: '', measureText: () => ({ width: 100 }) } as unknown as CanvasRenderingContext2D;

describe('шрифты из расширения', () => {
  it('всегда «установлены», без проверки canvas', () => {
    for (const f of [...BUNDLED_UI_FONTS, ...BUNDLED_CODE_FONTS]) expect(isInstalled(f, noFonts)).toBe(true);
    expect(isInstalled('Nonexistent Font 42', noFonts)).toBe(false);
  });

  it('в списках выбора — сразу после системного, без повторов', () => {
    expect(uiFonts().slice(0, 1 + BUNDLED_UI_FONTS.length)).toEqual(['system-ui', ...BUNDLED_UI_FONTS]);
    expect(codeFonts().slice(0, BUNDLED_CODE_FONTS.length)).toEqual([...BUNDLED_CODE_FONTS]);
    expect(new Set(uiFonts()).size).toBe(uiFonts().length);
    expect(new Set(codeFonts()).size).toBe(codeFonts().length);
  });

  it('fonts.css и bundledFonts.ts собраны из одного scripts/fonts.json', () => {
    const list = JSON.parse(readFileSync('scripts/fonts.json', 'utf8')) as { ui: string[]; code: string[] };
    expect(BUNDLED_UI_FONTS).toEqual(list.ui);
    expect(BUNDLED_CODE_FONTS).toEqual(list.code);
    const css = readFileSync('media/fonts/fonts.css', 'utf8');
    for (const f of [...list.ui, ...list.code]) expect(css).toContain(`font-family: "${f}"`);
  });
});

describe('скачанные из Google Fonts', () => {
  afterEach(() => {
    userFonts.value = { ui: [], code: [] };
  });

  it('в списках — после встроенных и до системных кандидатов, без повторов', () => {
    userFonts.value = { ui: ['Lora', 'Rubik', 'Arial'], code: ['Space Mono'] };
    const ui = uiFonts();
    const afterBundled = 1 + BUNDLED_UI_FONTS.length;
    // Arial есть и среди системных кандидатов: остаётся на месте скачанных, повтора нет
    expect(ui.slice(afterBundled, afterBundled + 3)).toEqual(['Lora', 'Rubik', 'Arial']);
    expect(ui.indexOf('SF Pro Text')).toBeGreaterThan(afterBundled + 2);
    expect(new Set(ui).size).toBe(ui.length);
    const code = codeFonts();
    expect(code[BUNDLED_CODE_FONTS.length]).toBe('Space Mono');
    expect(new Set(code).size).toBe(code.length);
  });

  it('«установлены» всегда, без проверки canvas; после удаления — снова по canvas', () => {
    expect(isInstalled('Onest Test', noFonts)).toBe(false);
    userFonts.value = { ui: ['Onest Test'], code: [] };
    expect(isInstalled('Onest Test', noFonts)).toBe(true);
    userFonts.value = { ui: [], code: [] };
    expect(isInstalled('Onest Test', noFonts)).toBe(false);
  });
});
