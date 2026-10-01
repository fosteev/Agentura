/**
 * Сравнение путей файлов без vscode: движок присылает путь как есть (`C:\a\b.ts`, `c:/a/../a/b.ts`),
 * а `TextDocument.uri.fsPath` — в форме VS Code (буква диска строчная, обратные слеши). Ключ
 * нормализует разделители и `..`, а на Windows ещё и регистр (файловая система её не различает).
 */
import { posix, win32 } from 'node:path';

export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32')
    return win32
      .normalize(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return posix.normalize(p).replace(/(.)\/+$/, '$1');
}

export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** Абсолютный путь файла из входа инструмента: относительный отсчитывается от `cwd` сессии, а не процесса. */
export function resolveFrom(
  cwd: string,
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const lib = platform === 'win32' ? win32 : posix;
  return lib.isAbsolute(p) ? p : lib.resolve(cwd, p);
}
