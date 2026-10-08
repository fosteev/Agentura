// @vitest-environment jsdom
/**
 * Режим задачи во вкладке чата (roadmap 19, этап 5): полоска задачи, вкладка «задача» правой панели (карточка,
 * лента изменений, плашка «пока агент работал», чаты по задаче, ошибки источника), бейдж и кромка нового,
 * `tasks.card`. Эталон — `prototype/screens/task-mode.html`.
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCard, TaskChatRow, TaskEvent, TaskStateMessage } from '../shared/task';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { chat, handleHostMessage, hudState, taskCardMode, taskChats, taskState } from './store';
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

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

const q = <T extends Element = HTMLElement>(host: Element, sel: string) => host.querySelector(sel) as T;
const qa = (host: Element, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const ptabs = (host: Element) => qa(host, '.ptabs [role="tab"]');
const taskTab = (host: Element) => ptabs(host).find((t) => t.id === 'ptab-task');

const T0 = Date.parse('2026-10-08T12:00:00Z');
const KEY = 'jira:inst:NEWMFC-1482';

function card(over: Partial<TaskCard> = {}): TaskCard {
  return {
    key: 'NEWMFC-1482',
    instanceId: 'inst',
    instanceName: 'sccloud',
    title: 'Электронная очередь: талон не печатается после перерыва',
    type: 'Task',
    status: 'В работе',
    statusCategory: 'indeterminate',
    assignee: 'А. Фостеев',
    priority: 'высокий',
    url: 'https://jira.example/browse/NEWMFC-1482',
    updatedAt: T0,
    description: 'Талон выдаётся на экран, но печать не запускается. <b>не жирный</b>',
    attachments: [{ id: 'a1', filename: 'terminal.log', size: 148 * 1024, mimeType: 'text/plain', url: 'https://x/a1' }],
    comments: [
      { id: 'c1', author: 'М. Крылова', mine: false, at: T0 - 3_600_000, text: 'Приложила лог.' },
      { id: 'c2', author: 'И. Петров', mine: false, at: T0 - 1_800_000, text: 'Подтверждаю.' },
    ],
    ...over,
  };
}

function ev(over: Partial<TaskEvent> & Pick<TaskEvent, 'id' | 'kind' | 'at'>): TaskEvent {
  return {
    author: 'Ольга К.',
    mine: false,
    fromThisChat: false,
    duringTurn: false,
    text: '',
    ...over,
  };
}

function state(over: Partial<TaskStateMessage> = {}): TaskStateMessage {
  return { type: 'task.state', taskKey: KEY, card: card(), events: [], fetchedAt: T0, source: 'jiraffe', ...over };
}

const post = (m: TaskStateMessage) => handleHostMessage(m);
const chats = (rows: TaskChatRow[]) => handleHostMessage({ type: 'task.chats', taskKey: KEY, chats: rows });

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-width');
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  stored = undefined;
  sent = [];
  vi.spyOn(vscode, 'send').mockImplementation((m) => void sent.push(m as unknown as Record<string, unknown>));
  chat.value = initialState();
  hudState.value = initialHud();
  taskState.value = undefined;
  taskChats.value = [];
  taskCardMode.value = 'panel';
});

afterEach(() => vi.restoreAllMocks());

describe('полоска и вкладка «задача»', () => {
  it('чат вне задачи: ни полоски, ни вкладки', async () => {
    const host = mount();
    await flush();
    expect(q(host, '.tk-strip')).toBeNull();
    expect(taskTab(host)).toBeUndefined();
    post(state({ taskKey: undefined as unknown as string }));
    await flush();
    expect(q(host, '.tk-strip')).toBeNull();
  });

  it('вкладку отвязали от задачи, а в состоянии панели осталась «задача»: панель падает на «изменения», вкладки нет', async () => {
    stored = { panel: { tab: 'task', taskView: 'changes', taskSeen: T0, taskSeenKey: KEY } };
    const host = mount();
    post(state());
    await flush();
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('task');
    post(state({ taskKey: undefined as unknown as string }));
    await flush();
    expect(q(host, '.tk-strip')).toBeNull();
    expect(taskTab(host)).toBeUndefined();
    expect(q(host, '#pane-task')).toBeNull();
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
  });

  it('чат по задаче: полоска (ключ, статус, название, «в Jiraffe ↗») и вкладка «задача» после git/агентов, доступная и в пустой сессии', async () => {
    const host = mount();
    post(state());
    await flush();
    const strip = q(host, '.tk-strip');
    expect(strip.querySelector('.tkey')!.textContent).toBe('NEWMFC-1482');
    expect(strip.querySelector('.pill.wip')!.textContent).toBe('В работе');
    expect(strip.querySelector('.ttl')!.textContent).toContain('талон не печатается');
    expect(strip.querySelector('.lnk')!.textContent).toBe('в Jiraffe ↗');
    expect(ptabs(host).map((t) => t.id)).toEqual(['ptab-changes', 'ptab-git', 'ptab-agents', 'ptab-task']);
    expect((taskTab(host) as HTMLButtonElement).disabled).toBe(false); // сессия пустая, «задача» всё равно доступна
    // ссылка на задачу: источник не Jiraffe — «в браузере ↗»; клик просит хоста открыть
    post(state({ source: 'own' }));
    await flush();
    const link = q(host, '.tk-strip .lnk');
    expect(link.textContent).toBe('в браузере ↗');
    link.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openExternal' });
  });

  it('карточка: описание и комментарии — текстом (HTML не разбирается), вложения чипами, новые комментарии снизу', async () => {
    const host = mount();
    post(state());
    await flush();
    taskTab(host)!.click();
    await flush();
    const pane = q(host, '#pane-task');
    expect(pane.hidden).toBe(false);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('task');
    expect(pane.querySelector('.tk-ph .tkey')!.textContent).toBe('NEWMFC-1482');
    expect(pane.querySelector('.tk-ph .l2')!.textContent).toContain('А. Фостеев');
    const desc = pane.querySelector('.tk-txt')!;
    expect(desc.textContent).toContain('<b>не жирный</b>');
    expect(desc.querySelector('b')).toBeNull();
    const chip = pane.querySelector<HTMLElement>('.chip2')!;
    expect(chip.textContent).toContain('terminal.log');
    expect(chip.textContent).toContain('148 КБ');
    chip.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openExternal', attachmentId: 'a1' });
    expect(qa(pane, '.tk-cm .w b').map((b) => b.textContent)).toEqual(['М. Крылова', 'И. Петров']);
    // ↻ просит хоста перечитать задачу
    pane.querySelector<HTMLElement>('.tk-ph .refresh')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.refresh' });
  });

  it('длинное описание сворачивается с «ещё»', async () => {
    const host = mount();
    post(state({ card: card({ description: 'строка\n'.repeat(8) }) }));
    await flush();
    taskTab(host)!.click();
    await flush();
    expect(q(host, '.tk-txt').classList.contains('clamp')).toBe(true);
    const more = q(host, '#pane-task .more');
    more.click();
    await flush();
    expect(q(host, '.tk-txt').classList.contains('clamp')).toBe(false);
  });

  it('tasks.card: strip — только полоска; split с Jiraffe — вкладка на «изменениях», без Jiraffe — как panel', async () => {
    const host = mount();
    post(state());
    taskCardMode.value = 'strip';
    await flush();
    expect(q(host, '.tk-strip')).not.toBeNull();
    expect(taskTab(host)).toBeUndefined();
    taskCardMode.value = 'split';
    await flush();
    expect(taskTab(host)).toBeDefined(); // карточка Jiraffe слева, справа — вкладка «задача»
    expect(q(host, '.tk-seg [aria-pressed="true"], .tk-seg [aria-checked="true"], .tk-seg .on')?.textContent).toMatch(/измен/i);
    post(state({ source: 'own' }));
    await flush();
    expect(taskTab(host)).toBeDefined();
    expect(q(host, '.tk-seg [aria-pressed="true"], .tk-seg [aria-checked="true"], .tk-seg .on')?.textContent).not.toMatch(/измен/i);
    // chat.info несёт значение настройки
    taskCardMode.value = 'panel';
    handleHostMessage({
      type: 'chat.info',
      project: 'p',
      cwd: '/p',
      allowBypass: false,
      taskCard: 'strip',
    });
    expect(taskCardMode.value).toBe('strip');
  });
});

describe('лента изменений и «новое»', () => {
  const agent = ev({ id: 'status:1', kind: 'status', at: T0 + 60_000, author: 'А. Фостеев', mine: true, fromThisChat: true, field: 'status', from: 'В работе', to: 'Тестирование', text: 'status: В работе → Тестирование' });
  const human = ev({ id: 'comment:9', kind: 'comment', at: T0 + 120_000, commentId: '9', duringTurn: true, text: 'Проверила на стенде: снова встаёт.' });

  it('новое событие: бейдж на вкладке, в переключателе и в полосе; открытие «изменений» гасит бейдж, кромка остаётся', async () => {
    const host = mount();
    post(state()); // первая загрузка — всё прежнее считается просмотренным
    await flush();
    expect(taskTab(host)!.querySelector('.b')).toBeNull();
    post(state({ events: [human, agent], fetchedAt: T0 + 200_000 }));
    await flush();
    expect(taskTab(host)!.querySelector('.b')!.textContent).toBe('2');
    taskTab(host)!.click();
    await flush();
    const seg = qa(host, '#pane-task .tk-seg button');
    expect(seg[1]!.querySelector('.b')!.textContent).toBe('2');
    seg[1]!.click();
    await flush();
    const rows = qa(host, '#pane-task .tk-evt');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.classList.contains('new'))).toBe(true);
    expect(rows[0]!.querySelector('.nw')!.textContent).toContain('новое');
    // просмотрено: бейджи погашены, подсветка нового пока лента открыта — на месте
    expect(taskTab(host)!.querySelector('.b')).toBeNull();
    expect(q(host, '#pane-task .tk-seg .b')).toBeNull();
    expect(rows[0]!.classList.contains('new')).toBe(true);
    expect((stored as { panel: { taskSeen: number; taskSeenKey: string } }).panel).toMatchObject({
      taskSeen: human.at,
      taskSeenKey: KEY,
    });
    // агент: метка «из этого чата», «от имени»; человек: аватар-инициалы и «человек»
    const agentRow = rows.find((r) => r.dataset.kind === 'status')!;
    expect(agentRow.querySelector('.fr')!.textContent).toBe('из этого чата');
    expect(agentRow.querySelector('.h')!.textContent).toContain('от имени А. Фостеев');
    expect(agentRow.querySelector('.bd')!.textContent).toBe('статус: В работе → Тестирование');
    const humanRow = rows.find((r) => r.dataset.kind === 'comment')!;
    expect(humanRow.classList.contains('hum')).toBe(true);
    expect(humanRow.querySelector('.av2')!.textContent).toBe('ОК');
    expect(humanRow.querySelector('.fr')).toBeNull();
  });

  it('повторный опрос без изменений бейдж не возвращает; humanChanges=false: открытая лента отмечает и комментарии карточки', async () => {
    const host = mount();
    post(state({ humanChanges: false }));
    await flush();
    const fresh = { id: 'c3', author: 'О. К.', mine: false, at: T0 + 300_000, text: 'Новый комментарий.' };
    post(state({ humanChanges: false, card: card({ comments: [...card().comments, fresh] }), events: [human, agent], fetchedAt: T0 + 400_000 }));
    await flush();
    expect(taskTab(host)!.querySelector('.b')!.textContent).toBe('1'); // чужое событие спрятано, своё — новое
    taskTab(host)!.click();
    await flush();
    expect(q(host, '#pane-task .tk-cm[data-comment="c3"]').classList.contains('new')).toBe(true);
    qa(host, '#pane-task .tk-seg button')[1]!.click();
    await flush();
    expect((stored as { panel: { taskSeen: number } }).panel.taskSeen).toBe(fresh.at);
    // тот же снимок с новым временем опроса — нового нет
    post(state({ humanChanges: false, card: card({ comments: [...card().comments, fresh] }), events: [human, agent], fetchedAt: T0 + 430_000 }));
    await flush();
    qa(host, '#pane-task .tk-seg button')[0]!.click();
    await flush();
    expect(taskTab(host)!.querySelector('.b')).toBeNull();
    expect(q(host, '#pane-task .tk-cm[data-comment="c3"]').classList.contains('new')).toBe(false);
  });

  it('комментарий человека во время хода: плашка с именем, «в чат» вставляет в поле (task.toComposer) и закрывает плашку', async () => {
    const host = mount();
    post(state());
    await flush();
    post(state({ events: [human, agent], fetchedAt: T0 + 200_000 }));
    taskTab(host)!.click();
    await flush();
    qa(host, '#pane-task .tk-seg button')[1]!.click();
    await flush();
    const ban = q(host, '#pane-task .tk-ban');
    expect(ban.textContent).toContain('Ольга К. прокомментировал(а), пока агент работал. Отправить агенту?');
    ban.querySelector<HTMLElement>('button')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.toComposer', commentId: '9' });
    await flush();
    expect(q(host, '#pane-task .tk-ban')).toBeNull();
    // сама запись в ленте остаётся
    expect(qa(host, '#pane-task .tk-evt')).toHaveLength(2);
  });

  it('комментарий человека вне хода плашки не даёт; humanChanges=false прячет чужие события и плашку', async () => {
    const host = mount();
    post(state());
    await flush();
    post(state({ events: [{ ...human, duringTurn: false }, agent], fetchedAt: T0 + 200_000 }));
    taskTab(host)!.click();
    await flush();
    qa(host, '#pane-task .tk-seg button')[1]!.click();
    await flush();
    expect(q(host, '#pane-task .tk-ban')).toBeNull();
    expect(qa(host, '#pane-task .tk-evt')).toHaveLength(2);
    // настройка выключена: чужое не показывается даже если хост прислал
    post(state({ events: [human, agent], humanChanges: false, fetchedAt: T0 + 300_000 }));
    await flush();
    expect(q(host, '#pane-task .tk-ban')).toBeNull();
    const rows = qa(host, '#pane-task .tk-evt');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dataset.kind).toBe('status');
  });

  it('пустая лента — подсказка; свернутая панель: кнопка «задача» в полосе с бейджем, клик открывает вкладку', async () => {
    const host = mount();
    post(state());
    await flush();
    taskTab(host)!.click();
    await flush();
    qa(host, '#pane-task .tk-seg button')[1]!.click();
    await flush();
    expect(q(host, '#pane-task .tk-body .empty').textContent).toContain('ничего не менялось');
    q(host, '.phide').click();
    await flush();
    post(state({ events: [agent], fetchedAt: T0 + 200_000 }));
    await flush();
    const railBtn = qa(host, '.rail button').find((b) => b.getAttribute('aria-label')?.includes('задача'))!;
    expect(railBtn.querySelector('.b.live')!.textContent).toBe('1');
    railBtn.click();
    await flush();
    expect(q(host, '.body').getAttribute('data-side')).toBeNull();
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('task');
  });
});

describe('чаты по задаче и ошибки источника', () => {
  it('блок чатов: текущий отмечен, другой открывается (task.openChat), «новый чат» шлёт task.newChat с ключом', async () => {
    const host = mount();
    post(state());
    chats([
      { id: 's2', provider: 'codex', title: 'восстановление очереди печати', updatedAt: T0, state: 'live', current: true },
      { id: 's1', provider: 'claude', title: 'почему не печатает', updatedAt: T0 - 86_400_000, state: 'idle', current: false },
    ]);
    await flush();
    taskTab(host)!.click();
    await flush();
    const foot = q(host, '#pane-task .tk-chats');
    expect(foot.querySelector('h5 em')!.textContent).toBe('2');
    const cur = foot.querySelector('.r.cur')!;
    expect(cur.getAttribute('aria-current')).toBe('true');
    expect(cur.textContent).toContain('этот');
    expect(cur.querySelector('.mk.codex')).not.toBeNull();
    const other = foot.querySelector<HTMLElement>('button.r')!;
    expect(other.textContent).toContain('почему не печатает');
    other.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openChat', sessionId: 's1' });
    foot.querySelector<HTMLElement>('.newchat')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.newChat', taskKey: KEY });
    // вкладка ушла из задачи — чаты сбрасываются
    handleHostMessage({ type: 'task.state', events: [], fetchedAt: 0, source: 'none' });
    expect(taskChats.value).toEqual([]);
  });

  it('нет подключения: строка в шапке с «подключить»; без карточки — только она', async () => {
    const host = mount();
    post(
      state({
        card: undefined,
        fetchedAt: 0,
        source: 'none',
        error: { code: 'no-source', message: 'Jira не подключена.' },
      }),
    );
    await flush();
    taskTab(host)!.click();
    await flush();
    const err = q(host, '#pane-task .tk-err');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('Jira не подключена.');
    expect(qa(err, 'button').map((b) => b.textContent)).toEqual(['подключить']);
    err.querySelector('button')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.connect' });
    expect(q(host, '#pane-task .tk-txt')).toBeNull();
    // полоска остаётся: ключ из ключа группы, ссылки на задачу без карточки нет
    expect(q(host, '.tk-strip .tkey').textContent).toBe('NEWMFC-1482');
    expect(q(host, '.tk-strip .lnk')).toBeNull();
  });

  it('401: подсказка про токен и ↻, «подключить» и «повторить»; сеть — «повторить» и устаревшая карточка', async () => {
    const host = mount();
    post(state({ error: { code: 'auth', message: 'Jira отклонила токен (401).' } }));
    await flush();
    taskTab(host)!.click();
    await flush();
    const err = q(host, '#pane-task .tk-err');
    expect(err.textContent).toContain('Проверьте токен и нажмите ↻.');
    expect(qa(err, 'button').map((b) => b.textContent)).toEqual(['подключить', 'повторить']);
    expect(q(host, '#pane-task .tk-txt')).not.toBeNull(); // карточка устарела, но показана
    post(state({ error: { code: 'network', message: 'Нет связи с Jira.' } }));
    await flush();
    const net = q(host, '#pane-task .tk-err');
    expect(qa(net, 'button').map((b) => b.textContent)).toEqual(['повторить']);
    expect(net.textContent).toContain('последние загруженные данные');
    qa(net, 'button')[0]!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.refresh' });
  });
});

describe('узкая вёрстка', () => {
  it('вкладка «задача» в шапке; открытие показывает панель, бейдж события — в шапке', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    const host = mount();
    post(state());
    await flush();
    const tabs = qa(host, '.tabs [role="tab"]');
    expect(tabs.map((t) => t.id)).toEqual(['tab-chat', 'tab-changes', 'tab-git', 'tab-agents', 'tab-task']);
    expect((tabs[4] as HTMLButtonElement).disabled).toBe(false);
    post(state({ events: [ev({ id: 'worklog:1', kind: 'worklog', at: T0 + 1000, text: '1h' })], fetchedAt: T0 + 2000 }));
    await flush();
    expect(qa(host, '.tabs [role="tab"]')[4]!.querySelector('.b')!.textContent).toBe('1');
    qa(host, '.tabs [role="tab"]')[4]!.click();
    await flush();
    expect(q(host, '#pane-task').hidden).toBe(false);
    expect(q(host, '#pane-task').getAttribute('aria-labelledby')).toBe('tab-task');
  });
});
