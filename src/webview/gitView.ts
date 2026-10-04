/**
 * Вкладка «git» (roadmap 12): модель вида — чистые функции над снимком хоста (`GitSnapshot`), без DOM.
 * Строки «путь» и «дерево», метка агента, фильтр, бейдж, текст кнопки коммита.
 */
import type { GitFileStatus, GitFileView, GitRepoView, GitSnapshot } from '../shared/git';

/** Предел заголовка коммита: счётчик `72 − длина`, меньше нуля — предупреждение. */
export const SUMMARY_LIMIT = 72;

/** Строка файла вкладки (общая для «путь» и «дерево»). */
export interface GitFileRow {
  kind: 'file';
  /** Путь от корня репозитория. */
  path: string;
  /** Имя файла. */
  base: string;
  /** Папка с хвостовым `/` (пусто — корень репозитория); в режиме «дерево» не показывается. */
  dir: string;
  status: GitFileStatus;
  from?: string;
  add?: number;
  del?: number;
  binary?: boolean;
  /** Файл правил агент в этой сессии. */
  agent: boolean;
  /** Отступ в дереве (число папок выше), в режиме «путь» — 0. */
  level: number;
}

/** Строка-папка режима «дерево». */
export interface GitDirRow {
  kind: 'dir';
  /** Полный путь папки без хвостового `/`. */
  path: string;
  name: string;
  level: number;
}

export type GitRow = GitFileRow | GitDirRow;

function split(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** Свернуть `a/./b/../c` в `a/c`; ведущие `..` остаются (файл выше корня). */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else out.push(part);
  }
  return out.join('/');
}

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Путь файла от cwd чата (как в списке правок агента). Есть `cwd` — считаем по абсолютным путям (cwd может
 * лежать глубже корня репозитория: `rel` тогда `..`, а имени папки в нём нет); нет — склеиваем `rel` с путём.
 * Начинается с `../` — файл вне cwd.
 */
export function cwdPath(
  repo: Pick<GitRepoView, 'root' | 'rel'>,
  path: string,
  cwd?: string,
): string {
  if (cwd) {
    const c = slash(cwd);
    const abs = `${slash(repo.root)}/${path}`;
    return abs.startsWith(`${c}/`) ? abs.slice(c.length + 1) : `../${path}`;
  }
  return normalize(repo.rel ? `${repo.rel}/${path}` : path);
}

/** Файл правил агент в этой сессии: его путь от cwd есть среди правок ленты. Вне cwd — никогда. */
export function isAgentFile(
  repo: Pick<GitRepoView, 'root' | 'rel'>,
  path: string,
  agentPaths: ReadonlySet<string>,
  cwd?: string,
): boolean {
  const p = cwdPath(repo, path, cwd);
  return p !== '..' && !p.startsWith('../') && agentPaths.has(p);
}

function fileRow(
  f: GitFileView,
  repo: GitRepoView,
  agentPaths: ReadonlySet<string>,
  cwd?: string,
): GitFileRow {
  const { dir, base } = split(f.path);
  return {
    kind: 'file',
    path: f.path,
    base,
    dir,
    status: f.status,
    ...(f.from ? { from: f.from } : {}),
    ...(f.add !== undefined ? { add: f.add } : {}),
    ...(f.del !== undefined ? { del: f.del } : {}),
    ...(f.binary ? { binary: true } : {}),
    agent: isAgentFile(repo, f.path, agentPaths, cwd),
    level: 0,
  };
}

/** Файлы секции с меткой агента; `agentOnly` — только помеченные. Порядок — по пути. */
export function fileRows(
  files: readonly GitFileView[],
  repo: GitRepoView,
  agentPaths: ReadonlySet<string>,
  agentOnly = false,
  cwd?: string,
): GitFileRow[] {
  const rows = files.map((f) => fileRow(f, repo, agentPaths, cwd));
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return agentOnly ? rows.filter((r) => r.agent) : rows;
}

/** Режим «дерево»: папки отдельными строками, файлы с отступом по числу папок над ними. */
export function treeRows(files: readonly GitFileRow[]): GitRow[] {
  const out: GitRow[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const parts = f.dir.split('/').filter(Boolean);
    for (let k = 0; k < parts.length; k++) {
      const path = parts.slice(0, k + 1).join('/');
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ kind: 'dir', path, name: parts[k]!, level: k });
    }
    out.push({ ...f, level: parts.length });
  }
  return out;
}

/** Строки секции в выбранном виде. */
export function sectionRows(rows: readonly GitFileRow[], tree: boolean): GitRow[] {
  return tree ? treeRows(rows) : [...rows];
}

/** Сколько файлов в репозитории (не в индексе + в индексе). */
export function repoCount(r: GitRepoView): number {
  return r.unstaged.length + r.staged.length;
}

/** Файлов во всех репозиториях. */
export function totalCount(s: GitSnapshot): number {
  return s.repos.reduce((n, r) => n + repoCount(r), 0);
}

/** Сколько файлов помечено агентом (по обоим спискам всех репозиториев). */
export function agentCount(s: GitSnapshot, agentPaths: ReadonlySet<string>, cwd?: string): number {
  let n = 0;
  for (const r of s.repos) {
    for (const f of [...r.unstaged, ...r.staged]) if (isAgentFile(r, f.path, agentPaths, cwd)) n++;
  }
  return n;
}

/** Бейдж вкладки: число файлов; без снимка, при `state !== 'ok'` и при нуле — нет. */
export function gitBadge(s: GitSnapshot | undefined): { count: number } | undefined {
  if (!s || s.state !== 'ok') return undefined;
  const count = totalCount(s);
  return count > 0 ? { count } : undefined;
}

/** Все пути помеченных агентом файлов из списка правок (`changesView`): путь от cwd. */
export function agentPathSet(dirs: readonly { dir: string; files: readonly { base: string }[] }[]) {
  const set = new Set<string>();
  for (const d of dirs) for (const f of d.files) set.add(`${d.dir}${f.base}`);
  return set;
}

/** Сообщение коммита: заголовок, пустая строка, описание. */
export function commitMessage(summary: string, desc: string): string {
  const s = summary.trim();
  const d = desc.trim();
  return d ? `${s}\n\n${d}` : s;
}

/** Остаток счётчика заголовка (`72 − длина`); `over` — заголовок длиннее предела. */
export function summaryLeft(summary: string): { left: number; over: boolean } {
  const left = SUMMARY_LIMIT - [...summary].length;
  return { left, over: left < 0 };
}

export interface CommitButton {
  /** Кнопка недоступна: пустой индекс (кроме «всех изменений»), пустое сообщение или идёт операция. */
  disabled: boolean;
  /** Почему недоступна — подсказка; пусто — доступна. */
  why?: 'empty-index' | 'empty-message' | 'busy';
  /** Число файлов в коммите. */
  files: number;
  branch: string;
}

/** Состояние кнопки «Коммит · N файла → ветка». `all` — «Коммит всех изменений» (индекс не нужен). */
export function commitButton(
  r: GitRepoView,
  opts: { message: string; amend: boolean; all?: boolean },
): CommitButton {
  const files = opts.all ? repoCount(r) : r.staged.length;
  const branch = r.branch ?? '';
  if (r.busy) return { disabled: true, why: 'busy', files, branch };
  // amend без новых файлов допустим: меняется сообщение предыдущего коммита
  if (files === 0 && !opts.amend) return { disabled: true, why: 'empty-index', files, branch };
  if (!opts.message.trim()) return { disabled: true, why: 'empty-message', files, branch };
  return { disabled: false, files, branch };
}

/** Против upstream: число стрелок и «не опубликована». */
export function syncView(r: GitRepoView): {
  unpublished: boolean;
  ahead: number;
  behind: number;
} {
  return { unpublished: !r.published, ahead: r.ahead ?? 0, behind: r.behind ?? 0 };
}

/** Лента последних коммитов: время короткое — сегодня часы, иначе дата. */
export function commitWhen(at: number, now: number): string {
  if (!at) return '';
  const d = new Date(at);
  const n = new Date(now);
  const pad = (x: number) => String(x).padStart(2, '0');
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}
