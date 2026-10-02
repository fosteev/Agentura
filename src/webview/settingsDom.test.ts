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
    expect([...host.querySelectorAll('h2')].map((e) => e.id)).toEqual([
      'perm',
      'model',
      'ctx',
      'lim',
      'view',
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
      'agentura.sessionList.view',
      'agentura.sessionList.context',
      'agentura.sessionList.time',
      'agentura.sidebar.top',
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
    expect(classes(host, '.st-nav a').length).toBe(classes(proto, '.st-nav a').length);
    expect(host.querySelector('.st-wrap > .st-nav')).not.toBeNull();
    expect(host.querySelector('.set.on .tg.on.danger')).not.toBeNull();
    expect(host.querySelector('.set.on .warn')).not.toBeNull();
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
