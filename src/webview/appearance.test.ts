// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyAppearance, appearanceVars, fontStack } from './appearance';

const msg = (
  over: Partial<{
    fontInterface: string;
    fontPanels: string;
    fontCode: string;
    feedFontSize: number;
  }> = {},
) => ({
  type: 'appearance' as const,
  fontInterface: '',
  fontPanels: '',
  fontCode: '',
  feedFontSize: 13,
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
    });
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
