import { describe, expect, it } from 'vitest';
import { FakeAppServer } from './fakeServer';
import { CodexRpcError } from './client';
import { isCodexAuthError, parseCodexLimits, readCodexLimits } from './limits';
import type { CodexAccountResponse, CodexRateLimitsResponse } from './protocol';

const main = {
  limitId: 'codex',
  primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1791380292 },
  secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791967092 },
  planType: 'plus',
};
const RATE: CodexRateLimitsResponse = { rateLimits: main, rateLimitsByLimitId: { codex: main } };
const ACCOUNT: CodexAccountResponse = { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true };

describe('parseCodexLimits', () => {
  it('5 ч и неделя, секунды → мс, аккаунт и план с заглавной', () => {
    expect(parseCodexLimits(RATE, ACCOUNT)).toEqual({
      signedIn: true,
      email: 'a@b.c',
      plan: 'Plus',
      windows: [
        { kind: 'fiveHour', percent: 4, resetsAt: 1791380292_000 },
        { kind: 'weekly', percent: 1, resetsAt: 1791967092_000 },
      ],
    });
  });

  it('доп. лимиты из rateLimitsByLimitId (кроме codex): имя без префикса codex_, limitName в приоритете', () => {
    const rate: CodexRateLimitsResponse = {
      ...RATE,
      rateLimitsByLimitId: {
        codex: main,
        codex_bengalfox: { limitId: 'codex_bengalfox', primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1791380292 } },
        other: { limitId: 'other', limitName: 'GPT-5 Spark', primary: { usedPercent: 50, windowDurationMins: 300 }, secondary: { usedPercent: 7, windowDurationMins: 10080 } },
      },
    };
    expect(parseCodexLimits(rate, ACCOUNT).windows.slice(2)).toEqual([
      { kind: 'model', name: 'bengalfox', percent: 12, resetsAt: 1791380292_000 },
      { kind: 'model', name: 'GPT-5 Spark', percent: 50 },
      { kind: 'model', name: 'GPT-5 Spark 7d', percent: 7 },
    ]);
  });

  it('account: null — не вошли, окон нет', () => {
    expect(parseCodexLimits(undefined, { account: null, requiresOpenaiAuth: true })).toEqual({ signedIn: false, windows: [] });
  });

  it('процент зажат в 0…100; план берётся из лимитов, если аккаунт его не дал', () => {
    const rate: CodexRateLimitsResponse = { rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300 }, planType: 'pro' } };
    const r = parseCodexLimits(rate, { account: { type: 'chatgpt', email: null, planType: null } });
    expect(r.plan).toBe('Pro');
    expect(r.windows[0]!.percent).toBe(100);
    expect(r.email).toBeUndefined();
  });
});

describe('isCodexAuthError', () => {
  it('узнаёт ошибки входа и не путает с прочими', () => {
    expect(isCodexAuthError(new CodexRpcError('Not logged in: please login'))).toBe(true);
    expect(isCodexAuthError(new Error('HTTP 401'))).toBe(true);
    expect(isCodexAuthError(new Error('socket hang up'))).toBe(false);
    expect(isCodexAuthError('auth')).toBe(false);
  });
});

describe('readCodexLimits', () => {
  const run = (server: FakeAppServer) =>
    readCodexLimits('/bin/codex', { spawn: () => server });

  it('handshake, оба запроса, разбор', async () => {
    const server = new FakeAppServer()
      .handle('initialize', () => ({}))
      .handle('account/read', () => ACCOUNT)
      .handle('account/rateLimits/read', () => RATE);
    const res = await run(server);
    expect(res.plan).toBe('Plus');
    expect(res.windows).toHaveLength(2);
    expect(server.methods()).toEqual(expect.arrayContaining(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']));
    expect(server.paramsOf('account/read')).toEqual({ refreshToken: false });
  });

  it('account: null → signedIn false, без ошибки', async () => {
    const server = new FakeAppServer()
      .handle('initialize', () => ({}))
      .handle('account/read', () => ({ account: null, requiresOpenaiAuth: true }))
      .handle('account/rateLimits/read', () => {
        throw new Error('codex account authentication required to read rate limits');
      });
    expect(await run(server)).toEqual({ signedIn: false, windows: [] });
  });
});
