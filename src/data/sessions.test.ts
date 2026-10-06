import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../agent/types';
import {
  countTurns,
  listSessionRows,
  LiveSessions,
  projectDir,
  projectDirName,
  toSummary,
  transcriptTotals,
} from './sessions';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'claude');

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = () => (dir = mkdtempSync(join(tmpdir(), 'agentura-sessions-')));

/** Строки транскрипта: запрос ассистента и записи пользователя разных видов. */
const assistant = (requestId: string, model: string, usage: Record<string, unknown>, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    requestId,
    uuid: requestId,
    timestamp: '2026-09-30T10:00:00.000Z',
    sessionId: 's',
    cwd: '/p',
    message: {
      id: `msg_${requestId}`,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage,
    },
    ...extra,
  });
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-09-30T10:00:00.000Z',
    sessionId: 's',
    cwd: '/p',
    message: { role: 'user', content },
    ...extra,
  });

describe('итоги сессии по транскрипту', () => {
  it('plain: токены как у эталона Agentmeter, 2 хода, стоимость по таблице (Opus 5, кэш 1 ч)', () => {
    const totals = transcriptTotals(join(fixtures, 'plain.jsonl'));
    expect(totals.tokens).toMatchObject({
      input: 19,
      output: 3125,
      cacheWrite: 27073,
      cacheRead: 464594,
    });
    expect(totals.turns).toBe(2);
    expect(totals.model).toBe('claude-opus-5');
    // $5 ввод, $25 вывод, $0.50 чтение, $10 запись 1 ч за MTok. Восстановленный Agentmeter запрос
    // (прогрев, 172 токена записи) разбивки по TTL не имеет — по 5-минутной цене $6.25.
    expect(totals.costUsd).toBeCloseTo(
      (19 * 5 + 3125 * 25 + 464594 * 0.5 + (27073 - 172) * 10 + 172 * 6.25) / 1e6,
      9,
    );
    expect(totals.costPartial).toBeUndefined();
  });

  it('служебные записи ходами не считаются', () => {
    const file = join(tmp(), 't.jsonl');
    writeFileSync(
      file,
      [
        user('первый вопрос'),
        user([{ type: 'text', text: 'второй вопрос' }]),
        user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]),
        user('<command-name>/model</command-name>'),
        user('<local-command-stdout>Set model</local-command-stdout>'),
        user('This session is being continued…', { isCompactSummary: true }),
        user('Caveat: служебное', { isMeta: true }),
        user([{ type: 'text', text: '[Request interrupted by user]' }]),
        user('ход сабагента', { isSidechain: true }),
      ].join('\n') + '\n',
    );
    expect(countTurns(file)).toBe(2);
  });

  it('ход из одной картинки или одного файла без текста — тоже ход (этапы 4 и 8 roadmap 0.2)', () => {
    const file = join(tmp(), 'd.jsonl');
    writeFileSync(
      file,
      [
        user([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ]),
        user([{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }]),
      ].join('\n') + '\n',
    );
    expect(countTurns(file)).toBe(2);
  });

  it('модель без цены: сумма по известным + costPartial; все без цены — стоимости нет, не $0', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const mixed = join(tmp(), 'mixed.jsonl');
    writeFileSync(
      mixed,
      [
        user('q'),
        assistant('r1', 'claude-sonnet-5-5', usage),
        assistant('r2', 'gpt-x', usage),
      ].join('\n') + '\n',
    );
    expect(transcriptTotals(mixed)).toMatchObject({ costUsd: 2, costPartial: true });

    const unknown = join(dir!, 'unknown.jsonl');
    writeFileSync(unknown, [user('q'), assistant('r1', 'gpt-x', usage)].join('\n') + '\n');
    const t = transcriptTotals(unknown);
    expect(t.costUsd).toBeUndefined();
    expect(t.costPartial).toBe(true);
  });

  it('inference_geo "us" и веб-поиск из транскрипта входят в стоимость', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      inference_geo: 'us',
      server_tool_use: { web_search_requests: 2 },
    };
    const file = join(tmp(), 'geo.jsonl');
    writeFileSync(file, [user('q'), assistant('r1', 'claude-sonnet-5-5', usage)].join('\n') + '\n');
    expect(transcriptTotals(file).costUsd).toBeCloseTo(2 * 1.1 + 0.02, 10);
  });

  it('имя каталога проекта как у CLI: замена символов, длинные пути — обрезка и хэш', () => {
    expect(projectDir('/Users/fost/Projects/Agentura', '/h')).toBe(
      '/h/projects/-Users-fost-Projects-Agentura',
    );
    expect(projectDirName('/a/.claude/wt_1')).toBe('-a--claude-wt-1');
    const long = '/' + 'x'.repeat(250);
    // Хэш CLI: h = (h << 5) - h + code | 0 по исходному пути, Math.abs, основание 36.
    let h = 0;
    for (const ch of long) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
    expect(projectDirName(long)).toBe(`-${'x'.repeat(199)}-${Math.abs(h).toString(36)}`);
    expect(projectDirName(long).length).toBeLessThan(215);
  });
});

describe('listSessionRows', () => {
  it('итоги по cwd самой сессии (worktree), статус и стоимость живой; без цены — без costUsd в строке', async () => {
    const home = tmp();
    const worktree = '/proj/a/.claude/worktrees/wt';
    mkdirSync(projectDir(worktree, home), { recursive: true });
    copyFileSync(join(fixtures, 'plain.jsonl'), join(projectDir(worktree, home), 'plain-id.jsonl'));

    const adapter = {
      listSessions: async () => [
        { id: 'plain-id', title: 'Из worktree', updatedAt: 2, cwd: worktree },
        { id: 'missing', title: 'Без файла', updatedAt: 1 },
      ],
    } as unknown as AgentAdapter;
    const live = new LiveSessions();
    live.set('missing', 'waiting', 0.5);

    const rows = await listSessionRows(adapter, { cwd: '/proj/a', live, claudeHome: home });
    expect(rows[0]).toMatchObject({
      id: 'plain-id',
      state: 'idle',
      turns: 2,
      costSource: 'pricing',
    });
    expect(rows[0]!.tokens.output).toBe(3125);
    expect(rows[1]).toMatchObject({
      id: 'missing',
      state: 'waiting',
      turns: 0,
      costUsd: 0.5,
      costSource: 'engine',
    });
    expect(toSummary(rows[1]!)).toEqual({
      id: 'missing',
      title: 'Без файла',
      turns: 0,
      costUsd: 0.5,
      state: 'waiting',
      updatedAt: 1,
    });
    live.delete('missing');
    const again = await listSessionRows(adapter, { cwd: '/proj/a', live, claudeHome: home });
    expect(toSummary(again[1]!)).not.toHaveProperty('costUsd');
  });
});

describe('Codex в списке', () => {
  it('toSummary: provider только у Codex, у Claude поля нет', () => {
    const base = { id: 'x', title: 't', updatedAt: 1, state: 'idle' as const, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    expect(toSummary({ ...base, provider: 'codex' })).toMatchObject({ provider: 'codex' });
    expect(toSummary(base)).not.toHaveProperty('provider');
    expect(toSummary({ ...base, provider: 'claude' })).not.toHaveProperty('provider');
  });

  it('LiveSessions.codexEpoch растёт от новой Codex-сессии, конца её хода и закрытия — не от статуса и цены', () => {
    const live = new LiveSessions();
    live.set('c', 'live');
    expect(live.codexEpoch).toBe(0);
    live.set('x', 'live', undefined, 'codex');
    expect(live.codexEpoch).toBe(1);
    live.set('x', 'live', undefined, 'codex');
    live.set('x', 'waiting', undefined, 'codex');
    live.set('x', 'live', 0.5, 'codex');
    expect(live.codexEpoch).toBe(1);
    live.set('x', 'idle');
    expect(live.codexEpoch).toBe(2);
    live.delete('x');
    expect(live.codexEpoch).toBe(3);
    live.delete('c');
    expect(live.codexEpoch).toBe(3);
  });
});
