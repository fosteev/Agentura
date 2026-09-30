// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h, render } from 'preact';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { applyEvent, initialState, queueUser } from './chatState';
import { Empty } from './components/Empty';
import { Hud } from './components/Hud';
import { Log } from './components/Log';

/**
 * Механическая сверка разметки ленты с prototype/screens/chat.html: теги и классы элементов
 * (без текстов), по первому встретившемуся ряду каждого вида.
 */
function skeleton(el: Element): string {
  const cls = [...el.classList].sort().join('.');
  // содержимое правой колонки зависит от данных (+/−, diff, pass) — сверяем только сам контейнер
  const kids = el.classList.contains('r')
    ? []
    : [...el.children].map(skeleton).filter((k, i, all) => k !== all[i - 1]);
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${kids.length ? `[${kids.join(',')}]` : ''}`;
}

const compact = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, '');

const proto = new DOMParser().parseFromString(
  readFileSync(join(__dirname, '..', '..', 'prototype', 'screens', 'chat.html'), 'utf8'),
  'text/html',
);
const protoLog = proto.querySelector('.log')!;

function firstProto(selector: string): string {
  const el = [...protoLog.children].find((c) => c.matches(selector));
  if (!el) throw new Error(`в прототипе нет ${selector}`);
  return skeleton(el);
}

const T0 = 1_700_000_000_000;
const usage = { input: 1204, output: 2318, cacheRead: 128400, cacheWrite: 3902 };

function scenario(): AgentEvent[] {
  return [
    { type: 'turn.start', at: T0, prompt: 'Почини `apps/board`' },
    { type: 'thinking.start', messageId: 'm1', at: T0 },
    { type: 'thinking.delta', messageId: 'm1', text: 'табло сбрасывает состояние' },
    { type: 'thinking.stop', messageId: 'm1', at: T0 + 12_000 },
    { type: 'tool.start', toolUseId: 't1', name: 'Read', input: { file_path: '/p/src/a.ts' } },
    { type: 'tool.result', toolUseId: 't1', isError: false, content: 'ok', durationMs: 400 },
    {
      type: 'tool.start',
      toolUseId: 't2',
      name: 'Grep',
      input: { pattern: 'ticket', path: '/p/apps' },
    },
    {
      type: 'tool.result',
      toolUseId: 't2',
      isError: false,
      content: 'x',
      result: { numFiles: 3 },
      durationMs: 200,
    },
    {
      type: 'tool.start',
      toolUseId: 't3',
      name: 'Edit',
      input: { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' },
    },
    { type: 'tool.result', toolUseId: 't3', isError: false, content: 'ok', durationMs: 1100 },
    { type: 'tool.start', toolUseId: 't4', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool.result', toolUseId: 't4', isError: false, content: 'ok', durationMs: 9800 },
    { type: 'text.delta', messageId: 'm2', text: 'Причина — `Counter`.' },
    {
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 48_000,
      apiDurationMs: 40_000,
      numTurns: 3,
      totalCostUsd: 0.21,
      costUsd: 0.21,
      usage,
      permissionDenials: [],
    },
  ];
}

function renderLog(
  events: AgentEvent[],
  extra?: (s: ReturnType<typeof initialState>) => ReturnType<typeof initialState>,
) {
  let s = queueUser({ ...initialState(), cwd: '/p' }, 'Почини `apps/board`');
  for (const e of events) s = applyEvent(s, e, T0 + 60_000);
  if (extra) s = extra(s);
  const host = document.createElement('div');
  render(
    h(Log, {
      rows: s.rows,
      cwd: '/p',
      now: T0 + 60_000,
      showThinking: true,
      mode: 'manual',
      onDiff: () => {},
    }),
    host,
  );
  return host.querySelector('.log')!;
}

describe('разметка ленты совпадает с chat.html', () => {
  const log = renderLog(scenario());
  const mine = (selector: string) => {
    const el = log.querySelector(`:scope > ${selector}`);
    if (!el) throw new Error(`в ленте нет ${selector}`);
    return skeleton(el);
  };

  it('строка пользователя', () => expect(mine('.u')).toBe(firstProto('.u')));
  it('think', () => expect(mine('.e.think')).toBe(firstProto('.e.think')));
  it('инструмент', () => expect(mine('.e:not(.think)')).toBe(firstProto('.e:not(.think)')));
  it('запуск команды (bash)', () => expect(mine('.e.run')).toBe(firstProto('.e.run')));
  it('ответ', () => expect(mine('.txt')).toBe(firstProto('.txt')));
  it('итог хода', () => expect(mine('.sum')).toBe(firstProto('.sum')));

  it('правая колонка edit: +/− и ссылка diff', () => {
    const edit = [...log.querySelectorAll('.e')].find(
      (e) => e.querySelector('.op')?.textContent === 'edit',
    )!;
    expect(edit.querySelector('.r a')?.textContent).toBe('diff');
    expect(edit.querySelector('.r .add')?.textContent).toBe('+1');
    expect(edit.querySelector('.what .dim')?.textContent).toBe('src/');
  });

  it('тексты: итог хода — как в прототипе (in / out / cache r… w…, стоимость, время)', () => {
    const sum = log.querySelector('.sum')!;
    expect([...sum.children].map((c) => c.textContent)).toEqual([
      'in 1 204',
      'out 2 318',
      'cache r128 400 w3 902',
      '$0.21',
      '48s',
    ]);
    expect(log.querySelector('.u code')?.textContent).toBe('apps/board');
    expect(log.querySelector('.txt code')?.textContent).toBe('Counter');
  });

  it('бегущий инструмент: spinner и классы now', () => {
    const running = renderLog(scenario().slice(0, 11));
    const row = running.querySelector('.e.run.now')!;
    expect(skeleton(row)).toBe(firstProto('.e.run.now'));
  });

  it('очередь: сообщение без turn.start помечено «в очереди»', () => {
    const l = renderLog([]);
    expect(l.querySelector('.u .at')?.textContent).toBe('в очереди');
  });
});

describe('пустое состояние и шапка совпадают с empty.html', () => {
  const emptyProto = new DOMParser().parseFromString(
    readFileSync(join(__dirname, '..', '..', 'prototype', 'screens', 'empty.html'), 'utf8'),
    'text/html',
  );

  it('экран empty: заголовок, подсказки, недавние сессии', () => {
    const host = document.createElement('div');
    const sessions = ['a', 'b', 'c'].map((id, i) => ({
      id,
      title: id,
      turns: i,
      state: 'idle' as const,
      updatedAt: T0,
    }));
    render(h(Empty, { project: 'queue-board', recent: sessions, onResume: () => {} }), host);
    expect(skeleton(host.querySelector('.empty')!)).toBe(
      skeleton(emptyProto.querySelector('.empty')!),
    );
    expect(host.querySelector('h2')?.textContent).toBe('Новая сессия в queue-board');
    expect(compact(host.querySelector('.tips'))).toBe(compact(emptyProto.querySelector('.tips')));
  });

  it('шапка: вкладки, название, sessions/new; ход и агенты отключены в пустой сессии', () => {
    const host = document.createElement('div');
    render(
      h(Hud, {
        project: 'queue-board',
        tab: 'chat',
        onTab: () => {},
        sidePanesEnabled: false,
        badges: {},
        onSessions: () => {},
        onNew: () => {},
      }),
      host,
    );
    expect(skeleton(host.querySelector('header')!)).toBe(
      skeleton(emptyProto.querySelector('header.hud')!),
    );
    expect(compact(host.querySelector('header'))).toBe(
      compact(emptyProto.querySelector('header.hud')),
    );
    expect(
      [...host.querySelectorAll('.tabs button')].map((b) => b.hasAttribute('disabled')),
    ).toEqual([false, true, true]);
  });
});
