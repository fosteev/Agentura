#!/usr/bin/env node
// Дымовой прогон CursorAdapter на живом `agent acp` (opt-in, не часть `npm run check`).
//   node scripts/cursor-smoke.mjs
// Один ход «ответь одним словом pong» во временной папке. Процесс не получает --force / --yolo.
// Каталоги ~/.cursor, ~/.claude, ~/.codex, ~/.gemini не читает и не пишет.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const { CursorAdapter } = await loadTs('src/agent/cursor/adapter.ts');
const { resolveCursorExecutable } = await loadTs('src/agent/cursor/executable.ts');

const resolved = await resolveCursorExecutable('');
if (!resolved.path) {
  console.error(`agent не найден: ${resolved.problem ?? ''}`);
  process.exit(1);
}
console.log(`agent ${resolved.version} (${resolved.path})`);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-cursor-smoke-')));
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const children = [];
const adapter = new CursorAdapter({
  spawn: (path, args, options) => {
    const blocked = args.find((item) => item === '--force' || item === '--yolo');
    if (blocked) throw new Error(`smoke refuses ${blocked}`);
    const child = spawn(path, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    children.push(child);
    return child;
  },
  executablePath: resolved.path,
  engineVersion: resolved.version,
  clientVersion: 'smoke',
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
});

let exitCode = 0;
let session;
try {
  session = await adapter.createSession({ cwd });
  const events = [];
  session.events.on((e) => {
    events.push(e);
    if (e.type !== 'text.delta') console.log(`${t()} ${e.type}`);
  });
  const waitEvent = (pred, ms, label) => {
    const already = events.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      session.events.on((e) => {
        if (!pred(e)) return;
        clearTimeout(timer);
        resolve(e);
      });
    });
  };
  const init = await waitEvent(
    (e) => e.type === 'session.init' || e.type === 'session.closed' || e.type === 'error',
    30_000,
    'таймаут handshake',
  );
  if (init.type !== 'session.init') throw new Error(`handshake: ${JSON.stringify(init)}`);
  console.log(`${t()} session ${init.sessionId} model ${init.model}`);
  session.send('Reply with exactly one word: pong. Do not use tools.');
  const result = await waitEvent(
    (e) => e.type === 'turn.result' || e.type === 'session.closed',
    120_000,
    'таймаут хода',
  );
  const text = events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
  console.log(`${t()} ${JSON.stringify(result)}`);
  console.log(`${t()} текст: «${text}»`);
  if (result.type !== 'turn.result' || !result.ok) exitCode = 1;
  if (!/pong/i.test(text)) exitCode = 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  session?.dispose();
  await new Promise((r) => setTimeout(r, 500));
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(exitCode);
