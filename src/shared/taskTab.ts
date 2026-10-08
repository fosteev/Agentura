/**
 * Вкладка на задачу (`agentura.tasks.tab = task`, roadmap 19, этап 7, вариант Б): одна вкладка редактора держит
 * несколько чатов задачи, видим один. Чистая логика без vscode: сообщения внутренних вкладок, состояние для
 * сериализатора, восстановление после «Reload Window», заголовок вкладки.
 */
import type { AgentProvider, SessionRef } from '../agent/types';
import { statusMarker, type ChatStatus } from '../agent/status';
import { isProvider } from '../settings';

/** Внутренняя вкладка: чат вкладки задачи. */
export interface TabChatRow {
  /** Id внутренней вкладки (хоста): у нового чата id сессии ещё нет. */
  id: string;
  /** Название чата; пусто — «новый чат». */
  title: string;
  provider: AgentProvider;
  status: ChatStatus;
  active: boolean;
}

/** Что webview вкладки задачи кладёт в `setState`: по нему сериализатор вернёт все её чаты. */
export interface TaskTabState {
  taskKey: string;
  /** Чаты с сессией в порядке внутренних вкладок (чат без единого сообщения не сохраняется). */
  chats: SessionRef[];
  /** Сессия видимого чата; нет — первый. */
  active?: string;
}

/** Хост → вкладка задачи: внутренние вкладки и состояние для сериализатора. */
export interface TabChatsMessage {
  type: 'tab.chats';
  /** Ключ группы (`jira:<инстанс>:<KEY>`). */
  taskKey: string;
  chats: TabChatRow[];
  persist: TaskTabState;
}

/** Вкладка задачи → хост: показать / закрыть внутреннюю вкладку, «＋» — новый чат по задаче. */
export type TabRequest = { type: 'tab.select'; id: string } | { type: 'tab.close'; id: string } | { type: 'tab.new' };

export function isTabRequest<T extends { type: string }>(m: T): m is T & TabRequest {
  return m.type === 'tab.select' || m.type === 'tab.close' || m.type === 'tab.new';
}

/** Потолок чатов одной вкладки в сохранённом состоянии: кривое состояние не поднимет сотню движков. */
export const TAB_CHATS_MAX = 20;

/** Состояние вкладки задачи из `getState` webview; кривое или не вкладка задачи — `undefined`. */
export function readTaskTabState(state: unknown): TaskTabState | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const t = (state as { taskTab?: unknown }).taskTab;
  if (typeof t !== 'object' || t === null) return undefined;
  const { taskKey, chats, active } = t as Record<string, unknown>;
  if (typeof taskKey !== 'string' || !taskKey || !Array.isArray(chats)) return undefined;
  const refs: SessionRef[] = [];
  for (const c of chats) {
    if (typeof c !== 'object' || c === null) continue;
    const { id, provider } = c as Record<string, unknown>;
    if (typeof id !== 'string' || !id || !isProvider(provider)) continue;
    if (refs.some((r) => r.id === id && r.provider === provider)) continue;
    refs.push({ provider, id });
    if (refs.length >= TAB_CHATS_MAX) break;
  }
  return {
    taskKey,
    chats: refs,
    ...(typeof active === 'string' && active ? { active } : {}),
  };
}

/**
 * Что восстановить во вкладке задачи после «Reload Window»: её чаты без уже открытых в других вкладках (второй
 * движок на один транскрипт хуже пропавшей внутренней вкладки) и индекс видимого. Пусто — вкладке нечего
 * возобновлять (останется один новый чат по задаче).
 */
export function restoredTabChats(
  state: TaskTabState,
  claimed: readonly (SessionRef | undefined)[],
): { refs: SessionRef[]; active: number } {
  const refs = state.chats.filter(
    (r) => !claimed.some((c) => c?.id === r.id && c.provider === r.provider),
  );
  const active = Math.max(
    0,
    refs.findIndex((r) => r.id === state.active),
  );
  return { refs, active };
}

/** Какую внутреннюю вкладку показать после закрытия `closed`: соседнюю справа, иначе слева; не видимую — та же. */
export function nextActive(ids: readonly string[], closed: string, active: string | undefined): string | undefined {
  const rest = ids.filter((id) => id !== closed);
  if (active !== closed && active !== undefined && rest.includes(active)) return active;
  const i = ids.indexOf(closed);
  return rest[Math.min(Math.max(i, 0), rest.length - 1)];
}

/** Самый срочный статус чатов вкладки: ждёт ответа → ошибка/лимит → идёт ход → покой. */
export function urgentStatus(statuses: readonly ChatStatus[]): ChatStatus {
  const order: ChatStatus[] = ['waiting', 'error', 'limited', 'working'];
  return order.find((s) => statuses.includes(s)) ?? 'idle';
}

/** Заголовок вкладки задачи: ключ задачи (`tasks.html#b`) с маркером самого срочного чата. */
export function taskTabTitle(key: string, statuses: readonly ChatStatus[]): string {
  const marker = statusMarker(urgentStatus(statuses));
  return marker ? `${marker} ${key}` : key;
}
