/**
 * Какую вкладку чата занять (этап 6). Чистая логика без vscode: вкладки описаны минимумом.
 * Правила: сессия, уже открытая во вкладке, — показать её (два движка на один транскрипт не
 * нужны); пустая нетронутая вкладка — занять её; иначе — новая вкладка.
 */
export interface PanelView {
  /** Сессия вкладки: живая или возобновляемая; нет — новая ещё не стартовала. */
  sessionId?: string | undefined;
  /** Новая сессия без сообщений. */
  pristine: boolean;
  /** Вкладка сейчас в фокусе. */
  active: boolean;
}

export type Route = { kind: 'reveal' | 'reuse'; index: number } | { kind: 'new' };

/** Возобновить `id`. `from` — вкладка, из которой пришёл клик (экран empty, попап). */
export function routeResume(panels: readonly PanelView[], id: string, from?: number): Route {
  const open = panels.findIndex((p) => p.sessionId === id);
  if (open >= 0) return { kind: 'reveal', index: open };
  if (from !== undefined && panels[from]?.pristine) return { kind: 'reuse', index: from };
  const spare = panels.findIndex((p) => p.pristine && p.active);
  if (spare >= 0) return { kind: 'reuse', index: spare };
  const any = panels.findIndex((p) => p.pristine);
  if (any >= 0) return { kind: 'reuse', index: any };
  return { kind: 'new' };
}

/** «Новая сессия» (⌘⇧N, боковая панель): пустая вкладка уже есть — показать её, иначе открыть новую. */
export function routeNew(panels: readonly PanelView[]): Route {
  const spare = panels.findIndex((p) => p.pristine && p.active);
  if (spare >= 0) return { kind: 'reveal', index: spare };
  const any = panels.findIndex((p) => p.pristine);
  return any >= 0 ? { kind: 'reveal', index: any } : { kind: 'new' };
}

/** «Открыть чат»: активная вкладка, иначе любая, иначе новая. */
export function routeOpen(panels: readonly PanelView[]): Route {
  const active = panels.findIndex((p) => p.active);
  if (active >= 0) return { kind: 'reveal', index: active };
  return panels.length > 0 ? { kind: 'reveal', index: panels.length - 1 } : { kind: 'new' };
}

/**
 * Какую сессию возобновить во вкладке, которую вернул сериализатор после «Reload Window».
 * Своя — из состояния webview; уже открытая в другой вкладке — никакую (второй движок на один
 * транскрипт хуже пустой вкладки). Запас из памяти воркспейса — только вкладке, чей webview ни разу
 * не запускался (состояния нет совсем): пустое состояние `{}` значит «вкладка без сессии».
 */
export function restoredSessionId(
  state: unknown,
  claimed: readonly (string | undefined)[],
  remembered: readonly string[],
): string | undefined {
  const taken = new Set(claimed);
  if (state !== undefined && state !== null) {
    const own = (state as { sessionId?: unknown }).sessionId;
    return typeof own === 'string' && own && !taken.has(own) ? own : undefined;
  }
  return remembered.find((x) => !taken.has(x));
}
