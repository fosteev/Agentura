import { parseTaskKey, type TaskKey, type TaskMeta } from './taskGroups';

/** Страницы UI Jira, после которых начинается не context path, а путь внутри приложения. */
const APP_PATH = /\/(browse|secure|projects|issues|plugins|rest|servicedesk|login\.jsp)(\/|$)/i;
const KEY_IN_TEXT = /\b([A-Za-z][A-Za-z0-9_]*-\d+)\b/;

/**
 * Скопировано из fosteev/jiraffe 0.7.0 src/jira/http.ts (`canonicalBaseUrl`) и src/state/instances.ts
 * (`instanceIdFromUrl`): id инстанса должен совпадать с тем, что считает Jiraffe. Правок нет.
 */
export function canonicalBaseUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.hostname.endsWith('.atlassian.net')) return u.origin;
  const m = APP_PATH.exec(u.pathname);
  const path = m ? u.pathname.slice(0, m.index) : u.pathname;
  return (u.origin + path).trim().replace(/\/+$/, '');
}

export function instanceIdFromUrl(url: string): string {
  const u = new URL(url.trim().replace(/\/+$/, ''));
  return (u.host + u.pathname)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type IssueInput =
  | { kind: 'link'; key: string; instanceId: string; baseUrl: string; url: string }
  | { kind: 'key'; key: string }
  | { kind: 'taskKey'; taskKey: TaskKey; instanceId: string; key: string };

/** Что ввёл человек: ключ `NEWMFC-1482`, ссылка на задачу, ключ группы `jira:<инстанс>:<KEY>`. */
export function parseIssueInput(input: string): IssueInput | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const tk = parseTaskKey(text);
  if (tk) return { kind: 'taskKey', ...tk };
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      const fromPath = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i.exec(u.pathname)?.[1];
      const key = (fromPath ?? u.searchParams.get('selectedIssue') ?? u.searchParams.get('issueKey') ?? '').toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return undefined;
      const baseUrl = canonicalBaseUrl(text);
      return { kind: 'link', key, instanceId: instanceIdFromUrl(baseUrl), baseUrl, url: `${baseUrl}/browse/${key}` };
    } catch {
      return undefined;
    }
  }
  const m = KEY_IN_TEXT.exec(text);
  return m && m[1]!.length === text.length ? { kind: 'key', key: m[1]!.toUpperCase() } : undefined;
}

/** Адрес инстанса из ссылки на его задачу (`…/browse/KEY-1`); не ссылка — пусто. */
export function baseUrlOfIssueUrl(url: string): string {
  try {
    return canonicalBaseUrl(url);
  } catch {
    return '';
  }
}

/** `TaskMeta` для привязки без запроса в Jira: название — ключ до первого обновления. */
export function bareMeta(key: string, instanceId: string, url: string): TaskMeta {
  return { key, instanceId, title: key, url };
}

/**
 * Id сессии из аргумента команды: строка (вызов из кода) или контекст меню строки боковой панели
 * (`webview/context`: `data-vscode-context` строки + `webview`) — объект с `sessionId`.
 */
export function sessionIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg || undefined;
  if (typeof arg === 'object' && arg !== null) {
    const id = (arg as { sessionId?: unknown }).sessionId;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}
