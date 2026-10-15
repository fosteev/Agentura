import { describe, expect, it } from 'vitest';
import type { CodeBranch, CodeRepo, TaskCodeStateMessage } from '../shared/task';
import {
  branchSet,
  codeCount,
  commitSet,
  dirtySet,
  howCommands,
  repoHasContent,
  splitPath,
  stepIndex,
  visibleBranches,
} from './taskCodeView';

const KEY = 'jira:inst:NEWMFC-1482';
const br = (name: string, ahead: number): CodeBranch => ({
  name,
  ahead,
  add: ahead ? 5 : 0,
  del: 0,
  files: ahead ? [{ path: 'a.ts', status: 'M', add: 5, del: 0 }] : [],
});
const repo = (over: Partial<CodeRepo> = {}): CodeRepo => ({
  root: '/r/eq',
  name: 'eq',
  base: 'origin/develop',
  branches: [],
  commits: [],
  dirty: [],
  ...over,
});
const commit = (sha: string) => ({ sha, short: sha.slice(0, 7), subject: 's', author: 'a', at: 1, src: 'key' as const });
const st = (repos: CodeRepo[], over: Partial<TaskCodeStateMessage> = {}): TaskCodeStateMessage => ({
  type: 'task.code.state',
  taskKey: KEY,
  repos,
  ...over,
});

describe('taskCodeView', () => {
  it('число у вкладки: коммиты + незакоммиченные; не загружено, другая задача, первая загрузка — без числа', () => {
    const r = repo({
      commits: [commit('aaaaaaa1'), commit('bbbbbbb2')],
      dirty: [{ path: 'x', status: 'M', chats: [] }],
    });
    expect(codeCount(st([r, repo({ root: '/r/api', commits: [commit('ccccccc3')] })]), KEY)).toBe(4);
    expect(codeCount(undefined, KEY)).toBeUndefined();
    expect(codeCount(st([r]), 'jira:inst:OTHER-1')).toBeUndefined();
    expect(codeCount(st([], { loading: true }), KEY)).toBeUndefined();
    expect(codeCount(st([r], { loading: true }), KEY)).toBe(3);
    expect(codeCount(st([]), KEY)).toBe(0);
  });

  it('ветки: при известной базе ahead 0 не показываем; без базы — только имя', () => {
    const r = repo({ branches: [br('feature/X', 3), br('old/X', 0)] });
    expect(visibleBranches(r).map((b) => b.name)).toEqual(['feature/X']);
    const nb = repo({ base: undefined, branches: [br('feature/X', 0)] });
    expect(visibleBranches(nb).map((b) => b.name)).toEqual(['feature/X']);
    expect(repoHasContent(repo({ branches: [br('old/X', 0)] }))).toBe(false);
    expect(repoHasContent(repo({ error: 'boom' }))).toBe(true);
  });

  it('команды «как ищем?»: ключ задачи; база и ветка — плейсхолдеры, не данные репо', () => {
    const c = howCommands(KEY);
    expect(c.key).toBe('NEWMFC-1482');
    expect(c.log).toBe(`git log --all -i --grep='NEWMFC-1482' --format='%h %an %s'`);
    expect(c.branches).toBe(`git branch -a --list '*NEWMFC-1482*'`);
    expect(c.ahead).toBe('git log --oneline <база>..<ветка>');
    // ключ не разобрался — запасной пример
    expect(howCommands(undefined).key).toBe('KEY-123');
  });

  it('наборы файлов: цели диффа коммита, ветки и незакоммиченного', () => {
    const files = [{ path: 'a/b.ts', status: 'M' as const, add: 1, del: 2 }];
    expect(commitSet('/r', 'abc1234', 'abc1234', files).items[0]!.target).toEqual({ kind: 'commit', sha: 'abc1234', path: 'a/b.ts' });
    expect(branchSet('/r', 'origin/develop', br('f/X', 1)).items[0]!.target).toEqual({
      kind: 'branch',
      base: 'origin/develop',
      branch: 'f/X',
      path: 'a.ts',
    });
    expect(dirtySet('/r', files).items[0]!.target).toEqual({ kind: 'wip', path: 'a/b.ts' });
  });

  it('вспомогательные: путь и шаг по набору без перехода через край', () => {
    expect(splitPath('a/b/c.ts')).toEqual(['a/b/', 'c.ts']);
    expect(splitPath('c.ts')).toEqual(['', 'c.ts']);
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});
