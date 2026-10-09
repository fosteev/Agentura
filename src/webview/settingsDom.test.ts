// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsValues } from '../settings';
import type { IntegrationsState } from '../shared/integrations';
import { Settings } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import {
  agyCheck,
  codexCheck,
  engineCheck,
  errors,
  handleSettingsMessage,
  integrations,
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
  'jira.agentTools': { comment: true, transition: true, worklog: true },
  defaultPermissionMode: 'manual',
  allowBypassPermissions: false,
  defaultModel: '',
  defaultEffort: '',
  remoteControl: false,
  remoteControlNamePrefix: '',
  contextThresholds: [120_000, 150_000],
  usagePollMinutes: 15,
  'limits.readKeychain': true,
  claudeExecutable: '',
  codexExecutable: '',
  antigravityExecutable: '',
  defaultProvider: 'claude',
  'sessionList.view': 'compact',
  'sessionList.context': true,
  'sessionList.time': true,
  'sidebar.top': 'detailed',
  'sidebar.limits': 'active',
  'tasks.sidebar': 'groups',
  'tasks.card': 'tab',
  'tasks.tab': 'chat',
  'jira.source': 'auto',
  'tasks.refresh': '30s',
  'tasks.humanChanges': true,
  'feed.style': 'journal',
  'composer.layout': 'classic',
  'agents.view': 'list',
  'git.layout': 'stack',
  'feed.fontSize': 13,
  'ui.fontSize': 13,
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
  integrations.value = undefined;
  overridden.value = [];
  errors.value = {};
  engineCheck.value = { pending: false };
  codexCheck.value = { pending: false };
  agyCheck.value = { pending: false };
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
      'integrations',
      'engine',
    ]);
    expect([...host.querySelectorAll('.set .key')].map((e) => e.textContent)).toEqual([
      // режим по умолчанию можно задать на проект (решение владельца 2026-10-01)
      'agentura.defaultPermissionMode',
      'agentura.allowBypassPermissions · только эта машина',
      'agentura.defaultModel',
      'agentura.defaultEffort',
      'agentura.remoteControl · только движок Claude',
      'agentura.remoteControlNamePrefix',
      'agentura.contextThresholds',
      'agentura.usagePollMinutes · не меньше 5',
      'agentura.limits.readKeychain',
      'agentura.sidebar.top',
      'agentura.sidebar.limits',
      'agentura.tasks.sidebar',
      'agentura.sessionList.view',
      'agentura.sessionList.context',
      'agentura.sessionList.time',
      'agentura.feed.style',
      'agentura.composer.layout',
      'agentura.agents.view',
      'agentura.git.layout',
      'agentura.tasks.card',
      'agentura.tasks.tab',
      'agentura.feed.fontSize',
      'agentura.ui.fontSize',
      'agentura.font.interface',
      'agentura.font.panels',
      'agentura.font.code',
      'agentura.language',
      'agentura.jira.source',
      'fosteev.jiraffe',
      'agentura.jira.connect',
      'agentura.tasks.refresh',
      'agentura.tasks.humanChanges',
      'agentura.jira.agentTools',
      'agentura.defaultProvider',
      'agentura.claudeExecutable · только эта машина',
      'agentura.codexExecutable · только эта машина',
      'agentura.antigravityExecutable · только эта машина',
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

  it('Remote Control: переключатель и префикс пишут через settings.set', async () => {
    const host = mount(Settings);
    state();
    await flush();
    host.querySelector<HTMLElement>('.set[data-key$="remoteControl"] .tg')!.click();
    await flush();
    change(host.querySelector('.set[data-key$="remoteControlNamePrefix"] input')!, 'Мак');
    expect(sets()).toEqual([
      { type: 'settings.set', key: 'remoteControl', value: true },
      { type: 'settings.set', key: 'remoteControlNamePrefix', value: 'Мак' },
    ]);
    expect(
      host
        .querySelector('.set[data-key$="remoteControlNamePrefix"] input')
        ?.getAttribute('placeholder'),
    ).toBe('пусто — имя машины');
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
    expect(visible()).toEqual(['integrations']);
    tab('integrations').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
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
    const comp = group('composer.layout');
    expect(
      [...comp.querySelectorAll('.pv footer.compose')].map((e) => e.getAttribute('data-layout')),
    ).toEqual(['classic', 'card', 'statusline', 'gauges', 'minimal', 'shell']);
    expect(comp.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('classic');
    comp.querySelector<HTMLButtonElement>('[data-value="shell"]')!.click();
    expect(sets()).toContainEqual({ type: 'settings.set', key: 'composer.layout', value: 'shell' });
    const agents = group('agents.view');
    expect(
      [...agents.querySelectorAll('.pv .webview')].map((e) => e.getAttribute('data-agents')),
    ).toEqual(['list', 'tree', 'lanes', 'cards', 'graph']);
    // превью — настоящая вкладка «агенты»: дерево с ветками, дорожки, карточки; у списка — строки агентов
    expect(agents.querySelectorAll('.pv [data-agents="tree"] .am .kids > li').length).toBeGreaterThan(3);
    expect(agents.querySelectorAll('.pv [data-agents="lanes"] .am .ln').length).toBeGreaterThan(4);
    expect(agents.querySelectorAll('.pv [data-agents="cards"] .am .card').length).toBe(4);
    expect(agents.querySelectorAll('.pv [data-agents="list"] .ag .a.sub').length).toBe(4);
    agents.querySelector<HTMLButtonElement>('[data-value="tree"]')!.click();
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'agents.view', value: 'tree' });
    const gitl = group('git.layout');
    expect(
      [...gitl.querySelectorAll('.pv .webview')].map((e) => e.getAttribute('data-git')),
    ).toEqual(['stack', 'picker', 'unified']);
    // превью — настоящая вкладка «git» на трёх репозиториях
    expect(gitl.querySelectorAll('.pv [data-git="stack"] .rb').length).toBe(3);
    expect(gitl.querySelectorAll('.pv [data-git="picker"] .pick .p').length).toBe(3);
    expect(gitl.querySelectorAll('.pv [data-git="unified"] .rgrp').length).toBeGreaterThan(2);
    gitl.querySelector<HTMLButtonElement>('[data-value="unified"]')!.click();
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'git.layout', value: 'unified' });
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

  it('лимиты движков: пять разных превью даже при плотном верхе; выбор пишет настройку', async () => {
    const host = mount(Settings);
    state({ 'sidebar.top': 'dense' });
    await flush();
    const row = host.querySelector('[data-key="agentura.sidebar.limits"]')!;
    expect(row.querySelector('select')).toBeNull();
    const cards = [...row.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(cards.map((c) => c.dataset.value)).toEqual(['stack', 'switch', 'table', 'active', 'header']);
    for (const card of cards) {
      expect(card.querySelector('.pv[inert][aria-hidden="true"]')).not.toBeNull();
      if (card.dataset.value === 'header') {
        expect(card.querySelectorAll('.head .hx .m')).toHaveLength(3);
        expect(card.querySelector('.sec.acc')).toBeNull();
      } else {
        expect(card.querySelector('.sec.acc')?.getAttribute('data-limits')).toBe(card.dataset.value);
        expect(card.textContent).toContain('Claude');
        expect(card.textContent).toContain('Codex');
        expect(card.querySelector('.mk.agy')).not.toBeNull();
      }
    }
    expect(row.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('active');
    cards[0]!.click();
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'sidebar.limits', value: 'stack' });
    state({ 'sidebar.limits': 'stack' });
    await flush();
    cards[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'sidebar.limits', value: 'switch' });
  });

  it('задачи Jira в панели: два превью с фикстурой групп (группы / секция), выбор пишет настройку', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const row = host.querySelector('[data-key="agentura.tasks.sidebar"]')!;
    expect(row.querySelector('select')).toBeNull();
    const cards = [...row.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(cards.map((c) => c.dataset.value)).toEqual(['groups', 'section']);
    for (const card of cards) expect(card.querySelector('.pv[inert][aria-hidden="true"]')).not.toBeNull();
    const [groups, section] = cards as [HTMLElement, HTMLElement];
    expect(groups.querySelectorAll('.tgp')).toHaveLength(3); // две задачи и «Без задачи»
    expect(groups.querySelector('.tgp .tkey')!.textContent).toBe('NEWMFC-1482');
    expect(groups.querySelector('.tgp .pill')).not.toBeNull();
    expect(groups.querySelector('.sec.tasks')).toBeNull();
    expect(section.querySelector('.sec.tasks .tk')).not.toBeNull();
    expect(section.querySelector('.tgp')).toBeNull();
    expect(section.querySelector('.s .tag')!.textContent).toBe('NEWMFC-1482');
    expect(row.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('groups');
    section.click();
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'tasks.sidebar', value: 'section' });
  });

  it('карточка задачи в чате: два превью (вкладка / сплит с пометкой «только с Jiraffe»), выбор пишет настройку', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const row = host.querySelector('[data-key="agentura.tasks.card"]')!;
    const cards = [...row.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(cards.map((c) => c.dataset.value)).toEqual(['tab', 'split']);
    for (const card of cards) {
      expect(card.querySelector('.pv-taskcard[inert][aria-hidden="true"]')).not.toBeNull();
      expect(card.querySelector('.tk-strip .tkey')!.textContent).toBe('NEWMFC-1482');
    }
    const [tab, split] = cards as [HTMLElement, HTMLElement];
    expect(tab.querySelector('.tcp-side .on')!.textContent).toBe('задача');
    expect(tab.querySelector('.tcp-card')).toBeNull();
    expect(split.querySelector('.tcp-card')).not.toBeNull();
    expect(split.querySelector('.tcp-note')!.textContent).toBe('только с Jiraffe');
    expect(row.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('tab');
    split.click();
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'tasks.card', value: 'split' });
  });

  it('вкладки чатов по задаче: два превью (вкладка на чат / на задачу с внутренними вкладками), выбор пишет настройку', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const row = host.querySelector('[data-key="agentura.tasks.tab"]')!;
    const cards = [...row.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(cards.map((c) => c.dataset.value)).toEqual(['chat', 'task']);
    const [perChat, perTask] = cards as [HTMLElement, HTMLElement];
    for (const card of cards) {
      expect(card.querySelector('.pv-tasktab[inert][aria-hidden="true"]')).not.toBeNull();
      expect(card.querySelector('.tk-strip .tkey')!.textContent).toBe('NEWMFC-1482');
    }
    expect(perChat.querySelector('.tk-ctabs')).toBeNull();
    expect(perChat.querySelector('.ttp-tabs .on')!.textContent).toContain('NEWMFC-1482 · ');
    expect(perTask.querySelector('.ttp-tabs .on')!.textContent).toBe('NEWMFC-1482');
    expect(perTask.querySelectorAll('.tk-ctabs .ctab')).toHaveLength(2);
    expect(row.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('chat');
    perTask.click();
    expect(sets().at(-1)).toEqual({ type: 'settings.set', key: 'tasks.tab', value: 'task' });
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
    const ok = host.querySelector('.set .ok[role="status"]')!;
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

  it('Codex: строка пути с «проверить» (свой результат) и выбор движка по умолчанию', async () => {
    const host = mount(Settings);
    state({ codexExecutable: '/x/codex', defaultProvider: 'codex' });
    await flush();
    host.querySelector<HTMLButtonElement>('.set[data-key$="codexExecutable"] .btn')!.click();
    expect(posted).toContainEqual({ type: 'settings.checkEngine', path: '/x/codex', engine: 'codex' });
    handleSettingsMessage({
      type: 'settings.engine',
      engine: 'codex',
      result: { ok: true, source: 'setting', path: '/x/codex', version: '0.160.0' },
    });
    await flush();
    const row = host.querySelector('.set[data-key$="codexExecutable"]')!;
    expect(row.querySelector('.ok[role="status"]')!.textContent).toContain('0.160.0');
    // результат Codex не попадает в строку Claude
    expect(host.querySelector('.set[data-key$="claudeExecutable"] .ok')).toBeNull();
    const sel = host.querySelector<HTMLSelectElement>('select[aria-label="defaultProvider"]')!;
    expect(sel.value).toBe('codex');
    sel.value = 'claude';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(posted).toContainEqual({ type: 'settings.set', key: 'defaultProvider', value: 'claude' });
  });

  it('Antigravity: строка пути с «проверить» (свой результат) и вариант движка по умолчанию', async () => {
    const host = mount(Settings);
    state({ antigravityExecutable: '/x/agy', defaultProvider: 'antigravity' });
    await flush();
    host.querySelector<HTMLButtonElement>('.set[data-key$="antigravityExecutable"] .btn')!.click();
    expect(posted).toContainEqual({
      type: 'settings.checkEngine',
      path: '/x/agy',
      engine: 'antigravity',
    });
    handleSettingsMessage({
      type: 'settings.engine',
      engine: 'antigravity',
      result: { ok: true, source: 'setting', path: '/x/agy', version: '1.2.3' },
    });
    await flush();
    const row = host.querySelector('.set[data-key$="antigravityExecutable"]')!;
    expect(row.querySelector('.ok[role="status"]')!.textContent).toContain('1.2.3');
    expect(host.querySelector('.set[data-key$="claudeExecutable"] .ok')).toBeNull();
    expect(host.querySelector('.set[data-key$="codexExecutable"] .ok')).toBeNull();
    const sel = host.querySelector<HTMLSelectElement>('select[aria-label="defaultProvider"]')!;
    expect(sel.value).toBe('antigravity');
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

describe('страница «Интеграции»', () => {
  const inst = (id: string, kind: 'dc' | 'cloud' = 'dc') => ({ id, name: id.toUpperCase(), baseUrl: `https://${id}.example`, kind });
  const page = (st: IntegrationsState | undefined) => {
    const host = mount(Settings);
    state();
    if (st) handleSettingsMessage({ type: 'integrations.state', state: st });
    return host;
  };
  const pageEl = (host: HTMLElement) => host.querySelector<HTMLElement>('#integrations')!;

  it('Jiraffe есть: версия, инстансы по именам; свои подключения пусты', async () => {
    const host = page({ jiraffe: { state: 'ready', version: '0.8.0', instances: [inst('a'), inst('b')] }, own: [], active: 'jiraffe' });
    await flush();
    const p = pageEl(host);
    expect(p.textContent).toContain('Jiraffe 0.8.0 установлен');
    expect(p.textContent).toContain('2 инстанса: A, B');
    expect(p.textContent).toContain('Сейчас работает: Jiraffe');
    expect(p.textContent).toContain('Подключений нет.');
    expect(p.querySelector('.set[data-key$="jira.source"] select')).not.toBeNull();
    expect(p.querySelector('.set .btn')?.textContent).toBe('подключить'); // «поставить» только без Jiraffe
    expect(p.textContent).not.toContain('поставить');
  });

  it('Jiraffe нет, два своих: «поставить», список, проверить / удалить / подключить шлют сообщения', async () => {
    const host = page({ jiraffe: { state: 'absent', instances: [] }, own: [inst('a'), inst('b', 'cloud')], active: 'own' });
    await flush();
    const p = pageEl(host);
    expect(p.textContent).toContain('не установлен');
    expect(p.textContent).toContain('Сейчас работает: свои подключения');
    const rows = [...p.querySelectorAll<HTMLElement>('.cn .r')];
    expect(rows.map((r) => r.dataset.instance)).toEqual(['a', 'b']);
    expect(rows[1]!.textContent).toContain('Cloud');
    const btn = (el: ParentNode, text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
    btn(rows[0]!, 'проверить').click();
    btn(rows[1]!, 'удалить').click();
    btn(p, 'подключить').click();
    btn(p, 'поставить').click();
    expect(posted.filter((m) => String(m.type).startsWith('integrations.'))).toEqual([
      { type: 'integrations.test', instanceId: 'a' },
      { type: 'integrations.disconnect', instanceId: 'b' },
      { type: 'integrations.connect' },
      { type: 'integrations.installJiraffe' },
    ]);
  });

  it('ничего нет; старый Jiraffe без API; Jiraffe не используется', async () => {
    const host = page({ jiraffe: { state: 'absent', instances: [] }, own: [] });
    await flush();
    const p = pageEl(host);
    expect(p.textContent).toContain('Сейчас источника нет');
    expect(p.textContent).toContain('Подключений нет.');
    handleSettingsMessage({ type: 'integrations.state', state: { jiraffe: { state: 'no-api', version: '0.7.0', instances: [] }, own: [] } });
    await flush();
    expect(p.textContent).toContain('не отдаёт API');
    handleSettingsMessage({ type: 'integrations.state', state: { jiraffe: { state: 'inactive', version: '0.8.0', instances: [] }, own: [inst('a')], active: 'own' } });
    await flush();
    expect(p.textContent).toContain('сейчас не используется');
  });

  it('источник, обновление и «изменения от людей» пишут через settings.set; инструменты агента неактивны', async () => {
    const host = page({ jiraffe: { state: 'absent', instances: [] }, own: [] });
    await flush();
    const p = pageEl(host);
    const sel = p.querySelector<HTMLSelectElement>('.set[data-key$="jira.source"] select')!;
    sel.value = 'own';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const rf = p.querySelector<HTMLSelectElement>('.set[data-key$="tasks.refresh"] select')!;
    rf.value = 'manual';
    rf.dispatchEvent(new Event('change', { bubbles: true }));
    p.querySelector<HTMLElement>('.set[data-key$="tasks.humanChanges"] .tg')!.click();
    expect(sets()).toEqual([
      { type: 'settings.set', key: 'jira.source', value: 'own' },
      { type: 'settings.set', key: 'tasks.refresh', value: 'manual' },
      { type: 'settings.set', key: 'tasks.humanChanges', value: false },
    ]);
    const boxes = [...p.querySelectorAll<HTMLInputElement>('.cbs input')];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(p.querySelector('.set[data-key$="jira.agentTools"] .soon')?.textContent).toContain('источник не пишет');
  });

  it('инструменты агента (этап 8): источник пишет — флажки активны и пишут настройку целиком', async () => {
    const host = page({ jiraffe: { state: 'absent', instances: [] }, own: [inst('a')], active: 'own', writes: true });
    await flush();
    const p = pageEl(host);
    const boxes = [...p.querySelectorAll<HTMLInputElement>('.set[data-key$="jira.agentTools"] .cbs input')];
    expect(boxes.map((b) => [b.disabled, b.checked])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect(p.querySelector('.set[data-key$="jira.agentTools"] .soon')).toBeNull();
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sets()).toEqual([{ type: 'settings.set', key: 'jira.agentTools', value: { comment: true, transition: false, worklog: true } }]);
  });

  it('шестая страница в навигации; стрелки ↑↓ проходят по кругу через неё', async () => {
    const host = mount(Settings);
    state();
    await flush();
    const ids = [...host.querySelectorAll<HTMLElement>('.st-tabs [role="tab"]')].map((t) => t.dataset.section);
    expect(ids).toEqual(['session', 'limits', 'sidebar', 'look', 'integrations', 'engine']);
    const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[data-section="${id}"]`)!;
    tab('look').click();
    await flush();
    tab('look').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await flush();
    expect(tab('integrations').getAttribute('aria-selected')).toBe('true');
    tab('integrations').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await flush();
    expect(tab('look').getAttribute('aria-selected')).toBe('true');
  });
});
