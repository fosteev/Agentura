import { describe, expect, it } from 'vitest';
import {
  restoredSessionId,
  routeNew,
  routeOpen,
  routeResume,
  type PanelView,
} from './panelRouting';

const p = (over: Partial<PanelView> = {}): PanelView => ({
  pristine: false,
  active: false,
  ...over,
});

describe('routeResume', () => {
  it('сессия уже открыта — показать её вкладку', () => {
    expect(routeResume([p({ sessionId: 'a' }), p({ sessionId: 'b' })], 'b')).toEqual({
      kind: 'reveal',
      index: 1,
    });
  });
  it('клик из пустой вкладки — занять её', () => {
    expect(routeResume([p({ sessionId: 'a' }), p({ pristine: true })], 'x', 1)).toEqual({
      kind: 'reuse',
      index: 1,
    });
  });
  it('клик из занятой вкладки — новая (идущий диалог не затирается)', () => {
    expect(routeResume([p({ sessionId: 'a', active: true })], 'x', 0)).toEqual({ kind: 'new' });
  });
  it('из боковой панели: пустая вкладка (активная в приоритете), иначе новая', () => {
    expect(routeResume([p({ pristine: true }), p({ pristine: true, active: true })], 'x')).toEqual({
      kind: 'reuse',
      index: 1,
    });
    expect(routeResume([p({ pristine: true })], 'x')).toEqual({ kind: 'reuse', index: 0 });
    expect(routeResume([], 'x')).toEqual({ kind: 'new' });
  });
});

describe('routeResume: движок', () => {
  it('тот же id у другого движка — не открытая сессия', () => {
    const panels: PanelView[] = [{ sessionId: 'a', provider: 'claude', pristine: false, active: true }];
    expect(routeResume(panels, { provider: 'claude', id: 'a' })).toEqual({ kind: 'reveal', index: 0 });
    expect(routeResume(panels, 'a')).toEqual({ kind: 'reveal', index: 0 });
    expect(routeResume(panels, { provider: 'codex', id: 'a' })).toEqual({ kind: 'new' });
  });
});

describe('routeNew / routeOpen', () => {
  it('новая: пустая вкладка уже есть — показать её, иначе открыть', () => {
    expect(routeNew([p({ sessionId: 'a' }), p({ pristine: true })])).toEqual({
      kind: 'reveal',
      index: 1,
    });
    expect(routeNew([p({ sessionId: 'a' })])).toEqual({ kind: 'new' });
  });
  it('открыть чат: активная, иначе последняя, иначе новая', () => {
    expect(routeOpen([p(), p({ active: true }), p()])).toEqual({ kind: 'reveal', index: 1 });
    expect(routeOpen([p(), p()])).toEqual({ kind: 'reveal', index: 1 });
    expect(routeOpen([])).toEqual({ kind: 'new' });
  });
  it('открыть чат без активной: фоновый чат вкладки задачи не выбирается', () => {
    expect(routeOpen([p(), p({ tab: 'k', background: true })])).toEqual({ kind: 'reveal', index: 0 });
    expect(routeOpen([p({ tab: 'k' }), p({ tab: 'k', background: true })])).toEqual({ kind: 'reveal', index: 0 });
  });
});

describe('вкладка на задачу (tasks.tab = task, этап 7)', () => {
  const T = 'jira:inst:NEWMFC-1482';
  it('пустой чат вкладки задачи не занимается чатом без задачи — ни возобновлением, ни «новой сессией»', () => {
    const panels = [p({ pristine: true, active: true, tab: T })];
    expect(routeResume(panels, 'x', 0)).toEqual({ kind: 'new' });
    expect(routeNew(panels)).toEqual({ kind: 'new' });
  });
  it('чат задачи занимает пустой чат своей вкладки задачи, но не обычную пустую вкладку и не чужую задачу', () => {
    const panels = [
      p({ pristine: true, active: true }),
      p({ pristine: true, tab: 'jira:inst:GARM-1' }),
      p({ pristine: true, tab: T }),
    ];
    expect(routeResume(panels, 'x', 0, T)).toEqual({ kind: 'reuse', index: 2 });
    expect(routeNew(panels, T)).toEqual({ kind: 'reveal', index: 2 });
    expect(routeNew(panels.slice(0, 2), T)).toEqual({ kind: 'new' });
  });
  it('уже открытый чат показывается, где бы он ни был', () => {
    expect(routeResume([p({ sessionId: 'a', tab: T })], 'a')).toEqual({ kind: 'reveal', index: 0 });
  });
});

describe('restoredSessionId (сериализатор)', () => {
  const cl = (id: string) => ({ provider: 'claude' as const, id });
  const cx = (id: string) => ({ provider: 'codex' as const, id });
  it('лишнее поле panel состояния не мешает: id берётся из sessionId', () => {
    expect(
      restoredSessionId({ sessionId: 'a', panel: { w: 400, off: true } }, [], [cl('b')]),
    ).toEqual(cl('a'));
    expect(restoredSessionId({ panel: { w: 400 } }, [], [cl('b')])).toBeUndefined();
  });
  it('своя сессия из состояния webview; движок — из памяти воркспейса, иначе Claude', () => {
    expect(restoredSessionId({ sessionId: 'a' }, [], [cl('b')])).toEqual(cl('a'));
    expect(restoredSessionId({ sessionId: 'a' }, [], [cx('a')])).toEqual(cx('a'));
    expect(restoredSessionId({ sessionId: 'a', provider: 'codex' }, [], [])).toEqual(cx('a'));
    expect(restoredSessionId({ sessionId: 'a', provider: 'antigravity' }, [], [])).toEqual({ provider: 'antigravity', id: 'a' });
    expect(restoredSessionId({ sessionId: 'a', provider: 'nope' }, [], [])).toEqual(cl('a'));
  });
  it('своя уже открыта в другой вкладке — не поднимать второй раз; тот же id другого движка — другая', () => {
    expect(restoredSessionId({ sessionId: 'a' }, [cl('a')], [])).toBeUndefined();
    expect(restoredSessionId({ sessionId: 'a', provider: 'codex' }, [cl('a')], [])).toEqual(cx('a'));
  });
  it('пустое состояние — вкладка без сессии, запас из памяти не берётся', () => {
    expect(restoredSessionId({}, [], [cl('a')])).toBeUndefined();
  });
  it('состояния нет совсем — первая незанятая из памяти воркспейса, с движком', () => {
    expect(restoredSessionId(undefined, [cl('a'), undefined], [cl('a'), cx('b')])).toEqual(cx('b'));
  });
});
