/**
 * Чистая логика вкладки «код» полосы задачи (roadmap 24): счётчик у вкладки, видимые ветки, команды «как ищем?»,
 * наборы файлов для встроенного диффа.
 */
import type { CodeBranch, CodeDiffTarget, CodeFile, CodeRepo, TaskCodeStateMessage } from '../shared/task';
import { ui } from './strings';
import { issueKeyOf } from './taskView';

/** Итог относится к этой задаче и уже загружен (идущая первая загрузка без репозиториев — ещё нет). */
export function codeFor(state: TaskCodeStateMessage | undefined, taskKey: string | undefined): TaskCodeStateMessage | undefined {
  return state && taskKey && state.taskKey === taskKey ? state : undefined;
}

/** Число у вкладки: коммиты + незакоммиченные файлы по всем репозиториям; не загружено — `undefined` (без числа). */
export function codeCount(state: TaskCodeStateMessage | undefined, taskKey: string | undefined): number | undefined {
  const s = codeFor(state, taskKey);
  if (!s || (s.loading && s.repos.length === 0)) return undefined;
  return s.repos.reduce((n, r) => n + r.commits.length + r.dirty.length, 0);
}

/**
 * Ветки, которые показываем: при известной базе — только с коммитами сверх неё (`ahead > 0`, остальные уже влиты);
 * без базы хост отдаёт `ahead: 0` и пустой список файлов — показываем только имя.
 */
export function visibleBranches(repo: CodeRepo): CodeBranch[] {
  return repo.base ? repo.branches.filter((b) => b.ahead > 0) : repo.branches;
}

/** В репозитории есть что показать (или ошибка чтения). */
export function repoHasContent(repo: CodeRepo): boolean {
  return !!repo.error || repo.commits.length > 0 || repo.dirty.length > 0 || visibleBranches(repo).length > 0;
}

/** Каталог и имя файла: `a/b/c.ts` → `['a/b/', 'c.ts']`. */
export function splitPath(p: string): [dir: string, base: string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

export interface HowCommands {
  /** Ключ задачи (или пример `KEY-123`, если ключ не разобрался). */
  key: string;
  log: string;
  branches: string;
  ahead: string;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Команды для «как ищем?»: общий текст с ключом задачи, без реальных базы и ветки репозитория —
 * на их месте плейсхолдеры из строк (`<база>` / `<ветка>`).
 */
export function howCommands(taskKey: string | undefined): HowCommands {
  const key = (taskKey && issueKeyOf(taskKey)) || 'KEY-123';
  const t = ui.task.code;
  return {
    key,
    log: `git log --all -i --grep=${shq(key)} --format='%h %an %s'`,
    branches: `git branch -a --list ${shq(`*${key}*`)}`,
    ahead: `git log --oneline ${t.howPhBase}..${t.howPhBranch}`,
  };
}

/** Один файл набора встроенного диффа. */
export interface DiffItem {
  path: string;
  status: CodeFile['status'];
  from?: string;
  add?: number;
  del?: number;
  target: CodeDiffTarget;
}

/** Набор файлов одного объекта (коммит, ветка, незакоммиченное) — по нему идут j/k. */
export interface DiffSet {
  root: string;
  /** Подпись источника в шапке: «коммит a41c9e2», «ветка feature/X», «не закоммичено». */
  label: string;
  items: DiffItem[];
}

const item = (f: CodeFile, target: CodeDiffTarget): DiffItem => ({
  path: f.path,
  status: f.status,
  ...(f.from ? { from: f.from } : {}),
  ...(f.add !== undefined ? { add: f.add } : {}),
  ...(f.del !== undefined ? { del: f.del } : {}),
  target,
});

export function commitSet(root: string, sha: string, short: string, files: readonly CodeFile[]): DiffSet {
  return {
    root,
    label: ui.task.code.diffCtxCommit(short),
    items: files.map((f) => item(f, { kind: 'commit', sha, path: f.path })),
  };
}

export function branchSet(root: string, base: string, branch: CodeBranch): DiffSet {
  return {
    root,
    label: ui.task.code.diffCtxBranch(branch.name),
    items: branch.files.map((f) => item(f, { kind: 'branch', base, branch: branch.name, path: f.path })),
  };
}

export function dirtySet(root: string, files: readonly CodeFile[]): DiffSet {
  return { root, label: ui.task.code.diffCtxWip, items: files.map((f) => item(f, { kind: 'wip', path: f.path })) };
}

/** Следующий/предыдущий индекс набора без перехода через край. */
export function stepIndex(i: number, n: number, dir: 1 | -1): number {
  return Math.min(Math.max(i + dir, 0), Math.max(n - 1, 0));
}

/** Текст «в чат»: `<short> <тема>` и имя репозитория. */
export function prefillText(short: string, subject: string, repoName: string): string {
  return `${short} ${subject} (${repoName})`;
}
