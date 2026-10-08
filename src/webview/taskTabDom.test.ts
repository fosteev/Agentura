// @vitest-environment jsdom
/**
 * Вкладка на задачу (`tasks.tab = task`, roadmap 19, этап 7; эталон — `prototype/screens/tasks.html#b`, `#d`):
 * внутренние вкладки чатов под полоской, их сообщения хосту, сброс ленты при переключении, черновик поля ввода
 * по чату, состояние для сериализатора.
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabChatRow, TabChatsMessage } from '../shared/taskTab';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { chat, extra, handleHostMessage, hudState, tabChats, taskChats, taskState } from './store';
import * as vscode from './vscode';

let stored: unknown;
/** Что ушло хосту настоящим `send` (без мока). */
const toHost: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => void toHost.push(m),
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

const qa = (host: Element, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

function row(id: string, over: Partial<TabChatRow> = {}): TabChatRow {
  return { id, title: `чат ${id}`, provider: 'claude', status: 'idle', active: false, ...over };
}

function tabs(rows: TabChatRow[]): TabChatsMessage {
  return {
    type: 'tab.chats',
    taskKey: KEY,
    chats: rows,
    persist: { taskKey: KEY, chats: rows.map((r) => ({ provider: r.provider, id: `s-${r.id}` })), active: `s-${rows.find((r) => r.active)?.id}` },
  };
}

function type(host: Element, text: string) {
  const ed = host.querySelector<HTMLElement>('.typed')!;
  ed.focus();
  ed.textContent = text;
  ed.dispatchEvent(new Event('input', { bubbles: true }));
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
  tabChats.value = undefined;
  extra.value = [];
});

afterEach(() => vi.restoreAllMocks());

describe('внутренние вкладки чатов', () => {
  it('обычная вкладка чата (tasks.tab = chat): ряда внутренних вкладок нет', async () => {
    const host = mount();
    await flush();
    expect(host.querySelector('.tk-ctabs')).toBeNull();
  });

  it('ряд под полоской: чаты с меткой движка, показанный отмечен, точка статуса, «＋», счётчик', async () => {
    const host = mount();
    handleHostMessage({ type: 'task.state', taskKey: KEY, events: [], fetchedAt: 0, source: 'own' });
    handleHostMessage(
      tabs([
        row('c1', { title: 'почему не печатает' }),
        row('c2', { provider: 'codex', status: 'waiting', active: true }),
        row('c3', { title: '', status: 'working' }),
      ]),
    );
    await flush();
    const bar = host.querySelector('.tk-ctabs')!;
    expect(bar.getAttribute('role')).toBe('tablist');
    // полоска задачи — сразу над рядом вкладок
    expect(bar.previousElementSibling?.classList.contains('tk-strip')).toBe(true);
    const tabsEl = qa(bar, '.ctab');
    expect(tabsEl.map((t) => t.querySelector('.n')!.textContent)).toEqual(['почему не печатает', 'чат c2', 'новый чат']);
    expect(tabsEl.map((t) => t.classList.contains('on'))).toEqual([false, true, false]);
    expect(qa(bar, '[role="tab"]').map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabsEl[1]!.querySelector('.mk')!.classList.contains('codex')).toBe(true);
    // фоновый чат, который ждёт ответа, виден сразу
    expect(tabsEl[1]!.querySelector('.dot.waiting')!.getAttribute('aria-label')).toBe('ждёт ответа');
    expect(tabsEl[2]!.querySelector('.dot.working')).not.toBeNull();
    expect(tabsEl[0]!.querySelector('.dot')).toBeNull();
    expect(bar.querySelector('.rt')!.textContent).toBe('чатов: 3 · общий контекст задачи');
  });

  it('клик по фоновой — tab.select, по показанной — ничего; «×» — tab.close; «＋» — tab.new', async () => {
    const host = mount();
    handleHostMessage(tabs([row('c1', { active: true }), row('c2')]));
    await flush();
    const [first, second] = qa(host, '.tk-ctabs [role="tab"]');
    first!.click();
    second!.click();
    qa(host, '.tk-ctabs .x')[1]!.click();
    host.querySelector<HTMLElement>('.tk-ctabs .plus')!.click();
    expect(sent).toEqual([
      { type: 'tab.select', id: 'c2' },
      { type: 'tab.close', id: 'c2' },
      { type: 'tab.new' },
    ]);
  });

  it('состояние для сериализатора: tab.chats.persist — в setState как taskTab; сброс сессии его не стирает', async () => {
    mount();
    stored = { panel: { w: 300 } };
    const m = tabs([row('c1', { active: true }), row('c2')]);
    handleHostMessage(m);
    expect(stored).toEqual({ panel: { w: 300 }, taskTab: m.persist });
    handleHostMessage({ type: 'session.reset' });
    expect(stored).toEqual({ panel: { w: 300 }, taskTab: m.persist });
  });

  it('переключение: лента прежнего чата сбрасывается, черновик поля и чипы возвращаются при возврате', async () => {
    const host = mount();
    handleHostMessage(tabs([row('c1', { active: true }), row('c2')]));
    handleHostMessage({
      type: 'session.history',
      sessionId: 's-c1',
      events: [{ type: 'user.message', text: 'первый вопрос' } as never],
      skippedTurns: 0,
    });
    await flush();
    expect(chat.value.sessionId).toBe('s-c1');
    type(host, 'недописанное');
    extra.value = [{ kind: 'file', path: '/w/a.ts', name: 'a.ts' } as never];
    await flush();
    handleHostMessage(tabs([row('c1'), row('c2', { active: true })]));
    await flush();
    expect(chat.value.sessionId).toBe('');
    expect(chat.value.rows).toEqual([]);
    expect(host.querySelector('.typed')!.textContent).toBe('');
    expect(extra.value).toEqual([]);
    handleHostMessage(tabs([row('c1', { active: true }), row('c2')]));
    await flush();
    expect(host.querySelector('.typed')!.textContent).toBe('недописанное');
    expect(extra.value).toHaveLength(1);
    // пересев вернувшегося чата (`ready` → `reseed` → `session.history`) чипы черновика не стирает
    handleHostMessage({ type: 'session.history', sessionId: 's-c1', events: [], skippedTurns: 0 });
    expect(extra.value).toHaveLength(1);
    // а следующая история (возобновление другой сессии в этом чате) — как обычно
    handleHostMessage({ type: 'session.history', sessionId: 's-x', events: [], skippedTurns: 0 });
    expect(extra.value).toEqual([]);
  });

  it('переход на чат без задачи: полоска и «Чаты по задаче» прежнего чата пропадают', () => {
    handleHostMessage(tabs([row('c1', { active: true }), row('c2')]));
    taskState.value = { type: 'task.state', taskKey: KEY } as never;
    taskChats.value = [{ id: 's-c1' } as never];
    handleHostMessage(tabs([row('c1'), row('c2', { active: true })]));
    expect(taskState.value).toBeUndefined();
    expect(taskChats.value).toEqual([]);
  });

  it('сообщения хосту помечены показанным чатом (`tab`): хост отбросит запоздавшие сообщения ушедшего в фон', () => {
    vi.mocked(vscode.send).mockRestore();
    toHost.length = 0;
    handleHostMessage(tabs([row('c1', { active: true }), row('c2')]));
    vscode.send({ type: 'session.new' });
    handleHostMessage(tabs([row('c1'), row('c2', { active: true })]));
    vscode.send({ type: 'session.new' });
    expect(toHost).toEqual([
      { type: 'session.new', tab: 'c1' },
      { type: 'session.new', tab: 'c2' },
    ]);
    vscode.setTabChat(undefined);
  });
});
