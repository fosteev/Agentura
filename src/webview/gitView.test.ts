import { describe, expect, it } from 'vitest';
import type { GitFileView, GitRepoView, GitSnapshot } from '../shared/git';
import {
  agentCount,
  agentPathSet,
  commitButton,
  commitMessage,
  commitWhen,
  cwdPath,
  fileRows,
  gitBadge,
  isAgentFile,
  sectionRows,
  summaryLeft,
  syncView,
  totalCount,
} from './gitView';

const f = (path: string, status: GitFileView['status'] = 'M', extra: Partial<GitFileView> = {}) =>
  ({ path, status, ...extra }) as GitFileView;

function repo(over: Partial<GitRepoView> = {}): GitRepoView {
  return {
    root: '/w',
    rel: '',
    name: 'w',
    branch: 'main',
    published: true,
    unstaged: [],
    staged: [],
    log: [],
    ...over,
  };
}

const snap = (...repos: GitRepoView[]): GitSnapshot => ({ state: 'ok', repos });

describe('cwdPath и метка агента', () => {
  const at = (rel: string, root = '/w') => ({ root, rel });
  it('без cwd: rel склеивается и нормализуется', () => {
    expect(cwdPath(at(''), 'src/a.ts')).toBe('src/a.ts');
    expect(cwdPath(at('board'), 'src/a.ts')).toBe('board/src/a.ts');
    expect(cwdPath(at('..'), 'sub/a.ts')).toBe('../sub/a.ts');
    expect(cwdPath(at('a/./b'), '../c.ts')).toBe('a/c.ts');
  });

  it('с cwd: путь по абсолютным; cwd глубже корня репо — файл внутри cwd помечается', () => {
    // cwd = /w/sub, корень репо /w (rel '..'): sub/a.ts репо — это a.ts от cwd
    expect(cwdPath(at('..'), 'sub/a.ts', '/w/sub')).toBe('a.ts');
    expect(isAgentFile(at('..'), 'sub/a.ts', new Set(['a.ts']), '/w/sub')).toBe(true);
    expect(isAgentFile(at('..'), 'other/a.ts', new Set(['a.ts']), '/w/sub')).toBe(false);
    // вложенный репозиторий под cwd
    expect(
      isAgentFile(at('board', '/w/board'), 'src/a.ts', new Set(['board/src/a.ts']), '/w'),
    ).toBe(true);
    // cwd с хвостовым слешем и обратными слешами
    expect(cwdPath(at('', 'C:\\w'), 'a.ts', 'C:\\w\\')).toBe('a.ts');
  });

  it('файл вне cwd агентом не помечается, даже если имя совпало', () => {
    expect(isAgentFile(at('..'), 'x/a.ts', new Set(['x/a.ts']))).toBe(false);
    expect(isAgentFile(at('../..'), 'x/a.ts', new Set(['x/a.ts', '../../x/a.ts']))).toBe(false);
    expect(isAgentFile(at('..'), 'x/a.ts', new Set(['x/a.ts']), '/w/sub')).toBe(false);
  });

  it('agentPathSet склеивает папку и имя из changesView', () => {
    const set = agentPathSet([
      { dir: 'src/', files: [{ base: 'a.ts' }, { base: 'b.ts' }] },
      { dir: '', files: [{ base: 'README.md' }] },
    ]);
    expect([...set].sort()).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  });
});

describe('строки «путь» и «дерево»', () => {
  const r = repo({ rel: 'board' });
  const files = [
    f('src/z.ts', 'A', { add: 3 }),
    f('README.md', 'M'),
    f('src/deep/x.ts', 'U', { add: 1, del: 2 }),
    f('src/a.ts', 'M'),
  ];
  const agent = new Set(['board/src/a.ts']);

  it('путь: сортировка по пути, папка с «/», метка агента', () => {
    const rows = fileRows(files, r, agent);
    expect(rows.map((x) => x.path)).toEqual(['README.md', 'src/a.ts', 'src/deep/x.ts', 'src/z.ts']);
    expect(rows.map((x) => x.dir)).toEqual(['', 'src/', 'src/deep/', 'src/']);
    expect(rows.map((x) => x.agent)).toEqual([false, true, false, false]);
    expect(rows[2]).toMatchObject({ base: 'x.ts', status: 'U', add: 1, del: 2 });
  });

  it('фильтр «агент» оставляет только помеченные', () => {
    expect(fileRows(files, r, agent, true).map((x) => x.path)).toEqual(['src/a.ts']);
  });

  it('дерево: папки отдельными строками один раз, файлы с отступом', () => {
    const rows = sectionRows(fileRows(files, r, agent), true);
    expect(
      rows.map((x) => (x.kind === 'dir' ? `d:${x.path}@${x.level}` : `f:${x.path}@${x.level}`)),
    ).toEqual([
      'f:README.md@0',
      'd:src@0',
      'f:src/a.ts@1',
      'd:src/deep@1',
      'f:src/deep/x.ts@2',
      'f:src/z.ts@1',
    ]);
  });
});

describe('счётчики и бейдж', () => {
  const a = repo({ unstaged: [f('a')], staged: [f('b'), f('c')] });
  const b = repo({ root: '/w/b', rel: 'b', unstaged: [f('x/y.ts')] });
  it('число файлов по всем репо; агентских — по меткам', () => {
    expect(totalCount(snap(a, b))).toBe(4);
    expect(agentCount(snap(a, b), new Set(['a', 'b/x/y.ts']))).toBe(2);
  });
  it('бейдж: нет без снимка, не-ok и при нуле', () => {
    expect(gitBadge(undefined)).toBeUndefined();
    expect(gitBadge({ state: 'none', repos: [] })).toBeUndefined();
    expect(gitBadge({ state: 'unavailable', reason: 'x', repos: [a] })).toBeUndefined();
    expect(gitBadge(snap(repo()))).toBeUndefined();
    expect(gitBadge(snap(a, b))).toEqual({ count: 4 });
  });
});

describe('коммит', () => {
  it('сообщение: заголовок, пустая строка, описание', () => {
    expect(commitMessage(' Fix  ', '')).toBe('Fix');
    expect(commitMessage('Fix', ' body \n')).toBe('Fix\n\nbody');
  });
  it('счётчик 72 − длина, меньше нуля — over', () => {
    expect(summaryLeft('abc')).toEqual({ left: 69, over: false });
    expect(summaryLeft('x'.repeat(72))).toEqual({ left: 0, over: false });
    expect(summaryLeft('x'.repeat(75))).toEqual({ left: -3, over: true });
  });
  it('кнопка: индекс пуст → неактивна, пустое сообщение → неактивна, busy → неактивна', () => {
    const staged = repo({ staged: [f('a'), f('b')], unstaged: [f('c')] });
    expect(commitButton(staged, { message: 'm', amend: false })).toEqual({
      disabled: false,
      files: 2,
      branch: 'main',
    });
    expect(commitButton(staged, { message: ' ', amend: false })).toMatchObject({
      disabled: true,
      why: 'empty-message',
    });
    expect(
      commitButton(repo({ unstaged: [f('c')] }), { message: 'm', amend: false }),
    ).toMatchObject({
      disabled: true,
      why: 'empty-index',
    });
    // «всех изменений» не требует индекса
    expect(
      commitButton(repo({ unstaged: [f('c')] }), { message: 'm', amend: false, all: true }),
    ).toMatchObject({ disabled: false, files: 1 });
    // amend с пустым индексом — переписать сообщение
    expect(commitButton(repo(), { message: 'm', amend: true }).disabled).toBe(false);
    expect(
      commitButton({ ...staged, busy: 'commit' }, { message: 'm', amend: false }),
    ).toMatchObject({
      disabled: true,
      why: 'busy',
    });
  });
});

describe('синхронизация и время', () => {
  it('syncView: числа по умолчанию 0, unpublished из published', () => {
    expect(syncView(repo({ ahead: 2 }))).toEqual({ unpublished: false, ahead: 2, behind: 0 });
    expect(syncView(repo({ published: false }))).toMatchObject({ unpublished: true });
  });
  it('commitWhen: сегодня — часы, иначе дата, 0 — пусто', () => {
    const now = new Date(2026, 9, 4, 15, 0).getTime();
    expect(commitWhen(new Date(2026, 9, 4, 9, 5).getTime(), now)).toBe('09:05');
    expect(commitWhen(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('01.10');
    expect(commitWhen(0, now)).toBe('');
  });
});
