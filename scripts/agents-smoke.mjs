#!/usr/bin/env node
// Несколько агентов (A6, этап 2 roadmap 0.2) на живом движке, ≈ $0.02–0.10 на Haiku:
//   node scripts/agents-smoke.mjs                       — прогон и проверки
//   node scripts/agents-smoke.mjs --record agents-parallel   — ещё и записать фикстуру test/fixtures/claude/<имя>.*
//   node scripts/agents-smoke.mjs --stop                — остановить первого foreground-агента (stopTask) после его 1-го вызова
//   --model <id> (по умолчанию claude-haiku-4-5), --keep — не удалять временную папку и каталог транскриптов
//
// Ход: фоновый Bash (`sleep`), два Explore на переднем плане параллельно и один фоновый general-purpose.
// Рабочая папка — временная (три крошечных файла и `.claude/settings.local.json` с разрешением `sleep`),
// настройки пользователя не грузятся (`settingSources: project, local`) — запросов разрешений нет.
// Фикстура: `.sdk.ndjson` — сырые сообщения SDK + строки `probe/send` (формат логов пробы, проигрывается
// `replayProbeLog`), `.messages.json` — `getSessionMessages()`, `.transcript.ndjson` и `.subagents/` — файлы
// транскрипта. Пути временной папки и домашней папки в фикстуре заменены, списки скиллов/команд очищены.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs, repoRoot } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const model = value('--model', 'claude-haiku-4-5');
const record = value('--record', undefined);
const stopFirst = flag('--stop');

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-agents-')));
for (const [dir, text] of [
  ['alpha', 'alpha: табло очереди\nсброс состояния в onOpen\n'],
  ['beta', 'beta: киоск\nreset() из onReconnect\nкэш талонов\n'],
  ['gamma', 'gamma: пульт\nсостояние из снимка\nбез сброса\nконец\n'],
]) {
  mkdirSync(join(cwd, dir));
  writeFileSync(join(cwd, dir, 'notes.md'), text);
}
mkdirSync(join(cwd, '.claude'));
writeFileSync(
  join(cwd, '.claude', 'settings.local.json'),
  JSON.stringify({ permissions: { allow: ['Bash(sleep:*)'] } }),
);

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { projectDir, projectDirName } = await loadTs('src/data/sessions.ts');

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const short = (s, n = 90) => String(s).replace(/\n/g, '⏎').slice(0, n);

/** Сырые сообщения SDK и строки пробы — будущая фикстура. */
const raw = [];
const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/0',
  settingSources: ['project', 'local'],
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
  trace: (m) => raw.push({ at: Date.now() - started, m }),
});

const session = await adapter.createSession({ cwd, model, title: 'agentura agents smoke' });
// uuid отправленного сообщения — для строки `probe/send` (маппер привязывает промпт к ходу по эху uuid)
const input = session.input;
const push = input.push.bind(input);
input.push = (m) => {
  raw.push({
    at: Date.now() - started,
    m: {
      type: 'probe',
      kind: 'send',
      t: Date.now() - started,
      text: m.message.content,
      uuid: m.uuid,
    },
  });
  push(m);
};

const events = [];
const waiters = [];
const agents = new Map(); // agentId → сводка
let stopped = false;
session.events.on((e) => {
  events.push({ at: Date.now() - started, e });
  const a = e.agentId ? `[${e.agentId.slice(-6)}] ` : '';
  switch (e.type) {
    case 'text.delta':
    case 'thinking.delta':
    case 'usage.message':
    case 'context.usage':
      break;
    case 'agent.start':
      agents.set(e.agentId, {
        taskId: e.taskId,
        type: e.taskType,
        sub: e.subagentType,
        bg: e.background,
        tools: [],
        progress: 0,
        startedAt: Date.now() - started,
      });
      console.log(
        `${t()} ${a}agent.start ${e.taskType}/${e.subagentType ?? '-'} bg=${e.background} «${short(e.description, 60)}» prompt=${e.prompt ? e.prompt.length : 0}`,
      );
      break;
    case 'agent.progress': {
      const x = agents.get(e.agentId);
      if (x) x.progress++;
      console.log(
        `${t()} ${a}agent.progress last=${e.lastToolName ?? '-'} tokens=${e.totalTokens ?? '-'} uses=${e.toolUses ?? '-'} dur=${e.durationMs ?? '-'} status=${e.status ?? '-'}`,
      );
      break;
    }
    case 'agent.end': {
      const x = agents.get(e.agentId);
      if (x) x.endedAt = Date.now() - started;
      if (x) x.status = e.status;
      console.log(
        `${t()} ${a}agent.end ${e.status} tokens=${e.totalTokens ?? '-'} uses=${e.toolUses ?? '-'} dur=${e.durationMs ?? '-'} «${short(e.summary ?? '', 60)}»`,
      );
      break;
    }
    case 'tool.start': {
      const x = e.agentId ? agents.get(e.agentId) : undefined;
      if (x) x.tools.push(Date.now() - started);
      console.log(`${t()} ${a}tool.start ${e.name} ${short(JSON.stringify(e.input), 70)}`);
      if (stopFirst && !stopped && x && !x.bg) {
        stopped = true;
        console.log(`${t()} → stopTask(${x.taskId}) foreground-агента`);
        session.stopTask(x.taskId).then(
          () => console.log(`${t()} ← stopTask ok`),
          (err) => console.log(`${t()} ← stopTask ошибка: ${err.message}`),
        );
      }
      break;
    }
    case 'tool.result':
      console.log(`${t()} ${a}tool.result err=${e.isError} «${short(e.content, 70)}»`);
      break;
    case 'turn.start':
      console.log(`${t()} turn.start «${short(e.prompt ?? '(пробуждение)', 60)}»`);
      break;
    case 'turn.result':
      console.log(
        `${t()} turn.result ok=${e.ok} origin=${e.origin ?? '-'} cost=$${e.costUsd?.toFixed(4) ?? '?'} total=$${e.totalCostUsd.toFixed(4)} «${short(e.text ?? '', 80)}»`,
      );
      break;
    default:
      console.log(`${t()} ${a}${e.type}`);
  }
  for (const w of [...waiters]) {
    if (!w.pred(e)) continue;
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(e);
  }
});
const waitFor = (pred, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });

const prompt = [
  'Сделай в одном ответе, вызовами инструментов параллельно (все в одном сообщении):',
  '1) Bash с run_in_background: true — команда `sleep 20`;',
  '2) два агента Explore (инструмент Agent, subagent_type: "Explore", run_in_background: false): первый читает',
  'alpha/notes.md и возвращает его вторую строку, второй — то же для beta/notes.md;',
  '3) агент general-purpose (инструмент Agent, run_in_background: true): прочитать gamma/notes.md и вернуть число строк.',
  'Дождись обоих Explore и ответь одной строкой с их итогами. Фоновые задачи не жди.',
].join('\n');

let exitCode = 0;
const fail = (msg) => {
  console.log(`!! ${msg}`);
  exitCode = 1;
};
try {
  console.log(`${t()} → send (model ${model}, cwd ${cwd})`);
  session.send(prompt);
  const first = await waitFor((e) => e.type === 'turn.result', 240_000);
  if (!first) fail('ход не закончился за 240 с');
  // фоновые: ждём их конца и хода-пробуждения (≤ 90 с)
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const live = [...agents.values()].filter((x) => x.endedAt === undefined);
    if (live.length === 0) break;
    await waitFor((e) => e.type === 'agent.end', deadline - Date.now());
  }
  // ход-пробуждение после последнего уведомления — ещё до 60 с
  const lastEnd = events.findLastIndex((x) => x.e.type === 'agent.end');
  const lastResult = events.findLastIndex((x) => x.e.type === 'turn.result');
  if (lastEnd > lastResult) await waitFor((e) => e.type === 'turn.result', 60_000);
} catch (error) {
  fail(`ошибка: ${error.message}`);
} finally {
  session.dispose();
}

// ——— выводы разведки ———
console.log('\n— агенты —');
for (const [id, x] of agents) {
  const during = x.tools.filter((at) => x.endedAt === undefined || at <= x.endedAt).length;
  console.log(
    `${id.slice(-8)} ${x.type}/${x.sub ?? '-'} bg=${x.bg} status=${x.status ?? 'не закончился'} tool.start=${x.tools.length} (до конца агента ${during}) task_progress=${x.progress} ${x.startedAt}→${x.endedAt ?? '…'} мс`,
  );
}
const rawTypes = {};
for (const { m } of raw) {
  const k = m.type === 'system' ? `system/${m.subtype}` : m.type;
  const key = m.parent_tool_use_id ? `${k} (parent_tool_use_id)` : k;
  rawTypes[key] = (rawTypes[key] ?? 0) + 1;
}
console.log('— сырые сообщения —', JSON.stringify(rawTypes));
const progress = raw.find(({ m }) => m.type === 'system' && m.subtype === 'task_progress');
if (progress) console.log('— task_progress (пример) —', short(JSON.stringify(progress.m), 400));
const note = raw.find(({ m }) => m.type === 'system' && m.subtype === 'task_notification');
if (note) console.log('— task_notification (пример) —', short(JSON.stringify(note.m), 400));

const subs = [...agents.values()].filter((x) => x.type === 'local_agent');
const fg = subs.filter((x) => !x.bg);
if (subs.length < 2) fail(`агентов меньше двух (${subs.length})`);
if (fg.length === 0)
  console.log('?? ни одного агента переднего плана — движок запустил всех фоном');
for (const x of subs) {
  if (x.endedAt === undefined) fail(`агент ${x.taskId} не закончился`);
  if (x.tools.length === 0 && x.status !== 'stopped')
    fail(`у агента ${x.taskId} нет ни одного tool.start с agentId`);
}

// ——— фикстура ———
const sessionId = session.id;
const dir = projectDir(cwd);
if (record && sessionId) {
  const home = homedir();
  // каталог транскриптов и задач CLI назван по пути папки: `-private-var-folders-…-agentura-agents-XXXX`
  const encoded = projectDirName(cwd);
  const clean = (text) =>
    text
      .split(cwd)
      .join('/tmp/agentura-agents')
      .split(cwd.replace(/^\/private/, ''))
      .join('/tmp/agentura-agents')
      .split(encoded)
      .join('-tmp-agentura-agents')
      .split(home)
      .join('/home/user')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com');
  // транскрипт: вложения движка (окружение, организация, список скиллов, контекст сессии) — не нужны
  // разбору и личные; остальное как есть
  const cleanJsonl = (text) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const r = JSON.parse(l);
          return r.type === 'attachment' ? undefined : clean(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .join('\n') + '\n';
  const scrub = (m) => {
    if (m.type === 'system' && m.subtype === 'init') {
      // MCP-инструменты и команды выдают подключённые коннекторы пользователя — в фикстуру не кладём.
      const tools = (m.tools ?? []).filter((t) => !String(t).startsWith('mcp__'));
      return { ...m, tools, slash_commands: [], skills: [], plugins: [], mcp_servers: [] };
    }
    if (m.type === 'system' && m.subtype === 'commands_changed') return { ...m, commands: [] };
    return m;
  };
  const out = join(repoRoot, 'test', 'fixtures', 'claude');
  writeFileSync(
    join(out, `${record}.sdk.ndjson`),
    raw.map(({ m }) => clean(JSON.stringify(scrub(m)))).join('\n') + '\n',
  );
  const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  writeFileSync(
    join(out, `${record}.messages.json`),
    clean(JSON.stringify(messages, null, 1)) + '\n',
  );
  const transcript = join(dir, `${sessionId}.jsonl`);
  if (existsSync(transcript)) {
    writeFileSync(
      join(out, `${record}.transcript.ndjson`),
      cleanJsonl(readFileSync(transcript, 'utf8')),
    );
  }
  const subDir = join(dir, sessionId, 'subagents');
  if (existsSync(subDir)) {
    const target = join(out, `${record}.subagents`);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target);
    for (const f of readdirSync(subDir)) {
      const p = join(subDir, f);
      if (f.endsWith('.jsonl')) writeFileSync(join(target, f), cleanJsonl(readFileSync(p, 'utf8')));
      else if (f.endsWith('.json')) writeFileSync(join(target, f), clean(readFileSync(p, 'utf8')));
      else cpSync(p, join(target, f), { recursive: true });
    }
  }
  console.log(`фикстура: test/fixtures/claude/${record}.* (сессия ${sessionId})`);
}

if (!flag('--keep')) {
  // процесс CLI после dispose() ещё дописывает транскрипт (последняя запись хода) и пересоздал бы
  // удалённый каталог — ждём его выхода
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(cwd, { recursive: true, force: true });
  // только каталог транскриптов этой временной папки (имя по её пути), реальные сессии не трогаем
  if (dir.includes('agentura-agents-')) rmSync(dir, { recursive: true, force: true });
  // и каталог задач CLI (`/tmp/claude-<uid>/<имя по пути папки>/<сессия>/tasks/*.output`)
  const tasks = join('/tmp', `claude-${process.getuid?.() ?? ''}`, projectDirName(cwd));
  if (tasks.includes('agentura-agents-')) rmSync(tasks, { recursive: true, force: true });
}
console.log(exitCode === 0 ? '\nOK' : '\nПРОВАЛ');
process.exit(exitCode);
