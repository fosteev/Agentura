// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltips } from './tooltip';

function rect(el: Element, r: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...r }) as DOMRect;
}
const over = (el: Element): boolean => el.dispatchEvent(new Event('pointerover', { bubbles: true }));
const tipEl = (): HTMLElement => document.getElementById('agentura-tip')!;

describe('тултип', () => {
  let off: () => void;
  let a: HTMLElement;
  let b: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="a" data-tip="Первая">A</button><button id="b" data-tip="Вторая">B</button>';
    a = document.getElementById('a')!;
    b = document.getElementById('b')!;
    rect(a, { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 });
    rect(b, { left: 50, top: 10, right: 70, bottom: 30, width: 20, height: 20 });
    off = installTooltips(document);
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('показывается через 500 мс после pointerover', () => {
    over(a);
    vi.advanceTimersByTime(499);
    expect(tipEl().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tipEl().hidden).toBe(false);
    expect(tipEl().textContent).toBe('Первая');
    expect(a.getAttribute('aria-describedby')).toBe('agentura-tip');
  });

  it('следующий элемент показывается сразу (тёплый режим)', () => {
    over(a);
    vi.advanceTimersByTime(500);
    over(b);
    vi.advanceTimersByTime(0);
    expect(tipEl().hidden).toBe(false);
    expect(tipEl().textContent).toBe('Вторая');
    expect(a.hasAttribute('aria-describedby')).toBe(false);
  });

  it('Esc и pointerdown скрывают', () => {
    over(a);
    vi.advanceTimersByTime(500);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tipEl().hidden).toBe(true);
    over(a);
    vi.advanceTimersByTime(500);
    expect(tipEl().hidden).toBe(false);
    b.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(tipEl().hidden).toBe(true);
  });

  it('уход курсора из окна (pointerout без relatedTarget) скрывает, до показа — отменяет', () => {
    over(a);
    a.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(tipEl().hidden).toBe(true);
  });

  it('\\n делает две строки .tl, data-tip-key — kbd в первой', () => {
    a.setAttribute('data-tip', 'Обновить\nданные в 12:00');
    a.setAttribute('data-tip-key', 'Enter');
    over(a);
    vi.advanceTimersByTime(500);
    const rows = tipEl().querySelectorAll('.tl');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('kbd')?.textContent).toBe('Enter');
    expect(rows[1]!.querySelector('kbd')).toBeNull();
    expect(rows[1]!.textContent).toBe('данные в 12:00');
  });

  it('текст читается при каждом показе', () => {
    over(a);
    vi.advanceTimersByTime(500);
    expect(tipEl().textContent).toBe('Первая');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    a.setAttribute('data-tip', 'Новая');
    over(a);
    vi.advanceTimersByTime(500);
    expect(tipEl().textContent).toBe('Новая');
  });

  it('у нижнего края — над элементом (data-side=top), иначе под', () => {
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { value: 20, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { value: 60, configurable: true });
    try {
      rect(a, { left: 10, top: 80, right: 30, bottom: 96, width: 20, height: 16 });
      over(a);
      vi.advanceTimersByTime(500);
      expect(tipEl().getAttribute('data-side')).toBe('top');
      expect(tipEl().style.top).toBe('54px'); // 80 - 6 - 20
      expect(tipEl().style.left).toBe('4px'); // прижим к левому краю
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      over(b);
      vi.advanceTimersByTime(500);
      expect(tipEl().getAttribute('data-side')).toBe('bottom');
    } finally {
      delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
      delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    }
  });

  it('uninstall удаляет слой и слушатели', () => {
    off();
    expect(document.getElementById('agentura-tip')).toBeNull();
    over(a);
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('agentura-tip')).toBeNull();
    off = installTooltips(document);
  });
});
