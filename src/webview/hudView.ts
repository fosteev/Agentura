/**
 * Вид приборов: из `HudState` и состояния чата — готовые к отрисовке значения (классы по
 * прототипу `hud.css`). Чистые функции: проверяются юнит-тестами, компоненты только выводят.
 */
import type { LimitWindow } from '../agent/types';
import {
  DEFAULT_CONTEXT_MAX,
  cacheExpiresAt,
  cacheHitRatio,
  cacheTtl,
  contextMax,
  type HudState,
  type TimelineSeg,
} from './hudState';
import { resetLabel } from './chatState';

export { resetLabel };
import {
  compactTokens,
  formatCost,
  formatDuration,
  formatInt,
  toolView,
} from './toolView';
import { ui } from './strings';

export type Zone = 'ok' | 'warn' | 'hot' | 'full';

/** Число блоков шкалы контекста. */
export const BLOCK_COUNT = 20;

/** Конец шкалы, с которого цвет «полный»: порог автосжатия движка, иначе окно. */
export function contextFullAt(autoCompact: number | undefined, max: number): number {
  return autoCompact !== undefined && autoCompact > 0 ? Math.min(autoCompact, max) : max;
}

/**
 * Длина шкалы (решение приёмки этапа 4): окно, но не больше «последний порог / 0,75» и не меньше
 * 200k. На окне 200k — как в прототипе (150k на 15-м блоке из 20), на окне 1M — те же 0–200k, иначе
 * абсолютные пороги 120k/150k сжимаются в 3-й блок и шкала всегда зелёная. Число «N / окно» — полное.
 */
export function contextScale(max: number, thresholds: readonly number[]): number {
  const top = Math.max(0, ...thresholds);
  if (top === 0) return max; // нет порогов (Codex) — шкала на всё окно
  return Math.min(max, Math.max(DEFAULT_CONTEXT_MAX, Math.ceil(top / 0.75)));
}

/** Зона контекста: до первого порога — ok, до второго — warn, до конца — hot, дальше — full. */
export function contextZone(used: number, thresholds: readonly number[], fullAt: number): Zone {
  const [warn = Infinity, hot = Infinity] = [...thresholds].sort((a, b) => a - b);
  if (used >= fullAt) return 'full';
  if (used >= hot) return 'hot';
  if (used >= warn) return 'warn';
  return 'ok';
}

const ZONE_BLOCK: Record<Zone, string> = { ok: '', warn: ' w', hot: ' h', full: ' f' };
const ZONE_VAR: Record<Zone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  hot: 'var(--hot)',
  full: 'var(--full)',
};

export interface Block {
  /** Класс `<i>` по `hud.css`: `on`, `on w|h|f`, `part`, `t` (метка порога). */
  cls: string;
  /** Частично залитый блок: цвет и ширина заливки. */
  style?: Record<string, string>;
}

/**
 * 20 блоков шкалы по `max/20` токенов. Цвет блока — зона его начала (как в прототипе: блок 12
 * при 200k — первый «жёлтый»), метка `t` — на блоке, в конце которого лежит порог.
 */
export function contextBlocks(
  used: number,
  max: number,
  thresholds: readonly number[],
  fullAt: number,
): Block[] {
  const step = max / BLOCK_COUNT;
  const marks = new Set(
    thresholds.filter((t) => t > 0 && t < max).map((t) => Math.ceil(t / step - 1e-9) - 1),
  );
  const filled = Math.min(BLOCK_COUNT, Math.max(0, Math.floor(used / step + 1e-9)));
  const blocks: Block[] = [];
  for (let i = 0; i < BLOCK_COUNT; i++) {
    const t = marks.has(i) ? ' t' : '';
    const zone = contextZone(i * step, thresholds, fullAt);
    if (i < filled) blocks.push({ cls: `on${ZONE_BLOCK[zone]}${t}` });
    else if (i === filled && used > 0 && filled < BLOCK_COUNT) {
      const frac = (used - i * step) / step;
      blocks.push({
        cls: `part${t}`,
        style: {
          '--c': ZONE_VAR[contextZone(used, thresholds, fullAt)],
          '--w': `${Math.max(6, Math.round(frac * 100))}%`,
        },
      });
    } else blocks.push({ cls: t.trim() });
  }
  return blocks;
}

export function kilo(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

export interface ContextView {
  now: string;
  max: string;
  /** Класс числа: `ok`, `zero`, пусто (жёлтый по умолчанию), `hot`, `full`. */
  numCls: string;
  zone: Zone;
  /** Заполнение до автосжатия, 0…100 (`used / fullAt`): кольцо, % и кромка раскладок поля. */
  percent: number;
  /** Заполнение шкалы (`used / scale`), 0…100 — полоса `ContextBar`. */
  fill: number;
  /** Пороги на шкале, 0…100 (`порог / scale`) — засечки `ContextBar`. */
  marks: number[];
  /** Цвет зоны (`var(--ok|warn|hot|full)`). */
  color: string;
  /** `131k/200k`. */
  short: string;
  blocks: Block[];
  /** «порог 150k пройден» — когда перешагнули второй порог. */
  note?: string;
  /** Идёт сжатие контекста — рядом с числом «сжимаю…». */
  compacting: boolean;
  title: string;
}

export function contextView(s: HudState): ContextView {
  const used = s.context?.used ?? 0;
  const max = contextMax(s);
  const fullAt = contextFullAt(s.context?.autoCompact, max);
  const zone = contextZone(used, s.thresholds, fullAt);
  const scale = contextScale(max, s.thresholds);
  const sorted = [...s.thresholds].sort((a, b) => a - b);
  const passed = [...sorted].reverse().find((t) => used >= t);
  return {
    now: formatInt(used),
    max: formatInt(max),
    numCls: used === 0 ? 'zero' : zone === 'warn' ? '' : zone,
    zone,
    percent: fullAt > 0 ? Math.max(0, Math.min(100, Math.round((used / fullAt) * 100))) : 0,
    fill: scale > 0 ? Math.max(0, Math.min(100, (used / scale) * 100)) : 0,
    // как метки в contextBlocks: только пороги внутри шкалы
    marks: sorted.filter((t) => t > 0 && t < scale).map((t) => (t / scale) * 100),
    color: ZONE_VAR[zone],
    short: `${kilo(used)}/${kilo(max)}`,
    blocks: contextBlocks(used, scale, s.thresholds, fullAt),
    ...(passed !== undefined && zone !== 'ok'
      ? { note: ui.compose.thresholdPassed(kilo(passed)) }
      : {}),
    compacting: !!s.compacting,
    title:
      sorted.length === 0
        ? ui.compose.ctxTitleOpen(kilo(max))
        : ui.compose.ctxTitle(sorted.map(kilo), kilo(fullAt), scale < max ? kilo(scale) : undefined),
  };
}

/** `04:12`, `1:00:00`; нулевое и отрицательное — `00:00`. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export interface CacheView {
  /** Остаток до истечения, `истёк` или `—` (кэша ещё нет). */
  time: string;
  hit: string;
  expired: boolean;
  /** Доля оставшегося TTL, 0…1 — угол «часов». */
  left: number;
  title: string;
}

export function cacheView(s: HudState, now: number): CacheView {
  const hitRatio = cacheHitRatio(s.totals);
  const hit = hitRatio === undefined ? '—' : `${Math.round(hitRatio * 100)}%`;
  const exp = cacheExpiresAt(s);
  if (exp === undefined)
    return { time: '—', hit, expired: false, left: 0, title: ui.compose.cacheTitle('—') };
  const ttl = cacheTtl(s);
  const remain = exp - now;
  if (remain <= 0) {
    return {
      time: ui.compose.cacheExpired,
      hit,
      expired: true,
      left: 0,
      title: ui.compose.cacheTitle(formatDuration(ttl)),
    };
  }
  return {
    time: formatCountdown(remain),
    hit,
    expired: false,
    left: Math.min(1, remain / ttl),
    title: ui.compose.cacheTitle(ttl >= 3_600_000 ? ui.time.oneHour : ui.time.minutes(Math.round(ttl / 60_000))),
  };
}

/** Кэш жив и таймер надо тикать. */
export function cacheLive(s: HudState, now: number): boolean {
  const exp = cacheExpiresAt(s);
  return exp !== undefined && exp > now;
}

/** Цвет лимита по проценту — как `level()` в `prototype/shared/limits.js`: >85 красный, >70 жёлтый. */
export function limitLevel(percent: number): 'lim-hot' | 'lim-warn' | 'lim-full' {
  return percent > 85 ? 'lim-full' : percent > 70 ? 'lim-warn' : 'lim-hot';
}

export interface LimitMeter {
  percent: number;
  /** Заполненных ячеек из 10. */
  cells: number;
  level: 'lim-hot' | 'lim-warn' | 'lim-full';
  /** 100 %: ячейки и число красные (`.f`, `.full`). */
  full: boolean;
  resetsAt?: number;
}

export function limitMeter(w: LimitWindow | undefined): LimitMeter | undefined {
  if (!w) return undefined;
  const percent = Math.max(0, Math.min(100, Math.round(w.percent)));
  return {
    percent,
    cells: Math.round(percent / 10),
    level: limitLevel(percent),
    full: percent >= 100,
    ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
  };
}

export interface LimitsView {
  five?: LimitMeter;
  week?: LimitMeter;
  title: string;
}

export function limitsView(windows: readonly LimitWindow[], now: number): LimitsView {
  const five = limitMeter(windows.find((w) => w.kind === 'five-hour'));
  const week = limitMeter(windows.find((w) => w.kind === 'weekly'));
  const parts: string[] = [];
  if (five) {
    parts.push(
      `${ui.compose.fiveHourWindow}${five.resetsAt !== undefined ? ` · ${ui.sidebar.resetAt(resetLabel(five.resetsAt, now))}` : ''}`,
    );
  }
  if (week) {
    parts.push(
      `${ui.compose.week} ${week.percent}%${week.resetsAt !== undefined ? ` · ${ui.sidebar.resetAt(resetLabel(week.resetsAt, now))}` : ''}`,
    );
  }
  return {
    ...(five ? { five } : {}),
    ...(week ? { week } : {}),
    title: parts.join('\n') || ui.compose.limitsUnknown,
  };
}

// ——— цвета сегментов таймлайна (деталь агента) ———

export function segClass(g: TimelineSeg): string | undefined {
  if (g.kind === 'think') return 'th';
  if (g.kind === 'text') return 'tx';
  const op = toolView(g.name ?? '', g.input ?? {}).op;
  if (op === 'edit' || op === 'write') return 'ed';
  if (op === 'bash') return 'rn';
  return undefined;
}

// ——— панель «агенты» ———

export { compactTokens };

export function sessionTotals(s: HudState): { label: string; value: string }[] {
  const t = s.totals;
  const hit = cacheHitRatio(t);
  return [
    {
      label: ui.agents.totalCost,
      value:
        t.turns === 0
          ? '—'
          : t.costPartial
            ? `${formatCost(t.costUsd)} ${ui.agents.costPartial}`
            : formatCost(t.costUsd),
    },
    { label: ui.agents.totalTurns, value: String(t.turns) },
    { label: ui.agents.totalTime, value: t.turns > 0 ? formatDuration(t.durationMs) : '—' },
    { label: ui.agents.totalCache, value: hit === undefined ? '—' : `${Math.round(hit * 100)}%` },
  ];
}
