import { describe, expect, it } from 'vitest';
import { nextActive, readTaskTabState, restoredTabChats, taskTabTitle, urgentStatus, TAB_CHATS_MAX } from './taskTab';

const K = 'jira:inst:NEWMFC-1482';

describe('readTaskTabState', () => {
  it('нет поля taskTab или кривое — не вкладка задачи', () => {
    expect(readTaskTabState(undefined)).toBeUndefined();
    expect(readTaskTabState({ sessionId: 'a' })).toBeUndefined();
    expect(readTaskTabState({ taskTab: { taskKey: '', chats: [] } })).toBeUndefined();
    expect(readTaskTabState({ taskTab: { taskKey: K, chats: 'x' } })).toBeUndefined();
  });

  it('чужие записи чатов отбрасываются, дубли — тоже; active — только строка', () => {
    expect(
      readTaskTabState({
        taskTab: {
          taskKey: K,
          chats: [
            { provider: 'claude', id: 'a' },
            { provider: 'gpt', id: 'b' },
            { provider: 'codex', id: '' },
            null,
            { provider: 'codex', id: 'c' },
            { provider: 'claude', id: 'a' },
          ],
          active: 7,
        },
      }),
    ).toEqual({ taskKey: K, chats: [{ provider: 'claude', id: 'a' }, { provider: 'codex', id: 'c' }] });
  });

  it('не больше TAB_CHATS_MAX чатов', () => {
    const chats = Array.from({ length: TAB_CHATS_MAX + 5 }, (_, i) => ({ provider: 'claude', id: `s${i}` }));
    expect(readTaskTabState({ taskTab: { taskKey: K, chats } })?.chats).toHaveLength(TAB_CHATS_MAX);
  });
});

describe('restoredTabChats', () => {
  const state = {
    taskKey: K,
    chats: [
      { provider: 'claude' as const, id: 'a' },
      { provider: 'codex' as const, id: 'b' },
      { provider: 'claude' as const, id: 'c' },
    ],
    active: 'c',
  };

  it('все чаты по порядку, видимый — по сессии', () => {
    expect(restoredTabChats(state, [])).toEqual({ refs: state.chats, active: 2 });
  });

  it('чат, уже открытый в другой вкладке, не поднимается второй раз; индекс видимого — после фильтра', () => {
    expect(restoredTabChats(state, [undefined, { provider: 'codex', id: 'b' }])).toEqual({
      refs: [state.chats[0], state.chats[2]],
      active: 1,
    });
  });

  it('тот же id другого движка — другая сессия', () => {
    expect(restoredTabChats(state, [{ provider: 'codex', id: 'a' }]).refs).toHaveLength(3);
  });

  it('видимого нет среди восстановленных — первый', () => {
    expect(restoredTabChats({ ...state, active: 'zzz' }, []).active).toBe(0);
    expect(restoredTabChats(state, [{ provider: 'claude', id: 'c' }]).active).toBe(0);
  });
});

describe('nextActive', () => {
  it('закрыли показанный — соседний справа, у последнего — слева', () => {
    expect(nextActive(['c1', 'c2', 'c3'], 'c2', 'c2')).toBe('c3');
    expect(nextActive(['c1', 'c2', 'c3'], 'c3', 'c3')).toBe('c2');
  });
  it('закрыли фоновый — показанный остаётся', () => {
    expect(nextActive(['c1', 'c2', 'c3'], 'c1', 'c3')).toBe('c3');
  });
  it('закрыли последний — никого', () => {
    expect(nextActive(['c1'], 'c1', 'c1')).toBeUndefined();
  });
});

describe('заголовок вкладки задачи', () => {
  it('самый срочный статус: ждёт ответа важнее идущего хода', () => {
    expect(urgentStatus(['idle', 'working', 'waiting'])).toBe('waiting');
    expect(urgentStatus(['idle', 'limited', 'working'])).toBe('limited');
    expect(urgentStatus([])).toBe('idle');
  });
  it('ключ задачи с маркером', () => {
    expect(taskTabTitle('NEWMFC-1482', ['idle'])).toBe('NEWMFC-1482');
    expect(taskTabTitle('NEWMFC-1482', ['idle', 'working'])).toBe('● NEWMFC-1482');
    expect(taskTabTitle('NEWMFC-1482', ['working', 'waiting'])).toBe('? NEWMFC-1482');
  });
});
