// @vitest-environment jsdom
/**
 * Remote Control в webview (roadmap 17, этап 2): кнопка «rc» и меню во всех раскладках поля ввода, `/rc`, метка в
 * шапке, системные строки на переходы, отметка «с телефона» у реплик, закрытие карточки ответом с claude.ai.
 */
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerFeatures } from '../agent/features';
import type { AgentEvent } from '../agent/types';
import { applyEvent, initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import {
  capabilities,
  chat,
  composerLayout,
  dispatchEvent,
  editor,
  extra,
  features,
  handleHostMessage,
  history,
  hudState,
  limits,
} from './store';
import * as vscode from './vscode';

const flush = () => new Promise((r) => setTimeout(r, 120));
const posted: unknown[] = [];
const mounted: HTMLElement[] = [];
const URL = 'https://claude.ai/code/session_abc123';

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
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

const enter = (el: HTMLElement) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

const remote = (e: Omit<Extract<AgentEvent, { type: 'remote.state' }>, 'type'>) =>
  dispatchEvent({ type: 'remote.state', ...e } as AgentEvent);

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m));
  chat.value = { ...initialState(), project: 'p', cwd: '/p', sessionId: 's1', title: 'Мигание' };
  features.value = providerFeatures('claude');
  composerLayout.value = 'classic';
  capabilities.value = { models: [], commands: [] };
  editor.value = {};
  extra.value = [];
  history.value = [];
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
});

const LAYOUTS = ['classic', 'card', 'gauges', 'minimal', 'statusline', 'shell'] as const;
const sysTexts = (host: HTMLElement) =>
  [...host.querySelectorAll('.log .sys > span:nth-child(2)')].map((e) => e.textContent ?? '');

describe('кнопка «rc»', () => {
  it.each(LAYOUTS)('раскладка %s: кнопка у Claude, значение «выкл»', async (layout) => {
    composerLayout.value = layout;
    const host = mount();
    await flush();
    const btn = host.querySelector('footer.compose .rc');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('rc выкл');
  });

  it('у Codex и Antigravity кнопки нет', async () => {
    for (const p of ['codex', 'antigravity'] as const) {
      features.value = providerFeatures(p);
      const host = mount();
      await flush();
      expect(host.querySelector('.rc')).toBeNull();
    }
  });

  it('значение следует за состоянием моста: … / вкл / ошибка', async () => {
    const host = mount();
    remote({ state: 'connecting' });
    await flush();
    expect(host.querySelector('.rc')?.textContent).toBe('rc …');
    remote({ state: 'on', url: URL });
    await flush();
    expect(host.querySelector('.rc.on')?.textContent).toBe('rc вкл');
    remote({ state: 'error', error: 'network' });
    await flush();
    expect(host.querySelector('.rc.error')?.textContent).toBe('rc ошибка');
  });

  it('клик по переключателю в меню шлёт remote.set; при «вкл» — выключение', async () => {
    const host = mount();
    host.querySelector<HTMLElement>('.rc')!.click();
    await flush();
    expect(host.querySelector('.rcmenu .hd')?.textContent).toBe('Remote Control · эта сессия');
    host.querySelector<HTMLElement>('.rcmenu [role="menuitemcheckbox"]')!.click();
    expect(posted).toEqual([{ type: 'remote.set', sessionId: 's1', on: true }]);
    remote({ state: 'on', url: URL });
    await flush();
    posted.length = 0;
    host.querySelector<HTMLElement>('.rcmenu [role="menuitemcheckbox"]')!.click();
    expect(posted).toEqual([{ type: 'remote.set', sessionId: 's1', on: false }]);
  });

  it('меню при «вкл»: QR, открыть, скопировать (без буфера — строкой в ленту)', async () => {
    const host = mount();
    remote({ state: 'on', url: URL });
    host.querySelector<HTMLElement>('.rc')!.click();
    await flush();
    const svg = host.querySelector('.rcmenu .qr svg')!;
    expect(svg.getAttribute('viewBox')).toMatch(/^-4 -4 \d+ \d+$/);
    expect(svg.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100);
    expect(host.querySelector('.rcmenu .qr p')?.textContent).toContain('«Мигание»');
    const items = [...host.querySelectorAll<HTMLElement>('.rcmenu .it[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      'Открыть на claude.ai/code↗',
      'Скопировать ссылкуссылка',
    ]);
    items[0]!.click();
    expect(posted).toContainEqual({ type: 'link.open', url: URL });
    host.querySelectorAll<HTMLElement>('.rcmenu .it[role="menuitem"]')[1]!.click();
    await flush();
    expect(sysTexts(host)).toContain(`ссылка: ${URL}`);
  });

  it('меню при ошибке: причина и «Повторить»', async () => {
    const host = mount();
    remote({ state: 'error', error: 'rejected', detail: '403' });
    host.querySelector<HTMLElement>('.rc')!.click();
    await flush();
    expect(host.querySelector('.rcmenu .nt.err')?.textContent).toBe(
      'claude.ai отклонил подключение (403)',
    );
    expect(host.querySelector('.rcmenu .qr')).toBeNull();
    const retry = [...host.querySelectorAll<HTMLElement>('.rcmenu .it')].find((i) =>
      i.textContent?.includes('Повторить'),
    )!;
    retry.click();
    expect(posted).toEqual([{ type: 'remote.set', sessionId: 's1', on: true }]);
  });
});

describe('/rc и /remote-control', () => {
  it.each(['/rc', '/remote-control'])('%s шлёт remote.set и не уходит движком', async (cmd) => {
    const host = mount();
    const ed = type(host, `${cmd} `);
    await flush();
    enter(ed);
    await flush();
    expect(posted).toEqual([{ type: 'remote.set', sessionId: 's1', on: true }]);
  });

  it('при включённом мосте /rc выключает', async () => {
    const host = mount();
    remote({ state: 'on', url: URL });
    const ed = type(host, '/rc ');
    await flush();
    enter(ed);
    await flush();
    expect(posted).toEqual([{ type: 'remote.set', sessionId: 's1', on: false }]);
  });

  it('у Codex команды нет в меню, а набранная отвечает «недоступна»', async () => {
    features.value = providerFeatures('codex');
    const host = mount();
    const ed = type(host, '/');
    await flush();
    const names = [...host.querySelectorAll('.menu .it')].map(
      (i) => i.firstElementChild?.firstChild?.textContent,
    );
    expect(names).not.toContain('/rc');
    type(host, '/rc ');
    await flush();
    enter(ed);
    await flush();
    expect(posted).toEqual([]);
    expect(sysTexts(host)).toContain('/rc недоступна для этого агента');
  });
});

describe('шапка и лента', () => {
  it('on: метка «remote» со ссылкой в подсказке, клик открывает ссылку; off — метки нет', async () => {
    const host = mount();
    expect(host.querySelector('.hud .rcb')).toBeNull();
    remote({ state: 'on', url: URL });
    await flush();
    const badge = host.querySelector<HTMLElement>('.hud .rcb')!;
    expect(badge.textContent).toBe('remote');
    expect(badge.getAttribute('data-tip')).toBe(URL);
    badge.click();
    expect(posted).toContainEqual({ type: 'link.open', url: URL });
    remote({ state: 'off' });
    await flush();
    expect(host.querySelector('.hud .rcb')).toBeNull();
  });

  it('системные строки: включён, выключен (только после on), причина ошибки; повтор того же — без дубля', async () => {
    const host = mount();
    remote({ state: 'connecting' });
    remote({ state: 'on', url: URL });
    remote({ state: 'on', url: URL });
    remote({ state: 'off' });
    remote({ state: 'off' });
    remote({ state: 'error', error: 'no-token' });
    remote({ state: 'error', error: 'no-token' });
    remote({ state: 'off', error: 'superseded' });
    await flush();
    expect(sysTexts(host)).toEqual([
      'Remote Control включён · claude.ai/code/session_abc123',
      'Remote Control выключен',
      'нет входа Claude Code — выполните claude login',
      'сессию подхватил другой процесс',
    ]);
  });

  it('remote.prompt помечает реплику «с телефона» / «с claude.ai» (до хода и после)', async () => {
    const host = mount();
    dispatchEvent({
      type: 'remote.prompt',
      uuid: 'u1',
      text: 'Добавь тест',
      from: 'phone',
    } as AgentEvent);
    dispatchEvent({
      type: 'turn.start',
      at: 1_700_000_000_000,
      prompt: 'Добавь тест',
    } as AgentEvent);
    // ход начался раньше события
    dispatchEvent({ type: 'turn.start', at: 1_700_000_100_000, prompt: 'Ещё' } as AgentEvent);
    dispatchEvent({ type: 'remote.prompt', uuid: 'u2', text: 'Ещё', from: 'web' } as AgentEvent);
    // обычная реплика отметки не получает
    dispatchEvent({ type: 'turn.start', at: 1_700_000_200_000, prompt: 'Своя' } as AgentEvent);
    await flush();
    const ats = [...host.querySelectorAll('.log .u .at')].map((e) => e.textContent ?? '');
    expect(ats[0]).toMatch(/^с телефона ·\d\d:\d\d$/);
    expect(ats[1]).toMatch(/^с claude\.ai ·\d\d:\d\d$/);
    expect(ats[2]).toMatch(/^\d\d:\d\d$/);
    expect(chat.value.remotePrompts).toBeUndefined();
  });

  it('session.reset сбрасывает состояние remote без строки в ленте', async () => {
    const host = mount();
    remote({ state: 'on', url: URL });
    await flush();
    expect(host.querySelector('.hud .rcb')).not.toBeNull();
    handleHostMessage({ type: 'session.reset' });
    await flush();
    expect(chat.value.remote).toBeUndefined();
    expect(host.querySelector('.hud .rcb')).toBeNull();
    expect(host.querySelector('.rc')?.textContent).toBe('rc выкл');
    expect(sysTexts(host).join('')).not.toContain('выключен');
  });
});

describe('разрешения с claude.ai', () => {
  it('permission.resolved by remote закрывает карточку так же, как by user', () => {
    const req = {
      type: 'permission.request',
      toolUseId: 'p1',
      toolName: 'Bash',
      input: {},
      canAlwaysAllow: false,
    } as unknown as AgentEvent;
    const resolved = (by: 'user' | 'remote') =>
      applyEvent(
        applyEvent(initialState(), req, 1),
        {
          type: 'permission.resolved',
          toolUseId: 'p1',
          decision: 'allow',
          by,
        } as AgentEvent,
        2,
      );
    expect(resolved('remote').rows).toEqual(resolved('user').rows);
    expect(resolved('remote').rows.some((r) => r.kind === 'perm')).toBe(false);
    expect(resolved('remote').pending).toEqual([]);
  });
});
