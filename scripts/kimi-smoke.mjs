#!/usr/bin/env node
// Opt-in live smoke Kimi Code ACP; не входит в npm run check и тратит один короткий ход.
//   node scripts/kimi-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const { KimiAdapter } = await loadTs('src/agent/kimi/adapter.ts');
const { resolveKimiExecutable } = await loadTs('src/agent/kimi/executable.ts');

const resolved = await resolveKimiExecutable('');
if (!resolved.path) {
  console.error(`kimi не найден: ${resolved.problem ?? ''}`);
  process.exit(1);
}
console.log(`kimi ${resolved.version} (${resolved.path})`);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-kimi-smoke-')));
const children = [];
const adapter = new KimiAdapter({
  executablePath: resolved.path,
  engineVersion: resolved.version,
  clientVersion: 'smoke',
  spawn: (path, args, options) => {
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
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
});

let exitCode = 0;
let session;
try {
  session = await adapter.createSession({ cwd });
  const events = [];
  session.events.on((event) => {
    events.push(event);
    if (event.type !== 'text.delta' && event.type !== 'thinking.delta') console.log(event.type);
  });
  const waitEvent = (predicate, timeoutMs, label) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      session.events.on((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        resolve(event);
      });
    });
  };

  const init = await waitEvent(
    (event) => event.type === 'session.init' || event.type === 'session.closed' || event.type === 'error',
    30_000,
    'таймаут handshake',
  );
  if (init.type !== 'session.init') throw new Error(`handshake: ${JSON.stringify(init)}`);
  console.log(`session ${init.sessionId}`);

  session.send('Reply with exactly one word: pong. Do not use tools.');
  const result = await waitEvent(
    (event) => event.type === 'turn.result' || event.type === 'session.closed',
    120_000,
    'таймаут хода',
  );
  if (result.type !== 'turn.result' || !result.ok) throw new Error(`turn: ${JSON.stringify(result)}`);
  if (result.usageKnown !== false) throw new Error('Kimi per-turn usage must remain unknown');
  const text = events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('');
  if (!/pong/i.test(text)) throw new Error(`unexpected response: ${text}`);
  await waitEvent((event) => event.type === 'context.usage', 30_000, 'таймаут usage_update');
  const context = await session.contextUsage();
  if (!context || context.usedTokens <= 0 || !context.maxTokens) {
    throw new Error(`usage_update/context.usage missing: ${JSON.stringify(context)}`);
  }
  console.log(`turn ok; context ${context.usedTokens}/${context.maxTokens}`);
} catch (error) {
  console.error(error?.stack ?? error);
  exitCode = 1;
} finally {
  session?.dispose();
  const deadline = Date.now() + 10_000;
  for (const child of children) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (child.exitCode === null && child.signalCode === null) {
      console.error('kimi acp did not close gracefully; killing');
      child.kill('SIGKILL');
      exitCode = 1;
    }
  }
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(exitCode);
