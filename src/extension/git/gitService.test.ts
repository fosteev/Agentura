import { beforeEach, describe, expect, it, vi } from 'vitest';

// минимальный `vscode`: только `Uri.file` (fsPath) — остальное сервис берёт из зависимостей
vi.mock('vscode', () => {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly fsPath: string,
    ) {}
    static file(p: string) {
      return new Uri('file', p);
    }
  }
  return { Uri };
});

import { GitService, parseNumstat, type GitDeps, type GitUi } from './gitService';
import { GIT_STATUS as S, type GitNotice, type GitSnapshot } from '../../shared/git';
import { hostStrings } from '../../shared/l10n';

type Listener<T> = (v: T) => void;
function emitter<T = void>() {
  const ls = new Set<Listener<T>>();
  return {
    event: (l: Listener<T>) => {
      ls.add(l);
      return { dispose: () => ls.delete(l) };
    },
    fire: (v: T) => ls.forEach((l) => l(v)),
    get size() {
      return ls.size;
    },
  };
}

const uri = (p: string) => ({ scheme: 'file', fsPath: p });

interface Ch {
  uri: { fsPath: string };
  originalUri: { fsPath: string };
  renameUri: { fsPath: string } | undefined;
  status: number;
}
const ch = (root: string, rel: string, status: number, from?: string): Ch => ({
  uri: uri(`${root}/${rel}`),
  originalUri: uri(`${root}/${from ?? rel}`),
  renameUri: from ? uri(`${root}/${rel}`) : undefined,
  status,
});

interface StateInit {
  HEAD?: {
    name?: string;
    commit?: string;
    upstream?: { remote: string; name: string };
    ahead?: number;
    behind?: number;
    type: number;
  };
  remotes?: { name: string; fetchUrl?: string; isReadOnly: boolean }[];
  workingTreeChanges?: Ch[];
  untrackedChanges?: Ch[];
  indexChanges?: Ch[];
  mergeChanges?: Ch[];
}

function fakeRepo(root: string, init: StateInit = {}) {
  const changed = emitter();
  const state = {
    HEAD: {
      name: 'main',
      commit: 'abcdef1234',
      upstream: { remote: 'origin', name: 'main' },
      ahead: 0,
      behind: 0,
      type: 0,
    },
    refs: [],
    remotes: [{ name: 'origin', isReadOnly: false }],
    submodules: [],
    worktrees: [],
    rebaseCommit: undefined,
    mergeChanges: [] as Ch[],
    indexChanges: [] as Ch[],
    workingTreeChanges: [] as Ch[],
    untrackedChanges: [] as Ch[],
    ...init,
    onDidChange: changed.event,
  };
  return {
    rootUri: uri(root),
    state,
    changed,
    add: vi.fn(async () => {}),
    revert: vi.fn(async () => {}),
    clean: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    pull: vi.fn(async () => {}),
    fetch: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    createBranch: vi.fn(async () => {}),
    setBranchUpstream: vi.fn(async () => {}),
    getRefs: vi.fn(async () => []),
    log: vi.fn(
      async () => [] as { hash: string; message: string; parents: string[]; commitDate?: Date }[],
    ),
  };
}
type FakeRepo = ReturnType<typeof fakeRepo>;

function fakeApi(repos: FakeRepo[]) {
  return {
    state: 'initialized',
    git: { path: '/usr/bin/git' },
    repositories: repos,
    onDidOpenRepository: emitter<FakeRepo>().event,
    onDidCloseRepository: emitter<FakeRepo>().event,
    onDidChangeState: emitter<string>().event,
    toGitUri: (u: { fsPath: string }, ref: string) => ({ scheme: 'git', fsPath: u.fsPath, ref }),
  };
}

function fakeUi(confirm = true) {
  return {
    confirm: vi.fn(async () => confirm),
    pick: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    diff: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
    openRepository: vi.fn(async () => {}),
    empty: vi.fn((name: string) => ({ scheme: 'empty', fsPath: name })),
  };
}

const t = hostStrings('ru');

function setup(
  repos: FakeRepo[] | { reason: 'missing' | 'disabled' },
  opts: {
    ui?: ReturnType<typeof fakeUi>;
    run?: GitDeps['run'];
    countLines?: GitDeps['countLines'];
    /** `null` — у адаптера нет одноразовых запросов. */
    complete?: GitDeps['complete'] | null;
  } = {},
) {
  const ui = opts.ui ?? fakeUi();
  const run = vi.fn(opts.run ?? (async () => ''));
  const countLines = vi.fn(opts.countLines ?? (async () => undefined));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const complete = vi.fn(opts.complete ?? (async () => 'Subject\n\nBody'));
  const service = new GitService({
    ...(opts.complete === null ? {} : { complete }),
    loadApi: async () => (Array.isArray(repos) ? { api: fakeApi(repos) as never } : repos),
    ui: ui as unknown as GitUi,
    lang: () => 'ru',
    log,
    run,
    countLines,
    debounceMs: 0,
  });
  return { service, ui, run, countLines, log, complete };
}

function client(service: GitService, cwd: string) {
  const posts: GitNotice[] = [];
  const c = service.attach(cwd, (m) => posts.push(m));
  const states = () =>
    posts.filter((m): m is Extract<GitNotice, { type: 'git.state' }> => m.type === 'git.state');
  const last = async (): Promise<GitSnapshot> => {
    await vi.waitFor(() => expect(states().length).toBeGreaterThan(0));
    return states().at(-1)!.snapshot;
  };
  const errors = () => posts.filter((m) => m.type === 'git.error');
  return { c, posts, states, last, errors };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('parseNumstat', () => {
  it('обычные, бинарные и переименования (-z)', () => {
    const out =
      '3\t1\tsrc/a.ts\0-\t-\timg/logo.png\0' +
      '5\t2\t\0old/name.ts\0new/name.ts\0' +
      '0\t4\tпуть с пробелом.md\0';
    const m = parseNumstat(out);
    expect(m.get('src/a.ts')).toEqual({ add: 3, del: 1 });
    expect(m.get('img/logo.png')).toEqual({ binary: true });
    expect(m.get('new/name.ts')).toEqual({ add: 5, del: 2 });
    expect(m.has('old/name.ts')).toBe(false);
    expect(m.get('путь с пробелом.md')).toEqual({ add: 0, del: 4 });
    expect(parseNumstat('').size).toBe(0);
  });
});

describe('GitService: какие репозитории', () => {
  it('cwd внутри репозитория — один, самый глубокий; внешний (~) не берётся', async () => {
    const { service } = setup([fakeRepo('/home'), fakeRepo('/home/w/queue')]);
    const s = await client(service, '/home/w/queue/board').last();
    expect(s.state).toBe('ok');
    expect(s.repos.map((r) => [r.root, r.rel, r.name])).toEqual([['/home/w/queue', '..', 'queue']]);
  });

  it('cwd — корень репозитория с вложенными: все, cwd первым, остальные по пути', async () => {
    const { service } = setup([
      fakeRepo('/w/ws-client'),
      fakeRepo('/w/board'),
      fakeRepo('/w'),
      fakeRepo('/other'),
    ]);
    const s = await client(service, '/w').last();
    expect(s.repos.map((r) => r.rel)).toEqual(['', 'board', 'ws-client']);
  });

  it('cwd над репозиториями (сам не репо) — вложенные', async () => {
    const { service } = setup([fakeRepo('/w/b'), fakeRepo('/w/a/deep')]);
    const s = await client(service, '/w').last();
    expect(s.repos.map((r) => r.rel)).toEqual(['a/deep', 'b']);
  });

  it('репозиториев нет — none', async () => {
    const { service } = setup([fakeRepo('/elsewhere')]);
    expect(await client(service, '/w').last()).toEqual({ state: 'none', repos: [] });
  });

  it('git недоступен — unavailable и причина', async () => {
    const a = setup({ reason: 'disabled' });
    expect(await client(a.service, '/w').last()).toEqual({
      state: 'unavailable',
      reason: t.gitDisabled,
      repos: [],
    });
    const b = setup({ reason: 'missing' });
    expect((await client(b.service, '/w').last()).reason).toBe(t.gitMissing);
  });
});

describe('GitService: снимок', () => {
  const root = '/w';
  function busyRepo() {
    return fakeRepo(root, {
      HEAD: {
        name: 'fix/x',
        commit: 'c0ffee12345',
        upstream: { remote: 'origin', name: 'fix/x' },
        ahead: 2,
        behind: 1,
        type: 0,
      },
      workingTreeChanges: [
        ch(root, 'src/a.ts', S.MODIFIED),
        ch(root, 'new.ts', S.UNTRACKED),
        ch(root, 'logo.png', S.MODIFIED),
        ch(root, 'build/out.js', S.IGNORED),
      ],
      mergeChanges: [ch(root, 'conflict.ts', S.BOTH_MODIFIED)],
      indexChanges: [
        ch(root, 'lib/new-name.ts', S.INDEX_RENAMED, 'lib/old-name.ts'),
        ch(root, 'gone.ts', S.INDEX_DELETED),
      ],
    });
  }

  it('статусы, ветка, upstream, merge; без открытой вкладки — без цифр, лога и git diff', async () => {
    const repo = busyRepo();
    const { service, run } = setup([repo]);
    const s = await client(service, root).last();
    const r = s.repos[0]!;
    expect(r).toMatchObject({
      branch: 'fix/x',
      upstream: 'origin/fix/x',
      ahead: 2,
      behind: 1,
      published: true,
      op: 'merge',
    });
    expect(r.unstaged).toEqual([
      { path: 'conflict.ts', status: 'C' },
      { path: 'src/a.ts', status: 'M' },
      { path: 'new.ts', status: 'U' },
      { path: 'logo.png', status: 'M' },
    ]);
    expect(r.staged).toEqual([
      { path: 'lib/new-name.ts', status: 'R', from: 'lib/old-name.ts' },
      { path: 'gone.ts', status: 'D' },
    ]);
    expect(r.log).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(repo.log).not.toHaveBeenCalled();
  });

  it('вкладка открыта (git.watch) — numstat индекса и дерева, строки неотслеживаемых, лог с unpushed', async () => {
    const repo = busyRepo();
    repo.log.mockResolvedValue([
      { hash: 'aaaaaaa111', message: 'Second\n\nbody', parents: [], commitDate: new Date(2000) },
      { hash: 'bbbbbbb222', message: 'First', parents: [], commitDate: new Date(1000) },
      { hash: 'ccccccc333', message: 'Old', parents: [] },
    ]);
    const { service, run, countLines } = setup([repo], {
      run: async (_git, args) =>
        args.includes('--cached')
          ? '7\t3\t\0lib/old-name.ts\0lib/new-name.ts\0' + '0\t12\tgone.ts\0'
          : '2\t1\tsrc/a.ts\0-\t-\tlogo.png\0',
      countLines: async (f) => (f.endsWith('new.ts') ? { lines: 31 } : undefined),
    });
    const cl = client(service, root);
    await cl.last();
    await cl.c.handle({ type: 'git.watch', on: true });
    await vi.waitFor(() => expect(cl.states().at(-1)!.snapshot.repos[0]!.log.length).toBe(3));
    const r = cl.states().at(-1)!.snapshot.repos[0]!;
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['--no-optional-locks', 'diff', '--numstat', '-z'],
      root,
    );
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['--no-optional-locks', 'diff', '--numstat', '-z', '--cached'],
      root,
    );
    expect(countLines).toHaveBeenCalledWith('/w/new.ts');
    expect(r.unstaged.find((f) => f.path === 'src/a.ts')).toMatchObject({ add: 2, del: 1 });
    expect(r.unstaged.find((f) => f.path === 'logo.png')).toMatchObject({ binary: true });
    expect(r.unstaged.find((f) => f.path === 'new.ts')).toMatchObject({ add: 31, del: 0 });
    expect(r.staged.find((f) => f.path === 'lib/new-name.ts')).toMatchObject({
      add: 7,
      del: 3,
      from: 'lib/old-name.ts',
    });
    expect(r.staged.find((f) => f.path === 'gone.ts')).toMatchObject({ add: 0, del: 12 });
    expect(r.log).toEqual([
      { hash: 'aaaaaaa', subject: 'Second', at: 2000, unpushed: true },
      { hash: 'bbbbbbb', subject: 'First', at: 1000, unpushed: true },
      { hash: 'ccccccc', subject: 'Old', at: 0, unpushed: false },
    ]);
  });

  it('событие state.onDidChange — новый снимок; неопубликованная ветка и detached', async () => {
    const repo = fakeRepo('/w', { HEAD: { name: 'feat', commit: '1234567890', type: 0 } });
    const { service } = setup([repo]);
    const cl = client(service, '/w');
    expect((await cl.last()).repos[0]).toMatchObject({ branch: 'feat', published: false });
    repo.state.HEAD = { commit: 'deadbeef00', type: 0 };
    const before = cl.states().length;
    repo.changed.fire();
    await vi.waitFor(() => expect(cl.states().length).toBeGreaterThan(before));
    expect(cl.states().at(-1)!.snapshot.repos[0]).toMatchObject({
      branch: 'deadbee',
      detached: true,
      published: true,
    });
  });
});

describe('GitService: действия', () => {
  let repo: FakeRepo;
  beforeEach(() => {
    repo = fakeRepo('/w', {
      workingTreeChanges: [
        ch('/w', 'a.ts', S.MODIFIED),
        ch('/w', 'b.ts', S.MODIFIED),
        ch('/w', 'tmp.txt', S.UNTRACKED),
      ],
    });
  });

  it('stage / unstage — абсолютными путями', async () => {
    const { service } = setup([repo]);
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.stage', root: '/w', paths: ['a.ts', 'sub/c.ts'] });
    expect(repo.add).toHaveBeenCalledWith(['/w/a.ts', '/w/sub/c.ts']);
    await cl.c.handle({ type: 'git.unstage', root: '/w', paths: ['a.ts'] });
    expect(repo.revert).toHaveBeenCalledWith(['/w/a.ts']);
  });

  it('git.openRepository: команда VS Code через ui, сбой — git.error', async () => {
    const ui = fakeUi();
    const { service } = setup([repo], { ui });
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.openRepository' });
    expect(ui.openRepository).toHaveBeenCalledTimes(1);
    ui.openRepository.mockRejectedValueOnce(new Error('нет команды'));
    await cl.c.handle({ type: 'git.openRepository' });
    expect(cl.errors()).toEqual([{ type: 'git.error', op: 'open', message: 'нет команды' }]);
  });

  it('путь вне репозитория и чужой root отклонены — git.error, git не зовётся', async () => {
    const { service, log } = setup([repo]);
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.stage', root: '/w', paths: ['a.ts', '../etc/passwd'] });
    await cl.c.handle({ type: 'git.discard', root: '/w', paths: ['/etc/hosts'] });
    await cl.c.handle({ type: 'git.openFile', root: '/w', path: '.' });
    await cl.c.handle({ type: 'git.stage', root: '/other', paths: ['a.ts'] });
    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.clean).not.toHaveBeenCalled();
    expect(cl.errors()).toEqual([
      { type: 'git.error', root: '/w', op: 'stage', message: t.gitOutside },
      { type: 'git.error', root: '/w', op: 'discard', message: t.gitOutside },
      { type: 'git.error', root: '/w', op: 'openFile', message: t.gitOutside },
      { type: 'git.error', root: '/other', op: 'stage', message: t.gitUnknownRepo },
    ]);
    expect(log.error).toHaveBeenCalledTimes(4);
  });

  it('discard: без подтверждения clean не зовётся; с подтверждением — clean', async () => {
    const no = setup([repo], { ui: fakeUi(false) });
    await client(no.service, '/w').c.handle({
      type: 'git.discard',
      root: '/w',
      paths: ['a.ts', 'b.ts', 'tmp.txt'],
    });
    expect(no.ui.confirm).toHaveBeenCalledWith(
      t.gitDiscard(2),
      t.gitDiscardAlso(1),
      t.gitDiscardButton,
    );
    expect(repo.clean).not.toHaveBeenCalled();

    const yes = setup([repo]);
    await client(yes.service, '/w').c.handle({
      type: 'git.discard',
      root: '/w',
      paths: ['tmp.txt'],
    });
    expect(yes.ui.confirm).toHaveBeenCalledWith(
      t.gitDiscardUntracked(1),
      undefined,
      t.gitDeleteButton,
    );
    expect(repo.clean).toHaveBeenCalledWith(['/w/tmp.txt']);
  });

  it('commit в два root: один падает — второй всё равно коммитится, итог по каждому', async () => {
    const a = fakeRepo('/w/a');
    const b = fakeRepo('/w/b');
    a.commit.mockRejectedValue(
      Object.assign(new Error('Failed to execute git'), { stderr: 'nothing to commit\n' }),
    );
    const { service } = setup([a, b]);
    const cl = client(service, '/w');
    await cl.c.handle({
      type: 'git.commit',
      roots: ['/w/a', '/w/b'],
      message: '  Fix it\n\nbody ',
      amend: false,
      push: false,
    });
    expect(a.commit).toHaveBeenCalledWith('Fix it\n\nbody', {
      amend: false,
      postCommitCommand: null,
    });
    expect(b.commit).toHaveBeenCalledWith('Fix it\n\nbody', {
      amend: false,
      postCommitCommand: null,
    });
    expect(cl.posts.find((m) => m.type === 'git.commit.result')).toEqual({
      type: 'git.commit.result',
      results: [
        { root: '/w/a', ok: false, error: 'nothing to commit' },
        { root: '/w/b', ok: true },
      ],
    });
    expect(cl.errors()).toEqual([
      { type: 'git.error', root: '/w/a', op: 'commit', message: 'nothing to commit' },
    ]);
  });

  it('commit: all и amend, «и push» неопубликованной ветки — push(origin, ветка, true)', async () => {
    repo.state.HEAD = { name: 'feat', commit: '1234567', type: 0 };
    repo.state.remotes = [
      { name: 'upstream', isReadOnly: false },
      { name: 'origin', isReadOnly: false },
    ];
    const { service, ui } = setup([repo]);
    const cl = client(service, '/w');
    await cl.c.handle({
      type: 'git.commit',
      roots: ['/w'],
      message: 'M',
      amend: true,
      push: true,
      all: true,
    });
    expect(repo.commit).toHaveBeenCalledWith('M', {
      amend: true,
      all: true,
      postCommitCommand: null,
    });
    expect(repo.push).toHaveBeenCalledWith('origin', 'feat', true);
    expect(ui.pick).not.toHaveBeenCalled();
    expect(cl.posts.find((m) => m.type === 'git.commit.result')).toMatchObject({
      results: [{ root: '/w', ok: true, pushed: true }],
    });
  });

  it('пустое сообщение — коммита нет, ошибка', async () => {
    const { service } = setup([repo]);
    const cl = client(service, '/w');
    await cl.c.handle({
      type: 'git.commit',
      roots: ['/w'],
      message: '  ',
      amend: false,
      push: false,
    });
    expect(repo.commit).not.toHaveBeenCalled();
    expect(cl.errors()[0]).toMatchObject({ op: 'commit', message: t.gitEmptyMessage });
  });

  it('sync без root — во всех репозиториях; ошибка одного — git.error с его root', async () => {
    const a = fakeRepo('/w/a');
    const b = fakeRepo('/w/b');
    a.pull.mockRejectedValue(new Error('conflict'));
    const { service } = setup([a, b]);
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.sync', op: 'pull' });
    expect(a.pull).toHaveBeenCalled();
    expect(b.pull).toHaveBeenCalled();
    expect(cl.errors()).toEqual([
      { type: 'git.error', root: '/w/a', op: 'pull', message: 'conflict' },
    ]);
    await cl.c.handle({ type: 'git.sync', root: '/w/b', op: 'push' });
    expect(b.push).toHaveBeenCalledWith();
  });

  it('busy в снимке, пока идёт операция', async () => {
    let release!: () => void;
    repo.fetch.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const { service } = setup([repo]);
    const cl = client(service, '/w');
    await cl.last();
    const done = cl.c.handle({ type: 'git.sync', root: '/w', op: 'fetch' });
    await vi.waitFor(() => expect(cl.states().at(-1)!.snapshot.repos[0]!.busy).toBe('fetch'));
    release();
    await done;
    await vi.waitFor(() => expect(cl.states().at(-1)!.snapshot.repos[0]!.busy).toBeUndefined());
  });

  it('branch: удалённая ветка — локальная с upstream; «Создать ветку…» — createBranch', async () => {
    repo.getRefs.mockResolvedValue([
      { type: 0, name: 'main', commit: 'aaaaaaa1' },
      { type: 1, name: 'origin/HEAD', remote: 'origin' },
      { type: 1, name: 'origin/feat', remote: 'origin', commit: 'bbbbbbb1' },
    ] as never);
    const ui = fakeUi();
    const { service } = setup([repo], { ui });
    const cl = client(service, '/w');
    ui.pick.mockImplementationOnce((async (items: { label: string }[]) => {
      expect(items.map((i) => i.label)).toEqual([
        t.gitCreateBranch,
        t.gitLocal,
        'main',
        t.gitRemote,
        'origin/feat',
      ]);
      return items.at(-1);
    }) as never);
    await cl.c.handle({ type: 'git.branch', root: '/w' });
    expect(repo.createBranch).toHaveBeenCalledWith('feat', true, 'origin/feat');
    expect(repo.setBranchUpstream).toHaveBeenCalledWith('feat', 'origin/feat');

    ui.pick.mockImplementationOnce((async (items: unknown[]) => items[0]) as never);
    ui.input.mockResolvedValueOnce(' topic ' as never);
    await cl.c.handle({ type: 'git.branch', root: '/w' });
    expect(repo.createBranch).toHaveBeenLastCalledWith('topic', true);
  });

  it('open: дифф как у SCM — индекс (~) ↔ файл, HEAD ↔ индекс (""), новый — файл, удалённый — ↔ пусто', async () => {
    repo.state.workingTreeChanges = [
      ch('/w', 'a.ts', S.MODIFIED),
      ch('/w', 'gone.ts', S.DELETED),
      ch('/w', 'n.ts', S.UNTRACKED),
    ];
    repo.state.indexChanges = [
      ch('/w', 'new-name.ts', S.INDEX_RENAMED, 'old-name.ts'),
      ch('/w', 'added.ts', S.INDEX_ADDED),
    ];
    const { service, ui } = setup([repo]);
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.open', root: '/w', path: 'a.ts', staged: false });
    expect(ui.diff).toHaveBeenLastCalledWith(
      { scheme: 'git', fsPath: '/w/a.ts', ref: '~' },
      { scheme: 'file', fsPath: '/w/a.ts' },
      `a.ts (${t.gitWorkingTree})`,
    );
    await cl.c.handle({ type: 'git.open', root: '/w', path: 'new-name.ts', staged: true });
    expect(ui.diff).toHaveBeenLastCalledWith(
      { scheme: 'git', fsPath: '/w/old-name.ts', ref: 'HEAD' },
      { scheme: 'git', fsPath: '/w/new-name.ts', ref: '' },
      `new-name.ts (${t.gitIndex})`,
    );
    await cl.c.handle({ type: 'git.open', root: '/w', path: 'gone.ts', staged: false });
    expect(ui.diff).toHaveBeenLastCalledWith(
      { scheme: 'git', fsPath: '/w/gone.ts', ref: '~' },
      { scheme: 'empty', fsPath: 'gone.ts' },
      `gone.ts (${t.gitDeleted})`,
    );
    await cl.c.handle({ type: 'git.open', root: '/w', path: 'n.ts', staged: false });
    await cl.c.handle({ type: 'git.open', root: '/w', path: 'added.ts', staged: true });
    expect(ui.open.mock.calls).toEqual([
      [{ scheme: 'file', fsPath: '/w/n.ts' }],
      [{ scheme: 'file', fsPath: '/w/added.ts' }],
    ]);
  });

  it('dispose панели — снимки ей больше не идут', async () => {
    const { service } = setup([repo]);
    const cl = client(service, '/w');
    await cl.last();
    cl.c.dispose();
    const n = cl.states().length;
    repo.changed.fire();
    await tick();
    expect(cl.states().length).toBe(n);
  });
});

describe('GitService: ✦ сообщение коммита', () => {
  /** git по аргументам: `--stat`, дифф, лог — с корнем в тексте, чтобы видеть, чей индекс ушёл в промпт. */
  const git: GitDeps['run'] = async (_bin, args, cwd) => {
    if (args.includes('--stat')) return ` a.ts | 2 +-  (${cwd})\n`;
    if (args[0] === 'diff') return `diff --git a/a.ts b/a.ts (${cwd})\n-old\n+new\n`;
    if (args[0] === 'log') return 'Fix the thing\nAdd the other\n';
    return '';
  };
  const staged = (root: string) =>
    fakeRepo(root, { indexChanges: [ch(root, 'a.ts', S.INDEX_MODIFIED)] });

  it('один репозиторий: индекс, стиль и модель sonnet — в одноразовый запрос, ответ — git.message.result', async () => {
    const repo = staged('/w');
    const { service, run, complete } = setup([repo], {
      run: git,
      complete: async () => '```\nFix parser  \n\nHandle the empty line.\n```',
    });
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.message', roots: ['/w'] });
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['diff', '--cached', '--stat', '--no-color'],
      '/w',
    );
    expect(run).toHaveBeenCalledWith('/usr/bin/git', ['log', '-n5', '--format=%s'], '/w');
    expect(complete).toHaveBeenCalledTimes(1);
    const [cwd, req] = complete.mock.calls[0]!;
    expect(cwd).toBe('/w');
    expect(req.model).toBe('sonnet');
    expect(req.system).toMatch(/72 characters/);
    expect(req.prompt).toContain('- Fix the thing');
    expect(req.prompt).toContain('a.ts | 2 +-  (/w)');
    expect(req.prompt).toContain('+new');
    expect(cl.posts.find((m) => m.type === 'git.message.result')).toEqual({
      type: 'git.message.result',
      roots: ['/w'],
      summary: 'Fix parser',
      desc: 'Handle the empty line.',
    });
    expect(cl.errors()).toEqual([]);
  });

  it('unified: индекс всех отмеченных — одним запросом; репозиторий без индекса не идёт', async () => {
    const a = staged('/w/a');
    const b = staged('/w/b');
    const c = fakeRepo('/w/c');
    const { service, complete } = setup([a, b, c], { run: git });
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.message', roots: ['/w/a', '/w/b', '/w/c'] });
    expect(complete).toHaveBeenCalledTimes(1);
    const [cwd, req] = complete.mock.calls[0]!;
    expect(cwd).toBe('/w/a');
    expect(req.prompt).toContain('## Repository: a');
    expect(req.prompt).toContain('## Repository: b');
    expect(req.prompt).not.toContain('## Repository: c');
    expect(req.prompt).toMatch(/separate commit in each of these 2 repositories/);
    expect(cl.posts.find((m) => m.type === 'git.message.result')).toMatchObject({
      roots: ['/w/a', '/w/b', '/w/c'],
      summary: 'Subject',
      desc: 'Body',
    });
  });

  it('пустой индекс, чужой root, нет движка, сбой модели, пустой ответ — git.error {op: message}', async () => {
    const empty = fakeRepo('/w');
    const r1 = setup([empty], { run: git });
    const c1 = client(r1.service, '/w');
    await c1.c.handle({ type: 'git.message', roots: ['/w'] });
    expect(r1.complete).not.toHaveBeenCalled();
    expect(c1.errors()).toEqual([
      { type: 'git.error', root: '/w', op: 'message', message: t.gitMessageEmptyIndex },
    ]);

    const r2 = setup([staged('/w')], { run: git });
    const c2 = client(r2.service, '/w');
    await c2.c.handle({ type: 'git.message', roots: ['/w', '/other'] });
    expect(r2.complete).not.toHaveBeenCalled();
    expect(c2.errors()).toEqual([{ type: 'git.error', op: 'message', message: t.gitUnknownRepo }]);

    const r3 = setup([staged('/w')], { run: git, complete: null });
    const c3 = client(r3.service, '/w');
    await c3.c.handle({ type: 'git.message', roots: ['/w'] });
    expect(c3.errors()).toEqual([
      { type: 'git.error', root: '/w', op: 'message', message: t.gitMessageNoModel },
    ]);

    const r4 = setup([staged('/w')], {
      run: git,
      complete: async () => {
        throw new Error('движок не ответил за 60 с');
      },
    });
    const c4 = client(r4.service, '/w');
    await c4.c.handle({ type: 'git.message', roots: ['/w'] });
    expect(c4.errors()).toEqual([
      { type: 'git.error', root: '/w', op: 'message', message: 'движок не ответил за 60 с' },
    ]);
    expect(r4.log.error).toHaveBeenCalled();

    const r5 = setup([staged('/w')], { run: git, complete: async () => '  \n ' });
    const c5 = client(r5.service, '/w');
    await c5.c.handle({ type: 'git.message', roots: ['/w'] });
    expect(c5.errors()).toEqual([
      { type: 'git.error', root: '/w', op: 'message', message: t.gitMessageBlank },
    ]);
    expect(c5.posts.some((m) => m.type === 'git.message.result')).toBe(false);
  });

  it('репозиторий без коммитов: лог падает — заголовков нет, запрос всё равно идёт', async () => {
    const { service, complete } = setup([staged('/w')], {
      run: async (bin, args, cwd) => {
        if (args[0] === 'log') throw new Error('does not have any commits yet');
        return git(bin, args, cwd);
      },
    });
    const cl = client(service, '/w');
    await cl.c.handle({ type: 'git.message', roots: ['/w'] });
    expect(complete.mock.calls[0]![1].prompt).toContain('(no commits yet)');
    expect(cl.errors()).toEqual([]);
  });
});
