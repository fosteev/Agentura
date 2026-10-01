#!/usr/bin/env node
// Синтетический транскрипт Claude Code для замеров (этап 5 roadmap 0.2): ходы с картинками и pdf base64 в
// репликах пользователя (строки по несколько МБ, как с этапов 4 и 8), ответы по блокам с общим requestId,
// результаты инструментов с `toolUseResult`, `permissionMode`, `cost-state`.
//   node scripts/transcript-gen.mjs --out <файл.jsonl> [--mb 50] [--session <uuid>] [--cwd <папка>]
// Как модуль: `generateTranscript({ file, mb, sessionId, cwd })`, `turnLines(...)` — строки одного хода
// (для дописывания во время замера). Пишет только туда, куда сказали; ~/.claude не трогает.
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MODEL = 'claude-sonnet-4-5-20250929';

/** Детерминированный «base64» нужной длины (кратной 4): содержимое не важно, важен размер строки. */
function fakeBase64(bytes, seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const len = Math.ceil(bytes / 3) * 4;
  const unit = Array.from({ length: 4096 }, (_, i) => alphabet[(i * 7 + seed) % 64]).join('');
  return unit.repeat(Math.ceil(len / unit.length)).slice(0, len);
}

/** Цепочка `parentUuid`: `getSessionMessages` собирает ветку от последней записи по ней. */
const lastUuid = new Map();

function base(sessionId, cwd, at, extra = {}) {
  const uuid = randomUUID();
  const parentUuid = lastUuid.get(sessionId) ?? null;
  lastUuid.set(sessionId, uuid);
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version: '2.1.285',
    gitBranch: 'main',
    uuid,
    timestamp: new Date(at).toISOString(),
    ...extra,
  };
}

/**
 * Строки одного хода: промпт (каждый 5-й — с картинкой ~1,5 МБ base64, каждый 9-й — с pdf ~3 МБ), три
 * API-запроса по 2–3 записи (thinking, text, tool_use) и результаты инструментов (Edit с патчем, Read с текстом).
 */
export function turnLines({ sessionId, cwd, turn, at = Date.now() }) {
  const lines = [];
  const push = (rec) => lines.push(JSON.stringify(rec));
  const content = [
    { type: 'text', text: `Ход ${turn}: поправь функцию и объясни, что изменилось.` },
  ];
  if (turn % 5 === 0) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: fakeBase64(1_100_000, turn) },
    });
  }
  if (turn % 9 === 0) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: fakeBase64(2_200_000, turn) },
      title: `docs/spec-${turn}.pdf`,
    });
  }
  push({
    ...base(sessionId, cwd, at),
    type: 'user',
    permissionMode: 'default',
    message: { role: 'user', content },
  });
  for (let r = 0; r < 3; r++) {
    const requestId = `req_${sessionId.slice(0, 8)}_${turn}_${r}`;
    const id = `msg_${sessionId.slice(0, 8)}_${turn}_${r}`;
    const usage = {
      input_tokens: 3 + r,
      cache_creation_input_tokens: 1200 + turn * 3,
      cache_read_input_tokens: 20_000 + turn * 400 + r * 1500,
      cache_creation: { ephemeral_5m_input_tokens: 1200 + turn * 3, ephemeral_1h_input_tokens: 0 },
      output_tokens: 1,
      service_tier: 'standard',
    };
    const toolId = `toolu_${sessionId.slice(0, 8)}_${turn}_${r}`;
    const blocks = [
      {
        type: 'thinking',
        thinking: 'Смотрю файл и решаю, что поправить. '.repeat(20),
        signature: 'sig',
      },
      { type: 'text', text: `Шаг ${r}: читаю и правлю. `.repeat(10) },
      r < 2
        ? {
            type: 'tool_use',
            id: toolId,
            name: r === 0 ? 'Read' : 'Edit',
            input:
              r === 0
                ? { file_path: `${cwd}/src/file${turn}.ts` }
                : {
                    file_path: `${cwd}/src/file${turn}.ts`,
                    old_string: 'const a = 1;',
                    new_string: 'const a = 2;',
                  },
          }
        : undefined,
    ].filter(Boolean);
    blocks.forEach((block, i) => {
      push({
        ...base(sessionId, cwd, at + r * 1000 + i),
        type: 'assistant',
        requestId,
        message: {
          model: MODEL,
          id,
          type: 'message',
          role: 'assistant',
          content: [block],
          stop_reason: null,
          usage: { ...usage, output_tokens: i === blocks.length - 1 ? 180 + r * 20 : 1 },
        },
      });
    });
    if (r < 2) {
      const text = r === 0 ? 'export const a = 1;\n'.repeat(1000) : 'The file has been updated.';
      push({
        ...base(sessionId, cwd, at + r * 1000 + 500),
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: text }],
        },
        toolUseResult:
          r === 0
            ? { type: 'text', file: { filePath: `${cwd}/src/file${turn}.ts`, numLines: 1000 } }
            : {
                filePath: `${cwd}/src/file${turn}.ts`,
                oldString: 'const a = 1;',
                newString: 'const a = 2;',
                structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ['-const a = 1;', '+const a = 2;'],
                  },
                ],
              },
      });
    }
  }
  push({ type: 'cost-state', sessionId, totalCostUSD: Number((turn * 0.031).toFixed(4)) });
  return lines;
}

/** Транскрипт размером не меньше `mb` МБ. Возвращает число ходов и байт. */
export function generateTranscript({
  file,
  mb = 50,
  sessionId = randomUUID(),
  cwd = '/tmp/agentura-bench',
}) {
  const target = mb * 1024 * 1024;
  writeFileSync(file, '');
  let bytes = 0;
  let turn = 0;
  const at = Date.now() - 86_400_000;
  while (bytes < target) {
    turn++;
    const chunk = `${turnLines({ sessionId, cwd, turn, at: at + turn * 60_000 }).join('\n')}\n`;
    appendFileSync(file, chunk);
    bytes += Buffer.byteLength(chunk);
  }
  return { turns: turn, bytes, sessionId };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const file = value('--out', undefined);
  if (!file) {
    console.error('нужен --out <файл.jsonl>');
    process.exit(2);
  }
  const r = generateTranscript({
    file,
    mb: Number(value('--mb', '50')),
    sessionId: value('--session', randomUUID()),
    cwd: value('--cwd', '/tmp/agentura-bench'),
  });
  console.log(
    `${file}: ${r.turns} ходов, ${(r.bytes / 1024 / 1024).toFixed(1)} МБ, сессия ${r.sessionId}`,
  );
}
