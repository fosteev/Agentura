// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { FilePatch } from '../shared/patch';
import { diffBodyHtml } from './diffView';
import { highlightLines, languageFor } from './highlight';

const patch = (): FilePatch => ({
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,3 +1,3 @@ function f()',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: ' ', text: 'const a = 1;', old: 1, new: 1 },
        { kind: '-', text: 'const b = "x";', old: 2, new: null },
        { kind: '+', text: 'const b = "<script>alert(1)</script>";', old: null, new: 2 },
        { kind: '+', text: 'const c = 3;', old: null, new: 3 },
        { kind: ' ', text: 'export {};', old: 3, new: 4 },
      ],
    },
  ],
});

function dom(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('diffView: тело диффа', () => {
  it('inline: четыре колонки, номера старой и новой стороны, метки +/-', () => {
    const html = diffBodyHtml(patch(), 'inline', null);
    expect(html).toContain('class="dgrid dinl"');
    expect(html).not.toContain('dgrid dinl hl');
    expect(html).toContain('<span class="dfold">@@ -1,3 +1,3 @@ function f()</span>');
    expect((html.match(/class="dg rem">-</g) ?? []).length).toBe(1);
    expect((html.match(/class="dg ins">\+</g) ?? []).length).toBe(2);
    // удалённая строка: номер только старой стороны
    expect(html).toContain('<span class="dn rem">2</span><span class="dn rem"></span>');
  });

  it('split: удаление и добавление рядом, недостающая сторона — штриховка', () => {
    const html = diffBodyHtml(patch(), 'split', null);
    expect(html).toContain('class="dgrid dsbs"');
    expect(html).toContain('<span class="dn rem">2</span><span class="dc rem">const b = &quot;x&quot;;</span><span class="dn ins dr">2</span>');
    // вторая добавленная строка без пары слева
    expect(html).toContain('<span class="dn fill"></span><span class="dc fill"></span><span class="dn ins dr">3</span>');
  });

  it('код экранируется целиком: <script> в строке остаётся текстом (inline, split и с подсветкой)', () => {
    for (const mode of ['inline', 'split'] as const) {
      for (const lang of [null, 'typescript']) {
        const html = diffBodyHtml(patch(), mode, lang);
        expect(html).not.toContain('<script');
        const d = dom(html);
        expect(d.querySelector('script')).toBeNull();
        expect(d.textContent).toContain('<script>alert(1)</script>');
      }
    }
  });

  it('заголовок хунка тоже экранируется', () => {
    const p = patch();
    p.hunks[0]!.header = '@@ -1 +1 @@ <img src=x onerror=alert(1)>';
    const d = dom(diffBodyHtml(p, 'inline', null));
    expect(d.querySelector('img')).toBeNull();
    expect(d.querySelector('.dfold')!.textContent).toContain('<img src=x');
  });

  it('язык включает подсветку: .hl на сетке и токены в ячейках кода', () => {
    const html = diffBodyHtml(patch(), 'inline', 'typescript');
    expect(html).toContain('dgrid dinl hl');
    expect(html).toContain('hljs-keyword');
  });

  it('заметки: загрузка, ошибка, бинарный, пустой, слишком большой, обрезанный', () => {
    expect(diffBodyHtml('loading', 'inline')).toContain('Загрузка диффа');
    expect(diffBodyHtml({ error: 'fatal: <bad>' }, 'inline')).toContain('dnote err');
    expect(diffBodyHtml({ error: 'fatal: <bad>' }, 'inline')).not.toContain('<bad>');
    expect(diffBodyHtml({ binary: true, truncated: false, hunks: [] }, 'inline')).toContain('Бинарный');
    expect(diffBodyHtml({ binary: false, truncated: false, hunks: [] }, 'inline')).toContain('не изменилось');
    expect(diffBodyHtml({ binary: false, truncated: true, hunks: [] }, 'inline')).toContain('слишком большой');
    const cut = patch();
    cut.truncated = true;
    const html = diffBodyHtml(cut, 'inline');
    expect(html).toContain('dgrid');
    expect(html).toContain('обрезан на 10 000');
  });
});

describe('highlight', () => {
  it('язык по расширению и имени файла', () => {
    expect(languageFor('src/a/b.tsx')).toBe('typescript');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('a/README.md')).toBe('markdown');
    expect(languageFor('a/file.unknown')).toBeNull();
    expect(languageFor('LICENSE')).toBeNull();
  });

  it('число строк сохраняется, спаны многострочных токенов закрыты в каждой строке', () => {
    const out = highlightLines(['/* a', ' b */', 'let x = "<y>";'], 'javascript');
    expect(out).toHaveLength(3);
    for (const l of out) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    expect(out[2]).toContain('&lt;y&gt;');
  });

  it('неизвестный язык — экранированный текст', () => {
    expect(highlightLines(['<a href="x">'], null)).toEqual(['&lt;a href=&quot;x&quot;&gt;']);
    expect(highlightLines(['<a>'], 'nope')).toEqual(['&lt;a&gt;']);
  });
});
