import { describe, expect, it, vi } from 'vitest';
import { AGY_QUOTA_ERROR_COOLDOWN_MS, AgyQuotaService, type AgyQuotaSnapshot } from './agyQuota';

const OUT = 'Gemini Models\tWeekly Limit Remaining\t26%\t2026-10-12T16:21:42Z\n';

function make(
  run: ReturnType<typeof vi.fn<(p: string) => Promise<string>>> = vi.fn(async () => OUT),
  exe: string | undefined = '/bin/agy',
) {
  let t = 1000;
  const warnings: string[] = [];
  const svc = new AgyQuotaService(async () => exe, run, () => t, 600_000, (m) => warnings.push(m));
  return { svc, run, warnings, advance: (ms: number) => (t += ms) };
}

describe('AgyQuotaService', () => {
  it('стартует в loading, кэширует ok на 10 минут и склеивает параллельные запросы', async () => {
    const { svc, run, advance } = make();
    expect(svc.snapshot).toEqual({ state: 'loading', rows: [], updatedAt: 0 });
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toBe(b);
    expect(a.state).toBe('ok');
    expect(a.rows).toMatchObject([{ label: 'Gemini 7д', remaining: 26 }]);
    advance(60_000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    advance(600_000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('при ошибке сохраняет прежние строки и updatedAt, пишет warn, уведомляет listeners и ждёт короткий кулдаун 60с', async () => {
    const eligErr = 'Eligibility check failed: Your current account is not eligible for Antigravity';
    const run = vi
      .fn<(p: string) => Promise<string>>()
      .mockResolvedValueOnce(OUT)
      .mockRejectedValueOnce(new Error(eligErr))
      .mockResolvedValueOnce(OUT);
    const { svc, warnings, advance } = make(run);
    const seen: AgyQuotaSnapshot[] = [];
    svc.onUpdate((s) => seen.push(s));

    const first = await svc.refresh();
    expect(first.state).toBe('ok');
    expect(first.updatedAt).toBe(1000);

    advance(600_000);
    const failed = await svc.refresh();
    expect(failed).toMatchObject({
      state: 'error',
      error: eligErr,
      updatedAt: 1000,
    });
    expect(failed.rows).toHaveLength(1);
    expect(warnings).toEqual([eligErr]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.state).toBe('error');

    // В пределах 60с кулдауна ошибки повтор без force не запускает процесс
    advance(1000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(2);

    // Через 60с (меньше 10 минут!) кулдаун ошибки истекает
    advance(AGY_QUOTA_ERROR_COOLDOWN_MS);
    const recovered = await svc.refresh();
    expect(run).toHaveBeenCalledTimes(3);
    expect(recovered.state).toBe('ok');
    expect(recovered.error).toBeUndefined();
  });

  it('refresh(true) обходит кулдаун для кнопки ↻, а при разлогине ставит signedOut', async () => {
    const run = vi
      .fn<(p: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('Eligibility check failed'))
      .mockRejectedValueOnce(new Error('Error: not logged in\nrun agy to sign in'));
    const { svc, advance } = make(run);

    const errSnap = await svc.refresh();
    expect(errSnap.state).toBe('error');
    advance(1000);

    const signedOut = await svc.refresh(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(signedOut).toMatchObject({ state: 'signedOut', rows: [] });
  });

  it('не затирает прежние непустые rows в signedOut при пустом выводе без признака разлогина', async () => {
    const run = vi.fn<(p: string) => Promise<string>>().mockResolvedValueOnce(OUT).mockResolvedValueOnce('');
    const { svc, advance } = make(run);
    await svc.refresh();
    advance(600_000);
    const snap = await svc.refresh();
    expect(snap.state).toBe('error');
    expect(snap.rows).toHaveLength(1);
    expect(snap.updatedAt).toBe(1000);
  });

  it('не разобрали вывод на холодном старте — signedOut; нет agy — missing без взвода кулдауна', async () => {
    const bad = make(vi.fn((path: string) => Promise.resolve(path ? 'garbage' : '')));
    expect(await bad.svc.refresh()).toMatchObject({ state: 'signedOut', rows: [] });

    const getExe = vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce(undefined).mockResolvedValue('/bin/agy');
    const run = vi.fn(async () => OUT);
    const svc = new AgyQuotaService(getExe, run, () => 1000, 600_000);
    expect(await svc.refresh()).toMatchObject({ state: 'missing', rows: [] });
    expect(run).not.toHaveBeenCalled();

    // Как только бинарник появился, кулдаун не мешает сразу получить квоту
    expect((await svc.refresh()).state).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
