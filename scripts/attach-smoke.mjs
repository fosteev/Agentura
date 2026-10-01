#!/usr/bin/env node
// Файлы-вложения (этап 8 roadmap 0.2) на живом движке, ≈ $0.02–0.05 на Haiku:
//   node scripts/attach-smoke.mjs                       — прогон и проверки
//   node scripts/attach-smoke.mjs --record attach-basic — ещё и записать фикстуру test/fixtures/claude/<имя>.*
//   --model <id> (по умолчанию claude-haiku-4-5), --keep — не удалять временную папку и каталог транскриптов
//
// Файлы синтетические: `notes/secret.txt` в рабочей папке (секретное слово) и минимальный pdf вне её
// (одна страница с кодовым словом). Хост читает их тем же `readAttachment`, что «+» и перетаскивание,
// ход — `send(text, [], files)`: текст — `document` с `source.type: 'text'`, pdf — base64, `title` — путь.
// Затем: что CLI записал в транскрипт (хранит ли документы целиком), `getSessionMessages()` и
// `loadHistory()` — чипы в `turn.start.files` восстановленной истории.
import { Buffer } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
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

/** Минимальный pdf: одна страница, Helvetica, строка `text`; таблица xref по настоящим смещениям. */
function pdf(text) {
  const stream = `BT /F1 18 Tf 20 70 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const SECRET = 'PELICAN-7342';
const CODE = 'ZEBRA 42';
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-attach-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-attach-out-')));
mkdirSync(join(cwd, 'notes'));
writeFileSync(join(cwd, 'notes', 'secret.txt'), `Project notes.\nThe secret word is ${SECRET}.\n`);
writeFileSync(join(outside, 'probe.pdf'), pdf(`The code word is ${CODE}`));

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { projectDir, projectDirName } = await loadTs('src/data/sessions.ts');
const { readAttachment } = await loadTs('src/extension/attachFiles.ts');

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const short = (s, n = 90) => String(s).replace(/\n/g, '⏎').slice(0, n);

let exitCode = 0;
const fail = (msg) => {
  console.log(`!! ${msg}`);
  exitCode = 1;
};

// хост читает файлы так же, как «+» и перетаскивание
const files = [];
for (const fsPath of [join(cwd, 'notes', 'secret.txt'), join(outside, 'probe.pdf')]) {
  const bytes = readFileSync(fsPath);
  const picked = await readAttachment(cwd, {
    fsPath,
    size: bytes.length,
    read: async () => new Uint8Array(bytes),
  });
  const f = picked.files[0];
  if (!f || f.problem || !f.kind) {
    fail(`файл не взят: ${fsPath} — ${f?.problem ?? 'картинка?'}`);
    continue;
  }
  console.log(
    `${t()} файл ${f.kind} «${f.path}» ${f.size} байт${f.pages ? `, ${f.pages} стр.` : ''}`,
  );
  files.push({
    kind: f.kind,
    path: f.path,
    data: f.data,
    size: f.size,
    ...(f.pages !== undefined ? { pages: f.pages } : {}),
  });
}
if (files[0]?.path !== 'notes/secret.txt') fail(`путь файла рабочей папки: ${files[0]?.path}`);
if (files[1]?.path !== join(outside, 'probe.pdf')) fail(`путь файла вне папки: ${files[1]?.path}`);

const raw = [];
const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/0',
  settingSources: ['project', 'local'],
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
  trace: (m) => raw.push({ at: Date.now() - started, m }),
});

const session = await adapter.createSession({ cwd, model, title: 'agentura attach smoke' });
// строка `probe/send` для фикстуры: текст и файлы сообщения (без содержимого) + uuid
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
      files: files.map((f) => ({ ...f, data: undefined })),
      uuid: m.uuid,
    },
  });
  console.log(
    `${t()} → content: ${Array.isArray(content) ? content.map((b) => (b.type === 'document' ? `document(${b.source.type}, «${b.title}»)` : b.type)).join(', ') : 'string'}`,
  );
  push(m);
};

const events = [];
let done;
const finished = new Promise((r) => (done = r));
session.events.on((e) => {
  events.push(e);
  if (e.type === 'turn.start')
    console.log(
      `${t()} turn.start «${short(e.prompt ?? '')}» files=${JSON.stringify(e.files ?? [])}`,
    );
  if (e.type === 'tool.start')
    console.log(`${t()} tool.start ${e.name} ${short(JSON.stringify(e.input ?? {}), 120)}`);
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
  'Two files are attached: a text file and a PDF. Reply with exactly two lines: the secret word from the text file, then the code word from the PDF.';
let result;
try {
  console.log(`${t()} → send (model ${model}, cwd ${cwd})`);
  if (!session.send(prompt, [], files)) fail('send вернул false');
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

const answer = (result?.text ?? '').toUpperCase();
if (result && !result.ok) fail('ход закончился ошибкой');
if (result && !answer.includes(SECRET)) fail(`модель не назвала слово из текста: «${answer}»`);
if (result && !answer.includes(CODE)) fail(`модель не назвала слово из pdf: «${answer}»`);
const start = events.find((e) => e.type === 'turn.start');
if (start?.files?.map((f) => f.path).join('|') !== files.map((f) => f.path).join('|'))
  fail('turn.start живого хода без файлов');
if (start?.files?.some((f) => f.data !== undefined))
  fail('turn.start живого хода несёт содержимое');

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
  const kept = new Set();
  for (const r of records) {
    const c = r.message?.content;
    if (r.type !== 'user' || !Array.isArray(c)) continue;
    const shape = c.map((b) =>
      b.type === 'document'
        ? `document(${b.source?.type}, ${b.source?.media_type}, ${b.source?.data?.length ?? 0} симв., title=${b.title})`
        : b.type,
    );
    console.log(`user${r.isMeta ? ' [meta]' : ''}: [${shape.join(', ')}]`);
    for (const b of c)
      for (const f of files)
        if (b.type === 'document' && b.title === f.path && b.source?.data === f.data)
          kept.add(f.path);
  }
  console.log(`документы в транскрипте целиком: ${kept.size} из ${files.length}`);
  if (kept.size !== files.length) fail('транскрипт не хранит документы целиком');
}

const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
const messages = sessionId ? await getSessionMessages(sessionId, { dir: cwd }) : [];
const docs = messages
  .filter((m) => m.type === 'user' && Array.isArray(m.message?.content))
  .flatMap((m) => m.message.content.filter((b) => b.type === 'document'));
console.log(`getSessionMessages: ${messages.length} сообщений, документов ${docs.length}`);
if (docs.length !== files.length) fail('getSessionMessages без документов');

const history = sessionId ? await adapter.loadHistory(sessionId, cwd) : { events: [] };
const hStart = history.events.find((e) => e.type === 'turn.start');
console.log(
  `loadHistory: turn.start «${short(hStart?.prompt ?? '')}» files=${JSON.stringify((hStart?.files ?? []).map((f) => ({ ...f, data: f.data ? `${f.data.length} симв.` : undefined })))}`,
);
if (
  hStart?.files?.map((f) => `${f.kind}:${f.path}`).join('|') !==
  files.map((f) => `${f.kind}:${f.path}`).join('|')
)
  fail('история: нет чипов файлов в turn.start');
if (hStart?.files?.[0]?.data !== files[0]?.data) fail('история: нет содержимого текстового файла');
if (hStart?.prompt !== prompt) fail('история: текст реплики не совпал');

// ——— фикстура ———
if (record && sessionId) {
  const { clean, cleanJsonl, scrub } = fixtureCleaner(
    cwd,
    projectDirName(cwd),
    '/tmp/agentura-attach',
  );
  const cleanOut = (text) =>
    clean(text)
      .split(outside)
      .join('/tmp/outside')
      .split(outside.replace(/^\/private/, ''))
      .join('/tmp/outside');
  const out = join(repoRoot, 'test', 'fixtures', 'claude');
  writeFileSync(
    join(out, `${record}.sdk.ndjson`),
    raw.map(({ m }) => cleanOut(JSON.stringify(scrub(m)))).join('\n') + '\n',
  );
  writeFileSync(
    join(out, `${record}.messages.json`),
    cleanOut(JSON.stringify(messages, null, 1)) + '\n',
  );
  if (existsSync(transcript))
    writeFileSync(
      join(out, `${record}.transcript.ndjson`),
      cleanOut(cleanJsonl(readFileSync(transcript, 'utf8'))),
    );
  console.log(`фикстура: test/fixtures/claude/${record}.* (сессия ${sessionId})`);
}

if (!keep) {
  await new Promise((r) => setTimeout(r, 2000));
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  // только каталоги этой временной папки (имя по её пути), реальные сессии не трогаем
  if (dir.includes('agentura-attach-')) rmSync(dir, { recursive: true, force: true });
  const tasks = join('/tmp', `claude-${process.getuid?.() ?? ''}`, projectDirName(cwd));
  if (tasks.includes('agentura-attach-')) rmSync(tasks, { recursive: true, force: true });
}
console.log(exitCode === 0 ? '\nOK' : '\nПРОВАЛ');
process.exit(exitCode);
