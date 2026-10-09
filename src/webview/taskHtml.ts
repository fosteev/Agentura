import DOMPurify from 'dompurify';
import { isOpenableLink } from '../shared/task';
import { ui } from './strings';

/**
 * Санитайзер HTML задачи Jira (roadmap 20, решение 5). Вход — **недоверенный**: Jiraffe чистит HTML у себя, свое
 * подключение Agentura отдаёт как есть, а описание и комментарии пишут люди. Один путь для обоих источников.
 * Белый список тегов — как `ALLOWED_TAGS` в `jiraffe/src/jira/sanitize.ts`; атрибуты — только `href` у ссылок
 * (`colspan`/`rowspan` у ячеек), без `class`/`style`/`on*`. Ссылка живёт, если адрес абсолютный http/https/mailto;
 * `img` → плашка `[картинка]` (CSP не пустит картинки Jira, токен в webview не живёт).
 */
const TAGS = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'strong', 'em', 'b', 'i', 'u', 's',
  'del', 'ins', 'sub', 'sup', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span', 'div', 'blockquote',
];

type Purifier = typeof DOMPurify;
let purifier: Purifier | undefined;
/** База для относительных ссылок текущего вызова `sanitizeTaskHtml` (хук общий на экземпляр, вызовы синхронные). */
let linkBase: string | undefined;

/**
 * Относительная ссылка Jira (`/browse/X-1`, `secure/…`) → абсолютная от адреса задачи. Своё подключение отдаёт HTML как
 * есть, с относительными ссылками; путь с `/` уже содержит context path инстанса, `new URL` от адреса задачи это учитывает.
 * Якоря `#…` и всё, что не резолвится, — пусто.
 */
function absolute(href: string): string {
  if (!href || href.startsWith('#')) return '';
  if (isOpenableLink(href)) return href; // уже абсолютная — как есть, без нормализации URL
  try {
    return new URL(href, linkBase).toString();
  } catch {
    return '';
  }
}

/** Свой экземпляр DOMPurify: хуки ниже не должны задеть `markdown.ts`, который чистит ответ модели общим экземпляром. */
function instance(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const raw = node.getAttribute('href');
    if (raw === null) return;
    const href = absolute(raw.trim());
    if (isOpenableLink(href)) node.setAttribute('href', href);
    else node.removeAttribute('href');
  });
  purifier = p;
  return p;
}

/** Метка вместо картинки: пустой `<span data-ph>` с текстом — стиль рисует плашку. */
function imagePlaceholders(html: string): string {
  // <template> инертен: картинки из разбираемой разметки не грузятся и скрипты не выполняются
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const img of Array.from(tpl.content.querySelectorAll('img'))) {
    const ph = document.createElement('span');
    ph.setAttribute('data-ph', '');
    ph.textContent = ui.task.imagePlaceholder;
    img.replaceWith(ph);
  }
  return tpl.innerHTML;
}

/**
 * HTML описания/комментария → безопасная разметка для `dangerouslySetInnerHTML`. Пусто на входе — пусто на выходе.
 * `base` — адрес задачи (`TaskCard.url`): от него резолвятся относительные ссылки; без него они удаляются.
 */
export function sanitizeTaskHtml(html: string, base?: string): string {
  if (!html) return '';
  linkBase = base && isOpenableLink(base) ? base : undefined;
  return String(
    instance().sanitize(imagePlaceholders(html), {
      ALLOWED_TAGS: TAGS,
      ALLOWED_ATTR: ['href', 'colspan', 'rowspan', 'data-ph'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    }),
  );
}

/**
 * Адрес ссылки, по которой кликнули в санитизированном HTML (`null` — клик не по ссылке). Переход webview не нужен:
 * вызывающий делает `preventDefault` и шлёт хосту `task.openLink`, если адрес открываемый (`undefined` — ссылка мёртвая).
 */
export function clickedLink(target: EventTarget | null): { link: boolean; url?: string } {
  const a = target instanceof Element ? target.closest('a') : null;
  if (!a) return { link: false };
  const href = a.getAttribute('href');
  return href && isOpenableLink(href) ? { link: true, url: href } : { link: true };
}
