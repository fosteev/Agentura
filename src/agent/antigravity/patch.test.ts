import { describe, expect, it } from 'vitest';
import { parseDiffBlocks } from './patch';

const wrap = (body: string) => `The following changes were made.\n[diff_block_start]\n${body}\n[diff_block_end]\n\nPlease note that...`;

describe('parseDiffBlocks', () => {
  it('один ханк из реального результата replace_file_content', () => {
    const hunks = parseDiffBlocks(wrap('@@ -1,2 +1,2 @@\n-hi\n+hello world\n '));
    expect(hunks).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-hi', '+hello world', ' '] }]);
  });

  it('несколько блоков и ханков, счётчик без запятой = 1', () => {
    const hunks = parseDiffBlocks(`${wrap('@@ -1 +1 @@\n-a\n+b')}\n${wrap('@@ -10,2 +10,3 @@\n x\n+y\n z')}`);
    expect(hunks).toHaveLength(2);
    expect(hunks?.[0]).toMatchObject({ oldStart: 1, oldLines: 1, newLines: 1, lines: ['-a', '+b'] });
    expect(hunks?.[1]).toMatchObject({ oldStart: 10, oldLines: 2, newLines: 3 });
  });

  it('нет блока, мусор или несошедшиеся счётчики — undefined, не исключение', () => {
    expect(parseDiffBlocks('Created file with requested content.')).toBeUndefined();
    expect(parseDiffBlocks(wrap('not a diff'))).toBeUndefined();
    expect(parseDiffBlocks(wrap('@@ -1,5 +1,5 @@\n-a\n+b'))).toBeUndefined();
  });

  it('CRLF и маркер «нет перевода строки» не ломают разбор', () => {
    const hunks = parseDiffBlocks(wrap('@@ -1 +1 @@\r\n-a\r\n+b\r\n\\ No newline at end of file'));
    expect(hunks?.[0]?.lines).toEqual(['-a', '+b']);
  });
});
