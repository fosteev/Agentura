#!/usr/bin/env node
// Дымовой прогон AntigravityAdapter на живом `agy` (opt-in; ход тратит недельную квоту Gemini).
//   node scripts/agy-smoke.mjs                         — найти agy, `agy models`, без хода
//   node scripts/agy-smoke.mjs --turn                  — ход «ответь одним словом pong» + resume и второй короткий ход
//   node scripts/agy-smoke.mjs --turn --record test/fixtures/antigravity/ok-turn.json   — записать фикстуру
// Модель строго gemini-3.8-flash-low (самая дешёвая; не менять — квота мала). Работает во временной папке вне репо.
// Процессы agy за собой не оставляет (проверка — pgrep в конце). Диалоги остаются в хранилище agy (~/.gemini): их мы не трогаем.
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
const MODEL = 'gemini-3.8-flash-low';

const { AntigravityAdapter } = await loadTs('src/agent/antigravity/adapter.ts');
const { resolveAgyExecutable } = await loadTs('src/agent/antigravity/executable.ts');

const resolved = await resolveAgyExecutable('');
if (!resolved.path) {
  console.error(`agy не найден: ${resolved.problem ?? ''}`);
  process.exit(1);
}
console.log(`agy ${resolved.version} (${resolved.path})`);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-agy-smoke-')));
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const traced = [];
const adapter = new AntigravityAdapter({
  executablePath: resolved.path,
  engineVersion: resolved.version,
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
  trace: (event) => traced.push(event),
});

/** Ждать `turn.result` (или закрытия сессии) после `send`. */
function nextResult(session, events) {
  const from = events.length;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('таймаут хода')), 120_000);
    const check = (e) => {
      if (e.type === 'turn.result' || e.type === 'session.closed') {
        clearTimeout(timer);
        resolve(e);
      }
    };
    for (const e of events.slice(from)) check(e);
    session.events.on(check);
  });
}

let exitCode = 0;
let session;
try {
  session = await adapter.createSession({ cwd, model: MODEL });
  const events = [];
  session.events.on((e) => {
    events.push(e);
    if (e.type !== 'text.delta') console.log(`${t()} ${e.type}`);
  });
  const caps = await session.capabilities();
  console.log(`${t()} agy models: ${caps.models.map((m) => m.value).join(', ')}`);
  if (!caps.models.some((m) => m.value === MODEL)) exitCode = 1;

  if (flag('--turn')) {
    session.send('Reply with just the word pong');
    const first = await nextResult(session, events);
    console.log(`${t()} ${JSON.stringify(first)}`);
    const text = events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
    console.log(`${t()} текст: «${text}»`);
    if (first.type !== 'turn.result' || !first.ok) exitCode = 1;

    // resume: новый процесс с --conversation, помнит прошлый ход; init с тем же id
    const id = session.id;
    session.dispose();
    await new Promise((r) => setTimeout(r, 1500));
    const again = await adapter.resumeSession(id, { cwd, model: MODEL });
    const events2 = [];
    again.events.on((e) => events2.push(e));
    again.send('Reply with just the word ok');
    const second = await nextResult(again, events2);
    const init = events2.find((e) => e.type === 'session.init');
    console.log(`${t()} resume: init ${init ? init.sessionId === id : 'нет'}, ход ${second.type === 'turn.result' && second.ok}`);
    if (!init || init.sessionId !== id || second.type !== 'turn.result' || !second.ok) exitCode = 1;
    again.dispose();
  }

  if (record) {
    const sanitize = (text) => {
      const user = userInfo().username;
      const swaps = [
        [cwd, '/tmp/agentura-agy'],
        [cwd.replace(/^\/private/, ''), '/tmp/agentura-agy'],
        [homedir(), '/home/user'],
        [hostname(), 'host'],
        [hostname().replace(/\.local$/, ''), 'host'],
        [user, 'user'],
      ].filter(([from]) => from && from.length > 2);
      for (const [from, to] of swaps) text = text.split(from).join(to);
      const ids = [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])];
      ids.forEach((id, i) => (text = text.split(id).join(`00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`)));
      return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com');
    };
    const fixture = {
      agyVersion: resolved.version,
      note: 'Записано scripts/agy-smoke.mjs на живом agy (два хода: исходный и resume, события обоих процессов подряд); пути и id заменены.',
      models: caps.models,
      events: traced,
    };
    writeFileSync(record, `${sanitize(JSON.stringify(fixture, null, 1))}\n`);
    console.log(`${t()} фикстура записана: ${record} (${traced.length} событий agy)`);
  }
} catch (error) {
  console.error(`smoke упал: ${error?.stack ?? error}`);
  exitCode = 1;
} finally {
  session?.dispose();
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(cwd, { recursive: true, force: true });
  try {
    const left = execFileSync('pgrep', ['-fl', cwd], { encoding: 'utf8' }).trim();
    if (left) {
      console.error(`остались процессы:\n${left}`);
      exitCode = 1;
    }
  } catch {
    // pgrep ничего не нашёл — чисто
  }
  console.log(`${t()} готово, код ${exitCode}`);
  process.exit(exitCode);
}
