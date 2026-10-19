import { describe, expect, it } from 'vitest';
import {
  pickCwd,
  restoredSessionId,
  routeContextNew,
  routeNew,
  routeOpen,
  routeResume,
  stateCwd,
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
  it('новая с движком (roadmap 26): пустая вкладка другого движка не занимается; без движка — любая', () => {
    const panels = [p({ pristine: true, provider: 'codex' }), p({ pristine: true })];
    expect(routeNew(panels, undefined, 'claude')).toEqual({ kind: 'reveal', index: 1 });
    expect(routeNew(panels, undefined, 'codex')).toEqual({ kind: 'reveal', index: 0 });
    expect(routeNew(panels, undefined, 'antigravity')).toEqual({ kind: 'new' });
    expect(routeNew(panels)).toEqual({ kind: 'reveal', index: 0 });
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

describe('routeContextNew (roadmap 26, Д3)', () => {
  const panels = [p({ pristine: true, active: true }), p({ pristine: true })];

  it('без опций — как routeNew: пустая вкладка того же движка', () => {
    expect(routeContextNew(panels, {})).toEqual({ kind: 'reveal', index: 0 });
    expect(routeContextNew([p({ pristine: true, provider: 'codex' })], { provider: 'claude' })).toEqual({ kind: 'new' });
  });

  it('автоотправка, своя папка, «рядом» — всегда новая вкладка, пустая не занимается', () => {
    expect(routeContextNew(panels, { autoSend: true })).toEqual({ kind: 'new' });
    expect(routeContextNew(panels, { cwd: true })).toEqual({ kind: 'new' });
    expect(routeContextNew(panels, { beside: true })).toEqual({ kind: 'new' });
    expect(routeContextNew([p({ pristine: true, tab: 'k' })], { tab: 'k', autoSend: true })).toEqual({ kind: 'new' });
  });
});

describe('рабочая папка восстановленного чата (roadmap 26, Д1)', () => {
  it('stateCwd: panel.cwd из состояния webview; нет или кривой — undefined', () => {
    expect(stateCwd({ sessionId: 's', panel: { w: 300, cwd: '/w/app-K-1-2' } })).toBe('/w/app-K-1-2');
    expect(stateCwd({ panel: { cwd: 7 } })).toBeUndefined();
    expect(stateCwd({ panel: {} })).toBeUndefined();
    expect(stateCwd({ sessionId: 's' })).toBeUndefined();
    expect(stateCwd(undefined)).toBeUndefined();
    expect(stateCwd({ panel: { cwd: `/${'a'.repeat(2000)}` } })).toBeUndefined();
  });

  it('pickCwd: состояние → строка списка → ссылка группы, только существующие папки', () => {
    const dirs = new Set(['/w/app', '/w/app-K-1-2', '/w/app-K-1-3']);
    const exists = (d: string) => dirs.has(d);
    expect(pickCwd(['/w/app-K-1-2', '/w/app-K-1-3', undefined], exists)).toBe('/w/app-K-1-2');
    // папки из состояния больше нет — строка списка
    expect(pickCwd(['/w/gone', '/w/app-K-1-3'], exists)).toBe('/w/app-K-1-3');
    // строки нет (codex/agy до Д2, список не загружен) — ссылка группы
    expect(pickCwd([undefined, undefined, '/w/app-K-1-2'], exists)).toBe('/w/app-K-1-2');
    // папка воркспейса в состоянии — ответ (дальше её отсеет chatCwd), строку не смотрим
    expect(pickCwd(['/w/app', '/w/app-K-1-2'], exists)).toBe('/w/app');
    expect(pickCwd([undefined, '/w/gone'], exists)).toBeUndefined();
  });
});
