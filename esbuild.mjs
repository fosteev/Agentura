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
  // SDK — ESM с нативным бинарником CLI, ищет его через import.meta.url: не бандлить (этап 2).
  external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
  // фикстуры состояний для agentura.debug.showState (этап 7) — текстом в бандл
  loader: { '.jsonl': 'text' },
};

const webview = {
  ...common,
  entryPoints: { chat: 'src/webview/chat/index.tsx', sidebar: 'src/webview/sidebar/index.tsx',
    settings: 'src/webview/settings/index.tsx',
    agents: 'src/webview/agentsGraph/index.tsx',
  },
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
