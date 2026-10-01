import type { ToWebview } from '../protocol';

/**
 * Отладочная команда `agentura.debug.showState` (этап 7): прогоняет фикстуры состояний
 * (`test/fixtures/states/*.jsonl`) через те же сообщения, что шлёт живой хост, — владелец сверяет
 * экраны с прототипом без живого движка и без траты лимита.
 */
export const STATE_NAMES = ['empty', 'working', 'waiting', 'error', 'limited'] as const;
export type StateName = (typeof STATE_NAMES)[number];

export function isStateName(x: unknown): x is StateName {
  return typeof x === 'string' && (STATE_NAMES as readonly string[]).includes(x);
}

/**
 * В фикстуре моменты времени — `{"$now": <смещение в мс>}`: они подставляются как `now + смещение`,
 * иначе «сброс лимита в 17:00» в файле давно остался бы в прошлом и баннер не показался бы.
 */
export function resolveTimes(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveTimes(v, now));
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$now' && typeof o['$now'] === 'number') {
      return now + o['$now'];
    }
    return Object.fromEntries(keys.map((k) => [k, resolveTimes(o[k], now)]));
  }
  return value;
}

/** Строки jsonl → сообщения хоста; пустые строки пропускаются, битая строка — ошибка с номером. */
export function parseFixture(text: string, now: number): ToWebview[] {
  const out: ToWebview[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(resolveTimes(JSON.parse(line), now) as ToWebview);
    } catch (e) {
      throw new Error(`фикстура состояния, строка ${i + 1}: ${String(e)}`, { cause: e });
    }
  });
  return out;
}
