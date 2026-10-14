import { describe, expect, it, vi } from 'vitest';
import type { TaskCodeCommitMessage, TaskCodeDiffMessage, TaskCodeStateMessage } from '../../shared/task';
import {
  branchesOf,
  codePatch,
  collectCode,
  commitFiles,
  countTextLines,
  detectBase,
  editedPaths,
  keyRegex,
  parseLog,
  parseNameStatus,
  parseStatus,
  TaskCode,
  untrackedPatch,
  withNumstat,
  type CodeChatInfo,
  type CodeCollectDeps,
  type HistoryTool,
} from './taskCode';

// `taskCode` берёт `parseNumstat` из gitService, а тот тянет `vscode`
vi.mock('vscode', () => ({}));

const US = '\x1f';
const commit = (sha: string, subject: string, at: number, author = 'Anna') =>
  `${sha}${US}${sha.slice(0, 7)}${US}${author}${US}${at}${US}${subject}`;

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);

type Handler = (args: string[], cwd: string) => string | undefined;

/** Заглушка git: первый подошедший обработчик отвечает, остальным — исключение «неизвестная команда». */
function fakeRun(handlers: Handler[]): { run: CodeCollectDeps['run']; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args, cwd) => {
      calls.push(args);
      for (const h of handlers) {
        const r = h(args, cwd);
        if (r !== undefined) return r;
      }
      throw Object.assign(new Error('fail'), { stderr: `fatal: unexpected ${args.join(' ')}` });
    },
  };
}

const has = (args: string[], ...parts: string[]): boolean => parts.every((p) => args.includes(p));
const edit = (file_path: string, name = 'Edit'): HistoryTool => ({ type: 'tool.start', name, input: { file_path } });

describe('разборщики git', () => {
  it('KEYRE: GARM-87 не ловит GARM-870, но ловит ключ в начале, в конце и в имени ветки', () => {
    const re = keyRegex('GARM-87');
    expect(re.test('GARM-87: fix')).toBe(true);
    expect(re.test('fix garm-87')).toBe(true);
    expect(re.test('feature/GARM-87-login')).toBe(true);
    expect(re.test('[GARM-87]')).toBe(true);
    expect(re.test('GARM-870 fix')).toBe(false);
    expect(re.test('XGARM-87')).toBe(false);
    expect(re.test('PRE-GARM-87')).toBe(true); // дефис — не буква и не цифра, как в `[^A-Za-z0-9]`
  });

  it('parseLog: поля через US, мусорные строки пропускаются', () => {
    const out = [commit(SHA1, 'GARM-87: one', 1700000000), 'мусор', commit(SHA2, 'two' + US + 'tail', 1700000100)].join('\n');
    const res = parseLog(out);
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({ sha: SHA1, short: SHA1.slice(0, 7), author: 'Anna', at: 1700000000, subject: 'GARM-87: one' });
    expect(res[1]!.subject).toBe('two' + US + 'tail');
  });

  it('branchesOf: по ключу в имени, без HEAD, локальная вытесняет origin/<то же>', () => {
    const refs = [
      'develop',
      'feature/GARM-87-login',
      'origin/feature/GARM-87-login',
      'origin/GARM-87-only-remote',
      'origin/HEAD',
      'origin/feature/GARM-870-other',
      'GARM-87',
    ].join('\n');
    expect(branchesOf(refs, 'GARM-87')).toEqual(['feature/GARM-87-login', 'origin/GARM-87-only-remote', 'GARM-87']);
  });

  it('parseNameStatus: переименование, копия, смена типа, удаление; withNumstat добавляет ± и бинарность', () => {
    const files = parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0T\0link\0C100\0src\0copy\0A\0img.png\0');
    expect(files).toEqual([
      { path: 'a.ts', status: 'M' },
      { path: 'new.ts', status: 'R', from: 'old.ts' },
      { path: 'gone.ts', status: 'D' },
      { path: 'link', status: 'T' },
      { path: 'copy', status: 'A', from: 'src' },
      { path: 'img.png', status: 'A' },
    ]);
    const num = '3\t1\ta.ts\0' + '0\t0\t\0old.ts\0new.ts\0' + '-\t-\timg.png\0';
    const withStat = withNumstat(files, num);
    expect(withStat[0]).toMatchObject({ path: 'a.ts', add: 3, del: 1 });
    expect(withStat[1]).toMatchObject({ path: 'new.ts', add: 0, del: 0 });
    expect(withStat[2]).toEqual({ path: 'gone.ts', status: 'D' });
    expect(withStat[5]).toMatchObject({ path: 'img.png', binary: true });
  });

  it('parseStatus: изменённый, индекс, переименование, неотслеживаемый, игнорируемый', () => {
    const out = ' M a.ts\0A  added.ts\0AM both.ts\0R  new.ts\0old.ts\0 D gone.ts\0?? fresh.ts\0!! ignored.log\0MM two.ts\0';
    expect(parseStatus(out)).toEqual([
      { path: 'a.ts', status: 'M', untracked: false },
      { path: 'added.ts', status: 'A', untracked: false },
      { path: 'both.ts', status: 'A', untracked: false },
      { path: 'new.ts', from: 'old.ts', status: 'R', untracked: false },
      { path: 'gone.ts', status: 'D', untracked: false },
      { path: 'fresh.ts', status: 'A', untracked: true },
      { path: 'two.ts', status: 'M', untracked: false },
    ]);
  });

  it('editedPaths: только Edit/MultiEdit/Write/NotebookEdit; относительный путь — от cwd чата', () => {
    const events: HistoryTool[] = [
      edit('src/a.ts'),
      edit('/abs/b.ts', 'Write'),
      edit('c.ts', 'MultiEdit'),
      { type: 'tool.start', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } },
      { type: 'tool.start', name: 'Read', input: { file_path: 'read.ts' } },
      { type: 'tool.start', name: 'Edit', input: { file_path: 5 } },
      { type: 'tool.result' },
      edit('src/a.ts'),
    ];
    expect(editedPaths(events, '/work/r')).toEqual(['/work/r/src/a.ts', '/abs/b.ts', '/work/r/c.ts', '/work/r/n.ipynb']);
  });

  it('untrackedPatch: все строки «+», пустой файл — без хунков; countTextLines', () => {
    const p = untrackedPatch('n.ts', 'one\ntwo\n');
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]!.lines).toEqual([
      { kind: '+', text: 'one', old: null, new: 1 },
      { kind: '+', text: 'two', old: null, new: 2 },
    ]);
    expect(untrackedPatch('e.ts', '').hunks).toEqual([]);
    expect(countTextLines('')).toBe(0);
    expect(countTextLines('a')).toBe(1);
    expect(countTextLines('a\nb\n')).toBe(2);
    expect(countTextLines('a\nb')).toBe(2);
  });
});

describe('detectBase', () => {
  it('origin/HEAD приоритетнее, иначе первая существующая из списка, иначе нет', async () => {
    const a = fakeRun([(args) => (args[0] === 'symbolic-ref' ? 'origin/develop\n' : undefined)]);
    expect(await detectBase(a.run, '/r')).toBe('origin/develop');
    const b = fakeRun([(args) => (args[0] === 'rev-parse' && args[3] === 'main' ? 'abc\n' : undefined)]);
    expect(await detectBase(b.run, '/r')).toBe('main');
    expect(b.calls.map((c) => c[3]).filter(Boolean)).toEqual(['refs/remotes/origin/HEAD', 'develop', 'main']);
    expect(await detectBase(fakeRun([]).run, '/r')).toBeUndefined();
  });
});

function repoHandlers(opts: { base?: boolean; remotes?: boolean } = {}): Handler[] {
  const base = opts.base !== false;
  const remotes = opts.remotes !== false;
  return [
    (a) => (a[0] === 'remote' ? (remotes ? 'origin\n' : '') : undefined),
    (a) => (a[0] === 'symbolic-ref' ? (base ? 'origin/develop\n' : undefined) : undefined),
    // коммиты по ключу
    (a) =>
      a[0] === 'log' && has(a, '--all')
        ? [commit(SHA1, 'GARM-87: first', 1700000000), commit(SHA2, 'GARM-87 second', 1700000500)].join('\n') + '\n'
        : undefined,
    (a) =>
      a[0] === 'for-each-ref'
        ? ['develop', 'feature/GARM-87-x', 'origin/feature/GARM-87-x', 'origin/HEAD', 'origin/other'].join('\n') + '\n'
        : undefined,
    // коммиты ветки сверх базы: один найден и по ключу, один — только по ветке
    (a) =>
      a[0] === 'log' && a[1] === 'origin/develop..feature/GARM-87-x'
        ? [commit(SHA2, 'GARM-87 second', 1700000500), commit(SHA3, 'wip without key', 1700001000)].join('\n') + '\n'
        : undefined,
    (a) => (a[0] === 'diff' && has(a, '--numstat') && has(a, 'origin/develop...feature/GARM-87-x') ? '5\t1\tsrc/a.ts\0' + '2\t0\tnew.ts\0' : undefined),
    (a) => (a[0] === 'diff' && has(a, '--name-status') && has(a, 'origin/develop...feature/GARM-87-x') ? 'M\0src/a.ts\0A\0new.ts\0' : undefined),
    // не в удалённых: SHA3 (и предок, которого мы не знаем)
    (a) => (a[0] === 'rev-list' ? `${SHA3}\n${'d'.repeat(40)}\n` : undefined),
    // уже в базе
    (a) => (a[0] === 'log' && a[1] === 'origin/develop' ? `${SHA1}\n` : undefined),
    // рабочее дерево
    (a) => (a[0] === 'status' ? ' M src/a.ts\0?? n.ts\0 M other.ts\0 M manual.ts\0' : undefined),
    (a) => (a[0] === 'diff' && has(a, '--numstat') && has(a, 'HEAD') ? '4\t2\tsrc/a.ts\0' + '1\t1\tother.ts\0' : undefined),
  ];
}

const chat1: CodeChatInfo = { id: 'c1', title: 'Первый', cwd: '/w/r' };
const chat2: CodeChatInfo = { id: 'c2', provider: 'codex', title: 'Второй' };

describe('collectCode', () => {
  it('коммиты по ключу и ветке, статусы, итог ветки, правки агентов ∩ status', async () => {
    const git = fakeRun(repoHandlers());
    const history = vi.fn(async (chat: CodeChatInfo): Promise<HistoryTool[]> =>
      chat.id === 'c1'
        ? [edit('src/a.ts'), edit('/w/r/n.ts', 'Write'), edit('src/not-changed.ts')]
        : [edit('/w/r/other.ts'), edit('/w/r/src/a.ts'), edit('/elsewhere/x.ts'), edit('rel.ts')],
    );
    const readText = vi.fn(async () => ({ text: 'a\nb\nc\n' }));
    const repos = vi.fn(async () => ['/w/r']);
    const res = await collectCode(
      { run: git.run, repos, history, readText },
      { key: 'GARM-87', cwd: '/fallback', chats: [chat1, chat2] },
    );
    expect(res.error).toBeUndefined();
    expect(repos).toHaveBeenCalledWith('/w/r'); // чат с cwd — своя папка
    expect(repos).toHaveBeenCalledWith('/fallback'); // чат без cwd — папка вкладки
    expect(history).toHaveBeenCalledWith(chat2, '/fallback');
    expect(res.repos).toHaveLength(1);
    const r = res.repos[0]!;
    expect(r).toMatchObject({ root: '/w/r', name: 'r', base: 'origin/develop' });

    // новые сверху; SHA2 найден по ключу (ветка не пишется), SHA3 — только по ветке
    expect(r.commits.map((c) => [c.sha, c.src, c.branch, c.unpushed, c.inBase])).toEqual([
      [SHA3, 'branch', 'feature/GARM-87-x', true, undefined],
      [SHA2, 'key', undefined, undefined, undefined],
      [SHA1, 'key', undefined, undefined, true],
    ]);
    expect(r.commits[1]).toMatchObject({ subject: 'GARM-87 second', author: 'Anna', at: 1700000500_000 });

    // ветка: локальная вытесняет origin/<то же>, origin/HEAD и чужие отброшены
    expect(r.branches).toEqual([
      {
        name: 'feature/GARM-87-x',
        ahead: 2,
        add: 7,
        del: 1,
        files: [
          { path: 'src/a.ts', status: 'M', add: 5, del: 1 },
          { path: 'new.ts', status: 'A', add: 2, del: 0 },
        ],
      },
    ]);

    // unpushed считается пересечением с нашими sha: чужой предок из rev-list не попадает в коммиты
    expect(r.commits.some((c) => c.sha === 'd'.repeat(40))).toBe(false);

    // незакоммиченное: пересечение status с правками; manual.ts (правки руками) не попадает
    expect(r.dirty.map((d) => d.path)).toEqual(['n.ts', 'other.ts', 'src/a.ts']);
    const a = r.dirty.find((d) => d.path === 'src/a.ts')!;
    expect(a).toMatchObject({ status: 'M', add: 4, del: 2 });
    expect(a.chats).toEqual([
      { id: 'c1', title: 'Первый' },
      { id: 'c2', provider: 'codex', title: 'Второй' },
    ]);
    expect(r.dirty.find((d) => d.path === 'n.ts')).toMatchObject({ status: 'A', add: 3, del: 0 });
    expect(r.dirty.find((d) => d.path === 'other.ts')!.chats.map((c) => c.id)).toEqual(['c2']);
    expect(readText).toHaveBeenCalledWith('/w/r/n.ts');
  });

  it('все git-команды — массивом, пути после «--», sha и ветки без флагов', async () => {
    const git = fakeRun(repoHandlers());
    await collectCode(
      { run: git.run, repos: async () => ['/w/r'], history: async () => [edit('src/a.ts')], readText: async () => undefined },
      { key: 'GARM-87', cwd: '/w/r', chats: [chat1] },
    );
    const grepLog = git.calls.find((c) => c[0] === 'log' && c.includes('--all'))!;
    expect(grepLog).toContain('-i');
    expect(grepLog).toContain('-E');
    expect(grepLog).toContain('--grep=(^|[^A-Za-z0-9])GARM-87([^0-9]|$)');
    expect(grepLog.slice(grepLog.indexOf('-n'), grepLog.indexOf('-n') + 2)).toEqual(['-n', '200']);
    expect(git.calls.find((c) => c[0] === 'rev-list')).toEqual(['rev-list', SHA1, SHA2, SHA3, '--not', '--remotes']);
    expect(git.calls.find((c) => c[0] === 'status')).toEqual(['status', '--porcelain=v1', '-z', '-uall']);
  });

  it('без remote: «↑ локально» не ставится, rev-list не запускается', async () => {
    const git = fakeRun(repoHandlers({ remotes: false }));
    const res = await collectCode(
      { run: git.run, repos: async () => ['/w/r'], history: async () => [], readText: async () => undefined },
      { key: 'GARM-87', cwd: '/w/r', chats: [chat1] },
    );
    expect(git.calls.some((c) => c[0] === 'rev-list')).toBe(false);
    expect(res.repos[0]!.commits.some((c) => c.unpushed)).toBe(false);
  });

  it('нет базы: ветки по имени без «сверх базы», коммиты только по ключу, inBase нет', async () => {
    const git = fakeRun(repoHandlers({ base: false }));
    const res = await collectCode(
      { run: git.run, repos: async () => ['/w/r'], history: async () => [], readText: async () => undefined },
      { key: 'GARM-87', cwd: '/w/r', chats: [chat1] },
    );
    const r = res.repos[0]!;
    expect(r.base).toBeUndefined();
    expect(r.branches).toEqual([{ name: 'feature/GARM-87-x', ahead: 0, add: 0, del: 0, files: [] }]);
    expect(r.commits.map((c) => [c.sha, c.src, c.inBase])).toEqual([
      [SHA2, 'key', undefined],
      [SHA1, 'key', undefined],
    ]);
  });

  it('только удалённая ветка остаётся под именем origin/…', async () => {
    const git = fakeRun([
      (a) => (a[0] === 'for-each-ref' ? 'main\norigin/main\norigin/feature/GARM-87-y\n' : undefined),
      (a) => (a[0] === 'symbolic-ref' ? 'origin/main\n' : undefined),
      (a) => (a[0] === 'log' ? '' : undefined),
      (a) => (a[0] === 'diff' ? '' : undefined),
      (a) => (a[0] === 'status' ? '' : undefined),
    ]);
    const res = await collectCode(
      { run: git.run, repos: async () => ['/w/r'], history: async () => [], readText: async () => undefined },
      { key: 'GARM-87', cwd: '/w/r', chats: [] },
    );
    expect(res.repos[0]!.branches.map((b) => b.name)).toEqual(['origin/feature/GARM-87-y']);
  });

  it('репозитории разных папок дедуплицируются по корню; ошибка одного — в его error, остальные целы', async () => {
    const git = fakeRun([
      (a, cwd) => (cwd === '/bad' ? undefined : repoHandlers().map((h) => h(a, cwd)).find((x) => x !== undefined)),
    ]);
    const repos = vi.fn(async (cwd: string) => (cwd === '/w/r' || cwd === '/w/r/sub' ? ['/w/r'] : ['/w/r', '/bad']));
    const res = await collectCode(
      { run: git.run, repos, history: async () => [], readText: async () => undefined },
      { key: 'GARM-87', cwd: undefined, chats: [chat1, { id: 'c3', title: 'Три', cwd: '/w/r/sub' }, { id: 'c4', title: 'Четыре', cwd: '/other' }] },
    );
    expect(res.repos.map((r) => r.root)).toEqual(['/w/r', '/bad']);
    expect(res.repos[0]!.error).toBeUndefined();
    expect(res.repos[1]).toMatchObject({ root: '/bad', commits: [], branches: [], dirty: [] });
    expect(res.repos[1]!.error).toContain('fatal');
    expect(res.error).toBeUndefined();
  });

  it('git недоступен: нет репозиториев — error с причиной; папка без репозитория — пропуск без ошибки', async () => {
    const down = await collectCode(
      {
        run: fakeRun([]).run,
        repos: async () => {
          throw new Error('Git disabled');
        },
        history: async () => [],
        readText: async () => undefined,
      },
      { key: 'GARM-87', cwd: '/w', chats: [] },
    );
    expect(down).toEqual({ repos: [], error: 'Git disabled' });
    const none = await collectCode(
      { run: fakeRun([]).run, repos: async () => [], history: async () => [], readText: async () => undefined },
      { key: 'GARM-87', cwd: '/w', chats: [] },
    );
    expect(none).toEqual({ repos: [] });
  });

  it('история чата не читается — его правок нет, остальное цело; без status правки не читаются вовсе', async () => {
    const git = fakeRun(repoHandlers());
    const history = vi.fn(async (c: CodeChatInfo): Promise<HistoryTool[]> => {
      if (c.id === 'c1') throw new Error('boom');
      return [edit('/w/r/other.ts')];
    });
    const res = await collectCode(
      { run: git.run, repos: async () => ['/w/r'], history, readText: async () => undefined },
      { key: 'GARM-87', cwd: '/w/r', chats: [chat1, { ...chat2, cwd: '/w/r' }] },
    );
    expect(res.repos[0]!.dirty.map((d) => d.path)).toEqual(['other.ts']);

    const clean = fakeRun([...repoHandlers().slice(0, 7), (a) => (a[0] === 'status' ? '' : undefined)]);
    const h2 = vi.fn(async () => []);
    await collectCode({ run: clean.run, repos: async () => ['/w/r'], history: h2, readText: async () => undefined }, { key: 'GARM-87', cwd: '/w/r', chats: [chat1] });
    expect(h2).not.toHaveBeenCalled();
  });

  it('неверный ключ задачи — ошибка без запуска git', async () => {
    const git = fakeRun([]);
    const res = await collectCode(
      { run: git.run, repos: async () => ['/r'], history: async () => [], readText: async () => undefined },
      { key: 'not a key', cwd: '/r', chats: [] },
    );
    expect(res.error).toBeTruthy();
    expect(git.calls).toEqual([]);
  });

  it('неотслеживаемый бинарный файл: binary без ±', async () => {
    const git = fakeRun([...repoHandlers().slice(0, 7), (a) => (a[0] === 'status' ? '?? pic.png\0' : undefined)]);
    const res = await collectCode(
      { run: git.run, repos: async () => ['/w/r'], history: async () => [edit('pic.png', 'Write')], readText: async () => ({ binary: true }) },
      { key: 'GARM-87', cwd: '/w/r', chats: [chat1] },
    );
    expect(res.repos[0]!.dirty).toEqual([{ path: 'pic.png', status: 'A', binary: true, chats: [{ id: 'c1', title: 'Первый' }] }]);
  });
});

describe('файлы коммита и патчи', () => {
  const NS = 'M\0a.ts\0R100\0old.ts\0new.ts\0';
  const NUM = '2\t1\ta.ts\0' + '0\t0\t\0old.ts\0new.ts\0';

  it('commitFiles: против родителя; корневой — diff-tree --root', async () => {
    const withParent = fakeRun([
      (a) => (a[0] === 'rev-parse' ? `${SHA1}\n` : undefined),
      (a) => (a[0] === 'diff' && has(a, '--name-status') && has(a, `${SHA2}^`, SHA2) ? NS : undefined),
      (a) => (a[0] === 'diff' && has(a, '--numstat') ? NUM : undefined),
    ]);
    expect(await commitFiles(withParent.run, '/r', SHA2)).toEqual([
      { path: 'a.ts', status: 'M', add: 2, del: 1 },
      { path: 'new.ts', status: 'R', from: 'old.ts', add: 0, del: 0 },
    ]);
    const root = fakeRun([
      (a) => (a[0] === 'diff-tree' && has(a, '--root', '--name-status') ? 'A\0a.ts\0' : undefined),
      (a) => (a[0] === 'diff-tree' && has(a, '--root', '--numstat') ? '1\t0\ta.ts\0' : undefined),
    ]);
    expect(await commitFiles(root.run, '/r', SHA1)).toEqual([{ path: 'a.ts', status: 'A', add: 1, del: 0 }]);
  });

  const PATCH = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n';

  it('codePatch: файл коммита, корневого коммита и ветки', async () => {
    const c = fakeRun([
      (a) => (a[0] === 'rev-parse' ? 'ok\n' : undefined),
      (a) => (a[0] === 'diff' && has(a, '--no-color', '--no-ext-diff', '-M', `${SHA2}^`, SHA2, '--', 'a.ts') ? PATCH : undefined),
    ]);
    const deps = { run: c.run, readText: async () => undefined };
    const p = await codePatch(deps, '/r', { kind: 'commit', sha: SHA2, path: 'a.ts' });
    expect(p.hunks[0]!.lines.map((l) => l.kind)).toEqual(['-', '+']);

    const root = fakeRun([(a) => (a[0] === 'diff-tree' && has(a, '-p', '--root', SHA1, '--', 'a.ts') ? PATCH : undefined)]);
    expect((await codePatch({ run: root.run, readText: async () => undefined }, '/r', { kind: 'commit', sha: SHA1, path: 'a.ts' })).hunks).toHaveLength(1);

    const br = fakeRun([(a) => (a[0] === 'diff' && has(a, 'origin/develop...feat/x', '--', 'a.ts') ? PATCH : undefined)]);
    expect((await codePatch({ run: br.run, readText: async () => undefined }, '/r', { kind: 'branch', base: 'origin/develop', branch: 'feat/x', path: 'a.ts' })).hunks).toHaveLength(1);
  });

  it('codePatch wip: отслеживаемый — diff HEAD, неотслеживаемый — из содержимого, бинарный — binary', async () => {
    const tracked = fakeRun([
      (a) => (a[0] === 'ls-files' ? '' : undefined),
      (a) => (a[0] === 'diff' && has(a, 'HEAD', '--', 'a.ts') ? PATCH : undefined),
    ]);
    expect((await codePatch({ run: tracked.run, readText: async () => undefined }, '/r', { kind: 'wip', path: 'a.ts' })).hunks).toHaveLength(1);

    const fresh = fakeRun([(a) => (a[0] === 'ls-files' ? 'n.ts\0' : undefined)]);
    const readText = vi.fn(async () => ({ text: 'l1\nl2\nl3\n' }));
    const p = await codePatch({ run: fresh.run, readText }, '/r', { kind: 'wip', path: 'n.ts' });
    expect(readText).toHaveBeenCalledWith('/r/n.ts');
    expect(p.hunks[0]!.lines.map((l) => [l.kind, l.text, l.new])).toEqual([
      ['+', 'l1', 1],
      ['+', 'l2', 2],
      ['+', 'l3', 3],
    ]);
    expect(fresh.calls.some((c) => c[0] === 'diff')).toBe(false); // --no-index не используем

    const bin = await codePatch({ run: fresh.run, readText: async () => ({ binary: true }) }, '/r', { kind: 'wip', path: 'n.ts' });
    expect(bin).toEqual({ binary: true, hunks: [], truncated: false });
    // большой/нечитаемый — обрезанный патч без строк, не ошибка
    expect(await codePatch({ run: fresh.run, readText: async () => undefined }, '/r', { kind: 'wip', path: 'n.ts' })).toEqual({
      binary: false,
      hunks: [],
      truncated: true,
    });
  });
});

describe('TaskCode', () => {
  const TASK = 'jira:inst:GARM-87';

  function setup(over: Partial<{ delay: Promise<void> }> = {}) {
    const posted: (TaskCodeStateMessage | TaskCodeCommitMessage | TaskCodeDiffMessage)[] = [];
    const git = fakeRun([
      ...repoHandlers(),
      (a) => (a[0] === 'rev-parse' ? 'ok\n' : undefined),
      (a) => (a[0] === 'diff' && has(a, '--name-status', `${SHA2}^`) ? 'M\0a.ts\0' : undefined),
      (a) => (a[0] === 'diff' && has(a, '--numstat', `${SHA2}^`) ? '1\t1\ta.ts\0' : undefined),
      (a) => (a[0] === 'diff' && has(a, '--no-color', `${SHA2}^`) ? '@@ -1 +1 @@\n-x\n+y\n' : undefined),
      (a) => (a[0] === 'ls-files' ? '' : undefined),
      (a) => (a[0] === 'diff' && has(a, '--no-color', 'HEAD') ? '@@ -1 +1 @@\n-x\n+y\n' : undefined),
    ]);
    const prefill = vi.fn();
    const copy = vi.fn();
    const chats = vi.fn(async () => {
      await over.delay;
      return [chat1];
    });
    const code = new TaskCode({
      run: git.run,
      repos: async () => ['/w/r'],
      history: async () => [edit('src/a.ts')],
      readText: async () => ({ text: 'x\n' }),
      cwd: () => '/w/r',
      chats,
      post: (m) => posted.push(m),
      prefill,
      copy,
    });
    return { code, posted, git, prefill, copy, chats };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const states = (p: ReturnType<typeof setup>['posted']) => p.filter((m): m is TaskCodeStateMessage => m.type === 'task.code.state');

  it('load: сначала loading, потом итог; повторный load без force — из кэша, без git', async () => {
    const s = setup();
    s.code.handle(TASK, { type: 'task.code.load' });
    await settle();
    const st = states(s.posted);
    expect(st[0]).toMatchObject({ taskKey: TASK, loading: true, repos: [] });
    expect(st[1]!.loading).toBeUndefined();
    expect(st[1]!.repos[0]!.root).toBe('/w/r');
    expect(s.code.loaded(TASK)).toBe(true);
    const calls = s.git.calls.length;
    s.code.handle(TASK, { type: 'task.code.load' });
    await settle();
    expect(s.git.calls.length).toBe(calls);
    expect(states(s.posted)).toHaveLength(3);
    s.code.handle(TASK, { type: 'task.code.load', force: true });
    await settle();
    expect(s.git.calls.length).toBeGreaterThan(calls);
    expect(states(s.posted)[3]).toMatchObject({ loading: true });
    expect(states(s.posted)[3]!.repos).toHaveLength(1); // прежний итог остаётся, пока грузится новый
  });

  it('refresh: без загрузки вкладки — ничего; после — тихо, без loading', async () => {
    const s = setup();
    s.code.refresh(TASK);
    await settle();
    expect(s.posted).toEqual([]);
    s.code.handle(TASK, { type: 'task.code.load' });
    await settle();
    s.posted.length = 0;
    s.code.refresh(TASK);
    await settle();
    expect(states(s.posted)).toHaveLength(1);
    expect(states(s.posted)[0]!.loading).toBeUndefined();
  });

  it('commit и diff принимают только корни последнего состояния; ответы на diff несут req', async () => {
    const s = setup();
    s.code.handle(TASK, { type: 'task.code.commit', root: '/w/r', sha: SHA2 });
    s.code.handle(TASK, { type: 'task.code.diff', req: 1, root: '/w/r', target: { kind: 'wip', path: 'src/a.ts' } });
    await settle();
    expect(s.posted).toEqual([]); // ещё ничего не загружено

    s.code.handle(TASK, { type: 'task.code.load' });
    await settle();
    s.posted.length = 0;
    s.code.handle(TASK, { type: 'task.code.commit', root: '/not/mine', sha: SHA2 });
    s.code.handle(TASK, { type: 'task.code.diff', req: 2, root: '/not/mine', target: { kind: 'wip', path: 'a' } });
    await settle();
    expect(s.posted).toEqual([]);

    s.code.handle(TASK, { type: 'task.code.commit', root: '/w/r', sha: SHA2 });
    s.code.handle(TASK, { type: 'task.code.diff', req: 7, root: '/w/r', target: { kind: 'wip', path: 'src/a.ts' } });
    await settle();
    expect(s.posted).toContainEqual({ type: 'task.code.commit', root: '/w/r', sha: SHA2, files: [{ path: 'a.ts', status: 'M', add: 1, del: 1 }] });
    const d = s.posted.find((m): m is TaskCodeDiffMessage => m.type === 'task.code.diff')!;
    expect(d.req).toBe(7);
    expect(d.patch!.hunks).toHaveLength(1);
  });

  it('ошибка git в diff — в error с тем же req', async () => {
    const s = setup();
    s.code.handle(TASK, { type: 'task.code.load' });
    await settle();
    s.posted.length = 0;
    // ветка/база не из итога репо — запрос игнорируется
    s.code.handle(TASK, { type: 'task.code.diff', req: 2, root: '/w/r', target: { kind: 'branch', base: 'x', branch: 'y', path: 'a' } });
    await settle();
    expect(s.posted).toEqual([]);
    s.code.handle(TASK, {
      type: 'task.code.diff',
      req: 3,
      root: '/w/r',
      target: { kind: 'branch', base: 'origin/develop', branch: 'feature/GARM-87-x', path: 'a' },
    });
    await settle();
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0]).toMatchObject({ type: 'task.code.diff', req: 3 });
    expect((s.posted[0] as TaskCodeDiffMessage).error).toContain('fatal');
  });

  it('reset: летящая загрузка не публикуется, корни забыты', async () => {
    let release!: () => void;
    const s = setup({ delay: new Promise<void>((r) => (release = r)) });
    s.code.handle(TASK, { type: 'task.code.load' });
    await settle();
    s.code.reset();
    release();
    await settle();
    expect(states(s.posted)).toHaveLength(1); // только loading
    expect(s.code.loaded(TASK)).toBe(false);
  });

  it('история чата с тем же updatedAt берётся из кэша; reset кэш сбрасывает', async () => {
    const history = vi.fn(async () => [edit('src/a.ts'), { type: 'text.delta' }]);
    const git = fakeRun(repoHandlers());
    const code = new TaskCode({
      run: git.run,
      repos: async () => ['/w/r'],
      history,
      readText: async () => ({ text: 'x\n' }),
      cwd: () => '/w/r',
      chats: async () => [{ ...chat1, updatedAt: 5 }],
      post: () => {},
      prefill: () => {},
      copy: () => {},
    });
    code.handle(TASK, { type: 'task.code.load' });
    await settle();
    code.handle(TASK, { type: 'task.code.load', force: true });
    await settle();
    expect(history).toHaveBeenCalledTimes(1);
    code.reset();
    code.handle(TASK, { type: 'task.code.load' });
    await settle();
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('prefill и copy идут в зависимости', () => {
    const s = setup();
    s.code.handle(TASK, { type: 'task.code.prefill', text: 'abc123 subject' });
    s.code.handle(TASK, { type: 'task.code.copy', text: SHA1 });
    expect(s.prefill).toHaveBeenCalledWith('abc123 subject');
    expect(s.copy).toHaveBeenCalledWith(SHA1);
  });
});
