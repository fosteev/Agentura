/** Аргумент `agentura.openWithContext`: `context` уходит файлом `name` в поле ввода новой вкладки. */
export interface ContextRequest {
  name: string;
  context: string;
  /** Текст в пустое поле ввода (например, ссылка на задачу). */
  prompt?: string;
  /** Внешний ключ (например, `jiraffe:<инстанс>:<задача>`): повторный вызов возобновляет ту же сессию. */
  sessionKey?: string;
}

/** Лимит контекста: больше — обрезается (дальше файл проверят лимиты вложений поля ввода). */
export const MAX_CONTEXT_CHARS = 200_000;

const MAX_PROMPT_CHARS = 2_000;

/** Проверить недоверенный аргумент команды. Имя — один сегмент пути; нет — `context.md`. */
export function contextRequest(arg: unknown): ContextRequest | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const { context, name, prompt, sessionKey } = arg as Record<string, unknown>;
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
    ...(typeof sessionKey === 'string' && sessionKey
      ? { sessionKey: sessionKey.slice(0, 200) }
      : {}),
  };
}
