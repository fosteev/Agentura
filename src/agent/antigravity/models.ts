import { execFile } from 'node:child_process';
import type { EffortLevel, ModelOption } from '../types';
import { stripAgySpinnerLine } from './executable';

/**
 * Модель по умолчанию, если расширение не передало свою: `--model` agy обязателен (без него ход может висеть).
 * Уровень — часть id; `medium` — середина между ценой квоты и качеством.
 */
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-medium';

/** Вывод `agy models`: строка «Fetching available models…» (возможен `\r`-спиннер), затем `id<TAB>Название` на модель. */
export function parseModels(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const rawLine of output.split('\n')) {
    const line = stripAgySpinnerLine(rawLine);
    const m = /^(\S+)(?:\t| {2,})(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2] && !m[1].includes('Fetching') && !m[2].includes('Fetching')) {
      models.push({ value: m[1], displayName: m[2], supportsEffort: false });
    }
  }
  return models;
}

/**
 * Каталог базовых моделей Antigravity для настроек: схлопывает 13 склеенных записей `agy models`
 * (суффиксы -low, -medium, -high) в базовые модели с поддержкой effortLevels.
 */
export function parseAgyModels(output: string): ModelOption[] {
  const raw = parseModels(output);
  const map = new Map<string, { displayName: string; efforts: EffortLevel[] }>();

  for (const item of raw) {
    if (item.value === 'gpt-oss-120b-medium') {
      map.set(item.value, { displayName: item.displayName, efforts: [] });
      continue;
    }
    const match = /^(.*?)-(low|medium|high)$/.exec(item.value);
    if (match) {
      const base = match[1]!;
      const effort = match[2] as EffortLevel;
      const cleanName = item.displayName.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, '');
      const existing = map.get(base);
      if (existing) {
        if (!existing.efforts.includes(effort)) existing.efforts.push(effort);
      } else {
        map.set(base, { displayName: cleanName, efforts: [effort] });
      }
    } else {
      map.set(item.value, { displayName: item.displayName, efforts: [] });
    }
  }

  const result: ModelOption[] = [];
  for (const [value, entry] of map.entries()) {
    result.push({
      value,
      displayName: entry.displayName,
      supportsEffort: entry.efforts.length > 0,
      ...(entry.efforts.length ? { effortLevels: entry.efforts } : {}),
    });
  }
  return result;
}

export type RunModels = (path: string) => Promise<string>;

const defaultRun: RunModels = (path) =>
  new Promise((resolve, reject) => {
    execFile(path, ['models'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** Загружает каталог базовых моделей Antigravity через `agy models`. */
export async function loadAntigravityCatalog(path: string, run: RunModels = defaultRun): Promise<ModelOption[]> {
  return parseAgyModels(await run(path));
}

/** `agy models` → список. Пусто — agy не ответил или формат сменился (вызывающий не кэширует). */
export async function listAgyModels(path: string, run: RunModels = defaultRun): Promise<ModelOption[]> {
  return parseModels(await run(path));
}

/**
 * Размер контекстного окна модели Antigravity по её идентификатору.
 * Снимает суффикс `-(low|medium|high)` в конце строки (регистронезависимо, с `trim()`).
 * Для `gemini-*` возвращает 1_000_000, для `claude-*` — 200_000, для `gpt-oss-120b*` — 128_000.
 * Для любых прочих или пустых ID возвращает undefined.
 */
export function agyContextWindow(model: string): number | undefined {
  const clean = model.trim().replace(/-(low|medium|high)$/i, '');
  if (!clean) return undefined;
  if (/^gemini-/i.test(clean)) return 1_000_000;
  if (/^claude-/i.test(clean)) return 200_000;
  if (/^gpt-oss-120b/i.test(clean)) return 128_000;
  return undefined;
}
