/**
 * Чистая логика вкладки «задача» и полоски задачи (roadmap 19, этап 5): когда они показываются, что в ленте
 * считается новым, какие плашки «пока агент работал» открыты. Данные — `task.state` хоста (`shared/task.ts`).
 */
import type { TaskCardMode } from '../settings';
import { TASK_LIMITS, type TaskEvent, type TaskStateMessage } from '../shared/task';
import { activeCard, pendingPlan, type ChatState } from './chatState';
import { ui } from './strings';
import { toolView } from './toolView';
import type { TaskSub } from './vscode';

/** Это чат по задаче: хост прислал `task.state` с ключом. */
export function isTaskChat(state: TaskStateMessage | undefined): state is TaskStateMessage & { taskKey: string } {
  return !!state?.taskKey;
}

/**
 * Вкладка «задача» есть у любого чата по задаче в обоих режимах `tasks.card` (roadmap 20, решение 10; режима `strip`
 * больше нет). При `split` с Jiraffe она тоже есть (решение владельца 2026-10-08): карточка Jiraffe слева.
 */
export function taskPanelShown(mode: TaskCardMode, state: TaskStateMessage | undefined): boolean {
  return isTaskChat(state) && (mode === 'tab' || mode === 'split');
}

/** Подвкладка по умолчанию: при `split` с Jiraffe карточка уже слева — вкладка открыта на «изменениях». */
export function taskDefaultView(mode: TaskCardMode, state: TaskStateMessage | undefined): TaskSub {
  return mode === 'split' && state?.source === 'jiraffe' ? 'changes' : 'comments';
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

/** Сколько «в задаче →» ждёт события в ленте (загрузка после записи идёт сама); дольше — переход забывается. */
export const FOCUS_TTL_MS = 60_000;

/**
 * Событие, к которому ведёт «в задаче →» (этап 8): по `id`, если он известен (ждём именно его); иначе самое свежее
 * событие этого вида — сначала «моё» (автор = текущий пользователь Jira). Для статуса и комментария — не старше двух
 * минут до клика (ворклог датируется днём работы, у него проверки времени нет).
 */
export function focusTarget(
  events: readonly TaskEvent[],
  focus: { kind: TaskEvent['kind']; id?: string; since: number } | undefined,
): TaskEvent | undefined {
  if (!focus) return undefined;
  if (focus.id) return events.find((e) => e.id === focus.id);
  const fresh = (e: TaskEvent) => e.kind === focus.kind && (e.kind === 'worklog' || e.at >= focus.since - 120_000);
  return events.find((e) => fresh(e) && e.mine) ?? events.find(fresh);
}

/** Что ждёт ответа агент: короткая подпись для тоста на вкладке «задача» (разрешение, вопрос, план); нет ожидания — `undefined`. */
export function waitingWhat(s: ChatState): string | undefined {
  const card = activeCard(s);
  if (card?.kind === 'perm') {
    const v = toolView(card.toolName, card.input);
    return card.description || `${v.op} ${v.what}`.trim();
  }
  if (card?.kind === 'question') return card.questions[0]?.question || ui.task.waitAsk;
  if (pendingPlan(s)) return ui.task.waitPlan;
  return undefined;
}

/**
 * Длительность из поля ворклога → секунды: `1h 30m`, `45m`, `2h`, `1.5h`, `90m` (дни не берём: Jira считает
 * рабочий день иначе, потолок и так сутки). Нет единицы — ошибка. Меньше минуты, больше суток и мусор — `undefined`.
 */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  const re = /^(\d+(?:[.,]\d+)?)\s*(h|m)\b\s*/;
  let rest = t;
  let sec = 0;
  const seen = new Set<string>();
  while (rest) {
    const m = re.exec(rest);
    if (!m || seen.has(m[2]!)) return undefined;
    seen.add(m[2]!);
    sec += Number(m[1]!.replace(',', '.')) * (m[2] === 'h' ? 3600 : 60);
    rest = rest.slice(m[0].length);
  }
  const whole = Math.round(sec);
  return whole >= 60 && whole <= TASK_LIMITS.workSeconds ? whole : undefined;
}

/** Сегодня как `YYYY-MM-DD` в местном часовом поясе (дата ворклога по умолчанию). */
export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Доля учтённого времени от оценки, 0–100; нет оценки — `undefined`. */
export function timeProgress(time: { originalSec?: number; spentSec?: number }): number | undefined {
  if (!time.originalSec || time.originalSec <= 0) return undefined;
  return Math.min(100, Math.round(((time.spentSec ?? 0) / time.originalSec) * 100));
}

/** Причина отказа записи, как её показывать: `no-writer` — подсказка, остальное — текст источника. */
export function actionErrorText(error: string | undefined): string {
  if (error === 'no-writer') return ui.task.noWriter;
  return ui.task.actionFailed(error ?? '?');
}

/** «9 окт, 14:12» (по локали окружения); дата не разобрана — прочерк. */
export function dateTimeLabel(at: number): string {
  if (!at) return ui.task.noValue;
  return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Расширение вложения крупно на плитке: `terminal.log` → `LOG`, без расширения — `FILE`. */
export function fileExt(filename: string): string {
  const i = filename.lastIndexOf('.');
  const ext = i > 0 ? filename.slice(i + 1) : '';
  return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : 'FILE';
}
