#!/usr/bin/env node
// Дымовой прогон CodexAdapter на живом `codex app-server` (opt-in; ход тратит лимит подписки Codex).
//   node scripts/codex-smoke.mjs                      — handshake + model/list, без хода
//   node scripts/codex-smoke.mjs --turn               — ещё один короткий ход «ответь одним словом OK» + resume
//   node scripts/codex-smoke.mjs --turn --record test/fixtures/codex/ok-turn.json   — записать фикстуру
//   --model <id> (по умолчанию самая дешёвая из model/list: «affordable»/«fast»), --effort <low|…>
// Работает во временной папке; approvalPolicy `on-request`, sandbox `read-only` — не ослабляем.
// Процессы app-server за собой не оставляет (проверка — pgrep в конце).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const record = value('--record');

const { CodexAdapter } = await loadTs('src/agent/codex/adapter.ts');
const { resolveCodexExecutable } = await loadTs('src/agent/codex/executable.ts');

const resolved = await resolveCodexExecutable('');
if (!resolved.path) {
  console.error(`codex не найден: ${resolved.problem ?? ''}`);
  process.exit(1);
}
console.log(`codex ${resolved.version} (${resolved.path})`);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-codex-smoke-')));
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const traced = [];
const adapter = new CodexAdapter({
  executablePath: resolved.path,
  clientVersion: 'smoke',
  thread: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
  trace: (kind, method, payload) => traced.push({ kind, method, payload }),
});

let exitCode = 0;
let session;
try {
  session = await adapter.createSession({ cwd, ...(value('--model') ? { model: value('--model') } : {}) });
  const events = [];
  session.events.on((e) => {
    events.push(e);
    if (e.type !== 'text.delta' && e.type !== 'thinking.delta') console.log(`${t()} ${e.type}`);
  });
  const caps = await session.capabilities();
  console.log(`${t()} model/list: ${caps.models.map((m) => m.value).join(', ')}`);
  const cheapest =
    value('--model') ??
    (caps.models.find((m) => /affordable|cheap/i.test(m.description ?? '')) ??
      caps.models.find((m) => /fast/i.test(m.description ?? '')) ??
      caps.models.at(-1))?.value;
  console.log(`${t()} дешёвая модель: ${cheapest}`);

  if (flag('--turn')) {
    if (cheapest) await session.setModel(cheapest);
    if (value('--effort')) await session.setEffort(value('--effort'));
    session.send('ответь одним словом OK');
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('таймаут хода')), 120_000);
      session.events.on((e) => {
        if (e.type === 'turn.result' || e.type === 'session.closed') {
          clearTimeout(timer);
          resolve(e);
        }
      });
    });
    console.log(`${t()} ${JSON.stringify(result)}`);
    const text = events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
    console.log(`${t()} текст: «${text}»`);
    if (result.type !== 'turn.result' || !result.ok) exitCode = 1;

    // resume того же треда: без хода, проверяет thread/resume и session.init
    const id = session.id;
    session.dispose();
    // app-server снимает блокировку треда при выходе: resume сразу после dispose ловит «already has an active writer»
    await new Promise((r) => setTimeout(r, 3000));
    const again = await adapter.resumeSession(id, { cwd });
    const init = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('таймаут resume')), 30_000);
      again.events.on((e) => {
        if (e.type === 'session.init' || e.type === 'session.closed') {
          clearTimeout(timer);
          resolve(e);
        }
      });
    });
    console.log(`${t()} resume: ${init.type} ${init.type === 'session.init' ? init.sessionId === id : JSON.stringify(init)}`);
    if (init.type !== 'session.init') exitCode = 1;
    again.dispose();
  }

  if (record) {
    const KEEP = new Set([
      'thread/started', 'thread/status/changed', 'turn/started', 'turn/completed', 'item/started',
      'item/completed', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta', 'thread/tokenUsage/updated', 'error',
    ]);
    const first = (kind, method) => traced.find((x) => x.kind === kind && x.method === method)?.payload;
    const threadStart = first('response', 'thread/start');
    const fixture = {
      cliVersion: resolved.version,
      note: 'Записано scripts/codex-smoke.mjs на живом codex app-server; пути, имя, хост и почта заменены.',
      threadStart,
      modelList: first('response', 'model/list'),
      notifications: traced
        .filter((x) => x.kind === 'notification' && KEEP.has(x.method))
        .map((x) => ({ method: x.method, params: x.payload })),
    };
    let text = JSON.stringify(fixture, null, 2);
    const user = userInfo().username;
    const swaps = [
      [cwd, '/tmp/agentura-codex'],
      [cwd.replace(/^\/private/, ''), '/tmp/agentura-codex'],
      [homedir(), '/home/user'],
      [hostname(), 'host'],
      [hostname().replace(/\.local$/, ''), 'host'],
      [user, 'user'],
    ].filter(([from]) => from && from.length > 2);
    for (const [from, to] of swaps) text = text.split(from).join(to);
    text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com');
    writeFileSync(record, `${text}\n`);
    console.log(`${t()} фикстура записана: ${record} (${traced.length} сообщений, оставлено ${fixture.notifications.length} notifications)`);
  }
} catch (error) {
  console.error(`smoke упал: ${error?.stack ?? error}`);
  exitCode = 1;
} finally {
  session?.dispose();
  await new Promise((r) => setTimeout(r, 2500));
  rmSync(cwd, { recursive: true, force: true });
  try {
    const left = execFileSync('pgrep', ['-fl', 'app-server --listen stdio://'], { encoding: 'utf8' }).trim();
    console.log(`ОСТАЛИСЬ процессы app-server:\n${left}`);
    exitCode = 1;
  } catch {
    console.log('процессов app-server не осталось');
  }
}
process.exit(exitCode);
