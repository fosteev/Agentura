import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CommandOption,
  EffortLevel,
  ImageMediaType,
  ModelOption,
  PermissionMode,
  PromptFile,
  PromptImage,
  Question,
} from '../types';

/** Подмножество ACP Kimi Code 2.6.0, подтверждённое `test/fixtures/kimi/`. */
export const KIMI_PROTOCOL_VERSION = 1;
export const KIMI_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
} as const;
export const ELICITATION_METHOD = 'elicitation/create';

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
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

export function agentVersionOf(result: unknown): string | undefined {
  return text(record(record(result)?.agentInfo)?.version);
}

export function currentModeId(result: unknown): string | undefined {
  return text(record(record(result)?.modes)?.currentModeId);
}

export function chunkText(update: unknown): string {
  const content = record(record(update)?.content);
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

export function sessionTitleOf(update: unknown): string | undefined {
  const title = record(update)?.title;
  return typeof title === 'string' ? title.trim() || undefined : undefined;
}

export interface KimiSelect {
  current: string;
  values: { value: string; name: string }[];
}

export interface KimiConfig {
  model?: KimiSelect;
  thinking?: KimiSelect;
  mode?: KimiSelect;
}

function selectOf(options: unknown, id: string): KimiSelect | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const item of options) {
    const row = record(item);
    if (row?.id !== id) continue;
    const values: KimiSelect['values'] = [];
    for (const option of Array.isArray(row.options) ? row.options : []) {
      const value = record(option);
      const idValue = text(value?.value);
      if (idValue) values.push({ value: idValue, name: text(value?.name) ?? idValue });
    }
    return { current: text(row.currentValue) ?? '', values };
  }
  return undefined;
}

export function hasConfigOptions(result: unknown): boolean {
  return Array.isArray(record(result)?.configOptions);
}

export function parseConfig(result: unknown): KimiConfig {
  const options = record(result)?.configOptions;
  const config: KimiConfig = {};
  const model = selectOf(options, 'model');
  const thinking = selectOf(options, 'thinking');
  const mode = selectOf(options, 'mode');
  if (model) config.model = model;
  if (thinking) config.thinking = thinking;
  if (mode) config.mode = mode;
  return config;
}

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isEffort(value: string): value is EffortLevel {
  return (EFFORTS as readonly string[]).includes(value);
}

/** Только текущая модель получает уровни из её живого `thinking`; для остальных возможности не выдумываются. */
export function modelOptionsFrom(config: KimiConfig): ModelOption[] {
  const model = config.model;
  if (!model) return [];
  return model.values.map(({ value, name }) => {
    if (value !== model.current) return { value, displayName: name };
    const levels = config.thinking?.values.map((v) => v.value).filter(isEffort) ?? [];
    return {
      value,
      displayName: name,
      supportsEffort: levels.length > 0,
      ...(levels.length ? { effortLevels: levels } : {}),
    };
  });
}

export function permissionModeOf(modeId: string | undefined, allowBypass: boolean): PermissionMode {
  if (modeId === 'plan') return 'plan';
  if (modeId === 'auto') return 'acceptEdits';
  if (modeId === 'yolo' && allowBypass) return 'bypassPermissions';
  return 'default';
}

export function kimiModeId(mode: PermissionMode, allowBypass: boolean): 'default' | 'plan' | 'auto' | 'yolo' {
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits') return 'auto';
  if (mode === 'bypassPermissions' && allowBypass) return 'yolo';
  return 'default';
}

export interface KimiPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export function permissionOptions(params: unknown): KimiPermissionOption[] {
  const out: KimiPermissionOption[] = [];
  for (const item of Array.isArray(record(params)?.options) ? record(params)!.options as unknown[] : []) {
    const row = record(item);
    const optionId = text(row?.optionId);
    if (optionId) out.push({ optionId, name: text(row?.name) ?? optionId, kind: text(row?.kind) ?? '' });
  }
  return out;
}

export function permissionOption(options: readonly KimiPermissionOption[], kind: string): string | undefined {
  return options.find((option) => option.kind === kind)?.optionId;
}

export function permissionOutcome(optionId: string): { outcome: { outcome: 'selected'; optionId: string } } {
  return { outcome: { outcome: 'selected', optionId } };
}

export function permissionCancelled(): { outcome: { outcome: 'cancelled' } } {
  return { outcome: { outcome: 'cancelled' } };
}

export function contentTexts(content: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const wrapper = record(item);
    const inner = wrapper?.type === 'content' ? record(wrapper.content) : wrapper;
    if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text) out.push(inner.text);
  }
  return out;
}

export function commandsOf(update: unknown): CommandOption[] {
  const commands = record(update)?.availableCommands;
  if (!Array.isArray(commands)) return [];
  const out: CommandOption[] = [];
  for (const item of commands) {
    const row = record(item);
    if (!row) continue;
    const name = text(row.name);
    if (!name) continue;
    const hint = text(record(row.input)?.hint);
    out.push({
      name,
      description: text(row.description) ?? '',
      ...(hint ? { argumentHint: hint } : {}),
    });
  }
  return out;
}

export function usageOf(update: unknown): { used: number; size: number } | undefined {
  const row = record(update);
  if (!row || sessionUpdateKind(row) !== 'usage_update') return undefined;
  const used = row?.used;
  const size = row?.size;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined;
  return { used, size };
}

export type PromptBlock =
  | { type: 'image'; data: string; mimeType: ImageMediaType }
  | { type: 'resource'; resource: { uri: string; mimeType: 'text/plain'; text: string } }
  | { type: 'text'; text: string };

/** Картинки и embedded text идут родными ACP-блоками; PDF/blob сюда не попадает (`files=false`). */
export function promptBlocks(
  cwd: string,
  prompt: string,
  images: readonly PromptImage[] = [],
  files: readonly PromptFile[] = [],
): PromptBlock[] {
  const blocks: PromptBlock[] = images.map((image) => ({
    type: 'image', data: image.data, mimeType: image.mediaType,
  }));
  for (const file of files) {
    if (file.kind !== 'text') continue;
    blocks.push({
      type: 'resource',
      resource: {
        uri: pathToFileURL(resolve(cwd, file.path)).href,
        mimeType: 'text/plain',
        text: file.data,
      },
    });
  }
  if (prompt) blocks.push({ type: 'text', text: prompt });
  return blocks;
}

export function permissionRefusal(params: unknown): { outcome: { outcome: 'selected'; optionId: string } } {
  const options = record(params)?.options;
  for (const item of Array.isArray(options) ? options : []) {
    const row = record(item);
    const optionId = text(row?.optionId);
    if (row?.kind === 'reject_once' && optionId) {
      return { outcome: { outcome: 'selected', optionId } };
    }
  }
  return { outcome: { outcome: 'selected', optionId: 'reject' } };
}

export function elicitationDecline(): { action: 'decline' } {
  return { action: 'decline' };
}

export function elicitationCancel(): { action: 'cancel' } {
  return { action: 'cancel' };
}

interface KimiQuestionField {
  key: string;
  question: Question;
  values: { label: string; value: string }[];
}

export interface ParsedKimiElicitation {
  questions: Question[];
  fields: KimiQuestionField[];
  required: Set<string>;
}

/** Kimi form использует q0-based поля; порядок — порядок `requestedSchema.properties`. */
export function parseElicitation(params: unknown): ParsedKimiElicitation | undefined {
  const row = record(params);
  if (row?.mode !== 'form') return undefined;
  const schema = record(row.requestedSchema);
  const properties = record(schema?.properties);
  if (schema?.type !== 'object' || !properties) return undefined;
  const fields: KimiQuestionField[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!/^q\d+$/.test(key)) return undefined;
    const property = record(value);
    if (!property) return undefined;
    const question = text(property.title) ?? text(property.description) ?? key;
    const source = property.type === 'string' && Array.isArray(property.oneOf)
      ? property.oneOf
      : property.type === 'array' && Array.isArray(record(property.items)?.anyOf)
        ? record(property.items)!.anyOf as unknown[]
        : undefined;
    if (!source) return undefined;
    const values: KimiQuestionField['values'] = [];
    for (const item of source) {
      const option = record(item);
      if (typeof option?.const !== 'string') return undefined;
      values.push({ label: text(option.title) ?? option.const, value: option.const });
    }
    fields.push({
      key,
      question: { question, options: values.map(({ label }) => ({ label })), multiSelect: property.type === 'array' },
      values,
    });
  }
  if (!fields.length) return undefined;
  const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter((v): v is string => typeof v === 'string'));
  return { questions: fields.map((field) => field.question), fields, required };
}

/** Other не входит в схему Kimi: неизвестный ответ — честный decline, а не выдуманное qN_other. */
export function formatElicitationAnswer(
  parsed: ParsedKimiElicitation,
  answers: Record<string, string>,
): { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } {
  const content: Record<string, unknown> = {};
  for (const field of parsed.fields) {
    const answer = answers[field.key] ?? answers[field.question.question];
    if (answer === undefined || !answer.trim()) {
      if (parsed.required.has(field.key)) return elicitationDecline();
      continue;
    }
    const selected = field.question.multiSelect ? answer.split(',').map((part) => part.trim()).filter(Boolean) : [answer.trim()];
    const values: string[] = [];
    for (const label of selected) {
      const option = field.values.find((value) => value.label === label);
      if (!option) return elicitationDecline();
      values.push(option.value);
    }
    if (field.question.multiSelect && !values.length && parsed.required.has(field.key)) return elicitationDecline();
    content[field.key] = field.question.multiSelect ? values : values[0];
  }
  return Object.keys(content).length ? { action: 'accept', content } : elicitationDecline();
}
