// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clickedLink, sanitizeTaskHtml } from './taskHtml';

const box = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = sanitizeTaskHtml(html);
  return d;
};

describe('sanitizeTaskHtml (roadmap 20, решение 5)', () => {
  it('скрипт, обработчики on*, style, class и iframe вырезаются, обычная разметка остаётся', () => {
    const d = box(
      '<p style="color:red" class="x" onclick="alert(1)">Текст <b onmouseover="x()">жирный</b></p><script>alert(1)</script><iframe src="https://evil"></iframe><style>p{}</style><ul><li>раз</li></ul>',
    );
    expect(d.querySelector('script, iframe, style')).toBeNull();
    expect(d.innerHTML).not.toMatch(/on\w+=|style=|class=/i);
    expect(d.querySelector('p')!.textContent).toBe('Текст жирный');
    expect(d.querySelector('b')!.textContent).toBe('жирный');
    expect(d.querySelectorAll('li')).toHaveLength(1);
  });

  it('javascript:, data:, file: и относительные ссылки теряют href; http, https и mailto остаются', () => {
    const d = box(
      [
        '<a href="javascript:alert(1)">a</a>',
        '<a href="JaVaScRiPt:alert(1)">b</a>',
        '<a href="data:text/html,x">c</a>',
        '<a href="file:///etc/passwd">d</a>',
        '<a href="/browse/X-1">e</a>',
        '<a href="https://jira.example/browse/X-1">f</a>',
        '<a href="http://a.example">g</a>',
        '<a href="mailto:a@b.c">h</a>',
      ].join(''),
    );
    const hrefs = [...d.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([null, null, null, null, null, 'https://jira.example/browse/X-1', 'http://a.example', 'mailto:a@b.c']);
    expect(d.textContent).toBe('abcdefgh'); // текст ссылок остаётся
  });

  it('img → плашка [картинка] без src и обработчиков', () => {
    const d = box('<p>до <img src="https://x/a.png" onerror="alert(1)" alt="a"> после</p>');
    expect(d.querySelector('img')).toBeNull();
    expect(d.querySelector('[data-ph]')!.textContent).toBe('[картинка]');
    expect(d.innerHTML).not.toMatch(/src=|onerror/);
  });

  it('таблица и код проходят; colspan остаётся, прочие атрибуты — нет; пустой вход — пустая строка', () => {
    const d = box('<table><tbody><tr><td colspan="2" width="9">x</td></tr></tbody></table><pre><code>a &lt; b</code></pre>');
    expect(d.querySelector('td')!.getAttribute('colspan')).toBe('2');
    expect(d.querySelector('td')!.hasAttribute('width')).toBe(false);
    expect(d.querySelector('pre code')!.textContent).toBe('a < b');
    expect(sanitizeTaskHtml('')).toBe('');
  });

  it('относительные ссылки резолвятся от адреса задачи (context path сохраняется), без базы — удаляются', () => {
    const base = 'https://jira.example/jira/browse/ABC-1';
    const d = box('<a href="/jira/browse/ABC-2">a</a><a href="secure/x">b</a><a href="#top">c</a>');
    d.innerHTML = sanitizeTaskHtml('<a href="/jira/browse/ABC-2">a</a><a href="secure/x">b</a><a href="#top">c</a>', base);
    const [a, b, c] = [...d.querySelectorAll('a')];
    expect(a!.getAttribute('href')).toBe('https://jira.example/jira/browse/ABC-2');
    expect(b!.getAttribute('href')).toBe('https://jira.example/jira/browse/secure/x');
    expect(c!.hasAttribute('href')).toBe(false);
    d.innerHTML = sanitizeTaskHtml('<a href="/jira/browse/ABC-2">a</a>');
    expect(d.querySelector('a')!.hasAttribute('href')).toBe(false);
  });

  it('не трогает общий DOMPurify, которым чистится markdown ответа агента', async () => {
    const { renderMarkdown } = await import('./markdown');
    sanitizeTaskHtml('<a href="https://a">x</a>');
    expect(renderMarkdown('[x](https://a)')).toContain('href="https://a"');
  });
});

describe('clickedLink', () => {
  it('ссылка с открываемым адресом — url; мёртвая ссылка — link без url; не ссылка — link=false', () => {
    const d = box('<p><a href="https://a.example">живая</a> <a href="javascript:x">мёртвая</a> текст</p>');
    const [live, dead] = [...d.querySelectorAll('a')];
    expect(clickedLink(live!)).toEqual({ link: true, url: 'https://a.example' });
    expect(clickedLink(dead!)).toEqual({ link: true });
    expect(clickedLink(d.querySelector('p'))).toEqual({ link: false });
    expect(clickedLink(null)).toEqual({ link: false });
  });
});
