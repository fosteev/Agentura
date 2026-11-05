/**
 * Подмножество ACP Cursor CLI, снятое спайком 2026-11-05.
 * Версия бинарника фикстуры `test/fixtures/cursor/acp-pong.ndjson`: 2026.11.05-86047df.
 * Кадры — docs/spikes/cursor-acp/report.md. Это не полная схема ACP.
 *
 * `jsonrpc` на живых кадрах есть и равен `"2.0"` в обе стороны.
 * Сентинелы `_modelsCount`, `_optionsCount`, `_commandsCount` — обрезка фикстуры, не поля протокола.
 */

import type { ModelOption, PermissionDecision, PermissionMode } from '../types';

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

/** `session/request_permission`. Клиент отвечает сам, если адаптер не забрал запрос. */
export const PERMISSION_METHOD = 'session/request_permission';

export const PLAN_METHOD = 'cursor/create_plan';
export const QUESTION_METHOD = 'cursor/ask_question';

/** Уведомления Cursor: в ленту не идут. */
export const CURSOR_DEBUG_METHODS = ['cursor/task', 'cursor/update_todos', 'cursor/generate_image'] as const;

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

/** `modes.currentModeId` из `session/new` / `session/load`. Нет поля — режим не сообщён. */
export function currentModeId(result: unknown): string | undefined {
  const id = record(record(result)?.modes)?.currentModeId;
  return typeof id === 'string' && id ? id : undefined;
}

/** `plan` → `plan`, остальное (`default`, `acceptEdits`, `bypassPermissions`) → `agent`. */
export function cursorModeId(mode: PermissionMode): 'agent' | 'plan' {
  return mode === 'plan' ? 'plan' : 'agent';
}

/**
 * Имя инструмента как у сервера: `kind` (`read` | `search` | `edit` | `execute`).
 * `other` с `rawInput._toolName` — это имя (`createPlan`). Неизвестный kind — сырая строка kind.
 * Id вызова сюда не входит: его берёт маппер из `toolCallId` кадра и не синтезирует.
 */
export function cursorToolName(source: unknown): string {
  const row = record(source);
  const kind = typeof row?.kind === 'string' ? row.kind : '';
  const named = namedTool(row?.rawInput);
  if (kind === 'other' && named) return named;
  if (kind) return kind;
  if (named) return named;
  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  return title || 'tool';
}

/** `rawInput` объекта. Нет объекта — пустой input, не выдуманные поля. */
export function cursorToolInput(source: unknown): Record<string, unknown> {
  const raw = record(record(source)?.rawInput);
  return raw ? { ...raw } : {};
}

const OPTION_SLOT = {
  allow: { kind: 'allow_once', id: 'allow-once' },
  'allow-always': { kind: 'allow_always', id: 'allow-always' },
  deny: { kind: 'reject_once', id: 'reject-once' },
} as const;

function listedOptions(options: unknown): { optionId: string; kind?: string }[] {
  if (!Array.isArray(options)) return [];
  const out: { optionId: string; kind?: string }[] = [];
  for (const item of options) {
    const row = record(item);
    const optionId = row?.optionId;
    if (typeof optionId !== 'string' || !optionId) continue;
    const kind = typeof row.kind === 'string' ? row.kind : undefined;
    out.push(kind ? { optionId, kind } : { optionId });
  }
  return out;
}

function optionIdOf(options: unknown, slot: keyof typeof OPTION_SLOT): string | undefined {
  const spec = OPTION_SLOT[slot];
  return listedOptions(options).find((option) => option.kind === spec.kind || option.optionId === spec.id)?.optionId;
}

/** В кадре была опция «всегда» (`allow-always` / `allow_always`). */
export function permissionHasAlways(options: unknown): boolean {
  return optionIdOf(options, 'allow-always') !== undefined;
}

/**
 * Ответ `respondPermission` из option id кадра.
 * `allow` и `allow-edits` → один раз. `allow-always` → всегда, только если такая опция была, иначе один раз.
 * `deny` → отказ. Нет нужной опции — id из спайка (`allow-once` / `reject-once`), чтобы ход не завис.
 */
export function permissionOutcome(
  options: unknown,
  decision: PermissionDecision,
): { outcome: { outcome: 'selected'; optionId: string } } {
  const once = optionIdOf(options, 'allow');
  const always = optionIdOf(options, 'allow-always');
  const reject = optionIdOf(options, 'deny');
  const optionId =
    decision === 'deny'
      ? (reject ?? 'reject-once')
      : decision === 'allow-always'
        ? (always ?? once ?? 'allow-once')
        : (once ?? 'allow-once');
  return { outcome: { outcome: 'selected', optionId } };
}

/** `cursor/create_plan`: одобрение из доков, отказ — как в кадре спайка (`rejected` + `reason`). */
export function planOutcome(decision: {
  approve: boolean;
  feedback?: string;
}): { outcome: { outcome: 'accepted' } } | { outcome: { outcome: 'rejected'; reason: string } } {
  if (decision.approve) return { outcome: { outcome: 'accepted' } };
  const reason = decision.feedback && decision.feedback.trim() ? decision.feedback : 'rejected';
  return { outcome: { outcome: 'rejected', reason } };
}

/**
 * `cursor/ask_question` спайк не видел. Форма пропуска — из доков CLI (`outcome: "skipped"`), не из кадра.
 */
export function questionSkipped(): { outcome: { outcome: 'skipped' } } {
  return { outcome: { outcome: 'skipped' } };
}

function namedTool(raw: unknown): string {
  const name = record(raw)?._toolName;
  return typeof name === 'string' && name.trim() ? name : '';
}
