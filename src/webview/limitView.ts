/**
 * Лимит исчерпан (этап 7, экран limit): когда блокировать отправку и что написать в баннере.
 * Чистая логика без Preact. Лимит общий на аккаунт, поэтому блокировку даёт не только своя сессия
 * (`limit.update rejected`, ошибка `limit`), но и данные подписки (`limits.update`, рассылаются во все вкладки):
 * окно на 100 % с будущим сбросом блокирует любую вкладку.
 */
import type { LimitWindow } from '../agent/types';
import type { ChatStatus } from '../agent/status';
import { resetLabel } from './hudView';
import { ui } from './strings';

export interface LimitBlock {
  kind: 'five-hour' | 'weekly' | 'weekly-model' | 'unknown';
  model?: string;
  /** Момент сброса, мс; нет — неизвестен (разблокирует только «Попробовать снова»). */
  until?: number;
  /** Недельное окно свободно на столько процентов (если оно не исчерпано). */
  weekFree?: number;
  /**
   * Блокировка по данным подписки (`limits.update`), а не по отказу движка: данные бывают устаревшими,
   * а с докупленным расходом (extra usage) движок примет и при 100 % — человек может попробовать.
   */
  soft?: boolean;
}

export interface LimitInput {
  /** Состояние чата этой вкладки: `limited` — свой ход упёрся в лимит. */
  status: ChatStatus;
  /** Сброс из `limit.update rejected` своей сессии. */
  resetsAt?: number | undefined;
  /** Окна подписки (`limits.update`) или движка. */
  windows: readonly LimitWindow[];
  /** Сброс окна подписки, блокировку по которому человек снял «Попробовать снова». */
  dismissed?: number | undefined;
}

/** Допуск при сопоставлении сброса события с окном подписки: оба — «через N часов», с точностью до минуты. */
const SAME_RESET_MS = 90_000;

export function limitBlock(input: LimitInput, now: number): LimitBlock | undefined {
  const { dismissed } = input;
  // недельное окно отдельной модели общий запрет не даёт: другие модели работают; если упрётся своя
  // сессия — блокировку даст её отказ (`status: limited`)
  const full = input.windows
    .filter(
      (w) =>
        w.kind !== 'weekly-model' &&
        w.percent >= 100 &&
        w.resetsAt !== undefined &&
        w.resetsAt > now &&
        !(dismissed !== undefined && Math.abs(w.resetsAt - dismissed) <= SAME_RESET_MS),
    )
    .sort((a, b) => b.resetsAt! - a.resetsAt!)[0];
  const week = input.windows.find((w) => w.kind === 'weekly');
  const weekFree =
    week && week.percent < 100 ? { weekFree: Math.max(0, Math.round(100 - week.percent)) } : {};
  const own =
    input.status === 'limited' && !(input.resetsAt !== undefined && input.resetsAt <= now);
  if (full) {
    return {
      kind: full.kind,
      ...(full.model ? { model: full.model } : {}),
      until: full.resetsAt!,
      ...(full.kind !== 'weekly' ? weekFree : {}),
      ...(own ? {} : { soft: true }),
    };
  }
  if (!own) return undefined;
  const match = input.windows.find(
    (w) =>
      input.resetsAt !== undefined &&
      w.resetsAt !== undefined &&
      Math.abs(w.resetsAt - input.resetsAt) <= SAME_RESET_MS,
  );
  return {
    kind: match?.kind ?? 'unknown',
    ...(match?.model ? { model: match.model } : {}),
    ...(input.resetsAt !== undefined ? { until: input.resetsAt } : {}),
    ...weekFree,
  };
}

/** `2 ч 04 мин`, `37 мин`, `меньше минуты`. */
export function leftLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 60_000));
  if (total < 1) return 'меньше минуты';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`;
}

export interface LimitBanner {
  title: string;
  detail: string;
  /** Сброс неизвестен или блокировка по данным подписки — кнопка «Попробовать снова». */
  canRetry: boolean;
}

export function limitBanner(b: LimitBlock, now: number): LimitBanner {
  const title =
    b.kind === 'five-hour'
      ? ui.limit.bannerFive
      : b.kind === 'weekly'
        ? ui.limit.bannerWeek
        : b.kind === 'weekly-model'
          ? ui.limit.bannerWeekModel(b.model ?? '')
          : ui.limit.bannerGeneric;
  const parts: string[] = [];
  parts.push(
    b.until !== undefined
      ? ui.limit.resetsAt(resetLabel(b.until, now), leftLabel(b.until - now))
      : ui.limit.resetUnknown,
  );
  if (b.weekFree !== undefined) parts.push(ui.limit.weekFree(b.weekFree));
  return { title, detail: parts.join(' '), canRetry: b.until === undefined || !!b.soft };
}

/** Подпись под полем ввода: «отправка отложена до 17:00». */
export function deferredNote(b: LimitBlock, now: number): string {
  return b.until !== undefined
    ? ui.limit.deferred(resetLabel(b.until, now))
    : ui.limit.deferredUnknown;
}
