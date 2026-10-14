/**
 * Строковый рендер встроенного диффа вкладки «код» (порт `diffBodyHtml` и соседей из `webview/render.ts` gitsprout,
 * roadmap 24). Весь текст кода и заголовки хунков экранируются здесь; результат вставляется через
 * `dangerouslySetInnerHTML`. Никаких `style=""` — CSP без `unsafe-inline`.
 */
import type { FilePatch, Hunk } from '../shared/patch';
import { esc } from './escHtml';
import { highlightLines } from './highlight';
import { ui } from './strings';

export type DiffMode = 'inline' | 'split';
/** Что показать в теле диффа: ожидание, ошибка хоста или разобранный патч. */
export type DiffBody = 'loading' | { error: string } | FilePatch;

const num = (n: number | null): string => (n === null ? '' : String(n));

/** HTML по строкам хунка: `old` для контекста и `-`, `new` для контекста и `+` (каждая сторона подсвечивается одним блоком). */
function hunkSides(h: Hunk, lang: string | null): { old: string[]; new: string[] } {
  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  h.lines.forEach((l, i) => {
    if (l.kind !== '+') oldIdx.push(i);
    if (l.kind !== '-') newIdx.push(i);
  });
  const side = (idx: number[]): string[] => {
    const html = highlightLines(
      idx.map((i) => h.lines[i]!.text),
      lang,
    );
    const out: string[] = new Array<string>(h.lines.length).fill('');
    idx.forEach((i, k) => {
      out[i] = html[k]!;
    });
    return out;
  };
  return { old: side(oldIdx), new: side(newIdx) };
}

function inlineRowsHtml(hunks: Hunk[], lang: string | null): string {
  return hunks
    .map((h) => {
      const sides = hunkSides(h, lang);
      return (
        `<span class="dfold">${esc(h.header)}</span>` +
        h.lines
          .map((l, i) => {
            const c = l.kind === '+' ? ' ins' : l.kind === '-' ? ' rem' : '';
            const code = l.kind === '-' ? sides.old[i] : sides.new[i];
            return `<span class="dn${c}">${num(l.old)}</span><span class="dn${c}">${num(l.new)}</span><span class="dg${c}">${l.kind === ' ' ? '' : l.kind}</span><span class="dc${c}">${code}</span>`;
          })
          .join('')
      );
    })
    .join('');
}

const fill = (right: boolean): string => `<span class="dn fill${right ? ' dr' : ''}"></span><span class="dc fill"></span>`;

function splitRowsHtml(hunks: Hunk[], lang: string | null): string {
  return hunks
    .map((h) => {
      const sides = hunkSides(h, lang);
      let out = `<span class="dfold">${esc(h.header)}</span>`;
      const ls = h.lines;
      for (let i = 0; i < ls.length; ) {
        const cur = ls[i]!;
        if (cur.kind === ' ') {
          out += `<span class="dn">${num(cur.old)}</span><span class="dc">${sides.old[i]}</span><span class="dn dr">${num(cur.new)}</span><span class="dc">${sides.new[i]}</span>`;
          i++;
          continue;
        }
        // серия удалений, за ней серия добавлений — рядом, строка в строку
        const dels: number[] = [];
        const adds: number[] = [];
        while (i < ls.length && ls[i]!.kind === '-') dels.push(i++);
        while (i < ls.length && ls[i]!.kind === '+') adds.push(i++);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          const d = dels[k];
          const a = adds[k];
          out +=
            (d !== undefined
              ? `<span class="dn rem">${num(ls[d]!.old)}</span><span class="dc rem">${sides.old[d]}</span>`
              : fill(false)) +
            (a !== undefined
              ? `<span class="dn ins dr">${num(ls[a]!.new)}</span><span class="dc ins">${sides.new[a]}</span>`
              : fill(true));
        }
      }
      return out;
    })
    .join('');
}

/**
 * Тело диффа. `lang` (язык highlight.js из `languageFor`) включает подсветку: `.hl` на сетке и токены в ячейках кода.
 * Патч `truncated` без строк — файл слишком большой; с хунками — показано то, что влезло, и пометка.
 */
export function diffBodyHtml(body: DiffBody, mode: DiffMode, lang: string | null = null): string {
  const t = ui.task.code;
  if (body === 'loading') return `<div class="dnote">${esc(t.diffLoading)}</div>`;
  if ('error' in body) return `<div class="dnote err">${esc(body.error)}</div>`;
  if (body.binary) return `<div class="dnote">${esc(t.diffBinary)}</div>`;
  if (body.hunks.length === 0) return `<div class="dnote">${esc(body.truncated ? t.diffTooLarge : t.diffEmpty)}</div>`;
  return (
    `<div class="dgrid ${mode === 'split' ? 'dsbs' : 'dinl'}${lang ? ' hl' : ''}">${mode === 'split' ? splitRowsHtml(body.hunks, lang) : inlineRowsHtml(body.hunks, lang)}</div>` +
    (body.truncated ? `<div class="dnote">${esc(t.diffTruncated)}</div>` : '')
  );
}
