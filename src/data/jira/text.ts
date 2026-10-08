// Скопировано из fosteev/jiraffe 0.7.0 src/panels/aiContext.ts. Правки помечены «Agentura:».
// Agentura: оставлены `htmlToText` и `issueContext`; TaskMeta/askMenu (сторона Jiraffe) не нужны; `IssueCard` Jiraffe заменён
// на минимальную структуру `{ instanceName, issue }`; вход `htmlToText` ограничен `MAX_HTML_CHARS`.
import type { IssueDetail } from './types';

/** Agentura: вместо `IssueCard` из src/panels/protocol.ts Jiraffe. */
interface IssueCard { instanceName: string; issue: IssueDetail }

/** Последних комментариев в контексте. */
export const AI_COMMENTS = 20;
const MAX_FIELD_CHARS = 30_000;

/** Agentura: потолок входа `htmlToText` — регулярки ниже на незакрытых тегах квадратичны (сотни КБ — секунды). */
const MAX_HTML_CHARS = 100_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Санитизированный HTML Jira → текст: блоки — строки, пункты списков — `- `, ссылки — `текст (адрес)`, картинки — `[image]`. */
export function htmlToText(html: string): string {
  return (html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html) // Agentura: потолок, см. MAX_HTML_CHARS
    .replace(/<span[^>]*class="img-ph"[^>]*>[\s\S]*?<\/span>/gi, '[image]')
    .replace(/<img\b[^>]*>/gi, '[image]')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return !href || href === text || href.startsWith('#') ? inner : `${inner} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|pre|blockquote|table|tr)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|pre|blockquote|table|tr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (s: string): string => (s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}\n…(truncated)` : s);

/** Markdown задачи для модели: поля, описание, последние комментарии. Подписи — по-английски (это текст для модели, не UI). */
export function issueContext(c: Pick<IssueCard, 'instanceName' | 'issue'>, url: string): string {
  const i = c.issue;
  const line = (label: string, v: string | undefined): string => (v ? `- ${label}: ${v}\n` : '');
  const desc = htmlToText(i.descriptionHtml);
  const comments = i.comments.slice(-AI_COMMENTS);
  let s = `# ${i.key}: ${i.summary}\n\n`;
  s += line('URL', url);
  s += line('Jira', c.instanceName);
  s += line('Type', i.type);
  s += line('Status', i.status);
  s += line('Priority', i.priority);
  s += line('Assignee', i.assignee?.name);
  s += line('Reporter', i.reporter?.name);
  s += line('Epic', i.epic && (i.epic.summary ? `${i.epic.key} ${i.epic.summary}` : i.epic.key));
  s += line('Fix versions', i.fixVersions.map((v) => v.name).join(', '));
  s += line('Labels', i.labels.join(', '));
  s += line('Components', i.components.join(', '));
  s += line('Created', i.created);
  s += line('Updated', i.updated);
  s += line('Due', i.due);
  s += `\n## Description\n\n${desc ? clip(desc) : '(empty)'}\n`;
  if (comments.length) {
    const head = comments.length < i.comments.length ? `last ${comments.length} of ${i.comments.length}` : `${comments.length}`;
    s += `\n## Comments (${head})\n`;
    for (const cm of comments) s += `\n### ${cm.author?.name ?? 'unknown'}, ${cm.created}\n\n${clip(htmlToText(cm.bodyHtml))}\n`;
  }
  return s;
}
