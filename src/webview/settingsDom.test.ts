// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsValues } from '../settings';
import { Settings } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import {
  engineCheck,
  errors,
  handleSettingsMessage,
  overridden,
  settingsValues,
} from './settingsStore';
import { userFonts } from './fonts';
import * as vscode from './vscode';

const posted: Record<string, unknown>[] = [];
const flush = () => new Promise((r) => setTimeout(r, 30));
const mounted: HTMLElement[] = [];

function mount(component: () => unknown) {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(component as never, {}), host);
  return host;
}

const values: SettingsValues = {
  defaultPermissionMode: 'manual',
  allowBypassPermissions: false,
  defaultModel: '',
  defaultEffort: '',
  contextThresholds: [120_000, 150_000],
  usagePollMinutes: 15,
  'limits.readKeychain': true,
  claudeExecutable: '',
  'sessionList.view': 'compact',
  'sessionList.context': true,
  'sessionList.time': true,
  'sidebar.top': 'detailed',
  'feed.style': 'journal',
  'feed.fontSize': 13,
  'font.interface': '',
  'font.panels': '',
  'font.code': '',
  language: 'auto',
};
const state = (over: Partial<SettingsValues> = {}) =>
  handleSettingsMessage({
    type: 'settings.state',
    values: { ...values, ...over },
    overridden: [],
  });

const change = (el: Element, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const sets = () => posted.filter((m) => m.type === 'settings.set');

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
  settingsValues.value = undefined;
  overridden.value = [];
  errors.value = {};
  engineCheck.value = { pending: false };
  userFonts.value = { ui: [], code: [] };
});
afterEach(() => vi.restoreAllMocks());

describe('⚙ в боковой панели', () => {
  it('клик отправляет settings.open', async () => {
    const host = mount(Sidebar);
    await flush();
    host.querySelector<HTMLButtonElement>('.head .gear')!.click();
    expect(posted).toContainEqual({ type: 'settings.open' });
  });
});

describe('вкладка настроек', () => {
  it('пока значений нет — пустая оболочка; пришли — все разделы и поля', async () => {
    const host = mount(Settings);
    expect(host.querySelector('.st-body')).toBeNull();
    state();
    await flush();
    expect([...host.querySelectorAll('.st-page')].map((e) => e.id)).toEqual([
      'session',
      'limits',
      'sidebar',
      'look',
      'engine',
    ]);
    expect([...host.querySelectorAll('.set .key')].map((e) => e.textContent)).toEqual([
      // режим по умолчанию можно задать на проект (решение владельца 2026-10-01)
      'agentura.defaultPermissionMode',
      'agentura.allowBypassPermissions · только эта машина',
      'agentura.defaultModel',
      'agentura.defaultEffort',
      'agentura.contextThresholds',
      'agentura.usagePollMinutes · не меньше 5',
      'agentura.limits.readKeychain',
      'agentura.sidebar.top',
      'agentura.sessionList.view',
      'agentura.sessionList.context',
      'agentura.sessionList.time',
      'agentura.feed.style',
      'agentura.feed.fontSize',
      'agentura.font.interface',
      'agentura.font.panels',
      'agentura.font.code',
      'agentura.language',
      'agentura.claudeExecutable · только эта машина',
    ]);
  });

  it('разметка строк и CSS-классы — как в прототипе settings.html', async () => {
    const proto = new DOMParser().parseFromString(
      readFileSync(join(__dirname, '..', '..', 'prototype', 'screens', 'settings.html'), 'utf8'),
      'text/html',
    );
    const host = mount(Settings);
    state({ allowBypassPermissions: true });
    await flush();
    const classes = (root: ParentNode, sel: string) =>
      [...root.querySelectorAll(sel)].map((e) => [...e.classList].sort().join('.'));
    expect(classes(host, '.set')).toEqual(classes(proto, '.set'));
    expect(classes(host, '.st-nav [role="tab"]').length).toBe(
      classes(proto, '.st-nav [role="tab"]').length,
    );
    expect([...host.querySelectorAll('.st-page')].map((e) => e.id)).toEqual(
      [...proto.querySelectorAll('.st-page')].map((e) => e.id),
    );
    expect(host.querySelector('.st-wrap > .st-nav')).not.toBeNull();
    expect(host.querySelector('.set.on .tg.on.danger')).not.toBeNull();
    expect(host.querySelector('.set.on .warn')).not.toBeNull();
  });

  it('разделы — страницы: видна одна, клик и стрелки переключают', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const visible = () =>
      [...host.querySelectorAll<HTMLElement>('.st-page')].filter((p) => !p.hidden).map((p) => p.id);
    const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[data-section="${id}"]`)!;
    expect(visible()).toEqual(['session']);
    expect(tab('session').getAttribute('aria-selected')).toBe('true');
    tab('look').click();
    await flush();
    expect(visible()).toEqual(['look']);
    expect(tab('look').classList.contains('on')).toBe(true);
    expect(tab('session').tabIndex).toBe(-1);
    tab('look').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flush();
    expect(visible()).toEqual(['engine']);
    expect(document.activeElement).toBe(tab('engine'));
    tab('engine').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flush();
    expect(visible()).toEqual(['session']);
  });

  it('виды — карточками с настоящими миниатюрами; клик и стрелки пишут настройку', async () => {
    const host = mount(Settings);
    state({ 'feed.style': 'folded' });
    await flush();
    const group = (k: string) =>
      host.querySelector<HTMLElement>(`[data-key="agentura.${k}"] [role="radiogroup"]`)!;
    const feed = group('feed.style');
    expect(
      [...feed.querySelectorAll('.pv .webview')].map((e) => e.getAttribute('data-feed')),
    ).toEqual(['journal', 'folded', 'replies', 'cards']);
    expect(feed.querySelectorAll('.pv .log .u').length).toBe(4);
    expect(feed.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('folded');
    feed.querySelector<HTMLButtonElement>('[data-value="cards"]')!.click();
    feed
      .querySelector('[aria-checked="true"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(sets()).toEqual([
      { type: 'settings.set', key: 'feed.style', value: 'cards' },
      { type: 'settings.set', key: 'feed.style', value: 'journal' },
    ]);
    const top = group('sidebar.top');
    expect(
      [...top.querySelectorAll('.pv .sidebar')].map((e) => e.getAttribute('data-top')),
    ).toEqual(['detailed', 'compact', 'dense']);
    const list = group('sessionList.view');
    expect(
      [...list.querySelectorAll('.pv .sidebar')].map((e) => e.getAttribute('data-list')),
    ).toEqual(['detailed', 'compact', 'dense']);
    expect(
      host.querySelector('[data-key="agentura.feed.fontSize"] .pv-one .pv-sized .log'),
    ).not.toBeNull();
  });

  it('шрифт карточками: каждая своим шрифтом, наведение примеряет на образец, клик пишет', async () => {
    const host = mount(Settings);
    state({ 'font.code': 'My Mono' });
    await flush();
    const code = host.querySelector<HTMLElement>(
      '[data-key="agentura.font.code"] [role="radiogroup"]',
    )!;
    const card = (v: string) => code.querySelector<HTMLButtonElement>(`[data-value="${v}"]`)!;
    // без canvas (jsdom) показываются все кандидаты; свой шрифт — отдельной карточкой, выбран
    expect(card('JetBrains Mono').querySelector<HTMLElement>('.fs')!.style.fontFamily).toContain(
      'JetBrains Mono',
    );
    expect(card('My Mono').getAttribute('aria-checked')).toBe('true');
    expect(card('').getAttribute('aria-checked')).toBe('false');
    const sample = host.querySelector<HTMLElement>('[data-key="agentura.feed.fontSize"] .pv-one')!;
    card('Fira Code').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    card('Fira Code').dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    expect(sample.style.getPropertyValue('--mono')).toBe('"Fira Code", var(--mono-vscode)');
    expect(sample.textContent).toContain('Fira Code');
    code.dispatchEvent(new MouseEvent('mouseleave'));
    await flush();
    expect(sample.style.getPropertyValue('--mono')).toBe('');
    card('Fira Code').click();
    expect(sets()).toEqual([{ type: 'settings.set', key: 'font.code', value: 'Fira Code' }]);
  });

  it('Google Fonts: кнопка под карточками шлёт fonts.add с kind, ✕ — только у скачанных и шлёт fonts.remove', async () => {
    userFonts.value = { ui: ['Onest'], code: ['Fira Code'] };
    const host = mount(Settings);
    state();
    await flush();
    const row = (k: string) => host.querySelector<HTMLElement>(`[data-key="agentura.${k}"]`)!;
    const add = (k: string) => row(k).querySelector<HTMLButtonElement>('.fonts-add');
    add('font.interface')!.click();
    add('font.code')!.click();
    add('font.panels')!.click();
    expect(posted.filter((m) => m.type === 'fonts.add')).toEqual([
      { type: 'fonts.add', kind: 'ui' },
      { type: 'fonts.add', kind: 'code' },
      { type: 'fonts.add', kind: 'panels' },
    ]);
    const marks = (k: string) =>
      [...row(k).querySelectorAll<HTMLElement>('.cx')].map((b) => b.getAttribute('data-remove'));
    expect(marks('font.interface')).toEqual(['Onest']);
    expect(marks('font.code')).toEqual(['Fira Code']);
    expect(marks('font.panels')).toEqual(['Onest', 'Fira Code']);
    // карточка скачанного — обычная: клик выбирает шрифт
    row('font.interface').querySelector<HTMLButtonElement>('[data-value="Onest"]')!.click();
    expect(sets()).toEqual([{ type: 'settings.set', key: 'font.interface', value: 'Onest' }]);
    // стрелка на ✕ не меняет выбор карточек
    row('font.interface')
      .querySelector('.cx')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(sets()).toHaveLength(1);
    row('font.interface').querySelector<HTMLButtonElement>('.cx')!.click();
    expect(posted).toContainEqual({ type: 'fonts.remove', family: 'Onest' });
    // системные кандидаты ✕ не получают
    expect(
      row('font.interface').querySelector('[data-value="system-ui"]')!.parentElement!.classList.contains('cw'),
    ).toBe(false);
  });

  it('значения отражаются в полях, в «режиме» нет bypass, пока он не разрешён', async () => {
    const host = mount(Settings);
    state({ defaultEffort: 'high', usagePollMinutes: 30, defaultModel: 'opus' });
    await flush();
    const val = (k: string) =>
      (host.querySelector(`[aria-label="${k}"]`) as HTMLInputElement).value;
    expect(val('defaultEffort')).toBe('high');
    expect(val('usagePollMinutes')).toBe('30');
    expect(val('defaultModel')).toBe('opus');
    const modes = [...host.querySelectorAll('[aria-label="defaultPermissionMode"] option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(modes).toEqual(['manual', 'acceptEdits', 'plan']);
    state({ allowBypassPermissions: true });
    await flush();
    expect(host.querySelectorAll('[aria-label="defaultPermissionMode"] option').length).toBe(4);
  });

  it('переключатель и список пишут через settings.set', async () => {
    const host = mount(Settings);
    state();
    await flush();
    host.querySelector<HTMLButtonElement>('[aria-label="allowBypassPermissions"]')!.click();
    change(host.querySelector('[aria-label="defaultPermissionMode"]')!, 'plan');
    expect(sets()).toEqual([
      { type: 'settings.set', key: 'allowBypassPermissions', value: true },
      { type: 'settings.set', key: 'defaultPermissionMode', value: 'plan' },
    ]);
  });

  it('пороги: жёлтый ≥ оранжевого — ошибка у поля, ничего не отправлено; верные — отправлены парой', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const [yellow, orange] = [
      ...host.querySelectorAll<HTMLInputElement>('.set[data-key$="contextThresholds"] input'),
    ];
    change(yellow!, '160000');
    await flush();
    expect(sets()).toEqual([]);
    expect(host.querySelector('.set[data-key$="contextThresholds"] .err')?.textContent).toMatch(
      /ниже оранжевого/,
    );
    change(orange!, '200000');
    await flush();
    expect(sets()).toEqual([]);
    expect(host.querySelector('.set[data-key$="contextThresholds"] .err')?.textContent).toMatch(
      /200/,
    );
    change(orange!, '190000');
    await flush();
    expect(sets()).toEqual([
      { type: 'settings.set', key: 'contextThresholds', value: [160_000, 190_000] },
    ]);
    expect(host.querySelector('.set[data-key$="contextThresholds"] .err')).toBeNull();
  });

  it('опрос лимитов меньше 5 — ошибка, не отправляется', async () => {
    const host = mount(Settings);
    state();
    await flush();
    change(host.querySelector('[aria-label="usagePollMinutes"]')!, '3');
    await flush();
    expect(sets()).toEqual([]);
    expect(host.querySelector('.set[data-key$="usagePollMinutes"] .err')).not.toBeNull();
    change(host.querySelector('[aria-label="usagePollMinutes"]')!, '20');
    expect(sets()).toEqual([{ type: 'settings.set', key: 'usagePollMinutes', value: 20 }]);
  });

  it('правка в settings.json (новое settings.state) сразу меняет поле, ошибка хоста показывается', async () => {
    const host = mount(Settings);
    state();
    await flush();
    state({ usagePollMinutes: 45, defaultModel: 'sonnet' });
    await flush();
    expect((host.querySelector('[aria-label="usagePollMinutes"]') as HTMLInputElement).value).toBe(
      '45',
    );
    expect((host.querySelector('[aria-label="defaultModel"]') as HTMLInputElement).value).toBe(
      'sonnet',
    );
    handleSettingsMessage({
      type: 'settings.error',
      key: 'defaultModel',
      message: 'не записалось',
    });
    await flush();
    expect(host.querySelector('.set[data-key$="defaultModel"] .err')?.textContent).toBe(
      'не записалось',
    );
  });

  it('«проверить»: отправляет путь из поля, показывает версию и источник', async () => {
    const host = mount(Settings);
    state({ claudeExecutable: '/x/claude' });
    await flush();
    host.querySelector<HTMLButtonElement>('.set[data-key$="claudeExecutable"] .btn')!.click();
    expect(posted).toContainEqual({ type: 'settings.checkEngine', path: '/x/claude' });
    handleSettingsMessage({
      type: 'settings.engine',
      result: { ok: true, source: 'setting', path: '/x/claude', version: '2.1.285' },
    });
    await flush();
    const ok = host.querySelector('.set .ok')!;
    expect(ok.textContent).toContain('найден');
    expect(ok.textContent).toContain('/x/claude');
    expect(ok.textContent).toContain('2.1.285');
    handleSettingsMessage({
      type: 'settings.engine',
      result: { ok: false, source: 'none', problem: 'Не найден Claude Code' },
    });
    await flush();
    expect(host.querySelector('.set .ok.bad')?.textContent).toContain('Не найден Claude Code');
  });

  it('ссылки «в настройках VS Code» и settings.json', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const [ui, json] = [...host.querySelectorAll<HTMLButtonElement>('.hud .acts button')];
    ui!.click();
    json!.click();
    expect(posted).toEqual([
      { type: 'settings.reveal', target: 'ui' },
      { type: 'settings.reveal', target: 'json' },
    ]);
  });

  it('переопределение рабочей папкой помечается', async () => {
    const host = mount(Settings);
    handleSettingsMessage({ type: 'settings.state', values, overridden: ['defaultModel'] });
    await flush();
    expect(host.querySelector('.set[data-key$="defaultModel"] .note')).not.toBeNull();
    expect(host.querySelector('.set[data-key$="defaultEffort"] .note')).toBeNull();
  });
});
