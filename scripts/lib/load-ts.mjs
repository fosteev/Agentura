// Загрузка TypeScript-модуля из src/ в node-скрипт: esbuild собирает его в dist/scripts/*.mjs
// (зависимости из node_modules не бандлятся — остаются import'ами) и отдаёт import().
import * as esbuild from 'esbuild';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadTs(entry) {
  const outfile = join(root, 'dist', 'scripts', `${basename(entry).replace(/\.ts$/, '')}.mjs`);
  await esbuild.build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'error',
    sourcemap: 'inline',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

export const repoRoot = root;
