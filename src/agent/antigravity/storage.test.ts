import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editResultOf } from './edits';
import { findEditDetail, readEditDetail, readTranscriptFull, transcriptFullPath } from './storage';

const ID = '00000000-0000-4000-8000-000000000001';
const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/antigravity/${name}`, import.meta.url), 'utf8');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agy-storage-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function put(content: string, id = ID): Promise<void> {
  const dir = join(root, 'brain', id, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'transcript_full.jsonl'), content);
}

describe('storage: transcript_full', () => {
  it('читает шаги; нет файла, мусорный id и оборванная строка — мягко', async () => {
    expect(await readTranscriptFull(root, ID)).toEqual([]);
    expect(transcriptFullPath(root, '../../etc')).toBeUndefined();
    expect(await readTranscriptFull(root, '../x')).toEqual([]);
    await put(`${fixture('transcript_full.jsonl')}{"step_index":9,"ty`);
    const steps = await readTranscriptFull(root, ID);
    expect(steps.map((s) => s.step_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(steps[3]?.tool_calls?.[0]?.name).toBe('replace_file_content');
  });

  it('findEditDetail: вызов в предыдущем PLANNER_RESPONSE, результат — в GENERIC с тем же индексом, что шаг tool', async () => {
    await put(fixture('transcript_full.jsonl'));
    const steps = await readTranscriptFull(root, ID);
    const found = findEditDetail(steps, 4, 'replace_file_content', '/tmp/agentura-agy/hello.txt');
    expect(found?.args).toMatchObject({ TargetContent: 'hi', ReplacementContent: 'hello world' });
    expect(found?.resultText).toContain('[diff_block_start]');
    // результат шага N — про другой файл (рассинхрон нумерации): не наш шаг
    expect(findEditDetail(steps, 4, 'replace_file_content', '/other')).toBeUndefined();
    // вызов в ближайшем planner-шаге — другой инструмент: аргументов нет, остаются ханки
    expect(findEditDetail(steps, 4, 'write_to_file', '/tmp/agentura-agy/hello.txt')?.args).toEqual({});
    // шага ещё нет в транскрипте
    expect(findEditDetail(steps, 40, 'replace_file_content', undefined)).toBeUndefined();
  });

  it('findEditDetail не берёт аргументы прежней правки того же файла и различает вызовы одного шага', () => {
    const steps = [
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'replace_file_content', args: { TargetFile: '/a/x.txt', TargetContent: 'old1' } }] },
      { step_index: 2, type: 'GENERIC', content: 'changes to: /a/x.txt' },
      { step_index: 3, type: 'PLANNER_RESPONSE', tool_calls: [
        { name: 'replace_file_content', args: { TargetFile: '/a/x.txt', TargetContent: 'p1' } },
        { name: 'replace_file_content', args: { TargetFile: '/a/x.txt', TargetContent: 'p2' } },
      ] },
      { step_index: 4, type: 'GENERIC', content: 'changes to: /a/x.txt' },
      { step_index: 5, type: 'GENERIC', content: 'changes to: /a/x.txt' },
      { step_index: 6, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/a/x.txt' } }] },
      { step_index: 7, type: 'GENERIC', content: 'viewed /a/x.txt' },
      { step_index: 8, type: 'GENERIC', content: 'changes to: /a/x.txt' },
    ];
    expect(findEditDetail(steps, 4, 'replace_file_content', '/a/x.txt')?.args['TargetContent']).toBe('p1');
    expect(findEditDetail(steps, 5, 'replace_file_content', '/a/x.txt')?.args['TargetContent']).toBe('p2');
    // ближайший planner — view_file: старую правку 1 не подхватываем
    expect(findEditDetail(steps, 8, 'replace_file_content', '/a/x.txt')?.args).toEqual({});
  });

  it('не обычный файл (папка/FIFO на месте транскрипта) — пусто, без зависания', async () => {
    await mkdir(join(root, 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl'), { recursive: true });
    expect(await readTranscriptFull(root, ID)).toEqual([]);
  });

  it('readEditDetail читает хвост: окно меньше файла — вызов всё равно находится (окно расширяется)', async () => {
    const pad = Array.from({ length: 200 }, (_, i) => JSON.stringify({ step_index: -1000 + i, type: 'GENERIC', content: 'x'.repeat(100) })).join('\n');
    await put(`${pad}\n${fixture('transcript_full.jsonl')}`);
    const found = await readEditDetail(root, ID, 4, 'replace_file_content', '/tmp/agentura-agy/hello.txt', { retries: 0, windowBytes: 200 });
    expect(found?.args).toMatchObject({ TargetContent: 'hi', ReplacementContent: 'hello world' });
  });

  it('readEditDetail ждёт, пока agy допишет транскрипт', async () => {
    const pending = readEditDetail(root, ID, 4, 'replace_file_content', undefined, { retries: 5, delayMs: 20 });
    setTimeout(() => void put(fixture('transcript_full.jsonl')), 30);
    expect((await pending)?.resultText).toContain('hello world');
  });
});

describe('editResultOf', () => {
  const lookup = (stepIndex: number, agyName: string, cardName: string) => ({
    root,
    conversationId: ID,
    stepIndex,
    agyName,
    cardName,
    targetFile: '/tmp/agentura-agy/hello.txt',
  });
  const fast = { retries: 0 };

  it('Edit: filePath, oldString/newString и structuredPatch', async () => {
    await put(fixture('transcript_full.jsonl'));
    expect(await editResultOf(lookup(4, 'replace_file_content', 'Edit'), fast)).toEqual({
      filePath: '/tmp/agentura-agy/hello.txt',
      oldString: 'hi',
      newString: 'hello world',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-hi', '+hello world', ' '] }],
    });
  });

  it('многострочная правка', async () => {
    await put(fixture('transcript_full_multiline.jsonl'));
    const r = await editResultOf({ ...lookup(4, 'replace_file_content', 'Edit'), targetFile: '/tmp/agentura-agy/a.txt' }, fast);
    expect(r).toMatchObject({ oldString: 'beta needle\ngamma', newString: 'BETA needle\ndelta' });
    expect((r?.['structuredPatch'] as { lines: string[] }[])[0]?.lines).toContain('+delta');
  });

  it('Write нового файла: content без diff-а, type create', async () => {
    await put(fixture('transcript_full.jsonl'));
    expect(await editResultOf(lookup(2, 'write_to_file', 'Write'), fast)).toEqual({
      filePath: '/tmp/agentura-agy/hello.txt',
      content: 'hi',
      type: 'create',
    });
  });

  it('Write без «Created file» (перезапись) — type update, не новый файл', async () => {
    await put(fixture('transcript_full.jsonl').replace('Created file file:///tmp/agentura-agy/hello.txt', 'Wrote file:///tmp/agentura-agy/hello.txt'));
    expect(await editResultOf(lookup(2, 'write_to_file', 'Write'), fast)).toMatchObject({ type: 'update' });
  });

  it('нет транскрипта или шага — undefined (карточка без диффа)', async () => {
    expect(await editResultOf(lookup(4, 'replace_file_content', 'Edit'), fast)).toBeUndefined();
    await put(fixture('transcript_full.jsonl'));
    expect(await editResultOf(lookup(99, 'replace_file_content', 'Edit'), fast)).toBeUndefined();
  });
});
