import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cost, modelKey, priceFor, PRICES } from './pricing';

const logs = join(__dirname, '..', '..', 'spikes', 'sdk-probe', 'logs');

function results(name: string): Record<string, unknown>[] {
  return readFileSync(join(logs, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l['type'] === 'result');
}

describe('pricing', () => {
  it('имена моделей с суффиксами провайдеров', () => {
    expect(priceFor('claude-opus-5-5')?.input).toBe(4);
    expect(priceFor('claude-opus-5-5[1m]')?.input).toBe(4);
    expect(priceFor('claude-haiku-4-5-20251001')?.output).toBe(5);
    expect(priceFor('us.anthropic.claude-sonnet-5-5')?.cacheRead).toBe(0.2);
    expect(priceFor('claude-sonnet-5-5@20260101')?.input).toBe(2);
    expect(priceFor('gpt-5')).toBeUndefined();
    expect(cost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 'unknown')).toBeUndefined();
  });

  it('совпадает с modelUsage.costUSD движка (главный разговор пишет кэш на 1 ч)', () => {
    // 01-basic-control: итог сессии — Sonnet 5.5 и Opus 5.5 в одном modelUsage.
    const last = results('01-basic-control').at(-1) as {
      modelUsage: Record<string, Record<string, number>>;
    };
    for (const [model, u] of Object.entries(last.modelUsage)) {
      const usd = cost(
        {
          input: u['inputTokens'] ?? 0,
          output: u['outputTokens'] ?? 0,
          cacheRead: u['cacheReadInputTokens'] ?? 0,
          cacheWrite: u['cacheCreationInputTokens'] ?? 0,
          cacheWrite1h: u['cacheCreationInputTokens'] ?? 0,
        },
        model,
      );
      expect(usd, model).toBeCloseTo(u['costUSD'] ?? NaN, 7);
    }
  });

  it('разбивка записи кэша 5m/1h: субагенты пишут на 5 минут', () => {
    // Субагент Sonnet 5.5: 2 ввода, 7 442 записи 5 мин, 16 вывода.
    const usd = cost(
      { input: 2, output: 16, cacheRead: 0, cacheWrite: 7442, cacheWrite5m: 7442, cacheWrite1h: 0 },
      'claude-sonnet-5-5',
    );
    expect(usd).toBeCloseTo((2 * 2 + 16 * 10 + 7442 * 2.5) / 1e6, 10);
    // Без разбивки — по 5-минутной цене.
    expect(
      cost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 }, 'claude-opus-5-5'),
    ).toBeCloseTo(0.005, 10);
  });

  it('каталог моделей CLI 2.1.285 весь с ценами; имена с датой и алиасы находятся', () => {
    const catalog = [
      'claude-3-5-haiku',
      'claude-3-5-sonnet',
      'claude-3-7-sonnet',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-mythos-5',
      'claude-mythos-5-1',
      'claude-opus-4-0',
      'claude-opus-4-1',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-4-0',
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
    ];
    expect(catalog.filter((m) => !PRICES[m])).toEqual([]);
    expect(modelKey('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-0');
    expect(modelKey('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(modelKey('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
    expect(modelKey('claude-3-5-haiku-latest')).toBe('claude-3-5-haiku');
    expect(modelKey('anthropic.claude-opus-4-20250514-v1:0')).toBe('claude-opus-4-0');
    expect(priceFor('claude-opus-4-20250514')?.output).toBe(75);
    expect(priceFor('claude-3-5-haiku-20241022')?.input).toBe(0.8);
  });

  it('inference_geo "us" — ×1.1 к токенам; веб-поиск — $10 за 1000', () => {
    const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(cost(u, 'claude-sonnet-5-5')).toBeCloseTo(2, 10);
    expect(cost(u, 'claude-sonnet-5-5', { inferenceGeo: 'us' })).toBeCloseTo(2.2, 10);
    expect(cost(u, 'claude-sonnet-5-5', { inferenceGeo: 'not_available' })).toBeCloseTo(2, 10);
    expect(cost(u, 'claude-sonnet-5-5', { inferenceGeo: 'us', webSearchRequests: 3 })).toBeCloseTo(
      2.23,
      10,
    );
  });
});
