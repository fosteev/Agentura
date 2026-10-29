// @vitest-environment jsdom
/** Cmd/Ctrl+C по выделению ленты копируем сами, до перехвата обёртки webview VS Code. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCopyKeys } from './copyKeys';

let off: () => void;
let vscodeHook: ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>>;
let exec: ReturnType<typeof vi.fn<(cmd: string) => boolean>>;

beforeEach(() => {
  document.body.innerHTML = '<div class="txt"><p>ответ агента</p></div><textarea>черновик</textarea>';
  exec = vi.fn<(cmd: string) => boolean>(() => true);
  (document as unknown as { execCommand: unknown }).execCommand = exec;
  off = installCopyKeys();
  // как pre/index.html: слушатель на всплытии того же window
  vscodeHook = vi.fn<(e: KeyboardEvent) => void>();
  window.addEventListener('keydown', vscodeHook);
});

afterEach(() => {
  off();
  window.removeEventListener('keydown', vscodeHook);
  window.getSelection()?.removeAllRanges();
});

function selectFeed(): void {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('.txt p')!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('installCopyKeys', () => {
  it('Cmd+C по выделению — копирует и не пускает событие в обёртку VS Code', () => {
    selectFeed();
    const e = press(document.body, { metaKey: true });
    expect(exec).toHaveBeenCalledWith('copy');
    expect(e.defaultPrevented).toBe(true);
    expect(vscodeHook).not.toHaveBeenCalled();
  });

  it('Ctrl+C тоже', () => {
    selectFeed();
    press(document.body, { ctrlKey: true });
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('без выделения — событие идёт как раньше', () => {
    press(document.body, { metaKey: true });
    expect(exec).not.toHaveBeenCalled();
    expect(vscodeHook).toHaveBeenCalledOnce();
  });

  it('в поле ввода — не трогаем', () => {
    selectFeed();
    press(document.querySelector('textarea')!, { metaKey: true });
    expect(exec).not.toHaveBeenCalled();
    expect(vscodeHook).toHaveBeenCalledOnce();
  });

  it('Cmd+Shift+C и просто C — не наши', () => {
    selectFeed();
    press(document.body, { metaKey: true, shiftKey: true });
    press(document.body, {});
    expect(exec).not.toHaveBeenCalled();
    expect(vscodeHook).toHaveBeenCalledTimes(2);
  });
});
