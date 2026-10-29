// Cmd/Ctrl+C по выделенному тексту ленты. Обёртка webview VS Code (pre/index.html) на Electron гасит
// копирование в keydown и отдаёт его workbench, а тот возвращает фокус во вкладку раньше `execCommand('copy')`:
// фокус уходит в поле ввода, выделение схлопывается, в буфер ничего не попадает. Копируем сами в фазе
// захвата, до её слушателя (он висит на том же window на всплытии), и дальше событие не пускаем.

/** Фокус в поле ввода: там копирует сам элемент, как и раньше. */
function editable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

/** Ставит перехват; возвращает снятие. */
export function installCopyKeys(win: Window = window): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key.toLowerCase() !== 'c' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (editable(e.target)) return;
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (win.document.execCommand('copy')) return;
    void win.navigator.clipboard?.writeText(sel.toString()).catch(() => undefined);
  };
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}
