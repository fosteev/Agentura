import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

const extension = {
  ...common,
  entryPoints: { extension: 'src/extension/extension.ts' },
  outdir: 'dist',
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: { chat: 'src/webview/chat/index.tsx', sidebar: 'src/webview/sidebar/index.tsx' },
  outdir: 'dist/webview',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
