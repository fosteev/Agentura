// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyAppearance, appearanceVars, fontStack, highlightThemeAttr, uiZoom } from './appearance';
import { userFonts } from './fonts';

const msg = (
  over: Partial<{
    fontInterface: string;
    fontPanels: string;
    fontCode: string;
    feedFontSize: number;
    uiFontSize: number;
    diffHighlight: boolean;
    diffTheme: 'simple' | 'github' | 'one';
    diffFontSize: number;
    userFonts: { ui: string[]; code: string[]; css?: string };
  }> = {},
) => ({
  type: 'appearance' as const,
  fontInterface: '',
  fontPanels: '',
  fontCode: '',
  feedFontSize: 13,
  uiFontSize: 13,
  diffHighlight: true,
  diffTheme: 'github' as const,
  diffFontSize: 0,
  userFonts: { ui: [], code: [] },
  ...over,
});

describe('fontStack', () => {
  it('одно имя — в кавычки и запасной шрифт VS Code', () => {
    expect(fontStack(' JetBrains Mono ', 'var(--mono-vscode)')).toBe(
      '"JetBrains Mono", var(--mono-vscode)',
    );
  });
  it('список или имя в кавычках — как есть', () => {
    expect(fontStack('Fira Code, monospace', 'X')).toBe('Fira Code, monospace, X');
    expect(fontStack("'Iosevka'", 'X')).toBe("'Iosevka', X");
  });
  it('родовое имя — без кавычек', () => {
    expect(fontStack('system-ui', 'X')).toBe('system-ui, X');
  });
  it('пусто и мусор — нет значения', () => {
    expect(fontStack('  ', 'X')).toBeUndefined();
    expect(fontStack('a; color: red', 'X')).toBeUndefined();
    expect(fontStack('a}', 'X')).toBeUndefined();
  });
});

describe('appearanceVars / applyAppearance', () => {
  it('по умолчанию — ничего не перекрывать', () => {
    expect(appearanceVars(msg())).toEqual({
      '--font': undefined,
      '--mono': undefined,
      '--panel-font': undefined,
      '--feed-zoom': undefined,
      '--ui-zoom': undefined,
      '--diff-size': '13px',
    });
  });
  it('размер интерфейса — свой масштаб от 13 px; мусор — как 13', () => {
    expect(appearanceVars(msg({ uiFontSize: 16 }))['--ui-zoom']).toBe(String(16 / 13));
    expect(appearanceVars(msg({ uiFontSize: 99 }))['--ui-zoom']).toBeUndefined();
    expect(appearanceVars(msg({ uiFontSize: 16 }))['--feed-zoom']).toBeUndefined();
  });
  it('размер ленты — масштаб от 13 px; мусор — как 13', () => {
    expect(appearanceVars(msg({ feedFontSize: 15.5 }))['--feed-zoom']).toBeUndefined();
    expect(appearanceVars(msg({ feedFontSize: 15 }))['--feed-zoom']).toBe(String(15 / 13));
  });
  it('шрифт панелей — своя переменная, запасной — шрифт интерфейса VS Code', () => {
    expect(appearanceVars(msg({ fontPanels: 'Inter' }))['--panel-font']).toBe(
      '"Inter", var(--font-vscode)',
    );
  });
  it('ставит и снимает переменные на корне', () => {
    const root = document.createElement('div');
    applyAppearance(msg({ fontCode: 'Menlo', feedFontSize: 16 }), root);
    expect(root.style.getPropertyValue('--mono')).toBe('"Menlo", var(--mono-vscode)');
    expect(root.style.getPropertyValue('--feed-zoom')).toBe(String(16 / 13));
    applyAppearance(msg(), root);
    expect(root.style.getPropertyValue('--mono')).toBe('');
    expect(root.style.getPropertyValue('--feed-zoom')).toBe('');
  });
});

describe('дифф вкладки «код»', () => {
  it('размер: 0 и мусор — размер ленты, иначе свой в px', () => {
    expect(appearanceVars(msg())['--diff-size']).toBe('13px');
    expect(appearanceVars(msg({ feedFontSize: 16 }))['--diff-size']).toBe('16px');
    expect(appearanceVars(msg({ diffFontSize: 11 }))['--diff-size']).toBe('11px');
    expect(appearanceVars(msg({ diffFontSize: 40, feedFontSize: 16 }))['--diff-size']).toBe('40px');
    expect(appearanceVars(msg({ diffFontSize: 99, feedFontSize: 16 }))['--diff-size']).toBe('16px');
    expect(appearanceVars(msg({ diffFontSize: 1.5 }))['--diff-size']).toBe('13px');
  });
  it('палитра: из настройки, выключенная подсветка — off, мусор — github', () => {
    expect(highlightThemeAttr(msg({ diffTheme: 'one' }))).toBe('one');
    expect(highlightThemeAttr(msg({ diffHighlight: false, diffTheme: 'one' }))).toBe('off');
    expect(highlightThemeAttr({ ...msg(), diffTheme: 'x' as never })).toBe('github');
  });
  it('смена настройки живьём: атрибут body и --diff-size на корне', () => {
    const root = document.createElement('div');
    applyAppearance(msg({ diffTheme: 'one', diffFontSize: 14 }), root);
    expect(document.body.dataset.hlTheme).toBe('one');
    expect(root.style.getPropertyValue('--diff-size')).toBe('14px');
    applyAppearance(msg({ diffTheme: 'simple', diffFontSize: 0, feedFontSize: 15 }), root);
    expect(document.body.dataset.hlTheme).toBe('simple');
    expect(root.style.getPropertyValue('--diff-size')).toBe('15px');
    applyAppearance(msg({ diffHighlight: false }), root);
    expect(document.body.dataset.hlTheme).toBe('off');
  });
});

describe('скачанные шрифты', () => {
  const link = () => document.querySelectorAll<HTMLLinkElement>('link#user-fonts');
  const root = document.createElement('div');
  afterEach(() => applyAppearance(msg(), root));

  it('ссылка на css ставится, меняется на новую и снимается; всегда одна', () => {
    applyAppearance(msg({ userFonts: { ui: ['Onest'], code: [], css: 'https://x/fonts.css?v=1' } }), root);
    expect(link()).toHaveLength(1);
    expect(link()[0]!.getAttribute('href')).toBe('https://x/fonts.css?v=1');
    expect(link()[0]!.rel).toBe('stylesheet');
    applyAppearance(msg({ userFonts: { ui: ['Onest'], code: [], css: 'https://x/fonts.css?v=2' } }), root);
    expect(link()).toHaveLength(1);
    expect(link()[0]!.getAttribute('href')).toBe('https://x/fonts.css?v=2');
    applyAppearance(msg(), root);
    expect(link()).toHaveLength(0);
  });

  it('имена попадают в список «установленных» шрифтов', () => {
    applyAppearance(msg({ userFonts: { ui: ['Onest'], code: ['Fira Code'], css: 'https://x/f.css' } }), root);
    expect(userFonts.value).toEqual({ ui: ['Onest'], code: ['Fira Code'] });
    applyAppearance(msg(), root);
    expect(userFonts.value).toEqual({ ui: [], code: [] });
  });

  it('масштаб интерфейса: uiZoom читает его, смена масштаба шлёт resize (пороги ширины пересчитываются)', () => {
    let resized = 0;
    const onResize = () => resized++;
    window.addEventListener('resize', onResize);
    applyAppearance(msg({ uiFontSize: 16 }), root);
    expect(uiZoom(root)).toBeCloseTo(16 / 13);
    applyAppearance(msg({ uiFontSize: 16, fontCode: 'Fira Code' }), root);
    expect(resized).toBe(1);
    applyAppearance(msg(), root);
    expect(uiZoom(root)).toBe(1);
    expect(resized).toBe(2);
    window.removeEventListener('resize', onResize);
  });
});
