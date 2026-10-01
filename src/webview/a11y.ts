/**
 * Клавиатура меню (этап 7): стрелки, Home/End двигают фокус по пунктам открытого меню внутри
 * контейнера-обработчика (`.pop`, попап сессий). Esc и закрытие по клику — у владельца меню.
 */
export function menuKeys(e: KeyboardEvent): void {
  const root = e.currentTarget as HTMLElement | null;
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('.menu .it:not(.dis)')];
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = items.length;
  let next: number | undefined;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % n;
  else if (e.key === 'ArrowUp') next = i < 0 ? n - 1 : (i - 1 + n) % n;
  else if (e.key === 'Home' && i >= 0) next = 0;
  else if (e.key === 'End' && i >= 0) next = n - 1;
  if (next === undefined) return;
  e.preventDefault();
  items[next]!.focus();
}

/** Следующая вкладка по стрелке в `role=tablist`: индекс среди включённых вкладок. */
export function tabStep(
  key: string,
  index: number,
  enabled: readonly boolean[],
): number | undefined {
  const n = enabled.length;
  const dir = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (key === 'Home') return enabled.findIndex(Boolean);
  if (key === 'End') return enabled.lastIndexOf(true);
  if (dir === 0) return undefined;
  for (let k = 1; k <= n; k++) {
    const j = (index + dir * k + n * k) % n;
    if (enabled[j]) return j;
  }
  return undefined;
}
