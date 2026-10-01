import { describe, expect, it } from 'vitest';
import { restoredSessionId, routeNew, routeOpen, routeResume, type PanelView } from './panelRouting';

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
});

describe('restoredSessionId (сериализатор)', () => {
  it('своя сессия из состояния webview', () => {
    expect(restoredSessionId({ sessionId: 'a' }, [], ['b'])).toBe('a');
  });
  it('своя уже открыта в другой вкладке — не поднимать второй раз', () => {
    expect(restoredSessionId({ sessionId: 'a' }, ['a'], [])).toBeUndefined();
  });
  it('пустое состояние — вкладка без сессии, запас из памяти не берётся', () => {
    expect(restoredSessionId({}, [], ['a'])).toBeUndefined();
  });
  it('состояния нет совсем — первая незанятая из памяти воркспейса', () => {
    expect(restoredSessionId(undefined, ['a', undefined], ['a', 'b'])).toBe('b');
  });
});
