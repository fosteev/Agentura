/**
 * Доступ к полям сообщений SDK без доверия к типам: часть полей в `sdk.d.ts` не описана
 * (`unifiedWindows`, `session_title_changed`), форма меняется между версиями CLI.
 */
export type Json = Record<string, unknown>;

export function isObj(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function obj(value: unknown): Json | undefined {
  return isObj(value) ? value : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function strings(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === 'string');
}

/** ISO-время сообщения → мс. */
export function timestamp(value: unknown): number | undefined {
  const s = str(value);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Структурный результат инструмента (`tool_use_result`) без данных картинки: у `Read` картинки это
 * `{type: 'image', file: {base64, type, originalSize, dimensions}}`, а лента показывает только плашку
 * `[image]` из текста результата. Копия base64 лишь раздувала бы postMessage и память webview.
 */
export function withoutImageData(result: unknown): unknown {
  // `Read` pdf устроен так же (`{type: 'pdf', file: {base64, …}}`) — тоже без копии данных
  if (!isObj(result) || (result['type'] !== 'image' && result['type'] !== 'pdf')) return result;
  const file = obj(result['file']);
  if (!file || typeof file['base64'] !== 'string') return result;
  const { base64: _data, ...rest } = file;
  void _data;
  return { ...result, file: { ...rest, dataOmitted: true } };
}
