import { describe, expect, it } from 'vitest';
import { GIT_STATUS, gitStatus, isGitRequest } from './git';

describe('gitStatus', () => {
  it('буква по Status встроенного git', () => {
    const S = GIT_STATUS;
    expect(gitStatus(S.INDEX_MODIFIED)).toBe('M');
    expect(gitStatus(S.INDEX_ADDED)).toBe('A');
    expect(gitStatus(S.INDEX_DELETED)).toBe('D');
    expect(gitStatus(S.INDEX_RENAMED)).toBe('R');
    expect(gitStatus(S.INDEX_COPIED)).toBe('A');
    expect(gitStatus(S.MODIFIED)).toBe('M');
    expect(gitStatus(S.DELETED)).toBe('D');
    expect(gitStatus(S.UNTRACKED)).toBe('U');
    expect(gitStatus(S.INTENT_TO_ADD)).toBe('U');
    expect(gitStatus(S.INTENT_TO_RENAME)).toBe('R');
    expect(gitStatus(S.TYPE_CHANGED)).toBe('T');
  });

  it('все конфликты — C, игнорируемые и неизвестные не идут во вкладку', () => {
    const S = GIT_STATUS;
    for (const s of [
      S.ADDED_BY_US,
      S.ADDED_BY_THEM,
      S.DELETED_BY_US,
      S.DELETED_BY_THEM,
      S.BOTH_ADDED,
      S.BOTH_DELETED,
      S.BOTH_MODIFIED,
    ])
      expect(gitStatus(s)).toBe('C');
    expect(gitStatus(S.IGNORED)).toBeUndefined();
    expect(gitStatus(99)).toBeUndefined();
  });

  it('isGitRequest — по префиксу типа', () => {
    expect(isGitRequest({ type: 'git.stage' })).toBe(true);
    expect(isGitRequest({ type: 'send' })).toBe(false);
  });
});
