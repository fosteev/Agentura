// @vitest-environment jsdom
/**
 * Вид ленты (roadmap 08): `data-feed` из `chat.info`, ходы-контейнеры, «свёрнуто» по клику, `.live` внутри
 * идущего хода, цена и время в шапке карточки.
 */
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { chat, dispatchEvent, feedStyle, handleHostMessage, hudState, provider } from './store';
import * as vscode from './vscode';

const T0 = 1_700_000_000_000;
const usage = { input: 1204, output: 2318, cacheRead: 128400, cacheWrite: 3902 };
const flush = () => new Promise((r) => setTimeout(r, 50));
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
  vi.spyOn(vscode, 'send').mockImplementation(() => undefined);
  chat.value = initialState();
  hudState.value = initialHud();
  feedStyle.value = 'journal';
});

const info = (feedStyleValue?: 'journal' | 'folded' | 'replies' | 'cards') =>
  handleHostMessage({
    type: 'chat.info',
    project: 'p',
    cwd: '/p',
    allowBypass: false,
    ...(feedStyleValue ? { feedStyle: feedStyleValue } : {}),
  });

/** Первый ход завершён (read, edit, ответ, итог), второй идёт (bash в работе). */
function play(opts: { secondRunning: boolean }): void {
  const ev: AgentEvent[] = [
    { type: 'turn.start', at: T0, prompt: 'первый' },
    { type: 'tool.start', toolUseId: 't1', name: 'Read', input: { file_path: '/p/a.ts' } },
    { type: 'tool.result', toolUseId: 't1', isError: false, content: 'ok', durationMs: 400 },
    {
      type: 'tool.start',
      toolUseId: 't2',
      name: 'Edit',
      input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' },
    },
    { type: 'tool.result', toolUseId: 't2', isError: false, content: 'ok', durationMs: 1100 },
    { type: 'text.delta', messageId: 'm1', text: 'Готово.' },
    {
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 48_000,
      apiDurationMs: 40_000,
      numTurns: 3,
      totalCostUsd: 0.21,
      costUsd: 0.21,
      usage,
      permissionDenials: [],
    },
  ];
  let now = T0;
  for (const e of ev) dispatchEvent(e, (now += 10));
  if (opts.secondRunning) {
    // таймер ленты идёт по настоящим часам — ход начался «11 секунд назад»
    const at = Date.now() - 11_000;
    dispatchEvent({ type: 'turn.start', at, prompt: 'второй' }, at);
    dispatchEvent(
      { type: 'tool.start', toolUseId: 't3', name: 'Bash', input: { command: 'npm test' } },
      at + 1000,
    );
  }
}

describe('вид ленты', () => {
  it('data-feed на корне чата приходит из chat.info; без поля — journal', async () => {
    const host = mount();
    expect(host.querySelector('.webview')?.getAttribute('data-feed')).toBe('journal');
    info('cards');
    await flush();
    expect(host.querySelector('.webview')?.getAttribute('data-feed')).toBe('cards');
    info('folded');
    await flush();
    expect(host.querySelector('.webview')?.getAttribute('data-feed')).toBe('folded');
    info();
    await flush();
    expect(host.querySelector('.webview')?.getAttribute('data-feed')).toBe('journal');
  });

  it('ходы: .turn с .u, .steps, .sum; завершённый — done, идущий — live', async () => {
    const host = mount();
    play({ secondRunning: true });
    await flush();
    const turns = [...host.querySelectorAll('.log > .turn')];
    expect(turns.map((t) => [t.getAttribute('data-state'), t.getAttribute('data-open')])).toEqual([
      ['done', 'false'],
      ['live', 'true'],
    ]);
    expect(turns[0]!.querySelector(':scope > .u')?.textContent).toContain('первый');
    expect(turns[0]!.querySelectorAll(':scope > .steps > .e')).toHaveLength(2);
    expect(turns[0]!.querySelector(':scope > .sum')).not.toBeNull();
    expect(turns[0]!.querySelector(':scope > .who')?.textContent).toBe('claude');
    provider.value = 'codex';
    await flush();
    expect(host.querySelector('.log > .turn > .who')?.textContent).toBe('codex');
    provider.value = 'claude';
  });

  it('folded: .fold со сводкой, клик раскрывает и сворачивает, идущий ход — всегда раскрыт', async () => {
    const host = mount();
    info('folded');
    play({ secondRunning: true });
    await flush();
    const [done, live] = [...host.querySelectorAll('.log > .turn')] as HTMLElement[];
    const fold = done!.querySelector('button.fold') as HTMLButtonElement;
    expect(fold.querySelector('.n')?.textContent).toBe('2 действия');
    expect(fold.querySelector('.what')?.textContent).toMatch(/read · edit \+1 −1/);
    expect(fold.querySelectorAll('.mstrip i')).toHaveLength(2);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fold.click();
    await flush();
    expect(done!.getAttribute('data-open')).toBe('true');
    expect(done!.querySelector('button.fold')?.getAttribute('aria-expanded')).toBe('true');
    (done!.querySelector('button.fold') as HTMLButtonElement).click();
    await flush();
    expect(done!.getAttribute('data-open')).toBe('false');

    const liveFold = live!.querySelector('button.fold') as HTMLButtonElement;
    expect(liveFold.querySelector('.n')?.textContent).toBe('1 действие');
    expect(liveFold.querySelector('.what')?.textContent).toBe('идёт');
    liveFold.click();
    await flush();
    expect(live!.getAttribute('data-open')).toBe('true');
  });

  it('.live — внутри идущего хода; когда хода нет — после всех ходов', async () => {
    const host = mount();
    play({ secondRunning: true });
    await flush();
    const live = host.querySelector('.log > .turn[data-state="live"] > .live');
    expect(live).not.toBeNull();
    expect(host.querySelectorAll('.log > .live')).toHaveLength(0);
  });

  it('cards: .tm в шапке — цена и время завершённого хода, «идёт Ns» у идущего', async () => {
    const host = mount();
    info('cards');
    play({ secondRunning: true });
    await flush();
    const [done, live] = [...host.querySelectorAll('.log > .turn')];
    expect(done!.querySelector('.u .tm')?.textContent).toBe('$0.21 · 48s');
    expect(live!.querySelector('.u .tm')?.textContent).toMatch(/^идёт 1[12]s$/);
    // время в итоге обёрнуто — в карточке его прячет CSS
    expect(done!.querySelector('.sum .t')?.textContent).toBe('48s');
  });
});
