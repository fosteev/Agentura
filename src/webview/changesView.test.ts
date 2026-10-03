import { describe, expect, it } from 'vitest';
import type { FeedRow } from './chatState';
import { changesView, isCheckCommand } from './changesView';

const cwd = '/p';
let n = 0;
const user = (): FeedRow => ({ id: ++n, kind: 'user', text: 'q' });
const tool = (
  name: string,
  input: Record<string, unknown>,
  extra: Partial<Extract<FeedRow, { kind: 'tool' }>> = {},
): FeedRow => ({
  id: ++n,
  kind: 'tool',
  toolUseId: `t${n}`,
  name,
  input,
  startedAt: 1000,
  state: 'ok',
  ...extra,
});
const edit = (file: string, o = 'a', nw = 'b\nc', extra = {}) =>
  tool('Edit', { file_path: `${cwd}/${file}`, old_string: o, new_string: nw }, extra);
const view = (rows: FeedRow[], scope: 'session' | 'turn' = 'session') =>
  changesView(rows, { scope, now: 5000, cwd });

describe('changesView', () => {
  it('пусто: нет правок — нет папок и бейджа', () => {
    const v = view([user(), tool('Read', { file_path: '/p/a.ts' })]);
    expect(v.dirs).toEqual([]);
    expect(v.fileCount).toBe(0);
    expect(v.badge).toBeUndefined();
  });

  it('группирует по папкам относительно cwd, суммирует +/− по правкам файла', () => {
    const v = view([
      user(),
      edit('src/a.ts'), // +2 −1
      edit('src/b.ts'),
      edit('src/a.ts'), // ещё +2 −1
      edit('README.md'),
    ]);
    expect(v.dirs.map((d) => d.dir)).toEqual(['src/', '']);
    const a = v.dirs[0]!.files[0]!;
    expect(a).toMatchObject({ path: 'src/a.ts', base: 'a.ts', stats: { add: 4, del: 2 } });
    expect(a.ids).toHaveLength(2);
    expect(v.fileCount).toBe(3);
    expect(v.add).toBe(8);
    expect(v.del).toBe(4);
    expect(v.ids).toHaveLength(4);
    expect(v.badge).toEqual({ count: 3, live: false });
  });

  it('номера ходов: счётчик user-строк, до первого — ход 1', () => {
    const v = view([edit('a.ts'), user(), edit('b.ts'), user(), edit('a.ts'), edit('c.ts')]);
    const files = v.dirs[0]!.files;
    expect(files.find((f) => f.path === 'a.ts')!.turns).toEqual([1, 2]);
    expect(files.find((f) => f.path === 'b.ts')!.turns).toEqual([1]);
    expect(v.lastTurn).toBe(2);
  });

  it('«новый»: первая правка в охвате — Write с result.type create', () => {
    const v = view([
      user(),
      tool('Write', { file_path: '/p/n.ts', content: 'x\ny' }, { result: { type: 'create' } }),
      edit('n.ts'),
      tool('Write', { file_path: '/p/o.ts', content: 'x' }, { result: { type: 'update' } }),
    ]);
    const f = v.dirs[0]!.files;
    expect(f[0]).toMatchObject({ path: 'n.ts', isNew: true });
    expect(f[1]).toMatchObject({ path: 'o.ts', isNew: false });
  });

  it('err/stopped правки не считаются; MultiEdit без патча — без цифр', () => {
    const v = view([
      user(),
      edit('bad.ts', 'a', 'b', { state: 'err' }),
      edit('bad2.ts', 'a', 'b', { state: 'stopped' }),
      tool('MultiEdit', { file_path: '/p/m.ts', edits: [] }),
    ]);
    expect(v.dirs[0]!.files.map((f) => f.path)).toEqual(['m.ts']);
    expect(v.dirs[0]!.files[0]!.stats).toBeUndefined();
    expect(v.add).toBe(0);
  });

  it('live: в последнем ходе идёт Edit/Write', () => {
    const rows = [user(), edit('a.ts'), user(), edit('b.ts', 'a', 'b', { state: 'run' })];
    expect(view(rows).badge).toEqual({ count: 2, live: true });
    expect(view(rows).dirs[0]!.files[1]!.live).toBe(true);
    // идущая правка в предыдущем ходе — не live
    const old = [user(), edit('a.ts', 'a', 'b', { state: 'run' }), user()];
    expect(view(old).badge).toEqual({ count: 1, live: false });
  });

  it('сообщение «в очереди» не начинает новый ход', () => {
    const queued: FeedRow = { id: ++n, kind: 'user', text: 'потом', queued: true };
    const rows = [user(), edit('a.ts', 'a', 'b', { state: 'run' }), queued];
    const v = view(rows, 'turn');
    expect(v.lastTurn).toBe(1);
    expect(v.dirs[0]!.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(v.badge).toEqual({ count: 1, live: true });
    // строки после очереди (ход ещё тот же) — тоже ход 1
    expect(view([...rows, edit('b.ts')]).dirs[0]!.files[1]!.turns).toEqual([1]);
  });

  it('охват «ход»: только правки последнего хода, бейдж — по всей сессии', () => {
    const rows = [user(), edit('a.ts'), user(), edit('b.ts')];
    const v = view(rows, 'turn');
    expect(v.dirs[0]!.files.map((f) => f.path)).toEqual(['b.ts']);
    expect(v.ids).toHaveLength(1);
    expect(v.badge).toEqual({ count: 2, live: false });
    expect(view([user(), edit('a.ts'), user()], 'turn').fileCount).toBe(0);
  });

  describe('проверки', () => {
    it('регэксп по командам', () => {
      for (const c of [
        'npm test',
        'pnpm vitest run',
        'npx jest',
        'pytest -q',
        'cargo test',
        'go test ./...',
        'npm run lint',
        'tsc --noEmit',
        'npm run check',
        'npx playwright test',
        'pnpm e2e',
        'npm run test:unit',
        'python -m pytest tests/',
        'uv run pytest',
        'make lint',
        './node_modules/.bin/vitest run',
        'cd /p && CI=1 timeout 60 npm test 2>&1 | tail -30',
        'npm run check > /tmp/check.log 2>&1; tail -40 /tmp/check.log',
      ])
        expect(isCheckCommand(c), c).toBe(true);
      for (const c of [
        'ls -la',
        'git status',
        'npm run build',
        'cat latest.txt',
        // слово-проверка не программой — не проверка
        'ls test/',
        'git checkout main',
        'git commit -m "fix test"',
        'cat tsconfig.json',
        'grep -rn check src',
        'mkdir -p tests',
        'npm install -D vitest',
        'rg lint',
        'npx playwright install chromium',
      ])
        expect(isCheckCommand(c), c).toBe(false);
    });

    it('последний прогон команды, новые сверху, статусы и номер хода', () => {
      const v = view([
        user(),
        tool('Bash', { command: 'npm test' }, { state: 'err', durationMs: 2000 }),
        tool('Bash', { command: 'ls' }),
        tool('Bash', { command: 'npm run lint ' }, { durationMs: 900 }),
        user(),
        tool('Bash', { command: 'npm test' }, { durationMs: 3100 }),
        tool('Bash', { command: 'npm run check' }, { state: 'run', startedAt: 2000 }),
      ]);
      expect(v.checks).toEqual([
        { command: 'npm run check', state: 'run', ms: 3000, turn: 2 },
        { command: 'npm test', state: 'ok', ms: 3100, turn: 2 },
        { command: 'npm run lint', state: 'ok', ms: 900, turn: 1 },
      ]);
    });

    it('не больше 6', () => {
      const rows = [user()];
      for (let i = 0; i < 9; i++) rows.push(tool('Bash', { command: `npm test -- ${i}` }));
      const v = view(rows);
      expect(v.checks).toHaveLength(6);
      expect(v.checks[0]!.command).toBe('npm test -- 8');
    });

    it('не зависят от охвата', () => {
      const rows = [user(), tool('Bash', { command: 'npm test' }), user()];
      expect(view(rows, 'turn').checks).toHaveLength(1);
    });

    it('фоновый запуск (run_in_background) — не проверка: исхода в строке нет', () => {
      const rows = [user(), tool('Bash', { command: 'npm test', run_in_background: true })];
      expect(view(rows).checks).toEqual([]);
    });
  });
});
