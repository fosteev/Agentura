import type { TokenUsage } from '../agent/types';

/**
 * Цены Anthropic API, $ за миллион токенов. Нужны только для итогов сессий из транскриптов:
 * у живого хода стоимость считает сам движок (`result.total_cost_usd`, `modelUsage.costUSD`).
 *
 * Источник — таблица моделей справочника Claude API (снимок 2026-09-25): ввод и вывод, чтение
 * кэша там, где названо явно (Opus 5.5 и Sonnet 5.5 — $0.20, Fable 5.1 — $0.25). Остальное —
 * стандартные множители от цены ввода: чтение 0.1×, запись 5 мин 1.25×, запись 1 ч 2×.
 * Сверено с живым прогоном: Opus 5.5, 2 ввода + 13 472 чтения + 7 962 записи 1 ч + 88 вывода =
 * $0.0681584 (`modelUsage.costUSD` в `spikes/sdk-probe/logs/01-basic-control:66`).
 */
export const PRICING_DATE = '2026-09-25';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function price(input: number, output: number, cacheRead = input * 0.1): ModelPrice {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/**
 * Ключ — id модели без даты и суффиксов (`claude-opus-5-5`). Набор — каталог моделей CLI 2.1.285
 * (список `claude-*` в `sdk.mjs`). Цены старых моделей — прайс Anthropic на момент их выпуска:
 * Opus 4.0/4.1 $15/$75, Sonnet 3.5/3.7/4.0/4.5 $3/$15, Haiku 3.5 $0.80/$4.
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-mythos-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50),
  'claude-mythos-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-opus-4-5': price(5, 25),
  'claude-opus-4-1': price(15, 75),
  'claude-opus-4-0': price(15, 75),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-sonnet-4-5': price(3, 15),
  'claude-sonnet-4-0': price(3, 15),
  'claude-3-7-sonnet': price(3, 15),
  'claude-3-5-sonnet': price(3, 15),
  'claude-haiku-4-5': price(1, 5),
  'claude-3-5-haiku': price(0.8, 4),
};

/** Надбавка за `inference_geo: "us"` (запрос с привязкой к США) — ко всем токенам. */
export const US_GEO_MULTIPLIER = 1.1;
/** Веб-поиск: $10 за 1000 запросов. */
export const WEB_SEARCH_USD = 0.01;

/**
 * Модель из транскрипта → цена. Снимает суффиксы движка и провайдеров: `[1m]`, дату
 * (`-20251001`), `-latest`, префикс Bedrock (`anthropic.`, `us.anthropic.`), версию Bedrock
 * (`-v1:0`) и Vertex (`@…`); `claude-sonnet-4-20250514` → `claude-sonnet-4-0`.
 */
export function modelKey(model: string): string {
  const id = model
    .toLowerCase()
    .replace(/\[.*\]$/, '')
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-latest$/, '')
    .replace(/-\d{8}$/, '');
  // Первые Claude 4 назывались без минорной версии: `claude-sonnet-4-20250514` = `claude-sonnet-4-0`.
  return /^claude-(opus|sonnet)-4$/.test(id) ? `${id}-0` : id;
}

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES[modelKey(model)];
}

export interface CostExtras {
  /** `usage.inference_geo` ответа: `us` — надбавка `US_GEO_MULTIPLIER`. */
  inferenceGeo?: string;
  /** `usage.server_tool_use.web_search_requests`. */
  webSearchRequests?: number;
}

/**
 * Стоимость токенов по таблице. Запись кэша без разбивки по TTL считается по 5-минутной
 * цене; если разбивка есть — по ней. `undefined` — модель не знаем (показывать «—», не ноль).
 */
export function cost(
  usage: TokenUsage,
  model: string,
  extras: CostExtras = {},
): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const w1h = usage.cacheWrite1h ?? 0;
  const w5m = usage.cacheWrite5m ?? Math.max(0, usage.cacheWrite - w1h);
  const micro =
    usage.input * p.input +
    usage.output * p.output +
    usage.cacheRead * p.cacheRead +
    w5m * p.cacheWrite5m +
    w1h * p.cacheWrite1h;
  const geo = extras.inferenceGeo === 'us' ? US_GEO_MULTIPLIER : 1;
  return (micro * geo) / 1_000_000 + (extras.webSearchRequests ?? 0) * WEB_SEARCH_USD;
}
