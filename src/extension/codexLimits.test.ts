import { describe, expect, it, vi } from 'vitest';
import { CodexLimitsService } from './codexLimits';
import type { CodexLimits } from '../agent/codex/limits';

const OK: CodexLimits = {
  signedIn: true,
  email: 'a@b.c',
  plan: 'Plus',
  windows: [{ kind: 'fiveHour', percent: 4, resetsAt: 1000 }],
};

function make(run: ReturnType<typeof vi.fn<(p: string) => Promise<CodexLimits>>> = vi.fn(async () => OK), exe: string | null = '/bin/codex') {
  let t = 1000;
  const svc = new CodexLimitsService(async () => exe ?? undefined, run, () => t, 60_000);
  return { svc, run, advance: (ms: number) => (t += ms) };
}

describe('CodexLimitsService', () => {
  it('запускает codex и кэширует: повтор в пределах кулдауна процесс не поднимает', async () => {
    const { svc, run, advance } = make();
    expect(svc.snapshot.state).toBe('loading');
    const a = await svc.refresh();
    expect(a).toMatchObject({ state: 'ok', email: 'a@b.c', plan: 'Plus', windows: [{ kind: 'fiveHour', percent: 4 }] });
    advance(30_000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    advance(30_000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('параллельные запросы склеиваются', async () => {
    const { svc, run } = make();
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('codex не найден — missing, процесс не запускается', async () => {
    const { svc, run } = make(vi.fn(async () => OK), null);
    expect((await svc.refresh()).state).toBe('missing');
    expect(run).not.toHaveBeenCalled();
  });

  it('не вошли: signedIn false и ошибка авторизации → signedOut без окон', async () => {
    const out = make(vi.fn(async () => ({ signedIn: false, windows: [] })));
    expect((await out.svc.refresh()).state).toBe('signedOut');
    const run = vi.fn<(p: string) => Promise<CodexLimits>>().mockResolvedValueOnce(OK).mockRejectedValue(new Error('please login first'));
    const { svc, advance } = make(run);
    await svc.refresh();
    advance(60_000);
    const snap = await svc.refresh();
    expect(snap).toMatchObject({ state: 'signedOut', windows: [] });
  });

  it('прочая ошибка: state error, окна и аккаунт сохраняются, кулдаун действует', async () => {
    const run = vi.fn<(p: string) => Promise<CodexLimits>>().mockResolvedValueOnce(OK).mockRejectedValue(new Error('boom'));
    const { svc, advance } = make(run);
    await svc.refresh();
    advance(60_000);
    const snap = await svc.refresh();
    expect(snap).toMatchObject({ state: 'error', error: 'boom', email: 'a@b.c', windows: [{ percent: 4 }] });
    advance(1000);
    await svc.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('onUpdate получает снимок, отписка работает', async () => {
    const { svc, advance } = make();
    const seen = vi.fn();
    const off = svc.onUpdate(seen);
    await svc.refresh();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    advance(60_000);
    await svc.refresh();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
