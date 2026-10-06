import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from './adapter';
import { fakeSpawn } from './fakeAgy';
import { AgySessionIndex, memoryStore } from './sessionIndex';
import { parseSummaryTime, readConversationSummaries } from './storage';

const sqlite = await import('node:sqlite').catch(() => undefined);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const SCHEMA =
  'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0, raw_summary BLOB, PRIMARY KEY (`conversation_id`))';

let root: string;
let work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agy-sessions-'));
  work = join(root, 'work');
  mkdirSync(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeDb(rows: Record<string, unknown>[]): void {
  const db = new sqlite!.DatabaseSync(join(root, 'conversation_summaries.db'));
  db.exec(SCHEMA);
  const insert = db.prepare(
    'INSERT INTO conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,parent_conversation_id) VALUES (?,?,?,?,?,?,?)',
  );
  for (const r of rows)
    insert.run(r['id'] as string, (r['title'] as string) ?? '', (r['preview'] as string) ?? '', (r['steps'] as number) ?? 2, (r['at'] as string) ?? '2026-10-06 07:51:39.002729+00:00', JSON.stringify(r['ws'] ?? []), (r['parent'] as string) ?? '');
  db.close();
}

function adapter(state = memoryStore()) {
  return new AntigravityAdapter({ executablePath: '/bin/agy', agyRoot: root, spawn: fakeSpawn().spawn, listProcesses: async () => [], killPid: () => undefined, state });
}

describe('parseSummaryTime', () => {
  it('микросекунды и пробел вместо T', () => {
    expect(parseSummaryTime('2026-10-06 07:51:39.002729+00:00')).toBe(Date.UTC(2026, 9, 6, 7, 51, 39, 2));
    expect(parseSummaryTime('мусор')).toBeUndefined();
    expect(parseSummaryTime(5)).toBeUndefined();
  });
});

describe.skipIf(!sqlite)('conversation_summaries.db через node:sqlite', () => {
  const uri = (p: string) => `file://${p}`;

  it('listSessions: беседы этой папки, без чужих, подбесед и пустых; заголовок — title, иначе preview без обёртки', async () => {
    makeDb([
      { id: A, title: 'Свой заголовок', preview: 'запрос А', ws: [uri(work)], at: '2026-10-06 07:00:00+00:00' },
      { id: B, preview: '<USER_REQUEST>\nвторой\nзапрос\n</USER_REQUEST>', ws: [uri(work), uri('/elsewhere')], at: '2026-10-06 08:00:00+00:00' },
      { id: C, preview: 'чужая', ws: [uri('/elsewhere')] },
      { id: '00000000-0000-4000-8000-00000000000d', preview: 'суб', ws: [uri(work)], parent: A },
      { id: '00000000-0000-4000-8000-00000000000e', preview: 'пустая', ws: [uri(work)], steps: 0 },
    ]);
    const list = await adapter().listSessions(work);
    expect(list.map((s) => [s.id, s.title, s.firstPrompt])).toEqual([
      [B, 'второй запрос', 'второй запрос'],
      [A, 'Свой заголовок', 'запрос А'],
    ]);
    expect(list[0]).toMatchObject({ cwd: work, updatedAt: Date.UTC(2026, 9, 6, 8) });
  });

  it('читает копию: оригинал не меняется, временная папка убирается', async () => {
    makeDb([{ id: A, preview: 'x', ws: [uri(work)] }]);
    const path = join(root, 'conversation_summaries.db');
    const before = readFileSync(path);
    const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('agentura-agy-')).sort();
    const tmpBefore = leftovers();
    expect(await readConversationSummaries(root)).toHaveLength(1);
    expect(readFileSync(path).equals(before)).toBe(true);
    // и при ошибке чтения копия не остаётся; отдаётся прошлый список (копия могла попасть на checkpoint agy)
    writeFileSync(path, 'not a database');
    expect((await readConversationSummaries(root))?.map((r) => r.id)).toEqual([A]);
    expect(leftovers()).toEqual(tmpBefore);
    rmSync(path);
    expect(await readConversationSummaries(root)).toBeUndefined();
  });

  it('повторный список без изменений базы — из кэша (копии независимы); база изменилась — перечитывается', async () => {
    makeDb([{ id: A, preview: 'x', ws: [uri(work)] }]);
    const first = await readConversationSummaries(root);
    first![0]!.workspaces.push('/mutated');
    expect((await readConversationSummaries(root))?.[0]?.workspaces).toEqual([work]);
    const db = new sqlite!.DatabaseSync(join(root, 'conversation_summaries.db'));
    db.exec("INSERT INTO conversation_summaries (conversation_id,preview,step_count,last_modified_time,workspace_uris) VALUES ('n1','новая',3,'2026-10-06 09:00:00+00:00','[]')");
    db.close();
    expect((await readConversationSummaries(root))?.map((r) => r.id).sort()).toEqual([A, 'n1'].sort());
  });

  it('другая схема или битый файл — undefined, без исключения', async () => {
    writeFileSync(join(root, 'conversation_summaries.db'), 'not a database');
    const warns: string[] = [];
    expect(await readConversationSummaries(root, (_l, m) => warns.push(m))).toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
    rmSync(join(root, 'conversation_summaries.db'));
    expect(await readConversationSummaries(root)).toBeUndefined();
  });

  it('читает и незакоммиченный WAL рядом с базой', async () => {
    makeDb([{ id: A, preview: 'x', ws: [uri(work)] }]);
    const src = join(root, 'conversation_summaries.db');
    // база в режиме WAL с несброшенной записью: копия обязана взять -wal
    const live = new sqlite!.DatabaseSync(src);
    live.exec('PRAGMA journal_mode=WAL');
    live.exec("INSERT INTO conversation_summaries (conversation_id,preview,step_count,last_modified_time,workspace_uris) VALUES ('w1','из wal',3,'2026-10-06 09:00:00+00:00','[]')");
    // пока соединение открыто, -wal содержит запись
    const snap = mkdtempSync(join(tmpdir(), 'agy-wal-'));
    copyFileSync(src, join(snap, 'conversation_summaries.db'));
    copyFileSync(`${src}-wal`, join(snap, 'conversation_summaries.db-wal'));
    live.close();
    const list = await readConversationSummaries(snap);
    rmSync(snap, { recursive: true, force: true });
    expect(list?.map((r) => r.id).sort()).toEqual([A, 'w1'].sort());
  });
});

describe('listSessions: запасной путь без базы и свои имена', () => {
  it('без базы — беседы из индекса Agentura для этой папки; rename меняет заголовок, пустое имя снимает', async () => {
    const state = memoryStore();
    const index = new AgySessionIndex(state);
    await index.note({ id: A, cwd: work, at: 1000, firstPrompt: '  первое\nсообщение ' });
    await index.note({ id: A, cwd: work, at: 2000, firstPrompt: 'не перезаписывает' });
    await index.note({ id: B, cwd: '/elsewhere', at: 3000, firstPrompt: 'чужая' });
    const a = adapter(state);
    const list = await a.listSessions(work);
    expect(list).toEqual([{ id: A, title: 'первое сообщение', firstPrompt: 'первое сообщение', cwd: work, createdAt: 1000, updatedAt: 2000 }]);
    await a.renameSession(A, '  Моё   имя ');
    expect((await a.listSessions(work))[0]?.title).toBe('Моё имя');
    await a.renameSession(A, '  ');
    expect((await a.listSessions(work))[0]?.title).toBe('первое сообщение');
  });

  it('сессия, созданная адаптером, попадает в индекс (id из init, первое сообщение)', async () => {
    const state = memoryStore();
    const a = adapter(state);
    const session = await a.createSession({ cwd: work });
    session.send('привет, agy');
    await new Promise((r) => setTimeout(r, 50));
    const list = await a.listSessions(work);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: session.id, title: 'привет, agy' });
    session.dispose();
  });

  it('открытая, но пустая вкладка в индекс не попадает; после первого сообщения — попадает', async () => {
    const state = memoryStore();
    const a = adapter(state);
    const session = await a.createSession({ cwd: work });
    await new Promise((r) => setTimeout(r, 50));
    expect(session.id).not.toBe('');
    expect(await a.listSessions(work)).toEqual([]);
    session.send('позже');
    await new Promise((r) => setTimeout(r, 20));
    expect((await a.listSessions(work)).map((s) => s.title)).toEqual(['позже']);
    session.dispose();
  });

  it('битые значения в globalState не роняют список', async () => {
    const state = memoryStore();
    await state.update('agentura.antigravity.sessions', { [A]: { id: A, cwd: work, createdAt: 1, updatedAt: 2 }, x: null, y: { id: 'y' }, z: 'str' });
    await state.update('agentura.antigravity.names', { [A]: 42, constructor: 'x' });
    const list = await adapter(state).listSessions(work);
    expect(list).toEqual([{ id: A, title: A, cwd: work, createdAt: 1, updatedAt: 2 }]);
    await state.update('agentura.antigravity.sessions', ['not', 'an', 'object']);
    expect(await adapter(state).listSessions(work)).toEqual([]);
  });

  it('индекс ограничен: старые записи вытесняются', async () => {
    const index = new AgySessionIndex();
    for (let i = 0; i < 505; i++) await index.note({ id: `id-${i}`, cwd: '/w', at: i });
    expect(index.entries()).toHaveLength(500);
    expect(index.entries().some((e) => e.id === 'id-0')).toBe(false);
  });
});

describe('loadHistory: из хранилища', () => {
  it('читает transcript_full.jsonl беседы; нет файла или мусорный id — пустая история', async () => {
    const dir = join(root, 'brain', A, '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    copyFileSync(new URL('../../../test/fixtures/antigravity/transcript_full.jsonl', import.meta.url), join(dir, 'transcript_full.jsonl'));
    const a = adapter();
    const history = await a.loadHistory(A, work);
    expect(history.turns).toBe(1);
    expect(history.events[0]).toMatchObject({ type: 'turn.start' });
    expect(await a.loadHistory(B, work)).toEqual({ events: [], turns: 0, skippedTurns: 0 });
    expect(await a.loadHistory('../x', work)).toEqual({ events: [], turns: 0, skippedTurns: 0 });
  });
});
