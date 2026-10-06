import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { CodexEventMapper } from './mapper';

const THREAD = 'thr';
const base = { threadId: THREAD, turnId: 'turn-1' };
const mapper = () => {
  const m = new CodexEventMapper(() => 10_000);
  m.threadId = THREAD;
  return m;
};
const command = (status: string, extra: Record<string, unknown> = {}) => ({
  type: 'commandExecution',
  id: 'exec-1',
  command: '/bin/zsh -lc ls',
  cwd: '/work',
  status,
  source: 'agent',
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...extra,
});
const started = (item: unknown, at = 1000) => ({ ...base, item, startedAtMs: at });
const completed = (item: unknown, at = 2500) => ({ ...base, item, completedAtMs: at });
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

describe('команды: commandExecution → Bash', () => {
  it('start: имя Bash, команда без обёртки оболочки, время из startedAtMs', () => {
    const [start] = mapper().map('item/started', started(command('inProgress')));
    expect(start).toEqual({
      type: 'tool.start',
      toolUseId: 'exec-1',
      name: 'Bash',
      input: { command: 'ls' },
      at: 1000,
    });
  });

  it('вывод — из outputDelta (aggregatedOutput у живого сервера бывает null); прогресс не чаще раза в секунду', () => {
    let now = 1000;
    const m = new CodexEventMapper(() => now);
    m.threadId = THREAD;
    m.map('item/started', started(command('inProgress')));
    now = 1100;
    const first = m.map('item/commandExecution/outputDelta', { ...base, itemId: 'exec-1', delta: 'a.txt\n' });
    now = 1500;
    const second = m.map('item/commandExecution/outputDelta', { ...base, itemId: 'exec-1', delta: 'b.txt\n' });
    now = 2300;
    const third = m.map('item/commandExecution/outputDelta', { ...base, itemId: 'exec-1', delta: '' });
    expect(first).toEqual([{ type: 'tool.progress', toolUseId: 'exec-1', name: 'Bash', elapsedMs: 100 }]);
    expect(second).toEqual([]);
    expect(third).toMatchObject([{ type: 'tool.progress', elapsedMs: 1300 }]);
    const [result] = m.map('item/completed', completed(command('completed', { exitCode: 0, durationMs: 900 })));
    expect(result).toMatchObject({
      type: 'tool.result',
      toolUseId: 'exec-1',
      isError: false,
      content: 'a.txt\nb.txt\n',
      result: { stdout: 'a.txt\nb.txt\n', exitCode: 0 },
      durationMs: 900,
    });
  });

  it('exit ≠ 0 и failed — isError; declined — isError с пометкой', () => {
    const m = mapper();
    m.map('item/started', started(command('inProgress')));
    const [bad] = m.map('item/completed', completed(command('completed', { exitCode: 2, aggregatedOutput: 'boom' })));
    expect(bad).toMatchObject({ isError: true, content: 'boom', result: { exitCode: 2 } });
    m.map('item/started', started(command('inProgress')));
    const [declined] = m.map('item/completed', completed(command('declined')));
    expect(declined).toMatchObject({ isError: true, content: 'declined', result: { declined: true } });
  });

  it('вывода нет (aggregatedOutput null, без delta): exit ≠ 0 и failed не выглядят пустым успехом', () => {
    const m = mapper();
    m.map('item/started', started(command('inProgress')));
    const [exit] = m.map('item/completed', completed(command('completed', { exitCode: 127 })));
    expect(exit).toMatchObject({ isError: true, content: 'exit code 127' });
    m.map('item/started', started(command('inProgress')));
    const [failed] = m.map('item/completed', completed(command('failed')));
    expect(failed).toMatchObject({ isError: true, content: 'failed' });
    m.map('item/started', started(command('inProgress')));
    const [ok] = m.map('item/completed', completed(command('completed', { exitCode: 0 })));
    expect(ok).toMatchObject({ isError: false, content: '' });
  });

  it('aggregatedOutput длиннее 100 КБ обрезается с пометкой', () => {
    const m = mapper();
    const [r] = m.map('item/completed', completed(command('completed', { exitCode: 0, aggregatedOutput: 'x'.repeat(150_000) }))).slice(-1);
    expect((r as { content: string }).content).toHaveLength(100_000 + '\n[output truncated]'.length);
  });

  it('completed без started (resume) — tool.start перед результатом', () => {
    const events = mapper().map('item/completed', completed(command('completed', { exitCode: 0 })));
    expect(events.map((e) => e.type)).toEqual(['tool.start', 'tool.result']);
  });

  it('вывод длиннее лимита обрезается с пометкой', () => {
    const m = mapper();
    m.map('item/started', started(command('inProgress')));
    m.map('item/commandExecution/outputDelta', { ...base, itemId: 'exec-1', delta: 'x'.repeat(150_000) });
    const [result] = of(m.map('item/completed', completed(command('completed', { exitCode: 0 }))), 'tool.result');
    expect(result!.content.length).toBeLessThan(100_100);
    expect(result!.content).toMatch(/output truncated/);
  });

  it('чужой тред не трогает ленту', () => {
    expect(mapper().map('item/started', { ...started(command('inProgress')), threadId: 'other' })).toEqual([]);
  });
});

describe('правки: fileChange → Write/Edit', () => {
  const add = { path: '/work/a.txt', kind: { type: 'add' }, diff: 'hi\n' };
  const update = {
    path: '/work/b.txt',
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,3 +1,3 @@\n line1\n-line2\n+line two\n line3\n',
  };
  const item = (changes: unknown[], status = 'inProgress') => ({ type: 'fileChange', id: 'fc-1', changes, status });

  it('создание — Write: content и результат type create', () => {
    const m = mapper();
    const [start] = m.map('item/started', started(item([add])));
    expect(start).toMatchObject({
      type: 'tool.start',
      toolUseId: 'fc-1',
      name: 'Write',
      input: { file_path: '/work/a.txt', content: 'hi\n' },
    });
    const [result] = m.map('item/completed', completed(item([add], 'completed')));
    expect(result).toMatchObject({
      type: 'tool.result',
      toolUseId: 'fc-1',
      isError: false,
      result: { type: 'create', filePath: '/work/a.txt', content: 'hi\n' },
    });
  });

  it('правка — Edit: old/new из ханков и structuredPatch (счётчики вкладки «изменения»)', () => {
    const m = mapper();
    const [start] = m.map('item/started', started(item([update])));
    expect(start).toMatchObject({
      name: 'Edit',
      input: { file_path: '/work/b.txt', old_string: 'line1\nline2\nline3', new_string: 'line1\nline two\nline3' },
    });
    const [result] = of(m.map('item/completed', completed(item([update], 'completed'))), 'tool.result');
    expect(result!.result).toMatchObject({
      filePath: '/work/b.txt',
      oldString: 'line1\nline2\nline3',
      structuredPatch: [{ oldStart: 1, lines: [' line1', '-line2', '+line two', ' line3'] }],
    });
  });

  it('удаление — Edit со старым содержимым; перенос — по новому пути', () => {
    const m = mapper();
    const del = { path: '/work/c.txt', kind: { type: 'delete' }, diff: 'x\ny\n' };
    const moved = { path: '/work/d.txt', kind: { type: 'update', move_path: '/work/e.txt' }, diff: '@@ -1 +1 @@\n-a\n+b\n' };
    const starts = of(m.map('item/started', started(item([del, moved]))), 'tool.start');
    expect(starts.map((e) => [e.toolUseId, e.name, e.input['file_path']])).toEqual([
      ['fc-1', 'Edit', '/work/c.txt'],
      ['fc-1#1', 'Edit', '/work/e.txt'],
    ]);
    const results = of(m.map('item/completed', completed(item([del, moved], 'completed'))), 'tool.result');
    expect(results[0]!.result).toMatchObject({ type: 'delete', structuredPatch: [{ lines: ['-x', '-y'] }] });
  });

  it('набор файлов уточнился patchUpdated: новые строки стартуют, прежние — нет', () => {
    const m = mapper();
    m.map('item/started', started(item([])));
    expect(m.map('item/fileChange/patchUpdated', { ...base, itemId: 'fc-1', changes: [add] })).toHaveLength(1);
    expect(m.map('item/fileChange/patchUpdated', { ...base, itemId: 'fc-1', changes: [add, update] })).toMatchObject([
      { toolUseId: 'fc-1#1' },
    ]);
  });

  it('отказ — все строки закрываются ошибкой; changesOf отдаёт правки для карточки', () => {
    const m = mapper();
    m.map('item/started', started(item([add])));
    expect(m.changesOf('fc-1')).toEqual([add]);
    const results = of(m.map('item/completed', completed(item([add], 'declined'))), 'tool.result');
    expect(results).toMatchObject([{ toolUseId: 'fc-1', isError: true, content: 'declined' }]);
    expect(m.changesOf('fc-1')).toBeUndefined();
  });
});

describe('MCP, поиск, динамические инструменты', () => {
  it('mcpToolCall → mcp__server__tool; текст результата из content; ошибка — isError', () => {
    const m = mapper();
    const call = (status: string, extra: Record<string, unknown> = {}) => ({
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      status,
      arguments: { q: 'x' },
      result: null,
      error: null,
      durationMs: null,
      ...extra,
    });
    expect(m.map('item/started', started(call('inProgress')))).toMatchObject([
      { type: 'tool.start', name: 'mcp__docs__search', input: { q: 'x' } },
    ]);
    const [ok] = m.map(
      'item/completed',
      completed(call('completed', { result: { content: [{ type: 'text', text: 'found' }], structuredContent: null }, durationMs: 40 })),
    );
    expect(ok).toMatchObject({ type: 'tool.result', isError: false, content: 'found', durationMs: 40 });
    m.map('item/started', started(call('inProgress')));
    const [bad] = m.map('item/completed', completed(call('failed', { error: { message: 'denied' } })));
    expect(bad).toMatchObject({ isError: true, content: 'denied' });
  });

  it('webSearch → WebSearch с запросом', () => {
    const m = mapper();
    const events = m.map('item/started', started({ type: 'webSearch', id: 'ws-1', query: 'codex', action: null }));
    expect(events).toMatchObject([{ type: 'tool.start', name: 'WebSearch', input: { query: 'codex' } }]);
    expect(m.map('item/completed', completed({ type: 'webSearch', id: 'ws-1', query: 'codex', action: null }))).toMatchObject([
      { type: 'tool.result', isError: false },
    ]);
  });

  it('неизвестные виды элементов молчат', () => {
    const m = mapper();
    expect(m.map('item/started', started({ type: 'imageView', id: 'i', path: '/x' }))).toEqual([]);
    expect(m.map('item/completed', completed({ type: 'contextCompaction', id: 'c' }))).toEqual([]);
  });
});

describe('поздний item/completed после turn/completed', () => {
  it('результат всё равно приходит (лента найдёт строку по toolUseId)', () => {
    const m = mapper();
    m.map('turn/started', { threadId: THREAD, turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } });
    m.map('item/started', started(command('inProgress')));
    m.map('turn/completed', { threadId: THREAD, turn: { id: 'turn-1', items: [], status: 'completed', error: null } });
    expect(m.map('item/completed', completed(command('completed', { exitCode: 0 })))).toMatchObject([
      { type: 'tool.result', toolUseId: 'exec-1' },
    ]);
  });
});
