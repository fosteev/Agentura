#!/usr/bin/env node
// Картинка в сообщении (этап 4 roadmap 0.2) на живом движке, ≈ $0.01–0.03 на Haiku:
//   node scripts/image-smoke.mjs                    — прогон и проверки
//   node scripts/image-smoke.mjs --record image-basic   — ещё и записать фикстуру test/fixtures/claude/<имя>.*
//   --model <id> (по умолчанию claude-haiku-4-5), --keep — не удалять временную папку и каталог транскриптов
//
// Картинка синтетическая: png 48×32, левая половина красная, правая синяя (≈ 100 байт). Ход: `send(text,
// [png])`, модель называет цвета. Затем: что CLI записал в транскрипт (хранит ли base64 целиком),
// `getSessionMessages()` и `loadHistory()` — миниатюра в `turn.start.images` восстановленной истории.
// Фикстура: `.sdk.ndjson` (сообщения SDK + строка `probe/send` с картинкой), `.messages.json`,
// `.transcript.ndjson`; пути и списки init очищены как у agents-smoke.
import { Buffer } from 'node:buffer';
import { deflateSync, crc32 } from 'node:zlib';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCleaner } from './lib/fixture-clean.mjs';
import { loadTs, repoRoot } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const model = value('--model', 'claude-haiku-4-5');
const record = value('--record', undefined);
const keep = args.includes('--keep');

/** PNG RGB 8 бит без сжатия фильтрами: строки с байтом фильтра 0. */
function png(width, height, pixel) {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * row + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 бит, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 48;
const H = 32;
const image = {
  mediaType: 'image/png',
  data: png(W, H, (x) => (x < W / 2 ? [220, 20, 20] : [20, 40, 220])).toString('base64'),
  width: W,
  height: H,
  name: 'скриншот 1',
};

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-image-')));
const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { projectDir, projectDirName } = await loadTs('src/data/sessions.ts');

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const short = (s, n = 90) => String(s).replace(/\n/g, '⏎').slice(0, n);

const raw = [];
const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/0',
  settingSources: ['project', 'local'],
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
  trace: (m) => raw.push({ at: Date.now() - started, m }),
});

let exitCode = 0;
const fail = (msg) => {
  console.log(`!! ${msg}`);
  exitCode = 1;
};

const session = await adapter.createSession({ cwd, model, title: 'agentura image smoke' });
// строка `probe/send` для фикстуры: текст и картинки сообщения + uuid (маппер привязывает промпт по эху)
const input = session.input;
const push = input.push.bind(input);
input.push = (m) => {
  const content = m.message.content;
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  raw.push({
    at: Date.now() - started,
    m: {
      type: 'probe',
      kind: 'send',
      t: Date.now() - started,
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      images: blocks
        .filter((b) => b.type === 'image')
        .map((b) => ({ mediaType: b.source.media_type, data: b.source.data, width: W, height: H })),
      uuid: m.uuid,
    },
  });
  console.log(
    `${t()} → content: ${Array.isArray(content) ? content.map((b) => b.type).join(', ') : 'string'}`,
  );
  push(m);
};

const events = [];
let done;
const finished = new Promise((r) => (done = r));
session.events.on((e) => {
  events.push(e);
  if (e.type === 'turn.start')
    console.log(`${t()} turn.start «${short(e.prompt ?? '')}» images=${e.images?.length ?? 0}`);
  if (e.type === 'turn.result') {
    console.log(
      `${t()} turn.result ok=${e.ok} cost=$${e.costUsd?.toFixed(4) ?? '?'} «${short(e.text ?? '', 120)}»`,
    );
    done(e);
  }
  if (e.type === 'error')
    console.log(`${t()} error ${e.code ?? ''} ${short(e.message ?? '', 160)}`);
  if (e.type === 'usage.message' && !e.agentId)
    console.log(
      `${t()} usage input=${e.usage.input} cacheW=${e.usage.cacheWrite} cacheR=${e.usage.cacheRead}`,
    );
});

const prompt =
  'The attached picture has two halves. Name the colour of the left half and of the right half. Answer in English, exactly two words: <left> <right>.';
let result;
try {
  console.log(
    `${t()} → send (model ${model}, png ${image.data.length} символов base64, cwd ${cwd})`,
  );
  if (!session.send(prompt, [image])) fail('send вернул false');
  result = await Promise.race([
    finished,
    new Promise((r) => setTimeout(() => r(undefined), 120_000)),
  ]);
  if (!result) fail('ход не закончился за 120 с');
} catch (error) {
  fail(`ошибка: ${error.message}`);
} finally {
  session.dispose();
}

const answer = (result?.text ?? '').toLowerCase();
if (result && !result.ok) fail('ход закончился ошибкой');
if (result && !(answer.includes('red') && answer.includes('blue')))
  fail(`модель не назвала red и blue: «${answer}»`);
const start = events.find((e) => e.type === 'turn.start');
if (start?.images?.[0]?.data !== image.data) fail('turn.start живого хода без картинки');

// ——— что CLI хранит ———
const sessionId = session.id;
const dir = projectDir(cwd);
const transcript = join(dir, `${sessionId}.jsonl`);
await new Promise((r) => setTimeout(r, 1500)); // CLI дописывает транскрипт после dispose
console.log('\n— транскрипт —');
if (!existsSync(transcript)) fail(`нет транскрипта ${transcript}`);
else {
  const records = readFileSync(transcript, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let found = false;
  for (const r of records) {
    const c = r.message?.content;
    if (r.type !== 'user' || !Array.isArray(c)) continue;
    const shape = c.map((b) =>
      b.type === 'image'
        ? `image(${b.source?.type}, ${b.source?.media_type}, ${b.source?.data?.length ?? 0} симв.)`
        : b.type,
    );
    console.log(
      `user: [${shape.join(', ')}]${r.imagePasteIds ? ` imagePasteIds=${JSON.stringify(r.imagePasteIds)}` : ''}`,
    );
    for (const b of c) if (b.type === 'image' && b.source?.data === image.data) found = true;
  }
  const keys = new Set();
  for (const r of records) if (r.type === 'user') Object.keys(r).forEach((k) => keys.add(k));
  console.log(`поля записей user: ${[...keys].sort().join(', ')}`);
  console.log(
    found ? 'base64 в транскрипте: целиком, совпадает с отправленным' : 'base64 в транскрипте: НЕТ',
  );
  if (!found) fail('транскрипт не хранит base64 картинки');
}

const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
const messages = sessionId ? await getSessionMessages(sessionId, { dir: cwd }) : [];
const userImage = messages.some(
  (m) =>
    m.type === 'user' &&
    Array.isArray(m.message?.content) &&
    m.message.content.some((b) => b.type === 'image' && b.source?.data === image.data),
);
console.log(
  `getSessionMessages: ${messages.length} сообщений, картинка ${userImage ? 'есть' : 'НЕТ'}`,
);
if (!userImage) fail('getSessionMessages без картинки');

const history = sessionId ? await adapter.loadHistory(sessionId, cwd) : { events: [] };
const hStart = history.events.find((e) => e.type === 'turn.start');
console.log(
  `loadHistory: turn.start «${short(hStart?.prompt ?? '')}» images=${JSON.stringify((hStart?.images ?? []).map((i) => ({ ...i, data: i.data ? `${i.data.length} симв.` : undefined })))}`,
);
if (hStart?.images?.[0]?.data !== image.data) fail('история: нет миниатюры в turn.start');
if (hStart?.prompt !== prompt) fail('история: текст реплики не совпал');

// ——— фикстура ———
if (record && sessionId) {
  const { clean, cleanJsonl, scrub } = fixtureCleaner(
    cwd,
    projectDirName(cwd),
    '/tmp/agentura-image',
  );
  const out = join(repoRoot, 'test', 'fixtures', 'claude');
  writeFileSync(
    join(out, `${record}.sdk.ndjson`),
    raw.map(({ m }) => clean(JSON.stringify(scrub(m)))).join('\n') + '\n',
  );
  writeFileSync(
    join(out, `${record}.messages.json`),
    clean(JSON.stringify(messages, null, 1)) + '\n',
  );
  if (existsSync(transcript))
    writeFileSync(
      join(out, `${record}.transcript.ndjson`),
      cleanJsonl(readFileSync(transcript, 'utf8')),
    );
  console.log(`фикстура: test/fixtures/claude/${record}.* (сессия ${sessionId})`);
}

if (!keep) {
  await new Promise((r) => setTimeout(r, 2000));
  rmSync(cwd, { recursive: true, force: true });
  // только каталоги этой временной папки (имя по её пути), реальные сессии не трогаем
  if (dir.includes('agentura-image-')) rmSync(dir, { recursive: true, force: true });
  const tasks = join('/tmp', `claude-${process.getuid?.() ?? ''}`, projectDirName(cwd));
  if (tasks.includes('agentura-image-')) rmSync(tasks, { recursive: true, force: true });
}
console.log(exitCode === 0 ? '\nOK' : '\nПРОВАЛ');
process.exit(exitCode);
