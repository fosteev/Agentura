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
}

/** Лимит контекста: больше — обрезается (дальше файл проверят лимиты вложений поля ввода). */
export const MAX_CONTEXT_CHARS = 200_000;

const MAX_PROMPT_CHARS = 2_000;
const MAX_SESSION_CHARS = 200;

/** Проверить недоверенный аргумент команды. Имя — один сегмент пути; нет — `context.md`. */
export function contextRequest(arg: unknown): ContextRequest | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const { context, name, prompt, sessionKey, task, session } = arg as Record<string, unknown>;
  if (typeof context !== 'string' || !context.trim()) return undefined;
  const clean =
    typeof name === 'string'
      ? name
          .replace(/[\\/:*?"<>|]/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100)
      : '';
  return {
    name: clean && !/^\.+$/.test(clean) ? clean : 'context.md',
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
  };
}
