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

describe('SessionsService: треды Codex (этап 5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const codexInfo = (id: string, updatedAt: number, title = id): SessionInfo => ({
    id,
    title,
    updatedAt,
    cwd: '/nonexistent/project',
    provider: 'codex',
  });

  function both(claude: SessionInfo[], codex: SessionInfo[], available = true) {
    let codexList = codex;
    const claudeAdapter = {
      listSessions: vi.fn(async () => claude),
      renameSession: vi.fn(async () => undefined),
    } as unknown as AgentAdapter;
    const codexAdapter = {
      listSessions: vi.fn(async () => codexList),
      renameSession: vi.fn(async (id: string, title: string) => {
        codexList = codexList.map((s) => (s.id === id ? { ...s, title } : s));
      }),
    } as unknown as AgentAdapter;
    const live = new LiveSessions();
    const warn = vi.fn();
    const state = { available };
    const svc = new SessionsService({
      adapter: claudeAdapter,
      codex: { adapter: () => codexAdapter, available: async () => state.available },
      cwd: '/nonexistent/project',
      live,
      cache: new TranscriptCache(),
      log: { debug: vi.fn(), warn },
      dir: '/tmp',
      watch: () => ({ close: () => undefined }),
    });
    return { svc, live, claudeAdapter, codexAdapter, warn, state, setCodex: (l: SessionInfo[]) => (codexList = l) };
  }

  const listed = (m: ReturnType<typeof both>) =>
    (m.codexAdapter.listSessions as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

  it('строки обоих движков в одном списке по времени; у Codex provider, у Claude поля нет', async () => {
    const m = both([info('c1', 1), info('c2', 5)], [codexInfo('x1', 3), codexInfo('x2', 9)]);
    const rows = await m.svc.summaries();
    expect(rows.map((r) => [r.id, r.provider])).toEqual([
      ['x2', 'codex'],
      ['c2', undefined],
      ['x1', 'codex'],
      ['c1', undefined],
    ]);
    expect(rows[0]).toMatchObject({ turns: 0, state: 'idle' });
    expect(rows[1]).not.toHaveProperty('provider');
    expect(m.codexAdapter.listSessions).toHaveBeenCalledWith('/nonexistent/project');
  });

  it('без источника Codex список как раньше', async () => {
    const { svc } = setup([info('a', 1)]);
    expect((await svc.summaries()).map((r) => r.id)).toEqual(['a']);
  });

  it('Codex недоступен (не найден) — только Claude, процесс не запускается, повтор не чаще минуты', async () => {
    const m = both([info('c1', 1)], [codexInfo('x1', 3)], false);
    expect((await m.svc.summaries()).map((r) => r.id)).toEqual(['c1']);
    m.state.available = true;
    await m.svc.refresh();
    expect(listed(m)).toBe(0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await m.svc.refresh()).map((r) => r.id)).toEqual(['x1', 'c1']);
  });

  it('сбой thread/list не роняет Claude-список; одно предупреждение, прошлые строки остаются', async () => {
    const m = both([info('c1', 1)], [codexInfo('x1', 3)]);
    await m.svc.refresh();
    (m.codexAdapter.listSessions as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await vi.advanceTimersByTimeAsync(31_000);
    const rows = await m.svc.refresh();
    expect(rows.map((r) => r.id)).toEqual(['x1', 'c1']);
    await vi.advanceTimersByTimeAsync(61_000);
    await m.svc.refresh();
    expect(m.warn).toHaveBeenCalledTimes(1);
  });

  it('список Codex перечитывается не на каждый тик: срок, смена живой Codex-сессии, переименование', async () => {
    const m = both([info('c1', 1)], [codexInfo('x1', 3)]);
    await m.svc.refresh();
    await m.svc.refresh();
    expect(listed(m)).toBe(1);
    // статус Claude-сессии Codex-список не трогает
    m.live.set('c1', 'live');
    await m.svc.refresh();
    expect(listed(m)).toBe(1);
    // живая Codex-сессия сменила статус — перечитать, и строка показывает статус сразу
    m.live.set('x1', 'live', undefined, 'codex');
    const rows = await m.svc.refresh();
    expect(listed(m)).toBe(2);
    expect(rows.find((r) => r.id === 'x1')?.state).toBe('live');
    await vi.advanceTimersByTimeAsync(31_000);
    await m.svc.refresh();
    expect(listed(m)).toBe(3);
  });

  it('медленный thread/list не держит Claude-список: кэш сразу, процесс один, новые строки — следующим проходом', async () => {
    const m = both([info('c1', 1)], [codexInfo('x1', 3)]);
    await m.svc.refresh();
    let release: (() => void) | undefined;
    const fn = m.codexAdapter.listSessions as unknown as ReturnType<typeof vi.fn>;
    fn.mockImplementation(
      () => new Promise<SessionInfo[]>((resolve) => (release = () => resolve([codexInfo('x1', 3), codexInfo('x2', 9)]))),
    );
    const seen: string[][] = [];
    m.svc.onChange((rows) => seen.push(rows.map((r) => r.id)));
    await vi.advanceTimersByTimeAsync(31_000);
    // срок вышел, сервер «висит» — список отдаётся из кэша, не ждёт
    expect((await m.svc.refresh()).map((r) => r.id)).toEqual(['x1', 'c1']);
    // повторные проходы во время чтения второй процесс не запускают
    await m.svc.refresh();
    expect(listed(m)).toBe(2);
    release!();
    // пересборка после фонового чтения — через дебаунс и настоящий fs Claude-списка
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['x2', 'x1', 'c1']));
    expect(listed(m)).toBe(2);
  });

  it('первый показ: Codex молчит дольше 3 с — Claude-строки без него, Codex-строки приходят потом', async () => {
    const m = both([info('c1', 1)], []);
    let release: (() => void) | undefined;
    (m.codexAdapter.listSessions as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SessionInfo[]>((resolve) => (release = () => resolve([codexInfo('x1', 3)]))),
    );
    const seen: string[][] = [];
    m.svc.onChange((rows) => seen.push(rows.map((r) => r.id)));
    const first = m.svc.refresh();
    await vi.advanceTimersByTimeAsync(3100);
    expect((await first).map((r) => r.id)).toEqual(['c1']);
    release!();
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['x1', 'c1']));
  });

  it('rename Codex-id, чьей строки уже нет (Codex пропал из списка), — всё равно Codex-адаптеру', async () => {
    const m = both([info('c1', 1)], [codexInfo('x1', 3)]);
    await m.svc.refresh();
    m.state.available = false;
    m.live.set('x1', 'idle', undefined, 'codex');
    await m.svc.refresh();
    // фоновое перечитывание сбросило Codex-строки
    await vi.waitFor(async () => expect((await m.svc.list()).map((r) => r.id)).toEqual(['c1']));
    await m.svc.rename('x1', 'Имя');
    expect(m.claudeAdapter.renameSession).not.toHaveBeenCalled();
    expect(m.codexAdapter.renameSession).toHaveBeenCalledWith('x1', 'Имя', '/nonexistent/project');
  });

  it('rename Codex-треда: renameSession Codex-адаптера (не Claude), список перечитан, закрепления нет', async () => {
    const m = both([info('c1', 1)], [codexInfo('x1', 3, 'старое')]);
    await m.svc.refresh();
    await m.svc.rename('x1', 'Новое');
    expect(m.codexAdapter.renameSession).toHaveBeenCalledWith('x1', 'Новое', '/nonexistent/project');
    expect(m.claudeAdapter.renameSession).not.toHaveBeenCalled();
    expect((await m.svc.summaries()).find((r) => r.id === 'x1')?.title).toBe('Новое');
    // Claude-тред — по-прежнему Claude-адаптер
    await m.svc.rename('c1', 'Другое');
    expect(m.claudeAdapter.renameSession).toHaveBeenCalledWith('c1', 'Другое', '/nonexistent/project');
  });
});
