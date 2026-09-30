#!/usr/bin/env node
// Ожидания для тестов маппинга: лог пробы → события адаптера → src/agent/claude/__fixtures__/<лог>.expected.json.
// Запускать после осознанной правки маппера, затем ПРОСМОТРЕТЬ дифф ожиданий глазами — это и есть проверка.
//   node scripts/gen-adapter-fixtures.mjs            — все логи
//   node scripts/gen-adapter-fixtures.mjs 02 05      — только логи с этими префиксами
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTs, repoRoot } from './lib/load-ts.mjs';

const { replayProbeLog, projectEvents, PROBE_BASELINES } = await loadTs(
  'src/agent/claude/replay.ts',
);
const logsDir = join(repoRoot, 'spikes', 'sdk-probe', 'logs');
const outDir = join(repoRoot, 'src', 'agent', 'claude', '__fixtures__');
const only = process.argv.slice(2);

for (const file of readdirSync(logsDir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()) {
  const name = file.replace(/\.jsonl$/, '');
  if (only.length > 0 && !only.some((p) => name.startsWith(p))) continue;
  const lines = readFileSync(join(logsDir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const { events, permissionResults } = await replayProbeLog(lines, PROBE_BASELINES[name] ?? 0);
  if (events.length === 0) {
    console.log(`${name}: событий нет — пропущен`);
    continue;
  }
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const expected = { log: file, counts, events: projectEvents(events), permissionResults };
  writeFileSync(join(outDir, `${name}.expected.json`), JSON.stringify(expected, null, 2) + '\n');
  console.log(`${name}: ${events.length} событий`);
}
