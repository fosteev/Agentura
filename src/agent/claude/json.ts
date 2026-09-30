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
