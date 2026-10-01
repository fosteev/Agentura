#!/usr/bin/env node
// Живой прогон круга разрешений этапа 5 через ChatController (как во вкладке, только webview — этот
// скрипт). Тратит лимит подписки — ходы короткие. Каждый сценарий — во временной папке со своим
// `git init`, настройки пользователя не грузятся (`settingSources: project + local`): иначе правила
// `permissions.allow` владельца закроют запросы.
//   node scripts/permissions-smoke.mjs edit     — Edit: превью ханков, дифф до/после, «принимать правки», Bash «всегда» → settings.local.json
//   node scripts/permissions-smoke.mjs ask      — AskUserQuestion: ответ вариантом
//   node scripts/permissions-smoke.mjs plan     — plan mode: «доработать» с текстом, затем «выполнять» (default) и правка с карточкой
//   node scripts/permissions-smoke.mjs reject   — plan mode: «отклонить» (deny + interrupt), режим остаётся plan
//   node scripts/permissions-smoke.mjs outside — Edit файла вне рабочей папки: «принимать правки до конца сессии» добавляет папку (addDirectories), вторая правка там без запроса (этап 7)
//   --model <id> (по умолчанию claude-sonnet-5-5), --keep — не удалять временную папку
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith('--')) ?? 'edit';
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const model = value('--model', 'claude-sonnet-5-5');

const dir = mkdtempSync(join(tmpdir(), `agentura-smoke-${scenario}-`));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
writeFileSync(
  join(dir, 'math.js'),
  'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n',
);
writeFileSync(
  join(dir, 'test.js'),
  "const { add } = require('./math');\nif (add(2, 3) !== 5) throw new Error('fail');\nconsole.log('ok');\n",
);
writeFileSync(join(dir, 'README.md'), '# smoke\n\nПроект для проверки.\n');
git('init', '-q');
git('add', '.');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@local', 'commit', '-qm', 'init');

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { ChatController } = await loadTs('src/extension/chatController.ts');
const { readFile } = await import('node:fs/promises');

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const short = (s, n = 110) => String(s).replace(/\n/g, '⏎').slice(0, n);

const posted = [];
const opened = [];
const waiters = [];
/** Запросы (разрешение, вопрос, план) по порядку прихода — очередь, чтобы не потерять параллельные. */
const requests = [];
let wake = () => {};
const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/5',
  settingSources: ['project', 'local'],
  log: (level, m) => level !== 'debug' && console.error(`  [${level}] ${m}`),
});
const controller = new ChatController({
  adapter,
  cwd: dir,
  project: 'smoke',
  post: (m) => {
    posted.push(m);
    log(m);
    if (m.type === 'agent.event' && /\.request$/.test(m.event.type)) {
      requests.push(m.event);
      wake();
    }
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
  },
  setTitle: (title) => title.startsWith('?') && console.log(`${t()}   вкладка: «${title}»`),
  log: {
    debug() {},
    info() {},
    warn: (m) => console.error(`  [warn] ${m}`),
    error: (m) => console.error(`  [error] ${m}`),
  },
  settings: () => ({ allowBypass: false, defaultModel: model }),
  findFiles: async () => [],
  pickFiles: async () => [],
  readSelection: async () => undefined,
  listRecent: async () => [],
  showSessions() {},
  readText: (p) => readFile(p, 'utf8').catch(() => undefined),
  openDiff: async (d) => void opened.push(d),
});

let text = '';
function log(m) {
  if (m.type === 'diff.preview') {
    const p = m.preview;
    console.log(
      `${t()} ⇐ diff.preview +${p.add} −${p.del} ${p.hunks.map((h) => h.header).join(' ')} ${p.note ?? ''}`,
    );
    return;
  }
  if (m.type !== 'agent.event') return;
  const e = m.event;
  if (e.type === 'text.delta') return void (text += e.text);
  if (text) {
    console.log(`${t()}   text «${short(text, 160)}»`);
    text = '';
  }
  const a = e.agentId ? `[sub] ` : '';
  switch (e.type) {
    case 'tool.start':
      return console.log(`${t()} ${a}tool.start ${e.name} ${short(JSON.stringify(e.input), 90)}`);
    case 'tool.result':
      return console.log(`${t()} ${a}tool.result err=${e.isError} «${short(e.content, 90)}»`);
    case 'permission.request':
      return console.log(
        `${t()} ${a}permission.request ${e.toolName} «${short(e.description ?? '')}» always=${JSON.stringify(e.always ?? null)}`,
      );
    case 'question.request':
      return console.log(`${t()} ${a}question.request ${short(JSON.stringify(e.questions), 200)}`);
    case 'plan.request':
      return console.log(`${t()} ${a}plan.request «${short(e.plan, 200)}»`);
    case 'permission.resolved':
      return console.log(`${t()} ${a}permission.resolved ${e.decision} by=${e.by}`);
    case 'mode.changed':
    case 'session.init':
      return console.log(`${t()} ${e.type} ${e.mode ?? e.permissionMode}`);
    case 'turn.result':
      return console.log(
        `${t()} turn.result ok=${e.ok} interrupted=${e.interrupted} cost=$${e.costUsd?.toFixed(4)} total=$${e.totalCostUsd.toFixed(4)}`,
      );
    case 'error':
      return console.log(`${t()} error ${e.code ?? ''} ${short(e.message)}`);
    default:
      return;
  }
}

const waitFor = (pred, ms = 240_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('таймаут ожидания')), ms);
    waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
  });
const agentEvent =
  (type, extra = () => true) =>
  (m) =>
    m.type === 'agent.event' && m.event.type === type && extra(m.event);
const send = (s) => {
  console.log(`${t()} → ${short(s, 160)}`);
  return controller.handle({ type: 'send', sessionId: '', text: s });
};
const act = (m) => {
  console.log(
    `${t()} ⇒ ${m.type} ${m.decision ?? ''} ${m.feedback ?? ''}${m.answers ? JSON.stringify(m.answers) : ''}`,
  );
  return controller.handle({ sessionId: '', ...m });
};
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};
let failures = 0;

/** Ответить на все запросы до конца хода по правилу `policy(event) → действие | undefined`. */
async function runTurn(prompt, policy) {
  let finished = false;
  const done = waitFor(agentEvent('turn.result')).then((m) => ((finished = true), wake(), m));
  const loop = (async () => {
    for (;;) {
      while (requests.length) {
        const e = requests.shift();
        const action = await policy(e);
        if (action) await act({ toolUseId: e.toolUseId, ...action });
      }
      if (finished) return;
      await new Promise((r) => (wake = r));
    }
  })();
  if (prompt) await send(prompt);
  const result = await done;
  await loop;
  return result.event;
}

controller.start();
controller.onReady();
try {
  if (scenario === 'edit') {
    const seen = [];
    await runTurn(
      'Переименуй функцию add в sum в math.js и в test.js (правь файлы инструментом Edit, без sed), затем запусти `node test.js` в Bash. Ответь одним словом.',
      async (e) => {
        seen.push(e.toolName ?? e.type);
        if (e.type !== 'permission.request')
          return { type: 'permission.respond', decision: 'deny' };
        if (e.toolName === 'Edit' || e.toolName === 'Write') {
          const preview =
            posted.find((m) => m.type === 'diff.preview' && m.toolUseId === e.toolUseId) ??
            (await waitFor((m) => m.type === 'diff.preview' && m.toolUseId === e.toolUseId, 5000));
          check(
            preview.preview.hunks.length > 0 && !preview.preview.note,
            `превью ${e.toolName} с номерами строк: ${preview.preview.hunks[0]?.header}`,
          );
          await controller.handle({ type: 'diff.open', sessionId: '', toolUseId: e.toolUseId });
          const d = opened.at(-1);
          check(
            d?.stage === 'proposed' && d.before !== d.after,
            `открыть дифф до применения: ${d?.key}`,
          );
          return { type: 'permission.respond', decision: 'allow-edits' };
        }
        if (e.toolName === 'Bash') return { type: 'permission.respond', decision: 'allow-always' };
        return { type: 'permission.respond', decision: 'allow' };
      },
    );
    console.log(`  запросы: ${seen.join(', ')}`);
    check(
      seen.filter((s) => s === 'Edit').length === 1,
      'после «принимать правки» второй Edit без запроса',
    );
    check(
      posted.some(
        (m) =>
          m.type === 'agent.event' &&
          m.event.type === 'mode.changed' &&
          m.event.mode === 'acceptEdits',
      ),
      'mode.changed acceptEdits после «принимать правки»',
    );
    const edits = posted.filter(
      (m) =>
        m.type === 'agent.event' &&
        m.event.type === 'tool.result' &&
        m.event.result?.structuredPatch,
    );
    for (const m of edits)
      await controller.handle({ type: 'diff.open', sessionId: '', toolUseId: m.event.toolUseId });
    check(
      opened.filter((d) => d.stage === 'applied').length === edits.length && edits.length > 0,
      `diff после применения (${edits.length} правок)`,
    );
    check(
      readFileSync(join(dir, 'math.js'), 'utf8').includes('function sum'),
      'math.js переименован',
    );
    const local = join(dir, '.claude', 'settings.local.json');
    const settings = existsSync(local) ? readFileSync(local, 'utf8') : '';
    console.log(`  settings.local.json: ${short(settings, 200)}`);
    check(
      /Bash\(/.test(settings),
      '«всегда» для Bash записал правило в .claude/settings.local.json',
    );
  } else if (scenario === 'outside') {
    // две правки в файлах вне рабочей папки: без `addDirectories` из подсказок вторая снова спросит
    const outside = mkdtempSync(join(tmpdir(), 'agentura-smoke-outside-'));
    writeFileSync(join(outside, 'a.txt'), 'one\n');
    writeFileSync(join(outside, 'b.txt'), 'one\n');
    const seen = [];
    try {
      await runTurn(
        `Замени слово one на two сначала в файле ${join(outside, 'a.txt')}, затем в ${join(outside, 'b.txt')} — инструментом Edit, по одному вызову на файл. Ответь одним словом.`,
        async (e) => {
          seen.push(e.toolName ?? e.type);
          if (e.type !== 'permission.request')
            return { type: 'permission.respond', decision: 'deny' };
          console.log(
            `  always: ${JSON.stringify(e.always ?? null)} · blockedPath=${e.blockedPath ?? '—'}`,
          );
          return { type: 'permission.respond', decision: 'allow-edits' };
        },
      );
      console.log(`  запросы: ${seen.join(', ')}`);
      check(
        seen.filter((n) => n === 'Edit').length === 1,
        'после «принимать правки» (addDirectories) вторая правка вне папки без запроса',
      );
      check(readFileSync(join(outside, 'a.txt'), 'utf8').includes('two'), 'a.txt изменён');
      check(readFileSync(join(outside, 'b.txt'), 'utf8').includes('two'), 'b.txt изменён');
    } finally {
      if (!args.includes('--keep')) rmSync(outside, { recursive: true, force: true });
    }
  } else if (scenario === 'ask') {
    let q;
    const r = await runTurn(
      'Прежде чем что-то делать, спроси меня инструментом AskUserQuestion, какой цвет выбрать для шкалы (варианты: красный, синий, зелёный). Потом ответь одной фразой, какой я выбрал.',
      async (e) => {
        if (e.type !== 'question.request') return { type: 'permission.respond', decision: 'deny' };
        q = e.questions[0];
        return { type: 'question.answer', answers: { [q.question]: q.options[1].label } };
      },
    );
    check(!!q, `вопрос пришёл: ${q?.question}`);
    const result = posted.find(
      (m) => m.type === 'agent.event' && m.event.type === 'tool.result' && m.event.result?.answers,
    );
    check(
      !!result,
      `tool_use_result с ответами: ${short(JSON.stringify(result?.event.result?.answers))}`,
    );
    check(r.ok, 'ход завершён');
  } else if (scenario === 'plan' || scenario === 'reject') {
    await controller.handle({ type: 'mode.set', sessionId: '', mode: 'plan' });
    let plans = 0;
    const seen = [];
    const r = await runTurn(
      'Нужно добавить в README.md строку «Запуск: node test.js» в конец. Составь короткий план (2–3 шага) и вызови ExitPlanMode.',
      async (e) => {
        seen.push(e.toolName ?? e.type);
        if (e.type === 'plan.request') {
          plans++;
          if (scenario === 'reject') return { type: 'plan.decide', decision: 'reject' };
          return plans === 1
            ? {
                type: 'plan.decide',
                decision: 'refine',
                feedback: 'Добавь последним шагом проверку через git diff.',
              }
            : { type: 'plan.decide', decision: 'run' };
        }
        if (e.type === 'permission.request')
          return { type: 'permission.respond', decision: 'allow' };
        return { type: 'permission.respond', decision: 'deny' };
      },
    );
    console.log(`  запросы: ${seen.join(', ')}`);
    const modes = posted
      .filter((m) => m.type === 'agent.event' && m.event.type === 'mode.changed')
      .map((m) => m.event.mode);
    console.log(`  mode.changed: ${modes.join(' → ') || '—'}`);
    if (scenario === 'plan') {
      check(plans === 2, 'доработка: второй ExitPlanMode после отказа с текстом');
      const plan2 = posted.filter(
        (m) => m.type === 'agent.event' && m.event.type === 'plan.request',
      )[1];
      check(/git diff/i.test(plan2?.event.plan ?? ''), 'второй план учёл доработку (git diff)');
      check(modes.includes('default'), '«Выполнять» перевёл в default');
      check(
        seen.includes('Edit') || seen.includes('Write'),
        'после «Выполнять» (default) правка пришла карточкой',
      );
      check(
        readFileSync(join(dir, 'README.md'), 'utf8').includes('node test.js'),
        'README.md дописан',
      );
    } else {
      check(plans === 1, 'один план');
      check(
        r.interrupted || !r.ok || seen.length === 1,
        `ход остановлен (interrupted=${r.interrupted})`,
      );
      check(!modes.includes('default') && !modes.includes('acceptEdits'), 'режим остался plan');
      check(
        !readFileSync(join(dir, 'README.md'), 'utf8').includes('node test.js'),
        'README.md не тронут',
      );
    }
  } else {
    throw new Error(`неизвестный сценарий ${scenario}`);
  }
} catch (error) {
  console.error(`ошибка: ${error.stack ?? error}`);
  failures++;
} finally {
  const total = posted
    .filter((m) => m.type === 'agent.event' && m.event.type === 'turn.result')
    .at(-1);
  console.log(
    `итог: ${failures ? `${failures} проверок не прошло` : 'все проверки прошли'} · $${total?.event.totalCostUsd.toFixed(4) ?? '?'} · ${dir}`,
  );
  controller.dispose();
  // файл плана движок пишет в ~/.claude/plans/ — след прогона, убираем
  for (const m of posted)
    if (m.type === 'agent.event' && m.event.type === 'plan.request' && m.event.planFilePath)
      rmSync(m.event.planFilePath, { force: true });
  if (!args.includes('--keep')) rmSync(dir, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
