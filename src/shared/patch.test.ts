import { describe, expect, it } from 'vitest';
import { parsePatch } from './patch';

describe('parsePatch', () => {
  it('обычный патч: хунки, номера строк, маркер «без перевода строки» пропускается', () => {
    const p = parsePatch(
      [
        'diff --git a/a.ts b/a.ts',
        'index 111..222 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@ fn',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '\\ No newline at end of file',
        '@@ -10 +10,2 @@',
        ' ten',
        '+eleven',
        '',
      ].join('\n'),
    );
    expect(p.binary).toBe(false);
    expect(p.truncated).toBe(false);
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]!.header).toBe('@@ -1,3 +1,3 @@ fn');
    expect(p.hunks[0]!.lines).toEqual([
      { kind: ' ', text: 'one', old: 1, new: 1 },
      { kind: '-', text: 'two', old: 2, new: null },
      { kind: '+', text: 'TWO', old: null, new: 2 },
      { kind: ' ', text: 'three', old: 3, new: 3 },
    ]);
    expect(p.hunks[1]).toMatchObject({ oldStart: 10, newStart: 10 });
    expect(p.hunks[1]!.lines.map((l) => l.new)).toEqual([10, 11]);
  });

  it('переименование без правок: шапка есть, хунков нет, не бинарный', () => {
    const p = parsePatch(
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n',
    );
    expect(p).toEqual({ binary: false, hunks: [], truncated: false });
  });

  it('бинарный файл и GIT binary patch', () => {
    expect(parsePatch('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n').binary).toBe(true);
    expect(parsePatch('diff --git a/x b/x\nGIT binary patch\nliteral 3\n').binary).toBe(true);
  });

  it('потолок строк: хвост отбрасывается, truncated', () => {
    const body = Array.from({ length: 10 }, (_, i) => `+l${i}`).join('\n');
    const p = parsePatch(`@@ -0,0 +1,10 @@\n${body}\n`, 4);
    expect(p.truncated).toBe(true);
    expect(p.hunks[0]!.lines).toHaveLength(4);
  });
});
