// @vitest-environment jsdom
/**
 * Режим задачи во вкладке чата (roadmap 19, этап 5; roadmap 20, этап 2): полоса задачи с вкладками «чат | задача»,
 * вкладка «задача» на всю вкладку чата (карточка, комментарии, история, ворклог, лента изменений, плашка «пока агент
 * работал», запись от имени пользователя, чаты по задаче, ошибки источника), индикаторы на «чате», бейдж и кромка
 * нового, `tasks.card`. Эталон — `prototype/screens/task-tab.html`.
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCard, TaskChatRow, TaskEvent, TaskStateMessage } from '../shared/task';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import {
  chat,
  dispatchEvent,
  handleHostMessage,
  hudState,
  taskAction,
  taskCardMode,
  taskChats,
  taskFocus,
  taskState,
  taskTransitions,
} from './store';
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
/** Вкладки «чат | задача» полосы задачи. */
const vtab = (host: Element, which: 'chat' | 'task') => q(host, `#vtab-${which}`);
const subtab = (host: Element, i: number) => qa(host, '#pane-task .subtabs button')[i]!;
const SUB = { comments: 0, history: 1, worklog: 2, changes: 3 } as const;

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
    descriptionHtml: '<p>Талон выдаётся на экран, но печать не запускается.</p>',
    created: T0 - 86_400_000,
    labels: [],
    components: [],
    fixVersions: [],
    time: {},
    history: [],
    worklogs: [],
    canWrite: true,
    attachments: [{ id: 'a1', filename: 'terminal.log', size: 148 * 1024, mimeType: 'text/plain', url: 'https://x/a1' }],
    comments: [
      { id: 'c1', author: 'М. Крылова', mine: false, at: T0 - 3_600_000, text: 'Приложила лог.', html: '<p>Приложила лог.</p>' },
      { id: 'c2', author: 'И. Петров', mine: false, at: T0 - 1_800_000, text: 'Подтверждаю.', html: '<p>Подтверждаю.</p>' },
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
  taskCardMode.value = 'tab';
  taskFocus.value = undefined;
  taskAction.value = undefined;
  taskTransitions.value = undefined;
});

afterEach(() => vi.restoreAllMocks());

/** Открыть вкладку «задача» полосы. */
async function openTask(host: Element, sub?: keyof typeof SUB) {
  vtab(host, 'task').click();
  await flush();
  if (sub) {
    subtab(host, SUB[sub]).click();
    await flush();
  }
}

describe('полоса задачи и вкладки «чат | задача»', () => {
  it('чат вне задачи: ни полосы, ни вкладки', async () => {
    const host = mount();
    await flush();
    expect(q(host, '.tk-strip')).toBeNull();
    expect(q(host, '#pane-task')).toBeNull();
    post(state({ taskKey: undefined as unknown as string }));
    await flush();
    expect(q(host, '.tk-strip')).toBeNull();
  });

  it('старое состояние панели с «задачей» падает на «изменения»; вкладку отвязали от задачи — «задача» уходит, вид сбрасывается на чат', async () => {
    stored = { panel: { tab: 'task', taskView: 'card', view: 'task', taskSeen: T0, taskSeenKey: KEY } };
    const host = mount();
    post(state());
    await flush();
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
    expect(ptabs(host).map((t) => t.id)).toEqual(['ptab-changes', 'ptab-git', 'ptab-agents']);
    expect(q(host, '.webview').getAttribute('data-view')).toBe('task'); // сохранённый вид
    expect(subtab(host, SUB.comments).getAttribute('aria-selected')).toBe('true'); // 'card' → комментарии
    post(state({ taskKey: undefined as unknown as string }));
    await flush();
    expect(q(host, '.tk-strip')).toBeNull();
    expect(q(host, '#pane-task')).toBeNull();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
  });

  it('полоса: вкладки «чат | задача», ключ, статус, название, «в Jiraffe ↗»; в правой панели «задачи» нет, доступна и в пустой сессии', async () => {
    const host = mount();
    post(state());
    await flush();
    const strip = q(host, '.tk-strip');
    expect(qa(strip, '.vtab').map((b) => b.textContent)).toEqual(['чат', 'задача']);
    expect(vtab(host, 'chat').getAttribute('aria-selected')).toBe('true');
    expect(strip.querySelector('.tkey')!.textContent).toBe('NEWMFC-1482');
    expect(strip.querySelector('.pill.wip')!.textContent).toBe('В работе');
    expect(strip.querySelector('.ttl')!.textContent).toContain('талон не печатается');
    expect(strip.querySelector('.lnk')!.textContent).toBe('в Jiraffe ↗');
    expect(ptabs(host).map((t) => t.id)).toEqual(['ptab-changes', 'ptab-git', 'ptab-agents']);
    expect(qa(host, '.rail button').some((b) => b.getAttribute('aria-label')?.includes('задача'))).toBe(false);
    // ссылка на задачу: источник не Jiraffe — «в браузере ↗»; клик просит хоста открыть
    post(state({ source: 'own' }));
    await flush();
    const link = q(host, '.tk-strip .lnk');
    expect(link.textContent).toBe('в браузере ↗');
    link.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openExternal' });
  });

  it('«задача» занимает вкладку, а лента и поле ввода остаются в DOM; возврат на «чат»; вид запоминается в состоянии панели', async () => {
    const host = mount();
    post(state());
    await flush();
    expect(q(host, '#pane-task').hidden).toBe(true);
    await openTask(host);
    expect(q(host, '.webview').getAttribute('data-view')).toBe('task');
    expect(q(host, '#pane-task').hidden).toBe(false);
    expect(vtab(host, 'task').getAttribute('aria-selected')).toBe('true');
    // ничего не размонтировано — прячет CSS по data-view
    expect(q(host, '#pane-chat')).not.toBeNull();
    expect(q(host, '.compose')).not.toBeNull();
    expect((stored as { panel: { view: string } }).panel.view).toBe('task');
    vtab(host, 'chat').click();
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
    expect(q(host, '#pane-task').hidden).toBe(true);
    expect((stored as { panel: { view: string } }).panel.view).toBe('chat');
  });

  it('карточка: описание HTML через санитайзер, вложения плитками, комментарии снизу, ↻ и ссылки через хост', async () => {
    const host = mount();
    post(
      state({
        card: card({
          descriptionHtml:
            '<p>Талон <b>не</b> печатается <a href="https://jira.example/browse/X-1">X-1</a> <a href="javascript:alert(1)">плохая</a></p><script>alert(1)</script><img src="/secure/a.png" onerror="alert(1)">',
        }),
      }),
    );
    await flush();
    await openTask(host);
    const pane = q(host, '#pane-task');
    expect(pane.querySelector('.crumb .tkey')!.textContent).toBe('NEWMFC-1482');
    expect(pane.querySelector('h1')!.textContent).toContain('талон не печатается');
    const desc = pane.querySelector<HTMLElement>('.rich')!;
    expect(desc.querySelector('b')!.textContent).toBe('не');
    expect(desc.querySelector('script')).toBeNull();
    expect(desc.querySelector('img')).toBeNull();
    expect(desc.querySelector('[data-ph]')!.textContent).toBe('[картинка]');
    expect(desc.innerHTML).not.toContain('onerror');
    const links = [...desc.querySelectorAll('a')];
    expect(links[0]!.getAttribute('href')).toBe('https://jira.example/browse/X-1');
    expect(links[1]!.hasAttribute('href')).toBe(false);
    // клик по ссылке не уходит в webview — хост открывает сам
    links[0]!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openLink', url: 'https://jira.example/browse/X-1' });
    const before = sent.length;
    links[1]!.click();
    expect(sent.length).toBe(before);
    const tile = pane.querySelector<HTMLElement>('.att')!;
    expect(tile.querySelector('.th')!.textContent).toBe('.LOG');
    expect(tile.textContent).toContain('terminal.log');
    expect(tile.textContent).toContain('148 КБ');
    tile.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openExternal', attachmentId: 'a1' });
    expect(qa(pane, '.cmt .w b').map((b) => b.textContent)).toEqual(['М. Крылова', 'И. Петров']);
    expect(pane.querySelector('.cmt .rich')!.textContent).toBe('Приложила лог.');
    pane.querySelector<HTMLElement>('.crumb .rf')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.refresh' });
  });

  it('без HTML (старый хост) описание и комментарий — обычным текстом; длинное описание сворачивается с «показать целиком»', async () => {
    const host = mount();
    post(
      state({
        card: card({
          description: 'строка <b>x</b>\n'.repeat(60),
          descriptionHtml: '<p>' + 'длинная строка '.repeat(80) + '</p>',
          comments: [{ id: 'c1', author: 'М. К.', mine: false, at: T0, text: 'Просто <i>текст</i>', html: '' }],
        }),
      }),
    );
    await flush();
    await openTask(host);
    expect(q(host, '#pane-task .rich').classList.contains('clamp')).toBe(true);
    q(host, '#pane-task .more').click();
    await flush();
    expect(q(host, '#pane-task .rich').classList.contains('clamp')).toBe(false);
    const cm = q(host, '#pane-task .cmt .rich');
    expect(cm.textContent).toBe('Просто <i>текст</i>');
    expect(cm.querySelector('i')).toBeNull();
  });

  it('правая колонка: поля, время с прогрессом; история и ворклог — подвкладками', async () => {
    const host = mount();
    post(
      state({
        card: card({
          reporter: 'М. Крылова',
          labels: ['printer'],
          components: ['smart_eq_terminal'],
          time: { originalSec: 6 * 3600, spentSec: 2 * 3600 },
          history: [
            { at: T0 - 5000, author: 'Ольга К.', items: [{ field: 'status', from: 'Open', to: 'В работе' }] },
            { at: T0 - 1000, author: 'И. Петров', items: [{ field: 'priority', from: null, to: 'высокий' }] },
          ],
          worklogs: [{ id: 'w1', author: 'А. Фостеев', mine: true, at: T0, seconds: 5400, comment: 'разбирался' }],
        }),
      }),
    );
    await flush();
    await openTask(host);
    const side = q(host, '.tv-side');
    expect(side.textContent).toContain('smart_eq_terminal');
    expect(side.textContent).toContain('М. Крылова');
    expect(side.querySelector('.tags')!.textContent).toBe('printer');
    expect(side.querySelector('.tm2')!.textContent).toContain('2h из 6h');
    expect(side.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('33');
    expect(subtab(host, SUB.history).textContent).toContain('2');
    subtab(host, SUB.history).click();
    await flush();
    const hist = qa(host, '#pane-task .hist');
    expect(hist[0]!.textContent).toContain('И. Петров'); // новые сверху
    expect(hist[0]!.textContent).toContain('— → высокий');
    subtab(host, SUB.worklog).click();
    await flush();
    const wl = q(host, '#pane-task .wl');
    expect(wl.textContent).toContain('1h 30m');
    expect(wl.textContent).toContain('разбирался');
    expect((stored as { panel: { taskView: string } }).panel.taskView).toBe('worklog');
  });

  it('tasks.card: tab — подвкладка «комментарии»; split с Jiraffe — «изменения», без Jiraffe — как tab; вкладка «задача» есть всегда', async () => {
    const host = mount();
    post(state());
    taskCardMode.value = 'tab';
    await flush();
    expect(vtab(host, 'task')).not.toBeNull();
    expect(subtab(host, SUB.comments).getAttribute('aria-selected')).toBe('true');
    taskCardMode.value = 'split';
    await flush();
    expect(vtab(host, 'task')).not.toBeNull();
    expect(subtab(host, SUB.changes).getAttribute('aria-selected')).toBe('true');
    post(state({ source: 'own' }));
    await flush();
    expect(subtab(host, SUB.comments).getAttribute('aria-selected')).toBe('true');
    // chat.info несёт значение настройки
    taskCardMode.value = 'tab';
    handleHostMessage({
      type: 'chat.info',
      project: 'p',
      cwd: '/p',
      allowBypass: false,
      taskCard: 'split',
    });
    expect(taskCardMode.value).toBe('split');
  });
});

describe('лента изменений и «новое»', () => {
  const agent = ev({ id: 'status:1', kind: 'status', at: T0 + 60_000, author: 'А. Фостеев', mine: true, fromThisChat: true, field: 'status', from: 'В работе', to: 'Тестирование', text: 'status: В работе → Тестирование' });
  const human = ev({ id: 'comment:9', kind: 'comment', at: T0 + 120_000, commentId: '9', duringTurn: true, text: 'Проверила на стенде: снова встаёт.' });

  it('новое событие: бейдж на вкладке «задача» и на подвкладке; открытие «изменений» гасит бейдж, кромка остаётся', async () => {
    const host = mount();
    post(state()); // первая загрузка — всё прежнее считается просмотренным
    await flush();
    expect(vtab(host, 'task').querySelector('.nb')).toBeNull();
    post(state({ events: [human, agent], fetchedAt: T0 + 200_000 }));
    await flush();
    expect(vtab(host, 'task').querySelector('.nb')!.textContent).toBe('2');
    await openTask(host);
    expect(vtab(host, 'task').querySelector('.nb')).toBeNull(); // открыта «задача» — бейдж на её вкладке не нужен
    expect(subtab(host, SUB.changes).querySelector('.cnt')!.textContent).toBe('2');
    subtab(host, SUB.changes).click();
    await flush();
    const rows = qa(host, '#pane-task .tk-evt');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.classList.contains('new'))).toBe(true);
    expect(rows[0]!.querySelector('.nw')!.textContent).toContain('новое');
    // просмотрено: бейджи погашены, подсветка нового пока лента открыта — на месте
    expect(subtab(host, SUB.changes).querySelector('.cnt')).toBeNull();
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
    const fresh = { id: 'c3', author: 'О. К.', mine: false, at: T0 + 300_000, text: 'Новый комментарий.', html: '' };
    post(state({ humanChanges: false, card: card({ comments: [...card().comments, fresh] }), events: [human, agent], fetchedAt: T0 + 400_000 }));
    await flush();
    expect(vtab(host, 'task').querySelector('.nb')!.textContent).toBe('1'); // чужое событие спрятано, своё — новое
    await openTask(host);
    expect(q(host, '#pane-task .cmt[data-comment="c3"]').classList.contains('new')).toBe(true);
    subtab(host, SUB.changes).click();
    await flush();
    expect((stored as { panel: { taskSeen: number } }).panel.taskSeen).toBe(fresh.at);
    // тот же снимок с новым временем опроса — нового нет
    post(state({ humanChanges: false, card: card({ comments: [...card().comments, fresh] }), events: [human, agent], fetchedAt: T0 + 430_000 }));
    await flush();
    subtab(host, SUB.comments).click();
    await flush();
    vtab(host, 'chat').click();
    await flush();
    expect(vtab(host, 'task').querySelector('.nb')).toBeNull();
    expect(q(host, '#pane-task .cmt[data-comment="c3"]').classList.contains('new')).toBe(false);
  });

  it('комментарий человека во время хода: плашка с именем, «в чат» вставляет в поле (task.toComposer), закрывает плашку и уводит на «чат»', async () => {
    const host = mount();
    post(state());
    await flush();
    post(state({ events: [human, agent], fetchedAt: T0 + 200_000 }));
    await openTask(host, 'changes');
    const ban = q(host, '#pane-task .tk-ban');
    expect(ban.textContent).toContain('Ольга К. прокомментировал(а), пока агент работал. Отправить агенту?');
    ban.querySelector<HTMLElement>('button')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.toComposer', commentId: '9' });
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
    // сама запись в ленте остаётся, плашка закрыта
    vtab(host, 'task').click();
    await flush();
    expect(q(host, '#pane-task .tk-ban')).toBeNull();
    expect(qa(host, '#pane-task .tk-evt')).toHaveLength(2);
  });

  it('комментарий человека вне хода плашки не даёт; humanChanges=false прячет чужие события и плашку', async () => {
    const host = mount();
    post(state());
    await flush();
    post(state({ events: [{ ...human, duringTurn: false }, agent], fetchedAt: T0 + 200_000 }));
    await openTask(host, 'changes');
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

  it('пустая лента — подсказка', async () => {
    const host = mount();
    post(state());
    await flush();
    await openTask(host, 'changes');
    expect(q(host, '#pane-task .evs .empty').textContent).toContain('ничего не менялось');
  });
});

describe('запись от имени пользователя', () => {
  const act = (kind: 'transition' | 'comment' | 'logWork', ok = true, error?: string) =>
    handleHostMessage({ type: 'task.action', kind, ok, ...(error ? { error } : {}) });

  it('статус: меню из task.transitions, пункт с обязательными полями неактивен, выбор шлёт task.transition и блокирует кнопку до task.action', async () => {
    const host = mount();
    post(state());
    await flush();
    await openTask(host);
    const btn = q<HTMLButtonElement>(host, '#pane-task .btn.st');
    expect(btn.textContent).toContain('В работе');
    btn.click();
    await flush();
    expect(sent.at(-1)).toEqual({ type: 'task.transitions' });
    expect(q(host, '#pane-task .stmenu').textContent).toContain('Загружаю');
    handleHostMessage({
      type: 'task.transitions',
      items: [
        { id: '31', name: 'На тест', to: { name: 'Тестирование', category: 'indeterminate' }, requiresFields: false },
        { id: '41', name: 'Закрыть', to: { name: 'Готово', category: 'done' }, requiresFields: true },
      ],
    });
    await flush();
    const items = qa(host, '#pane-task .stmenu .it');
    expect(items.map((i) => i.textContent)).toEqual(['На тест→ Тестирование', 'Закрыть→ Готово']);
    expect(items[1]!.getAttribute('aria-disabled')).toBe('true');
    const n = sent.length;
    items[1]!.click();
    expect(sent.length).toBe(n); // отказ по полям — ничего не уходит
    items[0]!.click();
    await flush();
    expect(sent.at(-1)).toEqual({ type: 'task.transition', transitionId: '31' });
    expect(q<HTMLButtonElement>(host, '#pane-task .btn.st').disabled).toBe(true);
    act('transition');
    await flush();
    expect(q<HTMLButtonElement>(host, '#pane-task .btn.st').disabled).toBe(false);
  });

  it('статус: ошибка записи — строкой под кнопками; no-writer в переходах — подсказка в меню', async () => {
    const host = mount();
    post(state());
    await flush();
    await openTask(host);
    q(host, '#pane-task .btn.st').click();
    handleHostMessage({ type: 'task.transitions', items: [], error: 'no-writer' });
    await flush();
    expect(q(host, '#pane-task .stmenu').textContent).toContain('обновите Jiraffe');
    handleHostMessage({
      type: 'task.transitions',
      items: [{ id: '31', name: 'На тест', to: { name: 'Тестирование', category: 'indeterminate' }, requiresFields: false }],
    });
    await flush();
    q(host, '#pane-task .stmenu .it').click();
    act('transition', false, 'Jira: 400');
    await flush();
    expect(q(host, '#pane-task .act-err').textContent).toBe('Не вышло: Jira: 400');
  });

  it('комментарий: Ctrl+Enter отправляет, кнопка заблокирована до task.action; успех очищает поле, ошибка оставляет текст', async () => {
    const host = mount();
    post(state());
    await flush();
    await openTask(host);
    const ta = q<HTMLTextAreaElement>(host, '#pane-task .reply textarea');
    const send = q<HTMLButtonElement>(host, '#pane-task .reply .btn');
    expect(send.disabled).toBe(true); // пусто
    ta.value = 'Готово, проверьте';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(send.disabled).toBe(false);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(sent.at(-1)).toEqual({ type: 'task.comment', body: 'Готово, проверьте' });
    expect(send.disabled).toBe(true);
    const n = sent.length;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    expect(sent.length).toBe(n); // второй запрос до ответа не уходит
    act('comment', false, 'Jira: 500');
    await flush();
    expect(q(host, '#pane-task .reply + .act-err').textContent).toBe('Не вышло: Jira: 500');
    expect(ta.value).toBe('Готово, проверьте');
    expect(send.disabled).toBe(false);
    send.click();
    await flush();
    act('comment');
    await flush();
    expect(q<HTMLTextAreaElement>(host, '#pane-task .reply textarea').value).toBe('');
    expect(host.querySelector('#pane-task .reply + .act-err')).toBeNull();
  });

  it('ворклог: форма с проверкой времени, task.logWork с секундами и датой, успех закрывает форму', async () => {
    const host = mount();
    post(state());
    await flush();
    await openTask(host);
    qa(host, '#pane-task .bar .btn').find((b) => b.textContent === 'Ворклог')!.click();
    await flush();
    const form = q(host, '#pane-task .wlform');
    const inputs = qa(form, 'input');
    const set = (el: HTMLElement, v: string) => {
      (el as HTMLInputElement).value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs[0]!, 'abc');
    set(inputs[1]!, '2026-10-08');
    set(inputs[2]!, 'разбирался');
    await flush();
    form.querySelector<HTMLElement>('button[type="submit"]')!.click();
    await flush();
    expect(q(host, '#pane-task .wlform .act-err').textContent).toContain('1h 30m');
    expect(sent.some((m) => m.type === 'task.logWork')).toBe(false);
    set(inputs[0]!, '1h 30m');
    await flush();
    form.querySelector<HTMLElement>('button[type="submit"]')!.click();
    await flush();
    expect(sent.at(-1)).toEqual({ type: 'task.logWork', seconds: 5400, date: '2026-10-08', comment: 'разбирался' });
    expect(q<HTMLButtonElement>(host, '#pane-task .wlform button[type="submit"]').disabled).toBe(true);
    act('logWork');
    await flush();
    expect(q(host, '#pane-task .wlform')).toBeNull();
  });

  it('источник не пишет (canWrite=false): статус, ворклог и комментарий неактивны с подсказкой «обновите Jiraffe»', async () => {
    const host = mount();
    post(state({ card: card({ canWrite: false }) }));
    await flush();
    await openTask(host);
    expect(q<HTMLButtonElement>(host, '#pane-task .btn.st').disabled).toBe(true);
    expect(q(host, '#pane-task .btn.st').getAttribute('data-tip')).toContain('обновите Jiraffe');
    const wl = qa(host, '#pane-task .bar .btn').find((b) => b.textContent === 'Ворклог') as HTMLButtonElement;
    expect(wl.disabled).toBe(true);
    expect(q<HTMLTextAreaElement>(host, '#pane-task .reply textarea').disabled).toBe(true);
  });

  it('«↳ в чат»: у карточки — task.toComposer без commentId, у комментария — с ним; после этого открыт «чат»', async () => {
    const host = mount();
    post(state());
    await flush();
    await openTask(host);
    q(host, '#pane-task .btn.pri').click();
    expect(sent.at(-1)).toEqual({ type: 'task.toComposer' });
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
    await openTask(host);
    q(host, '#pane-task .cmt[data-comment="c2"] .tochat').click();
    expect(sent.at(-1)).toEqual({ type: 'task.toComposer', commentId: 'c2' });
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
  });
});

describe('индикаторы на «чате», пока открыта «задача»', () => {
  it('идёт ход — спиннер и число новых записей с момента переключения; ход идёт и на «чате» — индикаторов нет', async () => {
    const host = mount();
    post(state());
    const at = Date.now() - 5000;
    dispatchEvent({ type: 'turn.start', at, prompt: 'сделай' }, at);
    await flush();
    expect(vtab(host, 'chat').querySelector('.spin')).toBeNull();
    await openTask(host);
    expect(vtab(host, 'chat').querySelector('.spin')).not.toBeNull();
    expect(vtab(host, 'chat').querySelector('.nb')).toBeNull();
    expect(q(host, '.tk-strip .run').textContent).toMatch(/^ход /);
    dispatchEvent({ type: 'tool.start', toolUseId: 't1', name: 'Read', input: { file_path: '/p/a.ts' } }, at + 100);
    dispatchEvent({ type: 'tool.start', toolUseId: 't2', name: 'Read', input: { file_path: '/p/b.ts' } }, at + 200);
    await flush();
    expect(vtab(host, 'chat').querySelector('.nb')!.textContent).toBe('2');
    vtab(host, 'chat').click();
    await flush();
    expect(vtab(host, 'chat').querySelector('.spin')).toBeNull();
  });

  it('агент ждёт ответа — жёлтая точка и тост «к чату»; тост исчезает, когда ожидание снято', async () => {
    const host = mount();
    post(state());
    const at = Date.now() - 5000;
    dispatchEvent({ type: 'turn.start', at, prompt: 'сделай' }, at);
    await flush();
    await openTask(host);
    expect(q(host, '#pane-task .toast2')).toBeNull();
    dispatchEvent(
      { type: 'permission.request', toolUseId: 'p1', toolName: 'Bash', input: { command: 'git push' }, description: 'git push' } as never,
      at + 100,
    );
    await flush();
    expect(vtab(host, 'chat').querySelector('.wt')).not.toBeNull();
    expect(vtab(host, 'chat').querySelector('.spin')).toBeNull();
    const toast = q(host, '#pane-task .toast2');
    expect(toast.textContent).toContain('Агент ждёт ответа: git push');
    toast.querySelector('button')!.click();
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
    vtab(host, 'task').click();
    await flush();
    dispatchEvent({ type: 'permission.resolved', toolUseId: 'p1', decision: 'allow' } as never, at + 200);
    await flush();
    expect(q(host, '#pane-task .toast2')).toBeNull();
    expect(vtab(host, 'chat').querySelector('.wt')).toBeNull();
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
    await openTask(host);
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

  it('нет подключения: строка с «подключить»; без карточки — только она', async () => {
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
    await openTask(host);
    const err = q(host, '#pane-task .tk-err');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('Jira не подключена.');
    expect(qa(err, 'button').map((b) => b.textContent)).toEqual(['подключить']);
    err.querySelector('button')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.connect' });
    expect(q(host, '#pane-task h1')).toBeNull();
    // полоса остаётся: ключ из ключа группы, ссылки на задачу без карточки нет
    expect(q(host, '.tk-strip .tkey').textContent).toBe('NEWMFC-1482');
    expect(q(host, '.tk-strip .lnk')).toBeNull();
  });

  it('401: подсказка про токен и ↻, «подключить» и «повторить»; сеть — «повторить» и устаревшая карточка', async () => {
    const host = mount();
    post(state({ error: { code: 'auth', message: 'Jira отклонила токен (401).' } }));
    await flush();
    await openTask(host);
    const err = q(host, '#pane-task .tk-err');
    expect(err.textContent).toContain('Проверьте токен и нажмите ↻.');
    expect(qa(err, 'button').map((b) => b.textContent)).toEqual(['подключить', 'повторить']);
    expect(q(host, '#pane-task h1')).not.toBeNull(); // карточка устарела, но показана
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
  it('в шапке нет вкладки «задача»; вкладки «чат | задача» — в полосе; вкладка шапки уводит с «задачи» на чат', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    const host = mount();
    post(state());
    await flush();
    expect(qa(host, '.tabs [role="tab"]').map((t) => t.id)).toEqual(['tab-chat', 'tab-changes', 'tab-git', 'tab-agents']);
    post(state({ events: [ev({ id: 'worklog:1', kind: 'worklog', at: T0 + 1000, text: '1h' })], fetchedAt: T0 + 2000 }));
    await flush();
    expect(vtab(host, 'task').querySelector('.nb')!.textContent).toBe('1');
    await openTask(host);
    expect(q(host, '#pane-task').hidden).toBe(false);
    qa(host, '.tabs [role="tab"]')[0]!.click();
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat');
  });
});

describe('инструменты Jira агента в ленте (этап 8)', () => {
  /** Ход с вызовом `mcp__agentura_jira__<tool>` и его результатом. */
  function toolRow(tool: string, input: Record<string, unknown>, content: string, isError = false) {
    handleHostMessage({ type: 'chat.info', project: 'p', cwd: '/p', allowBypass: false, taskCard: taskCardMode.value });
    let at = Date.now() - 5_000;
    dispatchEvent({ type: 'turn.start', at, prompt: 'сделай' }, at);
    dispatchEvent({ type: 'tool.start', toolUseId: 'j1', name: `mcp__agentura_jira__${tool}`, input }, (at += 10));
    dispatchEvent({ type: 'tool.result', toolUseId: 'j1', isError, content, durationMs: 300 }, at + 10);
  }
  const row = (host: Element) => qa(host, '.log .e').find((e) => e.querySelector('.op')?.textContent === 'jira')!;

  it('«jira · комментарий NEWMFC-1482 ✓ · в задаче →»: клик открывает «задачу» на изменениях и подсвечивает событие', async () => {
    const host = mount();
    post(state({ events: [ev({ id: 'comment:10234', kind: 'comment', at: T0, mine: true, author: 'Я', text: 'Итог' })] }));
    toolRow('comment', { text: 'h3. Итог' }, 'Comment added to NEWMFC-1482 (id 10234).\nevent: comment:10234');
    await flush();
    const r = row(host);
    expect(r.querySelector('.what')!.textContent).toBe('комментарий NEWMFC-1482');
    expect(r.querySelector('.r')!.textContent).toBe('✓ · в задаче →');
    [...r.querySelectorAll<HTMLElement>('.r a')].find((a) => a.textContent === 'в задаче →')!.click();
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('task');
    expect(subtab(host, SUB.changes).getAttribute('aria-selected')).toBe('true');
    const evt = q(host, '.tk-evt[data-id="comment:10234"]');
    expect(evt.classList.contains('focus')).toBe(true);
    expect(taskFocus.value).toBeUndefined();
  });

  it('событие ещё не пришло — переход ждёт следующей загрузки; без id — самое свежее «моё» этого вида', async () => {
    const host = mount();
    post(state({ events: [] }));
    toolRow('transition', { to: 'Done' }, 'NEWMFC-1482 moved to "Done".\nevent: status');
    await flush();
    expect(row(host).querySelector('.what')!.textContent).toBe('статус NEWMFC-1482 → Done');
    [...row(host).querySelectorAll<HTMLElement>('.r a')].find((a) => a.textContent === 'в задаче →')!.click();
    await flush();
    expect(taskFocus.value).toMatchObject({ kind: 'status' });
    const now = Date.now();
    post(
      state({
        fetchedAt: now,
        events: [
          ev({ id: 'hist:2', kind: 'status', at: now, mine: true, author: 'Я', field: 'status', from: 'In Progress', to: 'Done' }),
          ev({ id: 'hist:1', kind: 'status', at: now - 1000, author: 'Ольга К.' }),
        ],
      }),
    );
    await flush();
    expect(q(host, '.tk-evt[data-id="hist:2"]').classList.contains('focus')).toBe(true);
    expect(taskFocus.value).toBeUndefined();
  });

  it('ворклог по другой задаче или ошибка — без «в задаче →»', async () => {
    const host = mount();
    post(state());
    toolRow('worklog', { minutes: 90, issue: 'ABC-7' }, 'Logged 1h 30m on ABC-7.\nevent: worklog:5');
    await flush();
    expect(row(host).querySelector('.what')!.textContent).toBe('ворклог ABC-7 · 1h 30m');
    expect(row(host).textContent).not.toContain('в задаче');
  });
});
