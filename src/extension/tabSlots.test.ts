/** Внутренние вкладки вкладки задачи (roadmap 19, этап 7): кому идут сообщения, порядок при переключении, закрытие. */
import { describe, expect, it, vi } from 'vitest';
import type { ChatStatus } from '../agent/status';
import type { FromWebview, ToWebview } from '../protocol';
import { readTaskTabState, restoredTabChats } from '../shared/taskTab';
import { TabSlots, type SlotInfo } from './tabSlots';

const K = 'jira:inst:NEWMFC-1482';

function setup() {
  const posted: ToWebview[] = [];
  const titles: string[] = [];
  const io = {
    post: (m: ToWebview) => void posted.push(m),
    setTitle: (t: string) => void titles.push(t),
    displayKey: 'NEWMFC-1482',
    onNew: vi.fn(),
    onEmpty: vi.fn(),
  };
  const tab = new TabSlots(K, io);
  const infos = new Map<string, SlotInfo>();
  /** Чат вкладки: что ему пришло от webview и сколько раз менялась видимость. */
  const chat = (info: SlotInfo) => {
    const id = tab.add(() => infos.get(id));
    infos.set(id, info);
    const got: FromWebview[] = [];
    const views = { n: 0 };
    const gone = { n: 0 };
    tab.onMessage(id, (m) => void got.push(m));
    tab.onView(id, () => void views.n++);
    tab.onGone(id, () => void gone.n++);
    return { id, got, views, gone, info: (p: Partial<SlotInfo>) => infos.set(id, { ...infos.get(id)!, ...p }) };
  };
  const chats = () => posted.filter((m): m is Extract<ToWebview, { type: 'tab.chats' }> => m.type === 'tab.chats');
  return { tab, io, posted, titles, chat, chats };
}

const st = (status: ChatStatus, sessionId?: string, title?: string): SlotInfo => ({
  provider: 'claude',
  status,
  ...(sessionId ? { sessionId } : {}),
  ...(title ? { title } : {}),
});

describe('TabSlots', () => {
  it('до готовности webview синтетический ready не шлётся; настоящий — tab.chats, затем показанному чату', () => {
    const { tab, chat, posted } = setup();
    const a = chat(st('idle', 'sa'));
    tab.activate(a.id);
    expect(a.got).toEqual([]);
    expect(posted).toEqual([]);
    tab.receive({ type: 'ready' });
    expect(posted.map((m) => m.type)).toEqual(['tab.chats']);
    expect(a.got).toEqual([{ type: 'ready' }]);
  });

  it('сообщения фонового чата в webview не уходят; сообщения webview — только показанному', () => {
    const { tab, chat, posted } = setup();
    const a = chat(st('idle', 'sa'));
    const b = chat(st('working', 'sb'));
    tab.activate(a.id);
    tab.receive({ type: 'ready' });
    posted.length = 0;
    tab.post(b.id, { type: 'session.reset' });
    expect(posted).toEqual([]);
    tab.post(a.id, { type: 'session.reset' });
    expect(posted).toEqual([{ type: 'session.reset' }]);
    tab.receive({ type: 'session.new' });
    expect(a.got.at(-1)).toEqual({ type: 'session.new' });
    expect(b.got).toEqual([]);
  });

  it('сообщение, помеченное чатом, который хост уже увёл в фон, отбрасывается (гонка переключения)', () => {
    const { tab, chat } = setup();
    const a = chat(st('working', 'sa'));
    const b = chat(st('idle', 'sb'));
    tab.activate(a.id);
    tab.receive({ type: 'ready' });
    // хост показал b («＋», сайдбар), а webview ещё рисует a и шлёт его «стоп»
    tab.activate(b.id);
    const before = b.got.length;
    tab.receive({ type: 'session.new', tab: a.id } as never);
    expect(b.got).toHaveLength(before);
    expect(a.got.some((m) => m.type === 'session.new')).toBe(false);
    tab.receive({ type: 'session.new', tab: b.id } as never);
    expect(b.got.at(-1)).toMatchObject({ type: 'session.new' });
  });

  it('переключение: сначала tab.chats с новой активной, потом ready новому; видимость — обоим', () => {
    const { tab, chat, posted } = setup();
    const a = chat(st('idle', 'sa'));
    const b = chat(st('working', 'sb'));
    tab.activate(a.id);
    tab.receive({ type: 'ready' });
    posted.length = 0;
    const order: string[] = [];
    tab.onMessage(b.id, () => void order.push(`ready→b, постов ${posted.length}`));
    const va = a.views.n;
    tab.receive({ type: 'tab.select', id: b.id });
    expect(posted[0]).toMatchObject({ type: 'tab.chats', chats: [{ active: false }, { active: true }] });
    expect(order).toEqual(['ready→b, постов 1']);
    expect(a.views.n).toBe(va + 1);
    expect(b.views.n).toBeGreaterThan(0);
    // повторный выбор той же — ничего
    tab.receive({ type: 'tab.select', id: b.id });
    expect(b.got.filter((m) => m.type === 'ready')).toHaveLength(1);
  });

  it('«×» показанного: чат закрывается, показывается соседний; последний — вкладка закрывается', () => {
    const { tab, chat, io } = setup();
    const a = chat(st('idle', 'sa'));
    const b = chat(st('idle', 'sb'));
    tab.activate(a.id);
    tab.receive({ type: 'ready' });
    tab.receive({ type: 'tab.close', id: a.id });
    expect(a.gone.n).toBe(1);
    expect(tab.active).toBe(b.id);
    expect(b.got).toEqual([{ type: 'ready' }]);
    tab.receive({ type: 'tab.close', id: b.id });
    expect(io.onEmpty).toHaveBeenCalledTimes(1);
  });

  it('«×» при ходе или ждущем запросе — вопрос (решение владельца, этап 8); «нет» — чат остаётся; в простое — без вопроса', async () => {
    const { tab, chat, io } = setup();
    let answer = false;
    const asked: (string | undefined)[] = [];
    const confirmClose = vi.fn(async (title: string | undefined) => {
      asked.push(title);
      return answer;
    });
    Object.assign(io, { confirmClose });
    const a = chat(st('working', 'sa', 'Чат A'));
    const b = chat(st('waiting', 'sb'));
    const c = chat(st('idle', 'sc'));
    tab.activate(a.id);
    // «нет»: ход идёт дальше, чат на месте
    await tab.requestClose(a.id);
    expect(a.gone.n).toBe(0);
    expect(tab.ids).toEqual([a.id, b.id, c.id]);
    // повторный «×», пока висит вопрос, второго вопроса не открывает
    answer = true;
    const first = tab.requestClose(b.id);
    tab.receive({ type: 'tab.close', id: b.id });
    await first;
    expect(confirmClose).toHaveBeenCalledTimes(2);
    expect(b.gone.n).toBe(1);
    // «да» — закрыт
    await tab.requestClose(a.id);
    expect(a.gone.n).toBe(1);
    expect(asked).toEqual(['Чат A', undefined, 'Чат A']);
    // простой — сразу, вопрос не задаётся
    tab.receive({ type: 'tab.close', id: c.id });
    expect(c.gone.n).toBe(1);
    expect(confirmClose).toHaveBeenCalledTimes(3);
    expect(io.onEmpty).toHaveBeenCalledTimes(1);
  });

  it('«×»: пока висел вопрос, чат закрыли другим путём — второе закрытие не происходит', async () => {
    const { tab, chat, io } = setup();
    let release: (v: boolean) => void = () => undefined;
    Object.assign(io, { confirmClose: () => new Promise<boolean>((r) => (release = r)) });
    const a = chat(st('working', 'sa'));
    chat(st('idle', 'sb'));
    const p = tab.requestClose(a.id);
    tab.close(a.id);
    release(true);
    await p;
    expect(a.gone.n).toBe(1);
  });

  it('«＋» — новый чат по задаче; закрытие вкладки редактора закрывает все чаты', () => {
    const { tab, chat, io } = setup();
    const a = chat(st('idle', 'sa'));
    const b = chat(st('idle'));
    tab.receive({ type: 'tab.new' });
    expect(io.onNew).toHaveBeenCalledTimes(1);
    tab.disposeAll();
    expect([a.gone.n, b.gone.n]).toEqual([1, 1]);
    expect(tab.ids).toEqual([]);
  });

  it('заголовок — ключ с маркером самого срочного чата; tab.chats без изменений не повторяется', () => {
    const { tab, chat, titles, chats } = setup();
    const a = chat(st('idle', 'sa', 'первый'));
    const b = chat(st('idle', 'sb'));
    tab.activate(a.id);
    tab.receive({ type: 'ready' });
    expect(titles.at(-1)).toBe('NEWMFC-1482');
    const n = chats().length;
    tab.refresh();
    expect(chats()).toHaveLength(n);
    b.info({ status: 'waiting' });
    tab.refresh();
    expect(titles.at(-1)).toBe('? NEWMFC-1482');
    expect(chats().at(-1)!.chats[1]).toMatchObject({ id: b.id, status: 'waiting', active: false, title: '' });
  });
});

describe('восстановление вкладки задачи из состояния сериализатора', () => {
  it('persist из tab.chats → состояние webview → те же чаты и видимый после «Reload Window»', () => {
    const { tab, chat, chats } = setup();
    const a = chat(st('idle', 'sa'));
    const fresh = chat(st('idle')); // новый чат без сообщений — не сохраняется
    const b = chat({ provider: 'codex', status: 'working', sessionId: 'sb' });
    tab.activate(b.id);
    tab.receive({ type: 'ready' });
    void a;
    void fresh;
    const persist = chats().at(-1)!.persist;
    expect(persist).toEqual({
      taskKey: K,
      chats: [
        { provider: 'claude', id: 'sa' },
        { provider: 'codex', id: 'sb' },
      ],
      active: 'sb',
    });
    // webview кладёт persist в setState как `taskTab` (рядом с panel/sessionId) — это и получит сериализатор
    const state = readTaskTabState({ sessionId: 'sb', panel: { w: 300 }, taskTab: persist });
    expect(state).toEqual(persist);
    expect(restoredTabChats(state!, [])).toEqual({ refs: persist.chats, active: 1 });
  });
});
