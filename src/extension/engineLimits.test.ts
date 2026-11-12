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
  const rows = [{ label: 'Gemini 7д', name: 'Gemini Models', remaining: 26, resetsAt: 7 }];
  it('остаток → израсходовано', () => {
    expect(summarizeAgy({ state: 'ok', rows, updatedAt: 5 }, true)).toEqual({
      engine: 'antigravity',
      state: 'ok',
      windows: [{ kind: 'model', name: 'Gemini 7д', percent: 74, resetsAt: 7 }],
      updatedAt: 5,
    });
  });
  it('missing / loading / signedOut / error', () => {
    expect(summarizeAgy({ state: 'ok', rows, updatedAt: 5 }, false).state).toBe('missing');
    expect(summarizeAgy({ state: 'loading', rows: [], updatedAt: 0 }, true).state).toBe('loading');
    expect(summarizeAgy({ state: 'signedOut', rows: [], updatedAt: 5 }, true)).toMatchObject({
      state: 'signedOut',
      windows: [],
    });
    // Сбой на холодном старте (updatedAt === 0) не маскируется под вечный loading
    expect(
      summarizeAgy({ state: 'error', rows: [], updatedAt: 0, error: 'Eligibility check failed' }, true, 'agy 1.5.6'),
    ).toEqual({
      engine: 'antigravity',
      state: 'error',
      version: 'agy 1.5.6',
      windows: [],
      updatedAt: 0,
      error: 'Eligibility check failed',
    });
    // Сбой после успешного опроса сохраняет прежние окна и добавляет error
    expect(summarizeAgy({ state: 'error', rows, updatedAt: 5, error: 'timeout' }, true)).toEqual({
      engine: 'antigravity',
      state: 'error',
      windows: [{ kind: 'model', name: 'Gemini 7д', percent: 74, resetsAt: 7 }],
      updatedAt: 5,
      error: 'timeout',
    });
  });

  it('сохраняет все 5 окон agy 1.5.3', () => {
    const rows5 = [
      { label: 'Gemini 7д', name: 'Gemini Models', remaining: 99 },
      { label: 'Gemini 5ч', name: 'Gemini Models', remaining: 97 },
      { label: 'Claude/GPT 7д', name: 'Claude and GPT models', remaining: 100 },
      { label: 'Claude/GPT 5ч', name: 'Claude and GPT models', remaining: 100 },
      { label: 'Gemini 4 Argon 7д', name: 'Gemini 4 Argon', remaining: 66 },
    ];
    const s = summarizeAgy({ state: 'ok', rows: rows5, updatedAt: 10 }, true);
    expect(s.windows.map((w) => [w.name, w.percent])).toEqual([
      ['Gemini 7д', 1],
      ['Gemini 5ч', 3],
      ['Claude/GPT 7д', 0],
      ['Claude/GPT 5ч', 0],
      ['Gemini 4 Argon 7д', 34],
    ]);
  });
});
