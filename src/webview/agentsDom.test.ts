// @vitest-environment jsdom
/**
 * Несколько агентов (A6) в DOM: живой прогон `agents-parallel` через `dispatchEvent` — группа в
 * ленте по разметке `prototype/screens/agents.html`, «stop all», бейдж, карта «список + детали».
 */
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { agentsParallelEvents } from '../agent/claude/__fixtures__/agentsParallel';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { chat, dispatchEvent, hudState, selectedAgent, tick } from './store';
import * as vscode from './vscode';

const flush = () => new Promise((r) => setTimeout(r, 50));
const posted: Record<string, unknown>[] = [];
const mounted: HTMLElement[] = [];

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-width');
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
  chat.value = initialState();
  hudState.value = initialHud();
  selectedAgent.value = undefined;
});

/** До момента, когда у всех трёх субагентов есть вызов, а основной ждёт двух Explore. */
async function midTurn(): Promise<AgentEvent[]> {
  const all = await agentsParallelEvents();
  const calls = all
    .map((e, i) => (e.type === 'tool.start' && e.agentId ? i : -1))
    .filter((i) => i >= 0);
  return all.slice(0, calls[2]! + 1);
}

describe('группа субагентов и карта агентов', () => {
  it('посреди хода: группа ×3, «ждёт 2 агентов», stop all — stopTask каждому живому', async () => {
    const host = mount();
    let now = Date.now();
    for (const e of await midTurn()) dispatchEvent(e, (now += 10));
    tick.value = now;
    await flush();
    const grp = host.querySelector('.log .grp');
    expect(grp?.querySelector('.gh .what')?.textContent).toMatch(/^×3 параллельно · 3 идут/);
    expect(grp?.querySelectorAll('.sa.busy')).toHaveLength(3);
    expect(grp?.querySelector('.sa .ds small')?.textContent).toBe('read notes.md');
    expect(grp?.querySelector('.gf .sp')?.textContent).toBe('основной ждёт агентов');
    // вызовы субагентов в основную ленту не попали
    const own = [...host.querySelectorAll('.log .e:not(.think)')].filter((e) => !e.closest('.grp'));
    expect(own).toHaveLength(1); // только Bash основного
    const live = host.querySelector('.log .live');
    expect(live?.textContent).toMatch(/ждёт 2 агентов/);
    const badge = host.querySelector('#tab-agents .b');
    expect([badge?.textContent, badge?.className]).toEqual(['3 / 3', 'b live']);

    (live?.querySelector('button.stop') as HTMLButtonElement).click();
    expect(posted.filter((m) => m['type'] === 'agent.stop').map((m) => m['taskId'])).toEqual([
      'a8829ceaf8a64fefc',
      'af768b2aec0b6c731',
      'a8131aefac5b50945',
    ]);
    expect(posted.some((m) => m['type'] === 'interrupt')).toBe(false);
  });

  it('«карта агентов» открывает вкладку: список, детали с промптом, ■ и «транскрипт»', async () => {
    // узкая вкладка (< 700 px): «агенты» — отдельная вкладка, ссылка переключает на неё
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    const host = mount();
    let now = Date.now();
    for (const e of await midTurn()) dispatchEvent(e, (now += 10));
    tick.value = now;
    chat.value = { ...chat.value, sessionId: 'sess' };
    await flush();
    const links = [...host.querySelectorAll('.grp .gf a')] as HTMLAnchorElement[];
    links.find((a) => a.textContent === 'карта агентов')!.click();
    await flush();
    expect(host.querySelector('#tab-agents')?.getAttribute('aria-selected')).toBe('true');
    const pane = host.querySelector('#pane-agents .amap');
    expect(pane?.querySelectorAll('.list .ag .a.sub')).toHaveLength(3);
    expect(pane?.querySelector('.a.sub.sel .nm')?.textContent).toMatch(
      /^Explore: Read second line from alpha/,
    );
    expect(pane?.querySelector('.det .prm')?.textContent).toMatch(/alpha\/notes\.md/);
    // выбрать третьего — детали переключаются
    (pane?.querySelectorAll('.a.sub')[2] as HTMLElement).click();
    await flush();
    expect(host.querySelector('.det .hd .ty')?.textContent).toBe('· general-purpose');
    const acts = [...host.querySelectorAll('.det .hd .acts button')] as HTMLButtonElement[];
    expect(acts.map((b) => b.textContent)).toEqual(['транскрипт', 'остановить']);
    acts[0]!.click();
    acts[1]!.click();
    expect(posted.slice(-2)).toEqual([
      {
        type: 'agent.transcript',
        sessionId: 'sess',
        agentId: 'toolu_015JQ6U8527mUHiSC6orLF33',
        taskId: 'a8131aefac5b50945',
      },
      { type: 'agent.stop', sessionId: 'sess', taskId: 'a8131aefac5b50945' },
    ]);
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  });

  it('после хода: итоги, «свернуть» сворачивает группу, бейдж — число агентов', async () => {
    const host = mount();
    let now = Date.now();
    for (const e of await agentsParallelEvents()) dispatchEvent(e, (now += 10));
    tick.value = now;
    await flush();
    const grp = host.querySelector('.log .grp')!;
    expect([...grp.querySelectorAll('.sa.ok .st')].map((s) => s.textContent)).toEqual([
      '✓',
      '✓',
      '✓',
    ]);
    expect(grp.querySelector('.sa .r a')?.textContent).toBe('итог');
    expect(host.querySelector('#tab-agents .b')?.textContent).toBe('3');
    (
      [...grp.querySelectorAll('.gf a')].find((a) => a.textContent === 'свернуть') as HTMLElement
    ).click();
    await flush();
    expect(host.querySelectorAll('.log .grp .sa')).toHaveLength(0);
    expect(host.querySelector('.log .grp .gh .p')?.textContent).toBe('▸');
  });
});
