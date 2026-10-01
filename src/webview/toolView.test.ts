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
  toolLinks,
  artifactStatus,
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

describe('Artifact', () => {
  it('toolView: publish — имя файла, иначе title, иначе url; прочие action — action (+ url)', () => {
    expect(toolView('Artifact', { file_path: `${cwd}/docs/page.html` }, cwd)).toEqual({
      op: 'artifact',
      what: 'page.html',
    });
    expect(toolView('Artifact', { action: 'publish', title: 'Отчёт' })).toEqual({
      op: 'artifact',
      what: 'Отчёт',
    });
    expect(toolView('Artifact', { url: 'https://claude.ai/artifact/1' }).what).toBe(
      'https://claude.ai/artifact/1',
    );
    expect(toolView('Artifact', { action: 'quickstart', intent: 'other' })).toEqual({
      op: 'artifact',
      what: 'quickstart',
    });
    expect(toolView('Artifact', { action: 'read', url: 'https://claude.ai/artifact/1' }).what).toBe(
      'read · https://claude.ai/artifact/1',
    );
  });

  it('toolLinks: html у Write/Edit/MultiEdit, только при ok', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit']) {
      expect(toolLinks(name, { file_path: '/a/b/x.HTML' }, undefined, 'ok')).toEqual({
        preview: '/a/b/x.HTML',
      });
    }
    expect(toolLinks('Write', { file_path: '/a/x.htm' }, undefined, 'ok')).toEqual({
      preview: '/a/x.htm',
    });
    expect(toolLinks('Write', { file_path: '/a/x.ts' }, undefined, 'ok')).toEqual({});
    expect(toolLinks('Write', { file_path: '/a/x.html' }, undefined, 'err')).toEqual({});
    expect(toolLinks('Read', { file_path: '/a/x.html' }, undefined, 'ok')).toEqual({});
  });

  it('toolLinks: Artifact — url только с https://claude.ai/, превью из result.path или input.file_path', () => {
    const url = 'https://claude.ai/artifact/abc';
    expect(toolLinks('Artifact', { file_path: '/p/a.html' }, { url, path: '/p/b.html' }, 'ok')).toEqual({
      url,
      preview: '/p/b.html',
    });
    expect(toolLinks('Artifact', { file_path: '/p/a.html' }, { url }, 'ok')).toEqual({
      url,
      preview: '/p/a.html',
    });
    expect(toolLinks('Artifact', { file_path: '/p/a.md' }, { url }, 'ok')).toEqual({ url });
    expect(toolLinks('Artifact', {}, { url: 'https://evil.example/x' }, 'ok')).toEqual({});
    expect(toolLinks('Artifact', {}, 'Error: x', 'ok')).toEqual({});
    expect(toolLinks('Artifact', { file_path: '/p/a.html' }, { url }, 'err')).toEqual({});
  });

  it('artifactStatus: создан / обновлён · vN / опубликован / ничего', () => {
    expect(artifactStatus({ created_from_type: true, url: 'https://claude.ai/a' })).toBe('создан');
    expect(artifactStatus({ updated: true, seq: 3, url: 'https://claude.ai/a' })).toBe(
      'обновлён · v3',
    );
    expect(artifactStatus({ updated: false, url: 'https://claude.ai/a' })).toBe('опубликован');
    expect(artifactStatus({ updated: false })).toBeUndefined();
    expect(artifactStatus({ quickstart: {} })).toBeUndefined();
    expect(artifactStatus('Error: x')).toBeUndefined();
    expect(artifactStatus(undefined)).toBeUndefined();
  });
});
