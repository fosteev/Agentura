#!/usr/bin/env node
// Дымовой прогон этапа 6 на живом движке (тратит лимит подписки, ~$0.05–0.15):
//   node scripts/sessions-smoke.mjs [--cwd <пустая временная папка>] [--model claude-haiku-4-5]
// Проверяет: listSessions → loadHistory → resumeSession (init до первого сообщения, режим, контекст),
// продолжение диалога в той же сессии (id не меняется, стоимость хода от базы), renameSession,
// сверку итогов списка с транскриптом.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cwd = value('--cwd', mkdtempSync(join(tmpdir(), 'agentura-sessions-')));
const model = value('--model', 'claude-haiku-4-5');

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { listSessionRows, LiveSessions, TranscriptCache } = await loadTs('src/data/sessions.ts');
const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/0',
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
});
const short = (s, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, '⏎');
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;

function watch(session, label) {
  const log = [];
  const waiters = [];
  session.events.on((e) => {
    log.push(e);
    if (e.type === 'text.delta' || e.type === 'thinking.delta' || e.type === 'usage.message')
      return;
    const extra =
      e.type === 'session.init'
        ? `${e.sessionId} model=${e.model} mode=${e.permissionMode}`
        : e.type === 'turn.result'
          ? `cost=${e.costUsd?.toFixed(4) ?? '—'} total=${e.totalCostUsd.toFixed(4)} «${short(e.text ?? '')}»`
          : e.type === 'context.usage'
            ? `${e.source} ${e.usedTokens}/${e.maxTokens ?? '?'}`
            : '';
    console.log(`${t()} [${label}] ${e.type} ${extra}`);
    for (const w of [...waiters]) {
      if (!w.pred(e)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(e);
    }
  });
  return {
    log,
    waitFor: (pred, ms = 120_000) =>
      new Promise((resolve, reject) => {
        const hit = log.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error('таймаут')), ms);
        waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) });
      }),
  };
}

let exit = 0;
try {
  console.log(`cwd ${cwd}, модель ${model}`);
  // 1. новая сессия в режиме plan: один короткий ход
  const a = await adapter.createSession({ cwd, model, permissionMode: 'plan' });
  const wa = watch(a, 'new');
  a.send('Запомни слово «ананас». Ответь одним словом: ок.');
  await wa.waitFor((e) => e.type === 'turn.result');
  const id = wa.log.find((e) => e.type === 'session.init').sessionId;
  a.dispose();
  await new Promise((r) => setTimeout(r, 500));

  // 2. список и история
  const rows = await listSessionRows(adapter, {
    cwd,
    live: new LiveSessions(),
    cache: new TranscriptCache(),
  });
  console.log(
    `${t()} список: ${rows.map((r) => `${r.id.slice(0, 8)} «${short(r.title, 40)}» ходов=${r.turns} $${r.costUsd?.toFixed(4)}`).join('; ')}`,
  );
  const history = await adapter.loadHistory(id, cwd);
  console.log(
    `${t()} история: ${history.events.length} событий, ходов ${history.turns}, режим ${history.mode}`,
  );
  for (const e of history.events)
    if (e.type !== 'usage.message')
      console.log(
        `     ${e.type} ${short(JSON.stringify(e.type === 'turn.start' ? e.prompt : e.type === 'text.delta' ? e.text : e.type === 'turn.result' ? { cost: e.costUsd, usage: e.usage } : ''))}`,
      );

  // 3. resume: init без сообщения, режим, контекст
  const base = history.totalCostUsd ?? rows.find((r) => r.id === id)?.costUsd;
  console.log(
    `${t()} база стоимости (cost-state транскрипта): $${base?.toFixed(4)}; модель конца сессии: ${history.model}`,
  );
  const b = await adapter.resumeSession(id, {
    cwd,
    model: history.model ?? model,
    permissionMode: history.mode ?? 'default',
    ...(base !== undefined ? { baselineCostUsd: base } : {}),
  });
  const wb = watch(b, 'resume');
  await wb
    .waitFor((e) => e.type === 'session.init', 30_000)
    .catch(() => console.log(`${t()} !! init до первого сообщения не пришёл за 30 с`));
  await new Promise((r) => setTimeout(r, 3000));
  // 4. продолжение в той же сессии
  b.send('Какое слово я просил запомнить? Одним словом.');
  const r2 = await wb.waitFor((e) => e.type === 'turn.result');
  const init2 = wb.log.find((e) => e.type === 'session.init');
  const id2 = init2?.sessionId;
  console.log(
    `${t()} режим после resume (init.permissionMode): ${init2?.permissionMode}, ожидали ${history.mode}`,
  );
  console.log(
    `${t()} id после resume: ${id2 === id ? 'тот же' : `ДРУГОЙ ${id2}`}; ответ «${short(r2.text ?? '')}»; стоимость хода $${r2.costUsd?.toFixed(4)} (итог движка $${r2.totalCostUsd.toFixed(4)}, оценка до хода $${base?.toFixed(4)})`,
  );
  b.dispose();
  await new Promise((r) => setTimeout(r, 500));

  // 5. rename и итоги
  await adapter.renameSession(id, 'smoke: переименовано', cwd);
  const after = (
    await listSessionRows(adapter, { cwd, live: new LiveSessions(), cache: new TranscriptCache() })
  ).find((r) => r.id === id);
  console.log(
    `${t()} после rename: «${after?.title}», ходов ${after?.turns}, $${after?.costUsd?.toFixed(4)}`,
  );
  console.log(
    `итог: оценка транскрипта $${after?.costUsd?.toFixed(4)} против total_cost_usd движка $${r2.totalCostUsd.toFixed(4)}`,
  );
} catch (error) {
  console.error(`ошибка: ${error.stack ?? error}`);
  exit = 1;
}
process.exit(exit);
