/**
 * Какую вкладку чата занять (этап 6). Чистая логика без vscode: вкладки описаны минимумом.
 * Правила: сессия, уже открытая во вкладке, — показать её (два движка на один транскрипт не
 * нужны); пустая нетронутая вкладка — занять её; иначе — новая вкладка.
 */
import type { AgentProvider, SessionRef } from '../agent/types';
import { isProvider } from '../settings';

export interface PanelView {
  /** Сессия вкладки: живая или возобновляемая; нет — новая ещё не стартовала. */
  sessionId?: string | undefined;
  /** Движок сессии вкладки; нет — `claude`. Один и тот же id у разных движков — разные сессии. */
  provider?: AgentProvider | undefined;
  /** Новая сессия без сообщений. */
  pristine: boolean;
  /** Вкладка сейчас в фокусе. */
  active: boolean;
  /**
   * Чат внутренней вкладкой вкладки задачи (`tasks.tab = task`, roadmap 19, этап 7): ключ задачи. Пустым такой чат
   * занимает только чат той же задачи (`tab` у `routeResume`/`routeNew`); своя вкладка — нет поля.
   */
  tab?: string | undefined;
  /** Фоновый чат вкладки задачи (её внутренняя вкладка не выбрана): «Открыть чат» его не выбирает. */
  background?: boolean;
}

export type Route = { kind: 'reveal' | 'reuse'; index: number } | { kind: 'new' };

/** Возобновить `id`. `from` — вкладка, из которой пришёл клик (экран empty, попап). */
export function routeResume(
  panels: readonly PanelView[],
  ref: SessionRef | string,
  from?: number,
  /** Ключ вкладки задачи, куда идёт сессия (`tasks.tab = task`); нет — своя вкладка. */
  tab?: string,
): Route {
  const want: SessionRef = typeof ref === 'string' ? { provider: 'claude', id: ref } : ref;
  const open = panels.findIndex(
    (p) => p.sessionId === want.id && (p.provider ?? 'claude') === want.provider,
  );
  if (open >= 0) return { kind: 'reveal', index: open };
  const free = (p: PanelView | undefined): boolean => !!p?.pristine && p.tab === tab;
  if (from !== undefined && free(panels[from])) return { kind: 'reuse', index: from };
  const spare = panels.findIndex((p) => free(p) && p.active);
  if (spare >= 0) return { kind: 'reuse', index: spare };
  const any = panels.findIndex(free);
  if (any >= 0) return { kind: 'reuse', index: any };
  return { kind: 'new' };
}

/** «Новая сессия» (⌘⇧N, боковая панель): пустая вкладка уже есть — показать её, иначе открыть новую. */
export function routeNew(
  panels: readonly PanelView[],
  /** Новый чат вкладки задачи (`tasks.tab = task`): пустой чат занимается только в ней. */
  tab?: string,
): Route {
  const free = (p: PanelView): boolean => p.pristine && p.tab === tab;
  const spare = panels.findIndex((p) => free(p) && p.active);
  if (spare >= 0) return { kind: 'reveal', index: spare };
  const any = panels.findIndex(free);
  return any >= 0 ? { kind: 'reveal', index: any } : { kind: 'new' };
}

/** «Открыть чат»: активная вкладка, иначе любая, иначе новая. */
export function routeOpen(panels: readonly PanelView[]): Route {
  const active = panels.findIndex((p) => p.active);
  if (active >= 0) return { kind: 'reveal', index: active };
  // последняя вкладка, но не фоновый чат вкладки задачи (иначе «Открыть чат» переключил бы её внутреннюю вкладку)
  for (let i = panels.length - 1; i >= 0; i--) if (!panels[i]!.background) return { kind: 'reveal', index: i };
  return { kind: 'new' };
}

/**
 * Какую сессию возобновить во вкладке, которую вернул сериализатор после «Reload Window».
 * Своя — из состояния webview; уже открытая в другой вкладке — никакую (второй движок на один
 * транскрипт хуже пустой вкладки). Запас из памяти воркспейса — только вкладке, чей webview ни разу
 * не запускался (состояния нет совсем): пустое состояние `{}` значит «вкладка без сессии».
 */
export function restoredSessionId(
  state: unknown,
  claimed: readonly (SessionRef | undefined)[],
  remembered: readonly SessionRef[],
): SessionRef | undefined {
  const isTaken = (ref: SessionRef) =>
    claimed.some((c) => c?.id === ref.id && c.provider === ref.provider);
  if (state !== undefined && state !== null) {
    const own = (state as { sessionId?: unknown }).sessionId;
    if (typeof own !== 'string' || !own) return undefined;
    // webview пишет `provider` рядом с id; состояние со старой версии (только id) — движок из памяти воркспейса, нет записи — Claude
    const stated = (state as { provider?: unknown }).provider;
    const provider: AgentProvider =
      isProvider(stated)
        ? stated
        : (remembered.find((x) => x.id === own)?.provider ?? 'claude');
    const ref: SessionRef = { provider, id: own };
    return isTaken(ref) ? undefined : ref;
  }
  return remembered.find((x) => !isTaken(x));
}
