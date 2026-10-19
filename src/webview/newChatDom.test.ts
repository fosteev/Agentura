// @vitest-environment jsdom
/**
 * Новые чаты внутри задачи (roadmap 26, сессия 2; эталон — `prototype/screens/task-chats.html`): чипы чатов задачи в
 * полосе, «＋ чат» (клик — всплывашка, ⌥ — сразу), всплывашка «Новый чат по задаче», команды `/new` и `/fork`.
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskChatRow, TaskStateMessage } from '../shared/task';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import {
  chat,
  dispatchEvent,
  extra,
  handleHostMessage,
  hudState,
  limits,
  newChatPopover,
  provider,
  tabChats,
  taskChats,
  taskNewChat,
  taskState,
  tick,
} from './store';
import { stripChats } from './taskView';
import * as vscode from './vscode';

let stored: unknown;
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState: () => stored,
  setState: (s: unknown) => {
    stored = s;
  },
});

const flush = () => new Promise((r) => setTimeout(r, 50));
const mounted: HTMLElement[] = [];
let sent: Record<string, unknown>[] = [];
const KEY = 'jira:inst:NEWMFC-1482';

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

const q = <T extends Element = HTMLElement>(host: Element, sel: string) => host.querySelector(sel) as T;
const qa = (host: Element, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

function row(id: string, over: Partial<TaskChatRow> = {}): TaskChatRow {
  return { id, title: `чат ${id}`, updatedAt: 1000, state: 'idle', current: false, ...over };
}

function taskMsg(): TaskStateMessage {
  return { type: 'task.state', taskKey: KEY, events: [], fetchedAt: 0, source: 'own' };
}

function setChats(rows: TaskChatRow[], newChat = { worktree: true, summary: true }) {
  handleHostMessage({ type: 'task.chats', taskKey: KEY, chats: rows, newChat });
}

const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));

function key(el: Element, k: string, opts: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
}

function type(host: Element, text: string) {
  const ed = host.querySelector<HTMLElement>('.typed')!;
  ed.focus();
  ed.textContent = text;
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  return ed;
}

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  stored = undefined;
  sent = [];
  vi.spyOn(vscode, 'send').mockImplementation((m) => void sent.push(m as unknown as Record<string, unknown>));
  chat.value = initialState();
  hudState.value = initialHud();
  taskState.value = undefined;
  taskChats.value = [];
  taskNewChat.value = { worktree: false, summary: false };
  newChatPopover.value = undefined;
  tabChats.value = undefined;
  provider.value = 'claude';
  extra.value = [];
  limits.value = { windows: [], updatedAt: 0 };
});

afterEach(() => vi.restoreAllMocks());

describe('stripChats: какие чаты видны чипами', () => {
  it('до четырёх — все; синтетический текущий занимает место', () => {
    expect(stripChats([row('a', { current: true }), row('b'), row('c'), row('d')]).hidden).toEqual([]);
    const s = stripChats([row('b'), row('c'), row('d'), row('e')]);
    expect(s.synthetic).toBe(true);
    expect(s.shown.map((c) => c.id)).toEqual(['b', 'c', 'd']);
    expect(s.hidden.map((c) => c.id)).toEqual(['e']);
  });

  it('больше четырёх — текущий и три последних по updatedAt, порядок прежний', () => {
    const s = stripChats([
      row('a', { updatedAt: 50 }),
      row('b', { updatedAt: 10 }),
      row('c', { updatedAt: 90, current: true }),
      row('d', { updatedAt: 70 }),
      row('e', { updatedAt: 5 }),
      row('f', { updatedAt: 60 }),
    ]);
    expect(s.shown.map((c) => c.id)).toEqual(['a', 'c', 'd', 'f']);
    expect(s.hidden.map((c) => c.id)).toEqual(['b', 'e']);
  });
});

describe('А · чипы чатов задачи в полосе', () => {
  it('чат без сессии в списке: синтетический текущий чип «новый чат» вместо вкладки «чат»', async () => {
    const host = mount();
    handleHostMessage(taskMsg());
    await flush();
    const chip = q(host, '#vtab-chat');
    expect(chip.classList.contains('cur')).toBe(true);
    expect(chip.getAttribute('aria-selected')).toBe('true');
    expect(q(chip, '.n').textContent).toBe('новый чат');
    expect(qa(host, '.tk-strip .cc')).toHaveLength(1);
    expect(q(host, '.tk-strip .np')).not.toBeNull();
    expect(q(host, '.tk-strip .more')).toBeNull();
  });

  it('1/3 чата: текущий — вкладка вида «чат», чужой — точка state и task.openChat', async () => {
    const host = mount();
    handleHostMessage(taskMsg());
    setChats([row('c1', { title: 'ревью фикса', provider: 'codex', state: 'waiting' }), row('c2', { current: true, title: 'почему не печатает' })]);
    await flush();
    const chips = qa(host, '.tk-strip .cc');
    expect(chips.map((c) => q(c, '.n').textContent)).toEqual(['ревью фикса', 'почему не печатает']);
    expect(q(chips[0]!, '.mk').classList.contains('codex')).toBe(true);
    expect(q(chips[0]!, '.lv.waiting')).not.toBeNull();
    expect(chips[0]!.getAttribute('data-tip')).toBe('ревью фикса · ждёт ответа');
    expect(chips[1]!.id).toBe('vtab-chat');
    expect(q(chips[1]!, '.lv')).toBeNull();
    click(chips[0]!);
    expect(sent).toEqual([{ type: 'task.openChat', sessionId: 'c1' }]);
    // по текущему — вид «чат», без сообщений хосту
    sent.length = 0;
    click(q(host, '#vtab-task'));
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('task');
    expect(chips[1]!.classList.contains('on')).toBe(false);
    click(q(host, '#vtab-chat'));
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
    expect(q(host, '#vtab-chat').classList.contains('on')).toBe(true);
    expect(sent).toEqual([]);
  });

  it('индикатор хода живёт на текущем чипе, пока открыта «задача»', async () => {
    const host = mount();
    handleHostMessage(taskMsg());
    setChats([row('c1', { current: true })]);
    const at = Date.now() - 5000;
    dispatchEvent({ type: 'turn.start', at, prompt: 'сделай' }, at);
    await flush();
    expect(q(host, '#vtab-chat .spin')).toBeNull();
    click(q(host, '#vtab-task'));
    await flush();
    expect(q(host, '#vtab-chat .spin')).not.toBeNull();
  });

  it('6 чатов: текущий и три последних, «ещё 2 ▾» открывает меню; клик по строке — task.openChat', async () => {
    const host = mount();
    handleHostMessage(taskMsg());
    setChats([
      row('c1', { updatedAt: 60 }),
      row('c2', { updatedAt: 50 }),
      row('c3', { updatedAt: 40, state: 'error' }),
      row('c4', { updatedAt: 30 }),
      row('c5', { updatedAt: 20, current: true }),
      row('c6', { updatedAt: 10, title: 'самый старый' }),
    ]);
    await flush();
    expect(qa(host, '.tk-strip .vtabs > .cc').map((c) => q(c, '.n').textContent)).toEqual(['чат c1', 'чат c2', 'чат c3', 'чат c5']);
    const more = q(host, '.tk-strip .cc.more');
    expect(more.textContent).toBe('ещё 2 ▾');
    expect(q(host, '.cmenu')).toBeNull();
    click(more);
    await flush();
    const items = qa(host, '.cmenu .it');
    expect(items.map((i) => q(i, '.n').textContent)).toEqual(['чат c4', 'самый старый']);
    click(items[1]!);
    await flush();
    expect(sent).toEqual([{ type: 'task.openChat', sessionId: 'c6' }]);
    expect(q(host, '.cmenu')).toBeNull();
  });

  it('tasks.tab = task: чипов нет — чаты уже во внутренних вкладках, вкладка «чат» прежняя', async () => {
    const host = mount();
    handleHostMessage(taskMsg());
    setChats([row('c1', { current: true })]);
    handleHostMessage({
      type: 'tab.chats',
      taskKey: KEY,
      chats: [{ id: 'c1', title: 'x', provider: 'claude', status: 'idle', active: true }],
      persist: { taskKey: KEY, chats: [] },
    });
    await flush();
    expect(q(host, '.tk-strip .cc')).toBeNull();
    expect(q(host, '.tk-strip .np')).toBeNull();
    expect(q(host, '#vtab-chat').textContent).toBe('чат');
  });
});

describe('«＋ чат» и всплывашка', () => {
  async function opened(over?: { newChat?: { worktree: boolean; summary: boolean }; prov?: 'codex' }) {
    if (over?.prov) provider.value = over.prov;
    const host = mount();
    handleHostMessage(taskMsg());
    setChats([row('c1', { current: true })], over?.newChat);
    await flush();
    click(q(host, '.tk-strip .np'));
    await flush();
    return host;
  }

  it('⌥+клик — сразу: движок вкладки, контекст задачи, без всплывашки', async () => {
    provider.value = 'codex';
    const host = mount();
    handleHostMessage(taskMsg());
    setChats([row('c1', { current: true })]);
    await flush();
    click(q(host, '.tk-strip .np'), { altKey: true });
    await flush();
    expect(q(host, '.ncp')).toBeNull();
    expect(sent).toEqual([{ type: 'task.newChat', taskKey: KEY, provider: 'codex', carry: { task: true } }]);
  });

  it('клик — всплывашка с умолчаниями: движок вкладки, контекст и итог отмечены, изменения нет, та же папка; повторный клик закрывает', async () => {
    const host = await opened({ prov: 'codex' });
    const pop = q(host, '.ncp');
    expect(pop.querySelector('h6 .k')!.textContent).toBe('NEWMFC-1482');
    expect(qa(pop, '.seg')[0]!.querySelector('.on')!.textContent).toContain('codex');
    expect(qa(pop, '.seg')[0]!.querySelectorAll('button')).toHaveLength(3);
    const boxes = qa(pop, '.ck input') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
    expect(boxes.map((b) => b.disabled)).toEqual([false, false, false]);
    expect(qa(pop, '.seg')[1]!.querySelector('.on')!.textContent).toBe('та же папка');
    expect(qa(pop, '.ft button').map((b) => b.textContent)).toEqual(['рядом', 'создать ⏎']);
    expect(sent).toEqual([]);
    click(q(host, '.tk-strip .np'));
    await flush();
    expect(q(host, '.ncp')).toBeNull();
  });

  it('нет newChat.summary/worktree: флажок итога снят и disabled, worktree disabled', async () => {
    const host = await opened({ newChat: { worktree: false, summary: false } });
    const boxes = qa(host, '.ncp .ck input') as HTMLInputElement[];
    expect(boxes[1]!.checked).toBe(false);
    expect(boxes[1]!.disabled).toBe(true);
    const tree = qa(host, '.ncp .seg')[1]!.querySelectorAll('button')[1]!;
    expect(tree.disabled).toBe(true);
    click(tree);
    await flush();
    expect(q(host, '.ncp .note')).toBeNull();
    key(q(host, '.ncp textarea'), 'Enter');
    expect(sent).toEqual([
      { type: 'task.newChat', taskKey: KEY, provider: 'claude', carry: { task: true, summary: false, changes: false }, where: 'same' },
    ]);
  });

  it('Enter создаёт: текст — первое сообщение, выбор агента, флажков и worktree попадает в сообщение; всплывашка закрывается', async () => {
    const host = await opened();
    const ta = q<HTMLTextAreaElement>(host, '.ncp textarea');
    ta.value = '  ревью фикса и тест на паузу ';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    click(qa(host, '.ncp .seg')[0]!.querySelectorAll('button')[1]!); // codex
    const boxes = qa(host, '.ncp .ck input') as HTMLInputElement[];
    click(boxes[1]!); // итог снят
    click(boxes[2]!); // изменения
    click(qa(host, '.ncp .seg')[1]!.querySelectorAll('button')[1]!); // worktree
    await flush();
    expect(q(host, '.ncp .note').textContent).toBe('ветка feature/NEWMFC-1482-N от HEAD, незакоммиченное не переносится');
    key(ta, 'Enter');
    await flush();
    expect(sent).toEqual([
      {
        type: 'task.newChat',
        taskKey: KEY,
        provider: 'codex',
        prompt: 'ревью фикса и тест на паузу',
        carry: { task: true, summary: false, changes: true },
        where: 'worktree',
      },
    ]);
    expect(q(host, '.ncp')).toBeNull();
  });

  it('⌥Enter и «рядом» — с beside; пустой текст — без prompt', async () => {
    let host = await opened();
    key(q(host, '.ncp textarea'), 'Enter', { altKey: true });
    await flush();
    expect(sent.at(-1)).toEqual({
      type: 'task.newChat',
      taskKey: KEY,
      provider: 'claude',
      carry: { task: true, summary: true, changes: false },
      where: 'same',
      beside: true,
    });
    sent.length = 0;
    newChatPopover.value = undefined;
    for (const h2 of mounted.splice(0)) render(null, h2);
    document.body.innerHTML = '';
    host = await opened();
    click(q(host, '.ncp .ft .sec'));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'task.newChat', beside: true });
    expect(sent[0]).not.toHaveProperty('prompt');
  });

  it('Shift+Enter не создаёт; Esc и клик мимо закрывают; выбор не запоминается', async () => {
    const host = await opened();
    key(q(host, '.ncp textarea'), 'Enter', { shiftKey: true });
    expect(sent).toEqual([]);
    click(qa(host, '.ncp .ck input')[2]!);
    key(q(host, '.ncp textarea'), 'Escape');
    await flush();
    expect(q(host, '.ncp')).toBeNull();
    click(q(host, '.tk-strip .np'));
    await flush();
    expect((qa(host, '.ncp .ck input')[2] as HTMLInputElement).checked).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(q(host, '.ncp')).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('Г · /new и /fork в поле ввода', () => {
  async function inTask(rows: TaskChatRow[] = [row('c1', { current: true })]) {
    const host = mount();
    handleHostMessage(taskMsg());
    setChats(rows);
    await flush();
    return host;
  }

  it('меню «/» во вкладке задачи: /new и /fork есть, вне задачи — нет', async () => {
    let host = await inTask();
    type(host, '/');
    await flush();
    const names = qa(host, '.menu .it').map((i) => i.firstElementChild?.firstChild?.textContent);
    expect(names).toEqual(expect.arrayContaining(['/new', '/fork']));
    for (const h2 of mounted.splice(0)) render(null, h2);
    document.body.innerHTML = '';
    taskState.value = undefined;
    taskChats.value = [];
    host = mount();
    type(host, '/');
    await flush();
    const plain = qa(host, '.menu .it').map((i) => i.firstElementChild?.firstChild?.textContent);
    expect(plain).not.toContain('/new');
    expect(plain).not.toContain('/fork');
  });

  it('/new — движок вкладки и контекст задачи; /new codex текст — движок и первое сообщение; в поле остаётся пусто', async () => {
    const host = await inTask();
    let ed = type(host, '/new ');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent).toEqual([{ type: 'task.newChat', taskKey: KEY, provider: 'claude', carry: { task: true } }]);
    sent.length = 0;
    ed = type(host, '/new codex ревью фикса');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent).toEqual([{ type: 'task.newChat', taskKey: KEY, provider: 'codex', prompt: 'ревью фикса', carry: { task: true } }]);
    expect(ed.textContent).toBe('');
    sent.length = 0;
    ed = type(host, '/new agy поправь тест');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent).toEqual([{ type: 'task.newChat', taskKey: KEY, provider: 'antigravity', prompt: 'поправь тест', carry: { task: true } }]);
    sent.length = 0;
    // первое слово — не движок: весь хвост текст
    ed = type(host, '/new codexfoo bar');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent).toEqual([{ type: 'task.newChat', taskKey: KEY, provider: 'claude', prompt: 'codexfoo bar', carry: { task: true } }]);
  });

  it('/fork текст — движок вкладки, контекст задачи и итог этого чата', async () => {
    provider.value = 'codex';
    const host = await inTask();
    const ed = type(host, '/fork закоммить socket.ts');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent).toEqual([
      { type: 'task.newChat', taskKey: KEY, provider: 'codex', prompt: 'закоммить socket.ts', carry: { task: true, summary: true } },
    ]);
  });

  it('работают и при исчерпанном лимите', async () => {
    limits.value = {
      windows: [{ kind: 'five-hour', percent: 100, resetsAt: Date.now() + 3_600_000 }],
      updatedAt: Date.now(),
    } as typeof limits.value;
    tick.value = Date.now();
    const host = await inTask();
    const ed = type(host, '/new ');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent).toEqual([{ type: 'task.newChat', taskKey: KEY, provider: 'claude', carry: { task: true } }]);
  });

  it('вне задачи /new — обычный текст движку, task.newChat не уходит', async () => {
    const host = mount();
    await flush();
    const ed = type(host, '/new codex что-то');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(sent.some((m) => m.type === 'task.newChat')).toBe(false);
    expect(sent.find((m) => m.type === 'send')).toMatchObject({ text: '/new codex что-то' });
  });
});
