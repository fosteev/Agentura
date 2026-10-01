#!/usr/bin/env node
// Замер списка сессий и resume на большом транскрипте (этап 5 roadmap 0.2), без движка и без токенов:
//   node scripts/sessions-bench.mjs [--mb 50] [--ticks 10]
// Во временной папке: CLAUDE_CONFIG_DIR, проект, синтетический транскрипт `--mb` МБ (scripts/transcript-gen.mjs)
// и ещё две маленькие сессии. Меряет `SessionsService.refresh()`: холодный проход и `--ticks` тиков «во время
// хода» (перед каждым дописывается ход; каждый пятый — с картинкой, каждый девятый — с pdf), а также
// `loadHistory` (resume). Для каждого — время на часах и самую длинную блокировку потока
// (наибольший промежуток между тиками таймера в 1 мс). Временную папку удаляет.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { loadTs } from './lib/load-ts.mjs';
import { generateTranscript, turnLines } from './transcript-gen.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const mb = Number(value('--mb', '50'));
const ticks = Number(value('--ticks', '10'));

// realpath: CLI и SDK называют каталог проекта по реальному пути (`/var` → `/private/var` на macOS)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-bench-')));
const home = join(root, 'claude');
const cwd = join(root, 'project');
mkdirSync(cwd, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = home;

try {
  const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
  const { LiveSessions, TranscriptCache, projectDir } = await loadTs('src/data/sessions.ts');
  const { SessionsService } = await loadTs('src/extension/sessionsService.ts');

  const dir = projectDir(cwd, home);
  mkdirSync(dir, { recursive: true });
  const big = randomUUID();
  const file = join(dir, `${big}.jsonl`);
  const t0 = performance.now();
  const gen = generateTranscript({ file, mb, sessionId: big, cwd });
  console.log(
    `транскрипт: ${(gen.bytes / 1024 / 1024).toFixed(1)} МБ, ${gen.turns} ходов (${Math.round(performance.now() - t0)} мс)`,
  );
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${turnLines({ sessionId: id, cwd, turn: 1 }).join('\n')}\n`,
    );
  }

  const adapter = new ClaudeAdapter({ clientApp: 'agentura-bench/0' });
  const live = new LiveSessions();
  live.set(big, 'live');
  const service = new SessionsService({
    adapter,
    cwd,
    dir,
    live,
    cache: new TranscriptCache(),
    log: { debug() {}, warn: (m) => console.error(m) },
    watch: () => ({ close() {} }),
  });

  // Самая длинная блокировка потока: наибольший промежуток между тиками таймера в 1 мс за время замера
  // (синхронный кусок не даёт таймеру сработать — промежуток ≈ длине куска).
  async function measure(fn) {
    let last = performance.now();
    let block = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      block = Math.max(block, now - last);
      last = now;
    }, 1);
    await new Promise((r) => setTimeout(r, 5));
    block = 0;
    last = performance.now();
    const start = performance.now();
    const out = await fn();
    const wall = performance.now() - start;
    await new Promise((r) => setTimeout(r, 3));
    clearInterval(timer);
    return { wall, block, out };
  }
  const fmt = (m) => `${m.wall.toFixed(1)} мс на часах, блок потока до ${m.block.toFixed(1)} мс`;

  const listOnly = await measure(() => adapter.listSessions(cwd));
  console.log(`listSessions() SDK, холодный: ${fmt(listOnly)}`);
  const cold = await measure(() => service.refresh());
  const row = cold.out.find((r) => r.id === big);
  console.log(
    `refresh() холодный: ${fmt(cold)} — ходов ${row?.turns}, $${row?.costUsd?.toFixed(2)}`,
  );
  const warm = await measure(() => service.refresh());
  console.log(`refresh() без изменений: ${fmt(warm)}`);

  const results = [];
  for (let i = 1; i <= ticks; i++) {
    const turn = gen.turns + i;
    appendFileSync(file, `${turnLines({ sessionId: big, cwd, turn }).join('\n')}\n`);
    const m = await measure(() => service.refresh());
    const r = m.out.find((x) => x.id === big);
    results.push(m);
    const kind = turn % 9 === 0 ? ' pdf' : turn % 5 === 0 ? ' картинка' : '';
    console.log(`  тик ${i} (ход ${turn}${kind}): ${fmt(m)} — ходов ${r?.turns}`);
  }
  const maxWall = Math.max(...results.map((m) => m.wall));
  const maxBlock = Math.max(...results.map((m) => m.block));
  const avgWall = results.reduce((s, m) => s + m.wall, 0) / results.length;
  console.log(
    `refresh() во время хода, ${ticks} тиков: среднее ${avgWall.toFixed(1)} мс, max ${maxWall.toFixed(1)} мс на часах, блок до ${maxBlock.toFixed(1)} мс`,
  );

  const before = process.memoryUsage().rss;
  const hist = await measure(() => adapter.loadHistory(big, cwd));
  const after = process.memoryUsage().rss;
  console.log(
    `loadHistory (resume): ${fmt(hist)} — событий ${hist.out.events.length}, RSS +${((after - before) / 1024 / 1024).toFixed(0)} МБ`,
  );
  service.dispose();
} finally {
  rmSync(root, { recursive: true, force: true });
}
