// @vitest-environment jsdom
/**
 * Правая панель вкладки чата (широкий режим) в DOM: вкладки `изменения | агенты`, скрыть/полоса,
 * ресайз за левый край, пределы, двойной клик, клавиатура, состояние из `getState` и мердж с `sessionId`.
 * Эталон разметки — `prototype/screens/agents.html`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { agentsParallelEvents } from '../agent/claude/__fixtures__/agentsParallel';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { chat, dispatchEvent, hudState, selectedAgent, tick } from './store';
import * as vscode from './vscode';

// состояние webview — в переменной: `host()` кэширует api, поэтому заглушка ставится один раз до первого вызова
let stored: unknown;
const setStateSpy = vi.fn();
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState: () => stored,
  setState: (s: unknown) => {
    stored = s;
    setStateSpy(s);
  },
});

const flush = () => new Promise((r) => setTimeout(r, 50));
const mounted: HTMLElement[] = [];
const BODY_LEFT = 0;
const BODY_W = 1000;
const realRect = Element.prototype.getBoundingClientRect;

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

async function session(): Promise<void> {
  const all = await agentsParallelEvents();
  const calls = all
    .map((e, i) => (e.type === 'tool.start' && e.agentId ? i : -1))
    .filter((i) => i >= 0);
  let now = Date.now();
  for (const e of all.slice(0, calls[2]! + 1) as AgentEvent[]) dispatchEvent(e, (now += 10));
  tick.value = now;
}

const q = <T extends Element = HTMLElement>(host: Element, sel: string) =>
  host.querySelector(sel) as T;
const tabs = (host: Element) => [...host.querySelectorAll<HTMLElement>('.ptabs [role="tab"]')];
const body = (host: Element) => q(host, '.body');
const sideW = (host: Element) => body(host).style.getPropertyValue('--side-w');
const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-width');
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  stored = undefined;
  setStateSpy.mockClear();
  vi.spyOn(vscode, 'send').mockImplementation(() => undefined);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('body'))
      return {
        left: BODY_LEFT,
        right: BODY_LEFT + BODY_W,
        width: BODY_W,
        top: 0,
        bottom: 600,
        height: 600,
        x: BODY_LEFT,
        y: 0,
        toJSON() {},
      } as DOMRect;
    return realRect.call(this);
  });
  chat.value = initialState();
  hudState.value = initialHud();
  selectedAgent.value = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('вкладки панели', () => {
  it('изменения | агенты с бейджами; активна «изменения», вторая секция скрыта, стрелки переключают', async () => {
    const host = mount();
    await session();
    await flush();
    const t = tabs(host);
    expect(t.map((x) => x.id)).toEqual(['ptab-changes', 'ptab-agents']);
    expect(t.map((x) => x.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(t.map((x) => x.tabIndex)).toEqual([0, -1]);
    expect(q(host, '.ptabs').getAttribute('role')).toBe('tablist');
    const badge = t[1]!.querySelector('.b');
    expect([badge?.textContent, badge?.className]).toEqual(['3 / 3', 'b live']);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
    expect(q(host, '#pane-changes').hidden).toBe(false);
    expect(q(host, '#pane-agents').hidden).toBe(true);
    expect(q(host, '#pane-agents').getAttribute('aria-labelledby')).toBe('ptab-agents');

    key(t[0]!, 'ArrowRight');
    await flush();
    expect(tabs(host).map((x) => x.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('agents');
    expect(q(host, '#pane-changes').hidden).toBe(true);
    expect(q(host, '#pane-agents').hidden).toBe(false);
    expect((stored as { panel: { tab: string } }).panel.tab).toBe('agents');

    key(tabs(host)[1]!, 'ArrowLeft');
    await flush();
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
  });

  it('в пустой сессии вкладки панели disabled, активна «изменения»', async () => {
    stored = { panel: { tab: 'agents' } };
    const host = mount();
    await flush();
    expect(tabs(host).map((x) => (x as HTMLButtonElement).disabled)).toEqual([true, true]);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
  });

  it('«карта агентов» из ленты открывает «агентов» и разворачивает свёрнутую панель', async () => {
    const host = mount();
    await session();
    await flush();
    q<HTMLButtonElement>(host, '.ptabs .phide').click();
    await flush();
    expect(body(host).getAttribute('data-side')).toBe('off');
    const open = host.querySelector<HTMLElement>('.log .grp .gf a, .log .grp .gf button');
    expect(open).toBeTruthy();
    open!.click();
    await flush();
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('agents');
    expect(stored).toMatchObject({ panel: { tab: 'agents', off: false } });
  });
});

describe('скрыть и полоса', () => {
  it('скрыть → data-side=off; значки полосы с бейджами; клик по «агентам» разворачивает панель на агентах', async () => {
    const host = mount();
    await session();
    await flush();
    expect(body(host).hasAttribute('data-side')).toBe(false);
    q<HTMLButtonElement>(host, '.ptabs .phide').click();
    await flush();
    expect(body(host).getAttribute('data-side')).toBe('off');
    expect(stored).toMatchObject({ panel: { off: true } });
    const rail = q(host, 'nav.rail');
    const btns = [...rail.querySelectorAll('button')];
    expect(btns).toHaveLength(3);
    // у агентов в полосе только число идущих, без « / »
    expect(btns[1]!.querySelector('.b')?.textContent).toBe('3');
    expect(btns[1]!.querySelector('.b')?.className).toBe('b live');
    expect(btns[2]!.classList.contains('show')).toBe(true);

    btns[1]!.click();
    await flush();
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('agents');
    expect(stored).toMatchObject({ panel: { tab: 'agents', off: false } });
  });

  it('«показать панель» внизу полосы возвращает панель на прежней вкладке', async () => {
    stored = { panel: { off: true, tab: 'agents' } };
    const host = mount();
    await session();
    await flush();
    expect(body(host).getAttribute('data-side')).toBe('off');
    q<HTMLButtonElement>(host, 'nav.rail .show').click();
    await flush();
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('agents');
  });
});

describe('ресайз', () => {
  it('pointerdown/move/up на ручке: --side-w по правому краю тела, сохранение на pointerup', async () => {
    const host = mount();
    await session();
    await flush();
    const grip = q(host, '.grip');
    expect(sideW(host)).toBe('300px');
    fire(grip, 'pointerdown', { button: 0, clientX: 700 });
    expect(grip.classList.contains('drag')).toBe(true);
    expect(document.documentElement.classList.contains('resizing')).toBe(true);
    fire(grip, 'pointermove', { clientX: 600 });
    expect(sideW(host)).toBe('400px');
    expect(setStateSpy).not.toHaveBeenCalled(); // пока тянут — не пишем
    fire(grip, 'pointerup', { clientX: 550 });
    await flush();
    expect(sideW(host)).toBe('450px');
    expect(grip.classList.contains('drag')).toBe(false);
    expect(document.documentElement.classList.contains('resizing')).toBe(false);
    expect(stored).toMatchObject({ panel: { w: 450 } });
  });

  it('движение без нажатия ничего не меняет', async () => {
    const host = mount();
    await flush();
    fire(q(host, '.grip'), 'pointermove', { clientX: 100 });
    expect(sideW(host)).toBe('300px');
  });

  it('пределы: не уже 220 и не шире «тело − 360»', async () => {
    const host = mount();
    await flush();
    const grip = q(host, '.grip');
    fire(grip, 'pointerdown', { button: 0, clientX: 700 });
    fire(grip, 'pointermove', { clientX: 990 });
    expect(sideW(host)).toBe('220px');
    fire(grip, 'pointermove', { clientX: 10 });
    expect(sideW(host)).toBe(`${BODY_W - 360}px`);
    fire(grip, 'pointerup', { clientX: 10 });
    await flush();
    expect(stored).toMatchObject({ panel: { w: BODY_W - 360 } });
  });

  it('захват сорвался без pointerup: resizing снят, сохранена последняя ширина', async () => {
    const host = mount();
    await flush();
    const grip = q(host, '.grip');
    fire(grip, 'pointerdown', { button: 0, clientX: 700 });
    fire(grip, 'pointermove', { clientX: 620 });
    fire(grip, 'lostpointercapture');
    await flush();
    expect(grip.classList.contains('drag')).toBe(false);
    expect(document.documentElement.classList.contains('resizing')).toBe(false);
    expect(stored).toMatchObject({ panel: { w: 380 } });
    // после срыва движение уже ничего не тянет
    fire(grip, 'pointermove', { clientX: 300 });
    expect(sideW(host)).toBe('380px');
  });

  it('pointercancel: ширина откатывается, ничего не пишется, resizing снят', async () => {
    const host = mount();
    await flush();
    const grip = q(host, '.grip');
    fire(grip, 'pointerdown', { button: 0, clientX: 700 });
    fire(grip, 'pointermove', { clientX: 500 });
    fire(grip, 'pointercancel');
    await flush();
    expect(sideW(host)).toBe('300px');
    expect(document.documentElement.classList.contains('resizing')).toBe(false);
    expect(setStateSpy).not.toHaveBeenCalled();
  });

  it('окно сузили (но ≥ 700): сохранённая ширина зажимается, а в state остаётся прежней', async () => {
    stored = { panel: { w: 600 } };
    const host = mount();
    await flush();
    expect(sideW(host)).toBe('600px');
    expect(q(host, '.grip').getAttribute('aria-valuemax')).toBe(`${BODY_W - 360}`);
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('body'))
        return { left: 0, right: 800, width: 800, top: 0, bottom: 600, height: 600 } as DOMRect;
      return realRect.call(this);
    });
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await flush();
    expect(sideW(host)).toBe('440px'); // лента не уже 360
    expect(q(host, '.grip').getAttribute('aria-valuemax')).toBe('440');
    expect(stored).toEqual({ panel: { w: 600 } });
  });

  it('двойной клик возвращает 300 и сохраняет', async () => {
    stored = { panel: { w: 500 } };
    const host = mount();
    await flush();
    expect(sideW(host)).toBe('500px');
    fire(q(host, '.grip'), 'dblclick');
    await flush();
    expect(sideW(host)).toBe('300px');
    expect(stored).toMatchObject({ panel: { w: 300 } });
  });

  it('клавиатура на ручке: ← шире на 16, → уже на 16, Home — 300', async () => {
    const host = mount();
    await flush();
    const grip = q(host, '.grip');
    expect([grip.getAttribute('role'), grip.tabIndex]).toEqual(['separator', 0]);
    key(grip, 'ArrowLeft');
    await flush();
    expect(sideW(host)).toBe('316px');
    key(grip, 'ArrowLeft');
    key(grip, 'ArrowRight');
    await flush();
    expect(sideW(host)).toBe('316px');
    expect(stored).toMatchObject({ panel: { w: 316 } });
    key(grip, 'Home');
    await flush();
    expect(sideW(host)).toBe('300px');
    expect(stored).toMatchObject({ panel: { w: 300 } });
  });
});

describe('состояние webview', () => {
  it('восстановление из getState: ширина, вкладка, свёрнутость', async () => {
    stored = { sessionId: 's1', panel: { w: 420, tab: 'agents', off: false } };
    const host = mount();
    await session();
    await flush();
    expect(sideW(host)).toBe('420px');
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('agents');
  });

  it('прочитанная ширина зажимается в пределы при рендере', async () => {
    stored = { panel: { w: 5000 } };
    const host = mount();
    await flush();
    expect(sideW(host)).toBe(`${BODY_W - 360}px`);
    render(null, host);
    stored = { panel: { w: 10 } };
    const host2 = mount();
    await flush();
    expect(sideW(host2)).toBe('220px');
  });

  it('кривое panel в state не ломает рендер: значения по умолчанию', async () => {
    stored = { sessionId: 's1', panel: { w: 'wide', off: 'yes', tab: 'log' } };
    const host = mount();
    await session();
    await flush();
    expect(sideW(host)).toBe('300px');
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
    expect(q(host, '#pane-changes').hidden).toBe(false);
  });

  it('по умолчанию: 300 px, развёрнута, «изменения»', async () => {
    const host = mount();
    await flush();
    expect(sideW(host)).toBe('300px');
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
  });

  it('сохранённое tab: «turn» (старое имя вкладки) открывает «изменения»', async () => {
    stored = { panel: { tab: 'turn' } };
    const host = mount();
    await session();
    await flush();
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('changes');
    expect(q(host, '#pane-changes').hidden).toBe(false);
    expect(tabs(host)[0]!.textContent).toContain('изменения');
  });

  it('вкладка «изменения»: файлы по папкам, итог, проверки; бейдж — число файлов', async () => {
    const host = mount();
    const at = Date.now();
    const ev = (e: Record<string, unknown>) => dispatchEvent(e as unknown as AgentEvent, at);
    ev({ type: 'turn.start', at, prompt: 'поправь' });
    ev({
      type: 'tool.start',
      toolUseId: 'e1',
      name: 'Edit',
      input: { file_path: `${chat.value.cwd}/src/a.ts`, old_string: 'x', new_string: 'y\nz' },
      at,
    });
    ev({ type: 'tool.result', toolUseId: 'e1', isError: false, content: 'ok', durationMs: 5 });
    ev({ type: 'tool.start', toolUseId: 'b1', name: 'Bash', input: { command: 'npm test' }, at });
    ev({ type: 'tool.result', toolUseId: 'b1', isError: false, content: '', durationMs: 2100 });
    await flush();
    const pane = q(host, '#pane-changes');
    expect(pane.querySelector('.dir')?.textContent).toContain('src/');
    expect(pane.querySelector('.file .nm')?.textContent).toBe('a.ts');
    expect(pane.querySelector('.tot')?.textContent).toContain('1');
    expect(pane.querySelector('.chk code')?.textContent).toBe('npm test');
    expect(tabs(host)[0]!.querySelector('.b')?.textContent).toBe('1');
  });

  it('охват «сессия | ход» переключается и сохраняется в panel.changes', async () => {
    const host = mount();
    await session();
    await flush();
    const scope = () =>
      [...host.querySelectorAll<HTMLElement>('#pane-changes .scope button')].map((b) =>
        b.getAttribute('aria-pressed'),
      );
    expect(scope()).toEqual(['true', 'false']);
    host.querySelectorAll<HTMLElement>('#pane-changes .scope button')[1]!.click();
    await flush();
    expect(scope()).toEqual(['false', 'true']);
    expect((stored as { panel: { changes: string } }).panel.changes).toBe('turn');
  });

  it('сохранение панели не затирает sessionId, и наоборот', async () => {
    stored = { sessionId: 's1' };
    const host = mount();
    await flush();
    fire(q(host, '.grip'), 'dblclick');
    await flush();
    expect(stored).toEqual({ sessionId: 's1', panel: { w: 300 } });
    vscode.persistSession('s2');
    expect(stored).toEqual({ sessionId: 's2', panel: { w: 300 } });
  });
});

describe('узкий режим', () => {
  it('hud.css прячет вкладки панели, ручку и полосу без data-width (так в расширении узкий режим)', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'media', 'hud.css'), 'utf8');
    expect(css).toContain(
      'html:not(:is([data-width="900"],[data-width="full"],[data-width="vscode"])) :is(.ptabs, .grip, .rail) { display: none !important; }',
    );
    expect(css).not.toMatch(/html\[data-width="380"\] \.(ptabs|grip|rail)/);
  });

  it('широкий → узкий → широкий: панель не применяется в узком и возвращается в широком', async () => {
    stored = { panel: { w: 420, off: true, tab: 'agents' } };
    const host = mount();
    await session();
    await flush();
    expect(body(host).getAttribute('data-side')).toBe('off');
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await flush();
    expect(document.documentElement.hasAttribute('data-width')).toBe(false);
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect(q(host, '#pane-agents').getAttribute('aria-labelledby')).toBe('tab-agents');
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await flush();
    expect(body(host).getAttribute('data-side')).toBe('off');
    expect(sideW(host)).toBe('420px');
    expect(q(host, '#pane-agents').getAttribute('aria-labelledby')).toBe('ptab-agents');
    expect(stored).toEqual({ panel: { w: 420, off: true, tab: 'agents' } });
  });

  it('меньше 700 px: вкладки шапки есть, панель не применяется (data-width снят, состояние не меняется)', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    stored = { panel: { w: 420, off: true } };
    const host = mount();
    await session();
    await flush();
    expect(document.documentElement.hasAttribute('data-width')).toBe(false);
    // ручка и полоса лежат в DOM, но скрыты hud.css при отсутствии data-width; тело без `data-side`
    expect(body(host).hasAttribute('data-side')).toBe(false);
    expect([...host.querySelectorAll('.tabs [role="tab"]')].map((x) => x.id)).toEqual([
      'tab-chat',
      'tab-changes',
      'tab-agents',
    ]);
    const changes = host.querySelectorAll<HTMLElement>('.tabs [role="tab"]')[1]!;
    changes.click();
    await flush();
    expect(q(host, '#pane-changes').getAttribute('aria-labelledby')).toBe('tab-changes');
    expect(q(host, '#pane-changes').hidden).toBe(false);
    expect(stored).toEqual({ panel: { w: 420, off: true } });
  });
});
