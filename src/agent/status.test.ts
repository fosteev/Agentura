import { describe, expect, it } from 'vitest';
import { nextStatus, statusMarker, tabTitle } from './status';
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
  });
  it('маркер и заголовок вкладки', () => {
    expect(statusMarker('working')).toBe('●');
    expect(statusMarker('waiting')).toBe('?');
    expect(statusMarker('error')).toBe('!');
    expect(tabTitle('idle')).toBe('Agentura');
    expect(tabTitle('working', 'мигание')).toBe('● Agentura · мигание');
  });
});
