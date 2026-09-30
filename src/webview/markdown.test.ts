// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, withCursor } from './markdown';

describe('markdown', () => {
  it('абзацы, инлайн-код, выделение', () => {
    const html = renderMarkdown('Причина — `Counter` и **важно**.\n\nВторой абзац');
    expect(html).toContain('<p>Причина — <code>Counter</code> и <strong>важно</strong>.</p>');
    expect(html).toContain('<p>Второй абзац</p>');
  });

  it('блок кода с кнопкой копирования и языком', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2;\n```');
    expect(html).toContain('class="codeblock"');
    expect(html).toContain('data-copy');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('const a = 1 &lt; 2;');
  });

  it('недоверенный HTML вычищается: скрипты, обработчики, style', () => {
    const html = renderMarkdown(
      'x <script>alert(1)</script> <img src=x onerror="alert(2)"> <p style="color:red" onclick="a()">y</p> [z](javascript:alert(3))',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('javascript:');
  });

  it('GFM: список и таблица', () => {
    expect(renderMarkdown('- a\n- b')).toContain('<li>a</li>');
    expect(renderMarkdown('|a|b|\n|-|-|\n|1|2|')).toContain('<table>');
  });

  it('курсор стриминга встаёт в конец последнего абзаца', () => {
    expect(withCursor('<p>тест</p>\n')).toBe('<p>тест<span class="cursor"></span></p>');
    expect(withCursor('<ul><li>a</li></ul>')).toBe(
      '<ul><li>a</li></ul><span class="cursor"></span>',
    );
  });
});
