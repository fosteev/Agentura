// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import {
  capabilities,
  chat,
  composerLayout,
  dispatchEvent,
  editor,
  extra,
  features,
  history,
  mcpComposerButton,
  skillFiles,
  handleHostMessage,
  hudState,
  limits,
  newSession,
  tick,
} from './store';
import { initialHud } from './hudState';
import { initialState } from './chatState';
import { providerFeatures } from '../agent/features';
import type { McpServerInfo } from '../agent/types';
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
  composerLayout.value = 'classic';
  features.value = providerFeatures('claude');
  mcpComposerButton.value = true;
  skillFiles.value = new Set();
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
    expect(names).toEqual([
      '/plan',
      '/compact',
      '/clear',
      '/status',
      '/rc',
      '/remote-control',
      '/init',
      '/release-notes',
    ]);
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

  it('composer.prefill: без send — только текст в поле; с send (roadmap 26) — уходит обычной отправкой с файлами', async () => {
    const host = mount();
    handleHostMessage({ type: 'composer.prefill', text: 'просто текст' });
    await flush();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    expect(ed.textContent).toBe('просто текст');
    expect(posted.filter((m) => (m as { type: string }).type === 'send')).toHaveLength(0);
    ed.textContent = '';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    handleHostMessage({
      type: 'file.picked',
      items: [{ name: 'K-1.md', path: 'K-1.md', kind: 'text', data: '# K-1', size: 5 }],
    });
    handleHostMessage({ type: 'composer.prefill', text: 'продолжи', send: true });
    await flush();
    await flush();
    const sent = posted.filter((m) => (m as { type: string }).type === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'send',
      text: 'продолжи',
      files: [{ kind: 'text', path: 'K-1.md', data: '# K-1' }],
    });
    expect(ed.textContent).toBe('');
    // поле живёт на сигналах: не снятое заберёт prefill следующего теста
    render(null, host);
  });

  it('composer.prefill с send в непустое поле — не пишет и не отправляет набранное', async () => {
    const host = mount();
    const ed = type(host, 'моё');
    await flush();
    handleHostMessage({ type: 'composer.prefill', text: 'чужое', send: true });
    await flush();
    await flush();
    expect(ed.textContent).toBe('моё');
    expect(posted.filter((m) => (m as { type: string }).type === 'send')).toHaveLength(0);
    render(null, host);
  });

  it('Д5: автоотправка `/текста` — обычное сообщение с файлами, не локальная команда', async () => {
    const host = mount();
    handleHostMessage({
      type: 'file.picked',
      items: [{ name: 'K-1.md', path: 'K-1.md', kind: 'text', data: '# K-1', size: 5 }],
    });
    handleHostMessage({ type: 'composer.prefill', text: '/clear и продолжи', send: true });
    await flush();
    await flush();
    const sent = posted.filter((m) => (m as { type: string }).type === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: '/clear и продолжи', files: [{ path: 'K-1.md' }] });
    expect(posted.some((m) => (m as { type: string }).type === 'session.new')).toBe(false);
    render(null, host);
  });

  it('Д5: автоотправка при лимите — текст остаётся в поле, в ленте строка почему', async () => {
    limits.value = {
      windows: [{ kind: 'five-hour', percent: 100, resetsAt: Date.now() + 3_600_000 }],
      updatedAt: Date.now(),
    } as typeof limits.value;
    tick.value = Date.now();
    const host = mount();
    handleHostMessage({ type: 'composer.prefill', text: 'продолжи', send: true });
    await flush();
    await flush();
    expect(posted.filter((m) => (m as { type: string }).type === 'send')).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.typed')!.textContent).toBe('продолжи');
    const sys = chat.value.rows.filter((r) => r.kind === 'sys');
    expect(JSON.stringify(sys.at(-1))).toContain('лимит');
    render(null, host);
  });

  it('Д5: автоотправка в закрытую сессию — текст остаётся, строка в ленте', async () => {
    chat.value = { ...chat.value, closed: { reason: 'exit' } };
    const host = mount();
    handleHostMessage({ type: 'composer.prefill', text: 'продолжи', send: true });
    await flush();
    await flush();
    expect(posted.filter((m) => (m as { type: string }).type === 'send')).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.typed')!.textContent).toBe('продолжи');
    expect(JSON.stringify(chat.value.rows.filter((r) => r.kind === 'sys').at(-1))).toContain('сессия закрыта');
    render(null, host);
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

describe('кнопка «mcp N/M» (roadmap 21, этап 3)', () => {
  const srv = (name: string, status: McpServerInfo['status'], extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
    name,
    status,
    ...extra,
  });
  const LIST = [
    srv('serena', 'connected', { version: '1.2.0', tools: 21 }),
    srv('jira', 'connected', { builtin: true }),
    srv('webstorm', 'failed', { error: 'spawn ENOENT' }),
    srv('sentry', 'needs-auth'),
    srv('old', 'disabled'),
  ];
  const withStatus = (servers: McpServerInfo[]) =>
    dispatchEvent({ type: 'mcp.status', servers, at: 1 }, 1);
  const btn = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.mcpb');

  it('в каждой из шести раскладок: «mcp N/M» (N подключено, M без выключенных) и жёлтая точка при сбое', async () => {
    for (const layout of ['classic', 'card', 'gauges', 'minimal', 'statusline', 'shell'] as const) {
      composerLayout.value = layout;
      chat.value = { ...initialState(), project: 'p', cwd: '/p' };
      withStatus(LIST);
      const host = mount();
      await flush();
      expect(host.querySelectorAll('.mcpb'), layout).toHaveLength(1);
      expect(btn(host)!.textContent, layout).toContain('mcp 2/4');
      expect(btn(host)!.querySelector('.d'), layout).not.toBeNull();
      host.remove();
      document.body.innerHTML = '';
    }
  });

  it('без сбоев точки нет; скрыта до статуса, при пустом списке, без features.mcp и при выключенной настройке', async () => {
    const host = mount();
    await flush();
    expect(btn(host)).toBeNull(); // статуса ещё нет
    withStatus([srv('a', 'connected'), srv('b', 'pending')]);
    await flush();
    expect(btn(host)!.textContent).toContain('mcp 1/2');
    expect(btn(host)!.querySelector('.d')).toBeNull();
    withStatus([]);
    await flush();
    expect(btn(host)).toBeNull();
    withStatus(LIST);
    await flush();
    expect(btn(host)).not.toBeNull();
    mcpComposerButton.value = false;
    await flush();
    expect(btn(host)).toBeNull();
    mcpComposerButton.value = true;
    features.value = providerFeatures('antigravity');
    await flush();
    expect(btn(host)).toBeNull();
  });

  it('всплывашка: серверы со статусом, версией, «встроенный», ошибкой; «повторить» шлёт mcp.reconnect; ↻ — mcp.refresh', async () => {
    withStatus(LIST);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    const rows = [...host.querySelectorAll<HTMLElement>('.mcpmenu .srv[data-name]')];
    expect(rows.map((r) => [r.dataset.name, r.dataset.status])).toEqual([
      ['serena', 'connected'],
      ['jira', 'connected'],
      ['webstorm', 'failed'],
      ['sentry', 'needs-auth'],
      ['old', 'disabled'],
    ]);
    expect(rows[0]!.textContent).toContain('v1.2.0');
    expect(rows[0]!.textContent).toContain('21 тул.');
    expect(rows[1]!.textContent).toContain('встроенный');
    expect(rows[2]!.querySelector('.st.fail')).not.toBeNull();
    expect(rows[2]!.querySelector('small.err')!.textContent).toBe('spawn ENOENT');
    rows[2]!.querySelector<HTMLElement>('.act')!.click();
    host.querySelector<HTMLElement>('.mcpmenu .rf')!.click();
    expect(posted).toContainEqual({ type: 'mcp.reconnect', name: 'webstorm' });
    expect(posted).toContainEqual({ type: 'mcp.refresh' });
    // у Claude «перезапустить все» нет
    expect(host.querySelector('.mcpmenu h5 .act')).toBeNull();
  });

  it('тумблер (roadmap 22): у Claude есть, у builtin нет; шлёт mcp.toggle с инверсией; выключенный — .off, «—»; чип источника', async () => {
    withStatus([
      srv('serena', 'connected', { tools: 21, scope: 'user' }),
      srv('agentura_jira', 'connected', { builtin: true, scope: 'user' }),
      srv('figma', 'connected', { scope: 'claudeai' }),
      srv('bare', 'failed', { error: 'x' }),
      srv('old', 'disabled', { scope: 'project' }),
    ]);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    const row = (n: string) => host.querySelector<HTMLElement>(`.mcpmenu .srv[data-name="${n}"]`)!;
    const sw = (n: string) => row(n).querySelector<HTMLButtonElement>('button.tg');
    expect(sw('serena')!.getAttribute('role')).toBe('switch');
    expect(sw('serena')!.getAttribute('aria-checked')).toBe('true');
    expect(sw('serena')!.getAttribute('data-tip')).toContain('Выключить serena в этом проекте');
    expect(sw('bare')).not.toBeNull(); // выключить сломанный — частый случай
    expect(sw('agentura_jira')).toBeNull(); // встроенный: им правит настройка Jira
    expect(row('agentura_jira').classList.contains('tgl')).toBe(true); // место под колонку сохранено
    sw('serena')!.click();
    sw('old')!.click();
    expect(posted).toContainEqual({ type: 'mcp.toggle', name: 'serena', enabled: false });
    expect(posted).toContainEqual({ type: 'mcp.toggle', name: 'old', enabled: true });
    // выключенный: .off, переключатель снят, заметка «выключен», справа «—»
    expect(row('old').classList.contains('off')).toBe(true);
    expect(sw('old')!.getAttribute('aria-checked')).toBe('false');
    expect(sw('old')!.getAttribute('data-tip')).toBe('Включить old в этом проекте');
    expect(row('old').textContent).toContain('выключен');
    expect(row('old').querySelector('.n')!.textContent).toBe('—');
    // чип источника: claudeai → claude.ai, остальное как есть, у встроенного нет
    expect(row('figma').querySelector('.src')!.textContent).toBe('claude.ai');
    expect(row('serena').querySelector('.src')!.textContent).toBe('user');
    expect(row('old').querySelector('.src')!.textContent).toBe('project');
    expect(row('agentura_jira').querySelector('.src')).toBeNull();
    expect(row('bare').querySelector('.src')).toBeNull();
  });

  it('тумблера нет у Codex (чип источника — есть, если scope пришёл)', async () => {
    chat.value = { ...initialState(), project: 'p', cwd: '/p', engine: 'codex' };
    features.value = providerFeatures('codex');
    withStatus([srv('serena', 'connected', { scope: 'user' }), srv('old', 'disabled')]);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    expect(host.querySelector('.mcpmenu .tg')).toBeNull();
    expect(host.querySelector('.mcpmenu .srv.tgl')).toBeNull();
    expect(host.querySelector('.mcpmenu .srv[data-name="serena"] .src')!.textContent).toBe('user');
  });

  it('needs-auth: подсказка входа и «скопировать команду» кладёт команду в буфер; у Codex — codex mcp login', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
      configurable: true,
    });
    withStatus(LIST);
    let host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    expect(host.querySelector('.srv-hint')!.textContent).toContain('/mcp');
    host.querySelector<HTMLElement>('.srv-hint .act')!.click();
    await flush();
    expect(written).toEqual(['/mcp']);
    host.remove();
    document.body.innerHTML = '';
    chat.value = { ...initialState(), project: 'p', cwd: '/p', engine: 'codex' };
    features.value = providerFeatures('codex');
    withStatus([srv('sentry', 'needs-auth'), srv('x', 'failed')]);
    host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    expect(host.querySelector('.srv-hint')!.textContent).toContain('codex mcp login sentry');
    host.querySelector<HTMLElement>('.srv-hint .act')!.click();
    await flush();
    expect(written).toEqual(['/mcp', 'codex mcp login sentry']);
    // Codex: «повторить» по серверу нет, есть «перезапустить все»
    expect(host.querySelector('.srv[data-name="x"] .act')).toBeNull();
    host.querySelector<HTMLElement>('.mcpmenu h5 .act')!.click();
    expect(posted).toContainEqual({ type: 'mcp.reloadAll' });
    // скиллов у Codex нет
    expect(host.querySelector('.mcpmenu .sk')).toBeNull();
  });

  it('«скопировать команду» без буфера: команда строкой в ленту (как ссылка RC)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    withStatus(LIST);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    host.querySelector<HTMLElement>('.srv-hint .act')!.click();
    await flush();
    const last = chat.value.rows[chat.value.rows.length - 1];
    expect(last).toMatchObject({ kind: 'sys' });
    expect(JSON.stringify(last)).toContain('команда: /mcp');
    // подпись не сменилась на «скопировано»
    expect(host.querySelector('.srv-hint .act')!.textContent).toBe('скопировать команду');
  });

  it('раздел скиллов (Claude): вызванные в сессии, «доступно N», «открыть SKILL.md» только при найденном файле', async () => {
    dispatchEvent(
      {
        type: 'session.init',
        sessionId: 's1',
        model: 'm',
        cwd: '/p',
        permissionMode: 'default',
        tools: [],
        slashCommands: [],
        skills: ['plan', 'pohuy:pohuy', 'other'],
        agents: [],
        apiKeySource: 'none',
        engineVersion: '1',
      },
      1,
    );
    withStatus(LIST);
    dispatchEvent({ type: 'tool.start', toolUseId: 'u1', name: 'Skill', input: { skill: 'plan' } }, 2);
    dispatchEvent({ type: 'tool.start', toolUseId: 'u2', name: 'Skill', input: { skill: 'pohuy:pohuy' } }, 3);
    skillFiles.value = new Set(['plan', 'pohuy']);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    const sk = [...host.querySelectorAll<HTMLElement>('.mcpmenu .srv.sk')];
    expect(sk.map((r) => r.dataset.skill)).toEqual(['plan', 'pohuy:pohuy']);
    expect(host.querySelectorAll('.mcpmenu h5')[1]!.textContent).toContain('доступно 3');
    expect(sk[0]!.querySelector('.act')?.textContent).toBe('открыть SKILL.md');
    expect(sk[1]!.querySelector('.act')).toBeNull(); // плагинному ссылки нет
    sk[0]!.querySelector<HTMLElement>('.act')!.click();
    expect(posted).toContainEqual({ type: 'skill.open', name: 'plan' });
    host.querySelector<HTMLElement>('.mcpmenu .more')!.click();
    await flush();
    expect([...host.querySelectorAll('.mcpmenu .allsk .sk1')].map((e) => e.textContent)).toEqual([
      'plan',
      'pohuy:pohuy',
      'other',
    ]);
  });

  it('кнопка пропала при открытой всплывашке — меню закрыто и не открывается само, когда кнопка вернётся', async () => {
    withStatus(LIST);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    expect(host.querySelector('.mcpmenu')).not.toBeNull();
    mcpComposerButton.value = false;
    await flush();
    expect(btn(host)).toBeNull();
    mcpComposerButton.value = true;
    await flush();
    expect(btn(host)).not.toBeNull();
    expect(host.querySelector('.mcpmenu')).toBeNull();
    expect(btn(host)!.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape закрывает всплывашку', async () => {
    withStatus(LIST);
    const host = mount();
    await flush();
    btn(host)!.click();
    await flush();
    expect(host.querySelector('.mcpmenu')).not.toBeNull();
    key(document.body, 'Escape');
    await flush();
    expect(host.querySelector('.mcpmenu')).toBeNull();
  });
});
