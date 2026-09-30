// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import {
  capabilities,
  chat,
  dispatchEvent,
  editor,
  extra,
  history,
  handleHostMessage,
  hudState,
  limits,
  newSession,
  tick,
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
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
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

  it('«@»: хиты прошлого запроса не видны и не вставляются, пока не пришёл ответ на новый', async () => {
    const host = mount();
    type(host, '@Cou');
    await flush();
    const first = posted.find((m) => (m as { type: string }).type === 'files.find') as {
      requestId: number;
    };
    handleHostMessage({
      type: 'files.result',
      requestId: first.requestId,
      items: [{ path: 'src/Counter.tsx', name: 'Counter.tsx', dir: 'src', isDir: false }],
    });
    await flush();
    expect(host.querySelector('.menu .it')).not.toBeNull();
    const ed = type(host, '@Xyz');
    await flush();
    expect(host.querySelector('.menu .it')).toBeNull();
    key(ed, 'Tab');
    await flush();
    expect(ed.textContent).toBe('@Xyz');
    render(null, host); // иначе живой компонент дошлёт files.find в следующий тест
  });

  it('новая сессия: запоздавшие события брошенной не попадают в ленту', () => {
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'old',
      event: { type: 'session.title', title: 'старая' },
    });
    chat.value = { ...chat.value, sessionId: 'old' };
    newSession();
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'old',
      event: { type: 'session.title', title: 'запоздала' },
    });
    expect(chat.value.title).toBeUndefined();
    handleHostMessage({
      type: 'agent.event',
      sessionId: 'new',
      event: { type: 'session.title', title: 'новая' },
    });
    expect(chat.value.title).toBe('новая');
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

  it('история: своя команда из истории (/status) сбрасывает позицию истории', async () => {
    history.value = ['/status '];
    const host = mount();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    key(ed, 'ArrowUp');
    await flush();
    expect(host.querySelector('.note')).not.toBeNull();
    key(ed, 'Enter');
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

describe('приборы у поля ввода — живые значения', () => {
  it('контекст: число, шкала из 20 блоков, цвет по порогу; «сжать» шлёт compact', () => {
    const host = mount();
    dispatchEvent({
      type: 'context.usage',
      usedTokens: 160_000,
      maxTokens: 200_000,
      source: 'engine',
    });
    return flush().then(() => {
      const cn = host.querySelector('.ctx .cn')!;
      expect(cn.querySelector('b')?.textContent).toBe('160 000');
      expect(cn.querySelector('b')?.className).toBe('hot');
      expect(cn.textContent).toContain('/ 200 000');
      expect(cn.textContent).toContain('порог 150k пройден');
      expect(host.querySelectorAll('.blocks i')).toHaveLength(20);
      expect(host.querySelectorAll('.blocks i.on')).toHaveLength(16);
      host.querySelector<HTMLButtonElement>('.ctx .cn button')!.click();
      expect(posted).toContainEqual({ type: 'compact', sessionId: '' });
    });
  });

  it('кэш: таймер по тику и доля попаданий; лимит 5ч — проценты, ячейки, красный на 100 %', async () => {
    const host = mount();
    dispatchEvent(
      {
        type: 'session.init',
        sessionId: 's',
        model: 'm',
        cwd: '/p',
        permissionMode: 'default',
        tools: [],
        slashCommands: [],
        skills: [],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1',
      },
      0,
    );
    dispatchEvent(
      {
        type: 'usage.message',
        messageId: 'a',
        model: 'm',
        final: true,
        at: 10_000,
        usage: { input: 10, output: 1, cacheRead: 80, cacheWrite: 10 },
      },
      10_000,
    );
    dispatchEvent(
      {
        type: 'turn.result',
        ok: true,
        subtype: 'success',
        interrupted: false,
        durationMs: 1,
        apiDurationMs: 1,
        numTurns: 1,
        usage: { input: 10, output: 1, cacheRead: 80, cacheWrite: 10 },
        totalCostUsd: 0.1,
        permissionDenials: [],
      },
      10_000,
    );
    tick.value = 10_000 + 252_000;
    handleHostMessage({
      type: 'limits.update',
      windows: [{ kind: 'five-hour', percent: 100, resetsAt: 0 }],
      updatedAt: 1,
    });
    await flush();
    const m = [...host.querySelectorAll('.meters .m')];
    expect(m[0]!.textContent).toContain('кэш');
    expect(m[0]!.querySelectorAll('b')[0]!.textContent).toBe('55:48');
    expect(m[0]!.querySelectorAll('b')[1]!.textContent).toBe('80%');
    expect(m[1]!.textContent).toContain('5ч');
    expect(m[1]!.querySelector('b')!.className).toBe('pct full');
    expect(m[1]!.querySelectorAll('.cells i.on.f')).toHaveLength(10);
    expect(m[1]!.className).toContain('lim-full');
  });
});
