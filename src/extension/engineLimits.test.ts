import { describe, expect, it } from 'vitest';
import { summarizeAgy, summarizeCodex } from './engineLimits';

describe('summarizeCodex', () => {
  it('переносит аккаунт, окна и версию', () => {
    expect(
      summarizeCodex(
        { state: 'ok', email: 'a@b.c', plan: 'Plus', windows: [{ kind: 'fiveHour', percent: 4, resetsAt: 5 }, { kind: 'model', name: 'x', percent: 1 }], updatedAt: 9 },
        'codex 0.160.0',
      ),
    ).toEqual({
      engine: 'codex',
      state: 'ok',
      email: 'a@b.c',
      plan: 'Plus',
      version: 'codex 0.160.0',
      windows: [{ kind: 'fiveHour', percent: 4, resetsAt: 5 }, { kind: 'model', name: 'x', percent: 1 }],
      updatedAt: 9,
    });
  });

  it('ошибка и состояние проходят как есть', () => {
    expect(summarizeCodex({ state: 'error', windows: [], updatedAt: 1, error: 'boom' })).toMatchObject({ state: 'error', error: 'boom', windows: [] });
  });
});

describe('summarizeAgy', () => {
  const rows = [{ label: 'Gemini', name: 'Gemini Models', remaining: 26, resetsAt: 7 }];
  it('остаток → израсходовано', () => {
    expect(summarizeAgy({ rows, updatedAt: 5 }, true)).toEqual({
      engine: 'antigravity',
      state: 'ok',
      windows: [{ kind: 'model', name: 'Gemini', percent: 74, resetsAt: 7 }],
      updatedAt: 5,
    });
  });
  it('missing / loading / signedOut', () => {
    expect(summarizeAgy({ rows, updatedAt: 5 }, false).state).toBe('missing');
    expect(summarizeAgy({ rows: [], updatedAt: 0 }, true).state).toBe('loading');
    expect(summarizeAgy({ rows: [], updatedAt: 5 }, true)).toMatchObject({ state: 'signedOut', windows: [] });
  });
});
