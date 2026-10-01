import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, SessionInfo } from '../agent/types';
import { LiveSessions, TranscriptCache } from '../data/sessions';
import { SessionsService } from './sessionsService';

function setup(initial: SessionInfo[]) {
  let list = initial;
  const adapter = {
    listSessions: vi.fn(async () => list),
    renameSession: vi.fn(async (id: string, title: string) => {
      list = list.map((s) => (s.id === id ? { ...s, title } : s));
    }),
  } as unknown as AgentAdapter;
  let fire: () => void = () => {};
  let closed = false;
  const live = new LiveSessions();
  const svc = new SessionsService({
    adapter,
    cwd: '/nonexistent/project',
    live,
    cache: new TranscriptCache(),
    log: { debug: vi.fn(), warn: vi.fn() },
    dir: '/tmp', // существует — слежение подключается
    debounceMs: 100,
    maxWaitMs: 350,
    watch: (_d, cb) => {
      fire = cb;
      return { close: () => (closed = true) };
    },
  });
  return {
    svc,
    adapter,
    live,
    trigger: () => fire(),
    isClosed: () => closed,
    set: (l: SessionInfo[]) => (list = l),
  };
}

const info = (id: string, updatedAt: number, title = id): SessionInfo => ({ id, title, updatedAt });

describe('SessionsService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('список по убыванию времени, статус живых из реестра', async () => {
    const { svc, live } = setup([info('a', 1), info('b', 3), info('c', 2)]);
    live.set('c', 'live');
    const rows = await svc.summaries();
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['b', 'idle'],
      ['c', 'live'],
      ['a', 'idle'],
    ]);
  });

  it('fs.watch: серия записей даёт один пересчёт после тишины; при непрерывной записи — не реже maxWait', async () => {
    const { svc, adapter, trigger } = setup([info('a', 1)]);
    const seen: number[] = [];
    svc.onChange((r) => seen.push(r.length));
    svc.start();
    await svc.refresh();
    adapter.listSessions = vi.fn(adapter.listSessions);
    const calls = () =>
      (adapter.listSessions as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = calls();
    trigger();
    trigger();
    trigger();
    await vi.advanceTimersByTimeAsync(99);
    expect(calls()).toBe(before);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls()).toBe(before + 1);
    // непрерывная запись: каждые 80 мс — потолок 350 мс срабатывает, хотя тишины не было
    for (let i = 0; i < 6; i++) {
      trigger();
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(calls()).toBeGreaterThan(before + 1);
    svc.dispose();
  });

  it('refresh во время идущего прохода: ещё один проход после него, а не устаревший результат', async () => {
    const { svc, adapter, set } = setup([info('a', 1, 'старое')]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = adapter.listSessions;
    adapter.listSessions = vi.fn(async (...args: Parameters<typeof original>) => {
      await gate;
      return original(...args);
    });
    const first = svc.refresh();
    set([info('a', 2, 'новое')]);
    const second = svc.refresh();
    const third = svc.refresh();
    release();
    await first;
    expect((await second)[0]!.title).toBe('новое');
    expect(await third).toBe(await second);
    expect((adapter.listSessions as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('окно без папки: пустой список, listSessions не вызывается (иначе SDK отдал бы все проекты)', async () => {
    const adapter = { listSessions: vi.fn(async () => [info('x', 1)]) } as unknown as AgentAdapter;
    const svc = new SessionsService({
      adapter,
      cwd: '',
      live: new LiveSessions(),
      cache: new TranscriptCache(),
      log: { debug: vi.fn(), warn: vi.fn() },
    });
    expect(await svc.summaries()).toEqual([]);
    expect(adapter.listSessions).not.toHaveBeenCalled();
  });

  it('ошибка слежения (каталог удалили): watcher закрыт, через retryMs подключается снова', async () => {
    let attached = 0;
    let fail: () => void = () => {};
    const closed: number[] = [];
    const svc = new SessionsService({
      adapter: { listSessions: vi.fn(async () => []) } as unknown as AgentAdapter,
      cwd: '/nonexistent/project',
      live: new LiveSessions(),
      cache: new TranscriptCache(),
      log: { debug: vi.fn(), warn: vi.fn() },
      dir: '/tmp',
      retryMs: 1000,
      watch: (_d, _cb, onError) => {
        const n = ++attached;
        fail = onError;
        return { close: () => closed.push(n) };
      },
    });
    svc.start();
    expect(attached).toBe(1);
    fail();
    expect(closed).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attached).toBe(2);
    svc.dispose();
    expect(closed).toEqual([1, 2]);
  });

  it('dispose закрывает watcher и гасит таймеры', async () => {
    const { svc, isClosed, trigger } = setup([info('a', 1)]);
    svc.start();
    trigger();
    svc.dispose();
    expect(isClosed()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('rename: adapter.renameSession с cwd сессии, список пересобран', async () => {
    const { svc, adapter } = setup([info('a', 1, 'старое')]);
    await svc.refresh();
    const got: string[] = [];
    svc.onChange((r) => got.push(r[0]!.title));
    await svc.rename('a', 'новое');
    expect(adapter.renameSession).toHaveBeenCalledWith('a', 'новое', '/nonexistent/project');
    expect(got).toEqual(['новое']);
  });

  it('rename во время хода: движок перебил название — список держит своё и переименовывает снова, пока процесс жив', async () => {
    const { svc, adapter, live, set } = setup([info('a', 1, 'старое')]);
    live.set('a', 'live');
    await svc.rename('a', 'моё');
    expect(adapter.renameSession).toHaveBeenCalledTimes(1);
    // конец хода: CLI дописал своё название из памяти процесса
    set([info('a', 2, 'Название от CLI')]);
    live.set('a', 'idle');
    const rows = await svc.refresh();
    expect(rows[0]!.title).toBe('моё');
    expect(adapter.renameSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.renameSession).mock.calls[1]!.slice(0, 2)).toEqual(['a', 'моё']);
    await vi.runAllTimersAsync();
    expect((await svc.refresh())[0]!.title).toBe('моё');
    // процесс ушёл, название на месте — больше не следим
    live.delete('a');
    await svc.refresh();
    set([info('a', 3, 'другое')]);
    expect((await svc.refresh())[0]!.title).toBe('другое');
    expect(adapter.renameSession).toHaveBeenCalledTimes(2);
  });

  it('rename сессии без живого процесса в окне — один раз, без слежения', async () => {
    const { svc, adapter, set } = setup([info('a', 1, 'старое')]);
    await svc.rename('a', 'моё');
    set([info('a', 2, 'другое')]);
    expect((await svc.refresh())[0]!.title).toBe('другое');
    expect(adapter.renameSession).toHaveBeenCalledTimes(1);
  });

  it('название перебивается снова и снова (формат записи сменился) — после 5 попыток сдаёмся', async () => {
    const { svc, adapter, live } = setup([info('a', 1, 'старое')]);
    vi.mocked(adapter.renameSession).mockImplementation(async () => {});
    live.set('a', 'live');
    await svc.rename('a', 'моё');
    for (let i = 0; i < 8; i++) {
      await svc.refresh();
      await vi.runAllTimersAsync();
    }
    expect(adapter.renameSession).toHaveBeenCalledTimes(1 + 5);
  });

  it('каталога ещё нет (первая сессия проекта): ждём и подключаемся, когда появится', async () => {
    const svc = new SessionsService({
      adapter: { listSessions: async () => [] } as unknown as AgentAdapter,
      cwd: '/x',
      live: new LiveSessions(),
      cache: new TranscriptCache(),
      log: { debug: vi.fn(), warn: vi.fn() },
      dir: '/nonexistent/dir',
      retryMs: 1000,
      watch: () => ({ close() {} }),
    });
    svc.start();
    await vi.advanceTimersByTimeAsync(3500);
    svc.dispose(); // без падений и утечек таймера
  });
});
