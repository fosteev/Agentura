// @vitest-environment jsdom
/**
 * Вкладка «git» в DOM (roadmap 12, этап 2): снимок → строки, действия → запросы хосту, фильтр «агент», дерево,
 * поле коммита, пустые состояния, `git.watch` по видимости вкладки. Эталон разметки — `prototype/shared/git.js`.
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import type { GitRepoView, GitSnapshot } from '../shared/git';
import type { FromWebview } from '../protocol';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import {
  chat,
  dispatchEvent,
  GIT_UNIFIED,
  gitCommitted,
  gitDrafts,
  gitErrors,
  gitGenerating,
  gitTargets,
  gitSnapshot,
  handleHostMessage,
  sendMessage,
} from './store';
import * as vscode from './vscode';

let stored: unknown;
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState: () => stored,
  setState: (s: unknown) => {
    stored = s;
  },
});

const flush = () => new Promise((r) => setTimeout(r, 30));
const mounted: HTMLElement[] = [];
const sent: FromWebview[] = [];
const q = <T extends Element = HTMLElement>(host: Element, sel: string) =>
  host.querySelector(sel) as T;
const qa = <T extends Element = HTMLElement>(host: Element, sel: string) => [
  ...host.querySelectorAll<T>(sel),
];
const gitSent = () => sent.filter((m) => m.type.startsWith('git.') && m.type !== 'git.watch');

function mount(): HTMLElement {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

function repo(over: Partial<GitRepoView> = {}): GitRepoView {
  return {
    root: '/w',
    rel: '',
    name: 'w',
    branch: 'fix/board',
    upstream: 'origin/fix/board',
    ahead: 2,
    behind: 0,
    published: true,
    unstaged: [
      { path: 'src/Counter.tsx', status: 'M', add: 6, del: 2 },
      { path: 'src/new.test.ts', status: 'U', add: 31, del: 0 },
      { path: '.env.local', status: 'M', add: 1, del: 1 },
    ],
    staged: [
      { path: 'lib/backoff.ts', status: 'A', add: 40, del: 0 },
      { path: 'lib/reconnect.ts', status: 'M', add: 27, del: 7 },
    ],
    log: [
      { hash: 'a3f91c2', subject: 'Reconnect: backoff', at: 0, unpushed: true },
      { hash: '19d07fe', subject: 'Ticket list virtualized', at: 0, unpushed: false },
    ],
    ...over,
  };
}
const ok = (...repos: GitRepoView[]): GitSnapshot => ({ state: 'ok', repos });
const push = (snapshot: GitSnapshot) => {
  handleHostMessage({ type: 'git.state', snapshot });
};

/** Непустая сессия (вкладки панели в пустой отключены) и правка агента в `src/Counter.tsx`. */
function session(): void {
  chat.value = { ...initialState(), cwd: '/w' };
  const at = Date.now();
  sendMessage('go', false);
  dispatchEvent({ type: 'turn.start', at, prompt: 'go' } as unknown as AgentEvent, at);
  dispatchEvent(
    {
      type: 'tool.start',
      toolUseId: 'e1',
      name: 'Edit',
      input: { file_path: '/w/src/Counter.tsx', old_string: 'x', new_string: 'y' },
      at,
    } as unknown as AgentEvent,
    at,
  );
  dispatchEvent(
    {
      type: 'tool.result',
      toolUseId: 'e1',
      isError: false,
      content: 'ok',
      durationMs: 5,
    } as unknown as AgentEvent,
    at,
  );
}

async function open(snapshot?: GitSnapshot): Promise<HTMLElement> {
  stored = { panel: { tab: 'git' } };
  session();
  if (snapshot) push(snapshot);
  const host = mount();
  await flush();
  return host;
}

beforeEach(async () => {
  vi.spyOn(vscode, 'send').mockImplementation((m) => void sent.push(m));
  // размонтирование прошлого теста шлёт git.watch off — это не его запросы
  for (const host of mounted.splice(0)) render(null, host);
  // preact откладывает cleanup эффектов: дождаться, иначе `off` прошлого теста попадёт в этот
  await flush();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-width');
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  stored = undefined;
  sent.length = 0;
  chat.value = initialState();
  gitSnapshot.value = undefined;
  gitErrors.value = {};
  gitDrafts.value = {};
  gitTargets.value = {};
  gitCommitted.value = [];
  gitGenerating.value = {};
  handleHostMessage({ type: 'chat.info', project: 'w', cwd: '/w', allowBypass: false });
});
afterEach(() => vi.restoreAllMocks());

describe('вкладка «git»: вид', () => {
  it('третья вкладка панели между «изменения» и «агенты», бейдж — число файлов', async () => {
    const host = await open(ok(repo()));
    const t = qa(host, '.ptabs [role="tab"]');
    expect(t.map((x) => x.id)).toEqual(['ptab-changes', 'ptab-git', 'ptab-agents']);
    expect(q(host, '.pane.side').getAttribute('data-active')).toBe('git');
    expect(q(host, '#pane-git').hidden).toBe(false);
    expect(q(host, '#pane-git').getAttribute('aria-labelledby')).toBe('ptab-git');
    expect(t[1]!.querySelector('.b')?.textContent).toBe('5');
  });

  it('без снимка — «git загружается…», без бейджа', async () => {
    const host = await open();
    expect(q(host, '#pane-git').textContent).toContain('git загружается');
    expect(qa(host, '.ptabs [role="tab"]')[1]!.querySelector('.b')).toBeNull();
  });

  it('none и unavailable: сообщение, причина хоста как есть, бейджа нет', async () => {
    let host = await open({ state: 'none', repos: [] });
    expect(q(host, '#pane-git').textContent).toContain('Репозиториев нет');
    expect(q(host, '#pane-git').textContent).toContain('repositoryScanMaxDepth');
    push({ state: 'unavailable', reason: 'Расширение git выключено', repos: [] });
    await flush();
    host = mounted[0]!;
    expect(q(host, '#pane-git').textContent).toContain('git недоступен');
    expect(q(host, '#pane-git').textContent).toContain('Расширение git выключено');
    expect(qa(host, '.ptabs [role="tab"]')[1]!.querySelector('.b')).toBeNull();
  });

  it('один репозиторий: шапка, секции, строки со статусом и +/−, последние коммиты', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    expect(q(pane, '.gh .rn').textContent).toBe('w');
    expect(q(pane, '.gh .br').textContent).toContain('fix/board');
    expect(q(pane, '.gh .sync').textContent).toContain('↑2');
    const sections = qa(pane, '.sh');
    expect(sections.map((s) => s.querySelector('.tt')?.textContent)).toEqual([
      'неиндексированные',
      'в индексе',
    ]);
    expect(sections.map((s) => s.querySelector('.n')?.textContent)).toEqual(['3', '2']);
    const files = qa(pane, '.f');
    expect(files.map((f) => f.getAttribute('data-path'))).toEqual([
      '.env.local',
      'src/Counter.tsx',
      'src/new.test.ts',
      'lib/backoff.ts',
      'lib/reconnect.ts',
    ]);
    const counter = files[1]!;
    expect(counter.classList.contains('s-M')).toBe(true);
    expect(q(counter, '.nm b').textContent).toBe('Counter.tsx');
    expect(q(counter, '.nm .d').textContent).toBe('src/');
    expect(q(counter, '.ch').textContent).toBe('+6 −2');
    expect(q(counter, '.st').textContent).toBe('M');
    expect(files[2]!.classList.contains('s-U')).toBe(true);
    expect(qa(pane, '.hs .c').map((c) => c.classList.contains('up'))).toEqual([true, false]);
    expect(q(pane, '.bar').textContent).toContain('5 изменений');
  });

  it('метка агента — только у файла из правок ленты; чип «агент 1» фильтрует', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    const dots = qa(pane, '.f').map((f) => !!f.querySelector('.adot'));
    expect(dots).toEqual([false, true, false, false, false]);
    const chip = q(pane, '.flt');
    expect(chip.textContent).toContain('агент 1');
    chip.click();
    await flush();
    expect(qa(pane, '.f').map((f) => f.getAttribute('data-path'))).toEqual(['src/Counter.tsx']);
    expect(q(pane, '.flt').getAttribute('aria-pressed')).toBe('true');
    expect(qa(pane, '.empty').map((e) => e.textContent)).toEqual(['нет файлов агента']);
    expect(stored).toMatchObject({ panel: { gitAgent: true } });
  });

  it('дерево: папки строками, файлы с отступом, выбор сохраняется в panel.gitTree', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    qa(pane, '.seg button')[1]!.click();
    await flush();
    expect(stored).toMatchObject({ panel: { gitTree: true } });
    expect(qa(pane, '.dr').map((d) => d.textContent)).toEqual(['▾src', '▾lib']);
    const f = qa(pane, '.f.tr');
    expect(f).toHaveLength(5);
    expect(q(f[1]!, '.nm .d')).toBeNull();
    expect(f[1]!.style.getPropertyValue('--lv')).toBe('1');
    qa(pane, '.seg button')[0]!.click();
    await flush();
    expect(qa(pane, '.dr')).toHaveLength(0);
  });

  it('несколько репозиториев — стопкой: свои шапки, секции и поле коммита', async () => {
    const b = repo({ root: '/w/b', rel: 'b', name: 'b', unstaged: [], staged: [], log: [] });
    const a = repo({ root: '/w/a', rel: 'a', name: 'a' });
    const host = await open(ok(a, b));
    const pane = q(host, '#pane-git');
    expect(q(pane, '.ws').textContent).toContain('2 репозитория');
    expect(qa(pane, '.rh .nm').map((n) => n.textContent)).toEqual(['a', 'b']);
    expect(q(qa(pane, '.rh')[1]!, '.clean')).not.toBeNull();
    // стопка: у репозитория с файлами поле коммита строкой, у чистого его нет
    expect(qa(pane, '.cml')).toHaveLength(1);
    expect(qa(pane, '.cm')).toHaveLength(0);
    qa(pane, '.f')[0]!.click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.open', root: '/w/a' });
  });
});

describe('вкладка «git»: действия', () => {
  it('клик по «+» шлёт git.stage, по «−» — git.unstage, «отменить» — git.discard, строка — git.open', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    const rows = qa(pane, '.f');
    const btn = (row: Element, label: string) =>
      qa<HTMLButtonElement>(row, '.acts .ib').find((b) => b.getAttribute('aria-label') === label)!;
    btn(rows[1]!, 'В индекс').click();
    expect(gitSent().at(-1)).toEqual({ type: 'git.stage', root: '/w', paths: ['src/Counter.tsx'] });
    btn(rows[1]!, 'Отменить изменения').click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.discard',
      root: '/w',
      paths: ['src/Counter.tsx'],
    });
    btn(rows[3]!, 'Убрать из индекса').click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.unstage',
      root: '/w',
      paths: ['lib/backoff.ts'],
    });
    expect(btn(rows[3]!, 'Открыть файл')).toBeTruthy();
    expect(
      qa(rows[3]!, '.acts .ib').some((b) => b.getAttribute('aria-label') === 'Отменить изменения'),
    ).toBe(false);
    btn(rows[1]!, 'Открыть файл').click();
    expect(gitSent().at(-1)).toEqual({ type: 'git.openFile', root: '/w', path: 'src/Counter.tsx' });
    // клик по кнопке не открывает дифф строки
    expect(gitSent().filter((m) => m.type === 'git.open')).toHaveLength(0);
    rows[1]!.click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.open',
      root: '/w',
      path: 'src/Counter.tsx',
      staged: false,
    });
    rows[3]!.click();
    expect(gitSent().at(-1)).toMatchObject({
      type: 'git.open',
      path: 'lib/backoff.ts',
      staged: true,
    });
  });

  it('«+ все в индекс» и «− все» шлют все пути секции', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    const [stageAll, unstageAll] = qa<HTMLButtonElement>(pane, '.sh .all');
    stageAll!.click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.stage',
      root: '/w',
      paths: ['src/Counter.tsx', 'src/new.test.ts', '.env.local'],
    });
    unstageAll!.click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.unstage',
      root: '/w',
      paths: ['lib/backoff.ts', 'lib/reconnect.ts'],
    });
  });

  it('ветка, fetch / pull / push шлют git.branch и git.sync с root', async () => {
    const host = await open(ok(repo({ published: false })));
    const pane = q(host, '#pane-git');
    q(pane, '.gh .br').click();
    expect(gitSent().at(-1)).toEqual({ type: 'git.branch', root: '/w' });
    const sync = qa<HTMLButtonElement>(pane, '.gh .sb .ib');
    sync.forEach((b) => b.click());
    expect(gitSent().slice(-3)).toEqual([
      { type: 'git.sync', root: '/w', op: 'fetch' },
      { type: 'git.sync', root: '/w', op: 'pull' },
      { type: 'git.sync', root: '/w', op: 'push' },
    ]);
    expect(q(pane, '.gh .unpub')).not.toBeNull();
  });

  it('busy гасит кнопки репозитория', async () => {
    const host = await open(ok(repo({ busy: 'pull' })));
    const pane = q(host, '#pane-git');
    expect(qa<HTMLButtonElement>(pane, '.gh .sb .ib').every((b) => b.disabled)).toBe(true);
    expect(q<HTMLButtonElement>(pane, '.cm .go .main').disabled).toBe(true);
    expect(qa<HTMLButtonElement>(pane, '.sh .all').every((b) => b.disabled)).toBe(true);
  });
});

describe('вкладка «git»: коммит', () => {
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('сообщение из двух полей, amend и «и push» уходят в git.commit; счётчик 72 − длина', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    const main = () => q<HTMLButtonElement>(pane, '.cm .go .main');
    // пустое сообщение — кнопка неактивна
    expect(main().disabled).toBe(true);
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'Fix blink');
    await flush();
    expect(q(pane, '.cm .sum .n').textContent).toBe('63');
    type(q<HTMLTextAreaElement>(pane, '.cm textarea.desc'), 'Keep last value.');
    qa<HTMLInputElement>(pane, '.cm .opt input')[0]!.click();
    qa<HTMLInputElement>(pane, '.cm .opt input')[1]!.click();
    await flush();
    expect(main().disabled).toBe(false);
    expect(main().textContent).toBe('Amend · 2 файла → fix/board');
    main().click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.commit',
      roots: ['/w'],
      message: 'Fix blink\n\nKeep last value.',
      amend: true,
      push: true,
    });
  });

  it('индекс пуст — «Коммит» неактивна с подсказкой «Сначала в индекс»; заголовок длиннее 72 — над', async () => {
    const host = await open(ok(repo({ staged: [] })));
    const pane = q(host, '#pane-git');
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'x'.repeat(80));
    await flush();
    const main = q<HTMLButtonElement>(pane, '.cm .go .main');
    expect(main.disabled).toBe(true);
    expect(main.getAttribute('data-tip')).toBe('Сначала в индекс');
    expect(q(pane, '.cm .sum .n').classList.contains('over')).toBe(true);
    expect(q(pane, '.cm .sum .n').textContent).toBe('-8');
  });

  it('⌘Enter в заголовке коммитит; меню ▾: «Коммит и push» и «Коммит всех изменений» (all)', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    const sum = q<HTMLInputElement>(pane, '.cm input.t');
    type(sum, 'Msg');
    await flush();
    sum.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.commit', message: 'Msg', push: false });
    q(pane, '.cm .go .more').click();
    await flush();
    const items = qa<HTMLButtonElement>(pane, '.cm .menu .it');
    expect(items.map((i) => i.textContent)).toEqual(['Коммит и push', 'Коммит всех изменений']);
    items[0]!.click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.commit', push: true });
    await flush();
    q(pane, '.cm .go .more').click();
    await flush();
    qa<HTMLButtonElement>(pane, '.cm .menu .it')[1]!.click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.commit', all: true, push: false });
  });

  it('git.commit.result ok очищает черновик; git.error — строка над полем, закрывается', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'Msg');
    await flush();
    handleHostMessage({ type: 'git.error', root: '/w', op: 'commit', message: 'hook failed' });
    await flush();
    expect(q(pane, '.cm .err').textContent).toContain('hook failed');
    expect(q<HTMLInputElement>(pane, '.cm input.t').value).toBe('Msg');
    handleHostMessage({ type: 'git.commit.result', results: [{ root: '/w', ok: true }] });
    await flush();
    expect(q<HTMLInputElement>(pane, '.cm input.t').value).toBe('');
    expect(q(pane, '.cm .err')).toBeNull();
  });

  it('✦: запрос по индексу, крутится до ответа, повторный клик — ничего; ответ заменяет черновик', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'old');
    type(q<HTMLTextAreaElement>(pane, '.cm textarea.desc'), 'old body');
    await flush();
    const gen = () => q<HTMLButtonElement>(pane, '.cm .gen');
    expect(gen().disabled).toBe(false);
    gen().click();
    await flush();
    expect(gitSent().at(-1)).toEqual({ type: 'git.message', roots: ['/w'] });
    expect(gen().classList.contains('busy')).toBe(true);
    expect(gen().getAttribute('aria-busy')).toBe('true');
    gen().click();
    await flush();
    expect(gitSent().filter((m) => m.type === 'git.message')).toHaveLength(1);
    handleHostMessage({ type: 'git.message.result', roots: ['/w'], summary: 'Add backoff', desc: 'Why.' });
    await flush();
    expect(q<HTMLInputElement>(pane, '.cm input.t').value).toBe('Add backoff');
    expect(q<HTMLTextAreaElement>(pane, '.cm textarea.desc').value).toBe('Why.');
    expect(gen().classList.contains('busy')).toBe(false);
  });

  it('✦: отказ — строка ошибки и кнопка снова доступна; пустой индекс — выключена', async () => {
    const host = await open(ok(repo()));
    const pane = q(host, '#pane-git');
    q<HTMLButtonElement>(pane, '.cm .gen').click();
    await flush();
    handleHostMessage({ type: 'git.error', root: '/w', op: 'message', message: 'нет ответа' });
    await flush();
    expect(q(pane, '.cm .err').textContent).toContain('нет ответа');
    expect(q(pane, '.cm .gen').classList.contains('busy')).toBe(false);
    q<HTMLButtonElement>(pane, '.cm .gen').click();
    expect(gitSent().filter((m) => m.type === 'git.message')).toHaveLength(2);
    handleHostMessage({ type: 'git.message.result', roots: ['/w'], summary: 'S', desc: '' });

    push(ok(repo({ staged: [] })));
    await flush();
    const gen = q<HTMLButtonElement>(pane, '.cm .gen');
    expect(gen.disabled).toBe(true);
    expect(gen.getAttribute('data-tip')).toBe('Сначала в индекс');
  });
});

describe('вкладка «git»: git.watch', () => {
  it('открытие вкладки шлёт watch on, переключение на другую — off', async () => {
    const host = await open(ok(repo()));
    expect(sent.filter((m) => m.type === 'git.watch')).toEqual([{ type: 'git.watch', on: true }]);
    qa(host, '.ptabs [role="tab"]')[0]!.click();
    await flush();
    expect(sent.filter((m) => m.type === 'git.watch').at(-1)).toEqual({
      type: 'git.watch',
      on: false,
    });
    qa(host, '.ptabs [role="tab"]')[1]!.click();
    await flush();
    expect(sent.filter((m) => m.type === 'git.watch').at(-1)).toEqual({
      type: 'git.watch',
      on: true,
    });
  });

  it('свёрнутая панель — off; скрытый документ — off', async () => {
    const host = await open(ok(repo()));
    q<HTMLButtonElement>(host, '.ptabs .phide').click();
    await flush();
    expect(sent.filter((m) => m.type === 'git.watch').at(-1)).toEqual({
      type: 'git.watch',
      on: false,
    });
    q<HTMLButtonElement>(host, 'nav.rail .show').click();
    await flush();
    expect(sent.filter((m) => m.type === 'git.watch').at(-1)).toEqual({
      type: 'git.watch',
      on: true,
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(sent.filter((m) => m.type === 'git.watch').at(-1)).toEqual({
      type: 'git.watch',
      on: false,
    });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(sent.filter((m) => m.type === 'git.watch').at(-1)).toEqual({
      type: 'git.watch',
      on: true,
    });
  });
});

describe('вкладка «git»: несколько репозиториев, три раскладки', () => {
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const trio = () => {
    const a = repo({ root: '/w/a', rel: 'a', name: 'a' });
    const b = repo({
      root: '/w/b',
      rel: 'b',
      name: 'b',
      unstaged: [{ path: 'README.md', status: 'M', add: 3, del: 0 }],
      staged: [{ path: 'src/x.ts', status: 'A', add: 9, del: 0 }],
      log: [],
    });
    const c = repo({ root: '/w/c', rel: 'c', name: 'c', unstaged: [], staged: [], log: [] });
    return ok(a, b, c);
  };
  const layout = async (gitLayout: 'stack' | 'picker' | 'unified', snap = trio()) => {
    const host = await open(snap);
    handleHostMessage({ type: 'chat.info', project: 'w', cwd: '/w', allowBypass: false, gitLayout });
    await flush();
    return host;
  };

  it('data-git на корне чата: из chat.info, по умолчанию stack', async () => {
    const host = await open(trio());
    expect(q(host, '.webview').getAttribute('data-git')).toBe('stack');
    handleHostMessage({ type: 'chat.info', project: 'w', cwd: '/w', allowBypass: false, gitLayout: 'picker' });
    await flush();
    expect(q(host, '.webview').getAttribute('data-git')).toBe('picker');
  });

  it('stack: поле коммита строкой, на фокус раскрывается в полное с тем же черновиком', async () => {
    const host = await layout('stack');
    const pane = q(host, '#pane-git');
    expect(qa(pane, '.rb')).toHaveLength(3);
    expect(qa(pane, '.cml')).toHaveLength(2);
    const line = qa<HTMLInputElement>(pane, '.cml input.in')[0]!;
    line.focus();
    await flush();
    expect(qa(pane, '.cm')).toHaveLength(1);
    const full = q<HTMLInputElement>(pane, '.cm input.t');
    expect(document.activeElement).toBe(full);
    type(full, 'Stack msg');
    await flush();
    q<HTMLButtonElement>(pane, '.cm .go .main').click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.commit', roots: ['/w/a'], message: 'Stack msg' });
  });

  it('stack: кнопка «Коммит» в строке коммитит сразу', async () => {
    const host = await layout('stack');
    const pane = q(host, '#pane-git');
    const input = qa<HTMLInputElement>(pane, '.cml input.in')[1]!;
    const btn = qa<HTMLButtonElement>(pane, '.cml button')[1]!;
    expect(btn.disabled).toBe(true);
    type(input, 'Quick');
    await flush();
    qa<HTMLButtonElement>(pane, '.cml button')[1]!.click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.commit', roots: ['/w/b'], message: 'Quick' });
  });

  it('picker: список репозиториев, выбор сохраняется в panel.gitRepo, ниже — выбранный как один', async () => {
    const host = await layout('picker');
    const pane = q(host, '#pane-git');
    const rows = qa(pane, '.pick .p');
    expect(rows).toHaveLength(3);
    // по умолчанию — первый с изменениями
    expect(rows[0]!.classList.contains('on')).toBe(true);
    expect(qa(pane, '.sh .tt')).toHaveLength(2);
    expect(qa(pane, '.cm')).toHaveLength(1);
    expect(q(pane, '.cm').getAttribute('data-root')).toBe('/w/a');
    rows[1]!.click();
    await flush();
    expect(qa(pane, '.pick .p')[1]!.classList.contains('on')).toBe(true);
    expect(q(pane, '.cm').getAttribute('data-root')).toBe('/w/b');
    expect(qa(pane, '.f .nm b').map((n) => n.textContent)).toContain('README.md');
    expect((stored as { panel: { gitRepo: string } }).panel.gitRepo).toBe('/w/b');
    // чистый репозиторий в списке с прочерком
    expect(q(qa(pane, '.pick .p')[2]!, '.n').textContent).toBe('—');
    qa(pane, '.f')[0]!.click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.open', root: '/w/b' });
  });

  it('picker: сохранённый репозиторий исчез — берётся первый с изменениями', async () => {
    stored = { panel: { tab: 'git', gitRepo: '/w/gone' } };
    session();
    push(trio());
    const host = mount();
    await flush();
    handleHostMessage({ type: 'chat.info', project: 'w', cwd: '/w', allowBypass: false, gitLayout: 'picker' });
    await flush();
    expect(q(host, '.cm').getAttribute('data-root')).toBe('/w/a');
  });

  it('unified: общие секции с подзаголовками репо, чистые — строками внизу', async () => {
    const host = await layout('unified');
    const pane = q(host, '#pane-git');
    expect(qa(pane, '.sh .tt').map((n) => n.textContent)).toEqual(['неиндексированные', 'в индексе']);
    const groups = qa(pane, '.rgrp');
    expect(groups.map((g) => q(g, '.rg .nm').textContent)).toEqual(['a', 'b', 'a', 'b']);
    expect(qa(pane, '.sh .n').map((n) => n.textContent)).toEqual(['4', '3']);
    // чистый c — строкой внизу, отдельного поля коммита у репо нет
    expect(qa(pane, 'h6').map((n) => n.textContent)).toContain('чистые');
    expect(qa(pane, '.rg .nm.dim').map((n) => n.textContent)).toEqual(['c']);
    expect(qa(pane, '.cm')).toHaveLength(1);
    expect(q(pane, '.cm').getAttribute('data-root')).toBe(GIT_UNIFIED);
    // файл шлёт запрос со своим root
    qa(groups[1]!, '.f')[0]!.click();
    expect(gitSent().at(-1)).toMatchObject({ type: 'git.open', root: '/w/b' });
  });

  it('unified: «+ все в индекс» — по запросу на каждый репозиторий', async () => {
    const host = await layout('unified');
    const pane = q(host, '#pane-git');
    q<HTMLButtonElement>(pane, '.sh .all.pri').click();
    expect(gitSent()).toEqual([
      { type: 'git.stage', root: '/w/a', paths: ['src/Counter.tsx', 'src/new.test.ts', '.env.local'] },
      { type: 'git.stage', root: '/w/b', paths: ['README.md'] },
    ]);
  });

  it('unified: чипы целей по умолчанию отмечены у репо с индексом, один коммит уходит в отмеченные', async () => {
    const host = await layout('unified');
    const pane = q(host, '#pane-git');
    const chips = () => qa<HTMLInputElement>(pane, '.cm .tg input');
    expect(chips().map((c) => c.checked)).toEqual([true, true]);
    expect(q(pane, '.cm .tg').textContent).toContain('a 2');
    expect(q(pane, '.cm .tg').textContent).toContain('b 1');
    const main = () => q<HTMLButtonElement>(pane, '.cm .go .main');
    expect(main().disabled).toBe(true);
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'Both');
    await flush();
    expect(main().textContent).toBe('Коммит в 2 репозитория · 3 файла');
    main().click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.commit',
      roots: ['/w/a', '/w/b'],
      message: 'Both',
      amend: false,
      push: false,
    });
    // снять чип — коммит только в оставшийся
    chips()[0]!.click();
    await flush();
    expect(main().textContent).toBe('Коммит в 1 репозиторий · 1 файл');
    main().click();
    expect(gitSent().at(-1)).toMatchObject({ roots: ['/w/b'] });
    // все чипы сняты — кнопка гаснет с подсказкой
    chips()[1]!.click();
    await flush();
    expect(main().disabled).toBe(true);
    expect(main().getAttribute('data-tip')).toContain('Отметьте');
  });

  it('unified: итог по репозиториям — успех строкой, ошибка с именем репо; полный успех чистит черновик', async () => {
    const host = await layout('unified');
    const pane = q(host, '#pane-git');
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'Msg');
    await flush();
    handleHostMessage({
      type: 'git.commit.result',
      results: [
        { root: '/w/a', ok: true },
        { root: '/w/b', ok: false, error: 'hook failed' },
      ],
    });
    handleHostMessage({ type: 'git.error', root: '/w/b', op: 'commit', message: 'hook failed' });
    await flush();
    expect(q(pane, '.cm .ok').textContent).toContain('Закоммичено: a');
    expect(q(pane, '.cm .err').textContent).toContain('b: commit: hook failed');
    // частичный успех: сообщение остаётся для повтора
    expect(gitDrafts.value[GIT_UNIFIED]?.summary).toBe('Msg');
    handleHostMessage({
      type: 'git.commit.result',
      results: [
        { root: '/w/a', ok: true },
        { root: '/w/b', ok: true },
      ],
    });
    await flush();
    expect(gitDrafts.value[GIT_UNIFIED]?.summary).toBe('');
    expect(q<HTMLInputElement>(pane, '.cm input.t').value).toBe('');
  });

  it('unified: ✦ — индекс всех отмеченных одним запросом, ответ — в общий черновик', async () => {
    const host = await layout('unified');
    const pane = q(host, '#pane-git');
    q<HTMLButtonElement>(pane, '.cm .gen').click();
    await flush();
    expect(gitSent().at(-1)).toEqual({ type: 'git.message', roots: ['/w/a', '/w/b'] });
    handleHostMessage({ type: 'git.message.result', roots: ['/w/a', '/w/b'], summary: 'Both', desc: '' });
    await flush();
    expect(gitDrafts.value[GIT_UNIFIED]?.summary).toBe('Both');
    expect(gitDrafts.value['/w/a']).toBeUndefined();
    expect(q<HTMLInputElement>(pane, '.cm input.t').value).toBe('Both');
    // отказ без root (несколько репо) — снимает ожидание общего черновика
    q<HTMLButtonElement>(pane, '.cm .gen').click();
    await flush();
    expect(gitGenerating.value[GIT_UNIFIED]).toEqual(['/w/a', '/w/b']);
    handleHostMessage({ type: 'git.error', op: 'message', message: 'boom' });
    await flush();
    expect(gitGenerating.value).toEqual({});
    expect(q(pane, '.cm .err').textContent).toContain('boom');
  });

  it('unified: «и push» и amend применяются ко всем отмеченным', async () => {
    const host = await layout('unified');
    const pane = q(host, '#pane-git');
    type(q<HTMLInputElement>(pane, '.cm input.t'), 'P');
    qa<HTMLInputElement>(pane, '.cm .opt input')[0]!.click();
    qa<HTMLInputElement>(pane, '.cm .opt input')[1]!.click();
    await flush();
    q<HTMLButtonElement>(pane, '.cm .go .main').click();
    expect(gitSent().at(-1)).toEqual({
      type: 'git.commit',
      roots: ['/w/a', '/w/b'],
      message: 'P',
      amend: true,
      push: true,
    });
  });

  it('один репозиторий не зависит от раскладки', async () => {
    for (const l of ['stack', 'picker', 'unified'] as const) {
      const host = await layout(l, ok(repo()));
      const pane = q(host, '#pane-git');
      expect(qa(pane, '.pick, .rb, .rgrp')).toHaveLength(0);
      expect(q(pane, '.cm').getAttribute('data-root')).toBe('/w');
      expect(qa(pane, '.cml')).toHaveLength(0);
      for (const h of mounted.splice(0)) render(null, h);
      await flush();
      document.body.innerHTML = '';
    }
  });

  it('пустое состояние: «Открыть репозиторий…» шлёт git.openRepository', async () => {
    const host = await open({ state: 'none', repos: [] });
    q<HTMLButtonElement>(host, '#pane-git .open-repo').click();
    expect(gitSent().at(-1)).toEqual({ type: 'git.openRepository' });
  });
});
