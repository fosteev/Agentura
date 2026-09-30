import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimitsSource, startLimitsPolling, type HttpFetch } from './limits';

const probeBody = (() => {
  const lines = readFileSync(
    join(__dirname, '..', '..', 'spikes', 'sdk-probe', 'logs', '10-oauth-usage.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind?: string; body?: unknown });
  return lines.find((l) => l.kind === 'node_fetch')?.body;
})();

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function home(withToken: boolean): string {
  dir = mkdtempSync(join(tmpdir(), 'agentura-limits-'));
  if (withToken) {
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
    );
  }
  return dir;
}

function reply(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): HttpFetch {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  }));
}

const engineWindows = [{ kind: 'five-hour' as const, percent: 80, resetsAt: 1 }];

describe('LimitsSource', () => {
  it('ответ /api/oauth/usage из пробы → 5 ч, неделя и недельное окно модели', async () => {
    const fetch = reply(200, probeBody);
    const src = new LimitsSource({
      claudeHome: home(true),
      platform: 'linux',
      fetch,
      now: () => 42,
    });
    const reading = await src.fetch();
    expect(reading).toEqual({
      source: 'oauth',
      updatedAt: 42,
      windows: [
        { kind: 'five-hour', percent: 81, resetsAt: Date.parse('2026-09-30T16:50:00.181Z') },
        { kind: 'weekly', percent: 37, resetsAt: Date.parse('2026-10-01T12:00:00.181Z') },
        {
          kind: 'weekly-model',
          model: 'Fable',
          percent: 22,
          resetsAt: Date.parse('2026-10-01T12:00:00.181Z'),
        },
      ],
    });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers['authorization']).toBe('Bearer tok');
    expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('неактивное окно (resets_at: null) — 0 % без сброса, а не пропуск', async () => {
    const body = {
      limits: [
        { kind: 'session', percent: 0, resets_at: null },
        { kind: 'weekly_all', percent: 12, resets_at: '2026-10-01T12:00:00+00:00' },
      ],
    };
    const src = new LimitsSource({
      claudeHome: home(true),
      platform: 'linux',
      fetch: reply(200, body),
    });
    await expect(src.fetchOauth()).resolves.toEqual([
      { kind: 'weekly', percent: 12, resetsAt: Date.parse('2026-10-01T12:00:00Z') },
      { kind: 'five-hour', percent: 0 },
    ]);
  });

  it('пустой разбор ответа — ошибка, а не пустой успех', async () => {
    for (const body of [null, {}, { limits: [] }, { limits: [{ kind: 'tangelo', percent: 1 }] }]) {
      const src = new LimitsSource({
        claudeHome: home(true),
        platform: 'linux',
        fetch: reply(200, body),
      });
      await expect(src.fetchOauth()).rejects.toThrow(/нет окон/);
    }
  });

  it('токен из Keychain, если файла нет; чтение выключено настройкой — понятная ошибка, Keychain не трогаем', async () => {
    const keychain = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: 'kc' } }));
    const fetch = reply(200, probeBody);
    let allowed = true;
    const src = new LimitsSource({
      claudeHome: home(false),
      platform: 'darwin',
      fetch,
      keychain,
      readKeychain: () => allowed,
    });
    await src.fetchOauth();
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      headers: Record<string, string>;
    };
    expect(init.headers['authorization']).toBe('Bearer kc');

    allowed = false; // настройка сменилась без перезапуска
    await expect(src.fetchOauth()).rejects.toThrow(/включите чтение токена/);
    expect(keychain).toHaveBeenCalledOnce();
  });

  it('ошибка OAuth: окна движка отдаются, только если они новее последних удачных, и со своим временем', async () => {
    let now = 1000;
    let status = 200;
    const fetch: HttpFetch = vi.fn(async () => ({
      status,
      ok: status === 200,
      headers: { get: () => null },
      json: async () => probeBody,
    }));
    const src = new LimitsSource({
      claudeHome: home(true),
      platform: 'linux',
      fetch,
      now: () => now,
    });

    src.observeEngine(engineWindows, 500); // старше будущего ответа OAuth
    await expect(src.fetch()).resolves.toMatchObject({ source: 'oauth', updatedAt: 1000 });

    status = 500;
    now = 2000;
    await expect(src.fetch()).rejects.toThrow(/HTTP 500/); // окна движка старее — не подсовываем

    src.observeEngine(engineWindows, 1500);
    await expect(src.fetch()).resolves.toEqual({
      source: 'engine',
      updatedAt: 1500,
      windows: engineWindows,
    });
  });

  it('нет токена и нет окон движка — ошибка', async () => {
    const src = new LimitsSource({
      claudeHome: home(false),
      platform: 'linux',
      fetch: reply(200, probeBody),
    });
    await expect(src.fetch()).rejects.toThrow(/нет токена/);
  });

  it('429 — молчим до Retry-After, сеть не трогаем', async () => {
    let now = 1_000_000;
    const fetch = reply(429, {}, { 'retry-after': '120' });
    const src = new LimitsSource({
      claudeHome: home(true),
      platform: 'linux',
      fetch,
      now: () => now,
    });
    await expect(src.fetchOauth()).rejects.toThrow(/лимит запросов/);
    now += 60_000;
    await expect(src.fetchOauth()).rejects.toThrow(/лимит запросов/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('401 — войти заново; 403 — отказ сервера, не перелогин', async () => {
    const a = new LimitsSource({ claudeHome: home(true), platform: 'linux', fetch: reply(401) });
    await expect(a.fetchOauth()).rejects.toThrow(/войдите/);
    const b = new LimitsSource({ claudeHome: home(true), platform: 'linux', fetch: reply(403) });
    const error = await b.fetchOauth().catch((e: Error) => e);
    expect(String(error)).toMatch(/сервер отклонил запрос \(HTTP 403\)/);
    expect(String(error)).not.toMatch(/войдите/);
  });
});

describe('startLimitsPolling', () => {
  it('сразу и затем по интервалу из настройки, не чаще 5 минут', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    let minutes = 1;
    const poll = startLimitsPolling(refresh, () => minutes);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    minutes = 15;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(3); // интервал 5 мин уже был запланирован
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    poll.dispose();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
