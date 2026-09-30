/**
 * Контекст, который расширение дописывает к сообщению пользователя (этап 3): открытый файл,
 * выделение, файлы и папки из «+». Хост собирает блок и отправляет движку текст + блок; в ленте
 * пользователь видит только свой текст: `turn.start.prompt` несёт полный текст, а `splitPrompt`
 * отделяет блок обратно.
 */

export interface Attachment {
  kind: 'file' | 'folder' | 'selection';
  /** Путь относительно папки воркспейса (с `/`). */
  path: string;
  /** Для `selection` — строки, с 1. */
  startLine?: number;
  endLine?: number;
}

/** Файл или папка воркспейса для меню «@» и «+». */
export interface FileHit {
  path: string;
  name: string;
  /** Каталог относительно воркспейса, без имени; пусто — корень. */
  dir: string;
  isDir: boolean;
}

export const CONTEXT_MARKER = '[Agentura: контекст]';
const SEPARATOR = `\n\n${CONTEXT_MARKER}\n`;

export function attachmentKey(a: Attachment): string {
  return a.kind === 'selection' ? `${a.path}:${a.startLine ?? 0}-${a.endLine ?? 0}` : a.path;
}

/** Подпись чипа: `Counter.tsx 12–40`. */
export function attachmentLabel(a: Attachment): { name: string; range: string } {
  const name = a.path.split('/').pop() || a.path;
  const range =
    a.kind === 'selection' && a.startLine !== undefined
      ? a.endLine !== undefined && a.endLine !== a.startLine
        ? ` ${a.startLine}–${a.endLine}`
        : ` ${a.startLine}`
      : '';
  return { name: a.kind === 'folder' ? `${name}/` : name, range };
}

/**
 * Текст для движка. `selectionText` — тексты выделений по `attachmentKey`, читает хост.
 * Без вложений возвращает текст как есть.
 */
export function buildPrompt(
  text: string,
  attachments: readonly Attachment[],
  selectionText: Readonly<Record<string, string>> = {},
): string {
  if (attachments.length === 0) return text;
  const lines: string[] = [];
  const fences: string[] = [];
  for (const a of attachments) {
    if (a.kind === 'file') lines.push(`- файл: ${a.path}`);
    else if (a.kind === 'folder') lines.push(`- папка: ${a.path}`);
    else {
      const range = a.startLine !== undefined ? `:${a.startLine}-${a.endLine ?? a.startLine}` : '';
      lines.push(`- выделение: ${a.path}${range}`);
      const body = selectionText[attachmentKey(a)];
      if (body) fences.push('```\n' + body + '\n```');
    }
  }
  return `${text}${SEPARATOR}${lines.join('\n')}${fences.length ? '\n\n' + fences.join('\n\n') : ''}`;
}

/** Обратное к `buildPrompt`: текст пользователя и блок контекста (если есть). */
export function splitPrompt(prompt: string): { text: string; context?: string } {
  const at = prompt.indexOf(SEPARATOR);
  if (at < 0) return { text: prompt };
  return { text: prompt.slice(0, at), context: prompt.slice(at + SEPARATOR.length) };
}
