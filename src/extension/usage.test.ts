import { describe, expect, it, vi } from 'vitest';
import { UsageService } from './usage';

const windows = [{ kind: 'five-hour' as const, percent: 62, resetsAt: 0 }];

describe('UsageService', () => {
  it('в пределах кулдауна отдаёт кэш, после — идёт в источник снова', async () => {
    let now = 1_000;
    const fetch = vi.fn().mockResolvedValue(windows);
    const svc = new UsageService(fetch, () => now, 60_000);

    expect((await svc.refresh()).updatedAt).toBe(1_000);
    now += 30_000;
    expect((await svc.refresh()).updatedAt).toBe(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 31_000;
    expect((await svc.refresh()).updatedAt).toBe(62_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('параллельные нажатия склеиваются в один запрос', async () => {
    const fetch = vi.fn().mockResolvedValue(windows);
    const svc = new UsageService(fetch, () => 0, 60_000);
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ошибка источника не затирает прошлые данные и не включает кулдаун', async () => {
    let now = 0;
    const fetch = vi.fn().mockResolvedValueOnce(windows).mockRejectedValueOnce(new Error('429'));
    const svc = new UsageService(fetch, () => now, 60_000);
    await svc.refresh();
    now = 70_000;
    const failed = await svc.refresh();
    expect(failed).toMatchObject({ windows, updatedAt: 0, error: '429' });
    fetch.mockResolvedValueOnce(windows);
    expect((await svc.refresh()).error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
