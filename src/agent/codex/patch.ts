import type { FileUpdateChange } from './protocol';

/** Один ханк unified diff в форме `structuredPatch` (то же поле, что у результата Edit в Claude). */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Ханки из `FileUpdateChange.diff` вида `update`. Заголовки файла (`---`/`+++`/`diff --git`) до первого
 * `@@` пропускаются; строки после — `' '`, `'+'`, `'-'`, `\`. Ничего не разобрали — пустой список.
 */
export function parseHunks(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/** Старая и новая стороны правки по ханкам (контекст — в обеих); несколько ханков склеиваются подряд. */
export function sidesOfHunks(hunks: PatchHunk[]): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const body = line.slice(1);
      if (line.startsWith('+')) newLines.push(body);
      else if (line.startsWith('-')) oldLines.push(body);
      else if (line.startsWith(' ')) {
        oldLines.push(body);
        newLines.push(body);
      }
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/** Путь, по которому правка видна пользователю: у переноса — новое место. */
export function changePath(change: FileUpdateChange): string {
  return change.kind.type === 'update' && change.kind.move_path ? change.kind.move_path : change.path;
}

// только системный шелл (голое имя или стандартный каталог): `./bash -c ls` — уже чужой скрипт, его не прячем
const SHELL_WRAPPER = /^(?:\/bin\/|\/usr\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)?(?:bash|zsh|sh|dash) -[a-z]*c[a-z]* ([\s\S]+)$/;
const SIMPLE_WORD = /^[^\s'"\\$`;&|<>()*?{}!~#]+$/;

/**
 * Команда для показа: Codex запускает `/bin/zsh -lc '<команда>'`, и обёртка шум. Снимаем её только когда
 * вид однозначный (одно слово или одна пара кавычек без спецсимволов внутри); иначе — строка как есть,
 * семантику не угадываем.
 */
export function displayCommand(raw: string): string {
  const m = SHELL_WRAPPER.exec(raw.trim());
  if (!m) return raw;
  const rest = m[1]!.trim();
  if (SIMPLE_WORD.test(rest)) return rest;
  const quote = rest[0];
  if ((quote === "'" || quote === '"') && rest.length >= 2 && rest.endsWith(quote)) {
    const inner = rest.slice(1, -1);
    const bad = quote === "'" ? /'/ : /["\\$`]/;
    if (!bad.test(inner)) return inner;
  }
  return raw;
}
