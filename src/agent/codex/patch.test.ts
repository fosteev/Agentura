import { describe, expect, it } from 'vitest';
import { changePath, displayCommand, parseHunks, sidesOfHunks } from './patch';

describe('parseHunks', () => {
  it('ханки без заголовков файла — как их присылает Codex (живая запись)', () => {
    const hunks = parseHunks('@@ -1,3 +1,3 @@\n line1\n-line2\n+line two\n line3\n');
    expect(hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' line1', '-line2', '+line two', ' line3'] },
    ]);
  });

  it('заголовки diff --git/---/+++ до первого @@ пропускаются; несколько ханков; счётчик 1 по умолчанию', () => {
    const hunks = parseHunks(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,3 @@\n c\n+d\n e\n\\ No newline at end of file\n',
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] });
    expect(hunks[1]!.lines).toEqual([' c', '+d', ' e', '\\ No newline at end of file']);
  });

  it('не diff — пусто', () => {
    expect(parseHunks('просто текст\nбез ханков')).toEqual([]);
    expect(parseHunks('')).toEqual([]);
  });
});

describe('sidesOfHunks', () => {
  it('контекст в обеих сторонах, - только в старой, + только в новой', () => {
    const sides = sidesOfHunks(parseHunks('@@ -1,3 +1,3 @@\n line1\n-line2\n+line two\n line3\n'));
    expect(sides).toEqual({ oldText: 'line1\nline2\nline3', newText: 'line1\nline two\nline3' });
  });
});

describe('changePath', () => {
  it('у переноса — новое место', () => {
    expect(changePath({ path: '/a', kind: { type: 'update', move_path: '/b' }, diff: '' })).toBe('/b');
    expect(changePath({ path: '/a', kind: { type: 'update', move_path: null }, diff: '' })).toBe('/a');
    expect(changePath({ path: '/a', kind: { type: 'add' }, diff: '' })).toBe('/a');
  });
});

describe('displayCommand', () => {
  it('обёртка оболочки снимается, когда вид однозначный', () => {
    expect(displayCommand('/bin/zsh -lc ls')).toBe('ls');
    expect(displayCommand("/bin/bash -lc 'git status --short'")).toBe('git status --short');
    expect(displayCommand('/bin/zsh -c "npm test"')).toBe('npm test');
  });

  it('неоднозначное — строка как есть (семантику не угадываем)', () => {
    expect(displayCommand("/bin/zsh -lc 'echo it'\"'\"'s'")).toBe("/bin/zsh -lc 'echo it'\"'\"'s'");
    expect(displayCommand('/bin/zsh -lc "echo $HOME"')).toBe('/bin/zsh -lc "echo $HOME"');
    expect(displayCommand('/bin/zsh -lc ls -la')).toBe('/bin/zsh -lc ls -la');
    expect(displayCommand('python script.py')).toBe('python script.py');
    // не системный шелл — это чужой скрипт: обёртку не снимаем, иначе карточка показала бы не то, что запустится
    expect(displayCommand('./bash -c ls')).toBe('./bash -c ls');
    expect(displayCommand('/tmp/x/sh -lc ls')).toBe('/tmp/x/sh -lc ls');
    expect(displayCommand('zsh -lc ls')).toBe('ls');
  });
});
