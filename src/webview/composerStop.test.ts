// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import {
  capabilities,
  chat,
  composerLayout,
  editor,
  extra,
  handleHostMessage,
  history,
  hudState,
  limits,
} from './store';
import { initialHud } from './hudState';
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

beforeEach(() => {
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m));
  chat.value = { ...initialState(), project: 'p', cwd: '/p', sessionId: 's1' };
  composerLayout.value = 'classic';
  capabilities.value = { models: [], commands: [] };
  editor.value = {};
  extra.value = [];
  history.value = [];
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
});

describe('поле ввода: стоп и очередь во время хода', () => {
  it('вне хода — кнопка отправки, без стопа и подписи очереди', async () => {
    const host = mount();
    await flush();
    expect(host.querySelector('.opts .send')).not.toBeNull();
    expect(host.querySelector('.opts .stopb')).toBeNull();
    expect(host.querySelector('.opts .q')).toBeNull();
  });

  it('в ходе — «в очередь» и стоп вместо отправки; клик по стопу шлёт interrupt', async () => {
    chat.value = { ...chat.value, status: 'working' };
    const host = mount();
    await flush();
    expect(host.querySelector('.opts .send')).toBeNull();
    expect(host.querySelector('.opts .q')?.textContent).toContain('в очередь');
    const stop = host.querySelector<HTMLButtonElement>('.opts .stopb')!;
    expect(stop.textContent).toContain('esc');
    stop.click();
    expect(posted).toContainEqual({ type: 'interrupt', sessionId: 's1' });
  });

  it('стоп возвращает фокус в поле', async () => {
    chat.value = { ...chat.value, status: 'working' };
    const host = mount();
    await flush();
    host.querySelector<HTMLButtonElement>('.opts .stopb')!.focus();
    host.querySelector<HTMLButtonElement>('.opts .stopb')!.click();
    expect(document.activeElement).toBe(host.querySelector('.typed'));
  });

  it('в ходе Enter ставит сообщение в очередь; конец хода не пересоздаёт поле', async () => {
    chat.value = { ...chat.value, status: 'working' };
    const host = mount();
    await flush();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    ed.focus();
    ed.textContent = 'ещё';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(posted).toContainEqual({ type: 'send', sessionId: 's1', text: 'ещё' });
    expect(chat.value.rows.at(-1)).toMatchObject({ kind: 'user', queued: true, text: 'ещё' });
    ed.textContent = 'черновик';
    chat.value = { ...chat.value, status: 'idle' };
    await flush();
    expect(host.querySelector('.opts .send')).not.toBeNull();
    expect(host.querySelector('.typed')).toBe(ed);
    expect(ed.textContent).toBe('черновик');
  });

  it('ожидание ответа (waiting) — обычная отправка: стоп там не нужен', async () => {
    chat.value = { ...chat.value, status: 'waiting' };
    const host = mount();
    await flush();
    expect(host.querySelector('.opts .send')).not.toBeNull();
    expect(host.querySelector('.opts .stopb')).toBeNull();
  });
});

describe('поле ввода: раскладка из настройки', () => {
  it('по умолчанию data-layout=classic', async () => {
    const host = mount();
    await flush();
    expect(host.querySelector('footer.compose')?.getAttribute('data-layout')).toBe('classic');
  });

  it('chat.info с composerLayout меняет data-layout; без поля — classic; DOM один и тот же', async () => {
    const host = mount();
    await flush();
    const before = host.querySelector('footer.compose')!.innerHTML;
    handleHostMessage({
      type: 'chat.info',
      project: 'p',
      cwd: '/p',
      allowBypass: false,
      composerLayout: 'shell',
    });
    await flush();
    const footer = host.querySelector('footer.compose')!;
    expect(footer.getAttribute('data-layout')).toBe('shell');
    expect(footer.innerHTML).toBe(before);
    handleHostMessage({ type: 'chat.info', project: 'p', cwd: '/p', allowBypass: false });
    await flush();
    expect(host.querySelector('footer.compose')?.getAttribute('data-layout')).toBe('classic');
  });
});
