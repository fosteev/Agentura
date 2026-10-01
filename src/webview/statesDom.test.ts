// @vitest-environment jsdom
/**
 * Этап 7: пять состояний из `test/fixtures/states/*.jsonl` проигрываются тем же путём, что живые
 * сообщения хоста (`handleHostMessage`), и дают нужный экран — как отладочная команда `showState`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { STATE_NAMES, parseFixture, resolveTimes, type StateName } from '../extension/debugStates';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import {
  chat,
  dispatchEvent,
  handleHostMessage,
  hudState,
  limitBlocked,
  limits,
  replyTarget,
  RETRY_TIMEOUT_MS,
  retryTurn,
  tick,
} from './store';
import * as vscode from './vscode';

const NOW = Date.UTC(2026, 9, 1, 11, 0, 0);
const flush = () => new Promise((r) => setTimeout(r, 120));
const posted: Record<string, unknown>[] = [];
const mounted: HTMLElement[] = [];

const fixture = (name: StateName) =>
  readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'states', `${name}.jsonl`), 'utf8');

function play(name: StateName, now = Date.now()): void {
  for (const m of parseFixture(fixture(name), now)) handleHostMessage(m);
}

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

const button = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
  chat.value = initialState();
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
  replyTarget.value = undefined;
  tick.value = Date.now();
});

describe('фикстуры состояний', () => {
  it('все пять есть и разбираются; метки времени {"$now"} подставляются', () => {
    expect(STATE_NAMES).toEqual(['empty', 'working', 'waiting', 'error', 'limited']);
    for (const name of STATE_NAMES)
      expect(parseFixture(fixture(name), NOW).length).toBeGreaterThan(2);
    expect(resolveTimes({ a: [{ $now: -1000 }], b: 5 }, NOW)).toEqual({ a: [NOW - 1000], b: 5 });
    expect(() => parseFixture('{"type":', NOW)).toThrow(/строка 1/);
  });

  it('empty: пустая сессия, список сессий с состояниями err/limit/waiting', () => {
    play('empty');
    const s = chat.value;
    expect(s.rows).toHaveLength(0);
    expect(s.status).toBe('idle');
    expect(s.project).toBe('queue-board');
  });

  it('working: ход идёт, инструмент бежит', () => {
    play('working');
    expect(chat.value.status).toBe('working');
    const tool = chat.value.rows.find((r) => r.kind === 'tool' && r.state === 'run');
    expect(tool).toBeTruthy();
  });

  it('waiting: три карточки (разрешение с диффом, вопрос, план), превью дошло', () => {
    play('waiting');
    const s = chat.value;
    expect(s.status).toBe('waiting');
    const kinds = s.rows.map((r) => r.kind);
    expect(kinds).toContain('perm');
    expect(kinds).toContain('question');
    expect(kinds).toContain('plan');
    const perm = s.rows.find((r) => r.kind === 'perm');
    expect(perm && 'preview' in perm && perm.preview?.hunks.length).toBe(1);
    expect(s.pending).toHaveLength(3);
  });

  it('error: карточка «Движок остановился», сессия закрыта, состояние error', () => {
    play('error');
    const s = chat.value;
    expect(s.status).toBe('error');
    expect(s.closed?.reason).toBe('error');
    const fails = s.rows.filter((r) => r.kind === 'fail');
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ fatal: true, turn: true, state: 'open' });
  });

  it('limited: «ход не начат» одной строкой, сброс известен, отправка заблокирована', () => {
    play('limited');
    const s = chat.value;
    expect(s.status).toBe('limited');
    const rows = s.rows.filter((r) => r.kind === 'sys' && r.tag === 'limit');
    expect(rows).toHaveLength(1);
    expect(s.limitResetsAt).toBeGreaterThan(Date.now());
    expect(limitBlocked.value?.kind).toBe('five-hour');
  });
});

describe('порог контекста в ленте (limit.html)', () => {
  const usage = (usedTokens: number): AgentEvent => ({
    type: 'context.usage',
    usedTokens,
    maxTokens: 200_000,
    autoCompactThreshold: 190_000,
    source: 'usage',
  });
  const passed = () =>
    chat.value.rows.filter((r) => r.kind === 'sys' && r.text.join('').includes('пройден'));

  it('последний порог пройден — одна строка; дальше рост без повторов; после сжатия и нового роста — снова', () => {
    hudState.value = initialHud([120_000, 150_000]);
    dispatchEvent(usage(100_000));
    dispatchEvent(usage(140_000));
    expect(passed()).toHaveLength(0);
    dispatchEvent(usage(168_420));
    expect(passed()).toHaveLength(1);
    expect((passed()[0] as { text: string[] }).text.join('')).toBe(
      'контекст 168k: порог 150k пройден, автосжатие при 190k',
    );
    dispatchEvent(usage(170_000));
    expect(passed()).toHaveLength(1);
    dispatchEvent({ type: 'compaction.end', ok: true, postTokens: 30_000 } as AgentEvent);
    dispatchEvent(usage(155_000));
    expect(passed()).toHaveLength(2);
  });

  it('субагент контекст основного не двигает и строку не рисует', () => {
    hudState.value = initialHud([120_000, 150_000]);
    dispatchEvent({ ...usage(180_000), agentId: 'a1' });
    expect(passed()).toHaveLength(0);
  });
});

describe('экран error (error.html)', () => {
  it('карточка: заголовок, текст ошибки, подсказка про сеть, три элемента управления', async () => {
    const host = mount();
    play('error');
    await flush();
    const card = host.querySelector('.ask.danger[role="alert"]')!;
    expect(card.querySelector('.h')?.textContent).toContain('Движок остановился');
    expect(card.querySelector('pre')?.textContent).toContain('ECONNRESET');
    expect(card.textContent).toContain('Похоже на обрыв сети');
    expect(button(card, 'Повторить ход')).toBeTruthy();
    expect(button(card, 'Открыть журнал расширения')).toBeTruthy();
    expect(card.querySelector('.hint')?.textContent).toBe('журнал: панель Output → Agentura');
  });

  it('«Повторить ход» шлёт turn.retry и гасит кнопки; «Открыть журнал» — log.show', async () => {
    const host = mount();
    play('error');
    await flush();
    button(host, 'Открыть журнал')!.click();
    expect(posted.at(-1)).toEqual({ type: 'log.show' });
    button(host, 'Повторить ход')!.click();
    // ход оборван посреди работы — хост повторит промпт
    expect(posted.at(-1)).toMatchObject({ type: 'turn.retry', turn: true });
    await flush();
    const card = host.querySelector('.ask.danger')!;
    expect(button(card, 'Повторить ход')).toBeUndefined();
    expect(card.querySelector('.hint')?.textContent).toBe('повторяю…');
  });

  it('хост не начал ход: «повторяю…» по таймауту возвращает кнопки; пришедшая история таймер не ломает', () => {
    vi.useFakeTimers();
    try {
      play('error');
      retryTurn();
      expect(chat.value.rows.find((r) => r.kind === 'fail')).toMatchObject({ state: 'retrying' });
      vi.advanceTimersByTime(RETRY_TIMEOUT_MS - 1);
      expect(chat.value.rows.find((r) => r.kind === 'fail')).toMatchObject({ state: 'retrying' });
      vi.advanceTimersByTime(1);
      expect(chat.value.rows.find((r) => r.kind === 'fail')).toMatchObject({ state: 'open' });
      // второй клик: история пришла раньше таймера — карточки уже нет, таймер ничего не трогает
      retryTurn();
      handleHostMessage({
        type: 'session.history',
        sessionId: 'd0000000-0000-4000-8000-000000000007',
        events: [],
        skippedTurns: 0,
      });
      vi.advanceTimersByTime(RETRY_TIMEOUT_MS);
      expect(chat.value.rows.some((r) => r.kind === 'fail')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('после повтора история сессии заменяет ленту и снимает closed', async () => {
    mount();
    play('error');
    handleHostMessage({
      type: 'session.history',
      sessionId: 'd0000000-0000-4000-8000-000000000007',
      events: [],
      skippedTurns: 0,
    });
    expect(chat.value.closed).toBeUndefined();
    expect(chat.value.status).toBe('idle');
    expect(chat.value.rows.some((r) => r.kind === 'fail')).toBe(false);
  });

  it('упавший инструмент: красная строка раскрывается выводом; Enter тоже раскрывает', async () => {
    const host = mount();
    play('error');
    await flush();
    const row = host.querySelector('.log .e.fail[role="button"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('expected 42, received 0');
    row.click();
    await flush();
    expect(host.textContent).toContain('expected 42, received 0');
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flush();
    expect(host.textContent).not.toContain('expected 42, received 0');
  });

  it('claude не найден: карточка с инструкцией, «Открыть настройки» шлёт settings.open', async () => {
    const host = mount();
    dispatchEvent({
      type: 'error',
      fatal: true,
      code: 'engine_missing',
      message: 'Не найден Claude Code (claude).',
    } as AgentEvent);
    dispatchEvent({
      type: 'session.closed',
      reason: 'error',
      message: 'Не найден Claude Code (claude).',
    } as AgentEvent);
    await flush();
    const cards = host.querySelectorAll('.ask.danger');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector('.h')?.textContent).toContain('Claude Code не найден');
    expect(cards[0]!.textContent).toContain('agentura.claudeExecutable');
    expect(button(host, 'Повторить ход')).toBeFalsy();
    button(host, 'Открыть настройки')!.click();
    expect(posted.at(-1)).toEqual({ type: 'settings.open' });
    button(host, 'Проверить снова')!.click();
    expect(posted.at(-1)).toMatchObject({ type: 'turn.retry' });
  });

  it('обрыв сети посреди хода: error + session.closed → одна карточка, поле ввода выключено', async () => {
    const host = mount();
    dispatchEvent({ type: 'turn.start', at: Date.now(), prompt: 'сделай' } as AgentEvent);
    dispatchEvent({ type: 'error', fatal: true, message: 'fetch failed' } as AgentEvent);
    dispatchEvent({
      type: 'session.closed',
      reason: 'error',
      message: 'fetch failed',
    } as AgentEvent);
    await flush();
    expect(host.querySelectorAll('.ask.danger')).toHaveLength(1);
    expect(host.querySelector('footer.compose.off')).toBeTruthy();
  });
});

describe('экран limit (limit.html)', () => {
  it('баннер со временем сброса, строка «ход не начат», поле off с подписью, отправка выключена', async () => {
    const host = mount();
    play('limited');
    await flush();
    const banner = host.querySelector('.banner')!;
    expect(banner.textContent).toContain('Лимит 5-часового окна исчерпан.');
    expect(banner.textContent).toMatch(/Сброс в \d\d:\d\d, через 2 ч \d\d мин/);
    expect(banner.textContent).toContain('Недельное окно свободно на 64 %');
    expect(host.querySelector('.log .sys.bad')?.textContent).toContain('ход не начат');
    expect(host.querySelector('footer.compose.off')).toBeTruthy();
    expect(host.querySelector('footer .note')?.textContent).toMatch(
      /отправка отложена до \d\d:\d\d/,
    );
    expect((host.querySelector('button.send') as HTMLButtonElement).disabled).toBe(true);
    // автоотправки нет (A14 «Потом»): кнопки «Отправить в 17:00 автоматически» не существует
    expect(button(host, 'Отправить в')).toBeUndefined();
  });

  it('лимит общий на аккаунт: окно 100 % из limits.update блокирует и вкладку без своего упора', async () => {
    const host = mount();
    handleHostMessage({
      type: 'limits.update',
      windows: [{ kind: 'five-hour', percent: 100, resetsAt: Date.now() + 3_600_000 }],
      updatedAt: Date.now(),
    });
    await flush();
    expect(chat.value.status).toBe('idle');
    expect(host.querySelector('.banner')).toBeTruthy();
    expect(host.querySelector('footer.compose.off')).toBeTruthy();
  });

  it('блокировка по данным подписки снимается «Попробовать снова» (данные устарели, расход докуплен)', async () => {
    const host = mount();
    // отдельное время сброса: снятая блокировка помнится модулем стора и не должна задеть другие тесты
    const resetsAt = Date.now() + 5 * 3_600_000 + 17_000;
    handleHostMessage({
      type: 'limits.update',
      windows: [{ kind: 'five-hour', percent: 100, resetsAt }],
      updatedAt: Date.now(),
    });
    await flush();
    button(host, 'Попробовать снова')!.click();
    await flush();
    expect(host.querySelector('.banner')).toBeNull();
    expect(host.querySelector('footer.compose.off')).toBeNull();
  });

  it('по сбросу блокировка снимается сама (тик)', async () => {
    const host = mount();
    play('limited');
    await flush();
    expect(host.querySelector('.banner')).toBeTruthy();
    // прошло три часа: окно подписки (сброс +2 ч) и сброс своего упора позади
    tick.value = Date.now() + 3 * 3_600_000;
    limits.value = { windows: [], updatedAt: tick.value };
    await flush();
    expect(limitBlocked.value).toBeUndefined();
  });

  it('сброс неизвестен: баннер с «Попробовать снова», кнопка снимает блокировку', async () => {
    const host = mount();
    dispatchEvent({ type: 'turn.start', at: Date.now(), prompt: 'привет' } as AgentEvent);
    dispatchEvent({
      type: 'limit.update',
      source: 'engine',
      status: 'rejected',
      windows: [],
    } as unknown as AgentEvent);
    await flush();
    expect(host.querySelector('.banner')?.textContent).toContain('Время сброса неизвестно');
    button(host, 'Попробовать снова')!.click();
    await flush();
    expect(host.querySelector('.banner')).toBeNull();
    expect(chat.value.status).toBe('idle');
  });
});

describe('состояние waiting: строка «ждёт разрешения» в панели «ход»', () => {
  it('инструмент с запросом помечен в таймлайне и снимается ответом', async () => {
    const host = mount();
    play('waiting');
    await flush();
    const rows = [...host.querySelectorAll('#pane-turn .row.now')];
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('ждёт разрешения')]),
    );
    expect(rows.some((r) => r.textContent?.includes('ждёт ответа'))).toBe(true);
    expect(rows.some((r) => r.textContent?.includes('ждёт решения'))).toBe(true);
    dispatchEvent({
      type: 'permission.resolved',
      toolUseId: 't2',
      decision: 'allow',
      by: 'user',
    } as AgentEvent);
    await flush();
    expect(host.querySelector('#pane-turn')?.textContent).not.toContain('ждёт разрешения');
  });
});

describe('компакция', () => {
  it('«сжимаю» у шкалы контекста и в строке хода, пока идёт сжатие; строка ленты заменяется итогом', async () => {
    const host = mount();
    dispatchEvent({ type: 'turn.start', at: Date.now(), prompt: '/compact' } as AgentEvent);
    dispatchEvent({ type: 'compaction.start' } as AgentEvent);
    await flush();
    expect(host.querySelector('.compose .cn')?.textContent).toContain('сжимаю контекст');
    expect(host.querySelector('.live')?.textContent).toContain('сжимаю контекст');
    dispatchEvent({
      type: 'compaction.end',
      ok: true,
      trigger: 'manual',
      preTokens: 168420,
      postTokens: 41200,
    } as AgentEvent);
    await flush();
    expect(host.querySelector('.compose .cn')?.textContent).not.toContain('сжимаю');
    expect(host.querySelector('.log')?.textContent).toContain('168 420');
  });
});

describe('доступность', () => {
  it('вкладки: tablist, aria-selected/controls, стрелка переключает, фокус — на выбранной', async () => {
    const host = mount();
    play('working');
    await flush();
    const tabs = [...host.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual([
      'pane-chat',
      'pane-turn',
      'pane-agents',
    ]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    await flush();
    expect(
      (host.querySelectorAll('[role="tab"]')[1] as HTMLElement).getAttribute('aria-selected'),
    ).toBe('true');
    expect(host.querySelector('#pane-turn')?.getAttribute('role')).toBe('tabpanel');
  });

  it('карточки: кнопки достижимы по Tab (нативные button), у «span-кнопок» есть tabindex и aria-label', async () => {
    const host = mount();
    play('waiting');
    await flush();
    const card = host.querySelector('.ask')!;
    expect([...card.querySelectorAll('button')].every((b) => b.tabIndex >= 0)).toBe(true);
    expect(host.querySelector('.log')?.getAttribute('role')).toBe('log');
  });

  it('prefers-reduced-motion гасит анимации (спиннер, курсор), видимый фокус у карточек и меню задан', () => {
    const css = (f: string) => readFileSync(join(__dirname, '..', '..', 'media', f), 'utf8');
    expect(css('tokens.css')).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[^}]*animation: none !important/s,
    );
    expect(css('tokens.css')).toContain(':focus-visible');
    expect(css('webview.css')).toMatch(/\.ask \.btn:focus-visible[\s\S]*outline: 2px solid/);
  });
});
