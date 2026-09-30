import { describe, expect, it } from 'vitest';
import { attachmentKey, attachmentLabel, buildPrompt, splitPrompt } from './prompt';

describe('контекст сообщения', () => {
  it('без вложений текст не меняется', () => expect(buildPrompt('привет', [])).toBe('привет'));

  it('блок собирается и отделяется обратно', () => {
    const sel = { kind: 'selection', path: 'src/a.ts', startLine: 12, endLine: 40 } as const;
    const p = buildPrompt(
      'поправь',
      [{ kind: 'file', path: 'src/a.ts' }, sel, { kind: 'folder', path: 'docs' }],
      { [attachmentKey(sel)]: 'const x = 1;' },
    );
    expect(p).toContain('- файл: src/a.ts');
    expect(p).toContain('- выделение: src/a.ts:12-40');
    expect(p).toContain('- папка: docs');
    expect(p).toContain('const x = 1;');
    const { text, context } = splitPrompt(p);
    expect(text).toBe('поправь');
    expect(context).toContain('src/a.ts');
  });

  it('выделение с ``` внутри ограждается длиннее', () => {
    const a = { kind: 'selection' as const, path: 'r.md', startLine: 1, endLine: 3 };
    const p = buildPrompt('x', [a], { [attachmentKey(a)]: '```ts\ncode\n```' });
    expect(p).toContain('````\n```ts\ncode\n```\n````');
  });

  it('текст без маркера — как есть', () =>
    expect(splitPrompt('просто')).toEqual({ text: 'просто' }));

  it('подписи чипов', () => {
    expect(
      attachmentLabel({ kind: 'selection', path: 'a/B.tsx', startLine: 12, endLine: 40 }),
    ).toEqual({ name: 'B.tsx', range: ' 12–40' });
    expect(attachmentLabel({ kind: 'folder', path: 'a/docs' })).toEqual({
      name: 'docs/',
      range: '',
    });
  });
});
