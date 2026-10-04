// @vitest-environment jsdom
/**
 * Виды вкладки «агенты» (roadmap 11, этап 1) в DOM: `data-agents` из `chat.info`, дерево, дорожки,
 * карточки, охват «ход / сессия». Данные — живой прогон `agents-parallel` через `dispatchEvent`.
 */
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { agentsParallelEvents } from '../agent/claude/__fixtures__/agentsParallel';
import type { AgentsView } from '../settings';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { AgentsPane } from './components/SidePanes';
import { agentMapView } from './agentsView';
import { agentsViewPane } from './agentViews';
import type { AgentNode } from './hudState';
import { initialHud } from './hudState';
import { chat, dispatchEvent, handleHostMessage, hudState, selectedAgent, tick } from './store';
import * as vscode from './vscode';

const flush = () => new Promise((r) => setTimeout(r, 50));
const posted: Record<string, unknown>[] = [];
const mounted: HTMLElement[] = [];
// состояние webview — в переменной: `host()` кэширует api, поэтому заглушка ставится один раз до первого вызова
let stored: unknown;
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState: () => stored,
  setState: (s: unknown) => void (stored = s),
});

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  // вкладка «агенты» открыта: виды Б/В/Г на скрытой вкладке модель не строят
  stored ??= { panel: { tab: 'agents' } };
  render(h(Chat, {}), host);
  return host;
}

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  stored = undefined;
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
  chat.value = initialState();
  hudState.value = initialHud();
  selectedAgent.value = undefined;
  info();
});

const info = (agentsView?: AgentsView) =>
  handleHostMessage({
    type: 'chat.info',
    project: 'p',
    cwd: '/p',
    allowBypass: false,
    ...(agentsView ? { agentsView } : {}),
  });

/** До момента, когда у всех трёх субагентов есть вызов, а основной ждёт двух Explore. */
async function midTurn(): Promise<AgentEvent[]> {
  const all = await agentsParallelEvents();
  const calls = all
    .map((e, i) => (e.type === 'tool.start' && e.agentId ? i : -1))
    .filter((i) => i >= 0);
  return all.slice(0, calls[2]! + 1);
}

/**
 * Посреди хода: фоновый shell и трое субагентов идут (ход 1). `mixed` — первый субагент готов, третий упал;
 * `older` — ещё и агент прошлого хода 0, а shell запущен в ходе 0.
 */
async function play(opts: { mixed?: boolean; older?: boolean } = {}) {
  let now = Date.now();
  for (const e of await midTurn()) dispatchEvent(e, (now += 10));
  tick.value = now;
  chat.value = { ...chat.value, sessionId: 'sess' };
  const hud = hudState.value;
  const [bg, ...subs] = hud.agents as [AgentNode, ...AgentNode[]];
  const shown = subs.map((a, i): AgentNode => {
    if (!opts.mixed) return a;
    return i === 0
      ? {
          ...a,
          status: 'completed',
          endedAt: now,
          durationMs: 40_000,
          summary: 'Нашёл одно место.',
        }
      : i === 2
        ? { ...a, status: 'failed', endedAt: now, durationMs: 22_000, summary: 'ECONNREFUSED' }
        : a;
  });
  const old: AgentNode[] = opts.older
    ? [
        {
          ...subs[0]!,
          agentId: 'old-1',
          taskId: 'old-task-1',
          description: 'старая разведка',
          status: 'completed',
          endedAt: now - 60_000,
          durationMs: 30_000,
          turnNo: 0,
          summary: 'старый итог',
          segs: [],
        },
      ]
    : [];
  hudState.value = {
    ...hud,
    agents: [...old, { ...bg, turnNo: opts.older ? 0 : bg.turnNo }, ...shown],
  };
  await flush();
}

const q = <T extends Element = HTMLElement>(host: ParentNode, sel: string) =>
  host.querySelector<T>(sel)!;
const qa = <T extends Element = HTMLElement>(host: ParentNode, sel: string) => [
  ...host.querySelectorAll<T>(sel),
];

describe('data-agents и вид списка', () => {
  it('data-agents приходит из chat.info; без поля — list; смена применяется сразу', async () => {
    const host = mount();
    await play();
    expect(q(host, '.webview').getAttribute('data-agents')).toBe('list');
    expect(qa(host, '#pane-agents .amap .ag .a.sub')).toHaveLength(3);
    info('tree');
    await flush();
    expect(q(host, '.webview').getAttribute('data-agents')).toBe('tree');
    expect(qa(host, '#pane-agents .amap')).toHaveLength(0);
    expect(qa(host, '#pane-agents .am[data-view="tree"]')).toHaveLength(1);
    info();
    await flush();
    expect(q(host, '.webview').getAttribute('data-agents')).toBe('list');
    expect(qa(host, '#pane-agents .amap')).toHaveLength(1);
  });

  it('graph: значение настройки, панель показывает список; кнопки «граф» пока нет', async () => {
    const host = mount();
    await play();
    info('graph');
    await flush();
    expect(q(host, '.webview').getAttribute('data-agents')).toBe('graph');
    expect(qa(host, '#pane-agents .amap .ag .a.sub')).toHaveLength(3);
    expect(qa(host, '#pane-agents .lnk')).toHaveLength(0);
  });
});

describe('Б · дерево', () => {
  it('раскрыт выбранный (идущий), клик по другому переносит раскрытие', async () => {
    info('tree');
    const host = mount();
    await play();
    const nodes = qa(host, '#pane-agents .kids:not(.bg) > li');
    expect(nodes).toHaveLength(3);
    expect(qa(host, '#pane-agents .open')).toHaveLength(1);
    expect(nodes[0]!.classList.contains('sel')).toBe(true);
    expect(nodes[0]!.querySelector('.open .q')?.textContent).toMatch(/alpha\/notes\.md/);
    q(nodes[2]!, '.nd').click();
    await flush();
    const after = qa(host, '#pane-agents .kids:not(.bg) > li');
    expect(after.map((li) => li.classList.contains('sel'))).toEqual([false, false, true]);
    expect(qa(host, '#pane-agents .open')).toHaveLength(1);
    expect(after[2]!.querySelector('.open')).not.toBeNull();
    const btns = qa(after[2]!, '.open .ac button');
    expect(btns.map((b) => b.textContent)).toEqual(['транскрипт', 'остановить']);
    btns[0]!.click();
    btns[1]!.click();
    expect(posted.slice(-2).map((m) => m['type'])).toEqual(['agent.transcript', 'agent.stop']);
  });

  it('охват «сессия» (по умолчанию): последний ход раскрыт, прошлые — свёрнутой строкой; клик раскрывает', async () => {
    info('tree');
    const host = mount();
    await play({ mixed: true, older: true });
    const turns = qa(host, '#pane-agents .turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.querySelector('.kids')).not.toBeNull();
    expect(turns[1]!.querySelector('.kids')).toBeNull();
    expect(turns[1]!.querySelector('.th')?.textContent).toMatch(/ход 0 · \d\d:\d\d · Explore ✓/);
    // идущий фоновый shell прошлого хода висит пунктирной веткой под последним ходом, с «с хода 1»
    expect(turns[0]!.querySelector('.kids.bg')?.textContent).toMatch(/с хода 0/);
    q(turns[1]!, '.th').click();
    await flush();
    const open = qa(host, '#pane-agents .turn')[1]!;
    expect(open.querySelector('.kids')).not.toBeNull();
    expect(open.querySelector('.th')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('переключатель «ход / сессия» меняет охват и запоминается в panel.agScope', async () => {
    info('tree');
    const host = mount();
    await play({ older: true });
    const btns = () => qa(host, '#pane-agents .top .seg button');
    expect(btns().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    btns()[0]!.click();
    await flush();
    expect(btns().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(qa(host, '#pane-agents .turn')).toHaveLength(1);
    expect((stored as { panel: { agScope: unknown } }).panel.agScope).toEqual({ tree: 'turn' });
  });
});

describe('В · дорожки', () => {
  it('дорожка на каждого агента и основной, линия «сейчас» у идущих, выбранная подсвечена', async () => {
    info('lanes');
    const host = mount();
    await play({ mixed: true });
    const lanes = qa(host, '#pane-agents .ln');
    expect(lanes).toHaveLength(5); // основной, 3 агента, фоновый shell
    expect(qa(host, '#pane-agents .ax .sc span').length).toBeGreaterThanOrEqual(2);
    // идут основной, второй агент и shell; первый готов, третий упал
    expect(lanes.map((l) => l.querySelector('.now') !== null)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(lanes.map((l) => l.querySelector('.bar')?.className.replace('bar ', ''))).toEqual([
      expect.stringMatching(/think|tool|wait/),
      'ok',
      'busy',
      'err',
      'sh',
    ]);
    expect(lanes[2]!.classList.contains('sel')).toBe(true);
    expect(qa(host, '#pane-agents .ldet')).toHaveLength(1);
    q(lanes[1]!, '.lb').click();
    await flush();
    expect(qa(host, '#pane-agents .ln')[1]!.classList.contains('sel')).toBe(true);
    expect(q(host, '#pane-agents .ldet .t').textContent).toMatch(/Explore/);
  });
});

describe('Г · карточки', () => {
  it('порядок: идущие → упавшие → готовые; «■ стоп» шлёт agent.stop', async () => {
    info('cards');
    const host = mount();
    await play({ mixed: true });
    const cards = qa(host, '#pane-agents .card');
    expect(cards.map((c) => c.className)).toEqual(['card is-busy', 'card is-err', 'card']);
    const stop = qa(cards[0]!, '.cf button.err')[0]!;
    expect(stop.textContent).toBe('■ стоп');
    stop.click();
    expect(posted.at(-1)).toEqual({
      type: 'agent.stop',
      sessionId: 'sess',
      taskId: 'af768b2aec0b6c731',
    });
    // у упавшей — текст ошибки и «лог», у готовой — выдержка итога и оценка «в основной»
    expect(cards[1]!.querySelector('.cb')?.textContent).toBe('ECONNREFUSED');
    expect(cards[1]!.querySelector('.cf button')?.textContent).toBe('лог');
    expect(cards[2]!.querySelector('.cb')?.textContent).toBe('Нашёл одно место.');
    expect(cards[2]!.querySelector('.cf')?.textContent).toMatch(/итог ≈\d+/);
    // «перезапустить» и «продолжить» не делаем: движок не умеет
    expect(host.textContent).not.toMatch(/перезапустить|продолжить/);
  });

  it('охват «сессия» — прошлый ход свёрнут; шапка карточек — счётчики', async () => {
    info('cards');
    const host = mount();
    await play({ mixed: true, older: true });
    expect(q(host, '#pane-agents .top .r').textContent).toBe('1 идёт · 1 готово · 1 ошибка');
    qa(host, '#pane-agents .top .seg button')[1]!.click();
    await flush();
    const turns = qa(host, '#pane-agents .turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.querySelector('.cards')).toBeNull();
    expect(turns[1]!.querySelector('.th')?.textContent).toMatch(/ход 0/);
    q(turns[1]!, '.th').click();
    await flush();
    expect(qa(host, '#pane-agents .turn')[1]!.querySelectorAll('.card')).toHaveLength(1);
  });
});

describe('кнопка «↗ граф»', () => {
  const noop = () => {};
  const base = { now: Date.now(), onSelect: noop, onStop: noop, onTranscript: noop, onScope: noop };

  it('есть, только если передан onGraph (поверхности графа ещё нет — Chat его не передаёт)', async () => {
    info('tree');
    const host = mount();
    await play();
    expect(qa(host, '#pane-agents .top .btn')).toHaveLength(0); // в Chat кнопки нет
    const hud = hudState.value;
    const o = { working: true, waiting: true, now: base.now };
    const opened: string[] = [];
    const el = document.createElement('div');
    mounted.push(el);
    document.body.append(el);
    for (const mode of ['tree', 'lanes', 'cards'] as const) {
      render(
        h(AgentsPane, {
          ...base,
          model: { mode: 'views', view: agentsViewPane(hud, mode, 'turn', o) },
          onGraph: () => void opened.push(mode),
        }),
        el,
      );
      q(el, '.top .btn').click();
    }
    render(
      h(AgentsPane, {
        ...base,
        model: { mode: 'list', view: agentMapView(hud, o) },
        onGraph: () => void opened.push('list'),
      }),
      el,
    );
    q(el, '.amap h4 .lnk').click();
    expect(opened).toEqual(['tree', 'lanes', 'cards', 'list']);
    render(h(AgentsPane, { ...base, model: { mode: 'list', view: agentMapView(hud, o) } }), el);
    expect(qa(el, '.amap h4 .lnk')).toHaveLength(0);
  });
});
