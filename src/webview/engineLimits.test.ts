// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineLimitsSummary, ToWebview } from '../protocol';
import type { SidebarLimitsMode, SidebarTopMode } from '../settings';
import { Sidebar } from './components/Sidebar';
import { resetEngineLimitsState } from './components/EngineLimits';
import * as vscode from './vscode';

const posted: Record<string, unknown>[] = [];
const mounted: HTMLElement[] = [];
const flush = () => new Promise((r) => setTimeout(r, 30));
const msg = (m: ToWebview) => window.dispatchEvent(new MessageEvent('message', { data: m }));

const soon = Date.now() + 2 * 3600_000;
const codex = (over: Partial<EngineLimitsSummary> = {}): EngineLimitsSummary => ({
  engine: 'codex',
  state: 'ok',
  email: 'x@y.z',
  plan: 'Plus',
  version: 'codex 0.160.0',
  windows: [
    { kind: 'fiveHour', percent: 78, resetsAt: soon },
    { kind: 'weekly', percent: 41, resetsAt: soon + 86_400_000 },
  ],
  updatedAt: Date.now(),
  ...over,
});
const agy = (over: Partial<EngineLimitsSummary> = {}): EngineLimitsSummary => ({
  engine: 'antigravity',
  state: 'ok',
  version: 'agy 1.4',
  windows: [
    { kind: 'model', name: 'Gemini', percent: 23, resetsAt: soon },
    { kind: 'model', name: 'Claude/GPT', percent: 91, resetsAt: soon },
  ],
  updatedAt: Date.now(),
  ...over,
});

interface Setup {
  limits?: SidebarLimitsMode;
  top?: SidebarTopMode;
  engines?: EngineLimitsSummary[];
  provider?: 'claude' | 'codex' | 'antigravity';
}

async function mount(o: Setup = {}) {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Sidebar as never, {}), host);
  await flush();
  msg({ type: 'account.info', email: 'a@b.c', plan: 'Max 5×', login: 'ok', engine: '2.1.285' });
  msg({
    type: 'limits.update',
    updatedAt: Date.now(),
    windows: [
      { kind: 'five-hour', percent: 62, resetsAt: soon },
      { kind: 'weekly', percent: 34, resetsAt: soon + 86_400_000 },
      { kind: 'weekly-model', model: 'Fable', percent: 8, resetsAt: soon + 86_400_000 },
    ],
  });
  msg({
    type: 'sidebar.view',
    view: 'compact',
    context: true,
    time: true,
    top: o.top ?? 'compact',
    limits: o.limits ?? 'stack',
  });
  msg({ type: 'engines.limits', engines: o.engines ?? [codex(), agy()] });
  msg({
    type: 'sessions.update',
    sessions: [],
    project: 'p',
    ...(o.provider ? { currentProvider: o.provider } : {}),
  });
  await flush();
  return host;
}

const q = (host: HTMLElement, sel: string) => host.querySelector<HTMLElement>(sel)!;
const qa = (host: HTMLElement, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  resetEngineLimitsState();
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('лимиты нескольких движков в боковой панели', () => {
  it('один Claude (codex/agy не установлены) — прежняя разметка при любом значении настройки', async () => {
    for (const limits of ['stack', 'switch', 'table', 'active', 'header'] as const) {
      const host = await mount({
        limits,
        engines: [codex({ state: 'missing', windows: [] }), agy({ state: 'missing', windows: [] })],
      });
      expect(q(host, '.sec.acc.multi')).toBeNull();
      expect(q(host, '.sec.acc .kv')).not.toBeNull();
      expect(qa(host, '.sec.acc .lim .row').length).toBe(3);
      expect(q(host, '.hx')).toBeNull();
      render(null, host);
    }
  });

  it('A stack: блок на движок, метка «вкладка» у текущего, аккаунт и окна', async () => {
    const host = await mount({ limits: 'stack', provider: 'codex' });
    expect(q(host, 'h3').textContent).toContain('Аккаунты и лимиты');
    const engs = qa(host, '.sec.acc .eng');
    expect(engs.map((e) => e.getAttribute('data-engine'))).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);
    expect(qa(host, '.sec.acc .mk').map((e) => e.textContent)).toEqual(['C', 'X', 'G']);
    expect(engs[1]!.querySelector('.now')?.textContent).toBe('вкладка');
    expect(host.querySelectorAll('.sec.acc .now').length).toBe(1);
    expect(engs[1]!.querySelector('.eh span')?.textContent).toBe('x@y.z · Plus');
    expect(engs[1]!.querySelector('.eh')?.getAttribute('data-tip')).toContain('codex 0.160.0');
    expect(engs[1]!.querySelectorAll('.L').length).toBe(2);
    expect(engs[2]!.querySelectorAll('.L').length).toBe(2);
    expect(engs[0]!.querySelectorAll('.L').length).toBe(3);
    expect(engs[1]!.querySelector('.L.lim-warn .n')?.textContent).toBe('78 %');
    expect(engs[2]!.querySelector('.L.lim-full .n')?.textContent).toBe('91 %');
    expect(q(host, '.sec.acc .kv')).toBeNull();
  });

  it('B switch: сегменты, по умолчанию выбран движок вкладки, клик выбирает руками до смены вкладки', async () => {
    const host = await mount({ limits: 'switch', provider: 'codex' });
    expect(q(host, 'h3').textContent).toContain('Аккаунт и лимиты');
    const sel = () =>
      qa(host, '.seg [role="tab"]')
        .filter((b) => b.getAttribute('aria-selected') === 'true')
        .map((b) => b.getAttribute('data-engine'));
    expect(qa(host, '.seg [role="tab"]').length).toBe(3);
    expect(sel()).toEqual(['codex']);
    expect(q(host, '.who b')?.textContent).toBe('x@y.z');
    expect(qa(host, '.lims .L').length).toBe(2);
    // точка худшего лимита: у Antigravity 91 % — красная
    expect(q(host, '.seg [data-engine="antigravity"]').classList.contains('lim-full')).toBe(true);
    q(host, '.seg [data-engine="antigravity"]').click();
    await flush();
    expect(sel()).toEqual(['antigravity']);
    q(host, '.seg [data-engine="claude"]').click();
    await flush();
    expect(sel()).toEqual(['claude']);
    expect(q(host, '.who b')?.textContent).toBe('a@b.c');
    expect(qa(host, '.lims .L').length).toBe(3);
    // сменился движок вкладки — ручной выбор сброшен
    msg({ type: 'sessions.update', sessions: [], project: 'p', currentProvider: 'antigravity' });
    await flush();
    expect(sel()).toEqual(['antigravity']);
  });

  it('C table: строка на движок, до трёх ячеек, пустые — «—», Antigr., сброс в data-tip', async () => {
    const host = await mount({ limits: 'table' });
    expect(q(host, 'h3').textContent).toContain('Лимиты');
    expect(qa(host, '.grid .nm').map((e) => e.textContent)).toEqual([
      'C' + 'Claude',
      'XCodex',
      'GAntigr.',
    ]);
    expect(qa(host, '.grid .c').length).toBe(9);
    expect(qa(host, '.grid .c.none').length).toBe(2); // Codex и Antigravity — по два окна
    expect(qa(host, '.grid .c em').map((e) => e.textContent)).toEqual([
      '5 ч',
      'нед',
      'Fable',
      '5 ч',
      'нед',
      'Gemini',
      'Claude/GPT',
    ]);
    expect(q(host, '.grid .c.lim-warn')?.getAttribute('data-tip')).toContain('сброс');
    expect(q(host, '.grid .c.lim-warn .n')?.textContent).toBe('78%');
  });

  it('D active: текущий раскрыт, остальные строкой с худшим окном, клик раскрывает другой', async () => {
    const host = await mount({ limits: 'active', provider: 'codex' });
    expect(q(host, '.exp')?.getAttribute('data-engine')).toBe('codex');
    expect(q(host, '.exp .one.hd .acc')?.textContent).toContain('x@y.z · Plus');
    expect(qa(host, '.exp .L').length).toBe(2);
    const rest = qa(host, '.one[role="button"]');
    expect(rest.map((r) => r.getAttribute('data-engine'))).toEqual(['claude', 'antigravity']);
    expect(rest[1]!.querySelector('.n')?.textContent).toBe('91 %'); // худший у Antigravity
    expect(rest[1]!.classList.contains('lim-full')).toBe(true);
    rest[1]!.click();
    await flush();
    expect(q(host, '.exp')?.getAttribute('data-engine')).toBe('antigravity');
    expect(host.querySelectorAll('.exp').length).toBe(1); // раскрыт всегда один
    expect(qa(host, '.one[role="button"]').map((r) => r.getAttribute('data-engine'))).toEqual([
      'claude',
      'codex',
    ]);
    // сменилась вкладка — раскрыт текущий
    msg({ type: 'sessions.update', sessions: [], project: 'p', currentProvider: 'claude' });
    await flush();
    expect(q(host, '.exp')?.getAttribute('data-engine')).toBe('claude');
  });

  it('E header: мини-шкалы в заголовке, секции нет, всплывашка по клику, закрытие Esc / мимо / повтор', async () => {
    const host = await mount({ limits: 'header' });
    expect(q(host, '.sec.acc')).toBeNull();
    expect(qa(host, '.head .hx .m').map((m) => m.querySelector('.n')?.textContent)).toEqual([
      '62',
      '78',
      '91',
    ]);
    expect(q(host, '.head .hx .m.lim-full')?.getAttribute('data-engine')).toBe('antigravity');
    expect(q(host, '.pop')).toBeNull();
    q(host, '.hx .mm').click();
    await flush();
    expect(qa(host, '.pop .eng').length).toBe(3);
    expect(q(host, '.pop .now')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(q(host, '.pop')).toBeNull();
    q(host, '.hx .mm').click();
    await flush();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flush();
    expect(q(host, '.pop')).toBeNull();
    q(host, '.hx .mm').click();
    await flush();
    expect(q(host, '.pop')).not.toBeNull();
    q(host, '.hx .mm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    q(host, '.hx .mm').click();
    await flush();
    expect(q(host, '.pop')).toBeNull();
    // ↻ в заголовке просит обновить лимиты
    q(host, '.hx .refresh').click();
    expect(posted).toContainEqual({ type: 'limits.refresh' });
  });

  it('top=dense при ≥ 2 движках рисует вариант header независимо от настройки', async () => {
    const host = await mount({ limits: 'table', top: 'dense' });
    expect(q(host, '.head .hx')).not.toBeNull();
    expect(q(host, '.sec.acc')).toBeNull();
    expect(q(host, '.head .hl')).toBeNull();
  });

  it('signedOut: «не вошли · войти» шлёт engine.login; loading — «обновляется…»; error — текст в data-tip', async () => {
    const host = await mount({
      limits: 'stack',
      engines: [
        codex({ state: 'signedOut', windows: [], email: undefined, plan: undefined }),
        agy({ state: 'loading', windows: [] }),
      ],
    });
    const cx = q(host, '.eng[data-engine="codex"]');
    expect(cx.querySelector('.eh')?.textContent).toContain('не вошли');
    expect(cx.querySelector('.L')).toBeNull();
    cx.querySelector<HTMLElement>('.signin')!.click();
    expect(posted).toContainEqual({ type: 'engine.login', engine: 'codex' });
    expect(q(host, '.eng[data-engine="antigravity"] .wait')?.textContent).toBe('обновляется…');
    msg({
      type: 'engines.limits',
      engines: [
        codex({ state: 'error', error: 'timeout' }),
        agy({ state: 'missing', windows: [] }),
      ],
    });
    await flush();
    expect(q(host, '.eng[data-engine="codex"] .eh')?.getAttribute('data-tip')).toContain('timeout');
    expect(qa(host, '.eng[data-engine="codex"] .L').length).toBe(2); // последние известные окна
    expect(host.querySelectorAll('.eng[data-engine="antigravity"]').length).toBe(0);
  });

  it('signedOut в таблице и в D', async () => {
    const host = await mount({
      limits: 'table',
      engines: [codex({ state: 'signedOut', windows: [] }), agy({ state: 'loading', windows: [] })],
    });
    expect(q(host, '.grid .off .signin')).not.toBeNull();
    expect(qa(host, '.grid .c.none').length).toBe(3); // у Antigravity (loading) три «—»; у Codex — «не вошли»
    msg({
      type: 'sidebar.view',
      view: 'compact',
      context: true,
      time: true,
      top: 'compact',
      limits: 'active',
    });
    await flush();
    expect(q(host, '.one[data-engine="codex"] .signin')).not.toBeNull();
    expect(q(host, '.one[data-engine="antigravity"] .wait')?.textContent).toBe('обновляется…');
  });
});
