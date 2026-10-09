/** Состояние webview: id сессии и панель лежат в одном `setState` и не затирают друг друга. */
import { beforeEach, describe, expect, it } from 'vitest';

let stored: unknown;
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState: () => stored,
  setState: (s: unknown) => {
    stored = s;
  },
});

const { forgetSession, persistSession, readPanel, savePanel } = await import('./vscode');

beforeEach(() => {
  stored = undefined;
});

describe('состояние webview', () => {
  it('persistSession дописывает sessionId и сохраняет panel', () => {
    stored = { panel: { w: 400 } };
    persistSession('a');
    expect(stored).toEqual({ sessionId: 'a', panel: { w: 400 } });
  });

  it('persistSession с движком пишет provider рядом с sessionId; forgetSession его убирает', () => {
    stored = { panel: { w: 400 } };
    persistSession('thr-1', 'codex');
    expect(stored).toEqual({ sessionId: 'thr-1', provider: 'codex', panel: { w: 400 } });
    forgetSession();
    expect(stored).toEqual({ panel: { w: 400 } });
  });

  it('вкладка задачи: forgetSession оставляет её список чатов, persistSession его не трогает', () => {
    const taskTab = { taskKey: 'jira:i:K-1', chats: [{ provider: 'claude' as const, id: 'a' }], active: 'a' };
    stored = { sessionId: 'a', panel: { w: 400 }, taskTab };
    forgetSession();
    expect(stored).toEqual({ panel: { w: 400 }, taskTab });
    persistSession('b');
    expect(stored).toEqual({ sessionId: 'b', panel: { w: 400 }, taskTab });
  });

  it('forgetSession убирает sessionId, но оставляет panel', () => {
    stored = { sessionId: 'a', panel: { w: 400, tab: 'agents' } };
    forgetSession();
    expect(stored).toEqual({ panel: { w: 400, tab: 'agents' } });
  });

  it('forgetSession без состояния пишет {} — «webview жил, сессии нет»', () => {
    forgetSession();
    expect(stored).toEqual({});
  });

  it('savePanel мерджит поля панели и не трогает sessionId', () => {
    stored = { sessionId: 'a' };
    savePanel({ w: 350 });
    savePanel({ off: true });
    expect(stored).toEqual({ sessionId: 'a', panel: { w: 350, off: true } });
    savePanel({ tab: 'agents', off: false });
    expect(stored).toEqual({ sessionId: 'a', panel: { w: 350, off: false, tab: 'agents' } });
  });

  it('readPanel: пусто, если состояния или панели нет; иначе сохранённое', () => {
    expect(readPanel()).toEqual({});
    stored = { sessionId: 'a' };
    expect(readPanel()).toEqual({});
    stored = { panel: { w: 260 } };
    expect(readPanel()).toEqual({ w: 260 });
  });

  it('readPanel: сохранённая вкладка «turn» → «changes»; охват «сессия | ход», чужой — отброшен', () => {
    stored = { panel: { tab: 'turn' } };
    expect(readPanel()).toEqual({ tab: 'changes' });
    stored = { panel: { tab: 'changes', changes: 'turn' } };
    expect(readPanel()).toEqual({ tab: 'changes', changes: 'turn' });
    stored = { panel: { changes: 'commit' } };
    expect(readPanel()).toEqual({});
  });

  it('readPanel отбрасывает кривые поля: не число / NaN / ≤ 0, не boolean, чужая вкладка', () => {
    stored = { panel: { w: 'abc', off: 'yes', tab: 'log' } };
    expect(readPanel()).toEqual({});
    stored = { panel: { w: Number.NaN, off: true } };
    expect(readPanel()).toEqual({ off: true });
    stored = { panel: { w: -40, tab: 'agents' } };
    expect(readPanel()).toEqual({ tab: 'agents' });
    stored = { panel: 'garbage' };
    expect(readPanel()).toEqual({});
  });

  it('savePanel поверх кривой панели пишет только валидное', () => {
    stored = { sessionId: 'a', panel: { w: 'abc', tab: 'agents' } };
    savePanel({ off: true });
    expect(stored).toEqual({ sessionId: 'a', panel: { tab: 'agents', off: true } });
  });
});
