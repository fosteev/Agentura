/**
 * Разбор унифицированного диффа одного файла (`git diff` / `git diff-tree -p`) в хунки. Порт `parsePatch` из gitsprout:
 * общий для хоста (разбор) и webview (встроенный дифф вкладки «код», roadmap 24).
 */

export interface PatchLine {
  kind: ' ' | '+' | '-';
  text: string;
  /** Номер строки в старом файле; у добавленной — `null`. */
  old: number | null;
  /** Номер строки в новом файле; у удалённой — `null`. */
  new: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: PatchLine[];
}

export interface FilePatch {
  binary: boolean;
  hunks: Hunk[];
  /** Строк в хунках больше потолка — остаток отброшен. */
  truncated: boolean;
}

/** Потолок строк хунков одного патча. */
export const MAX_PATCH_LINES = 10_000;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Дифф одного файла → хунки. Строки до первого `@@` — шапка файла (из неё берётся только признак бинарного).
 * После `maxLines` строк хунков разбор останавливается, `truncated: true`.
 */
export function parsePatch(text: string, maxLines = MAX_PATCH_LINES): FilePatch {
  const res: FilePatch = { binary: false, hunks: [], truncated: false };
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let count = 0;
  for (const raw of lines) {
    const m = HUNK_HEADER.exec(raw);
    if (m) {
      hunk = { header: raw.replace(/\r$/, ''), oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      res.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(raw) || raw === 'GIT binary patch') res.binary = true;
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c !== ' ' && c !== '+' && c !== '-' && raw !== '') continue; // не часть хунка
    if (count >= maxLines) {
      res.truncated = true;
      break;
    }
    count++;
    const t = raw.slice(1).replace(/\r$/, '');
    if (c === '+') hunk.lines.push({ kind: '+', text: t, old: null, new: newNo++ });
    else if (c === '-') hunk.lines.push({ kind: '-', text: t, old: oldNo++, new: null });
    else hunk.lines.push({ kind: ' ', text: t, old: oldNo++, new: newNo++ });
  }
  return res;
}
