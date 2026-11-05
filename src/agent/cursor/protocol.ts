/**
 * Подмножество ACP Cursor CLI, снятое спайком 2026-11-05.
 * Версия бинарника фикстуры `test/fixtures/cursor/acp-pong.ndjson`: 2026.11.05-86047df.
 * Кадры — docs/spikes/cursor-acp/report.md. Это не полная схема ACP.
 *
 * `jsonrpc` на живых кадрах есть и равен `"2.0"` в обе стороны.
 * Сентинелы `_modelsCount`, `_optionsCount`, `_commandsCount` — обрезка фикстуры, не поля протокола.
 */

import type { ModelOption } from '../types';

/** Версия CLI, с которой снята фикстура. Резолвер принимает любой такой штамп, не только этот. */
export const CURSOR_FIXTURE_CLI = '2026.11.05-86047df';

/** `agent --version` / `agent about`: `2026.11.05-86047df`. Чужой `agent` так не представляется. */
export const CURSOR_VERSION_RE = /(?:^|[\s:])(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\b/;

export function parseCursorVersion(output: string): string | undefined {
  return CURSOR_VERSION_RE.exec(output)?.[1];
}

export const JSONRPC = '2.0' as const;
export const PROTOCOL_VERSION = 1;
export const AUTH_METHOD = 'cursor_login';

/** Известное разрешение до этапа 3: клиент отвечает отказом, ход не ждёт карточку. */
export const PERMISSION_METHOD = 'session/request_permission';

/**
 * Отказ на `session/request_permission` формой, которую сервер принял:
 * `{outcome:{outcome:"selected", optionId}}`. `reject-once` — optionId из того же кадра.
 * Голую строку и `outcome:"rejected"` (это ответ на `cursor/create_plan`) сюда не подставляем.
 */
export function permissionRefusal(): {
  outcome: { outcome: 'selected'; optionId: 'reject-once' };
} {
  return { outcome: { outcome: 'selected', optionId: 'reject-once' } };
}

export interface CursorModel {
  modelId: string;
  name: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Модели из `session/new` / `session/load`: `models.availableModels[]` (`modelId`, `name`).
 * Элемент без `modelId` (сентинел `_modelsCount`) — не модель. `configOptions` не читаем.
 */
export function modelsFrom(result: unknown): ModelOption[] {
  const list = record(record(result)?.models)?.availableModels;
  if (!Array.isArray(list)) return [];
  const out: ModelOption[] = [];
  for (const item of list) {
    const row = record(item);
    const id = row?.modelId;
    if (typeof id !== 'string' || !id) continue;
    const name = row?.name;
    out.push({ value: id, displayName: typeof name === 'string' && name ? name : id });
  }
  return out;
}

export function currentModelId(result: unknown): string | undefined {
  const id = record(record(result)?.models)?.currentModelId;
  return typeof id === 'string' && id ? id : undefined;
}

export function sessionIdOf(result: unknown): string | undefined {
  const id = record(result)?.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Текст `content:{type:"text",text}` у chunk-обновлений. Нет текста — пусто. */
export function chunkText(update: unknown): string {
  const content = record(update)?.content;
  const row = record(content);
  if (row?.type !== 'text' || typeof row.text !== 'string' || !row.text) return '';
  return row.text;
}

export function sessionUpdateKind(update: unknown): string | undefined {
  const kind = record(update)?.sessionUpdate;
  return typeof kind === 'string' ? kind : undefined;
}

export function stopReasonOf(result: unknown): string | undefined {
  const reason = record(result)?.stopReason;
  return typeof reason === 'string' && reason ? reason : undefined;
}
