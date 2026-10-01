// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nearBottom, STICK_PX, useStickToBottom } from './useStickToBottom';

/** jsdom не считает вёрстку — задаём геометрию панели руками. */
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => g.clientHeight });
}

function Pane({ n }: { n: number }) {
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>([n]);
  return h('div', { ref, onScroll, id: 'p' });
}

describe('nearBottom', () => {
  it('у низа в пределах порога — да, дальше — нет', () => {
    expect(nearBottom({ scrollHeight: 500, clientHeight: 100, scrollTop: 400 })).toBe(true);
    expect(nearBottom({ scrollHeight: 500, clientHeight: 100, scrollTop: 400 - STICK_PX + 1 })).toBe(true);
    expect(nearBottom({ scrollHeight: 500, clientHeight: 100, scrollTop: 400 - STICK_PX })).toBe(false);
  });
});

describe('useStickToBottom', () => {
  const host = document.createElement('div');
  afterEach(() => render(null, host));

  it('у низа прилипает к новому содержимому, отлистали вверх — нет, вернулись — снова да', async () => {
    document.body.append(host);
    const g = { scrollHeight: 500, clientHeight: 100 };
    await act(() => render(h(Pane, { n: 1 }), host));
    const el = host.querySelector('#p') as HTMLDivElement;
    geometry(el, g);

    // по умолчанию прилипший: рост содержимого тянет вниз
    g.scrollHeight = 600;
    await act(() => render(h(Pane, { n: 2 }), host));
    expect(el.scrollTop).toBe(600);

    // отлистали вверх: новое содержимое не двигает панель
    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    g.scrollHeight = 700;
    await act(() => render(h(Pane, { n: 3 }), host));
    expect(el.scrollTop).toBe(100);

    // вернулись к низу: снова липнет
    el.scrollTop = 600;
    el.dispatchEvent(new Event('scroll'));
    g.scrollHeight = 800;
    await act(() => render(h(Pane, { n: 4 }), host));
    expect(el.scrollTop).toBe(800);
  });
});
