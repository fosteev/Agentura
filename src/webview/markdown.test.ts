// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { onMarkdownClick, renderMarkdown, withCursor } from './markdown';
import { send } from './vscode';

vi.mock('./vscode', () => ({ send: vi.fn() }));

describe('markdown', () => {
  it('клик по вложенному тексту ссылки передаёт исходный путь хосту и отменяет навигацию webview', () => {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown('[**результат**](/tmp/agentura-subagents-live-result.json) [код](/project/main.ts:35) [сайт](https://example.com)');
    box.addEventListener('click', onMarkdownClick);
    for (const target of [box.querySelector('strong')!, ...Array.from(box.querySelectorAll('a')).slice(1)]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(vi.mocked(send).mock.calls.map(([m]) => m)).toEqual([
      { type: 'link.open', url: '/tmp/agentura-subagents-live-result.json' },
      { type: 'link.open', url: '/project/main.ts:35' },
      { type: 'link.open', url: 'https://example.com' },
    ]);
  });
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

  it('недоверенный HTML вычищается: скрипты, обработчики, style и опасные схемы', () => {
    const html = renderMarkdown(
      'x <script>alert(1)</script> <img src=x onerror="alert(2)"> <p style="color:red" onclick="a()">y</p> ' +
        '[js](javascript:alert(3)) [d](data:text/html,<script>alert(4)</script>) [vb](vbscript:msgbox(1)) ' +
        '[cmd](command:workbench.action.terminal.new) [vsc](vscode://file/etc/passwd)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('vbscript:');
    expect(html).not.toContain('command:');
    expect(html).not.toContain('vscode:');
  });

  it('разрешает файловые ссылки file:// и передаёт их хосту по клику', () => {
    vi.mocked(send).mockClear();
    const url = 'file:///path/to/notes.md#L10-L20';
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown(`[notes.md](${url})`);
    const link = box.querySelector('a');
    expect(link?.getAttribute('href')).toBe(url);

    box.addEventListener('click', onMarkdownClick);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(vi.mocked(send)).toHaveBeenCalledWith({ type: 'link.open', url });
  });

  it('разрешает ссылки conversation://<uuid> и передаёт их хосту по клику', () => {
    vi.mocked(send).mockClear();
    const url = 'conversation://fa861d57-7ced-4ee4-a717-33c7361cca46';
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown(`[Subagent](${url})`);
    const link = box.querySelector('a');
    expect(link?.getAttribute('href')).toBe(url);

    box.addEventListener('click', onMarkdownClick);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(vi.mocked(send)).toHaveBeenCalledWith({ type: 'link.open', url });
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
