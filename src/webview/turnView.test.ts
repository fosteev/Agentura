import { describe, expect, it } from 'vitest';
import type { FeedRow } from './chatState';
import { feedItems } from './agentsView';
import { feedTurns, foldSummary, MAX_STRIP, stepRows, type Turn } from './turnView';

let n = 0;
const id = () => ++n;
const user = (text = 'q', extra: object = {}): FeedRow => ({ id: id(), kind: 'user', text, ...extra });
const text = (t = 'a'): FeedRow => ({ id: id(), kind: 'text', messageId: 'm', text: t, streaming: false });
const sys = (): FeedRow => ({ id: id(), kind: 'sys', text: ['s'] });
const sum = (): FeedRow => ({ id: id(), kind: 'sum', parts: ['in 1'], time: '1.0s' });
const tool = (name: string, input: Record<string, unknown> = {}, extra: object = {}): FeedRow => ({
  id: id(),
  kind: 'tool',
  toolUseId: `t${n}`,
  name,
  input,
  startedAt: 0,
  state: 'ok',
  durationMs: 100,
  ...extra,
});
const think = (ms: number): FeedRow => ({
  id: id(),
  kind: 'think',
  messageId: 'm',
  text: 'x',
  startedAt: 0,
  endedAt: ms,
});

const shape = (rows: FeedRow[]) =>
  feedTurns(feedItems(rows)).map((b) =>
    b.kind === 'loose'
      ? `loose:${b.item.kind}`
      : `turn[${b.user ? 'u' : '-'}|${b.parts
          .map((p) => (p.kind === 'steps' ? `steps${p.items.length}` : p.item.kind))
          .join(',')}|${b.sum ? 'sum' : 'open'}]`,
  );

describe('feedTurns', () => {
  it('обычные ходы: user открывает, sum закрывает', () => {
    const rows = [user(), tool('Read'), text(), sum(), user(), text(), sum()];
    expect(shape(rows)).toEqual(['turn[u|steps1,text|sum]', 'turn[u|text|sum]']);
  });

  it('серии tool/think/agents — отдельные .steps, текст между ними разрывает серию', () => {
    const rows = [user(), think(1), tool('Read'), text(), tool('Bash'), sum()];
    expect(shape(rows)).toEqual(['turn[u|steps2,text,steps1|sum]']);
  });

  it('группа агентов — часть серии steps', () => {
    const rows = [user(), tool('Agent'), tool('Agent'), sum()];
    const [t] = feedTurns(feedItems(rows)) as Turn[];
    expect(t!.parts).toHaveLength(1);
    const p = t!.parts[0]!;
    expect(stepRows(p.kind === 'steps' ? p.items : [])).toHaveLength(2);
  });

  it('строки до первого user и sys между ходами — вне контейнеров', () => {
    const rows = [sys(), text(), user(), text(), sum(), sys(), user(), sum()];
    expect(shape(rows)).toEqual([
      'loose:sys',
      'loose:text',
      'turn[u|text|sum]',
      'loose:sys',
      'turn[u||sum]',
    ]);
  });

  it('sys внутри открытого хода остаётся в нём', () => {
    expect(shape([user(), sys(), text()])).toEqual(['turn[u|sys,text|open]']);
  });

  it('открытый последний ход — без sum', () => {
    expect(shape([user(), sum(), user(), tool('Bash')])).toEqual([
      'turn[u||sum]',
      'turn[u|steps1|open]',
    ]);
  });

  it('ход без user (пробуждение): не-sys строка после закрытого хода открывает безымянный', () => {
    const rows = [user(), sum(), tool('Bash'), text(), sum()];
    expect(shape(rows)).toEqual(['turn[u||sum]', 'turn[-|steps1,text|sum]']);
  });

  it('«в очереди» посреди идущего хода остаётся в нём; после закрытого — новый ход', () => {
    expect(shape([user(), tool('Bash'), user('next', { queued: true }), sum()])).toEqual([
      'turn[u|steps1,user|sum]',
    ]);
    expect(shape([user(), sum(), user('next', { queued: true })])).toEqual([
      'turn[u||sum]',
      'turn[u||open]',
    ]);
  });

  it('ход оборван ошибкой без итога: ошибка закрывает ход, следующее не склеивается', () => {
    const failSys = (): FeedRow => ({ id: id(), kind: 'sys', tone: 'bad', tag: 'fail', text: ['x'] });
    const failCard = (): FeedRow => ({
      id: id(),
      kind: 'fail',
      fatal: true,
      message: 'x',
      at: '12:00',
      turn: true,
      state: 'open',
    });
    expect(shape([user(), tool('Bash'), failSys(), user('next', { queued: true })])).toEqual([
      'turn[u|steps1,sys|open]',
      'turn[u||open]',
    ]);
    expect(shape([user(), tool('Bash'), failCard(), tool('Read'), sys()])).toEqual([
      'turn[u|steps1,fail|open]',
      'turn[-|steps1,sys|open]',
    ]);
  });

  it('id хода — id строки user (у безымянного — первой строки)', () => {
    const u = user();
    const w = tool('Bash');
    const blocks = feedTurns(feedItems([u, sum(), w])) as Turn[];
    expect(blocks.map((b) => b.id)).toEqual([u.id, w.id]);
  });
});

describe('foldSummary', () => {
  const steps = (rows: FeedRow[]) => stepRows(feedItems(rows));

  it('считает tool + think, агенты — по числу агентов', () => {
    const f = foldSummary(steps([think(1000), tool('Read'), tool('Agent'), tool('Agent')]));
    expect(f.count).toBe(4);
  });

  it('op по порядку первого появления, ×k при повторах', () => {
    const f = foldSummary(
      steps([tool('Read'), tool('Grep'), tool('Read'), tool('Read'), tool('Glob')]),
    );
    expect(f.ops.map((o) => [o.op, o.times])).toEqual([
      ['read', 3],
      ['grep', 1],
      ['glob', 1],
    ]);
  });

  it('edit/write — сумма +a −d', () => {
    const f = foldSummary(
      steps([
        tool('Edit', { old_string: 'a', new_string: 'b\nc' }),
        tool('Edit', { old_string: 'a\nb', new_string: 'c' }),
      ]),
    );
    expect(f.ops).toEqual([{ op: 'edit', times: 2, add: 3, del: 3 }]);
  });

  it('bash — результат последнего запуска; ошибка помечена', () => {
    const ok = foldSummary(
      steps([tool('Bash', {}, { durationMs: 500 }), tool('Bash', {}, { durationMs: 12_000 })]),
    );
    expect(ok.ops[0]).toMatchObject({ op: 'bash', times: 2, result: '12s' });
    const bad = foldSummary(steps([tool('Bash', {}, { state: 'err', durationMs: 5 })]));
    expect(bad.ops[0]).toMatchObject({ result: 'ошибка', bad: true });
  });

  it('think — суммарное время; длительность — сумма durationMs', () => {
    const f = foldSummary(
      steps([
        think(12_000),
        tool('Read', {}, { durationMs: 300 }),
        tool('Bash', {}, { durationMs: 700 }),
      ]),
    );
    expect(f.thinkMs).toBe(12_000);
    expect(f.durationMs).toBe(13_000);
  });

  it('полоса: сегменты flex = durationMs, классы th/ed/rn/пусто', () => {
    const f = foldSummary(
      steps([
        think(120),
        tool('Read', {}, { durationMs: 4 }),
        tool('Edit', {}, { durationMs: 11 }),
        tool('Bash', {}, { durationMs: 98 }),
      ]),
    );
    expect(f.strip).toEqual([
      { cls: 'th', flex: 120 },
      { cls: '', flex: 4 },
      { cls: 'ed', flex: 11 },
      { cls: 'rn', flex: 98 },
    ]);
  });

  it(`полоса не длиннее ${MAX_STRIP} сегментов, счётчик — по всем`, () => {
    const rows = Array.from({ length: 55 }, () => tool('Read'));
    const f = foldSummary(steps(rows));
    expect(f.strip).toHaveLength(MAX_STRIP);
    expect(f.count).toBe(55);
  });
});
