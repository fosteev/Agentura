import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appliedSides, previewOf, proposedSides } from './editDiff';

const logsDir = join(__dirname, '..', '..', 'spikes', 'sdk-probe', 'logs');
const line = (log: string, n: number) =>
  JSON.parse(readFileSync(join(logsDir, `${log}.jsonl`), 'utf8').split('\n')[n - 1]!) as Record<
    string,
    unknown
  >;

const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('превью правки до применения', () => {
  it('Edit: фрагмент найден — дифф по файлу с номерами строк и контекстом 3', () => {
    const sides = proposedSides(
      {
        kind: 'edit',
        filePath: '/p/a.ts',
        oldText: 'line 18\n',
        newText: 'line 18a\nline 18b\n',
        replaceAll: false,
      },
      file,
    );
    expect(sides.fragment).toBeUndefined();
    const p = previewOf(sides);
    expect([p.add, p.del, p.isNew]).toEqual([2, 1, false]);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]!.header).toBe('@@ -15,7 +15,8 @@');
    expect(p.hunks[0]!.lines).toEqual([
      ' line 15',
      ' line 16',
      ' line 17',
      '-line 18',
      '+line 18a',
      '+line 18b',
      ' line 19',
      ' line 20',
      ' line 21',
    ]);
  });

  it('Edit: replace_all меняет все вхождения; `$&` в новом тексте не шаблон', () => {
    const sides = proposedSides(
      { kind: 'edit', filePath: '/p/a.ts', oldText: 'x', newText: '$&y', replaceAll: true },
      'x1\nx2\n',
    );
    expect(sides.after).toBe('$&y1\n$&y2\n');
    const once = proposedSides(
      { kind: 'edit', filePath: '/p/a.ts', oldText: 'x', newText: '$&', replaceAll: false },
      'x1\nx2\n',
    );
    expect(once.after).toBe('$&1\nx2\n');
  });

  it('Edit: фрагмента нет в файле (или файла нет) — превью по самим фрагментам', () => {
    const d = {
      kind: 'edit' as const,
      filePath: '/p/a.ts',
      oldText: 'nope\n',
      newText: 'yes\n',
      replaceAll: false,
    };
    for (const text of [file, undefined]) {
      const sides = proposedSides(d, text);
      expect(sides).toMatchObject({ before: 'nope\n', after: 'yes\n', fragment: true });
      const p = previewOf(sides);
      expect(p.note).toBe('fragment');
      expect([p.add, p.del]).toEqual([1, 1]);
    }
  });

  it('Write: новый файл и перезапись существующего', () => {
    const created = previewOf(
      proposedSides({ kind: 'write', filePath: '/p/n.md', content: 'a\nb\n' }, undefined),
    );
    expect([created.isNew, created.add, created.del]).toEqual([true, 2, 0]);
    const over = previewOf(
      proposedSides(
        { kind: 'write', filePath: '/p/a.ts', content: file.replace('line 3\n', 'LINE 3\n') },
        file,
      ),
    );
    expect([over.isNew, over.add, over.del]).toEqual([false, 1, 1]);
  });

  it('CRLF-файл: фрагмент с \\n находится, правка сохраняет \\r\\n, в превью нет \\r', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const sides = proposedSides(
      { kind: 'edit', filePath: '/p/w.txt', oldText: 'b\nc', newText: 'B\nc', replaceAll: false },
      crlf,
    );
    expect(sides.fragment).toBeUndefined();
    expect(sides.after).toBe('a\r\nB\r\nc\r\n');
    const p = previewOf(sides);
    expect(p.hunks[0]!.header).toBe('@@ -1,3 +1,3 @@');
    expect(p.hunks[0]!.lines).toEqual([' a', '-b', '+B', ' c']);
  });

  it('пустой файл, новый файл, файл без перевода строки в конце — заголовки как у diff -u', () => {
    const empty = previewOf(proposedSides({ kind: 'write', filePath: '/p/e', content: 'x\n' }, ''));
    expect([empty.isNew, empty.add, empty.del]).toEqual([false, 1, 0]);
    expect(empty.hunks[0]!.header).toBe('@@ -0,0 +1,1 @@');
    const created = previewOf(
      proposedSides(
        { kind: 'edit', filePath: '/p/n', oldText: '', newText: 'x\n', replaceAll: false },
        undefined,
      ),
    );
    expect([created.isNew, created.hunks[0]!.header]).toEqual([true, '@@ -0,0 +1,1 @@']);
    const noEol = previewOf(
      proposedSides(
        { kind: 'edit', filePath: '/p/t', oldText: 'b', newText: 'c', replaceAll: false },
        'a\nb',
      ),
    );
    expect(noEol.hunks[0]!.lines).toEqual([' a', '-b', '+c']);
    expect([noEol.add, noEol.del]).toEqual([1, 1]);
  });

  it('CRLF-файл: вставленные строки тоже с \r\n; пустой файл + пустой old_string — запись', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const sides = proposedSides(
      { kind: 'edit', filePath: '/p/w', oldText: 'b', newText: 'b1\nb2', replaceAll: false },
      crlf,
    );
    expect(sides.after).toBe('a\r\nb1\r\nb2\r\nc\r\n');
    const empty = proposedSides(
      { kind: 'edit', filePath: '/p/e', oldText: '', newText: 'x\n', replaceAll: false },
      '',
    );
    expect(empty).toMatchObject({ before: '', after: 'x\n', isNew: false });
    expect(empty.fragment).toBeUndefined();
  });

  it('превью обрезается по строкам, остаток — в hidden', () => {
    const big = Array.from({ length: 100 }, (_, i) => `n${i}`).join('\n') + '\n';
    const p = previewOf(proposedSides({ kind: 'write', filePath: '/p/b', content: big }, ''), 40);
    expect(p.hunks.flatMap((h) => h.lines)).toHaveLength(40);
    expect(p.hidden).toBe(60);
    expect(p.add).toBe(100);
  });
});

describe('дифф применённой правки из tool_use_result (логи пробы)', () => {
  it('Edit (02:50): originalFile + structuredPatch → после = файл с правкой', () => {
    const r = line('02-permissions-edit', 50)['tool_use_result'] as Record<string, unknown>;
    const sides = appliedSides('Edit', {}, r)!;
    expect(sides.before).toBe(r['originalFile']);
    expect(sides.after).toBe(
      (r['originalFile'] as string).replace(r['oldString'] as string, r['newString'] as string),
    );
    expect(sides.fragment).toBeUndefined();
    const p = previewOf(sides);
    expect([p.add, p.del]).toEqual([1, 0]);
  });

  it('Write create (02:135): до — пусто, файл новый', () => {
    const r = line('02-permissions-edit', 135)['tool_use_result'];
    expect(appliedSides('Write', {}, r)).toMatchObject({ before: '', after: 'probe', isNew: true });
  });

  it('Write update (04:146): до — originalFile', () => {
    const r = line('04-plan-mode', 146)['tool_use_result'] as Record<string, unknown>;
    const sides = appliedSides('Write', {}, r)!;
    expect(sides).toMatchObject({ before: r['originalFile'], after: r['content'], isNew: false });
  });

  it('Write update без originalFile (большой файл) — не новый файл, а фрагмент', () => {
    const sides = appliedSides(
      'Write',
      { file_path: '/p/big', content: 'new\n' },
      {
        type: 'update',
        filePath: '/p/big',
        content: 'new\n',
        originalFile: null,
        structuredPatch: [],
      },
    );
    expect(sides).toMatchObject({ isNew: false, fragment: true, after: 'new\n' });
  });

  it('не правка или ошибка — нет сторон', () => {
    expect(appliedSides('Bash', {}, { stdout: '' })).toBeUndefined();
    expect(appliedSides('Edit', {}, 'Error: denied')).toBeUndefined();
  });
});
