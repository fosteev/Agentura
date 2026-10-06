import { describe, expect, it, vi } from 'vitest';
import { AgyQuotaService } from './agyQuota';

const OUT = 'Gemini Models\tWeekly Limit Remaining\t26%\t2026-10-12T16:21:42Z\n';

function make(run: ReturnType<typeof vi.fn<(p: string) => Promise<string>>> = vi.fn(async () => OUT), exe: string | undefined = '/bin/agy') {
  let t = 1000;
  const svc = new AgyQuotaService(async () => exe, run, () => t, 600_000);
  return { svc, run, advance: (ms: number) => (t += ms) };
}

describe('AgyQuotaService', () => {
  it('запускает agy и кэширует: повтор в пределах интервала процесс не поднимает', async () => {
    const { svc, run, advance } = make();
    const a = await svc.refresh();
    expect(a.rows).toMatchObject([{ label: 'Gemini', remaining: 26 }]);
    advance(60_000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    advance(600_000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('параллельные запросы склеиваются', async () => {
    const { svc, run } = make();
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('упавший процесс оставляет прежние цифры, но тоже ждёт интервал', async () => {
    const run = vi.fn<(p: string) => Promise<string>>().mockResolvedValueOnce(OUT).mockRejectedValue(new Error('boom'));
    const { svc, advance } = make(run);
    await svc.refresh();
    advance(600_000);
    const snap = await svc.refresh();
    expect(snap.rows).toHaveLength(1);
    advance(1000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('не разобрали вывод — пустой список; agy не найден — процесс не запускается', async () => {
    const bad = make(vi.fn((path: string) => Promise.resolve(path ? 'garbage' : '')));
    expect((await bad.svc.refresh()).rows).toEqual([]);
    const run = vi.fn((path: string) => Promise.resolve(path ? OUT : ''));
    await new AgyQuotaService(async () => undefined, run).refresh();
    expect(run).not.toHaveBeenCalled();
  });

  it('подписчик получает свежий снимок', async () => {
    const { svc } = make();
    const seen: number[] = [];
    svc.onUpdate((s) => seen.push(s.rows.length));
    await svc.refresh();
    expect(seen).toEqual([1]);
  });
});
