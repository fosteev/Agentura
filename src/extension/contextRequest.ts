import type { AgentProvider } from '../agent/types';
import { isProvider } from '../settings';
import { taskMeta, type TaskMeta } from './taskGroups';

/** Аргумент `agentura.openWithContext`: `context` уходит файлом `name` в поле ввода новой вкладки. */
export interface ContextRequest {
  name: string;
  context: string;
  /** Текст в пустое поле ввода (например, ссылка на задачу). */
  prompt?: string;
  /** Внешний ключ (например, `jiraffe:<инстанс>:<задача>`): повторный вызов возобновляет ту же сессию. */
  sessionKey?: string;
  /**
   * Задача Jira, к которой относится чат (решение 7): группа `jira:<instanceId>:<KEY>`. Нет — задача берётся из
   * `sessionKey` вида `jiraffe:<инстанс>:<KEY>` (Jiraffe 0.7.0), иначе чат вне групп.
   */
  task?: TaskMeta;
  /** `new` — новая вкладка в группе; id чата группы — возобновить его; нет — последний чат группы. */
  session?: string;
  /** Движок новой вкладки (roadmap 26); нет — `agentura.defaultProvider`. Настройку не меняет. */
  provider?: AgentProvider;
  /** Ещё текстовые вложения после `context` (итог чата, изменения задачи), по порядку. */
  files?: { name: string; text: string }[];
  /**
   * `prompt` уходит первым сообщением сам (после вложений); нет — только в поле ввода. Только внутренний вызов
   * (`agentura.chatForTask` из вкладки чата): `contextRequest()` поле не принимает (Д4 доводки 1).
   */
  autoSend?: boolean;
  /**
   * Рабочая папка новой вкладки (своя worktree); нет — папка воркспейса. Новая вкладка — всегда новая. Только
   * внутренний вызов, как `autoSend`: внешний вход не открывает агента в произвольной папке.
   */
  cwd?: string;
  /** Новая вкладка рядом (`ViewColumn.Beside`); при `tasks.tab = task` не действует. */
  beside?: boolean;
}

/** Лимит контекста: больше — обрезается (дальше файл проверят лимиты вложений поля ввода). */
export const MAX_CONTEXT_CHARS = 200_000;

const MAX_PROMPT_CHARS = 2_000;
const MAX_SESSION_CHARS = 200;
/** Доп. вложений (`files`) не больше: лимит поля ввода — 10 файлов на сообщение. */
const MAX_EXTRA_FILES = 4;

/** Имя файла-вложения: один сегмент пути; пусто или одни точки — `undefined`. */
function cleanName(name: unknown): string | undefined {
  const clean =
    typeof name === 'string'
      ? name
          .replace(/[\\/:*?"<>|]/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100)
      : '';
  return clean && !/^\.+$/.test(clean) ? clean : undefined;
}

/** Доп. вложения: только `{ name, text }` с непустым текстом, имя — как у `name`, текст обрезается. */
function extraFiles(v: unknown): { name: string; text: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { name: string; text: string }[] = [];
  for (const f of v.slice(0, MAX_EXTRA_FILES)) {
    if (!f || typeof f !== 'object') continue;
    const { name, text } = f as Record<string, unknown>;
    const clean = cleanName(name);
    if (!clean || typeof text !== 'string' || !text.trim()) continue;
    out.push({ name: clean, text: text.slice(0, MAX_CONTEXT_CHARS) });
  }
  return out;
}

/**
 * Проверить недоверенный аргумент команды `agentura.openWithContext` (её зовёт любое расширение и `command:`-ссылка).
 * Имя — один сегмент пути; нет — `context.md`. `cwd` и `autoSend` не принимаются: снаружи нельзя открыть агента в
 * чужой папке или отправить ему сообщение без человека (Д4 доводки 1 roadmap 26).
 */
export function contextRequest(arg: unknown): ContextRequest | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const { context, name, prompt, sessionKey, task, session, provider, files, beside } = arg as Record<string, unknown>;
  if (typeof context !== 'string' || !context.trim()) return undefined;
  const extra = extraFiles(files);
  return {
    name: cleanName(name) ?? 'context.md',
    context: context.slice(0, MAX_CONTEXT_CHARS),
    ...(typeof prompt === 'string' && prompt.trim()
      ? { prompt: prompt.slice(0, MAX_PROMPT_CHARS) }
      : {}),
    // длинные ключ и id отбрасываются, а не режутся: обрезанный ключ задачи может оказаться другой задачей
    ...(typeof sessionKey === 'string' && sessionKey && sessionKey.length <= 200 ? { sessionKey } : {}),
    ...(taskMeta(task) ? { task: taskMeta(task)! } : {}),
    ...(typeof session === 'string' && session.trim() && session.trim().length <= MAX_SESSION_CHARS
      ? { session: session.trim() }
      : {}),
    ...(isProvider(provider) ? { provider } : {}),
    ...(extra.length ? { files: extra } : {}),
    ...(beside === true ? { beside: true } : {}),
  };
}
