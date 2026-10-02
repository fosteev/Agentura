/**
 * Виды списка сессий и лимитов боковой панели (этап 6): чистые функции без DOM — день, время,
 * подпись строки, класс строки, строки лимитов. Эталон разметки и текстов — `prototype/screens/sessions.html`.
 */
import type { LimitWindow } from '../agent/types';
import type { SessionSummary } from '../protocol';
import { clock } from './chatState';
import { formatCost } from './toolView';
import { ui } from './strings';

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAYS_LONG = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среду',
  'четверг',
  'пятницу',
  'субботу',
];
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Сколько календарных дней назад (0 — сегодня). */
function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
}

/** Заголовок дня: `Сегодня`, `Вчера`, `23 сентября` (с годом, если не текущий). */
export function dayLabel(ms: number, now: number): string {
  const ago = daysAgo(ms, now);
  if (ago <= 0) return ui.sidebar.days.today;
  if (ago === 1) return ui.sidebar.days.yesterday;
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** Справа в строке: `сейчас` у идущей, время за сегодня и вчера, день недели за неделю, иначе `23.09`. */
export function whenLabel(s: Pick<SessionSummary, 'state' | 'updatedAt'>, now: number): string {
  if (s.state === 'live' || s.state === 'waiting') return ui.sidebar.now;
  const ago = daysAgo(s.updatedAt, now);
  if (ago <= 1) return clock(s.updatedAt);
  if (ago < 7) return WEEKDAYS_SHORT[new Date(s.updatedAt).getDay()]!;
  const d = new Date(s.updatedAt);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export interface DayGroup<T> {
  day: string;
  rows: T[];
}

/** Строки по дням: порядок входа сохраняется (список уже отсортирован по времени). */
export function groupByDay(
  rows: readonly SessionSummary[],
  now: number,
): DayGroup<SessionSummary>[] {
  const out: DayGroup<SessionSummary>[] = [];
  for (const s of rows) {
    const day = dayLabel(s.updatedAt, now);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(s);
    else out.push({ day, rows: [s] });
  }
  return out;
}

/** `131k`, `950`, `1.2M` — контекст в строке списка. */
export function tokensLabel(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** Колонка контекста в строке списка: `173k ctx`; неизвестен — пусто (ячейка остаётся для разметки). */
export function ctxLabel(s: Pick<SessionSummary, 'contextTokens'>): string {
  return s.contextTokens ? `${tokensLabel(s.contextTokens)} ${ui.sidebar.ctx}` : '';
}

/** Стоимость: нет данных — `—`, оценка без части моделей — с пометкой. */
export function costLabel(s: Pick<SessionSummary, 'costUsd' | 'costPartial'>): string {
  if (s.costUsd === undefined) return ui.sidebar.unknown;
  const base = formatCost(s.costUsd);
  return s.costPartial ? `${base} ${ui.sidebar.partialCost}` : base;
}

/**
 * Подпись под названием и подсказка строки: `14 ходов · $1.84 · 131k` и тег состояния (ждёт ответа, ошибка,
 * лимит). `withCtx: false` — контекст уже показан колонкой справа, во второй строке его нет.
 */
export function subLabel(s: SessionSummary, withCtx = true): string {
  const parts = [ui.empty.turns(s.turns), costLabel(s)];
  if (withCtx && s.contextTokens !== undefined && s.contextTokens > 0)
    parts.push(tokensLabel(s.contextTokens));
  if (s.state === 'waiting') parts.push(ui.sidebar.stateTag.waiting);
  else if (s.state === 'error') parts.push(ui.sidebar.stateTag.error);
  else if (s.state === 'limit') parts.push(ui.sidebar.stateTag.limit);
  return parts.join(' · ');
}

/** Классы строки `.s`: `cur` у сессии активной вкладки, `live` / `wait` / `err` по состоянию. */
export function rowClass(s: Pick<SessionSummary, 'state'>, current: boolean): string {
  const cls = ['s'];
  if (current) cls.push('cur');
  if (s.state === 'live') cls.push('live');
  else if (s.state === 'waiting') cls.push('wait');
  else if (s.state === 'error' || s.state === 'limit') cls.push('err');
  return cls.join(' ');
}

/** `2 ч 08 мин`, `45 мин`, `3 дн 4 ч` — до сброса окна. */
export function untilLabel(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч ${String(min % 60).padStart(2, '0')} мин`;
  return `${Math.floor(h / 24)} дн ${h % 24} ч`;
}

/** Когда сброс: сегодня — `в 17:00`, в ближайшие дни — `в четверг, 09:00`, иначе `23 сентября, 09:00`. */
export function resetWhen(resetsAt: number, now: number): string {
  const ago = -daysAgo(resetsAt, now);
  const d = new Date(resetsAt);
  if (ago <= 0) return `в ${clock(resetsAt)}`;
  if (ago < 7) return `в ${WEEKDAYS_LONG[d.getDay()]}, ${clock(resetsAt)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(resetsAt)}`;
}

export interface LimitRowView {
  key: string;
  label: string;
  percent: number;
  full: boolean;
  /** Пусто у неактивного окна без `resetsAt` — «0 %» без времени сброса. */
  note: string;
}

function limitNote(w: LimitWindow, now: number): string {
  if (w.resetsAt === undefined) return '';
  const when = ui.sidebar.resetAt(resetWhen(w.resetsAt, now));
  // «через 2 ч 08 мин» — только для сегодняшних сбросов (у недельных день недели яснее)
  return daysAgo(w.resetsAt, now) === 0 && w.resetsAt > now
    ? `${when} · ${ui.sidebar.resetIn(untilLabel(w.resetsAt - now))}`
    : when;
}

/** Строки «Аккаунт и лимиты»: 5 часов, неделя, затем недельные окна по модели. */
export function limitRows(windows: readonly LimitWindow[], now: number): LimitRowView[] {
  const order = (w: LimitWindow) => (w.kind === 'five-hour' ? 0 : w.kind === 'weekly' ? 1 : 2);
  return [...windows]
    .sort((a, b) => order(a) - order(b))
    .map((w): LimitRowView => {
      const percent = Math.max(0, Math.min(100, Math.round(w.percent)));
      const label =
        w.kind === 'five-hour'
          ? ui.sidebar.limitFive
          : w.kind === 'weekly'
            ? ui.sidebar.limitWeek
            : ui.sidebar.limitWeekModel(w.model ?? '?');
      return {
        key: w.kind === 'weekly-model' ? `weekly-model:${w.model ?? ''}` : w.kind,
        label,
        percent,
        full: percent >= 100,
        note: limitNote(w, now),
      };
    });
}
