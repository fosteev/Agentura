#!/usr/bin/env node
// Сверка списка сессий этапа 6 с источниками (без токенов и без движка, только чтение):
//   node scripts/sessions-verify.mjs [--cwd <папка проекта>] [--days 14]
// 1) состав: сессии `listSessions()` против *.jsonl каталога транскриптов проекта (основной состав
//    `claude --resume`: по файлам каталога) — что не попало в список и почему;
// 2) итоги: токены и число запросов по транскрипту (наш `transcriptTotals`) против `agentmeter tasks --json`
//    за те же дни (репо Agentmeter: `AGENTMETER_DIR`, по умолчанию ~/Projects/Agentmeter) — расхождение в процентах.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs, repoRoot } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cwd = value('--cwd', repoRoot);
const days = Number(value('--days', '14'));
const AGENTMETER = process.env.AGENTMETER_DIR ?? join(homedir(), 'Projects/Agentmeter');

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { listSessionRows, LiveSessions, TranscriptCache, projectDir } =
  await loadTs('src/data/sessions.ts');
const adapter = new ClaudeAdapter({ clientApp: 'agentura-verify/0' });

// ——— 1. состав ———
const dir = projectDir(cwd);
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -6))
  : [];
const rows = await listSessionRows(adapter, {
  cwd,
  live: new LiveSessions(),
  cache: new TranscriptCache(),
});
const listed = new Set(rows.map((r) => r.id));
const fromDir = new Set(files);
const missing = files.filter((id) => !listed.has(id));
const extra = [...listed].filter((id) => !fromDir.has(id));
console.log(`каталог ${dir}`);
console.log(
  `файлов транскриптов: ${files.length}, в списке: ${rows.length}, не в списке: ${missing.length}, в списке без файла в каталоге (worktree): ${extra.length}`,
);
for (const id of missing) {
  const lines = readFileSync(join(dir, `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);
  const kinds = {};
  for (const l of lines) {
    try {
      const t = JSON.parse(l).type;
      kinds[t] = (kinds[t] ?? 0) + 1;
    } catch {
      kinds.broken = (kinds.broken ?? 0) + 1;
    }
  }
  console.log(`  не в списке ${id}: ${lines.length} строк, типы ${JSON.stringify(kinds)}`);
}

// ——— 2. итоги против Agentmeter ———
const scratch = mkdtempSync(join(tmpdir(), 'agentura-verify-'));
const byId = new Map(rows.map((r) => [r.id, r]));
const now = new Date();
let compared = 0;
let worst = { id: '', pct: 0 };
const seen = new Set();
const lines = [];
for (let d = 0; d < days; d++) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  let out;
  try {
    // через файл: CLI завершается process.exit(), и длинный вывод в канал обрезается на 64 КБ
    const file = join(scratch, `tasks-${iso}.json`);
    execFileSync(
      'sh',
      [
        '-c',
        `node --experimental-strip-types apps/cli/src/main.ts tasks --json --day ${iso} --limit 1000 > "${file}"`,
      ],
      {
        cwd: AGENTMETER,
        stdio: 'ignore',
      },
    );
    out = readFileSync(file, 'utf8');
  } catch (e) {
    console.log(`agentmeter tasks ${iso}: ${e.message.split('\n')[0]}`);
    continue;
  }
  for (const t of JSON.parse(out).rows) {
    const ours = byId.get(t.sessionId);
    if (!ours || seen.has(t.sessionId)) continue;
    seen.add(t.sessionId);
    const a = t.totals.total;
    const o =
      ours.tokens.input + ours.tokens.output + ours.tokens.cacheRead + ours.tokens.cacheWrite;
    const pct = a === 0 ? (o === 0 ? 0 : 100) : (Math.abs(o - a) / a) * 100;
    compared++;
    if (pct > worst.pct) worst = { id: t.sessionId, pct };
    lines.push({
      id: t.sessionId,
      iso,
      ours: o,
      agentmeter: a,
      pct,
      requests: t.totals.requests,
      children: t.children.length,
      sidechain: t.sidechain,
    });
  }
}
lines.sort((x, y) => y.pct - x.pct);
console.log(
  `\nсверка итогов: сессий сопоставлено ${compared} из ${rows.length} (остальные вне окна ${days} дн. или агентметр их не видит)`,
);
for (const l of lines.slice(0, 12)) {
  console.log(
    `  ${l.id.slice(0, 8)} ${l.iso} наши ${l.ours} / agentmeter ${l.agentmeter} → ${l.pct.toFixed(2)} %${l.children ? ` (субагентов ${l.children})` : ''}`,
  );
}
console.log(
  `макс. расхождение токенов: ${worst.pct.toFixed(2)} % (${worst.id.slice(0, 8) || '—'})`,
);
const over = lines.filter((l) => l.pct > 5);
console.log(over.length ? `ПРЕВЫШЕНИЕ 5 %: ${over.length} сессий` : 'все в пределах 5 %');
process.exit(0);
