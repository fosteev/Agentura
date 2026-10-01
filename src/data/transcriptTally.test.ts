import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countTurns, TranscriptCache, transcriptTotals } from './sessions';
import { FileTally } from './transcriptTally';
import { streamLines } from './jsonlStream';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'claude');

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = () => (dir = mkdtempSync(join(tmpdir(), 'agentura-tally-')));

/** Транскрипты фикстур: файл и (если есть) каталог субагентов. */
const SOURCES: { name: string; file: string; subagents?: string }[] = [
  { name: 'plain', file: 'plain.jsonl' },
  { name: 'compact', file: 'compact.jsonl' },
  { name: 'parallel', file: 'parallel.jsonl' },
  { name: 'sidechain', file: 'sidechain.jsonl' },
  { name: 'version-old', file: 'version-old.jsonl' },
  {
    name: 'agents-parallel',
    file: 'agents-parallel.transcript.ndjson',
    subagents: 'agents-parallel.subagents',
  },
  { name: 'image-basic', file: 'image-basic.transcript.ndjson' },
  { name: 'attach-basic', file: 'attach-basic.transcript.ndjson' },
];

/** Копия фикстуры как сессия `<id>.jsonl` (+ `<id>/subagents/`) во временном каталоге. */
function session(src: (typeof SOURCES)[number]): string {
  const root = tmp();
  const path = join(root, 'sess.jsonl');
  copyFileSync(join(fixtures, src.file), path);
  if (src.subagents) {
    const sub = join(root, 'sess', 'subagents');
    mkdirSync(sub, { recursive: true });
    for (const f of readdirSync(join(fixtures, src.subagents))) {
      copyFileSync(join(fixtures, src.subagents, f), join(sub, f));
    }
  }
  return path;
}

describe('итоги с хвоста (FileTally) против полного разбора Agentmeter', () => {
  for (const src of SOURCES) {
    it(`${src.name}: те же токены, цена, ходы, контекст и модель`, async () => {
      const path = session(src);
      const expected = transcriptTotals(path);
      const got = await new TranscriptCache().get(path);
      expect(got).toEqual(expected);
      if (src.subagents) expect(expected.tokens.output).toBeGreaterThan(0);
    });
  }

  it('дописывание кусками (в том числе посреди строки): после каждого куска итоги как у полного разбора', async () => {
    const root = tmp();
    const path = join(root, 's.jsonl');
    const full = readFileSync(join(fixtures, 'agents-parallel.transcript.ndjson'));
    writeFileSync(path, '');
    const cache = new TranscriptCache();
    // куски разного размера, границы попадают и внутрь строк
    const sizes = [1, 700, 5000, 12345, 3, 40000];
    let at = 0;
    let i = 0;
    while (at < full.length) {
      const n = sizes[i++ % sizes.length]!;
      appendFileSync(path, full.subarray(at, at + n));
      at += n;
      const got = await cache.get(path);
      // полный разбор того же префикса: оборванная последняя строка не разбирается ни там, ни тут
      const prefix = full.subarray(0, at).toString('utf8');
      const complete = prefix.slice(0, prefix.lastIndexOf('\n') + 1);
      const ref = join(root, 'ref.jsonl');
      writeFileSync(ref, complete);
      expect(got?.turns).toBe(countTurns(ref));
      expect(got?.tokens).toEqual(transcriptTotals(ref).tokens);
    }
    expect(await cache.get(path)).toEqual(transcriptTotals(path));
  });

  it('файл переписан короче или под тем же размером — считается заново', async () => {
    const root = tmp();
    const path = join(root, 's.jsonl');
    const a = readFileSync(join(fixtures, 'plain.jsonl'), 'utf8');
    const b = readFileSync(join(fixtures, 'compact.jsonl'), 'utf8');
    writeFileSync(path, a);
    const cache = new TranscriptCache();
    expect(await cache.get(path)).toEqual(transcriptTotals(path));
    writeFileSync(path, b.slice(0, 2000).slice(0, b.slice(0, 2000).lastIndexOf('\n') + 1));
    expect(await cache.get(path)).toEqual(transcriptTotals(path));
    // тот же размер, другое содержимое: последний байт перед смещением другой
    const tally = new FileTally();
    writeFileSync(path, '{"type":"user","message":{"content":"раз"}}\n');
    await tally.advance(path);
    expect(tally.turns).toBe(1);
    writeFileSync(path, '{"type":"user","message":{"content":"два"}}x');
    await tally.advance(path);
    // хвост без `\n` — целый JSON? нет («x» в конце) — не ход; главное, старый ход не остался
    expect(tally.turns).toBe(0);
  });

  it('хвост без перевода строки: целый JSON разбирается, оборванный — ждёт следующего прохода', async () => {
    const root = tmp();
    const path = join(root, 's.jsonl');
    const line = JSON.stringify({ type: 'user', message: { content: 'вопрос' } });
    writeFileSync(path, line.slice(0, 10));
    const tally = new FileTally();
    await tally.advance(path);
    expect(tally.turns).toBe(0);
    expect(tally.offset).toBe(0);
    appendFileSync(path, line.slice(10));
    await tally.advance(path);
    expect(tally.turns).toBe(1);
    appendFileSync(path, `\n${line}\n`);
    await tally.advance(path);
    expect(tally.turns).toBe(2);
  });
});

describe('streamLines', () => {
  it('строки длиннее куска чтения склеиваются, \\r\\n снимается, смещение — после последней целой', async () => {
    const root = tmp();
    const path = join(root, 'x.jsonl');
    const long = 'a'.repeat(3 * 1024 * 1024 + 17);
    writeFileSync(path, `один\r\n${long}\nдва\nоборв`);
    const lines: string[] = [];
    const r = await streamLines(path, (l) => lines.push(l));
    expect(lines).toEqual(['один', long, 'два']);
    expect(r.offset).toBe(Buffer.byteLength(`один\r\n${long}\nдва\n`));
    const rest: string[] = [];
    await streamLines(path, (l) => rest.push(l), { start: r.offset, acceptTail: () => true });
    expect(rest).toEqual(['оборв']);
  });

  it('многобайтовый символ на границе куска в 1 МБ не бьётся', async () => {
    const root = tmp();
    const path = join(root, 'x.jsonl');
    // «ж» — 2 байта: первый байт последний в первом куске, второй — первый во втором
    const pad = 'a'.repeat(1024 * 1024 - 1);
    const line = `${pad}жё😀`;
    writeFileSync(path, `${line}\nхвост\n`);
    const lines: string[] = [];
    await streamLines(path, (l) => lines.push(l));
    expect(lines).toEqual([line, 'хвост']);
  });
});

describe('TranscriptCache: гонки и замена файла', () => {
  it('параллельные get() одного файла не разбирают хвост дважды', async () => {
    const root = tmp();
    const path = join(root, 's.jsonl');
    const turn = (t: string) => `${JSON.stringify({ type: 'user', message: { content: t } })}\n`;
    writeFileSync(path, turn('раз'));
    const cache = new TranscriptCache();
    expect((await cache.get(path))?.turns).toBe(1);
    appendFileSync(path, turn('два') + turn('три'));
    const all = await Promise.all([cache.get(path), cache.get(path), cache.get(path)]);
    expect(all.map((x) => x?.turns)).toEqual([3, 3, 3]);
    expect((await cache.get(path))?.turns).toBe(3);
  });

  it('файл заменён другим (новый inode) и он длиннее — считается заново, а не с хвоста', async () => {
    const root = tmp();
    const path = join(root, 's.jsonl');
    const turn = (t: string) => `${JSON.stringify({ type: 'user', message: { content: t } })}\n`;
    writeFileSync(path, turn('раз') + turn('два'));
    const tally = new FileTally();
    await tally.advance(path);
    expect(tally.turns).toBe(2);
    const next = join(root, 'next.jsonl');
    writeFileSync(next, turn('один-длиннее') + turn('x') + turn('y'));
    rmSync(path);
    copyFileSync(next, path);
    await tally.advance(path);
    expect(tally.turns).toBe(3);
  });
});
