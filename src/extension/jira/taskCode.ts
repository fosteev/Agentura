import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentProvider } from '../../agent/types';
import { parsePatch, type FilePatch } from '../../shared/patch';
import {
  isCodeDiffTarget,
  type CodeBranch,
  type CodeChat,
  type CodeCommit,
  type CodeDiffTarget,
  type CodeDirty,
  type CodeFile,
  type CodeFileStatus,
  type CodeRepo,
  type TaskCodeCommitMessage,
  type TaskCodeDiffMessage,
  type TaskCodeStateMessage,
  type TaskCodeRequest,
} from '../../shared/task';
import { parseNumstat } from '../git/gitService';

/**
 * Вкладка «код» задачи (roadmap 24): коммиты по ключу, ветки задачи, незакоммиченные правки агентов и патчи файлов.
 * Чистые разборщики вывода git и сборщик `collectCode` не знают про `vscode` и сам git — всё через `CodeCollectDeps`.
 */

/** Коммитов в одной выборке (по ключу, по ветке). */
const LOG_LIMIT = 200;
/** `%H%x1f%h%x1f%an%x1f%at%x1f%s` — поля коммита через US. */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%at%x1f%s';
/** Базы по умолчанию, если у `origin` нет `HEAD`. */
const BASE_CANDIDATES = ['develop', 'main', 'master', 'origin/develop', 'origin/main', 'origin/master'];
/** Инструменты правки файлов: у всех трёх движков нормализованы в эти имена. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Ключ задачи: `GARM-87`; экранировать нечего. */
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

// ---------- чистые разборщики ----------

/** Источник регулярки ключа для `git --grep -E` и фильтра имён: `GARM-87` не ловит `GARM-870`. */
export function keyPattern(key: string): string {
  return `(^|[^A-Za-z0-9])${key}([^0-9]|$)`;
}

export function keyRegex(key: string): RegExp {
  return new RegExp(keyPattern(key), 'i');
}

export function isIssueKey(key: string): boolean {
  return ISSUE_KEY_RE.test(key);
}

export interface RawCommit {
  sha: string;
  short: string;
  author: string;
  /** Секунды эпохи. */
  at: number;
  subject: string;
}

/** Вывод `git log --format=LOG_FORMAT`: по коммиту на строку. */
export function parseLog(out: string): RawCommit[] {
  const res: RawCommit[] = [];
  for (const line of out.split('\n')) {
    const f = line.split('\x1f');
    if (f.length < 5 || !/^[0-9a-f]{4,40}$/.test(f[0]!)) continue;
    res.push({ sha: f[0]!, short: f[1]!, author: f[2]!, at: Number(f[3]) || 0, subject: f.slice(4).join('\x1f') });
  }
  return res;
}

/**
 * Ветки задачи: имя из `for-each-ref refs/heads refs/remotes` содержит ключ; `*\/HEAD` отбрасываются; есть локальная
 * `x` и `origin/x` — берём локальную. Порядок — как в выводе git.
 */
export function branchesOf(refs: string, key: string): string[] {
  const re = keyRegex(key);
  const names = refs
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/(^|\/)HEAD$/.test(l));
  const set = new Set(names);
  const res: string[] = [];
  for (const n of names) {
    if (!re.test(n)) continue;
    // `origin/feat/x` при наличии локальной `feat/x` — берём локальную
    const rest = n.slice(n.indexOf('/') + 1);
    if (n.includes('/') && set.has(rest) && re.test(rest)) continue;
    if (!res.includes(n)) res.push(n);
  }
  return res;
}

function fileStatus(c: string): CodeFileStatus {
  switch (c) {
    case 'A':
    case 'C':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'T':
      return 'T';
    default:
      return 'M'; // M, U и всё незнакомое
  }
}

/** `git diff --name-status -z -M`: `S\0path\0`, переименование/копия — `R100\0from\0to\0`. */
export function parseNameStatus(out: string): CodeFile[] {
  const parts = out.split('\0');
  const res: CodeFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!;
    if (!s) continue;
    const c = s[0]!;
    if (c === 'R' || c === 'C') {
      const from = parts[i + 1];
      const to = parts[i + 2];
      i += 2;
      if (from && to) res.push({ path: to, status: fileStatus(c), from });
    } else {
      const p = parts[i + 1];
      i += 1;
      if (p) res.push({ path: p, status: fileStatus(c) });
    }
  }
  return res;
}

/** Дописать ± и признак бинарного из `--numstat -z`. */
export function withNumstat(files: CodeFile[], numstat: string): CodeFile[] {
  const stat = parseNumstat(numstat);
  return files.map((f) => {
    const n = stat.get(f.path);
    if (!n) return f;
    return n.binary ? { ...f, binary: true } : { ...f, add: n.add ?? 0, del: n.del ?? 0 };
  });
}

export interface StatusEntry {
  path: string;
  from?: string;
  status: CodeFileStatus;
  untracked: boolean;
}

/** `git status --porcelain=v1 -z -uall`: `XY path\0`, переименование/копия — `XY to\0from\0`. Игнорируемые (`!!`) пропускаются. */
export function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const res: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    if (rec.length < 4 || rec[2] !== ' ') continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const p = rec.slice(3);
    if (x === '!' && y === '!') continue;
    if (x === '?' && y === '?') {
      res.push({ path: p, status: 'A', untracked: true });
      continue;
    }
    let from: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      from = parts[i + 1] || undefined;
      i += 1;
    }
    let status: CodeFileStatus;
    if (x === 'A') status = 'A';
    else if (x === 'R' || y === 'R') status = 'R';
    else if (x === 'D' || y === 'D') status = 'D';
    else status = fileStatus(y !== ' ' ? y : x);
    res.push({ path: p, ...(from ? { from } : {}), status, untracked: false });
  }
  return res;
}

/** Строки текста: пустой — 0, без завершающего перевода строки последняя строка тоже считается. */
export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/** Патч неотслеживаемого файла из его содержимого: все строки `+` (без `git diff --no-index`). */
export function untrackedPatch(filePath: string, text: string): FilePatch {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  if (lines.length === 0) return { binary: false, hunks: [], truncated: false };
  const head = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
  return parsePatch(head + lines.map((l) => `+${l}`).join('\n') + '\n');
}

/** Пути (абсолютные) файлов, которые правили инструменты в событиях истории; относительные — от `cwd` чата. */
export function editedPaths(events: readonly HistoryTool[], cwd: string): string[] {
  const res = new Set<string>();
  for (const e of events) {
    if (e.type !== 'tool.start' || !e.name || !e.input || !EDIT_TOOLS.has(e.name)) continue;
    const p = e.input.file_path ?? e.input.notebook_path;
    if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) continue;
    res.add(path.resolve(cwd, p));
  }
  return [...res];
}

/** Только то, что сборщик читает из событий истории (`AgentEvent` подходит как есть). */
export interface HistoryTool {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}

// ---------- сборщик ----------

/** Чат группы задачи, как его знает вкладка. */
export interface CodeChatInfo {
  id: string;
  provider?: AgentProvider;
  title: string;
  /** Рабочая папка чата; нет — папка вкладки. */
  cwd?: string;
  /** Мс последней активности: история чата с тем же значением берётся из кэша `TaskCode`. */
  updatedAt?: number;
}

export interface CodeCollectDeps {
  /** stdout `git <args>` в `cwd`; ошибка git — исключение. */
  run(args: string[], cwd: string): Promise<string>;
  /** Корни репозиториев рабочей папки; git недоступен — исключение с текстом причины. */
  repos(cwd: string): Promise<string[]>;
  /** События истории чата (нужны только `tool.start`); ошибка — исключение. */
  history(chat: CodeChatInfo, cwd: string): Promise<readonly HistoryTool[]>;
  /** Текст файла; бинарный — `binary`; большой/нечитаемый — `undefined`. */
  readText(abs: string): Promise<{ text: string } | { binary: true } | undefined>;
}

export interface CodeCollectInput {
  /** Ключ задачи в Jira, `GARM-87`. */
  key: string;
  /** Рабочая папка вкладки: для чатов без своей. */
  cwd: string | undefined;
  chats: readonly CodeChatInfo[];
}

function errText(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | undefined;
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  const msg = stderr || (typeof err?.message === 'string' ? err.message : String(e));
  return msg.split('\n')[0]!.slice(0, 300);
}

/** База репозитория: `origin/HEAD`, иначе первая существующая из `BASE_CANDIDATES`; нет — `undefined`. */
export async function detectBase(run: CodeCollectDeps['run'], root: string): Promise<string | undefined> {
  try {
    const head = (await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root)).trim();
    if (head) return head;
  } catch {
    /* нет origin/HEAD — перебор ниже */
  }
  for (const ref of BASE_CANDIDATES) {
    try {
      if ((await run(['rev-parse', '--verify', '--quiet', ref], root)).trim()) return ref;
    } catch {
      /* ref нет */
    }
  }
  return undefined;
}

function toCommit(c: RawCommit, src: CodeCommit['src'], branch?: string): CodeCommit {
  return {
    sha: c.sha,
    short: c.short,
    subject: c.subject,
    author: c.author,
    at: c.at * 1000,
    src,
    ...(branch ? { branch } : {}),
  };
}

async function collectRepo(
  deps: CodeCollectDeps,
  root: string,
  key: string,
  edits: () => Promise<Map<string, CodeChat[]>>,
): Promise<CodeRepo> {
  const run = (args: string[]): Promise<string> => deps.run(args, root);
  const base = await detectBase(deps.run, root);
  const grep = keyPattern(key);

  const byKey = parseLog(
    await run(['log', '--all', '-i', '-E', `--grep=${grep}`, '-n', String(LOG_LIMIT), `--format=${LOG_FORMAT}`]),
  );
  const commits = new Map<string, CodeCommit>();
  for (const c of byKey) commits.set(c.sha, toCommit(c, 'key'));

  const names = branchesOf(await run(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']), key);
  const branches: CodeBranch[] = [];
  for (const name of names) {
    if (!base) {
      branches.push({ name, ahead: 0, add: 0, del: 0, files: [] });
      continue;
    }
    if (name === base) continue;
    try {
      const raw = parseLog(await run(['log', `${base}..${name}`, '-n', String(LOG_LIMIT), `--format=${LOG_FORMAT}`]));
      for (const c of raw) if (!commits.has(c.sha)) commits.set(c.sha, toCommit(c, 'branch', name));
      const range = `${base}...${name}`;
      const [numstat, nameStatus] = await Promise.all([
        run(['diff', '--numstat', '-z', '-M', range]),
        run(['diff', '--name-status', '-z', '-M', range]),
      ]);
      const files = withNumstat(parseNameStatus(nameStatus), numstat);
      let add = 0;
      let del = 0;
      for (const f of files) {
        add += f.add ?? 0;
        del += f.del ?? 0;
      }
      branches.push({ name, ahead: raw.length, add, del, files });
    } catch {
      // ветка без общей базы или битый ref: показываем имя, без итога
      branches.push({ name, ahead: 0, add: 0, del: 0, files: [] });
    }
  }

  const shas = [...commits.keys()];
  if (shas.length > 0) {
    // «↑ локально»: коммита нет ни в одной удалённой ветке (rev-list берёт и предков — пересекаем со своими).
    // Без remote пометка бессмысленна, а rev-list выдал бы всю историю — пропускаем.
    try {
      if (!(await run(['remote'])).trim()) throw new Error('no remotes');
      const out = await run(['rev-list', ...shas, '--not', '--remotes']);
      const local = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
      for (const sha of shas) if (local.has(sha)) commits.get(sha)!.unpushed = true;
    } catch {
      /* без пометки */
    }
    if (base) {
      try {
        const out = await run(['log', base, '-i', '-E', `--grep=${grep}`, '-n', String(LOG_LIMIT), '--format=%H']);
        const inBase = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
        for (const sha of shas) if (inBase.has(sha)) commits.get(sha)!.inBase = true;
      } catch {
        /* без пометки */
      }
    }
  }

  return {
    root,
    name: path.basename(root),
    ...(base ? { base } : {}),
    branches,
    commits: [...commits.values()].sort((a, b) => b.at - a.at),
    dirty: await collectDirty(deps, root, edits),
  };
}

/** Незакоммиченное ∩ правки агентов группы. */
async function collectDirty(
  deps: CodeCollectDeps,
  root: string,
  edits: () => Promise<Map<string, CodeChat[]>>,
): Promise<CodeDirty[]> {
  const status = parseStatus(await deps.run(['status', '--porcelain=v1', '-z', '-uall'], root));
  if (status.length === 0) return [];
  const edited = await edits();
  if (edited.size === 0) return [];
  const mine: { entry: StatusEntry; chats: CodeChat[] }[] = [];
  for (const entry of status) {
    const chats = new Map<string, CodeChat>();
    for (const p of [entry.path, entry.from]) {
      if (!p) continue;
      for (const c of edited.get(path.join(root, p)) ?? []) chats.set(c.id, c);
    }
    if (chats.size > 0) mine.push({ entry, chats: [...chats.values()] });
  }
  if (mine.length === 0) return [];

  let stat = new Map<string, { add?: number; del?: number; binary?: boolean }>();
  if (mine.some((m) => !m.entry.untracked)) {
    try {
      stat = parseNumstat(await deps.run(['diff', '--numstat', '-z', '-M', 'HEAD'], root));
    } catch {
      /* нет HEAD (пустой репозиторий) — без ± */
    }
  }
  const res: CodeDirty[] = [];
  for (const { entry, chats } of mine) {
    const f: CodeDirty = {
      path: entry.path,
      status: entry.status,
      ...(entry.from ? { from: entry.from } : {}),
      chats,
    };
    if (entry.untracked) {
      const t = await deps.readText(path.join(root, entry.path)).catch(() => undefined);
      if (t && 'binary' in t) f.binary = true;
      else if (t) {
        f.add = countTextLines(t.text);
        f.del = 0;
      }
    } else {
      const n = stat.get(entry.path);
      if (n?.binary) f.binary = true;
      else if (n) {
        f.add = n.add ?? 0;
        f.del = n.del ?? 0;
      }
    }
    res.push(f);
  }
  return res.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Всё по задаче: репозитории рабочих папок чатов группы (дедуп по корню), в каждом — коммиты по ключу и по веткам,
 * итог веток, правки агентов. Ошибка одного репозитория — `CodeRepo.error`, остальные остаются; нет ни одного
 * репозитория и git недоступен — `error`.
 */
export async function collectCode(
  deps: CodeCollectDeps,
  input: CodeCollectInput,
): Promise<{ repos: CodeRepo[]; error?: string }> {
  if (!isIssueKey(input.key)) return { repos: [], error: 'Bad task key' };
  const cwdOf = (c: CodeChatInfo): string | undefined => c.cwd ?? input.cwd;
  const cwds = new Set<string>();
  for (const c of input.chats) {
    const cwd = cwdOf(c);
    if (cwd) cwds.add(cwd);
  }
  if (cwds.size === 0 && input.cwd) cwds.add(input.cwd);

  const roots: string[] = [];
  const errors: string[] = [];
  for (const cwd of cwds) {
    try {
      for (const r of await deps.repos(cwd)) if (!roots.includes(r)) roots.push(r);
    } catch (e) {
      errors.push(errText(e));
    }
  }

  // история чатов читается один раз и только если есть что пересекать
  let edits: Promise<Map<string, CodeChat[]>> | undefined;
  const getEdits = (): Promise<Map<string, CodeChat[]>> =>
    (edits ??= (async () => {
      const map = new Map<string, CodeChat[]>();
      await Promise.all(
        input.chats.map(async (c) => {
          const cwd = cwdOf(c);
          if (!cwd) return;
          let events: readonly HistoryTool[];
          try {
            events = await deps.history(c, cwd);
          } catch {
            return; // историю чата не прочитали — его правок нет
          }
          const chat: CodeChat = { id: c.id, ...(c.provider ? { provider: c.provider } : {}), title: c.title };
          for (const p of editedPaths(events, cwd)) {
            const list = map.get(p) ?? [];
            if (!list.some((x) => x.id === c.id)) list.push(chat);
            map.set(p, list);
          }
        }),
      );
      return map;
    })());

  const repos: CodeRepo[] = [];
  for (const root of roots) {
    try {
      repos.push(await collectRepo(deps, root, input.key, getEdits));
    } catch (e) {
      repos.push({ root, name: path.basename(root), branches: [], commits: [], dirty: [], error: errText(e) });
    }
  }
  return roots.length === 0 && errors.length > 0 ? { repos, error: errors[0]! } : { repos };
}

/** Файлы коммита: против первого родителя, корневой — против пустого дерева. */
export async function commitFiles(run: CodeCollectDeps['run'], root: string, sha: string): Promise<CodeFile[]> {
  const hasParent = await run(['rev-parse', '--verify', '--quiet', `${sha}^`], root).then(
    (o) => o.trim().length > 0,
    () => false,
  );
  const args = hasParent
    ? (mode: string): string[] => ['diff', mode, '-z', '-M', `${sha}^`, sha]
    : (mode: string): string[] => ['diff-tree', '--root', '-r', '--no-commit-id', mode, '-z', '-M', sha];
  const [nameStatus, numstat] = await Promise.all([run(args('--name-status'), root), run(args('--numstat'), root)]);
  return withNumstat(parseNameStatus(nameStatus), numstat);
}

/** Патч одного файла по цели диффа; неотслеживаемый файл — из содержимого. */
export async function codePatch(
  deps: Pick<CodeCollectDeps, 'run' | 'readText'>,
  root: string,
  target: CodeDiffTarget,
): Promise<FilePatch> {
  const git = (args: string[]): Promise<string> => deps.run(args, root);
  const DIFF = ['diff', '--no-color', '--no-ext-diff'];
  if (target.kind === 'branch') {
    return parsePatch(await git([...DIFF, '-M', `${target.base}...${target.branch}`, '--', target.path]));
  }
  if (target.kind === 'commit') {
    const hasParent = await git(['rev-parse', '--verify', '--quiet', `${target.sha}^`]).then(
      (o) => o.trim().length > 0,
      () => false,
    );
    if (!hasParent) {
      return parsePatch(
        await git(['diff-tree', '-p', '--no-color', '--no-ext-diff', '--root', '-M', target.sha, '--', target.path]),
      );
    }
    return parsePatch(await git([...DIFF, '-M', `${target.sha}^`, target.sha, '--', target.path]));
  }
  // wip: сначала неотслеживаемый — `git diff HEAD` про него молчит
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', target.path]).then(
    (o) => o.split('\0').includes(target.path),
    () => false,
  );
  if (untracked) {
    const t = await deps.readText(path.join(root, target.path));
    // большой или нечитаемый — как обрезанный патч без строк: webview покажет свою надпись
    if (!t) return { binary: false, hunks: [], truncated: true };
    if ('binary' in t) return { binary: true, hunks: [], truncated: false };
    return untrackedPatch(target.path, t.text);
  }
  return parsePatch(await git([...DIFF, 'HEAD', '--', target.path]));
}

/** Текст файла для `CodeCollectDeps.readText`: до 1 МБ; NUL в начале — бинарный; больше или не файл — `undefined`. */
export async function readTextFile(abs: string): Promise<{ text: string } | { binary: true } | undefined> {
  const st = await stat(abs);
  if (!st.isFile() || st.size > 1024 * 1024) return undefined;
  const buf = await readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true };
  return { text: buf.toString('utf8') };
}

// ---------- состояние вкладки ----------

export interface TaskCodeDeps extends CodeCollectDeps {
  /** Рабочая папка вкладки. */
  cwd(): string | undefined;
  /** Чаты группы задачи (новые сверху), как их знает список сессий. */
  chats(taskKey: string): Promise<CodeChatInfo[]>;
  post(m: TaskCodeStateMessage | TaskCodeCommitMessage | TaskCodeDiffMessage): void;
  /** Вставить текст в поле ввода (не отправляя). */
  prefill(text: string): void;
  /** Скопировать текст в буфер обмена. */
  copy(text: string): void;
}

/** Задача вкладки без экземпляра Jira: `jira:inst:GARM-87` → `GARM-87`. */
function issueKeyOf(taskKey: string): string | undefined {
  const key = taskKey.split(':').pop();
  return key && isIssueKey(key) ? key.toUpperCase() : undefined;
}

/**
 * Состояние вкладки «код» одного `TaskTab`: последний итог (его корни — единственные, которые принимают
 * `task.code.commit` и `task.code.diff`), устаревшие загрузки отсекаются счётчиком.
 */
export class TaskCode {
  /** Номер загрузки: устаревшая не затирает свежую. */
  private gen = 0;
  /** Меняется только со сменой задачи: ответы на commit/diff пережили перезагрузку списка, но не смену задачи. */
  private epoch = 0;
  private last: TaskCodeStateMessage | undefined;
  /** Правки из истории чата по `id` + `updatedAt`: тихая перезагрузка после каждого хода не перечитывает транскрипты. */
  private readonly edits = new Map<string, { at: number; events: readonly HistoryTool[] }>();
  private readonly collectDeps: CodeCollectDeps;

  constructor(private readonly deps: TaskCodeDeps) {
    this.collectDeps = {
      run: deps.run,
      repos: deps.repos,
      readText: deps.readText,
      history: async (chat, cwd) => {
        const hit = this.edits.get(chat.id);
        if (hit && chat.updatedAt !== undefined && hit.at === chat.updatedAt) return hit.events;
        const events = (await deps.history(chat, cwd)).filter((e) => e.type === 'tool.start' && !!e.name && EDIT_TOOLS.has(e.name));
        if (chat.updatedAt !== undefined) this.edits.set(chat.id, { at: chat.updatedAt, events });
        return events;
      },
    };
  }

  /** Загружалась ли вкладка «код» для этой задачи. */
  loaded(taskKey: string): boolean {
    return this.last?.taskKey === taskKey && !this.last.loading;
  }

  /** Сменилась задача вкладки или вкладка закрыта: итог и летящая загрузка не нужны. */
  reset(): void {
    this.gen++;
    this.epoch++;
    this.last = undefined;
    this.edits.clear();
  }

  handle(taskKey: string, m: TaskCodeRequest): void {
    switch (m.type) {
      case 'task.code.load':
        void this.load(taskKey, m.force === true, false);
        break;
      case 'task.code.commit':
        void this.commit(taskKey, m.root, m.sha);
        break;
      case 'task.code.diff':
        void this.diff(taskKey, m.req, m.root, m.target);
        break;
      case 'task.code.prefill':
        this.deps.prefill(m.text);
        break;
      case 'task.code.copy':
        this.deps.copy(m.text);
        break;
    }
  }

  /** После `turn.result`: тихая перезагрузка, если вкладка «код» уже загружалась. */
  refresh(taskKey: string): void {
    if (this.loaded(taskKey)) void this.load(taskKey, true, true);
  }

  private async load(taskKey: string, force: boolean, quiet: boolean): Promise<void> {
    const cached = this.last;
    if (!force && cached?.taskKey === taskKey && !cached.loading) {
      this.deps.post(cached);
      return;
    }
    const gen = ++this.gen;
    const prev = cached?.taskKey === taskKey ? cached.repos : [];
    if (!quiet) {
      // roots остаются доступными, пока идёт перезагрузка
      this.last = { type: 'task.code.state', taskKey, loading: true, repos: prev };
      this.deps.post(this.last);
    }
    const key = issueKeyOf(taskKey);
    let msg: TaskCodeStateMessage;
    if (!key) {
      msg = { type: 'task.code.state', taskKey, error: 'Bad task key', repos: [] };
    } else {
      try {
        const chats = await this.deps.chats(taskKey);
        const res = await collectCode(this.collectDeps, { key, cwd: this.deps.cwd(), chats });
        msg = { type: 'task.code.state', taskKey, ...(res.error ? { error: res.error } : {}), repos: res.repos };
      } catch (e) {
        msg = { type: 'task.code.state', taskKey, error: errText(e), repos: prev };
      }
    }
    if (gen !== this.gen) return;
    this.last = msg;
    this.deps.post(msg);
  }

  private repoOf(taskKey: string, root: string): CodeRepo | undefined {
    return this.last?.taskKey === taskKey ? this.last.repos.find((r) => r.root === root) : undefined;
  }

  private async commit(taskKey: string, root: string, sha: string): Promise<void> {
    if (!this.repoOf(taskKey, root)) return;
    const gen = this.epoch;
    try {
      const files = await commitFiles(this.deps.run, root, sha);
      if (gen === this.epoch) this.deps.post({ type: 'task.code.commit', root, sha, files });
    } catch (e) {
      if (gen === this.epoch) this.deps.post({ type: 'task.code.commit', root, sha, files: [], error: errText(e) });
    }
  }

  private async diff(taskKey: string, req: number, root: string, target: CodeDiffTarget): Promise<void> {
    const repo = this.repoOf(taskKey, root);
    if (!repo || !isCodeDiffTarget(target)) return;
    // ветка и база — только из последнего итога этого репо, не произвольные ref'ы из webview
    if (target.kind === 'branch' && (target.base !== repo.base || !repo.branches.some((b) => b.name === target.branch))) return;
    const gen = this.epoch;
    try {
      const patch = await codePatch(this.deps, root, target);
      if (gen === this.epoch) this.deps.post({ type: 'task.code.diff', req, patch });
    } catch (e) {
      if (gen === this.epoch) this.deps.post({ type: 'task.code.diff', req, error: errText(e) });
    }
  }
}
