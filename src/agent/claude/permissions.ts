import type { AgentEvent, DiffPreview, PermissionDecision, PlanDecision, Question } from '../types';
import { arr, isObj, obj, str, type Json } from './json';

/**
 * Единая точка `canUseTool`: запрос → событие в интерфейс → промис, который резолвит ответ
 * пользователя (`respondPermission` / `answerQuestion` / `decidePlan`) по `toolUseID`.
 * Формы ответов проверены пробой: docs/spikes/sdk-probe.md, разделы 7–9.
 */

/** Подмножество `PermissionResult` SDK, которое мы возвращаем. */
export type ToolPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** Опции `canUseTool` SDK в объёме, который мы читаем. */
export interface ToolPermissionOptions {
  signal?: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  description?: string;
  toolUseID?: string;
  agentID?: string;
}

type Kind = 'permission' | 'question' | 'plan';

interface Pending {
  kind: Kind;
  input: Record<string, unknown>;
  suggestions: unknown[];
  agentId?: string;
  resolve: (result: ToolPermissionResult) => void;
}

/** Сообщение модели при отказе без своего текста. */
export const DEFAULT_DENY_MESSAGE = 'The user declined this tool use.';
const ABORT_MESSAGE = 'The request was cancelled.';

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    /** `agentID` из опций (id задачи) → id субагента в событиях. */
    private readonly agentIdFor: (taskId: string | undefined) => string | undefined = (id) => id,
  ) {}

  /** Id запросов, ждущих ответа. */
  get waiting(): string[] {
    return [...this.pending.keys()];
  }

  readonly canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: ToolPermissionOptions,
  ): Promise<ToolPermissionResult> => {
    const toolUseId = options.toolUseID ?? `permission-${++this.seq}`;
    const agentId = this.agentIdFor(options.agentID);
    const agent = agentId !== undefined ? { agentId } : {};
    const suggestions = options.suggestions ?? [];
    const kind: Kind =
      toolName === 'AskUserQuestion'
        ? 'question'
        : toolName === 'ExitPlanMode'
          ? 'plan'
          : 'permission';

    return new Promise<ToolPermissionResult>((resolve) => {
      if (options.signal?.aborted) {
        resolve({ behavior: 'deny', message: ABORT_MESSAGE });
        return;
      }
      this.pending.set(toolUseId, { kind, input, suggestions, ...agent, resolve });
      options.signal?.addEventListener('abort', () => this.cancel(toolUseId), { once: true });

      if (kind === 'question') {
        this.emit({
          type: 'question.request',
          ...agent,
          toolUseId,
          questions: questionsFrom(input),
        });
      } else if (kind === 'plan') {
        const planFilePath = str(input['planFilePath']);
        this.emit({
          type: 'plan.request',
          ...agent,
          toolUseId,
          plan: str(input['plan']) ?? '',
          ...(planFilePath ? { planFilePath } : {}),
        });
      } else {
        const diff = diffPreview(toolName, input);
        this.emit({
          type: 'permission.request',
          ...agent,
          toolUseId,
          toolName,
          input,
          ...(options.title ? { title: options.title } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(options.decisionReason ? { reason: options.decisionReason } : {}),
          ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
          canAlwaysAllow: suggestions.length > 0,
          ...(diff ? { diff } : {}),
        });
      }
    });
  };

  /**
   * Ответ на запрос разрешения. «Всегда» возвращает подсказки движка как есть — так SDK
   * советует и так проверено пробой (правило Bash ушло в `.claude/settings.local.json`;
   * у Edit подсказка — режим `acceptEdits` на сессию). Отказ работает и для вопроса, и для плана.
   */
  respondPermission(toolUseId: string, decision: PermissionDecision, message?: string): boolean {
    const p = this.pending.get(toolUseId);
    if (!p) return false;
    if (decision === 'deny')
      return this.finish(toolUseId, { behavior: 'deny', message: message ?? DEFAULT_DENY_MESSAGE });
    if (p.kind !== 'permission') return false;
    const result: ToolPermissionResult = { behavior: 'allow', updatedInput: p.input };
    if (decision === 'allow-always' && p.suggestions.length > 0)
      result.updatedPermissions = p.suggestions;
    return this.finish(toolUseId, result);
  }

  /** Ответы на `AskUserQuestion`: `{ "<текст вопроса>": "<label>" }`. */
  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    const p = this.pending.get(toolUseId);
    if (!p || p.kind !== 'question') return false;
    return this.finish(toolUseId, { behavior: 'allow', updatedInput: { ...p.input, answers } });
  }

  /** План: одобрить (с выходом в режим) или вернуть на доработку с текстом. */
  decidePlan(toolUseId: string, decision: PlanDecision): boolean {
    const p = this.pending.get(toolUseId);
    if (!p || p.kind !== 'plan') return false;
    if (!decision.approve)
      return this.finish(toolUseId, { behavior: 'deny', message: decision.feedback });
    const result: ToolPermissionResult = { behavior: 'allow', updatedInput: p.input };
    if (decision.mode)
      result.updatedPermissions = [
        { type: 'setMode', mode: decision.mode, destination: 'session' },
      ];
    return this.finish(toolUseId, result);
  }

  /** Отменить все ожидающие запросы (закрытие сессии). */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  private cancel(toolUseId: string): void {
    const p = this.pending.get(toolUseId);
    if (!p) return;
    this.pending.delete(toolUseId);
    p.resolve({ behavior: 'deny', message: ABORT_MESSAGE });
    this.emit({
      type: 'permission.resolved',
      ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
      toolUseId,
      decision: 'deny',
      by: 'abort',
    });
  }

  private finish(toolUseId: string, result: ToolPermissionResult): boolean {
    const p = this.pending.get(toolUseId);
    if (!p) return false;
    this.pending.delete(toolUseId);
    p.resolve(result);
    this.emit({
      type: 'permission.resolved',
      ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
      toolUseId,
      decision: result.behavior,
      by: 'user',
    });
    return true;
  }
}

function questionsFrom(input: Json): Question[] {
  return arr(input['questions'])
    .filter(isObj)
    .map((q) => {
      const header = str(q['header']);
      return {
        question: str(q['question']) ?? '',
        ...(header ? { header } : {}),
        options: arr(q['options'])
          .filter(isObj)
          .map((o) => {
            const description = str(o['description']);
            return { label: str(o['label']) ?? '', ...(description ? { description } : {}) };
          }),
        multiSelect: q['multiSelect'] === true,
      };
    });
}

/** Превью правки до применения: Edit — фрагменты, Write — новый текст (старый читает интерфейс). */
export function diffPreview(toolName: string, input: Json): DiffPreview | undefined {
  const filePath = str(input['file_path']);
  if (!filePath) return undefined;
  if (toolName === 'Edit') {
    return {
      kind: 'edit',
      filePath,
      oldText: str(input['old_string']) ?? '',
      newText: str(input['new_string']) ?? '',
      replaceAll: input['replace_all'] === true,
    };
  }
  if (toolName === 'Write')
    return { kind: 'write', filePath, content: str(input['content']) ?? '' };
  return undefined;
}

/** Для тестов: форма опций из строки пробы `canUseTool`. */
export function optionsFromProbe(raw: unknown): ToolPermissionOptions {
  const o = obj(raw) ?? {};
  const pick = (k: string) => str(o[k]);
  const opts: ToolPermissionOptions = {};
  if (Array.isArray(o['suggestions'])) opts.suggestions = o['suggestions'];
  for (const k of [
    'blockedPath',
    'decisionReason',
    'title',
    'description',
    'toolUseID',
    'agentID',
  ] as const) {
    const v = pick(k);
    if (v !== undefined) opts[k] = v;
  }
  return opts;
}
