#!/usr/bin/env node
// Этап 6 на живом движке через настоящий ChatController (без VS Code), ≈ $0.05–0.10 на Haiku:
//   node scripts/resume-smoke.mjs [--model claude-haiku-4-5]
// 1) вкладка A: новая сессия, агент правит файл (Edit), разрешение приходит карточкой → allow;
// 2) вкладка B: тот же id (`resumeId`), как после Reload Window: история из транскрипта доходит до
//    webview (session.history), «diff» по правке находит её и открывает дифф, продолжение диалога идёт
//    в той же сессии с базой стоимости.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'claude-haiku-4-5';
const cwd = mkdtempSync(join(tmpdir(), 'agentura-resume-'));
writeFileSync(join(cwd, 'hello.txt'), 'alpha\nbeta\ngamma\n');

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { ChatController } = await loadTs('src/extension/chatController.ts');
const { LiveSessions } = await loadTs('src/data/sessions.ts');

const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/0',
  settingSources: ['project', 'local'], // правила владельца (allow: Edit) закрыли бы карточку разрешения
  log: (level, m) => level !== 'debug' && console.error(`  [${level}] ${m}`),
});
const live = new LiveSessions();
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, '⏎');

function tab(label, resumeId) {
  const posted = [];
  const opened = [];
  const warnings = [];
  const controller = new ChatController({
    adapter,
    cwd,
    project: 'tmp',
    post: (m) => posted.push(m),
    setTitle: () => {},
    log: {
      debug() {},
      info() {},
      warn: (m) => warnings.push(m),
      error: (m) => console.error(`  [${label}] ${m}`),
    },
    settings: () => ({ allowBypass: false, defaultModel: model }),
    findFiles: async () => [],
    pickFiles: async () => [],
    readSelection: async () => undefined,
    listRecent: async () => [],
    showSessions() {},
    live,
    readText: async (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    openDiff: async (d) => void opened.push(d),
    ...(resumeId ? { resumeId } : {}),
  });
  const waitFor = (pred, ms = 120_000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = posted.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error(`${label}: таймаут`));
        setTimeout(tick, 100);
      };
      tick();
    });
  return { controller, posted, opened, warnings, waitFor };
}

let exit = 0;
try {
  const a = tab('A');
  a.controller.start();
  await a.controller.handle({ type: 'ready' });
  await a.controller.handle({
    type: 'send',
    sessionId: '',
    text: 'В файле hello.txt замени строку "beta" на "BETA" инструментом Edit. Ответь одним словом: готово.',
  });
  const req = await a.waitFor(
    (m) => m.type === 'agent.event' && m.event.type === 'permission.request',
  );
  console.log(`A: permission.request ${req.event.toolName}, diff=${req.event.diff?.kind}`);
  await a.controller.handle({
    type: 'permission.respond',
    sessionId: '',
    toolUseId: req.event.toolUseId,
    decision: 'allow',
  });
  const done = await a.waitFor((m) => m.type === 'agent.event' && m.event.type === 'turn.result');
  const id = a.controller.sessionId;
  console.log(
    `A: ход завершён, сессия ${id}, итог движка $${done.event.totalCostUsd.toFixed(4)}; файл: ${JSON.stringify(readFileSync(join(cwd, 'hello.txt'), 'utf8'))}`,
  );
  a.controller.dispose();
  await new Promise((r) => setTimeout(r, 1000));

  // Reload Window: новая вкладка с resumeId, webview присылает ready
  const b = tab('B', id);
  b.controller.start();
  await b.controller.handle({ type: 'ready' });
  const hist = await b.waitFor((m) => m.type === 'session.history');
  const kinds = hist.events.map((e) => e.type);
  console.log(
    `B: session.history ${hist.sessionId === id ? '(та же сессия)' : '!! ДРУГАЯ'}, событий ${hist.events.length}, режим ${hist.mode}, модель ${hist.model}`,
  );
  console.log(`B: типы: ${[...new Set(kinds)].join(', ')}`);
  const res = hist.events.find((e) => e.type === 'tool.result' && e.result?.structuredPatch);
  console.log(
    `B: у tool.result правки structuredPatch=${!!res}, originalFile в webview=${res?.result?.originalFile !== undefined ? 'ЕСТЬ (тяжёлое)' : 'нет'}`,
  );
  const start = hist.events.find((e) => e.type === 'tool.start' && e.name === 'Edit');
  await b.controller.handle({ type: 'diff.open', sessionId: id, toolUseId: start.toolUseId });
  const d = b.opened[0];
  console.log(
    `B: diff.open → ${d ? `${d.stage}, ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}` : '!! не открыт'}${b.warnings.length ? `, предупреждения: ${b.warnings.join('; ')}` : ''}`,
  );
  if (!d || !d.after.includes('BETA')) exit = 2;

  await b.controller.handle({
    type: 'send',
    sessionId: id,
    text: 'Какой файл ты правил? Ответь только именем файла.',
  });
  const r2 = await b.waitFor((m) => m.type === 'agent.event' && m.event.type === 'turn.result');
  const init = b.posted.find((m) => m.type === 'agent.event' && m.event.type === 'session.init');
  console.log(
    `B: продолжение: «${short(r2.event.text ?? '')}», init.sessionId ${init?.event.sessionId === id ? 'та же' : '!! другая'}, стоимость хода $${r2.event.costUsd?.toFixed(4)}, итог $${r2.event.totalCostUsd.toFixed(4)} (база из cost-state)`,
  );
  if (init?.event.sessionId !== id) exit = 2;
  b.controller.dispose();
} catch (e) {
  console.error(`ошибка: ${e.stack ?? e}`);
  exit = 1;
}
process.exit(exit);
