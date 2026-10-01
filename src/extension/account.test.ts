import { describe, expect, it, vi } from 'vitest';
import { AccountService, loginLabel, planLabel } from './account';

describe('planLabel / loginLabel', () => {
  it('план: Max с множителем из rateLimitTier, Pro без', () => {
    expect(planLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })).toBe(
      'Max 5×',
    );
    expect(planLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe(
      'Max 20×',
    );
    expect(planLabel({ subscriptionType: 'pro' })).toBe('Pro');
    // accountInfo() движка отдаёт «Claude Max» (проверено на живом движке)
    expect(
      planLabel({ subscriptionType: 'Claude Max', rateLimitTier: 'default_claude_max_5x' }),
    ).toBe('Max 5×');
    expect(planLabel({ subscriptionType: 'Claude Max 5×' })).toBe('Max 5×');
    expect(planLabel({})).toBeUndefined();
  });
  it('вход: через CLI, ключ API', () => {
    expect(loginLabel({})).toBe('через CLI · ок');
    expect(loginLabel({ tokenSource: 'none' })).toBe('через CLI · ок');
    expect(loginLabel({ tokenSource: 'ANTHROPIC_API_KEY' })).toBe('ключ API');
  });
});

describe('AccountService', () => {
  const info = { email: 'a@b.c', subscriptionType: 'max', tokenSource: 'none' };

  it('собирает аккаунт, план и версию движка; кэширует', async () => {
    const accountInfo = vi.fn(async () => info);
    const svc = new AccountService({
      accountInfo,
      readPlan: async () => ({ rateLimitTier: 'default_claude_max_5x' }),
      savedEngine: 'claude 2.1.284',
    });
    expect(await svc.get()).toEqual({
      email: 'a@b.c',
      plan: 'Max 5×',
      login: 'через CLI · ок',
      engine: 'claude 2.1.284',
    });
    await svc.get();
    expect(accountInfo).toHaveBeenCalledTimes(1);
    const updates: unknown[] = [];
    svc.onUpdate((a) => updates.push(a));
    svc.noteEngine('2.1.285');
    expect(updates).toHaveLength(1);
    expect((await svc.get()).engine).toBe('claude 2.1.285');
  });

  it('accountInfo упал — ошибка в сводке, план из учётных данных остаётся, повтор не ждёт TTL', async () => {
    let fail = true;
    const accountInfo = vi.fn(async () => {
      if (fail) throw new Error('движок не ответил');
      return info;
    });
    const svc = new AccountService({
      accountInfo,
      readPlan: async () => ({ subscriptionType: 'max', rateLimitTier: 'x_5x' }),
    });
    expect(await svc.get()).toEqual({ error: 'движок не ответил', plan: 'Max 5×' });
    fail = false;
    expect((await svc.get()).email).toBe('a@b.c');
    expect(accountInfo).toHaveBeenCalledTimes(2);
  });
});
