/**
 * Дифф правок агента (этап 5), без vscode: стороны «до / после» для нативного диффа и превью
 * ханков для карточки. До применения — из входа `canUseTool` (`DiffPreview`) и файла на диске;
 * после — из `tool_use_result` (`originalFile` + `structuredPatch`, docs/spikes/sdk-probe.md, раздел 14).
 */
import { applyPatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import type { DiffPreview } from '../agent/types';
import type { EditPreview } from '../protocol';

export interface EditSides {
  filePath: string;
  before: string;
  after: string;
  isNew: boolean;
  /** Стороны — фрагменты правки, а не файл целиком (фрагмент не найден, файла нет, нет `originalFile`). */
  fragment?: boolean;
}

/** Строк ханков в превью карточки; остальное — «открыть дифф». */
export const PREVIEW_LINES = 40;
/** Предел длины правки для Myers: дальше дифф не считаем (огромная перезапись файла). */
const MAX_EDIT_LENGTH = 20_000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Первое вхождение без `$`-шаблонов `String.replace`. */
function replaceOnce(text: string, from: string, to: string): string | undefined {
  const i = text.indexOf(from);
  return i < 0 ? undefined : text.slice(0, i) + to + text.slice(i + from.length);
}

/** Замена в тексте файла: первое вхождение или все (`replace_all`); `undefined` — фрагмента нет. */
function replaceIn(text: string, from: string, to: string, all: boolean): string | undefined {
  if (from === '') return undefined;
  if (all) return text.includes(from) ? text.split(from).join(to) : undefined;
  return replaceOnce(text, from, to);
}

/**
 * Замена с учётом CRLF: модель пишет `old_string`/`new_string` с `\n`, а файл может быть с `\r\n`
 * (движок правит такие файлы, сохраняя окончания строк) — тогда ищем фрагмент с `\r\n`.
 */
function replaceEol(text: string, from: string, to: string, all: boolean): string | undefined {
  if (!text.includes('\r\n') || from.includes('\r') || to.includes('\r'))
    return replaceIn(text, from, to, all);
  const crlf = (x: string) => x.replace(/\n/g, '\r\n');
  return replaceIn(text, crlf(from), crlf(to), all) ?? replaceIn(text, from, to, all);
}

/**
 * Стороны правки до применения. `fileText` — файл на диске (`undefined` — файла нет или не
 * прочитан). Edit с пустым `old_string` по несуществующему файлу — создание файла.
 */
export function proposedSides(d: DiffPreview, fileText: string | undefined): EditSides {
  if (d.kind === 'write') {
    return {
      filePath: d.filePath,
      before: fileText ?? '',
      after: d.content,
      isNew: fileText === undefined,
    };
  }
  // пустой `old_string` по несуществующему или пустому файлу — движок просто пишет файл
  if (d.oldText === '' && fileText === '')
    return { filePath: d.filePath, before: '', after: d.newText, isNew: false };
  if (fileText === undefined) {
    if (d.oldText === '')
      return { filePath: d.filePath, before: '', after: d.newText, isNew: true };
    return {
      filePath: d.filePath,
      before: d.oldText,
      after: d.newText,
      isNew: false,
      fragment: true,
    };
  }
  const after = replaceEol(fileText, d.oldText, d.newText, d.replaceAll);
  if (after === undefined)
    return {
      filePath: d.filePath,
      before: d.oldText,
      after: d.newText,
      isNew: false,
      fragment: true,
    };
  return { filePath: d.filePath, before: fileText, after, isNew: false };
}

/**
 * Стороны уже применённой правки из `tool_use_result`: Write — `originalFile` (null у нового) и
 * `content`; Edit — `originalFile` + `structuredPatch`, при несовпадении патча — фрагменты.
 */
export function appliedSides(
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
): EditSides | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const filePath = str(r['filePath']) ?? str(input['file_path']);
  if (!filePath) return undefined;
  const original = str(r['originalFile']);
  if (toolName === 'Write') {
    const content = str(r['content']) ?? str(input['content']);
    if (content === undefined) return undefined;
    // `originalFile: null` бывает и у перезаписи слишком большого файла (`type: 'update'`):
    // тогда «до» неизвестно — не выдавать правку за новый файл
    if (original === undefined && r['type'] === 'update')
      return { filePath, before: '', after: content, isNew: false, fragment: true };
    return { filePath, before: original ?? '', after: content, isNew: original === undefined };
  }
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return undefined;
  const hunks = Array.isArray(r['structuredPatch'])
    ? (r['structuredPatch'] as StructuredPatchHunk[])
    : [];
  if (original !== undefined && hunks.length > 0) {
    const after = applyPatch(original, {
      oldFileName: filePath,
      newFileName: filePath,
      oldHeader: undefined,
      newHeader: undefined,
      hunks,
    });
    if (after !== false) return { filePath, before: original, after, isNew: false };
  }
  const oldText = str(r['oldString']) ?? str(input['old_string']);
  const newText = str(r['newString']) ?? str(input['new_string']);
  if (oldText === undefined || newText === undefined) return undefined;
  if (original !== undefined) {
    const after = replaceEol(original, oldText, newText, r['replaceAll'] === true);
    if (after !== undefined) return { filePath, before: original, after, isNew: false };
  }
  return { filePath, before: oldText, after: newText, isNew: false, fragment: true };
}

/** Превью для карточки: ханки с контекстом 3 строки, счётчики `+N −M`, не больше `maxLines` строк. */
export function previewOf(sides: EditSides, maxLines = PREVIEW_LINES): EditPreview {
  const base = { filePath: sides.filePath, isNew: sides.isNew };
  const patch = structuredPatch('a', 'b', sides.before, sides.after, undefined, undefined, {
    context: 3,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!patch) {
    const count = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
    return {
      ...base,
      add: count(sides.after),
      del: count(sides.before),
      hunks: [],
      hidden: 0,
      note: 'too-large',
    };
  }
  let add = 0;
  let del = 0;
  let shown = 0;
  let hidden = 0;
  const hunks: EditPreview['hunks'] = [];
  for (const h of patch.hunks) {
    // «\ No newline at end of file» — не строка файла; `\r` у CRLF-файла в карточке не нужен
    const lines = h.lines.filter((l) => !l.startsWith('\\')).map((l) => l.replace(/\r$/, ''));
    for (const l of lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
    const room = maxLines - shown;
    if (room <= 0) {
      hidden += lines.length;
      continue;
    }
    const header = sides.fragment
      ? '@@ фрагмент правки @@'
      : `@@ -${start(h.oldStart, h.oldLines)},${h.oldLines} +${start(h.newStart, h.newLines)},${h.newLines} @@`;
    hunks.push({ header, lines: lines.slice(0, room) });
    shown += Math.min(room, lines.length);
    hidden += Math.max(0, lines.length - room);
  }
  return {
    ...base,
    add,
    del,
    hunks,
    hidden,
    ...(sides.fragment ? { note: 'fragment' as const } : {}),
  };
}

/** Начало пустой стороны ханка — как у `diff -u`: строка *перед* вставкой (`-0,0` у нового файла). */
function start(line: number, count: number): number {
  return count === 0 ? Math.max(0, line - 1) : line;
}
