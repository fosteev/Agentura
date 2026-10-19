// @vitest-environment jsdom
/**
 * Вкладка «код» полосы задачи (roadmap 24, сессия 2; эталон — `prototype/screens/task-git.html#b`): третья вкладка с
 * числом, загрузка при первом открытии, репозитории с ветками, коммитами и метками, незакоммиченные правки агентов с
 * чатами, детали коммита, встроенный дифф на месте списка (×, Esc, j/k, inline | split), «как ищем?».
 */
import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePatch } from '../shared/patch';
import type { CodeRepo, TaskCodeStateMessage, TaskStateMessage } from '../shared/task';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import {
  chat,
  handleHostMessage,
  hudState,
  taskCardMode,
  taskChats,
  taskCode,
  taskCodeCommits,
  taskCodeDiff,
  taskFocus,
  taskState,
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

const flush = () => new Promise((r) => setTimeout(r, 50));
const mounted: HTMLElement[] = [];
let sent: Record<string, unknown>[] = [];
const KEY = 'jira:inst:NEWMFC-1482';
const T0 = Date.parse('2026-10-14T12:00:00Z');

const q = <T extends Element = HTMLElement>(host: Element, sel: string) => host.querySelector(sel) as T;
const qa = (host: Element, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const sentOf = (type: string) => sent.filter((m) => m.type === type);

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

function taskMsg(): TaskStateMessage {
  return {
    type: 'task.state',
    taskKey: KEY,
    card: {
      key: 'NEWMFC-1482',
      instanceId: 'inst',
      instanceName: 'sccloud',
      title: 'Талон не печатается',
      type: 'Task',
      status: 'В работе',
      statusCategory: 'indeterminate',
      assignee: 'А. Фостеев',
      priority: 'высокий',
      url: 'https://jira.example/browse/NEWMFC-1482',
      updatedAt: T0,
      description: '',
      descriptionHtml: '',
      created: T0,
      labels: [],
      components: [],
      fixVersions: [],
      time: {},
      history: [],
      worklogs: [],
      canWrite: true,
      attachments: [],
      comments: [],
    },
    events: [],
    fetchedAt: T0,
    source: 'jiraffe',
  };
}

const SHA1 = 'a41c9e2' + '0'.repeat(33);
const SHA2 = 'e19f5a0' + '0'.repeat(33);
const SHA3 = '3b8e7c4' + '0'.repeat(33);

function repos(): CodeRepo[] {
  return [
    {
      root: '/w/smart_eq_terminal',
      name: 'smart_eq_terminal',
      base: 'origin/develop',
      branches: [
        {
          name: 'feature/NEWMFC-1482',
          ahead: 3,
          add: 52,
          del: 6,
          files: [
            { path: 'packages/printer/src/PrintQueue.ts', status: 'M', add: 9, del: 2 },
            { path: 'packages/printer/test/resume.test.ts', status: 'A', add: 34, del: 0 },
          ],
        },
        { name: 'merged/NEWMFC-1482', ahead: 0, add: 0, del: 0, files: [] },
      ],
      commits: [
        { sha: SHA1, short: SHA1.slice(0, 7), subject: 'NEWMFC-1482: reset busy flag <b>', author: 'А. Фостеев', at: T0, src: 'key', unpushed: true },
        { sha: SHA2, short: SHA2.slice(0, 7), subject: 'Add resume test', author: 'А. Фостеев', at: T0 - 3_600_000, src: 'branch', branch: 'feature/NEWMFC-1482' },
      ],
      dirty: [
        {
          path: 'packages/printer/src/socket.ts',
          status: 'M',
          add: 3,
          del: 1,
          chats: [
            { id: 's-codex', provider: 'codex', title: 'восстановление очереди' },
            { id: 's-claude', title: '' },
          ],
        },
      ],
    },
    {
      root: '/w/smart_eq_api',
      name: 'smart_eq_api',
      base: 'origin/develop',
      branches: [],
      commits: [{ sha: SHA3, short: SHA3.slice(0, 7), subject: 'NEWMFC-1482: expose printer state', author: 'Д. Соколов', at: T0 - 86_400_000, src: 'key', inBase: true }],
      dirty: [],
    },
  ];
}

const codeState = (over: Partial<TaskCodeStateMessage> = {}): TaskCodeStateMessage => ({
  type: 'task.code.state',
  taskKey: KEY,
  repos: repos(),
  ...over,
});

const patch = (): FilePatch => ({
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: '-', text: 'const a = 1;', old: 1, new: null },
        { kind: '+', text: 'const a = "<script>x</script>";', old: null, new: 1 },
      ],
    },
  ],
});

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  stored = undefined;
  sent = [];
  vi.spyOn(vscode, 'send').mockImplementation((m) => void sent.push(m as unknown as Record<string, unknown>));
  chat.value = initialState();
  hudState.value = initialHud();
  taskState.value = undefined;
  taskChats.value = [];
  taskCardMode.value = 'tab';
  taskFocus.value = undefined;
  taskCode.value = undefined;
  taskCodeCommits.value = {};
  taskCodeDiff.value = undefined;
});

afterEach(() => vi.restoreAllMocks());

/** Хост с открытой вкладкой «код» и загруженным итогом. */
async function openCode(state: TaskCodeStateMessage | undefined = codeState()) {
  const host = mount();
  handleHostMessage(taskMsg());
  await flush();
  q(host, '#vtab-code').click();
  await flush();
  if (state) {
    handleHostMessage(state);
    await flush();
  }
  return host;
}

const key = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

describe('вкладка «код»: полоса и загрузка', () => {
  it('третья вкладка без числа, пока не загружено; клик открывает её, шлёт task.code.load и прячет поле ввода', async () => {
    const host = mount();
    handleHostMessage(taskMsg());
    await flush();
    expect(qa(host, '.tk-strip .vtab').map((b) => b.textContent)).toEqual(['задача', 'код']); // «чат» — чип «новый чат» (roadmap 26)
    expect(q(host, '#vtab-chat .n').textContent).toBe('новый чат');
    expect(q(host, '#vtab-code .cnt')).toBeNull();
    expect(sentOf('task.code.load')).toHaveLength(0);
    q(host, '#vtab-code').click();
    await flush();
    expect(q(host, '#vtab-code').getAttribute('aria-selected')).toBe('true');
    expect(q(host, '.webview').getAttribute('data-view')).toBe('code');
    expect(sentOf('task.code.load')).toEqual([{ type: 'task.code.load' }]);
    expect(q(host, '.tcd').hasAttribute('hidden')).toBe(false);
    expect(q(host, '.tcd .note')!.textContent).toBe('загрузка…');
    // вкладка «задача» скрыта, а не размонтирована
    expect(q(host, '.tv').hasAttribute('hidden')).toBe(true);
  });

  it('число у вкладки — коммиты + незакоммиченные файлы; вернувшись в чат, не шлёт загрузку повторно', async () => {
    const host = await openCode();
    expect(q(host, '#vtab-code .cnt').textContent).toBe('4');
    q(host, '#vtab-chat').click();
    await flush();
    expect(q(host, '.tcd').hasAttribute('hidden')).toBe(true);
    q(host, '#vtab-code').click();
    await flush();
    expect(sentOf('task.code.load')).toHaveLength(1);
  });

  it('↻ шлёт загрузку заново (force), идущая перезагрузка блокирует кнопку и оставляет прежние репозитории', async () => {
    const host = await openCode();
    q(host, '.tcd .rf').click();
    expect(sentOf('task.code.load').at(-1)).toEqual({ type: 'task.code.load', force: true });
    handleHostMessage(codeState({ loading: true }));
    await flush();
    expect(q<HTMLButtonElement>(host, '.tcd .rf').disabled).toBe(true);
    expect(qa(host, '.tcd .rb')).toHaveLength(2);
  });

  it('ошибка хоста и пустой итог показываются строкой', async () => {
    const host = await openCode(codeState({ error: 'Git недоступен', repos: [] }));
    expect(q(host, '.tcd .note.err').textContent).toBe('Git недоступен');
    handleHostMessage(codeState({ repos: [] }));
    await flush();
    expect(q(host, '.tcd .note').textContent).toBe('Репозитории не найдены');
    handleHostMessage(codeState({ repos: [{ root: '/w/x', name: 'x', base: 'origin/develop', branches: [{ name: 'old', ahead: 0, add: 0, del: 0, files: [] }], commits: [], dirty: [] }], }));
    await flush();
    expect(q(host, '.tcd .note').textContent).toContain('ничего не найдено');
  });
});

describe('вкладка «код»: список', () => {
  it('репозитории: шапка с веткой и базой, метки коммитов, «↑ локально», «в базе», незакоммиченные с чатами', async () => {
    const host = await openCode();
    const rbs = qa(host, '.tcd .rb');
    expect(rbs.map((r) => r.querySelector('.rh b')!.textContent)).toEqual(['smart_eq_terminal', 'smart_eq_api']);
    // ветка с ahead 0 при известной базе не показана
    expect(rbs[0]!.textContent).not.toContain('merged/NEWMFC-1482');
    expect(rbs[0]!.querySelector('.rh .br')!.textContent).toBe('feature/NEWMFC-1482 → origin/develop · 3 коммита впереди');
    expect(rbs[0]!.querySelector('.rh .n')!.textContent).toBe('+52 −6');
    expect(rbs[1]!.querySelector('.rh .br')!.textContent).toBe('ветки задачи нет · коммиты в origin/develop');
    expect(q(host, '.tcd .top').textContent).toContain('2 репо · 3 коммита · 1 файл не закоммичено');

    const rows = qa(rbs[0]!, '.row:not(.f)');
    expect(rows.map((r) => r.querySelector('.h')!.textContent)).toEqual([SHA1.slice(0, 7), SHA2.slice(0, 7)]);
    expect(rows[0]!.querySelector('.s')!.textContent).toBe('NEWMFC-1482: reset busy flag <b>');
    expect(rows[0]!.querySelector('b')).toBeNull(); // тема коммита — текст, не разметка
    expect(rows[0]!.querySelector('.src')!.textContent).toBe('ключ');
    expect(rows[0]!.querySelector('.up')!.textContent).toBe('↑ локально');
    expect(rows[1]!.querySelector('.src.br')!.textContent).toBe('ветка');
    expect(rows[1]!.querySelector('.src.br')!.getAttribute('data-tip')).toContain('feature/NEWMFC-1482');
    expect(q(rbs[1]!, '.row .ind').textContent).toBe('в origin/develop');

    expect(q(rbs[0]!, '.sub').textContent).toBe('не закоммичено · правки агентов');
    const dirty = q(rbs[0]!, '.row.f');
    expect(dirty.querySelector('.nm')!.textContent).toBe('packages/printer/src/socket.ts');
    expect(dirty.querySelector('.st')!.textContent).toBe('M');
    expect(qa(dirty, '.chm .mk').map((m) => m.textContent)).toEqual(['X', 'C']);
    expect(dirty.querySelector('em')!.textContent).toBe('+3 −1');
  });

  it('первый коммит выбран: справа детали, файлы запрашиваются, потом показываются; смена выбора — новый запрос', async () => {
    const host = await openCode();
    expect(sentOf('task.code.commit')).toEqual([{ type: 'task.code.commit', root: '/w/smart_eq_terminal', sha: SHA1 }]);
    expect(qa(host, '.tcd .row.sel .h').map((e) => e.textContent)).toEqual([SHA1.slice(0, 7)]);
    expect(q(host, '.tcd .r .ttl2').textContent).toBe('NEWMFC-1482: reset busy flag <b>');
    expect(q(host, '.tcd .r h5:nth-of-type(2)').textContent).toBe('файлы…');
    handleHostMessage({
      type: 'task.code.commit',
      root: '/w/smart_eq_terminal',
      sha: SHA1,
      files: [
        { path: 'packages/printer/src/PrintQueue.ts', status: 'M', add: 9, del: 2 },
        { path: 'packages/printer/test/resume.test.ts', status: 'A', add: 34, del: 0 },
      ],
    });
    await flush();
    expect(q(host, '.tcd .r h5:nth-of-type(2)').textContent).toBe('Файлы · 2');
    expect(qa(host, '.tcd .r .fr .nm').map((n) => n.textContent)).toEqual([
      'packages/printer/src/PrintQueue.ts',
      'packages/printer/test/resume.test.ts',
    ]);
    qa(host, '.tcd .rb')[1]!.querySelector<HTMLElement>('.row')!.click();
    await flush();
    expect(sentOf('task.code.commit').at(-1)).toEqual({ type: 'task.code.commit', root: '/w/smart_eq_api', sha: SHA3 });
    expect(qa(host, '.tcd .row.sel .h').map((e) => e.textContent)).toEqual([SHA3.slice(0, 7)]);
  });

  it('метка чата открывает этот чат и не выбирает строку; «копировать хэш» и «в чат ↳» шлют хосту', async () => {
    const host = await openCode();
    const mark = qa(host, '.tcd .row.f .chm')[0]!;
    expect(mark.getAttribute('data-tip')).toBe('Правил чат: восстановление очереди');
    mark.click();
    expect(sent.at(-1)).toEqual({ type: 'task.openChat', sessionId: 's-codex' });
    expect(qa(host, '.tcd .row.f .chm')[1]!.getAttribute('data-tip')).toBe('Правил чат: новый чат');

    const btns = qa(host, '.tcd .acts2 button');
    expect(btns.map((b) => b.textContent)).toEqual(['дифф коммита', 'в чат ↳', 'копировать хэш']);
    btns[2]!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.code.copy', text: SHA1 });
    btns[1]!.click();
    await flush();
    expect(sent.find((m) => m.type === 'task.code.prefill')).toEqual({
      type: 'task.code.prefill',
      text: `${SHA1.slice(0, 7)} NEWMFC-1482: reset busy flag <b> (smart_eq_terminal)`,
    });
    expect(q(host, '.webview').getAttribute('data-view')).toBe('chat'); // перешли на «чат»
  });
});

describe('вкладка «код»: встроенный дифф', () => {
  async function openDirtyDiff() {
    const host = await openCode();
    q(host, '.tcd .row.f').click();
    await flush();
    return host;
  }

  it('клик по незакоммиченному файлу открывает дифф в левой колонке под списком (правая панель остаётся), запрос с req и целью wip', async () => {
    const host = await openDirtyDiff();
    const req = sentOf('task.code.diff').at(-1)!;
    expect(req).toMatchObject({ type: 'task.code.diff', root: '/w/smart_eq_terminal', target: { kind: 'wip', path: 'packages/printer/src/socket.ts' } });
    const main = q(host, '.tcd-main');
    expect(main.hasAttribute('hidden')).toBe(false);
    expect(q(host, '.tcd-main > .lc.open > .l + .dview')).not.toBeNull();
    expect(q(host, '.tcd-main > .r')).not.toBeNull();
    expect(q(host, '.dview .dnote').textContent).toBe('Загрузка диффа…');
    expect(q(host, '.dbar').textContent).toContain('файл 1 / 1');

    handleHostMessage({ type: 'task.code.diff', req: req.req as number, patch: patch() });
    await flush();
    expect(q(host, '.dview .dgrid.dinl.hl')).not.toBeNull();
    expect(q(host, '.dview script')).toBeNull();
    expect(q(host, '.dview .dbody').textContent).toContain('<script>x</script>');
    // список не размонтирован
    expect(q(host, '.tcd-main')).toBe(main);
    expect(qa(host, '.tcd-main .row').length).toBeGreaterThan(0);
  });

  it('× и Esc закрывают дифф, список возвращается; Esc не останавливает ход', async () => {
    const host = await openDirtyDiff();
    q(host, '.dbar button[aria-label="Закрыть (Esc)"]').click();
    await flush();
    expect(q(host, '.dview')).toBeNull();
    expect(q(host, '.tcd-main > .lc.open')).toBeNull();

    q(host, '.tcd .row.f').click();
    await flush();
    expect(q(host, '.dview')).not.toBeNull();
    chat.value = { ...chat.value, status: 'working' };
    const before = sent.length;
    key('Escape');
    await flush();
    expect(q(host, '.dview')).toBeNull();
    expect(sent.slice(before).filter((m) => m.type === 'interrupt')).toEqual([]);
    // контроль: без диффа тот же Esc останавливает ход (общий обработчик чата)
    key('Escape');
    expect(sent.slice(before).filter((m) => m.type === 'interrupt')).toHaveLength(1);
  });

  it('«дифф коммита» → файлы коммита, j/k переключают, ответ на устаревший req отбрасывается', async () => {
    const host = await openCode();
    handleHostMessage({
      type: 'task.code.commit',
      root: '/w/smart_eq_terminal',
      sha: SHA1,
      files: [
        { path: 'a.ts', status: 'M', add: 1, del: 1 },
        { path: 'b.py', status: 'A', add: 3, del: 0 },
        { path: 'c.md', status: 'D', add: 0, del: 2 },
      ],
    });
    await flush();
    q(host, '.tcd .acts2 .pri').click();
    await flush();
    const r1 = sentOf('task.code.diff').at(-1)!;
    expect(r1.target).toEqual({ kind: 'commit', sha: SHA1, path: 'a.ts' });
    expect(q(host, '.dbar').textContent).toContain('файл 1 / 3');
    expect(q(host, '.dbar').textContent).toContain('коммит a41c9e2');

    key('j');
    await flush();
    const r2 = sentOf('task.code.diff').at(-1)!;
    expect(r2.target).toEqual({ kind: 'commit', sha: SHA1, path: 'b.py' });
    expect(r2.req).not.toBe(r1.req);
    expect(q(host, '.dbar').textContent).toContain('файл 2 / 3');
    // запоздавший ответ на первый файл не затирает «загрузку» второго
    handleHostMessage({ type: 'task.code.diff', req: r1.req as number, patch: patch() });
    await flush();
    expect(q(host, '.dview .dnote')!.textContent).toBe('Загрузка диффа…');
    handleHostMessage({ type: 'task.code.diff', req: r2.req as number, error: 'fatal: boom' });
    await flush();
    expect(q(host, '.dview .dnote.err').textContent).toBe('fatal: boom');

    key('j');
    key('j'); // дальше края не идём
    await flush();
    expect(q(host, '.dbar').textContent).toContain('файл 3 / 3');
    expect(q<HTMLButtonElement>(host, '.dbar button[aria-label="Следующий файл (j)"]').disabled).toBe(true);
    key('k');
    await flush();
    expect(q(host, '.dbar').textContent).toContain('файл 2 / 3');
    expect(qa(host, '.tcd .r .fr').map((e) => e.classList.contains('on'))).toEqual([false, true, false]);
  });

  it('при открытом диффе коммита выбор другого коммита переключает дифф на его файлы', async () => {
    const host = await openCode();
    handleHostMessage({ type: 'task.code.commit', root: '/w/smart_eq_terminal', sha: SHA1, files: [{ path: 'a.ts', status: 'M', add: 1, del: 1 }] });
    await flush();
    q(host, '.tcd .acts2 .pri').click();
    await flush();
    const before = sentOf('task.code.diff').length;

    qa(host, '.tcd .lc .row:not(.f)')[1]!.click();
    await flush();
    expect(sentOf('task.code.commit').at(-1)).toMatchObject({ sha: SHA2 });
    expect(q(host, '.dview')).not.toBeNull(); // старый дифф виден, пока не пришли файлы
    expect(sentOf('task.code.diff')).toHaveLength(before);

    handleHostMessage({ type: 'task.code.commit', root: '/w/smart_eq_terminal', sha: SHA2, files: [{ path: 'z.ts', status: 'A', add: 2, del: 0 }] });
    await flush();
    expect(sentOf('task.code.diff').at(-1)!.target).toEqual({ kind: 'commit', sha: SHA2, path: 'z.ts' });
    expect(q(host, '.dbar').textContent).toContain('коммит e19f5a0');
    expect(q(host, '.tcd .r .fr.on')).not.toBeNull();
  });

  it('дифф ветки идёт по файлам ветки против базы', async () => {
    const host = await openCode();
    q(host, '.tcd .rh button').click();
    await flush();
    expect(sentOf('task.code.diff').at(-1)).toMatchObject({
      root: '/w/smart_eq_terminal',
      target: { kind: 'branch', base: 'origin/develop', branch: 'feature/NEWMFC-1482', path: 'packages/printer/src/PrintQueue.ts' },
    });
    expect(q(host, '.dbar').textContent).toContain('ветка feature/NEWMFC-1482');
  });

  it('inline | split: переключатель перерисовывает и запоминается в состоянии панели', async () => {
    const host = await openDirtyDiff();
    const req = sentOf('task.code.diff').at(-1)!.req as number;
    handleHostMessage({ type: 'task.code.diff', req, patch: patch() });
    await flush();
    const seg = qa(host, '.dbar .seg button');
    expect(seg.map((b) => b.textContent)).toEqual(['inline', 'split']);
    expect(seg[0]!.getAttribute('aria-pressed')).toBe('true');
    seg[1]!.click();
    await flush();
    expect(q(host, '.dview .dgrid.dsbs')).not.toBeNull();
    expect((stored as { panel?: { diffMode?: string } }).panel?.diffMode).toBe('split');
  });

  it('патч «слишком большой» (truncated без строк) — строка UI', async () => {
    const host = await openDirtyDiff();
    const req = sentOf('task.code.diff').at(-1)!.req as number;
    handleHostMessage({ type: 'task.code.diff', req, patch: { binary: false, truncated: true, hunks: [] } });
    await flush();
    expect(q(host, '.dview .dnote').textContent).toBe('Файл слишком большой — дифф не показан.');
  });
});

describe('вкладка «код»: как ищем?', () => {
  const open = async (search?: { message: boolean; branch: boolean }) => {
    const host = await openCode(codeState(search ? { search } : {}));
    q(host, '.tcd .top .q').click();
    await flush();
    return host;
  };

  it('общий текст: ключ задачи и плейсхолдеры, без реальных базы, ветки и имени репо; «копировать»; Esc закрывает', async () => {
    const host = await openCode();
    expect(q(host, '.tcd .how')).toBeNull();
    q(host, '.tcd .top .q').click();
    await flush();
    const pres = qa(host, '.tcd .how pre');
    expect(pres.map((p) => p.firstChild!.textContent)).toEqual([
      `git log --all -i --grep='NEWMFC-1482' --format='%h %an %s'`,
      `git branch -a --list '*NEWMFC-1482*'`,
      'git log --oneline <база>..<ветка>',
    ]);
    const text = q(host, '.tcd .how').textContent!;
    // в итоге есть репо smart_eq_terminal, база origin/develop и ветка merged/NEWMFC-1482 — в попапе их быть не должно
    expect(text).not.toContain('smart_eq');
    expect(text).not.toContain('origin/develop');
    expect(text).not.toContain('merged/');
    expect(text).not.toContain('Agentura');
    expect(text).toContain('Смотрим git-репозитории, в которых работали чаты задачи NEWMFC-1482');
    expect(text).toContain('База — ветка по умолчанию у origin (origin/HEAD), иначе develop, main или master.');
    expect(q(host, '.tcd .how .rule').textContent).toContain('NEWMFC-1482: …');
    expect(q(host, '.tcd .how .rule').textContent).toContain('Иначе вкладка его не покажет.');
    expect(qa(host, '.tcd .how li.off')).toHaveLength(0);
    pres[1]!.querySelector<HTMLElement>('.cp')!.click();
    expect(sent.at(-1)).toEqual({ type: 'task.code.copy', text: `git branch -a --list '*NEWMFC-1482*'` });
    key('Escape');
    await flush();
    expect(q(host, '.tcd .how')).toBeNull();
  });

  it('выключенный пункт виден приглушённым с пометкой, команд у него нет', async () => {
    const host = await open({ message: false, branch: true });
    const [msg, br] = qa(host, '.tcd .how li');
    expect(msg!.classList.contains('off')).toBe(true);
    expect(msg!.textContent).toContain('выключено в настройках');
    expect(msg!.querySelector('pre')).toBeNull();
    expect(br!.classList.contains('off')).toBe(false);
    expect(br!.querySelectorAll('pre')).toHaveLength(2);
    // правило в рамке упоминает только включённое
    const rule = q(host, '.tcd .how .rule').textContent!;
    expect(rule).toContain('feature/NEWMFC-1482');
    expect(rule).not.toContain('NEWMFC-1482: …');

    handleHostMessage(codeState({ search: { message: true, branch: false } }));
    await flush();
    const [msg2, br2] = qa(host, '.tcd .how li');
    expect(msg2!.classList.contains('off')).toBe(false);
    expect(msg2!.querySelectorAll('pre')).toHaveLength(1);
    expect(br2!.classList.contains('off')).toBe(true);
    expect(br2!.textContent).toContain('выключено в настройках');
    expect(br2!.querySelector('pre')).toBeNull();
    expect(q(host, '.tcd .how .rule').textContent).toContain('NEWMFC-1482: …');
  });

  it('оба выключены: вместо правила — строка про выключенный git-поиск, команд нет', async () => {
    const host = await open({ message: false, branch: false });
    expect(qa(host, '.tcd .how pre')).toHaveLength(0);
    expect(q(host, '.tcd .how .rule')).toBeNull();
    expect(q(host, '.tcd .how .gitoff').textContent).toBe('Поиск по git выключен — видны только незакоммиченные правки агентов.');
    expect(qa(host, '.tcd .how li.off')).toHaveLength(2);
    // абзац про «не закоммичено» остаётся
    expect(q(host, '.tcd .how').textContent).toContain('Блок «не закоммичено»');
  });

  it('ссылка «настройки поиска →» открывает настройки на разделе «Интеграции»', async () => {
    const host = await open();
    const link = q(host, '.tcd .how .lnk');
    expect(link.textContent).toBe('настройки поиска →');
    link.click();
    expect(sent.at(-1)).toEqual({ type: 'settings.open', section: 'integrations' });
  });
});

describe('вкладка «код»: состояние', () => {
  it('сохранённый вид «код» открывается после перезагрузки webview и сразу грузит итог', async () => {
    stored = { panel: { view: 'code', diffMode: 'split' } };
    const host = mount();
    handleHostMessage(taskMsg());
    await flush();
    expect(q(host, '.webview').getAttribute('data-view')).toBe('code');
    expect(sentOf('task.code.load')).toHaveLength(1);
  });

  it('итог другой задачи не показывается', async () => {
    const host = await openCode(codeState({ taskKey: 'jira:inst:OTHER-1' }));
    expect(qa(host, '.tcd .rb')).toHaveLength(0);
    expect(q(host, '#vtab-code .cnt')).toBeNull();
  });
});
