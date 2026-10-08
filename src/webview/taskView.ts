/**
 * Чистая логика вкладки «задача» и полоски задачи (roadmap 19, этап 5): когда они показываются, что в ленте
 * считается новым, какие плашки «пока агент работал» открыты. Данные — `task.state` хоста (`shared/task.ts`).
 */
import type { TaskCardMode } from '../settings';
import type { TaskEvent, TaskStateMessage } from '../shared/task';
import { ui } from './strings';

/** Это чат по задаче: хост прислал `task.state` с ключом. */
export function isTaskChat(state: TaskStateMessage | undefined): state is TaskStateMessage & { taskKey: string } {
  return !!state?.taskKey;
}

/**
 * Вкладка «задача» правой панели есть у чата по задаче при `panel`, а при `split` — когда источник не Jiraffe
 * (карточку тогда открыть слева нечем, split работает как panel). `strip` — вкладки нет.
 */
export function taskPanelShown(mode: TaskCardMode, state: TaskStateMessage | undefined): boolean {
  if (!isTaskChat(state)) return false;
  if (mode === 'strip') return false;
  if (mode === 'split') return state.source !== 'jiraffe';
  return true;
}

/** `jira:<инстанс>:<KEY>` → `KEY` (инстанс может содержать `:` — берём хвост после последнего). */
export function issueKeyOf(taskKey: string): string {
  const i = taskKey.lastIndexOf(':');
  return i >= 0 ? taskKey.slice(i + 1) : taskKey;
}

/** События, которые вкладка показывает: `humanChanges === false` убирает чужие (хост уже фильтрует, это второй рубеж). */
export function visibleEvents(state: TaskStateMessage | undefined): TaskEvent[] {
  if (!state) return [];
  return state.humanChanges === false ? state.events.filter((e) => e.mine) : state.events;
}

/** Самое позднее из того, что вкладка уже «видела»: события и комментарии карточки. */
export function latestSeen(state: TaskStateMessage | undefined): number {
  if (!state) return 0;
  let at = 0;
  for (const e of visibleEvents(state)) at = Math.max(at, e.at);
  for (const c of state.card?.comments ?? []) at = Math.max(at, c.at);
  return at;
}

/** Событий новее `seen` (мс). */
export function unseenCount(events: readonly TaskEvent[], seen: number): number {
  let n = 0;
  for (const e of events) if (e.at > seen) n++;
  return n;
}

/**
 * Плашки «<имя> прокомментировал(а), пока агент работал»: комментарий человека внутри хода, ещё не отправленный
 * агенту (`done` — id комментариев, которые уже нажали «в чат»). Новые сверху, не больше `limit`.
 */
export function humanPrompts(events: readonly TaskEvent[], done: ReadonlySet<string>, limit = 3): TaskEvent[] {
  return events
    .filter((e) => e.kind === 'comment' && !e.mine && e.duringTurn && !!e.commentId && !done.has(e.commentId))
    .slice(0, limit);
}

/** «только что», «5 мин назад», «3 ч назад», «2 дн назад». */
export function agoLabel(at: number, now: number): string {
  const t = ui.task;
  if (!at) return t.notLoaded;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t.justNow;
  const m = Math.floor(s / 60);
  if (m < 60) return t.minAgo(m);
  const h = Math.floor(m / 60);
  if (h < 24) return t.hourAgo(h);
  return t.dayAgo(Math.floor(h / 24));
}

/** Инициалы автора для аватарки человека: «Ольга К.» → «ОК». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]!][0] ?? '?';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** Вставка длинного описания: подсказка «ещё» нужна, когда текст явно не влезает в четыре строки. */
export function descriptionLong(text: string): boolean {
  return text.length > 240 || text.split('\n').length > 4;
}

/** Кто автор события: человек, агент этого чата (`fromThisChat`) или сам пользователь вне этого чата. */
export function eventActor(e: TaskEvent): 'human' | 'agent' | 'self' {
  if (!e.mine) return 'human';
  return e.fromThisChat ? 'agent' : 'self';
}

/** Размер вложения: «148 КБ», «2,1 МБ». */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} ${ui.task.kb}`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ${ui.task.mb}`;
}

/** Строка события для ленты: что изменилось, готовым текстом (комментарий обрезан). */
export function eventText(e: TaskEvent): { label: string; text: string; strong?: string } {
  const label = ui.task.kind[e.kind];
  if (e.kind === 'status' && e.to) return { label, text: e.from ? `${e.from} → ` : '', strong: e.to };
  if (e.kind === 'field' && e.field) {
    return { label: e.field, text: `${e.from ?? '—'} → `, strong: e.to ?? '—' };
  }
  if (e.kind === 'worklog') return { label, text: '', strong: e.text };
  const t = e.text.length > 240 ? `${e.text.slice(0, 240)}…` : e.text;
  return { label, text: e.kind === 'comment' ? `«${t}»` : t };
}
