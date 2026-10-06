// @vitest-environment jsdom
/**
 * Roadmap 15, этап 3: интерфейс по флагам движка (`chat.info.features`). Codex — без режимов, приборов, `/compact`,
 * вкладки «агенты» и файлов; Claude — как раньше; выбор движка — только в пустой вкладке.
 */
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerFeatures } from '../agent/features';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import {
  addFiles,
  capabilities,
  chat,
  composerLayout,
  dispatchEvent,
  draftFiles,
  features,
  handleHostMessage,
  history,
  hudState,
  limitBlocked,
  limits,
  provider,
  tick,
} from './store';
import { initialHud } from './hudState';
import { initialState } from './chatState';
import * as vscode from './vscode';
import type { ComposerLayout } from '../settings';

const posted: unknown[] = [];

function mount(component: typeof Composer | typeof Chat = Composer) {
  const host = document.createElement('div');
  document.body.append(host);
  render(h(component, {}), host);
  return host;
}

const flush = () => new Promise((r) => setTimeout(r, 120));

function info(p: 'claude' | 'codex' | 'antigravity' | undefined, extra: Record<string, unknown> = {}) {
  handleHostMessage({
    type: 'chat.info',
    project: 'p',
    cwd: '/p',
    allowBypass: false,
    // chat.info без раскладки сбрасывает её на classic: сохранить выбранную тестом
    composerLayout: composerLayout.value,
    ...(p ? { provider: p, features: providerFeatures(p) } : {}),
    ...extra,
  } as never);
}

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

const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );

beforeEach(() => {
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m));
  chat.value = { ...initialState(), project: 'p', cwd: '/p' };
  composerLayout.value = 'classic';
  capabilities.value = { models: [], commands: [] };
  history.value = [];
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
  draftFiles.value = [];
  provider.value = 'claude';
  features.value = providerFeatures('claude');
});

describe('chat.info: движок и флаги', () => {
  it('нет полей (старое сообщение) — Claude со всеми возможностями', () => {
    provider.value = 'codex';
    features.value = providerFeatures('codex');
    info(undefined);
    expect(provider.value).toBe('claude');
    expect(features.value).toEqual(providerFeatures('claude'));
  });

  it('Codex: движок и флаги из сообщения; смена движка сбрасывает список моделей', () => {
    capabilities.value = { models: [{ value: 'opus', displayName: 'Opus' }], commands: [] };
    info('codex');
    expect(provider.value).toBe('codex');
    expect(features.value).toMatchObject({
      modes: false,
      compact: false,
      metrics: false,
      subagents: false,
      files: false,
      images: true,
    });
    expect(capabilities.value.models).toEqual([]);
  });

  it('тот же движок — список моделей не трогается (chat.info приходит и при смене настроек)', () => {
    info('codex');
    capabilities.value = { models: [{ value: 'gpt', displayName: 'GPT' }], commands: [] };
    info('codex');
    expect(capabilities.value.models).toHaveLength(1);
  });

  it('лимит подписки Claude не блокирует отправку в Codex-вкладке', () => {
    limits.value = {
      windows: [{ kind: 'five-hour', percent: 100, resetsAt: Date.now() + 3_600_000 }],
      updatedAt: Date.now(),
    } as typeof limits.value;
    tick.value = Date.now();
    expect(limitBlocked.value).toBeDefined();
    info('codex');
    expect(limitBlocked.value).toBeUndefined();
  });

  it('файлы в Codex-вкладке — красная плашка «агент не принимает», а не молча потерянный файл', () => {
    info('codex');
    addFiles([{ name: 'a.txt', path: 'a.txt', kind: 'text', data: 'hi', size: 2 }]);
    expect(draftFiles.value).toHaveLength(1);
    expect(draftFiles.value[0]).toMatchObject({ name: 'a.txt', problem: 'engine' });
    expect(draftFiles.value[0]!.file).toBeUndefined();
    info('claude');
    draftFiles.value = [];
    addFiles([{ name: 'a.txt', path: 'a.txt', kind: 'text', data: 'hi', size: 2 }]);
    expect(draftFiles.value[0]!.file).toBeDefined();
  });

  it('файл, прикреплённый до смены движка на Codex, становится красной плашкой', () => {
    info('claude');
    draftFiles.value = [];
    addFiles([{ name: 'a.txt', path: 'a.txt', kind: 'text', data: 'hi', size: 2 }]);
    expect(draftFiles.value[0]!.file).toBeDefined();
    info('codex');
    expect(draftFiles.value).toHaveLength(1);
    expect(draftFiles.value[0]).toMatchObject({ name: 'a.txt', problem: 'engine' });
    expect(draftFiles.value[0]!.file).toBeUndefined();
    draftFiles.value = [];
  });
});

const MODE_SEL = '.mode, .dollar, .blk, .mdt';
const GAUGE_SEL = '.meters, .cr, .cn, .cs, .ring, .bar';

describe.each<ComposerLayout>(['classic', 'card', 'gauges', 'statusline', 'minimal', 'shell'])(
  'раскладка %s: Codex',
  (layout) => {
    beforeEach(() => {
      composerLayout.value = layout;
    });

    it('нет режимов и приборов (контекст, кэш, лимиты), движок назван codex', async () => {
      info('codex');
      handleHostMessage({
        type: 'agent.event',
        sessionId: 's',
        event: { type: 'context.usage', usedTokens: 190_000, maxTokens: 200_000, source: 'engine' },
      } as never);
      limits.value = {
        windows: [{ kind: 'five-hour', percent: 95, resetsAt: Date.now() + 3_600_000 }],
        updatedAt: Date.now(),
      } as typeof limits.value;
      const host = mount();
      await flush();
      expect(host.querySelector(MODE_SEL)).toBeNull();
      expect(host.querySelector(GAUGE_SEL)).toBeNull();
      // в `minimal` имя агента на кнопке не показывается (только «модель · effort»)
      if (layout !== 'minimal') {
        expect(host.textContent).not.toContain('claude');
        expect(host.textContent).toContain('codex');
      }
    });

    it('Claude: режим и приборы на месте (контрольный)', async () => {
      info('claude');
      const host = mount();
      await flush();
      expect(host.querySelector(MODE_SEL), layout).not.toBeNull();
      if (layout !== 'minimal') expect(host.querySelector(GAUGE_SEL), layout).not.toBeNull();
      if (layout !== 'minimal') expect(host.textContent).toContain('claude');
    });
  },
);

describe('Composer: Codex', () => {
  it('меню «/»: только /clear и /status, без /plan и /compact', async () => {
    info('codex');
    const host = mount();
    const ed = type(host, '/');
    await flush();
    const items = [...host.querySelectorAll('.menu .it')].map((i) => i.textContent ?? '');
    expect(items.some((t) => t.startsWith('/clear'))).toBe(true);
    expect(items.some((t) => t.startsWith('/status'))).toBe(true);
    expect(items.some((t) => t.startsWith('/plan'))).toBe(false);
    expect(items.some((t) => t.startsWith('/compact'))).toBe(false);
    ed.blur();
  });

  it('Claude: /plan и /compact в меню как раньше', async () => {
    const host = mount();
    type(host, '/');
    await flush();
    const items = [...host.querySelectorAll('.menu .it')].map((i) => i.textContent ?? '');
    expect(items.some((t) => t.startsWith('/plan'))).toBe(true);
    expect(items.some((t) => t.startsWith('/compact'))).toBe(true);
  });

  it('/compact вручную: движку не уходит, в ленте — «недоступна для этого агента»', async () => {
    info('codex');
    const host = mount();
    const ed = type(host, '/compact');
    await flush();
    key(ed, 'Escape');
    key(ed, 'Enter');
    await flush();
    expect(
      posted.filter(
        (m) =>
          (m as { type: string }).type === 'compact' || (m as { type: string }).type === 'send',
      ),
    ).toEqual([]);
    expect(JSON.stringify(chat.value.rows)).toContain('/compact');
  });

  it('Shift+Tab режим не переключает', async () => {
    info('codex');
    const host = mount();
    const ed = type(host, '');
    key(ed, 'Tab', { shiftKey: true });
    expect(posted.some((m) => (m as { type: string }).type === 'mode.set')).toBe(false);
  });

  it('до model/list запасной список моделей Claude не показывается', async () => {
    composerLayout.value = 'gauges';
    info('codex');
    const host = mount();
    await flush();
    const model = [...host.querySelectorAll<HTMLElement>('.sets button')].find(
      (b) => b.textContent === '—',
    );
    expect(model).toBeDefined();
    model!.click();
    await flush();
    expect(host.querySelector('.menu')).not.toBeNull();
    const all = [...host.querySelectorAll('.menu .it')].map((i) => i.textContent ?? '').join('|');
    expect(all).not.toMatch(/opus|sonnet|haiku/i);
  });

  it('«+»: пункт картинки без «файл», «текст, pdf» не обещается', async () => {
    info('codex');
    const host = mount();
    await flush();
    host.querySelector<HTMLElement>('button.plus')!.click();
    await flush();
    const txt = host.querySelector('.menu')!.textContent ?? '';
    expect(txt).toContain('Изображение…');
    expect(txt).not.toContain('pdf,');
  });
});

describe('Выбор движка', () => {
  function openAgentMenu(host: HTMLElement) {
    host.querySelector<HTMLElement>('button.agent')!.click();
    return flush();
  }
  const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.menu .it')];

  beforeEach(() => {
    composerLayout.value = 'gauges';
  });

  it('пустая вкладка: Codex и Antigravity выбираются, шлётся engine.set; «скоро» нет ни у кого', async () => {
    info('claude');
    const host = mount();
    await flush();
    await openAgentMenu(host);
    const codex = items(host).find((i) => i.textContent?.startsWith('Codex'))!;
    expect(codex.textContent).not.toMatch(/скоро|soon/);
    expect(codex.getAttribute('aria-disabled')).toBeNull();
    const agy = items(host).find((i) => i.textContent?.startsWith('Antigravity'))!;
    expect(agy.textContent).not.toMatch(/скоро|soon/);
    expect(agy.getAttribute('aria-disabled')).toBeNull();
    expect(items(host).some((i) => i.textContent?.startsWith('Gemini'))).toBe(false);
    codex.click();
    expect(posted).toContainEqual({ type: 'engine.set', provider: 'codex' });
  });

  it('пустая вкладка: пункт Antigravity шлёт engine.set', async () => {
    info('claude');
    const host = mount();
    await flush();
    await openAgentMenu(host);
    items(host)
      .find((i) => i.textContent?.startsWith('Antigravity'))!
      .click();
    expect(posted).toContainEqual({ type: 'engine.set', provider: 'antigravity' });
  });

  it('после session.init (есть id) — только показ: другой движок недоступен, engine.set не шлётся', async () => {
    info('codex');
    chat.value = { ...chat.value, sessionId: 'thr-1' };
    const host = mount();
    await flush();
    await openAgentMenu(host);
    const claude = items(host).find((i) => i.textContent?.startsWith('Claude'))!;
    expect(claude.getAttribute('aria-disabled')).toBe('true');
    claude.click();
    expect(posted.some((m) => (m as { type: string }).type === 'engine.set')).toBe(false);
    expect(items(host).find((i) => i.textContent?.startsWith('Codex'))?.className).toContain('sel');
  });

  it('после первого сообщения (id ещё нет) выбор тоже закрыт', async () => {
    info('claude');
    chat.value = {
      ...chat.value,
      rows: [{ id: 1, kind: 'user', text: 'привет', at: '10:00' } as never],
    };
    const host = mount();
    await flush();
    await openAgentMenu(host);
    const codex = items(host).find((i) => i.textContent?.startsWith('Codex'))!;
    expect(codex.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Chat: вкладка «агенты»', () => {
  it('Codex: вкладки «агенты» нет ни в шапке, ни в панели, ни на рейке; Claude — есть', async () => {
    chat.value = {
      ...chat.value,
      sessionId: 's',
      rows: [{ id: 1, kind: 'user', text: 'x', at: '10:00' } as never],
    };
    info('claude');
    const host = mount(Chat);
    await flush();
    expect(host.querySelector('#tab-agents')).not.toBeNull();
    expect(host.querySelector('#ptab-agents')).not.toBeNull();
    info('codex');
    await flush();
    expect(host.querySelector('#tab-agents')).toBeNull();
    expect(host.querySelector('#ptab-agents')).toBeNull();
    expect(
      host.querySelector('.rail button[aria-label*="gent"], .rail button[aria-label*="гент"]'),
    ).toBeNull();
  });
});

describe('Antigravity: карточка отказа', () => {
  const result = (denials: { toolName: string; toolUseId: string }[]) =>
    ({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 10,
      apiDurationMs: 5,
      numTurns: 1,
      totalCostUsd: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      permissionDenials: denials,
    }) as never;
  const buttons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.ask .acts button')];

  async function ask(denials: { toolName: string; toolUseId: string }[], over: Record<string, unknown> = {}) {
    chat.value = {
      ...chat.value,
      sessionId: 'c1',
      rows: [{ id: 1, kind: 'user', text: 'создай файл', at: '10:00' } as never],
      nextId: 2,
    };
    info('antigravity', { mode: 'default', ...over });
    dispatchEvent(result(denials));
    const host = mount(Chat);
    await flush();
    return host;
  }

  it('Write отклонён: «правки» и «всё»; нажатие шлёт agy.retry и гасит карточку', async () => {
    const host = await ask([{ toolName: 'Write', toolUseId: 'u1' }], { allowBypass: true });
    expect(host.querySelector('.ask .h')?.textContent).toContain('agy');
    const [edits, all] = buttons(host);
    expect(edits!.textContent).toMatch(/правки|edits/i);
    expect(all!.disabled).toBe(false);
    edits!.click();
    expect(posted).toContainEqual({ type: 'agy.retry', sessionId: 'c1', mode: 'acceptEdits' });
    await flush();
    expect(buttons(host)).toHaveLength(0);
  });

  it('Bash отклонён: только «всё»; без allowBypass кнопка выключена', async () => {
    const host = await ask([{ toolName: 'Bash', toolUseId: 'u1' }]);
    const bs = buttons(host);
    expect(bs).toHaveLength(1);
    expect(bs[0]!.disabled).toBe(true);
    expect(host.querySelector('.ask .bd')?.textContent).toContain('allowBypassPermissions');
  });

  it('Claude и Codex карточку не получают; в режиме «всё разрешено» — тоже', async () => {
    for (const p of ['claude', 'codex'] as const) {
      chat.value = { ...chat.value, rows: [], nextId: 1 };
      info(p);
      dispatchEvent(result([{ toolName: 'Write', toolUseId: 'u' }]));
      expect(chat.value.rows.some((r) => r.kind === 'refusal')).toBe(false);
    }
    chat.value = { ...chat.value, rows: [], nextId: 1 };
    info('antigravity');
    chat.value = { ...chat.value, mode: 'bypassPermissions' };
    dispatchEvent(result([{ toolName: 'Write', toolUseId: 'u' }]));
    expect(chat.value.rows.some((r) => r.kind === 'refusal')).toBe(false);
  });

  it('следующий ход (в т.ч. доставленное из очереди сообщение со старым id) закрывает карточку', async () => {
    const host = await ask([{ toolName: 'Write', toolUseId: 'u1' }], { allowBypass: true });
    expect(buttons(host).length).toBeGreaterThan(0);
    dispatchEvent({ type: 'turn.start', at: 1 } as never);
    await flush();
    expect(buttons(host)).toHaveLength(0);
    expect(host.querySelector('.ask .acts')?.textContent).toBe('');
  });

  it('хост повтор не принял: «повторяю…» снимается, кнопки возвращаются, в ленте причина', async () => {
    const host = await ask([{ toolName: 'Write', toolUseId: 'u1' }], { allowBypass: true });
    buttons(host)[0]!.click();
    await flush();
    expect(buttons(host)).toHaveLength(0);
    handleHostMessage({ type: 'agy.retryRejected' });
    await flush();
    expect(buttons(host).length).toBeGreaterThan(0);
    expect(chat.value.rows.at(-1)).toMatchObject({ kind: 'sys', tone: 'bad' });
  });

  it('неопознанное имя инструмента agy — как команда: только «всё»', async () => {
    const host = await ask([{ toolName: 'run_command', toolUseId: 'u1' }], { allowBypass: true });
    const bs = buttons(host);
    expect(bs).toHaveLength(1);
    expect(bs[0]!.disabled).toBe(false);
    expect(host.querySelector('.ask .h')?.textContent).toMatch(/команда|command/);
  });

  it('прерванный ход (Stop) карточку не даёт', () => {
    chat.value = { ...chat.value, rows: [], nextId: 1 };
    info('antigravity');
    dispatchEvent({ ...(result([{ toolName: 'Write', toolUseId: 'u' }]) as object), interrupted: true } as never);
    expect(chat.value.rows.some((r) => r.kind === 'refusal')).toBe(false);
  });

  it('новое сообщение пользователя после отказа — кнопки старой карточки пропадают', async () => {
    const host = await ask([{ toolName: 'Write', toolUseId: 'u1' }], { allowBypass: true });
    expect(buttons(host).length).toBeGreaterThan(0);
    chat.value = {
      ...chat.value,
      rows: [...chat.value.rows, { id: 99, kind: 'user', text: 'ещё', at: '10:01' } as never],
    };
    await flush();
    expect(buttons(host)).toHaveLength(0);
  });
});
