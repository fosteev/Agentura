import type { FileHit } from '../shared/prompt';

/** Поиск по списку путей воркспейса для меню «@»: чистые функции без vscode — проверяются тестами. */

export function toHit(path: string, isDir: boolean): FileHit {
  const i = path.lastIndexOf('/');
  return {
    path,
    name: i < 0 ? path : path.slice(i + 1),
    dir: i < 0 ? '' : path.slice(0, i),
    isDir,
  };
}

/** Каталоги, встречающиеся в путях файлов (без корня). */
export function directoriesOf(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.indexOf('/');
    while (i >= 0) {
      dirs.add(f.slice(0, i));
      i = f.indexOf('/', i + 1);
    }
  }
  return [...dirs];
}

function isSubsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

/** Меньше — лучше; `undefined` — не подходит. */
function score(hit: FileHit, q: string): number | undefined {
  const name = hit.name.toLowerCase();
  const path = hit.path.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (path.includes(q)) return 3;
  if (isSubsequence(q, name)) return 4;
  return undefined;
}

export function rankFiles(files: readonly string[], query: string, limit = 20): FileHit[] {
  const hits = [
    ...files.map((f) => toHit(f, false)),
    ...directoriesOf(files).map((d) => toHit(d, true)),
  ];
  const q = query.trim().toLowerCase();
  if (!q) {
    return hits
      .sort(
        (a, b) =>
          a.path.split('/').length - b.path.split('/').length ||
          Number(a.isDir) - Number(b.isDir) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, limit);
  }
  const scored: { hit: FileHit; s: number }[] = [];
  for (const hit of hits) {
    const s = score(hit, q);
    if (s !== undefined) scored.push({ hit, s });
  }
  scored.sort(
    (a, b) =>
      a.s - b.s ||
      Number(a.hit.isDir) - Number(b.hit.isDir) ||
      a.hit.path.length - b.hit.path.length ||
      a.hit.path.localeCompare(b.hit.path),
  );
  return scored.slice(0, limit).map((x) => x.hit);
}

/** Из `files.exclude` / `search.exclude` (`{glob: bool}`) — глобы, отключённые не берём. */
export function excludeGlobs(...configs: (Record<string, unknown> | undefined)[]): string[] {
  const out = new Set<string>(['**/.git/**', '**/node_modules/**']);
  for (const c of configs) {
    if (!c) continue;
    for (const [glob, on] of Object.entries(c)) if (on === true) out.add(glob);
  }
  return [...out];
}
