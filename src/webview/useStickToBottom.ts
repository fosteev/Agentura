import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

/** Насколько близко к низу панель считается «прилипшей». */
export const STICK_PX = 32;

/** Панель прокручена к низу (в пределах `STICK_PX`)? */
export function nearBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
}

/**
 * Автопрокрутка с «прилипанием»: пока пользователь у низа, новое содержимое (смена `deps`) тянет
 * панель вниз; ушёл вверх — не дёргаем; вернулся к низу — прилипает снова.
 */
export function useStickToBottom<T extends HTMLElement>(
  deps: unknown[],
): { ref: RefObject<T | null>; onScroll: () => void } {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const onScroll = () => {
    if (ref.current) stick.current = nearBottom(ref.current);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, deps);
  return { ref, onScroll };
}
