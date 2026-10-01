// Проверка собранного .vsix (этап 8): распаковать, загрузить dist/extension.js с заглушкой vscode,
// резолвить SDK из распакованного пакета и убедиться, что бинарника движка в нём нет.
// С --live — один ход Haiku через SDK из пакета и системный claude (≈ $0.01).
// Запуск: node scripts/vsix-verify.mjs [agentura-0.1.0.vsix] [--live]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const vsix = resolve(args.find((a) => a.endsWith('.vsix')) ?? 'agentura-0.1.0.vsix');
const live = args.includes('--live');
const dir = mkdtempSync(join(tmpdir(), 'agentura-vsix-'));
execFileSync('unzip', ['-q', vsix, '-d', dir]);
const ext = join(dir, 'extension');
const ok = (m) => console.log(`ok   ${m}`);
const check = (cond, okMsg, failMsg) => {
  if (cond) ok(okMsg);
  else fail(failMsg);
};
const fail = (m) => {
  console.error(`FAIL ${m}`);
  process.exitCode = 1;
};

// 1. бандл расширения грузится с заглушкой vscode
const req = createRequire(join(ext, 'dist', 'extension.js'));
const Module = req('node:module');
const origLoad = Module._load;
// esbuild копирует свойства vscode через getOwnPropertyNames — перечисляем имена, которые бандл берёт из vscode
const used = [
  ...readFileSync(join(ext, 'dist', 'extension.js'), 'utf8').matchAll(/\bvscode\d*\.(\w+)/g),
].map((m) => m[1]);
const make = () =>
  new Proxy(function () {}, {
    get: (_t, k) => (k === 'prototype' ? {} : k === Symbol.toPrimitive ? () => '' : make()),
    apply: () => make(),
    construct: () => make(),
  });
const stub = Object.fromEntries([...new Set(used)].map((k) => [k, make()]));
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : origLoad.call(this, request, ...rest);
};
try {
  const m = req('./extension.js');
  check(
    typeof m.activate === 'function',
    'dist/extension.js загружается, activate экспортирован',
    'нет activate',
  );
} catch (e) {
  fail(`dist/extension.js не загрузился: ${e.message}`);
}
Module._load = origLoad;

// 2. SDK и его зависимости резолвятся из пакета
for (const p of [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk/package.json',
  'zod',
]) {
  try {
    req.resolve(p);
    ok(`резолвится ${p}`);
  } catch (e) {
    fail(`не резолвится ${p}: ${e.message}`);
  }
}

// 2б. граф модулей SDK загружается целиком (статические импорты транзитивных зависимостей из пакета)
for (const p of ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', 'zod']) {
  try {
    const m = await import(pathToFileURL(req.resolve(p)).href);
    check(Object.keys(m).length > 0, `импортируется ${p}`, `${p}: пустой модуль`);
  } catch (e) {
    fail(`не импортируется ${p}: ${e.message}`);
  }
}

// 3. бинарника движка в пакете нет (универсальный .vsix)
const scoped = join(ext, 'node_modules', '@anthropic-ai');
const platform = readdirSync(scoped).filter((n) => n.startsWith('claude-agent-sdk-'));
check(platform.length === 0, 'платформенных бинарников в пакете нет', `в пакете: ${platform}`);
for (const f of [
  'dist/webview/chat.js',
  'dist/webview/sidebar.js',
  'media/icon.svg',
  'package.json',
]) {
  check(existsSync(join(ext, f)), `есть ${f}`, `нет ${f}`);
}

// 4. (опц.) один ход Haiku: SDK из пакета + системный claude
if (live) {
  const { query } = await import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href);
  const claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  const env = { ...process.env };
  for (const k of Object.keys(env))
    if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') delete env[k];
  let result;
  for await (const m of query({
    prompt: 'Ответь одним словом: ок',
    options: {
      cwd: dir,
      model: 'haiku',
      pathToClaudeCodeExecutable: claude,
      env,
      maxTurns: 1,
      settingSources: [],
    },
  })) {
    if (m.type === 'result') result = m;
  }
  check(
    result?.subtype === 'success',
    `живой ход: «${String(result?.result).slice(0, 40)}», $${result?.total_cost_usd}`,
    `живой ход: ${JSON.stringify(result)?.slice(0, 200)}`,
  );
}
if (process.exitCode) console.log(`распаковано в ${dir} (оставлено для разбора)`);
else rmSync(dir, { recursive: true, force: true });
