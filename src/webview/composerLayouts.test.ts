// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import {
  capabilities,
  chat,
  composerLayout,
  dismissed,
  dispatchEvent,
  editor,
  extra,
  handleHostMessage,
  history,
  hudState,
  limits,
} from './store';
import { initialHud } from './hudState';
import { contextView } from './hudView';
import { initialState } from './chatState';
import * as vscode from './vscode';

const posted: unknown[] = [];

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  render(h(Composer, {}), host);
  return host;
}

const flush = () => new Promise((r) => setTimeout(r, 120));

function type(host: HTMLElement, text: string) {
  const ed = host.querySelector<HTMLElement>('.typed')!;
  ed.focus();
  ed.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  return ed;
}

function enter(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function usage(used: number) {
  dispatchEvent({ type: 'context.usage', usedTokens: used, maxTokens: 200_000, source: 'engine' });
}

function fiveHour(percent: number) {
  limits.value = {
    windows: [{ kind: 'five-hour', percent, resetsAt: Date.now() + 3_600_000 }],
    updatedAt: Date.now(),
  } as typeof limits.value;
}

beforeEach(() => {
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m));
  chat.value = { ...initialState(), project: 'p', cwd: '/p', sessionId: 's1', model: 'claude-opus-4-5' };
  composerLayout.value = 'classic';
  capabilities.value = { models: [], commands: [] };
  editor.value = {};
  extra.value = [];
  history.value = [];
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
  dismissed.value = new Set();
});

/** Ключевые элементы каждой новой раскладки (после `data-layout`). */
const KEY: Record<string, string[]> = {
  card: ['.frame .prompt', '.frame .row .plus', '.frame .row .pill.mode', '.frame .row .engine', '.frame .row .cr .ring', '.frame .row .send.go', '.under .cn', '.under .meters'],
  gauges: ['.top .bar', '.top .cn button', '.top .meters', '.prompt', '.sets .plus', '.sets .mode', '.sets .agent', '.sets .send.go'],
  statusline: ['.inp .prompt', '.sl .plus', '.sl .blk.mode', '.sl .agent', '.sl .effort', '.sl .cs .bar', '.sl .meters', '.sl .send.go'],
  shell: ['.pl .dir', '.pl .mdt.mode', '.pl .mdl .agent', '.pl .mdl .effort', '.pl .plus', '.pl .rg .bar', '.ln .prompt', '.ln .send.go'],
  minimal: ['.one .dollar', '.one .prompt', '.one .plus', '.one .engine', '.one .send.go'],
};

describe.each(['card', 'gauges', 'statusline', 'shell', 'minimal'] as const)('раскладка %s', (layout) => {
  beforeEach(() => {
    composerLayout.value = layout;
  });

  it('ключевые элементы на месте, полосы блоков нет', async () => {
    const host = mount();
    await flush();
    expect(host.querySelector('footer.compose')?.getAttribute('data-layout')).toBe(layout);
    for (const sel of KEY[layout]!) expect(host.querySelector(sel), sel).not.toBeNull();
    expect(host.querySelector('.blocks')).toBeNull();
    expect(host.querySelector('.opts')).toBeNull();
  });

  it('Enter отправляет, Shift+Enter нет; кнопка отправки тоже', async () => {
    const host = mount();
    const ed = type(host, 'привет');
    await flush();
    ed.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(posted).toHaveLength(0);
    enter(ed);
    await flush();
    expect(posted).toEqual([{ type: 'send', sessionId: 's1', text: 'привет' }]);
    type(host, 'ещё');
    await flush();
    host.querySelector<HTMLButtonElement>('.send')!.click();
    await flush();
    expect(posted).toContainEqual({ type: 'send', sessionId: 's1', text: 'ещё' });
  });

  it('в ходе — «в очередь» и стоп, клик шлёт interrupt', async () => {
    chat.value = { ...chat.value, status: 'working' };
    const host = mount();
    await flush();
    expect(host.querySelector('.send')).toBeNull();
    expect(host.querySelector('.q')?.textContent).toContain('в очередь');
    host.querySelector<HTMLButtonElement>('.stopb')!.click();
    expect(posted).toContainEqual({ type: 'interrupt', sessionId: 's1' });
  });

  it('меню режима открывается и меняет режим', async () => {
    const host = mount();
    await flush();
    host.querySelector<HTMLElement>('.mode')!.click();
    await flush();
    const items = [...host.querySelectorAll('.menu .it')];
    expect(items).toHaveLength(4);
    (items[1] as HTMLElement).click();
    expect(posted).toEqual([{ type: 'mode.set', sessionId: 's1', mode: 'acceptEdits' }]);
  });

  it('одно открытое меню на поле; Esc закрывает', async () => {
    const host = mount();
    await flush();
    host.querySelector<HTMLElement>('.mode')!.click();
    await flush();
    expect(host.querySelectorAll('.menu')).toHaveLength(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(host.querySelector('.menu')).toBeNull();
  });
});

describe('EngineMenu (card, minimal)', () => {
  it('card: «agent · model · effort» → три секции, выбор effort шлёт effort.set', async () => {
    composerLayout.value = 'card';
    chat.value = { ...chat.value, effort: 'high' };
    const host = mount();
    await flush();
    const btn = host.querySelector<HTMLElement>('.engine')!;
    expect(btn.textContent?.split(' · ')).toHaveLength(3);
    expect(btn.textContent).toMatch(/^claude · /);
    btn.click();
    await flush();
    const heads = [...host.querySelectorAll('.menu .hd')].map((x) => x.textContent);
    expect(heads).toHaveLength(3);
    expect(host.querySelectorAll('.menu .sep').length).toBeGreaterThanOrEqual(2);
    const effort = [...host.querySelectorAll<HTMLElement>('.menu .it')].find(
      (i) => i.textContent?.startsWith('low'),
    );
    expect(effort).toBeDefined();
    effort!.click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'effort.set' }));
    await flush();
    expect(host.querySelector('.menu')).toBeNull();
  });

  it('minimal: «model · effort», без агента; меню то же', async () => {
    composerLayout.value = 'minimal';
    const host = mount();
    await flush();
    const btn = host.querySelector<HTMLElement>('.engine')!;
    expect(btn.textContent?.split(' · ')).toHaveLength(2);
    btn.click();
    await flush();
    expect(host.querySelectorAll('.menu .hd')).toHaveLength(3);
  });
});

describe('minimal: правила видимости', () => {
  beforeEach(() => {
    composerLayout.value = 'minimal';
  });

  it('в норме кольца, 5ч и кэша нет; шпаргалка при пустом поле', async () => {
    usage(40_000);
    fiveHour(50);
    const host = mount();
    await flush();
    expect(host.querySelector('.cr')).toBeNull();
    expect(host.querySelector('.meters')).toBeNull();
    expect(host.querySelector('.sub .cheat')?.textContent).toContain('/ команды');
    type(host, 'текст');
    await flush();
    expect(host.querySelector('.sub .cheat')).toBeNull();
  });

  it('за порогом контекста — кольцо с %; 5ч > 70 % — «5ч N%»', async () => {
    usage(131_250);
    fiveHour(82);
    const host = mount();
    await flush();
    expect(host.querySelector('.one .cr .ring')).not.toBeNull();
    expect(host.querySelector('.one .cr .pc')?.textContent).toBe('66%');
    expect(host.querySelector('.meters.alert')?.textContent).toContain('5ч');
    expect(host.querySelector('.meters.alert')?.textContent).toContain('82%');
    expect(host.querySelector('footer')?.getAttribute('style')).toMatch(/--p: ?66/);
  });
});

describe('card и gauges: приборы', () => {
  it('card: кольцо и «контекст N / max · сжать» под рамкой', async () => {
    composerLayout.value = 'card';
    usage(131_250);
    const host = mount();
    await flush();
    expect(host.querySelector('.frame .cr .pc')?.textContent).toBe('66%');
    expect(host.querySelector('.under .cn')?.textContent).toContain('131 250');
    host.querySelector<HTMLButtonElement>('.under .cn button')!.click();
    expect(posted).toContainEqual({ type: 'compact', sessionId: 's1' });
  });

  it('gauges: полоса с засечками порогов и 131k/200k; «сжать» шлёт compact', async () => {
    composerLayout.value = 'gauges';
    usage(131_250);
    const host = mount();
    await flush();
    expect(host.querySelectorAll('.top .bar u')).toHaveLength(2);
    expect(host.querySelector('.top .cn b')?.textContent).toBe('131k/200k');
    host.querySelector<HTMLButtonElement>('.top .cn button')!.click();
    expect(posted).toContainEqual({ type: 'compact', sessionId: 's1' });
  });
});

describe('приёмка этапа 2', () => {
  it('смена раскладки с набранным текстом: текст остаётся в поле и уходит по Enter', async () => {
    const host = mount();
    type(host, 'черновик');
    await flush();
    composerLayout.value = 'card';
    await flush();
    const ed = host.querySelector<HTMLElement>('.frame .typed')!;
    expect(ed.textContent).toBe('черновик');
    composerLayout.value = 'minimal';
    await flush();
    expect(host.querySelector('.one .typed')?.textContent).toBe('черновик');
    expect(host.querySelector('.sub .cheat')).toBeNull();
    enter(host.querySelector<HTMLElement>('.typed')!);
    await flush();
    expect(posted).toEqual([{ type: 'send', sessionId: 's1', text: 'черновик' }]);
  });

  it('minimal: неделя > 70 % видна без 5ч в норме; шпаргалки нет в закрытой сессии', async () => {
    composerLayout.value = 'minimal';
    limits.value = {
      windows: [
        { kind: 'five-hour', percent: 70, resetsAt: Date.now() + 3_600_000 },
        { kind: 'weekly', percent: 91, resetsAt: Date.now() + 86_400_000 },
      ],
      updatedAt: Date.now(),
    } as typeof limits.value;
    chat.value = { ...chat.value, closed: { reason: 'exit' } };
    const host = mount();
    await flush();
    const alert = host.querySelector('.meters.alert')!;
    expect(alert.querySelectorAll('.m')).toHaveLength(1);
    expect(alert.textContent).toContain('91%');
    expect(host.querySelector('.sub .cheat')).toBeNull();
  });

  it('contextView: засечки только внутри шкалы, окно 0 — без NaN', () => {
    const v = contextView({ ...initialHud([120_000, 150_000, 0]), context: { used: 131_250, max: 200_000 } });
    expect(v.marks).toEqual([60, 75]);
    expect(v.percent).toBe(66);
    const small = contextView({ ...initialHud([120_000, 150_000]), context: { used: 50_000, max: 100_000 } });
    expect(small.marks).toEqual([]);
    const zero = contextView({ ...initialHud(), context: { used: 0, max: 0 } });
    expect([zero.percent, zero.fill]).toEqual([0, 0]);
  });
});

describe('statusline и shell', () => {
  function withEditor(path = 'src/Counter.tsx') {
    handleHostMessage({
      type: 'editor.context',
      file: { path, name: 'Counter.tsx' },
      selection: { path, name: 'Counter.tsx', startLine: 12, endLine: 40 },
    });
  }

  it('statusline: автоконтекст — @файл:строки перед полем, ✕ снимает; кромка — заполнение контекста', async () => {
    composerLayout.value = 'statusline';
    usage(131_250);
    withEditor();
    const host = mount();
    await flush();
    const refs = [...host.querySelectorAll('.inp .chips .auto')].map((c) => c.textContent);
    expect(refs).toEqual(['@Counter.tsx✕', '@Counter.tsx:12–40✕']);
    expect(host.querySelector('.inp .chips')!.compareDocumentPosition(host.querySelector('.typed')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(host.querySelector('footer')?.getAttribute('style')).toMatch(/--p: ?66/);
    host.querySelector<HTMLElement>('.inp .auto .x')!.click();
    await flush();
    expect(host.querySelectorAll('.inp .auto')).toHaveLength(1);
  });

  it('statusline: ctx 131k/200k, «сжать» — только вне зоны ok и шлёт compact', async () => {
    composerLayout.value = 'statusline';
    usage(40_000);
    const host = mount();
    await flush();
    expect(host.querySelector('.sl .cs b')?.textContent).toBe('40k/200k');
    expect(host.querySelector('.sl .cs button')).toBeNull();
    usage(131_250);
    await flush();
    expect(host.querySelector('.sl .cs b')?.textContent).toBe('131k/200k');
    host.querySelector<HTMLButtonElement>('.sl .cs button')!.click();
    expect(posted).toContainEqual({ type: 'compact', sessionId: 's1' });
  });

  it('statusline: сегмент режима открывает меню режима, agent — своё меню', async () => {
    composerLayout.value = 'statusline';
    const host = mount();
    await flush();
    host.querySelector<HTMLElement>('.sl .blk')!.click();
    await flush();
    expect(host.querySelectorAll('.menu .it')).toHaveLength(4);
    host.querySelector<HTMLElement>('.sl .agent')!.click();
    await flush();
    expect(host.querySelectorAll('.menu')).toHaveLength(1);
    expect(host.querySelector('.sl .agent')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.sl .blk')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('statusline и shell: пока идёт сжатие — крутилка, кнопки «сжать» нет', async () => {
    usage(131_250);
    hudState.value = { ...hudState.value, compacting: true };
    composerLayout.value = 'statusline';
    const host = mount();
    await flush();
    expect(host.querySelector('.sl .cs .spin')).not.toBeNull();
    expect(host.querySelector('.sl .cs button')).toBeNull();
    composerLayout.value = 'shell';
    await flush();
    expect(host.querySelector('.pl .rg .cs .spin')).not.toBeNull();
  });

  it('statusline: вручную добавленный файл — ✕ убирает его из extra', async () => {
    composerLayout.value = 'statusline';
    extra.value = [{ kind: 'file', path: 'src/a.ts' }] as typeof extra.value;
    const host = mount();
    await flush();
    expect(host.querySelector('.inp .chips .man')?.textContent).toBe('@a.ts✕');
    host.querySelector<HTMLElement>('.inp .man .x')!.click();
    await flush();
    expect(extra.value).toHaveLength(0);
  });

  it('shell: проект, + файл:строки, ❯-строка; процент контекста', async () => {
    composerLayout.value = 'shell';
    usage(131_250);
    withEditor();
    const host = mount();
    await flush();
    expect(host.querySelector('.pl .dir')?.textContent).toBe('p');
    const refs = [...host.querySelectorAll('.chips.refs .auto')].map((c) => c.textContent);
    expect(refs).toEqual(['+Counter.tsx✕', '+Counter.tsx:12–40✕']);
    expect(host.querySelector('.pl .rg .pc')?.textContent).toBe('66%');
    expect(host.querySelectorAll('.pl .rg .bar u')).toHaveLength(2);
  });

  it('shell: без проекта нет пустого .dir и лишней «·» перед режимом', async () => {
    handleHostMessage({ type: 'chat.info', project: '', cwd: '', allowBypass: false, composerLayout: 'shell' });
    const host = mount();
    await flush();
    expect(host.querySelector('.pl .dir')).toBeNull();
    expect(host.querySelector('.pl')!.firstElementChild?.querySelector('.mode')).not.toBeNull();
  });

  it('shell: agent, model и effort — каждый открывает своё меню; effort шлёт effort.set', async () => {
    composerLayout.value = 'shell';
    const host = mount();
    await flush();
    host.querySelector<HTMLElement>('.pl .mdl .effort')!.click();
    await flush();
    expect(host.querySelectorAll('.menu')).toHaveLength(1);
    const low = [...host.querySelectorAll<HTMLElement>('.menu .it')].find((i) =>
      i.textContent?.startsWith('low'),
    );
    low!.click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'effort.set' }));
  });
});
