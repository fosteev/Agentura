// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import type { SessionSummary, ToWebview } from '../protocol';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { Sidebar } from './components/Sidebar';
import { initialHud } from './hudState';
import { chat, currentSession, handleHostMessage, hudState, recent } from './store';
import * as vscode from './vscode';

const screen = (name: string) =>
  new DOMParser().parseFromString(
    readFileSync(join(__dirname, '..', '..', 'prototype', 'screens', `${name}.html`), 'utf8'),
    'text/html',
  );

/** Теги и классы без текстов — как в markup.test.ts. */
function skeleton(el: Element): string {
  const cls = [...el.classList].sort().join('.');
  const kids = [...el.children].map(skeleton).filter((k, i, all) => k !== all[i - 1]);
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${kids.length ? `[${kids.join(',')}]` : ''}`;
}

const posted: Record<string, unknown>[] = [];
const flush = () => new Promise((r) => setTimeout(r, 30));
const mounted: HTMLElement[] = [];
const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;

function mount(component: () => unknown) {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(component as never, {}), host);
  return host;
}

const NOW = Date.now();
const session = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 's',
  title: 'сессия',
  turns: 1,
  state: 'idle',
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
  vi.spyOn(vscode, 'persistSession').mockImplementation(() => undefined);
  chat.value = { ...initialState(), project: 'queue-board', cwd: '/p' };
  hudState.value = initialHud();
  recent.value = [];
  currentSession.value = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe('боковая панель (sessions.html)', () => {
  const push = (m: ToWebview) => handleHostMessage(m);
  const sidebarMessages = (m: ToWebview) =>
    window.dispatchEvent(new MessageEvent('message', { data: m }));

  it('разметка как в прототипе: аккаунт, лимиты с недельным окном модели, сессии по дням, строки live/wait/cur', async () => {
    const host = mount(Sidebar);
    await flush(); // подписка на сообщения хоста ставится эффектом
    const t = (d: number, hh = 12) =>
      new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        new Date().getDate() - d,
        hh,
      ).getTime();
    sidebarMessages({
      type: 'account.info',
      email: 'a@b.c',
      plan: 'Max 5×',
      login: 'через CLI · ок',
      engine: 'claude 2.1.285',
    });
    sidebarMessages({
      type: 'limits.update',
      updatedAt: Date.now(),
      windows: [
        { kind: 'five-hour', percent: 62, resetsAt: Date.now() + 2 * 3600_000 },
        { kind: 'weekly', percent: 34, resetsAt: Date.now() + 2 * 86_400_000 },
        {
          kind: 'weekly-model',
          model: 'Fable',
          percent: 12,
          resetsAt: Date.now() + 2 * 86_400_000,
        },
      ],
    });
    sidebarMessages({
      type: 'sessions.update',
      project: 'queue-board',
      current: 'a',
      sessions: [
        session({
          id: 'a',
          title: 'мигание счётчика',
          turns: 14,
          costUsd: 1.84,
          contextTokens: 131_000,
          state: 'live',
          updatedAt: t(0),
        }),
        session({
          id: 'b',
          title: 'плашка «нет связи»',
          turns: 3,
          costUsd: 0.42,
          state: 'waiting',
          updatedAt: t(0, 1),
        }),
        session({ id: 'c', title: 'вчерашняя', turns: 9, costUsd: 1.05, updatedAt: t(1) }),
      ],
    });
    await flush();
    const proto = screen('sessions').querySelector('.sidebar')!;
    const part = (root: Element, sel: string) => skeleton(root.querySelector(sel)!);
    for (const sel of [
      '.head',
      'section.sec',
      '.kv',
      '.lim .row',
      '.tools',
      'section.sec + section.sec',
      '.list .s.cur',
      '.list .s.wait',
      '.list .s:not(.cur):not(.wait)',
    ]) {
      expect(part(host, sel), sel).toBe(part(proto, sel));
    }
    expect([...host.querySelectorAll('.sidebar > *')].map((e) => e.className || e.tagName)).toEqual(
      [...proto.querySelectorAll(':scope > *')].map((e) => e.className || e.tagName),
    );
    const kv = [...host.querySelectorAll('.kv b')].map((b) => b.textContent);
    expect(kv).toEqual(['a@b.c', 'Max 5×', 'через CLI · ок', 'Claude · claude 2.1.285']);
    const rows = [...host.querySelectorAll('.lim .row')].map(
      (r) => r.querySelector('span')!.textContent,
    );
    expect(rows).toEqual(['Окно 5 часов', 'Неделя', 'Неделя · Fable']);
    expect([...host.querySelectorAll('.day')].map((d) => d.textContent)).toEqual([
      'Сегодня',
      'Вчера',
    ]);
    const s = [...host.querySelectorAll('.list .s')];
    expect(s.map((x) => x.className)).toEqual(['s cur live', 's wait', 's']);
    // контекст — колонкой справа (agentura.sessionList.context по умолчанию), во второй строке его нет
    expect(s[0]!.querySelector('small')!.textContent).toBe('14 ходов · $1.84');
    expect(s[0]!.querySelector('.ctx')!.textContent).toBe('131k ctx');
    expect(s[0]!.querySelector('.when')!.textContent).toBe('сейчас');
    expect(s[1]!.querySelector('small')!.textContent).toContain('ждёт ответа');
    expect(host.querySelector('input[type=search]')!.hasAttribute('disabled')).toBe(false);
    void push;
  });

  it('клик — возобновить (с задержкой под двойной клик), двойной клик — переименование, Enter сохраняет', async () => {
    vi.useFakeTimers();
    try {
      const host = mount(Sidebar);
      await vi.advanceTimersByTimeAsync(50);
      sidebarMessages({
        type: 'sessions.update',
        sessions: [session({ id: 'a', title: 'старое имя' })],
      });
      await vi.advanceTimersByTimeAsync(10);
      const row = () => host.querySelector('.list .s') as HTMLElement;
      row().click();
      expect(posted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(posted.at(-1)).toEqual({ type: 'session.resume', sessionId: 'a' });

      posted.length = 0;
      row().click();
      row().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      expect(posted).toHaveLength(0); // двойной клик отменил возобновление
      const input = host.querySelector('input.rename') as HTMLInputElement;
      expect(input.value).toBe('старое имя');
      input.value = 'новое имя';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(10);
      expect(posted.at(-1)).toEqual({ type: 'session.rename', sessionId: 'a', title: 'новое имя' });
      expect(host.querySelector('input.rename')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc отменяет переименование; «Новая сессия» и /status — сообщения хосту', async () => {
    const host = mount(Sidebar);
    await flush();
    sidebarMessages({ type: 'sessions.update', sessions: [session({ id: 'a' })] });
    await flush();
    (host.querySelector('.list .s') as HTMLElement).dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    await flush();
    const input = host.querySelector('input.rename') as HTMLInputElement;
    input.value = 'другое';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(posted.some((m) => m.type === 'session.rename')).toBe(false);
    (host.querySelector('.new') as HTMLElement).click();
    expect(host.querySelector('h3 button.r')).toBeNull();
    expect(posted.map((m) => m.type)).toEqual(['session.new']);
  });

  it('вид списка: sidebar.view ставит data-list и колонки, кнопка в «Сессии» пишет следующий вид; в подсказке — ходы и цена', async () => {
    const host = mount(Sidebar);
    await flush();
    const bar = host.querySelector('.sidebar') as HTMLElement;
    expect([bar.dataset.list, bar.dataset.ctx, bar.dataset.time]).toEqual(['compact', 'on', 'on']);
    sidebarMessages({
      type: 'sidebar.view',
      view: 'dense',
      context: true,
      time: false,
      top: 'detailed',
      limits: 'active',
    });
    sidebarMessages({
      type: 'sessions.update',
      sessions: [session({ id: 'a', turns: 3, costUsd: 0.42, contextTokens: 173_000 })],
    });
    await flush();
    expect([bar.dataset.list, bar.dataset.ctx, bar.dataset.time]).toEqual(['dense', 'on', 'off']);
    const row = host.querySelector('.list .s') as HTMLElement;
    expect(row.getAttribute('data-tip')).toContain('3 хода · $0.42 · 173k');
    expect(row.querySelector('.ctx')?.textContent).toBe('173k ctx');
    // контекст колонкой — во второй строке не дублируется
    expect(row.querySelector('small')?.textContent).toBe('3 хода · $0.42');
    const btn = host.querySelector('.sec h3 button.view') as HTMLButtonElement;
    expect(btn.getAttribute('data-tip')).toContain('«подробно»');
    btn.click();
    await flush();
    expect(posted).toEqual([{ type: 'settings.set', key: 'sessionList.view', value: 'detailed' }]);
    expect(bar.dataset.list).toBe('detailed');
  });

  it('вид верха: sidebar.view ставит data-top; аккаунт строкой, короткий сброс, мини-шкалы в заголовке, ＋ — новая сессия', async () => {
    const host = mount(Sidebar);
    await flush();
    const bar = host.querySelector('.sidebar') as HTMLElement;
    expect(bar.dataset.top).toBe('detailed');
    sidebarMessages({
      type: 'sidebar.view',
      view: 'compact',
      context: true,
      time: true,
      top: 'compact',
      limits: 'active',
    });
    sidebarMessages({
      type: 'account.info',
      email: 'a@b.c',
      plan: 'Max 5×',
      login: 'через CLI · ок',
      engine: 'claude 2.1.285',
    });
    const at = new Date();
    at.setHours(23, 30, 0, 0);
    sidebarMessages({
      type: 'limits.update',
      updatedAt: Date.now(),
      windows: [
        { kind: 'five-hour', percent: 91, resetsAt: at.getTime() },
        { kind: 'weekly', percent: 34, resetsAt: Date.now() + 2 * 86_400_000 },
        { kind: 'weekly-model', model: 'Fable', percent: 12 },
      ],
    });
    await flush();
    expect(bar.dataset.top).toBe('compact');
    const who = host.querySelector('.who') as HTMLElement;
    expect(who.textContent).toBe('a@b.c· Max 5×· claude 2.1.285');
    expect(who.getAttribute('data-tip')).toContain('Вход: через CLI · ок');
    expect(who.querySelector('.okd')).not.toBeNull();
    expect(host.querySelector('.lim .row .rs')?.textContent).toBe('→ 23:30');
    sidebarMessages({
      type: 'sidebar.view',
      view: 'compact',
      context: true,
      time: true,
      top: 'dense',
      limits: 'active',
    });
    await flush();
    expect(bar.dataset.top).toBe('dense');
    expect(host.querySelector('.who')).toBeNull();
    // мини-шкалы — только 5 часов и неделя; 91 % — красный уровень
    const minis = [...host.querySelectorAll('.head .hl .m')] as HTMLElement[];
    expect(minis.map((m) => m.textContent)).toEqual(['5 ч91 %', 'нед34 %']);
    expect(minis[0]!.className).toBe('m lim-full');
    expect(minis[1]!.className).toBe('m');
    expect(minis[0]!.getAttribute('data-tip')).toContain('Окно 5 часов · сброс в 23:30');
    expect(host.querySelector('.head')!.getAttribute('data-tip')).toContain('Аккаунт: a@b.c');
    (host.querySelector('.head .hl .refresh') as HTMLElement).click();
    (host.querySelector('.sec h3 button.add') as HTMLElement).click();
    expect(posted.map((m) => m.type)).toEqual(['limits.refresh', 'session.new']);
  });

  it('поиск по названию фильтрует список, ✕ и Esc сбрасывают; пусто — «Ничего не найдено»', async () => {
    const host = mount(Sidebar);
    await flush();
    sidebarMessages({
      type: 'sessions.update',
      sessions: [
        session({ id: 'a', title: 'Плашка «нет связи»' }),
        session({ id: 'b', title: 'ёлка в шапке' }),
      ],
    });
    await flush();
    const input = host.querySelector<HTMLInputElement>('.tools input')!;
    const titles = () =>
      [...host.querySelectorAll('.list .s .t')].map((t) => t.firstChild!.textContent);
    const type = async (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    };
    await type('  плаш ');
    expect(titles()).toEqual(['Плашка «нет связи»']);
    await type('елка');
    expect(titles()).toEqual(['ёлка в шапке']);
    const btn = host.querySelector<HTMLButtonElement>('.tools button')!;
    expect(btn.textContent).toBe('✕');
    btn.click();
    await flush();
    expect(titles()).toHaveLength(2);
    await type('нет такой');
    expect(host.querySelector('.list .day')!.textContent).toBe('Ничего не найдено.');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(input.value).toBe('');
    expect(titles()).toHaveLength(2);
  });

  it('заголовки секций сворачивают и разворачивают; кнопки в заголовке не сворачивают', async () => {
    const host = mount(Sidebar);
    await flush();
    const [acc, ses] = [...host.querySelectorAll<HTMLElement>('section.sec')];
    const h = (sec: HTMLElement) => sec.querySelector<HTMLElement>('h3')!;
    h(acc!).querySelector<HTMLButtonElement>('.refresh')!.click();
    await flush();
    expect(acc!.classList.contains('folded')).toBe(false);
    posted.length = 0;
    h(acc!).click();
    await flush();
    expect(acc!.classList.contains('folded')).toBe(true);
    expect(h(acc!).getAttribute('aria-expanded')).toBe('false');
    h(ses!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(ses!.classList.contains('folded')).toBe(true);
    expect(host.querySelector('.tools')!.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('.list')!.hasAttribute('hidden')).toBe(true);
    h(acc!).click();
    h(ses!).click();
    await flush();
    expect(acc!.classList.contains('folded')).toBe(false);
    expect(host.querySelector('.list')!.hasAttribute('hidden')).toBe(false);
  });

  it('пустой проект и неактивное окно: подпись и «0 %» без сброса', async () => {
    const host = mount(Sidebar);
    await flush();
    sidebarMessages({ type: 'sessions.update', sessions: [] });
    sidebarMessages({
      type: 'limits.update',
      updatedAt: 1,
      windows: [{ kind: 'five-hour', percent: 0 }],
    });
    await flush();
    expect(host.querySelector('.list .day')!.textContent).toBe('В этом проекте пока нет сессий.');
    const row = host.querySelector('.lim .row')!;
    expect(row.querySelector('.n')!.textContent).toBe('0 %');
    expect(row.querySelector('small')).toBeNull();
  });

  describe('задачи Jira (roadmap 19, этап 4)', () => {
    const view = (over: Record<string, unknown>) =>
      sidebarMessages({
        type: 'sidebar.view',
        view: 'compact',
        context: true,
        time: true,
        top: 'detailed',
        limits: 'active',
        ...over,
      } as ToWebview);
    const meta = (key: string, title: string, status?: string, cat?: 'new' | 'indeterminate' | 'done') => ({
      key,
      instanceId: 'x',
      title,
      url: '',
      ...(status ? { status } : {}),
      ...(cat ? { statusCategory: cat } : {}),
    });
    const rows = [
      session({ id: 'a', title: 'почему не печатает', updatedAt: NOW - 1000, task: { key: 'NEWMFC-1', title: 'Печать', status: 'В работе' } }),
      session({ id: 'b', title: 'свободный чат', updatedAt: NOW - 2000 }),
      session({ id: 'c', title: 'восстановление очереди', provider: 'codex', updatedAt: NOW - 3000, task: { key: 'NEWMFC-1', title: 'Печать', status: 'В работе' } }),
      session({ id: 'd', title: 'дубль пуша', updatedAt: NOW - 90_000_000, task: { key: 'GARM-8', title: 'Дубль' } }),
    ];
    const tasks = [
      { taskKey: 'jira:x:GARM-8', meta: meta('GARM-8', 'Пуш о тревоге дублируется'), sessionIds: ['d'] },
      { taskKey: 'jira:x:NEWMFC-1', meta: meta('NEWMFC-1', 'Талон не печатается', 'В работе', 'indeterminate'), sessionIds: ['a', 'c'] },
    ];
    afterEach(() => {
      view({ tasks: 'groups' });
      sidebarMessages({ type: 'sessions.update', sessions: [] });
    });

    it('groups: заголовок группы (ключ, пилюля, число чатов, ＋, название), чаты вложены, «Без задачи» в конце; свежая группа выше', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'groups' });
      sidebarMessages({ type: 'sessions.update', sessions: rows, tasks, current: 'c' });
      await flush();
      const bar = host.querySelector('.sidebar') as HTMLElement;
      expect(bar.dataset.tasks).toBe('groups');
      const groups = [...host.querySelectorAll('.list > .tgp')];
      expect(groups.map((g) => g.getAttribute('data-task'))).toEqual(['jira:x:NEWMFC-1', 'jira:x:GARM-8', null]);
      const first = groups[0]!;
      const head = first.querySelector('.tg-h')!;
      expect(head.querySelector('.tkey')!.textContent).toBe('NEWMFC-1');
      expect(head.querySelector('.pill.wip')!.textContent).toBe('В работе');
      expect(head.querySelector('.cn')!.textContent).toBe('2');
      expect(head.querySelector('.tt')!.textContent).toBe('Талон не печатается');
      expect(head.querySelector('button.hit')!.getAttribute('aria-expanded')).toBe('true');
      // «＋» — соседняя кнопка, не вложена в кнопку сворачивания (иначе скринридер её не видит)
      expect(head.querySelector('.hit .plus')).toBeNull();
      expect(head.querySelector(':scope > button.plus')).not.toBeNull();
      expect(first.classList.contains('sel')).toBe(true); // в группе открыта текущая вкладка
      expect([...first.querySelectorAll('.s')].map((r) => r.querySelector('.t')!.textContent!.replace(/[CX]?(?=почему|восст)/, '').slice(0, 9))).toEqual(['почему не', 'восстанов']);
      expect(first.querySelectorAll('.s.nest')).toHaveLength(2);
      expect(first.querySelector('.s.cur')).not.toBeNull();
      // GARM-8: статуса нет — пилюли нет
      expect(groups[1]!.querySelector('.pill')).toBeNull();
      // «Без задачи»: заголовок без ключа, внутри свободный чат; дней в списке с группами нет
      const free = groups[2]!;
      expect(free.querySelector('.tg-h.nokey b')!.textContent).toBe('Без задачи');
      expect(free.querySelectorAll('.s')).toHaveLength(1);
      expect(host.querySelector('.list > .day')).toBeNull();
      // в mixed-списке (есть Codex) у вложенного чата метка движка
      expect(first.querySelector('.s .t .mk.codex')!.textContent).toBe('X');
    });

    it('groups: «＋» — новый чат по задаче и не сворачивает группу; кнопка заголовка сворачивает, состояние пишется в state webview', async () => {
      const save = vi.spyOn(vscode, 'saveTaskFold').mockImplementation(() => undefined);
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'groups' });
      sidebarMessages({ type: 'sessions.update', sessions: rows, tasks });
      await flush();
      const g = () => host.querySelector('.tgp[data-task="jira:x:NEWMFC-1"]')!;
      (g().querySelector('.tg-h .plus') as HTMLElement).click();
      await flush();
      expect(posted).toEqual([{ type: 'task.newChat', taskKey: 'jira:x:NEWMFC-1' }]);
      expect(g().querySelectorAll('.s')).toHaveLength(2);
      expect(save).not.toHaveBeenCalled();
      const hit = () => g().querySelector('.tg-h button.hit') as HTMLButtonElement;
      expect(hit().type).toBe('button'); // настоящая кнопка: Enter/Space и фокус — от браузера
      hit().click();
      await flush();
      expect(g().querySelectorAll('.s')).toHaveLength(0);
      expect(hit().getAttribute('aria-expanded')).toBe('false');
      expect(hit().getAttribute('aria-label')).toBe('Развернуть задачу NEWMFC-1');
      expect(save).toHaveBeenLastCalledWith(['jira:x:NEWMFC-1']);
      hit().click();
      await flush();
      expect(g().querySelectorAll('.s')).toHaveLength(2);
      expect(save).toHaveBeenLastCalledWith([]);
      // «Без задачи»: имя кнопки — её текст, без aria-label
      const free = host.querySelector('.tgp.none button.hit')!;
      expect(free.getAttribute('aria-label')).toBeNull();
      expect(free.getAttribute('aria-expanded')).toBe('true');
    });

    it('groups: поиск по ключу задачи показывает все её чаты, по названию чата — только его; найденное видно в свёрнутой группе', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'groups' });
      sidebarMessages({ type: 'sessions.update', sessions: rows, tasks });
      await flush();
      const search = host.querySelector('.tools input') as HTMLInputElement;
      expect(search.placeholder).toContain('ключу задачи');
      const hit = () => host.querySelector('.tgp[data-task="jira:x:NEWMFC-1"] .tg-h .hit') as HTMLElement;
      hit().click(); // свернули
      search.value = 'newmfc';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect([...host.querySelectorAll('.list > .tgp')].map((g) => g.getAttribute('data-task'))).toEqual(['jira:x:NEWMFC-1']);
      expect(host.querySelectorAll('.tgp .s')).toHaveLength(2);
      hit().click(); // во время поиска сворачивание не действует
      await flush();
      expect(host.querySelectorAll('.tgp .s')).toHaveLength(2);
      search.value = 'восстановление';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect(host.querySelectorAll('.tgp .s')).toHaveLength(1);
      search.value = 'нетакого';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect(host.querySelector('.list .day')!.textContent).toBe('Ничего не найдено.');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect(host.querySelectorAll('.tgp[data-task="jira:x:NEWMFC-1"] .s')).toHaveLength(0); // как было до поиска
      hit().click(); // развернули обратно
      await flush();
    });

    it('без групп список прежний (по дням, без «Без задачи»), даже при tasks.sidebar = groups', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'groups' });
      sidebarMessages({ type: 'sessions.update', sessions: [rows[1]!] });
      await flush();
      expect(host.querySelector('.tgp')).toBeNull();
      expect(host.querySelector('.list .day')).not.toBeNull();
      expect((host.querySelector('.sidebar') as HTMLElement).dataset.tasks).toBeUndefined();
      expect(host.querySelector('.tools input')!.getAttribute('placeholder')).toBe('Поиск по названию');
    });

    it('section: группы без чатов в списке — ни секции, ни data-tasks, ни метки ключа (вид как до задач)', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'section' });
      sidebarMessages({ type: 'sessions.update', sessions: [rows[1]!], tasks: tasks.map((t) => ({ ...t, sessionIds: ['gone'] })) });
      await flush();
      expect(host.querySelector('.sec.tasks')).toBeNull();
      expect((host.querySelector('.sidebar') as HTMLElement).dataset.tasks).toBeUndefined();
      expect(host.querySelector('.s .tag')).toBeNull();
      expect(host.querySelector('.list .day')).not.toBeNull();
    });

    it('section: секция «Задачи» над «Сессиями» — карточки, движки, ＋; в строке сессии метка ключа; клик по карточке — последний чат', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'section' });
      sidebarMessages({ type: 'sessions.update', sessions: rows, tasks, current: 'd' });
      await flush();
      const bar = host.querySelector('.sidebar') as HTMLElement;
      expect(bar.dataset.tasks).toBe('section');
      const secs = [...bar.querySelectorAll(':scope > section.sec')];
      const at = (h: string) => secs.findIndex((x) => x.querySelector('h3')!.textContent!.includes(h));
      expect(at('Задачи')).toBeGreaterThan(-1);
      expect(at('Задачи')).toBeLessThan(at('Сессии'));
      const cards = [...host.querySelectorAll('.sec.tasks .tk')];
      expect(cards.map((c) => c.querySelector('.tkey')!.textContent)).toEqual(['NEWMFC-1', 'GARM-8']);
      expect(host.querySelector('.sec.tasks h3 .count')!.textContent).toBe('· 2');
      const c0 = cards[0]!;
      expect(c0.querySelector('.pill.wip')!.textContent).toBe('В работе');
      expect([...c0.querySelectorAll('.ri .mk')].map((m) => m.textContent)).toEqual(['C', 'X']);
      expect(c0.querySelector('.ri')!.textContent).toContain('2 чата');
      expect(c0.querySelector('.tt')!.textContent).toBe('Талон не печатается');
      expect(c0.querySelector('.sub')!.textContent).toContain('последний чат:');
      expect(cards[1]!.classList.contains('sel')).toBe(true); // текущий чат — в GARM-8
      // сессии — плоским списком по дням, у привязанных справа метка ключа
      expect(host.querySelector('.list .tgp')).toBeNull();
      const tagged = [...host.querySelectorAll('.list .s')].map((r) => r.querySelector('.tag')?.textContent ?? '');
      expect(tagged).toEqual(['NEWMFC-1', '', 'NEWMFC-1', 'GARM-8']);
      expect(host.querySelector('.list .s.tagged')).not.toBeNull();
      // клик по карточке — возобновить самый свежий чат; ＋ — новый чат и без возобновления
      expect(c0.getAttribute('role')).toBeNull();
      (c0.querySelector('button.hit') as HTMLElement).click();
      expect(posted.at(-1)).toEqual({ type: 'session.resume', sessionId: 'a' });
      (c0.querySelector('.plus') as HTMLElement).click();
      expect(posted.at(-1)).toEqual({ type: 'task.newChat', taskKey: 'jira:x:NEWMFC-1' });
      expect(posted.filter((m) => m.type === 'session.resume')).toHaveLength(1);
    });

    it('section: поиск находит чаты и по ключу задачи; карточка считает все чаты задачи, не только совпавшие', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'section' });
      sidebarMessages({ type: 'sessions.update', sessions: rows, tasks });
      await flush();
      const search = host.querySelector('.tools input') as HTMLInputElement;
      search.value = 'garm-8';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect([...host.querySelectorAll('.list .s .tag')].map((t) => t.textContent)).toEqual(['GARM-8']);
      search.value = 'восстановление';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      const card = host.querySelector('.sec.tasks .tk[data-task="jira:x:NEWMFC-1"]')!;
      expect(card.querySelector('.ri')!.textContent).toContain('2 чата');
      (card.querySelector('button.hit') as HTMLElement).click();
      expect(posted.at(-1)).toEqual({ type: 'session.resume', sessionId: 'a' });
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });

    it('все три вида списка и три вида верха рисуют группы', async () => {
      const host = mount(Sidebar);
      await flush();
      for (const list of ['detailed', 'compact', 'dense']) {
        for (const top of ['detailed', 'compact', 'dense']) {
          view({ tasks: 'groups', view: list, top });
          sidebarMessages({ type: 'sessions.update', sessions: rows, tasks });
          await flush();
          const bar = host.querySelector('.sidebar') as HTMLElement;
          expect([bar.dataset.list, bar.dataset.top]).toEqual([list, top]);
          expect(host.querySelectorAll('.list .tgp')).toHaveLength(3);
          expect(host.querySelectorAll('.list .tgp .s')).toHaveLength(4);
        }
      }
      view({ view: 'compact', top: 'detailed' });
    });

    it('строка сессии несёт контекст меню VS Code: sessionId и признак привязки к задаче', async () => {
      const host = mount(Sidebar);
      await flush();
      view({ tasks: 'groups' });
      sidebarMessages({ type: 'sessions.update', sessions: rows, tasks });
      await flush();
      const ctx = (id: string) => {
        const row = [...host.querySelectorAll<HTMLElement>('.s')].find((r) => r.textContent!.includes(id))!;
        return JSON.parse(row.getAttribute('data-vscode-context')!) as Record<string, unknown>;
      };
      expect(ctx('свободный')).toMatchObject({ webviewSection: 'session', sessionId: 'b', sessionBound: false });
      expect(ctx('почему')).toMatchObject({ sessionId: 'a', sessionBound: true });
    });
  });
});

describe('попап sessions в шапке чата', () => {
  it('список коротко, текущая подсвечена, клик — resume, «все сессии» и «новая» — сообщения хосту', async () => {
    const host = mount(Chat);
    chat.value = { ...chat.value, sessionId: 'a', title: 'текущая' };
    handleHostMessage({
      type: 'sessions.update',
      current: 'a',
      sessions: [
        session({ id: 'a', title: 'текущая', turns: 14, costUsd: 1.84, contextTokens: 131_000 }),
        session({ id: 'b', title: 'другая', state: 'waiting' }),
      ],
    });
    await flush();
    expect(host.querySelector('.menu')).toBeNull();
    const btn = [...host.querySelectorAll('.hud .acts button')].find(
      (b) => b.textContent === 'sessions',
    ) as HTMLElement;
    btn.click();
    await flush();
    const items = [...host.querySelectorAll('.menu .it')];
    expect(items.map((i) => i.className)).toEqual(['it sel', 'it', 'it', 'it']);
    expect(items[0]!.querySelector('.hint')!.textContent).toBe('131k');
    expect(items[1]!.querySelector('small')!.textContent).toContain('ждёт ответа');
    // строка текущей сессии не возобновляет сама себя
    (items[0] as HTMLElement).click();
    await flush();
    expect(posted.filter((m) => m.type === 'session.resume')).toHaveLength(0);
    btn.click();
    await flush();
    ([...host.querySelectorAll('.menu .it')][1] as HTMLElement).click();
    await flush();
    expect(posted.at(-1)).toEqual({ type: 'session.resume', sessionId: 'b' });
    btn.click();
    await flush();
    ([...host.querySelectorAll('.menu .it')][2] as HTMLElement).click();
    await flush();
    expect(posted.at(-1)).toEqual({ type: 'sessions.show' });
    btn.click();
    await flush();
    ([...host.querySelectorAll('.menu .it')][3] as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: 'session.new' });
    btn.click();
    await flush();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flush();
    expect(host.querySelector('.menu')).toBeNull();
  });
});

describe('session.history: восстановление ленты и фильтр брошенной сессии', () => {
  const history: AgentEvent[] = [
    ev({ type: 'turn.start', prompt: 'поправь a.ts', at: 1000 }),
    ev({
      type: 'tool.start',
      toolUseId: 't1',
      name: 'Edit',
      input: { file_path: '/p/a.ts', old_string: 'b', new_string: 'c' },
      at: 1100,
    }),
    ev({
      type: 'tool.result',
      toolUseId: 't1',
      isError: false,
      content: 'ok',
      at: 1200,
      result: { structuredPatch: [{ lines: [' a', '-b', '+c'] }] },
    }),
    ev({ type: 'text.delta', messageId: 'm', text: 'Готово.' }),
    ev({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 400,
      apiDurationMs: 0,
      numTurns: 1,
      usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 0 },
      costUsd: 0.05,
      totalCostUsd: 0.05,
      permissionDenials: [],
    }),
  ];

  it('лента, приборы и сведения о сессии восстанавливаются; diff-ссылка у правки на месте; нет залипших «run»', async () => {
    const host = mount(Chat);
    handleHostMessage({
      type: 'session.history',
      sessionId: 's-old',
      events: history,
      skippedTurns: 40,
      title: 'Старая',
      model: 'claude-haiku-4-5',
      mode: 'plan',
    });
    await flush();
    const s = chat.value;
    expect(s).toMatchObject({
      sessionId: 's-old',
      title: 'Старая',
      mode: 'plan',
      status: 'idle',
      model: 'claude-haiku-4-5',
    });
    expect(s.rows.map((r) => r.kind)).toEqual(['sys', 'user', 'tool', 'text', 'sum']);
    expect(s.rows[0]).toMatchObject({ kind: 'sys' });
    expect(hudState.value.totals).toMatchObject({ turns: 1 });
    expect(host.querySelector('.log .e .diff, .log .e a, .log .e button')).not.toBeNull();
    expect(host.textContent).toContain('поправь a.ts');
    expect(posted.filter((m) => m.type === 'diff.open')).toHaveLength(0);
  });

  it('возобновление той же сессии, брошенной через «new»: её события больше не отфильтровываются', async () => {
    mount(Chat);
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'A',
      event: ev({
        type: 'session.init',
        sessionId: 'A',
        model: 'm',
        cwd: '/',
        permissionMode: 'default',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1',
      }),
    });
    expect(chat.value.sessionId).toBe('A');
    const { newSession } = await import('./store');
    newSession(); // A брошена: фильтр ставится
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'A',
      event: ev({ type: 'text.delta', messageId: 'x', text: 'хвост' }),
    });
    expect(chat.value.rows).toHaveLength(0); // хвост брошенной отфильтрован

    handleHostMessage({
      type: 'session.history',
      sessionId: 'A',
      events: history,
      skippedTurns: 0,
    });
    const n = chat.value.rows.length;
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'A',
      event: ev({ type: 'turn.start', prompt: 'дальше', at: 5000 }),
    });
    expect(chat.value.rows.length).toBe(n + 1); // события возобновлённой A дошли до ленты
    expect(chat.value.status).toBe('working');
    // и её init не отфильтрован
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'A',
      event: ev({
        type: 'session.init',
        sessionId: 'A',
        model: 'm2',
        cwd: '/',
        permissionMode: 'plan',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1',
      }),
    });
    expect(chat.value).toMatchObject({ model: 'm2', mode: 'plan' });
  });

  it('пересев на живой сессии: карточка разрешения после истории на месте и ждёт ответа', async () => {
    const host = mount(Chat);
    handleHostMessage({
      type: 'session.history',
      sessionId: 'L',
      events: history,
      skippedTurns: 0,
    });
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'L',
      event: ev({ type: 'turn.start', at: 9000 }),
    });
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'L',
      event: ev({
        type: 'permission.request',
        toolUseId: 'p1',
        toolName: 'Bash',
        input: { command: 'ls' },
        description: 'ls',
        canAlwaysAllow: false,
      }),
    });
    await flush();
    expect(chat.value.status).toBe('waiting');
    expect(host.querySelector('.ask')).not.toBeNull();
  });

  it('chat.command status: строка с моделью и режимом', async () => {
    mount(Chat);
    handleHostMessage({
      type: 'session.history',
      sessionId: 's',
      events: [],
      skippedTurns: 0,
      model: 'claude-opus-5-5',
      mode: 'plan',
    });
    handleHostMessage({ type: 'chat.command', name: 'status' });
    const last = chat.value.rows.at(-1)!;
    expect(JSON.stringify(last)).toContain('opus-5.5');
    expect(JSON.stringify(last)).toContain('/status');
  });
});
