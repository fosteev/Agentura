import { describe, expect, it } from 'vitest';
import { directoriesOf, excludeGlobs, rankFiles } from './fileSearch';

const files = [
  'apps/board/src/Counter.tsx',
  'apps/board/src/__tests__/Counter.test.tsx',
  'packages/ws-client/src/counter/index.ts',
  'README.md',
];

describe('поиск для «@»', () => {
  it('каталоги выводятся из путей файлов', () => {
    expect(directoriesOf(files).sort()).toContain('apps/board/src/__tests__');
    expect(directoriesOf(files)).toContain('apps');
  });
  it('точное имя выше префикса и вхождения; файлы раньше папок при равной оценке', () => {
    const hits = rankFiles(files, 'counter');
    expect(hits[0]?.path).toBe('packages/ws-client/src/counter');
    expect(hits.map((h) => h.name)).toContain('Counter.tsx');
    expect(hits.find((h) => h.name === 'Counter.tsx')).toMatchObject({
      dir: 'apps/board/src',
      isDir: false,
    });
  });
  it('пустой запрос: верхний уровень первым', () => {
    expect(rankFiles(files, '')[0]?.path).toBe('README.md');
  });
  it('нечёткое совпадение по подпоследовательности', () => {
    expect(rankFiles(files, 'cntr').some((h) => h.name === 'Counter.tsx')).toBe(true);
    expect(rankFiles(files, 'zzz')).toEqual([]);
  });
  it('исключения: включённые глобы + всегда .git и node_modules', () => {
    expect(excludeGlobs({ '**/dist': true, '**/keep': false }, undefined)).toEqual([
      '**/.git/**',
      '**/node_modules/**',
      '**/dist',
    ]);
  });
});
