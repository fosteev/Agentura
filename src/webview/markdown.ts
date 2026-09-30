import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { ui } from './strings';

/** Markdown ответа агента → безопасный HTML. `marked` разбирает, `DOMPurify` чистит (ответ модели — недоверенный ввод). */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    // Блок кода с кнопкой копирования; сам клик обрабатывает `onCodeCopyClick`.
    code({ text, lang }) {
      const cls = lang ? ` class="language-${escapeHtml(lang.split(/\s/)[0] ?? '')}"` : '';
      return `<div class="codeblock"><button type="button" class="copy" data-copy>${ui.log.copy}</button><pre><code${cls}>${escapeHtml(text)}</code></pre></div>\n`;
    },
    // Ссылки только как текст с адресом: переход делает VS Code по клику, скриптов нет.
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t}>${inner}</a>`;
    },
  },
});

export type Sanitizer = (html: string) => string;

const purify: Sanitizer = (html) =>
  DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-copy'],
    FORBID_TAGS: ['style', 'form', 'input'],
    FORBID_ATTR: ['style'],
  });

export function renderMarkdown(source: string, sanitize: Sanitizer = purify): string {
  return sanitize(marked.parse(source, { async: false }));
}

/** Курсор стриминга встаёт внутрь последнего абзаца, как в прототипе. */
export function withCursor(html: string): string {
  const cursor = '<span class="cursor"></span>';
  const trimmed = html.replace(/\s+$/, '');
  if (trimmed.endsWith('</p>')) return `${trimmed.slice(0, -4)}${cursor}</p>`;
  return `${trimmed}${cursor}`;
}

/** Клик по «copy» в блоке кода (делегирование с контейнера ленты). */
export function onCodeCopyClick(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.hasAttribute('data-copy')) return;
  const code = target.parentElement?.querySelector('pre code')?.textContent ?? '';
  void navigator.clipboard?.writeText(code).then(
    () => {
      target.textContent = ui.log.copied;
      setTimeout(() => (target.textContent = ui.log.copy), 1500);
    },
    () => {},
  );
}
