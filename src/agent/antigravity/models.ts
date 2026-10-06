import { execFile } from 'node:child_process';
import type { ModelOption } from '../types';

/**
 * Модель по умолчанию, если расширение не передало свою: `--model` agy обязателен (без него ход может висеть).
 * Уровень — часть id; `medium` — середина между ценой квоты и качеством.
 */
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-medium';

/** Вывод `agy models`: строка «Fetching available models…», затем `id<TAB>Название` на модель. */
export function parseModels(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of output.split('\n')) {
    const m = /^(\S+)\t(.+?)\s*$/.exec(line.replace(/\r$/, ''));
    if (m?.[1] && m[2]) models.push({ value: m[1], displayName: m[2], supportsEffort: false });
  }
  return models;
}

export type RunModels = (path: string) => Promise<string>;

const defaultRun: RunModels = (path) =>
  new Promise((resolve, reject) => {
    execFile(path, ['models'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** `agy models` → список. Пусто — agy не ответил или формат сменился (вызывающий не кэширует). */
export async function listAgyModels(path: string, run: RunModels = defaultRun): Promise<ModelOption[]> {
  return parseModels(await run(path));
}
