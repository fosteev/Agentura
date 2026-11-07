/**
 * Подмножество ACP `agy acp` (Antigravity CLI 1.5.x), снятое спайком 2026-11-07.
 * Источник контракта — `docs/spikes/antigravity-acp/report.md` и `test/fixtures/antigravity/acp-pong.ndjson`.
 * Это не полная схема ACP. Строки фикстуры обёрнуты (`dir`, `scenario`, `msg`): `msg` — реальный кадр.
 *
 * Отличия от Cursor ACP: серверные запросы приходят со строковым `id`; отказ в разрешении — `optionId` по
 * `kind: "reject_once"` (`deny`); `model`, `thought_level` и `mode` — три независимых селекта `configOptions`;
 * `session/prompt` возвращает `usage`; вопросы идут через `elicitation/create`, если клиент объявил `elicitation.form`.
 */

import type { EffortLevel, ImageMediaType, ModelOption, PermissionMode, PromptImage, Question } from '../types';

export const AGY_PROTOCOL_VERSION = 1;

/** `initialize`: без `elicitation.form` `ask_question` повисает до следующего `session/prompt` и перехватывает его. */
export const AGY_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
} as const;

export const ELICITATION_METHOD = 'elicitation/create';

/** Уровни `thought_level`, которые знает Agentura (`EffortLevel` шире: `xhigh`/`max` у agy нет). */
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function sessionIdOf(result: unknown): string | undefined {
  return text(record(result)?.sessionId);
}

export function sessionUpdateKind(update: unknown): string | undefined {
  return text(record(update)?.sessionUpdate);
}

export function stopReasonOf(result: unknown): string | undefined {
  return text(record(result)?.stopReason);
}

/** `modes.currentModeId` из `session/new` / `session/resume`. */
export function currentModeId(result: unknown): string | undefined {
  return text(record(record(result)?.modes)?.currentModeId);
}

/** Текст `content:{type:"text",text}` у chunk-обновлений. Нет текста — пусто. */
export function chunkText(update: unknown): string {
  const row = record(record(update)?.content);
  if (row?.type !== 'text' || typeof row.text !== 'string') return '';
  return row.text;
}

/** `session_info_update.title`. Пусто, пробелы и не-строка — названия нет. */
export function sessionTitleOf(update: unknown): string | undefined {
  const title = record(update)?.title;
  return typeof title === 'string' ? title.trim() || undefined : undefined;
}

/** Тариф аккаунта: `_meta.antigravity.tier.name` из `session/new` / `session/resume`. */
export function tierNameOf(result: unknown): string | undefined {
  return text(record(record(record(record(result)?._meta)?.antigravity)?.tier)?.name);
}

/** `agy --version`: `agentInfo.version` ответа `initialize`. */
export function agentVersionOf(result: unknown): string | undefined {
  return text(record(record(result)?.agentInfo)?.version);
}

// ---- configOptions: model / thought_level / mode -----------------------------------------------------------

export interface AgySelect {
  /** `currentValue` селекта на момент ответа сервера. */
  current: string;
  values: { value: string; name: string }[];
}

export interface AgyConfig {
  model?: AgySelect;
  /** Нет у модели без уровней (`gpt-oss-120b-medium`): слать `thought_level` нельзя (`-32602`). */
  thoughtLevel?: AgySelect;
  mode?: AgySelect;
  /** `models.availableModels[].modelId`: 13 склеенных id вида `gemini-4-argon-low`. Нужны только для вывода уровней. */
  combinedIds: string[];
}

function selectOf(options: unknown, id: string): AgySelect | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const item of options) {
    const row = record(item);
    if (row?.id !== id) continue;
    const current = text(row.currentValue);
    const values: AgySelect['values'] = [];
    for (const option of Array.isArray(row.options) ? row.options : []) {
      const o = record(option);
      const value = text(o?.value);
      if (value) values.push({ value, name: text(o?.name) ?? value });
    }
    return { current: current ?? '', values };
  }
  return undefined;
}

/** Результат `session/new` / `session/resume` (`configOptions` и `models`) или `session/set_config_option` (`configOptions`). */
export function parseConfig(result: unknown): AgyConfig {
  const row = record(result);
  const combined: string[] = [];
  const available = record(row?.models)?.availableModels;
  for (const item of Array.isArray(available) ? available : []) {
    const id = text(record(item)?.modelId);
    if (id) combined.push(id);
  }
  const config: AgyConfig = { combinedIds: combined };
  const model = selectOf(row?.configOptions, 'model');
  const thought = selectOf(row?.configOptions, 'thought_level');
  const mode = selectOf(row?.configOptions, 'mode');
  if (model) config.model = model;
  if (thought) config.thoughtLevel = thought;
  if (mode) config.mode = mode;
  return config;
}

/**
 * Ответ `set_config_option` не повторяет `models`: список склеенных id и текущее состояние не теряем, а селекты
 * берём из ответа целиком — отсутствие `thought_level` в нём означает «у модели уровней нет».
 */
export function mergeConfig(prev: AgyConfig, next: AgyConfig): AgyConfig {
  const merged: AgyConfig = { combinedIds: next.combinedIds.length ? next.combinedIds : prev.combinedIds };
  if (next.model ?? prev.model) merged.model = (next.model ?? prev.model)!;
  if (next.thoughtLevel) merged.thoughtLevel = next.thoughtLevel;
  if (next.mode ?? prev.mode) merged.mode = (next.mode ?? prev.mode)!;
  return merged;
}

export function isEffort(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Базовые модели из селекта `model` (5 штук), а не 13 склеенных id. Уровни модели — суффиксы `-low|-medium|-high`
 * среди `availableModels` (у `gpt-oss-120b-medium` их нет → `supportsEffort: false`). Нет `availableModels` —
 * уровни текущего селекта `thought_level` только у текущей модели.
 */
export function modelOptionsFrom(config: AgyConfig): ModelOption[] {
  const select = config.model;
  if (!select) return [];
  const out: ModelOption[] = [];
  for (const { value, name } of select.values) {
    let levels: EffortLevel[];
    if (config.combinedIds.length) {
      levels = EFFORT_LEVELS.filter((level) => config.combinedIds.includes(`${value}-${level}`));
    } else {
      levels = value === select.current && config.thoughtLevel ? levelsOf(config.thoughtLevel) : [];
    }
    out.push({
      value,
      displayName: name,
      supportsEffort: levels.length > 0,
      ...(levels.length ? { effortLevels: levels } : {}),
    });
  }
  return out;
}

export function levelsOf(select: AgySelect): EffortLevel[] {
  return select.values.map((v) => v.value).filter(isEffort);
}

/**
 * Модель из настроек: базовый id как есть; склеенный id старого формата (`gemini-3.8-flash-low`) разбирается на
 * базовую модель и уровень. Неизвестное значение передаётся серверу как есть — он ответит `-32602`.
 */
export function normalizeModel(value: string, config: AgyConfig): { model: string; effort?: EffortLevel } {
  const bases = config.model?.values.map((v) => v.value) ?? [];
  if (!bases.length || bases.includes(value)) return { model: value };
  for (const level of EFFORT_LEVELS) {
    const base = value.endsWith(`-${level}`) ? value.slice(0, -level.length - 1) : '';
    if (base && bases.includes(base)) return { model: base, effort: level };
  }
  return { model: value };
}

// ---- режимы -------------------------------------------------------------------------------------------------

export type AgyModeId = 'default' | 'accept-edits' | 'plan';

/**
 * `default`→`default`, `acceptEdits`→`accept-edits`, `plan`→`plan`. `bypassPermissions` при разрешении в настройках —
 * `accept-edits` (команды сервер всё равно спросит: их разрешает адаптер, этап 3), без разрешения — `default`.
 */
export function agyModeId(mode: PermissionMode, allowBypass: boolean): AgyModeId {
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits') return 'accept-edits';
  if (mode === 'bypassPermissions' && allowBypass) return 'accept-edits';
  return 'default';
}

/** Серверный режим → режим Agentura для `session.init`, когда `resume` вернул режим не тот, что просили. */
export function permissionModeOf(modeId: string | undefined): PermissionMode {
  if (modeId === 'plan') return 'plan';
  if (modeId === 'accept-edits') return 'acceptEdits';
  return 'default';
}

// ---- ответы на серверные запросы ---------------------------------------------------------------------------

/**
 * Безопасный отказ на `session/request_permission` (до живых карточек, этап 3): `optionId` опции `kind: "reject_once"`
 * из кадра (`deny`), фолбэк `deny`. `reject-once` из Cursor не подставляем.
 */
export function permissionRefusal(params: unknown): { outcome: { outcome: 'selected'; optionId: string } } {
  const options = record(params)?.options;
  for (const item of Array.isArray(options) ? options : []) {
    const row = record(item);
    const optionId = text(row?.optionId);
    if (row?.kind === 'reject_once' && optionId) return { outcome: { outcome: 'selected', optionId } };
  }
  return { outcome: { outcome: 'selected', optionId: 'deny' } };
}

/** `elicitation/create` до этапа 3: вопрос не показываем, модель получает отказ в том же ходе. */
export function elicitationDecline(): { action: 'decline' } {
  return { action: 'decline' };
}

export interface ParsedElicitation {
  questions: Question[];
  properties: Record<string, unknown>;
}

export function parseElicitation(params: unknown): ParsedElicitation | undefined {
  const row = record(params);
  const schema = record(row?.requestedSchema);
  const props = record(schema?.properties);
  if (!props) return undefined;
  const questions: Question[] = [];
  for (const [key, val] of Object.entries(props)) {
    if (key.endsWith('_other')) continue;
    const p = record(val);
    if (!p) continue;
    const questionText = text(p.title) ?? text(p.description) ?? key;
    if (Array.isArray(p.oneOf)) {
      const options = p.oneOf.map((o) => {
        const opt = record(o);
        const label = typeof opt?.title === 'string' && opt.title ? opt.title : String(opt?.const ?? '');
        return { label };
      });
      questions.push({ question: questionText, options, multiSelect: false });
    } else if (p.type === 'array' && record(p.items) && Array.isArray(record(p.items)?.anyOf)) {
      const anyOf = record(p.items)!.anyOf as unknown[];
      const options = anyOf.map((o) => {
        const opt = record(o);
        const label = typeof opt?.title === 'string' && opt.title ? opt.title : String(opt?.const ?? '');
        return { label };
      });
      questions.push({ question: questionText, options, multiSelect: true });
    }
  }
  return { questions, properties: props };
}

export function formatElicitationAnswer(
  properties: Record<string, unknown>,
  questions: readonly Question[],
  answers: Record<string, string>,
): { action: 'accept'; content: Record<string, unknown> } {
  const content: Record<string, unknown> = {};
  const propKeys = Object.keys(properties).filter((k) => !k.endsWith('_other'));
  for (let i = 0; i < propKeys.length; i++) {
    const key = propKeys[i]!;
    const q = questions[i];
    const prop = record(properties[key]);
    if (!q || !prop) continue;
    const answer = answers[q.question] ?? answers[key];
    if (answer === undefined) continue;
    if (prop.type === 'string' && Array.isArray(prop.oneOf)) {
      const matchIdx = q.options.findIndex((o) => o.label === answer);
      if (matchIdx >= 0) {
        const constVal = record(prop.oneOf[matchIdx])?.const ?? String(matchIdx + 1);
        content[key] = String(constVal);
      } else {
        if (Object.prototype.hasOwnProperty.call(properties, `${key}_other`)) {
          content[`${key}_other`] = answer;
        } else {
          content[key] = answer;
        }
      }
    } else if (prop.type === 'array' && record(prop.items) && Array.isArray(record(prop.items)?.anyOf)) {
      const anyOf = record(prop.items)!.anyOf as unknown[];
      const pieces = answer.split(',').map((s) => s.trim()).filter(Boolean);
      const selected: string[] = [];
      const others: string[] = [];
      for (const piece of pieces) {
        const matchIdx = q.options.findIndex((o) => o.label === piece);
        if (matchIdx >= 0) {
          const constVal = record(anyOf[matchIdx])?.const ?? String(matchIdx + 1);
          selected.push(String(constVal));
        } else {
          others.push(piece);
        }
      }
      content[key] = selected;
      if (others.length && Object.prototype.hasOwnProperty.call(properties, `${key}_other`)) {
        content[`${key}_other`] = others.join(', ');
      }
    }
  }
  return { action: 'accept', content };
}

// ---- prompt -------------------------------------------------------------------------------------------------

export type PromptBlock =
  | { type: 'image'; data: string; mimeType: ImageMediaType }
  | { type: 'text'; text: string };

/** Картинки блоками `{type:"image",data,mimeType}` перед текстом (так принял сервер); пустой текст блока не даёт. */
export function promptBlocks(prompt: string, images: readonly PromptImage[] = []): PromptBlock[] {
  const blocks: PromptBlock[] = images.map((image) => ({
    type: 'image',
    data: image.data,
    mimeType: image.mediaType,
  }));
  if (prompt) blocks.push({ type: 'text', text: prompt });
  return blocks;
}
