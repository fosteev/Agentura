import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCursorHistory, sessionsFrom } from './history';

interface HistoryRow {
  dir: 'in' | 'out';
  scenario: string;
  msg: { method?: string; result?: unknown; params?: { update?: unknown } };
}

const raw = readFileSync(new URL('../../../test/fixtures/cursor/history.ndjson', import.meta.url), 'utf8');
const rows: HistoryRow[] = raw
  .trim()
  .split('\n')
  .filter((line) => line)
  .map((line) => JSON.parse(line) as HistoryRow);

const loadUpdates = rows
  .filter((row) => row.scenario === 'load' && row.dir === 'out' && row.msg.method === 'session/update')
  .map((row) => row.msg.params?.update);
const loadResult = rows.find((row) => row.scenario === 'load' && row.msg.result !== undefined)?.msg.result;
const listResult = rows.find((row) => row.scenario === 'list')?.msg.result;

const user = (text: string) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
const agent = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

describe('cursor history fixture', () => {
  it('файл без путей, почты и replay-id', () => {
    expect(raw).not.toMatch(/@/);
    expect(raw).not.toContain('replay-');
    expect(raw).not.toContain('<WORK>');
    expect(raw).not.toMatch(/\/(?:Users|var|home|tmp)\b/);
    expect(raw).not.toMatch(/[A-Za-z]:\\/);
  });

  it('session/list: только свой cwd, заголовок — id, чужой title не читается', () => {
    const at = Date.parse('2026-11-05T16:45:04.674Z');
    expect(sessionsFrom(listResult, 'cwd-a')).toEqual([
      { id: 'sess-pong', title: 'sess-pong', cwd: 'cwd-a', updatedAt: at, provider: 'cursor' },
    ]);
    expect(sessionsFrom(listResult, 'cwd-b').map((row) => row.id)).toEqual(['sess-other']);
    expect(
      sessionsFrom(
        {
          sessions: [
            { sessionId: 'sess-pong', cwd: 'cwd-a', updatedAt: '2026-11-05T16:45:04.674Z', title: 'secret' },
          ],
        },
        'cwd-a',
      )[0]?.title,
    ).toBe('sess-pong');
    expect(sessionsFrom({ sessions: [{ sessionId: 's', cwd: 'cwd-a', updatedAt: 'nope' }] }, 'cwd-a')[0]).toMatchObject({
      id: 's',
      updatedAt: 0,
    });
    expect(sessionsFrom(null, 'cwd-a')).toEqual([]);
    expect(sessionsFrom({}, 'cwd-a')).toEqual([]);
  });

  it('pong из фикстуры: turn.start, текст, turn.result; tool id из кадра, не replay', () => {
    const history = buildCursorHistory(loadUpdates, loadResult);
    expect(history.turns).toBe(2);
    expect(history.model).toBe('gpt-5.4-nano[reasoning=medium]');
    expect(history.mode).toBeUndefined();
    const text = history.events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e.type === 'text.delta' ? e.text : ''))
      .join('');
    expect(text).toBe('pongok');
    expect(text).not.toContain('wants');
    expect(history.events[0]).toMatchObject({ type: 'turn.start', prompt: 'Reply with exactly one word: pong.' });
    expect(history.events.find((e) => e.type === 'turn.result')).toMatchObject({
      type: 'turn.result',
      ok: true,
      subtype: 'end_turn',
      text: 'pong',
    });
    expect(history.events.find((e) => e.type === 'tool.result')).toMatchObject({
      toolUseId: 'tool_90fc4a4e-6e6d-46b2-83b5-3c3412526a7',
      isError: false,
      content: 'ok\n',
    });
    expect(JSON.stringify(history.events)).not.toContain('replay-');
    expect(JSON.stringify(history.events)).not.toContain('One Word Pong');
  });

  it('склеенный промпт — один ход; текст до первого промпта не лента; live не закрывает последний', () => {
    const joined = buildCursorHistory([user('pin'), user('g'), agent('ok')], {});
    expect(joined.turns).toBe(1);
    expect(joined.events[0]).toMatchObject({ type: 'turn.start', prompt: 'ping' });

    const dropped = buildCursorHistory([agent('orphan'), user('hi'), agent('yo')], {});
    expect(dropped.turns).toBe(1);
    expect(
      dropped.events
        .filter((e) => e.type === 'text.delta')
        .map((e) => (e.type === 'text.delta' ? e.text : ''))
        .join(''),
    ).toBe('yo');

    const live = buildCursorHistory([user('a'), agent('A'), user('b'), agent('B')], {}, { live: true });
    expect(live.events.filter((e) => e.type === 'turn.result')).toHaveLength(1);
    expect(live.events.at(-1)).toMatchObject({ type: 'text.delta', text: 'B' });

    const cut = buildCursorHistory(
      [user('one'), agent('1'), user('two'), agent('2'), user('three'), agent('3')],
      {},
      { maxTurns: 1 },
    );
    expect(cut.turns).toBe(3);
    expect(cut.skippedTurns).toBe(2);
    expect(cut.events[0]).toMatchObject({ type: 'turn.start', prompt: 'three' });
  });

  it('mode plan только из currentModeId plan; ask и agent режим не задают', () => {
    expect(buildCursorHistory([], { modes: { currentModeId: 'plan' }, models: { currentModelId: 'm' } })).toMatchObject(
      { mode: 'plan', model: 'm', turns: 0 },
    );
    expect(buildCursorHistory([], { modes: { currentModeId: 'ask' } }).mode).toBeUndefined();
    expect(buildCursorHistory([], { modes: { currentModeId: 'agent' } }).mode).toBeUndefined();
  });
});
