import { describe, expect, it } from 'vitest';
import { pathKey, resolveFrom, samePath } from './pathKey';

describe('сравнение путей', () => {
  it('posix: `..`, двойные и хвостовые слеши нормализуются, регистр различается', () => {
    expect(samePath('/p/a/../b/c.ts', '/p/b/c.ts', 'darwin')).toBe(true);
    expect(samePath('/p//b/c.ts', '/p/b/c.ts', 'linux')).toBe(true);
    expect(samePath('/p/B/c.ts', '/p/b/c.ts', 'linux')).toBe(false);
    expect(pathKey('/p/b/', 'linux')).toBe('/p/b');
    expect(pathKey('/', 'linux')).toBe('/');
  });

  it('Windows: буква диска и регистр, слеши обоих видов', () => {
    expect(samePath('C:\\Work\\App\\a.ts', 'c:/work/app/a.ts', 'win32')).toBe(true);
    expect(samePath('c:\\w\\x\\..\\a.ts', 'C:\\w\\a.ts', 'win32')).toBe(true);
    expect(samePath('C:\\w\\a.ts', 'C:\\w\\b.ts', 'win32')).toBe(false);
  });

  it('resolveFrom: относительный путь — от cwd сессии, абсолютный как есть', () => {
    expect(resolveFrom('/work/proj', 'src/a.ts', 'linux')).toBe('/work/proj/src/a.ts');
    expect(resolveFrom('/work/proj', './a.ts', 'linux')).toBe('/work/proj/a.ts');
    expect(resolveFrom('/work/proj', '/etc/x', 'linux')).toBe('/etc/x');
    expect(resolveFrom('C:\\proj', 'src\\a.ts', 'win32')).toBe('C:\\proj\\src\\a.ts');
    expect(resolveFrom('C:\\proj', 'D:\\x.ts', 'win32')).toBe('D:\\x.ts');
  });
});
