// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineLimitsSummary, ToWebview } from '../protocol';
import type { SidebarLimitsMode } from '../settings';
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
  top?: string;
  engines?: EngineLimitsSummary[];
  provider?: 'claude' | 'codex' | 'antigravity' | 'kimi';
  hidden?: ('claude' | 'codex' | 'antigravity' | 'kimi')[];
}

async function mount(o: Setup = {}) {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  await act(() => render(h(Sidebar as never, {}), host));
  await act(() => {
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
      limits: o.limits ?? 'tabs',
      ...(o.hidden ? { hidden: o.hidden } : {}),
    });
    msg({ type: 'engines.limits', engines: o.engines ?? [codex(), agy()] });
    msg({
      type: 'sessions.update',
      sessions: [],
      project: 'p',
      ...(o.provider ? { currentProvider: o.provider } : {}),
    });
  });
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

describe('блок «Лимиты» в боковой панели (roadmap 42, этап 2)', () => {
  it('одиночный движок (Claude): компактная карточка .panel-body без полосы переключения', async () => {
    const host = await mount({
      engines: [codex({ state: 'missing', windows: [] }), agy({ state: 'missing', windows: [] })],
    });
    expect(q(host, 'h3').textContent).toContain('Лимиты');
    expect(q(host, '.eng-tabs')).toBeNull();
    expect(q(host, '.radar-grid')).toBeNull();
    expect(q(host, '.acc-list')).toBeNull();
    expect(q(host, '.hx')).toBeNull();
    expect(q(host, '.head')).toBeNull();

    const panel = q(host, '.sec.acc .panel-body');
    expect(panel).not.toBeNull();
    expect(panel.querySelector('.acc-id')?.textContent).toBe('a@b.c');
    expect(panel.querySelector('.plan-chip')?.textContent).toBe('Max 5×');
    expect(panel.querySelector('.ver-txt')?.textContent).toBe('Claude 2.1.285');

    const rows = qa(panel, '.g-row');
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.querySelector('.g-lbl')?.textContent)).toEqual([
      'Окно 5 часов',
      'Неделя',
      'Неделя · Fable',
    ]);
    expect(rows.map((r) => r.querySelector('.g-pct')?.textContent)).toEqual(['62%', '34%', '8%']);
  });

  it('A tabs: адаптивные вкладки, активная по currentProvider, BrandIcon, индикаторы .st-pip', async () => {
    const host = await mount({ limits: 'tabs', provider: 'codex' });
    expect(q(host, 'h3').textContent).toContain('Лимиты');

    const tabs = qa(host, '.eng-tabs [role="tab"]');
    expect(tabs.length).toBe(3);
    expect(tabs.map((t) => t.getAttribute('data-eng'))).toEqual(['claude', 'codex', 'antigravity']);
    expect(tabs.map((t) => t.querySelector('.tab-lbl')?.textContent)).toEqual([
      'Claude',
      'Codex',
      'Antigravity',
    ]);

    // Логотипы движков BrandIcon
    expect(tabs[0]!.querySelector('.brand')?.className).toContain('brand-claude');
    expect(tabs[1]!.querySelector('.brand')?.className).toContain('brand-codex');
    expect(tabs[2]!.querySelector('.brand')?.className).toContain('brand-antigravity');

    // Активная вкладка — Codex (currentProvider)
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.tabIndex).toBe(0);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[0]!.tabIndex).toBe(-1);

    // Точки .st-pip (dark cockpit: ok скрыта, warn при >=70%, hot при >=85%)
    expect(tabs[0]!.querySelector('.st-pip')?.className).toContain('ok');
    expect(tabs[1]!.querySelector('.st-pip')?.className).toContain('warn');
    expect(tabs[2]!.querySelector('.st-pip')?.className).toContain('hot');

    // Панели вкладок
    const activePanel = q(host, '.eng-panels [role="tabpanel"]:not([hidden])');
    expect(activePanel.getAttribute('data-panel')).toBe('codex');
    expect(activePanel.querySelector('.acc-id')?.textContent).toBe('x@y.z');
    expect(activePanel.querySelector('.plan-chip')?.textContent).toBe('Plus');
    expect(qa(activePanel, '.g-row').length).toBe(2);

    // Клик по другой вкладке переключает отображаемую панель
    tabs[2]!.click();
    await flush();
    const agyPanel = q(host, '.eng-panels [role="tabpanel"]:not([hidden])');
    expect(agyPanel.getAttribute('data-panel')).toBe('antigravity');
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false');

    // Смена провайдера от хоста сбрасывает ручной выбор
    msg({ type: 'sessions.update', sessions: [], project: 'p', currentProvider: 'claude' });
    await flush();
    const claudePanel = q(host, '.eng-panels [role="tabpanel"]:not([hidden])');
    expect(claudePanel.getAttribute('data-panel')).toBe('claude');
  });

  it('A tabs: клавиатурная навигация ArrowLeft / ArrowRight / Home / End', async () => {
    const host = await mount({ limits: 'tabs', provider: 'claude' });
    const tabClaude = q(host, '[data-eng="claude"]');
    const tabCodex = q(host, '[data-eng="codex"]');
    const tabAgy = q(host, '[data-eng="antigravity"]');

    expect(tabClaude.getAttribute('aria-selected')).toBe('true');

    // ArrowRight: claude -> codex
    tabClaude.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(tabCodex.getAttribute('aria-selected')).toBe('true');
    expect(tabClaude.getAttribute('aria-selected')).toBe('false');

    // ArrowRight: codex -> antigravity
    tabCodex.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(tabAgy.getAttribute('aria-selected')).toBe('true');

    // ArrowRight wrapping: antigravity -> claude
    tabAgy.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(tabClaude.getAttribute('aria-selected')).toBe('true');

    // ArrowLeft wrapping: claude -> antigravity
    tabClaude.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flush();
    expect(tabAgy.getAttribute('aria-selected')).toBe('true');

    // Home: antigravity -> claude
    tabAgy.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await flush();
    expect(tabClaude.getAttribute('aria-selected')).toBe('true');

    // End: claude -> antigravity
    tabClaude.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await flush();
    expect(tabAgy.getAttribute('aria-selected')).toBe('true');
  });

  it('B radar: микро-плитки всех движков + детали активного ниже', async () => {
    const host = await mount({ limits: 'radar', provider: 'codex' });
    expect(q(host, '.radar-grid')).not.toBeNull();
    const tiles = qa(host, '.radar-grid .r-tile');
    expect(tiles.length).toBe(3);
    expect(tiles.map((t) => t.getAttribute('data-radar'))).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);

    expect(tiles.map((t) => t.querySelector('.r-val')?.textContent)).toEqual([
      '62%',
      '78%',
      '91%',
    ]);
    expect(tiles[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tiles[1]!.className).toContain('warn');
    expect(tiles[2]!.className).toContain('hot');

    const detail = q(host, '.radar-detail');
    expect(detail.querySelector('.acc-id')?.textContent).toBe('x@y.z');

    // Клик по плитке Antigravity переключает детальную панель
    tiles[2]!.click();
    await flush();
    expect(tiles[2]!.getAttribute('aria-selected')).toBe('true');
    expect(tiles[1]!.getAttribute('aria-selected')).toBe('false');
    expect(detail.querySelector('.ver-txt')?.textContent).toBe('agy 1.4');
  });

  it('C list: аккордеон с мини-шкалой и раскрытием окон движка', async () => {
    const host = await mount({ limits: 'list', provider: 'codex' });
    expect(q(host, '.acc-list')).not.toBeNull();
    const items = qa(host, '.acc-list .acc-item');
    expect(items.length).toBe(3);
    expect(items.map((it) => it.getAttribute('data-acc'))).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);

    // По умолчанию раскрыт движок вкладки (codex)
    expect(items[1]!.className).toContain('open');
    expect(items[0]!.className).not.toContain('open');
    expect(items[2]!.className).not.toContain('open');

    expect(items[1]!.querySelector('.acc-sub .acc-id')?.textContent).toBe('x@y.z');
    expect(qa(items[1]!, '.acc-sub .g-row').length).toBe(2);

    // Клик по Claude раскрывает его
    items[0]!.querySelector<HTMLButtonElement>('.acc-row-btn')!.click();
    await flush();
    expect(items[0]!.className).toContain('open');
    expect(qa(items[0]!, '.acc-sub .g-row').length).toBe(3);

    // Повторный клик по Claude сворачивает его
    items[0]!.querySelector<HTMLButtonElement>('.acc-row-btn')!.click();
    await flush();
    expect(items[0]!.className).not.toContain('open');
    expect(items[0]!.querySelector('.acc-sub')).toBeNull();
  });

  it('сворачивание секции и инлайн-сводка .sec-summary', async () => {
    const host = await mount({ limits: 'tabs' });
    const h3 = q(host, '.sec.acc h3');

    // В развёрнутом виде виден счетчик .sec-meta
    expect(q(host, '.sec-meta')?.textContent).toBe('3 движка');

    // Сворачивание секции
    h3.click();
    await flush();
    expect(q(host, '.sec.acc').className).toContain('folded');

    // Сводка .sec-summary выводит статус каждого движка
    const summary = q(host, '.sec-summary');
    expect(summary.textContent).toBe('Claude 62% · Codex 78% · AGY 91%');
    expect(summary.querySelector('.hot')?.textContent).toBe('AGY 91%');
    expect(summary.querySelector('.warn')?.textContent).toBe('Codex 78%');

    // При ошибке Antigravity сводка показывает «AGY !»
    msg({
      type: 'engines.limits',
      engines: [
        codex(),
        agy({ state: 'error', windows: [], error: 'Eligibility check failed' }),
      ],
    });
    await flush();
    expect(q(host, '.sec-summary').textContent).toBe('Claude 62% · Codex 78% · AGY !');
    expect(q(host, '.sec-summary .err')?.textContent).toBe('AGY !');
  });

  it('.diag-box для state=error: многострочный текст ошибки, Сменить аккаунт и Скрыть вкладку', async () => {
    const errText =
      'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.';
    const host = await mount({
      limits: 'tabs',
      provider: 'antigravity',
      engines: [codex(), agy({ state: 'error', windows: [], error: errText })],
    });

    const diag = q(host, '.diag-box');
    expect(diag).not.toBeNull();
    expect(diag.querySelector('.diag-hd')?.textContent).toContain('Квота недоступна');
    expect(diag.querySelector('.diag-hd')?.textContent).toContain('agy 1.4');
    expect(diag.querySelector('.diag-msg')?.textContent).toBe(errText);

    // Проверяем отсутствие обрезки в одну строку и отсутствие серой точки okd
    expect(diag.querySelector('.okd')).toBeNull();

    // Кнопка «Сменить аккаунт» отправляет engine.login
    const loginBtn = diag.querySelector<HTMLButtonElement>('.act-login')!;
    expect(loginBtn.textContent).toBe('Сменить аккаунт');
    loginBtn.click();
    expect(posted).toContainEqual({ type: 'engine.login', engine: 'antigravity' });

    // Кнопка «Скрыть вкладку» отправляет sidebar.hideEngine
    const hideBtn = diag.querySelector<HTMLButtonElement>('.act-hide')!;
    expect(hideBtn.textContent).toBe('Скрыть вкладку');
    hideBtn.click();
    expect(posted).toContainEqual({ type: 'sidebar.hideEngine', engine: 'antigravity' });
  });

  it('.diag-box для state=signedOut: приглашение ко входу, Войти и Скрыть вкладку', async () => {
    const host = await mount({
      limits: 'tabs',
      provider: 'codex',
      engines: [
        codex({ state: 'signedOut', windows: [], email: undefined, plan: undefined }),
        agy(),
      ],
    });

    const diag = q(host, '.diag-box');
    expect(diag).not.toBeNull();
    expect(diag.querySelector('.diag-hd')?.textContent).toContain('Вход не выполнен');

    const loginBtn = diag.querySelector<HTMLButtonElement>('.act-login')!;
    expect(loginBtn.textContent).toBe('Войти');
    loginBtn.click();
    expect(posted).toContainEqual({ type: 'engine.login', engine: 'codex' });

    const hideBtn = diag.querySelector<HTMLButtonElement>('.act-hide')!;
    hideBtn.click();
    expect(posted).toContainEqual({ type: 'sidebar.hideEngine', engine: 'codex' });
  });

  it('Kimi signedOut в аккордеоне и радаре: показывает статус без выдуманных email/плана', async () => {
    const host = await mount({
      limits: 'radar',
      provider: 'kimi',
      engines: [
        { engine: 'kimi', state: 'signedOut', version: 'kimi 2.6.0', windows: [], updatedAt: Date.now() },
      ],
    });

    const tile = q(host, '.radar-grid .r-tile[data-radar="kimi"]');
    expect(tile.className).toContain('err');
    expect(tile.querySelector('.r-val')?.textContent).toBe('!');

    const diag = q(host, '.radar-detail .diag-box');
    expect(diag).not.toBeNull();
    expect(diag.textContent).not.toContain('@');

    diag.querySelector<HTMLButtonElement>('.act-login')!.click();
    expect(posted).toContainEqual({ type: 'engine.login', engine: 'kimi' });
  });

  it('скрытие движков через hidden: отбрасывание из списка и скрытие всей секции', async () => {
    let host = await mount({ hidden: ['codex', 'antigravity'] });
    // Остался только Claude -> режим одиночного движка
    expect(q(host, '.eng-tabs')).toBeNull();
    expect(q(host, '.sec.acc .panel-body')).not.toBeNull();
    render(null, host);

    // Скрыты все движки -> секция отсутствует
    host = await mount({ hidden: ['claude', 'codex', 'antigravity'] });
    expect(q(host, '.sec.acc')).toBeNull();
  });

  it('hud.css содержит container query, стили брендовых SVG и плавные переходы', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'media', 'hud.css'), 'utf8');

    // Контейнерные запросы на .sidebar
    expect(css).toMatch(/\.sidebar\s*\{[^}]*container:\s*sidebar\s*\/\s*inline-size/);
    expect(css).toMatch(/@container\s+sidebar\s+\(max-width:\s*345px\)\s*\{[^}]*\.tab-lbl\s*\{[^}]*display:\s*none/);

    // Брендовые SVG и переключение тёмной темы
    expect(css).toMatch(/(?:\.sidebar|:is\([^)]*\.sidebar[^)]*\))\s+\.brand-claude\s*\{[^}]*claude-color\.svg/);
    expect(css).toMatch(/(?:\.sidebar|:is\([^)]*\.sidebar[^)]*\))\s+\.brand-codex\s*\{[^}]*openai\.svg/);
    expect(css).toMatch(/body\.vscode-dark[^{]*\.brand-codex\s*\{[^}]*openai-dark\.svg/);
    expect(css).toMatch(/body\.vscode-dark[^{]*\.brand-kimi\s*\{[^}]*kimi-dark\.svg/);

    // Плавные переходы для полос и шеврона
    expect(css).toMatch(/\.sidebar\s+\.g-bar\s*>\s*i\s*\{[^}]*transition:\s*width\s+var\(--dur\)\s+var\(--ease-out\)/);
    expect(css).toMatch(/\.sidebar\s+\.r-track\s*>\s*i\s*\{[^}]*transition:\s*width\s+var\(--dur\)\s+var\(--ease-out\)/);
    expect(css).toMatch(/\.sidebar\s+\.acc-row-btn\s+\.g-bar\s*>\s*i\s*\{[^}]*transition:\s*width\s+var\(--dur\)\s+var\(--ease-out\)/);
    expect(css).toMatch(/\.sidebar\s+\.sec\s+h3\s+\.tri\s*\{[^}]*transition:\s*transform\s+var\(--dur-fast\)\s+var\(--ease-out\)/);

    // Многострочный текст ошибки
    expect(css).toMatch(/\.sidebar\s+\.diag-msg\s*\{(?=[^}]*word-break:\s*break-word)(?=[^}]*white-space:\s*normal)[^}]*\}/);
  });
});
