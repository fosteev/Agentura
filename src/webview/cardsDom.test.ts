// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { initialState } from './chatState';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { chat, dispatchEvent, handleHostMessage, hudState, provider, replyTarget } from './store';
import * as vscode from './vscode';

/** Теги и классы без текстов — как в markup.test.ts. */
function skeleton(el: Element): string {
  const cls = [...el.classList].sort().join('.');
  const kids = [...el.children].map(skeleton).filter((k, i, all) => k !== all[i - 1]);
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${kids.length ? `[${kids.join(',')}]` : ''}`;
}

const screen = (name: string) =>
  new DOMParser().parseFromString(
    readFileSync(join(__dirname, '..', '..', 'prototype', 'screens', `${name}.html`), 'utf8'),
    'text/html',
  );

const posted: Record<string, unknown>[] = [];
const flush = () => new Promise((r) => setTimeout(r, 120));
const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;

// смонтированные Chat — размонтировать перед следующим тестом, иначе их слушатели keydown на window
// остаются и отвечают на клавиши вместе с новым
const mounted: HTMLElement[] = [];

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('нет элемента');
  (el as HTMLElement).click();
}

function key(k: string, target: EventTarget = document.body) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

const button = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation(
    (m) => void posted.push(m as Record<string, unknown>),
  );
  chat.value = {
    ...initialState(),
    project: 'queue-board',
    cwd: '/p/queue-board',
    sessionId: 's1',
  };
  hudState.value = initialHud();
  replyTarget.value = undefined;
  provider.value = 'claude';
  dispatchEvent(ev({ type: 'turn.start', at: Date.now(), prompt: 'прогони тесты' }));
});

const bash = ev({
  type: 'permission.request',
  toolUseId: 'b1',
  toolName: 'Bash',
  input: { command: 'pnpm -r test', description: 'Run tests' },
  description: 'pnpm -r test',
  canAlwaysAllow: true,
  always: { rules: ['Bash(pnpm -r test:*)'], destination: 'localSettings', directories: [] },
});

describe('карточка разрешения на команду (permission.html)', () => {
  it('разметка как в прототипе, «Всегда для» → allow-always, итог — строка с правилом', async () => {
    const host = mount();
    dispatchEvent(bash);
    await flush();
    const card = host.querySelector('.ask.warn')!;
    const proto = [...screen('permission').querySelectorAll('.ask.warn')][0]!;
    expect(skeleton(card)).toBe(skeleton(proto));
    expect(card.querySelector('pre')?.textContent).toBe('pnpm -r test');
    expect(card.querySelector('.hint')?.textContent).toBe(
      '«всегда» пишется в .claude/settings.local.json',
    );
    expect(host.querySelector('.typed')?.getAttribute('data-placeholder')).toBe(
      'ответ агенту или новая задача — уйдёт после решения по запросу',
    );
    click(button(card, 'Всегда для'));
    expect(posted.at(-1)).toMatchObject({
      type: 'permission.respond',
      toolUseId: 'b1',
      decision: 'allow-always',
    });
    dispatchEvent(
      ev({ type: 'permission.resolved', toolUseId: 'b1', decision: 'allow', by: 'user' }),
    );
    await flush();
    expect(host.querySelector('.ask')).toBeNull();
    expect(host.querySelector('.log .sys')?.textContent).toContain('Bash(pnpm -r test:*)');
  });

  it('Enter вне поля ввода — разрешить; Enter в поле ввода карточке не достаётся; Esc — отклонить', async () => {
    const host = mount();
    dispatchEvent(bash);
    await flush();
    key('Enter', host.querySelector('.typed')!);
    expect(posted.filter((m) => m['type'] === 'permission.respond')).toHaveLength(0);
    key('Escape');
    expect(posted.at(-1)).toMatchObject({ type: 'permission.respond', decision: 'deny' });
    posted.length = 0;
    // второй запрос — Enter на body разрешает
    dispatchEvent(ev({ ...bash, toolUseId: 'b2' }));
    await flush();
    key('Enter');
    expect(posted.at(-1)).toMatchObject({
      type: 'permission.respond',
      toolUseId: 'b2',
      decision: 'allow',
    });
  });
});

describe('клавиши карточек: модификаторы и Esc при ответе из поля', () => {
  it('Cmd/Ctrl+Enter и Cmd+цифра — хоткеи VS Code, не карточке; Esc вне поля отменяет ответ, а не карточку', async () => {
    mount();
    dispatchEvent(bash);
    await flush();
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }])
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mod }),
      );
    expect(posted.filter((m) => m['type'] === 'permission.respond')).toHaveLength(0);

    replyTarget.value = { kind: 'plan', toolUseId: 'p9' };
    key('Escape');
    expect(replyTarget.value).toBeUndefined();
    expect(posted.filter((m) => m['type'] === 'permission.respond')).toHaveLength(0);
    key('Escape');
    expect(posted.at(-1)).toMatchObject({ type: 'permission.respond', decision: 'deny' });
  });
});

describe('карточка правки (diff.html)', () => {
  it('превью ханков от хоста, «открыть дифф», «Принимать правки до конца сессии»', async () => {
    const host = mount();
    dispatchEvent(
      ev({
        type: 'permission.request',
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/p/queue-board/apps/board/src/Counter.tsx' },
        canAlwaysAllow: true,
        always: { rules: [], mode: 'acceptEdits', directories: [] },
        diff: {
          kind: 'edit',
          filePath: '/p/queue-board/apps/board/src/Counter.tsx',
          oldText: 'a',
          newText: 'b',
          replaceAll: false,
        },
      }),
    );
    handleHostMessage({
      type: 'diff.preview',
      sessionId: 's1',
      toolUseId: 'e1',
      preview: {
        filePath: '/p/queue-board/apps/board/src/Counter.tsx',
        add: 2,
        del: 1,
        hidden: 0,
        isNew: false,
        hunks: [{ header: '@@ -18,3 +18,4 @@', lines: ['   useEffect(() => {', '-a', '+b', '+c'] }],
      },
    });
    await flush();
    const card = host.querySelector('.ask.warn')!;
    const proto = screen('diff').querySelector('.ask.warn')!;
    expect(skeleton(card.querySelector('.diffbox')!)).toBe(
      skeleton(proto.querySelector('.diffbox')!),
    );
    expect(skeleton(card.querySelector('.acts')!)).toBe(skeleton(proto.querySelector('.acts')!));
    expect(card.querySelector('.diffbox .f')?.textContent).toBe('apps/board/src/Counter.tsx');
    expect([...card.querySelectorAll('.hunk div')].map((d) => d.className)).toEqual([
      'c',
      '',
      'd',
      'a',
      'a',
    ]);
    click(card.querySelector('.diffbox a'));
    expect(posted.at(-1)).toMatchObject({ type: 'diff.open', toolUseId: 'e1' });
    click(button(card, 'Принимать правки до конца сессии'));
    expect(posted.at(-1)).toMatchObject({ type: 'permission.respond', decision: 'allow-edits' });
    await flush();
    expect(host.querySelector('.ask .acts button')).toBeNull(); // ответ ушёл — кнопок нет
  });
});

describe('карточка вопроса', () => {
  const question = ev({
    type: 'question.request',
    toolUseId: 'q1',
    questions: [
      {
        question: 'Каким сообщением коммитить?',
        options: [
          { label: 'fix(board): keep ticket count', description: 'как в истории' },
          { label: 'fix: мигание', description: 'по-русски' },
        ],
        multiSelect: false,
      },
    ],
  });

  it('варианты как в прототипе; цифра 2 — ответ; итог «выбран вариант 2»', async () => {
    const host = mount();
    dispatchEvent(question);
    await flush();
    const card = host.querySelector('.ask')!;
    const proto = screen('permission').querySelector('.ask')!;
    expect(skeleton(card.querySelector('.opt')!)).toBe(
      skeleton(proto.querySelector('.opt:not(.sel)')!),
    );
    expect(card.querySelectorAll('.opt')).toHaveLength(3); // + «Свой вариант»
    key('2');
    expect(posted.at(-1)).toMatchObject({
      type: 'question.answer',
      toolUseId: 'q1',
      answers: { 'Каким сообщением коммитить?': 'fix: мигание' },
    });
    dispatchEvent(
      ev({ type: 'permission.resolved', toolUseId: 'q1', decision: 'allow', by: 'user' }),
    );
    await flush();
    expect(host.querySelector('.ask .tag')?.textContent).toBe('вопрос агента · отвечен');
    expect(host.querySelector('.ask + .sys')?.textContent).toContain('выбран вариант 2');
  });

  it('«Свой вариант» — ответ из поля ввода уходит карточке, не агенту', async () => {
    const host = mount();
    dispatchEvent(question);
    await flush();
    click(button(host.querySelector('.ask')!, '3'));
    await flush();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    expect(ed.getAttribute('data-placeholder')).toContain('свой ответ');
    ed.textContent = 'chore: свой';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    key('Enter', ed);
    expect(posted.some((m) => m['type'] === 'send')).toBe(false);
    expect(posted.at(-1)).toMatchObject({
      type: 'question.answer',
      answers: { 'Каким сообщением коммитить?': 'chore: свой' },
    });
  });
});

describe('карточка плана (plan.html)', () => {
  const plan = ev({
    type: 'plan.request',
    toolUseId: 'p1',
    plan: '# План: устойчивость табло\n\nКоротко.\n\n## Шаги\n1. Раз\n2. Два\n\n## Файлы\n- `apps/board/src/Board.tsx` — правка\n',
  });

  it('кнопки и файлы как в прототипе; «Доработать» ждёт текст из поля', async () => {
    const host = mount();
    dispatchEvent(plan);
    await flush();
    const card = host.querySelector('.ask.plan')!;
    const proto = screen('plan').querySelector('.ask.plan')!;
    expect(skeleton(card.querySelector('.h')!)).toBe(skeleton(proto.querySelector('.h')!));
    expect(skeleton(card.querySelector('.acts')!)).toBe(skeleton(proto.querySelector('.acts')!));
    expect(skeleton(card.querySelector('.files')!)).toBe(skeleton(proto.querySelector('.files')!));
    expect(card.querySelector('.tag')?.textContent).toBe('2 шага · 1 файл');
    expect(host.querySelector('.live')?.textContent).toContain('ждёт решения по плану');

    click(button(card, 'Доработать план'));
    expect(posted.some((m) => m['type'] === 'plan.decide')).toBe(false);
    await flush();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    ed.textContent = 'добавь тесты';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    key('Enter', ed);
    expect(posted.at(-1)).toMatchObject({
      type: 'plan.decide',
      decision: 'refine',
      feedback: 'добавь тесты',
    });
  });

  it('«Выполнять» → run; итог в ленте', async () => {
    const host = mount();
    dispatchEvent(plan);
    await flush();
    click(button(host.querySelector('.ask.plan')!, 'Выполнять'));
    expect(posted.at(-1)).toMatchObject({ type: 'plan.decide', toolUseId: 'p1', decision: 'run' });
    dispatchEvent(
      ev({ type: 'permission.resolved', toolUseId: 'p1', decision: 'allow', by: 'user' }),
    );
    dispatchEvent(ev({ type: 'mode.changed', mode: 'acceptEdits' }));
    await flush();
    const sys = [...host.querySelectorAll('.log .sys')].map((s) => s.textContent);
    expect(sys.some((t) => t?.includes('план принят · выполняю'))).toBe(true);
  });
});

describe('карточки подтверждений Codex', () => {
  it('правка нескольких файлов: «принимать правки» с подсказкой про сессию, а не про режим acceptEdits; ответ allow-edits', async () => {
    provider.value = 'codex';
    const host = mount();
    dispatchEvent(
      ev({
        type: 'permission.request',
        toolUseId: '4',
        toolName: 'Edit',
        input: { file_path: '/p/queue-board/a.ts' },
        description: '/p/queue-board/a.ts, /p/queue-board/b.ts',
        canAlwaysAllow: true,
        always: { rules: [], directories: [], mode: 'acceptEdits' },
      }),
    );
    await flush();
    expect(host.querySelector('.ask .h')?.textContent).toContain('Разрешить правку файла?');
    expect(host.querySelector('.ask .hint')?.textContent).toBe('«всегда» — до конца сессии');
    click(button(host, 'Принимать правки'));
    expect(posted.at(-1)).toMatchObject({ type: 'permission.respond', toolUseId: '4', decision: 'allow-always' });
  });

  it('постоянное правило Codex: подпись называет ~/.codex/rules; права — свой заголовок', async () => {
    provider.value = 'codex';
    const host = mount();
    dispatchEvent(
      ev({
        type: 'permission.request',
        toolUseId: '5',
        toolName: 'Bash',
        input: { command: 'ls' },
        canAlwaysAllow: true,
        always: { rules: ['Bash(ls:*)'], destination: 'codexRules', directories: [] },
      }),
    );
    dispatchEvent(
      ev({
        type: 'permission.request',
        toolUseId: '6',
        toolName: 'Permissions',
        input: { command: 'network' },
        canAlwaysAllow: false,
      }),
    );
    await flush();
    const cards = [...host.querySelectorAll('.ask')];
    expect(cards[0]!.querySelector('.hint')?.textContent).toBe('«всегда» пишется в ~/.codex/rules');
    expect(cards[1]!.querySelector('.h')?.textContent).toContain('Разрешить дополнительные права?');
    expect(cards[1]!.querySelector('pre')?.textContent).toBe('network');
  });
});
