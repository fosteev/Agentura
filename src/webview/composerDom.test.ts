// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import { hud } from './fixtures/chat';
import { capabilities, chat, editor, extra, history, handleHostMessage } from './store';
import { initialState } from './chatState';
import * as vscode from './vscode';

const posted: unknown[] = [];

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  render(h(Composer, { hud }), host);
  return host;
}

// эффекты Preact выполняются после отрисовки (rAF или таймер до 100 мс)
const flush = () => new Promise((r) => setTimeout(r, 120));

function type(host: HTMLElement, text: string) {
  const ed = host.querySelector<HTMLElement>('.typed')!;
  ed.focus();
  ed.textContent = text;
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  return ed;
}

function key(el: HTMLElement, k: string, opts: KeyboardEventInit = {}) {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }),
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m));
  chat.value = { ...initialState(), project: 'p', cwd: '/p' };
  capabilities.value = { models: [], commands: [] };
  editor.value = {};
  extra.value = [];
  history.value = [];
});

describe('поле ввода', () => {
  it('каркас: шкала, чипы, поле, строка настроек с приборами и отправкой', () => {
    const host = mount();
    const f = host.querySelector('footer.compose')!;
    expect([...f.children].map((c) => c.className)).toEqual(['blocks', 'ctx', 'pop', 'opts']);
    expect(f.querySelector('.ctx .cn')).not.toBeNull();
    expect(f.querySelector('.prompt .p')?.textContent).toBe('$');
    expect(f.querySelector('.typed')?.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(f.querySelector('.typed')?.getAttribute('data-placeholder')).toBe(
      'задача, @файл, /команда',
    );
    expect(
      f.querySelectorAll('.opts .mode, .opts .agent, .opts .meters, .opts .send'),
    ).toHaveLength(4);
    expect(f.querySelector('.opts .mode')?.textContent).toBe('режим manual');
  });

  it('Enter отправляет, Shift+Enter нет; сообщение встаёт в очередь ленты', async () => {
    const host = mount();
    const ed = type(host, 'привет');
    await flush();
    key(ed, 'Enter', { shiftKey: true });
    expect(posted).toHaveLength(0);
    key(ed, 'Enter');
    await flush();
    expect(posted).toEqual([{ type: 'send', sessionId: '', text: 'привет' }]);
    expect(chat.value.rows[0]).toMatchObject({ kind: 'user', queued: true, text: 'привет' });
    expect(ed.textContent).toBe('');
  });

  it('меню «/»: своя команда видна, фильтр по набранному, Enter подставляет команду', async () => {
    chat.value = { ...chat.value, slashCommands: ['init'], skills: ['release-notes'] };
    const host = mount();
    const ed = type(host, '/');
    await flush();
    const names = [...host.querySelectorAll('.menu .it')].map(
      (i) => i.firstElementChild?.firstChild?.textContent,
    );
    expect(names).toEqual(['/plan', '/compact', '/clear', '/status', '/init', '/release-notes']);
    expect(host.querySelector('.menu .hd')?.textContent).toBe('команды');
    expect(host.querySelectorAll('.menu .hd')).toHaveLength(2); // команды + скиллы проекта
    type(host, '/pl');
    await flush();
    expect(host.querySelectorAll('.menu .it')).toHaveLength(1);
    key(ed, 'Enter');
    await flush();
    expect(ed.textContent).toBe('/plan ');
    expect(posted).toHaveLength(0);
  });

  it('«/clear» не уходит движку, а начинает новую сессию', async () => {
    const host = mount();
    const ed = type(host, '/clear ');
    await flush();
    key(ed, 'Enter');
    await flush();
    expect(posted).toEqual([{ type: 'session.new' }]);
  });

  it('«/plan» переключает режим и пишет строку в ленту', async () => {
    const host = mount();
    const ed = type(host, '/plan ');
    await flush();
    key(ed, 'Enter');
    expect(posted).toEqual([{ type: 'mode.set', sessionId: '', mode: 'plan' }]);
    expect(chat.value.mode).toBe('plan');
    expect(chat.value.rows.at(-1)?.kind).toBe('sys');
  });

  it('«@»: запрос файлов к хосту и выбор результата', async () => {
    const host = mount();
    const ed = type(host, 'смотри @Cou');
    await flush();
    expect(posted).toContainEqual({ type: 'files.find', requestId: 1, query: 'Cou' });
    handleHostMessage({
      type: 'files.result',
      requestId: 1,
      items: [{ path: 'src/Counter.tsx', name: 'Counter.tsx', dir: 'src', isDir: false }],
    });
    await flush();
    expect(host.querySelector('.menu .it')?.textContent).toBe('Counter.tsxsrcфайл');
    key(ed, 'Tab');
    await flush();
    expect(ed.textContent).toBe('смотри @src/Counter.tsx ');
  });

  it('автоконтекст: чипы из редактора, крестик снимает, отправка несёт вложения', async () => {
    handleHostMessage({
      type: 'editor.context',
      file: { path: 'src/Counter.tsx', name: 'Counter.tsx' },
      selection: { path: 'src/Counter.tsx', name: 'Counter.tsx', startLine: 12, endLine: 40 },
    });
    const host = mount();
    await flush();
    const chips = [...host.querySelectorAll('.ctx .auto')].map((c) => c.textContent);
    expect(chips).toEqual(['открыт Counter.tsx✕', 'выделение 12–40✕']);
    host.querySelectorAll<HTMLElement>('.ctx .auto .x')[0]!.click();
    await flush();
    expect(host.querySelectorAll('.ctx .auto')).toHaveLength(1);
    const ed = type(host, 'поправь');
    await flush();
    key(ed, 'Enter');
    expect(posted.find((m) => (m as { type: string }).type === 'send')).toMatchObject({
      type: 'send',
      attachments: [{ kind: 'selection', path: 'src/Counter.tsx', startLine: 12, endLine: 40 }],
    });
  });

  it('история: ↑ в пустом поле листает отправленное, Esc очищает', async () => {
    history.value = ['первое', 'второе'];
    const host = mount();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    key(ed, 'ArrowUp');
    await flush();
    expect(ed.textContent).toBe('второе');
    expect(host.querySelector('.note')?.textContent).toBe(
      'история 2 из 2 · ↑ старше · ↓ новее · esc — очистить',
    );
    key(ed, 'ArrowUp');
    await flush();
    expect(ed.textContent).toBe('первое');
    key(ed, 'Escape');
    await flush();
    expect(ed.textContent).toBe('');
    expect(host.querySelector('.note')).toBeNull();
  });

  it('закрытая сессия: поле недоступно, отправка не идёт', async () => {
    chat.value = { ...chat.value, closed: { reason: 'exit' } };
    const host = mount();
    expect(host.querySelector('footer')?.className).toBe('compose off');
    expect(host.querySelector('.typed')?.getAttribute('contenteditable')).toBe('false');
    expect(host.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true);
  });

  it('меню режима: bypass недоступен без настройки; выбор шлёт mode.set', async () => {
    const host = mount();
    host.querySelector<HTMLElement>('.opts .mode')!.click();
    await flush();
    const items = [...host.querySelectorAll('.menu .it')];
    expect(items.map((i) => i.classList.contains('dis'))).toEqual([false, false, false, true]);
    (items[1] as HTMLElement).click();
    expect(posted).toEqual([{ type: 'mode.set', sessionId: '', mode: 'acceptEdits' }]);
  });
});
