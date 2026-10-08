import { describe, expect, it } from 'vitest';
import { nextStatus, statusMarker, tabTitle, updateInTurn, updatePending } from './status';
import type { AgentEvent } from './types';

const ev = (e: Partial<AgentEvent> & { type: AgentEvent['type'] }) => e as AgentEvent;

describe('состояние чата', () => {
  it('ход: working → waiting → working → idle', () => {
    let s = nextStatus('idle', ev({ type: 'turn.start', at: 1 }));
    expect(s).toBe('working');
    s = nextStatus(
      s,
      ev({
        type: 'permission.request',
        toolUseId: 't',
        toolName: 'Bash',
        input: {},
        canAlwaysAllow: false,
      }),
    );
    expect(s).toBe('waiting');
    s = nextStatus(
      s,
      ev({ type: 'permission.resolved', toolUseId: 't', decision: 'allow', by: 'user' }),
    );
    expect(s).toBe('working');
    s = nextStatus(s, ev({ type: 'turn.result' }));
    expect(s).toBe('idle');
  });
  it('события субагентов состояние не меняют', () => {
    expect(nextStatus('idle', ev({ type: 'turn.start', at: 1, agentId: 'a' }))).toBe('idle');
  });
  it('лимит и ошибка переживают turn.result, следующий ход сбрасывает', () => {
    let s = nextStatus(
      'working',
      ev({ type: 'limit.update', source: 'engine', status: 'rejected', windows: [] }),
    );
    expect(s).toBe('limited');
    expect(nextStatus(s, ev({ type: 'turn.result' }))).toBe('limited');
    s = nextStatus(s, ev({ type: 'turn.start', at: 2 }));
    expect(s).toBe('working');
    expect(nextStatus('working', ev({ type: 'error', message: 'x', fatal: true }))).toBe('error');
    expect(
      nextStatus('working', ev({ type: 'error', message: 'x', fatal: false, code: 'limit' })),
    ).toBe('limited');
    expect(
      nextStatus('working', ev({ type: 'error', message: 'x', fatal: false, code: 'api_retry' })),
    ).toBe('working');
  });
  it('два запроса: ответ на первый оставляет waiting, на второй — working (этап 5)', () => {
    const req = (id: string, agentId?: string) =>
      ev({
        type: 'question.request',
        toolUseId: id,
        questions: [],
        ...(agentId ? { agentId } : {}),
      });
    const res = (id: string) =>
      ev({ type: 'permission.resolved', toolUseId: id, decision: 'allow', by: 'user' });
    let pending: string[] = [];
    let s: ReturnType<typeof nextStatus> = 'working';
    for (const e of [req('a'), req('b', 'sub')]) {
      pending = updatePending(pending, e);
      s = nextStatus(s, e, pending.length);
    }
    expect([s, pending]).toEqual(['waiting', ['a', 'b']]);
    pending = updatePending(pending, res('a'));
    s = nextStatus(s, res('a'), pending.length);
    expect(s).toBe('waiting');
    pending = updatePending(pending, res('b'));
    s = nextStatus(s, res('b'), pending.length);
    expect(s).toBe('working');
  });
  it('запрос субагента между ходами — тоже waiting, после ответа — снова idle', () => {
    const events = [
      ev({ type: 'turn.start', at: 1 }),
      ev({ type: 'turn.result' }),
      ev({ type: 'permission.request', toolUseId: 'p', agentId: 'x' }),
      ev({ type: 'permission.resolved', toolUseId: 'p', agentId: 'x' }),
    ];
    let s: ReturnType<typeof nextStatus> = 'idle';
    let inTurn = false;
    let pending: string[] = [];
    const seen: string[] = [];
    for (const e of events) {
      inTurn = updateInTurn(inTurn, e);
      pending = updatePending(pending, e);
      s = nextStatus(s, e, pending.length, inTurn);
      seen.push(s);
    }
    expect(seen).toEqual(['working', 'idle', 'waiting', 'idle']);
    // ход субагента не открывает ход основного
    expect(updateInTurn(false, ev({ type: 'turn.start', at: 1, agentId: 'x' }))).toBe(false);
    expect(updateInTurn(true, ev({ type: 'session.closed', reason: 'exit' }))).toBe(false);
  });
  it('маркер и заголовок вкладки', () => {
    expect(statusMarker('working')).toBe('●');
    expect(statusMarker('waiting')).toBe('?');
    expect(statusMarker('error')).toBe('!');
    expect(tabTitle('idle', undefined, 'Новая сессия')).toBe('Новая сессия');
    expect(tabTitle('working', 'мигание', 'Новая сессия')).toBe('● мигание');
    expect(tabTitle('idle', '  ', 'New session')).toBe('New session');
    const long = tabTitle('idle', 'а'.repeat(60), 'x');
    expect(long).toHaveLength(40);
    expect(long.endsWith('…')).toBe(true);
    // чат по задаче: ключ перед названием, обрезается только название
    expect(tabTitle('idle', 'Фикс', 'x', 'NEWMFC-1482')).toBe('NEWMFC-1482 · Фикс');
    expect(tabTitle('working', undefined, 'Новая сессия', 'K-1')).toBe('● K-1 · Новая сессия');
    expect(tabTitle('idle', 'а'.repeat(60), 'x', 'K-1')).toHaveLength(40 + 'K-1 · '.length);
  });
});
