import { describe, expect, it } from 'vitest';
import {
  editStats,
  formatCost,
  formatDuration,
  formatInt,
  matchCount,
  relPath,
  shortModel,
  toolView,
} from './toolView';

const cwd = '/Users/fost/Projects/Agentura';

describe('toolView', () => {
  it('read/edit: каталог серым, имя файла отдельно, путь относительно cwd', () => {
    expect(toolView('Read', { file_path: `${cwd}/src/protocol.ts` }, cwd)).toEqual({
      op: 'read',
      dim: 'src/',
      what: 'protocol.ts',
    });
    expect(toolView('Edit', { file_path: `${cwd}/README.md` }, cwd)).toEqual({
      op: 'edit',
      what: 'README.md',
      edit: true,
    });
  });
  it('grep: паттерн, затем «в путь»', () => {
    expect(
      toolView('Grep', { pattern: 'ticketCount', path: `${cwd}/apps/board` }, cwd),
    ).toMatchObject({
      op: 'grep',
      what: 'ticketCount',
      dim: 'в apps/board',
      dimAfter: true,
    });
  });
  it('bash: первая строка команды, класс run', () => {
    expect(toolView('Bash', { command: 'npm test\nnpm run build' })).toMatchObject({
      op: 'bash',
      what: 'npm test',
      run: true,
    });
  });
  it('mcp-инструмент: короткое имя и первое строковое поле', () => {
    expect(toolView('mcp__jira__get_issue', { key: 'GARM-1' })).toMatchObject({
      op: 'get_iss',
      what: 'GARM-1',
    });
  });
  it('relPath не трогает пути вне cwd', () => {
    expect(relPath('/etc/hosts', cwd)).toBe('/etc/hosts');
  });
});

describe('editStats / matchCount', () => {
  it('по structuredPatch', () => {
    const result = { structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] };
    expect(editStats('Edit', {}, result)).toEqual({ add: 2, del: 1 });
  });
  it('Write без патча — строки содержимого', () => {
    expect(editStats('Write', { content: 'a\nb\nc' }, { structuredPatch: [] })).toEqual({
      add: 3,
      del: 0,
    });
  });
  it('по входу, если результата нет', () => {
    expect(editStats('Edit', { old_string: 'a', new_string: 'a\nb' }, undefined)).toEqual({
      add: 2,
      del: 1,
    });
  });
  it('не для Read', () => expect(editStats('Read', {}, {})).toBeUndefined());
  it('matchCount: numFiles / filenames', () => {
    expect(matchCount('Grep', { numFiles: 3 })).toBe(3);
    expect(matchCount('Glob', { filenames: ['a', 'b'] })).toBe(2);
    expect(matchCount('Bash', { numFiles: 3 })).toBeUndefined();
  });
});

describe('форматы', () => {
  it('длительность', () => {
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
  it('числа и стоимость', () => {
    expect(formatInt(128400)).toBe('128 400');
    expect(formatCost(0.2134)).toBe('$0.21');
    expect(formatCost(0.004)).toBe('$0.004');
  });
  it('имена моделей', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5.5');
    expect(shortModel('claude-sonnet-4-20250514')).toBe('sonnet-4');
    expect(shortModel('opus')).toBe('opus');
  });
});
