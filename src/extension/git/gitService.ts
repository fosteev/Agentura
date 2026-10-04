import { execFile } from 'node:child_process';
import { open as openFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { API, Change, Commit, Ref, Repository, Status } from './git';
import type { GitApiResult } from './gitApi';
import { pathKey, samePath } from '../pathKey';
import { hostStrings, type HostUi, type Lang } from '../../shared/l10n';
import {
  GIT_STATUS,
  gitStatus,
  type GitBusy,
  type GitCommitResult,
  type GitCommitView,
  type GitFileView,
  type GitNotice,
  type GitOp,
  type GitRepoView,
  type GitRequest,
  type GitSnapshot,
} from '../../shared/git';

/** `GIT_STATUS` против `const enum Status` из `git.d.ts`: значение разъедется — тип не сойдётся. */
type StatusCheck = {
  [K in keyof typeof GIT_STATUS]: (typeof Status)[K] extends (typeof GIT_STATUS)[K] ? true : never;
};
export const STATUS_CHECK: StatusCheck = {
  INDEX_MODIFIED: true,
  INDEX_ADDED: true,
  INDEX_DELETED: true,
  INDEX_RENAMED: true,
  INDEX_COPIED: true,
  MODIFIED: true,
  DELETED: true,
  UNTRACKED: true,
  IGNORED: true,
  INTENT_TO_ADD: true,
  INTENT_TO_RENAME: true,
  TYPE_CHANGED: true,
  ADDED_BY_US: true,
  ADDED_BY_THEM: true,
  DELETED_BY_US: true,
  DELETED_BY_THEM: true,
  BOTH_ADDED: true,
  BOTH_DELETED: true,
  BOTH_MODIFIED: true,
};

/** `RefType` из `git.d.ts` (`const enum`). */
const REF_HEAD = 0;
const REF_REMOTE = 1;

/** Дебаунс снимка после событий git. */
const DEBOUNCE_MS = 300;
/** Последних коммитов в снимке. */
const LOG_ENTRIES = 5;
/** Неотслеживаемый файл больше — без цифр +/−. */
const MAX_COUNT_BYTES = 1024 * 1024;

/** Пункт QuickPick; `separator` — заголовок группы. */
export interface GitPickItem {
  label: string;
  description?: string;
  separator?: boolean;
}

/** Всё, что вкладка «git» делает руками VS Code, — отдельно, чтобы сервис тестировался без окна. */
export interface GitUi {
  /** Модальное предупреждение; `true` — нажата `action`. */
  confirm(message: string, detail: string | undefined, action: string): Promise<boolean>;
  pick<T extends GitPickItem>(items: T[], placeholder: string): Promise<T | undefined>;
  input(
    prompt: string,
    validate: (value: string) => string | undefined,
  ): Promise<string | undefined>;
  diff(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void>;
  open(uri: vscode.Uri): Promise<void>;
  /** Пустой документ для стороны диффа удалённого файла. */
  empty(name: string): vscode.Uri;
}

export type LineCount = { lines: number } | { binary: true } | undefined;

export interface GitDeps {
  loadApi(): Promise<GitApiResult>;
  ui: GitUi;
  lang(): Lang;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** stdout `git <args>` в `cwd` бинарником `gitPath`. */
  run(gitPath: string, args: string[], cwd: string): Promise<string>;
  /** Строки неотслеживаемого файла: бинарный — `binary`; большой или нечитаемый — `undefined`. */
  countLines(file: string): Promise<LineCount>;
  /** Дебаунс, мс (тесты — 0). */
  debounceMs?: number;
}

/** Панель чата, подписанная на вкладку «git». */
export interface GitClient {
  /** Прислать текущий снимок этой панели (`ready`). */
  refresh(): void;
  handle(m: GitRequest): Promise<void>;
  dispose(): void;
}

interface Client {
  cwd: string;
  post(m: GitNotice): void;
  /** Вкладка «git» открыта в панели — считать +/− и лог. */
  watch: boolean;
}

interface Numstat {
  add?: number;
  del?: number;
  binary?: boolean;
}

/**
 * `git diff --numstat -z`: `add\tdel\tpath\0`; переименование — `add\tdel\t\0from\0to\0`; бинарный — `-\t-`.
 * Ключ — путь (новый для переименования) от корня репозитория.
 */
export function parseNumstat(out: string): Map<string, Numstat> {
  const res = new Map<string, Numstat>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]!);
    if (!m) continue;
    let file = m[3]!;
    if (file === '') {
      // переименование: дальше два поля — старый и новый путь
      file = parts[i + 2] ?? '';
      i += 2;
    }
    if (!file) continue;
    res.set(file, m[1] === '-' ? { binary: true } : { add: Number(m[1]), del: Number(m[2]) });
  }
  return res;
}

/** Путь от `from` до `to` через `/`; совпадают — `''`. */
function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

/** Внутри корня (не сам корень и не снаружи). */
function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Корень содержит `p` или совпадает с ним. */
function within(root: string, p: string): boolean {
  return samePath(root, p) || inside(root, p);
}

/** Текст ошибки git: stderr (у `GitError` встроенного git), иначе сообщение. */
export function gitErrorText(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | undefined;
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  const msg = stderr || (typeof err?.message === 'string' ? err.message : String(e));
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg;
}

/** Первая строка сообщения коммита. */
function subject(c: Commit): string {
  return c.message.split('\n', 1)[0]!.trim();
}

/**
 * Вкладка «git» (roadmap 12, этап 1): один сервис на окно над API встроенного `vscode.git`. Панели чата
 * подписываются (`attach`) со своим cwd и получают `git.state` на каждое изменение (дебаунс). Снимок без
 * цифр +/− строится из `repository.state` и уходит всегда — для бейджа; +/− и лог читаются, только пока
 * вкладка открыта хоть в одной панели этого cwd (`git.watch`).
 */
export class GitService implements vscode.Disposable {
  private api: API | undefined;
  /** Почему git недоступен (текст для вкладки). */
  private unavailable: string | undefined;
  private loading: Promise<void> | undefined;
  private readonly clients = new Set<Client>();
  /** Идущая операция по ключу корня (`pathKey`). */
  private readonly busy = new Map<string, GitBusy>();
  private readonly repoSubs = new Map<Repository, vscode.Disposable>();
  private apiSubs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private again = false;
  private disposed = false;

  constructor(private readonly deps: GitDeps) {}

  private get t(): HostUi {
    return hostStrings(this.deps.lang());
  }

  /** Подписать панель чата; API git грузится при первой подписке. */
  attach(cwd: string, post: (m: GitNotice) => void): GitClient {
    const client: Client = { cwd, post, watch: false };
    this.clients.add(client);
    this.ensure();
    return {
      refresh: () => void this.postTo([client]),
      handle: (m) => this.handle(client, m),
      dispose: () => {
        this.clients.delete(client);
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.reset();
    this.clients.clear();
  }

  // ---------- API и подписки ----------

  private ensure(): void {
    this.loading ??= this.load();
  }

  private async load(): Promise<void> {
    const res = await this.deps.loadApi();
    if (this.disposed) return;
    if ('api' in res) {
      this.unavailable = undefined;
      this.setApi(res.api);
    } else {
      const t = this.t;
      this.unavailable =
        res.reason === 'missing'
          ? t.gitMissing
          : res.reason === 'disabled'
            ? t.gitDisabled
            : t.gitFailed(res.message ?? '');
      this.deps.log.warn(`git: ${this.unavailable}`);
      // выключили настройкой — включат, перечитать
      if (res.extension) {
        this.apiSubs.push(
          res.extension.onDidChangeEnablement((on) => {
            if (!on) return;
            this.reset();
            this.loading = this.load();
          }),
        );
      }
    }
    this.schedule(0);
  }

  private setApi(api: API): void {
    this.api = api;
    for (const r of api.repositories) this.watchRepo(r);
    this.apiSubs.push(
      api.onDidOpenRepository((r) => {
        this.watchRepo(r);
        this.schedule();
      }),
      api.onDidCloseRepository((r) => {
        this.repoSubs.get(r)?.dispose();
        this.repoSubs.delete(r);
        this.schedule();
      }),
      api.onDidChangeState(() => this.schedule()),
    );
  }

  private watchRepo(r: Repository): void {
    if (this.repoSubs.has(r)) return;
    this.repoSubs.set(
      r,
      r.state.onDidChange(() => this.schedule()),
    );
  }

  private reset(): void {
    for (const d of this.apiSubs) d.dispose();
    this.apiSubs = [];
    for (const d of this.repoSubs.values()) d.dispose();
    this.repoSubs.clear();
    this.api = undefined;
    this.unavailable = undefined;
  }

  // ---------- снимок ----------

  /**
   * Репозитории панели: самый глубокий, внутри которого лежит cwd (внешние — домашний `~` с dotfiles — нет),
   * и все, чей корень внутри cwd. Корень cwd первым, остальные по пути.
   */
  reposFor(cwd: string): Repository[] {
    const all = this.api?.repositories ?? [];
    const outer = all
      .filter((r) => within(r.rootUri.fsPath, cwd))
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    const nested = all
      .filter((r) => inside(cwd, r.rootUri.fsPath))
      .sort((a, b) => a.rootUri.fsPath.localeCompare(b.rootUri.fsPath));
    return outer ? [outer, ...nested] : nested;
  }

  private findRepo(client: Client, root: string): Repository | undefined {
    return this.reposFor(client.cwd).find((r) => samePath(r.rootUri.fsPath, root));
  }

  /** `undefined` — API ещё не готов (не слать ничего, чтобы не мигнуло «репозиториев нет»). */
  async snapshot(cwd: string, full: boolean): Promise<GitSnapshot | undefined> {
    if (this.unavailable !== undefined)
      return { state: 'unavailable', reason: this.unavailable, repos: [] };
    const api = this.api;
    if (!api || api.state !== 'initialized') return undefined;
    const repos = this.reposFor(cwd);
    if (repos.length === 0) return { state: 'none', repos: [] };
    return {
      state: 'ok',
      repos: await Promise.all(repos.map((r) => this.view(api, r, cwd, full))),
    };
  }

  private async view(api: API, repo: Repository, cwd: string, full: boolean): Promise<GitRepoView> {
    const root = repo.rootUri.fsPath;
    const s = repo.state;
    const head = s.HEAD;
    const detached = !!head && !head.name && !!head.commit;
    const v: GitRepoView = {
      root,
      rel: relPosix(cwd, root),
      name: path.basename(root),
      published: detached || !!head?.upstream,
      unstaged: [],
      staged: [],
      log: [],
    };
    const branch = head?.name ?? head?.commit?.slice(0, 7);
    if (branch) v.branch = branch;
    if (detached) v.detached = true;
    if (head?.upstream) {
      v.upstream = `${head.upstream.remote}/${head.upstream.name}`;
      v.ahead = head.ahead ?? 0;
      v.behind = head.behind ?? 0;
    }
    if (s.mergeChanges.length > 0) v.op = 'merge';
    else if (s.rebaseCommit) v.op = 'rebase';
    const busy = this.busy.get(pathKey(root));
    if (busy) v.busy = busy;

    // вне индекса: конфликты, изменения, неотслеживаемые (`git.untrackedChanges: separate` — отдельным списком)
    const seen = new Set<string>();
    for (const c of [...s.mergeChanges, ...s.workingTreeChanges, ...s.untrackedChanges]) {
      const f = this.file(root, c);
      if (!f || seen.has(f.path)) continue;
      seen.add(f.path);
      v.unstaged.push(f);
    }
    for (const c of s.indexChanges) {
      const f = this.file(root, c);
      if (f) v.staged.push(f);
    }
    if (full) await this.fill(api, repo, v);
    return v;
  }

  private file(root: string, c: Change): GitFileView | undefined {
    const status = gitStatus(c.status);
    if (!status) return undefined;
    const f: GitFileView = { path: relPosix(root, c.uri.fsPath), status };
    if (status === 'R' && c.renameUri) {
      f.path = relPosix(root, c.renameUri.fsPath);
      f.from = relPosix(root, c.originalUri.fsPath);
    }
    return f;
  }

  /** +/− (`numstat` индекса и рабочего дерева, строки неотслеживаемых) и лог; ошибка — в журнал, снимок идёт без них. */
  private async fill(api: API, repo: Repository, v: GitRepoView): Promise<void> {
    const root = v.root;
    const numstat = async (cached: boolean): Promise<Map<string, Numstat>> => {
      try {
        const args = [
          '--no-optional-locks',
          'diff',
          '--numstat',
          '-z',
          ...(cached ? ['--cached'] : []),
        ];
        return parseNumstat(await this.deps.run(api.git.path, args, root));
      } catch (e) {
        this.deps.log.warn(`git numstat ${root}: ${gitErrorText(e)}`);
        return new Map();
      }
    };
    const [work, index, log] = await Promise.all([
      v.unstaged.length ? numstat(false) : new Map<string, Numstat>(),
      v.staged.length ? numstat(true) : new Map<string, Numstat>(),
      repo.log({ maxEntries: LOG_ENTRIES }).catch((e: unknown) => {
        // ветка без коммитов — `git log` падает, это не ошибка
        if (repo.state.HEAD?.commit) this.deps.log.warn(`git log ${root}: ${gitErrorText(e)}`);
        return [] as Commit[];
      }),
    ]);
    const apply = (f: GitFileView, n: Numstat | undefined): void => {
      if (!n) return;
      if (n.binary) f.binary = true;
      else {
        f.add = n.add;
        f.del = n.del;
      }
    };
    for (const f of v.staged) apply(f, index.get(f.path));
    await Promise.all(
      v.unstaged.map(async (f) => {
        const n = work.get(f.path);
        if (n || f.status !== 'U') return apply(f, n);
        const lines = await this.deps.countLines(path.join(root, f.path)).catch(() => undefined);
        if (!lines) return;
        if ('binary' in lines) f.binary = true;
        else {
          f.add = lines.lines;
          f.del = 0;
        }
      }),
    );
    const ahead = v.ahead ?? 0;
    v.log = log.map((c, i): GitCommitView => ({
      hash: c.hash.slice(0, 7),
      subject: subject(c),
      at: (c.commitDate ?? c.authorDate)?.getTime() ?? 0,
      unpushed: i < ahead,
    }));
  }

  /** Снимок через `ms` (дебаунс); идущий расчёт не прерывается — по окончании ещё один. */
  private schedule(ms = this.deps.debounceMs ?? DEBOUNCE_MS): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = true;
    try {
      await this.postTo([...this.clients]);
    } catch (e) {
      this.deps.log.error(`git: снимок не собран: ${String(e)}`);
    } finally {
      this.flushing = false;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    }
  }

  /** Снимок по cwd (с цифрами, если вкладку держит хоть одна панель этого cwd) — каждой панели. */
  private async postTo(clients: Client[]): Promise<void> {
    await this.loading;
    const groups = new Map<string, Client[]>();
    for (const c of clients) {
      const k = pathKey(c.cwd);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    for (const [k, group] of groups) {
      const full = [...this.clients].some((c) => c.watch && pathKey(c.cwd) === k);
      const snapshot = await this.snapshot(group[0]!.cwd, full);
      if (!snapshot || this.disposed) continue;
      for (const c of group) if (this.clients.has(c)) c.post({ type: 'git.state', snapshot });
    }
  }

  // ---------- действия ----------

  private fail(client: Client, op: GitOp, root: string | undefined, e: unknown): void {
    const message = gitErrorText(e);
    this.deps.log.error(`git ${op}${root ? ` ${root}` : ''}: ${message}`);
    client.post({ type: 'git.error', ...(root ? { root } : {}), op, message });
  }

  /** Операция с `busy` в снимке: кнопки гаснут сразу, после — свежий снимок. */
  private async withBusy<T>(repo: Repository, busy: GitBusy, fn: () => Promise<T>): Promise<T> {
    const key = pathKey(repo.rootUri.fsPath);
    this.busy.set(key, busy);
    this.schedule(0);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
      this.schedule();
    }
  }

  /** Абсолютные пути файлов запроса; хоть один вне репозитория — `undefined`. */
  private paths(root: string, paths: string[]): string[] | undefined {
    const abs = paths.map((p) => path.resolve(root, p));
    return abs.length > 0 && abs.every((p) => inside(root, p)) ? abs : undefined;
  }

  private async handle(client: Client, m: GitRequest): Promise<void> {
    await this.loading;
    if (m.type === 'git.watch') {
      const was = client.watch;
      client.watch = m.on;
      if (m.on && !was) this.schedule(0);
      return;
    }
    if (m.type === 'git.commit') return this.commit(client, m);
    if (m.type === 'git.sync') return this.sync(client, m.op, m.root);
    const repo = this.findRepo(client, m.root);
    const op: GitOp = m.type.slice(4) as GitOp;
    if (!repo) return this.fail(client, op, m.root, new Error(this.t.gitUnknownRepo));
    const root = repo.rootUri.fsPath;
    if (m.type === 'git.branch') return this.branch(client, repo);
    const abs = this.paths(
      root,
      m.type === 'git.open' || m.type === 'git.openFile' ? [m.path] : m.paths,
    );
    if (!abs) return this.fail(client, op, root, new Error(this.t.gitOutside));
    try {
      switch (m.type) {
        case 'git.stage':
          await this.withBusy(repo, 'stage', () => repo.add(abs));
          return;
        case 'git.unstage':
          await this.withBusy(repo, 'unstage', () => repo.revert(abs));
          return;
        case 'git.discard':
          return await this.discard(repo, abs);
        case 'git.open':
          return await this.openDiff(repo, abs[0]!, m.staged);
        case 'git.openFile':
          return await this.deps.ui.open(vscode.Uri.file(abs[0]!));
      }
    } catch (e) {
      this.fail(client, op, root, e);
    }
  }

  /** Отмена изменений — только после модального подтверждения; неотслеживаемые удаляются. */
  private async discard(repo: Repository, abs: string[]): Promise<void> {
    const s = repo.state;
    const untracked = new Set(
      [...s.workingTreeChanges, ...s.untrackedChanges]
        .filter((c) => gitStatus(c.status) === 'U')
        .map((c) => pathKey(c.uri.fsPath)),
    );
    const fresh = abs.filter((p) => untracked.has(pathKey(p))).length;
    const tracked = abs.length - fresh;
    const t = this.t;
    const ok =
      tracked > 0
        ? await this.deps.ui.confirm(
            t.gitDiscard(tracked),
            fresh > 0 ? t.gitDiscardAlso(fresh) : undefined,
            t.gitDiscardButton,
          )
        : await this.deps.ui.confirm(t.gitDiscardUntracked(fresh), undefined, t.gitDeleteButton);
    if (!ok) return;
    await this.withBusy(repo, 'discard', () => repo.clean(abs));
  }

  private async commit(
    client: Client,
    m: Extract<GitRequest, { type: 'git.commit' }>,
  ): Promise<void> {
    const results: GitCommitResult[] = [];
    const message = m.message.trim();
    for (const root of m.roots) {
      const repo = this.findRepo(client, root);
      const reject = (error: string): void => {
        results.push({ root, ok: false, error });
        this.fail(client, 'commit', root, new Error(error));
      };
      if (!repo) {
        reject(this.t.gitUnknownRepo);
        continue;
      }
      if (!message) {
        reject(this.t.gitEmptyMessage);
        continue;
      }
      try {
        await this.withBusy(repo, 'commit', () =>
          // свою post-commit команду пользователя (`git.postCommitCommand`) не зовём: push — флагом запроса
          repo.commit(message, {
            amend: m.amend,
            ...(m.all ? { all: true } : {}),
            postCommitCommand: null,
          }),
        );
      } catch (e) {
        results.push({ root, ok: false, error: gitErrorText(e) });
        this.fail(client, 'commit', root, e);
        continue;
      }
      const res: GitCommitResult = { root, ok: true };
      if (m.push) {
        try {
          res.pushed = await this.push(repo);
        } catch (e) {
          res.pushed = false;
          res.error = gitErrorText(e);
          this.fail(client, 'push', root, e);
        }
      }
      results.push(res);
    }
    client.post({ type: 'git.commit.result', results });
  }

  /**
   * Push ветки; неопубликованная — `push(remote, branch, true)` в единственный remote или `origin`, иначе выбор.
   * `false` — выбор remote отменён.
   */
  private async push(repo: Repository): Promise<boolean> {
    const head = repo.state.HEAD;
    if (!head?.name) throw new Error(this.t.gitDetached);
    if (head.upstream) {
      await this.withBusy(repo, 'push', () => repo.push());
      return true;
    }
    const remotes = repo.state.remotes;
    if (remotes.length === 0) throw new Error(this.t.gitNoRemote);
    const remote =
      remotes.length === 1
        ? remotes[0]!.name
        : (remotes.find((r) => r.name === 'origin')?.name ??
          (
            await this.deps.ui.pick(
              remotes.map((r) => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl ?? '' })),
              this.t.gitPickRemote,
            )
          )?.label);
    if (!remote) return false;
    const branch = head.name;
    await this.withBusy(repo, 'push', () => repo.push(remote, branch, true));
    return true;
  }

  private async sync(client: Client, op: 'fetch' | 'pull' | 'push', root?: string): Promise<void> {
    let repos: Repository[];
    if (root !== undefined) {
      const repo = this.findRepo(client, root);
      if (!repo) return this.fail(client, op, root, new Error(this.t.gitUnknownRepo));
      repos = [repo];
    } else repos = this.reposFor(client.cwd);
    for (const repo of repos) {
      try {
        if (op === 'push') await this.push(repo);
        else if (op === 'pull') await this.withBusy(repo, 'pull', () => repo.pull());
        else await this.withBusy(repo, 'fetch', () => repo.fetch());
      } catch (e) {
        this.fail(client, op, repo.rootUri.fsPath, e);
      }
    }
  }

  /** QuickPick веток: «Создать ветку…», локальные, удалённые; удалённая — локальная с тем же именем и upstream. */
  private async branch(client: Client, repo: Repository): Promise<void> {
    const t = this.t;
    const root = repo.rootUri.fsPath;
    try {
      const refs = await repo.getRefs({ sort: 'committerdate' });
      const current = repo.state.HEAD?.name;
      const heads = refs.filter(
        (r): r is Ref & { name: string } => r.type === REF_HEAD && !!r.name,
      );
      const remotes = refs.filter(
        (r): r is Ref & { name: string } =>
          r.type === REF_REMOTE && !!r.name && !r.name.endsWith('/HEAD'),
      );
      type Item = GitPickItem & {
        action?: 'create' | 'checkout' | 'track';
        ref?: Ref & { name: string };
      };
      const items: Item[] = [
        { label: t.gitCreateBranch, action: 'create' },
        ...(heads.length ? [{ label: t.gitLocal, separator: true }] : []),
        ...heads.map((r): Item => ({
          label: r.name,
          description: r.name === current ? t.gitCurrent : (r.commit?.slice(0, 7) ?? ''),
          action: 'checkout',
          ref: r,
        })),
        ...(remotes.length ? [{ label: t.gitRemote, separator: true }] : []),
        ...remotes.map((r): Item => ({
          label: r.name,
          description: r.commit?.slice(0, 7) ?? '',
          action: 'track',
          ref: r,
        })),
      ];
      const picked = await this.deps.ui.pick(items, t.gitPickBranch);
      if (!picked?.action) return;
      if (picked.action === 'create') {
        const name = await this.deps.ui.input(t.gitBranchName, (v) =>
          /\s/.test(v.trim()) ? t.gitBranchInvalid : undefined,
        );
        const branch = name?.trim();
        if (!branch) return;
        await this.withBusy(repo, 'checkout', () => repo.createBranch(branch, true));
        return;
      }
      const ref = picked.ref!;
      if (picked.action === 'checkout') {
        if (ref.name !== current)
          await this.withBusy(repo, 'checkout', () => repo.checkout(ref.name));
        return;
      }
      // удалённая: `origin/feat` → локальная `feat` (есть — просто checkout), upstream — на удалённую
      const local =
        ref.remote && ref.name.startsWith(`${ref.remote}/`)
          ? ref.name.slice(ref.remote.length + 1)
          : ref.name;
      if (heads.some((h) => h.name === local)) {
        await this.withBusy(repo, 'checkout', () => repo.checkout(local));
        return;
      }
      await this.withBusy(repo, 'checkout', async () => {
        await repo.createBranch(local, true, ref.name);
        await repo.setBranchUpstream(local, ref.name);
      });
    } catch (e) {
      this.fail(client, 'branch', root, e);
    }
  }

  /**
   * Дифф как у SCM VS Code: вне индекса — индекс (`~`) ↔ файл, в индексе — `HEAD` ↔ индекс (`''`); новый — сам
   * файл; удалённый — `HEAD` (или индекс) ↔ пусто.
   */
  private async openDiff(repo: Repository, abs: string, staged: boolean): Promise<void> {
    const api = this.api!;
    const ui = this.deps.ui;
    const s = repo.state;
    const uri = vscode.Uri.file(abs);
    const name = path.basename(abs);
    const list = staged
      ? s.indexChanges
      : [...s.mergeChanges, ...s.workingTreeChanges, ...s.untrackedChanges];
    const change = list.find((c) => samePath(c.uri.fsPath, abs));
    const status = change ? gitStatus(change.status) : undefined;
    const t = this.t;
    if (!change || status === 'U' || status === 'A' || status === 'C') return ui.open(uri);
    if (status === 'D') {
      return ui.diff(
        api.toGitUri(uri, staged ? 'HEAD' : '~'),
        ui.empty(name),
        `${name} (${t.gitDeleted})`,
      );
    }
    if (staged) {
      return ui.diff(
        api.toGitUri(change.originalUri, 'HEAD'),
        api.toGitUri(uri, ''),
        `${name} (${t.gitIndex})`,
      );
    }
    return ui.diff(api.toGitUri(uri, '~'), uri, `${name} (${t.gitWorkingTree})`);
  }
}

/** `git <args>` бинарником встроенного git: stdout, ошибка — со stderr. */
export function runGit(gitPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve(String(stdout));
      },
    );
  });
}

/** Строки текстового файла < 1 МБ; NUL в начале — бинарный. */
export async function countLines(file: string): Promise<LineCount> {
  const st = await stat(file);
  if (!st.isFile() || st.size > MAX_COUNT_BYTES) return undefined;
  const fh = await openFile(file, 'r');
  try {
    const buf = await fh.readFile();
    if (buf.subarray(0, 8000).includes(0)) return { binary: true };
    if (buf.length === 0) return { lines: 0 };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return { lines: buf[buf.length - 1] === 10 ? n : n + 1 };
  } finally {
    await fh.close();
  }
}
