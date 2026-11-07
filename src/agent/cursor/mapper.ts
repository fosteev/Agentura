import type { AgentEvent, TokenUsage } from '../types';
import {
  chunkText,
  cursorToolInput,
  cursorToolName,
  permissionHasAlways,
  sessionUpdateKind,
  stopReasonOf,
} from './protocol';

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Ход ACP → `AgentEvent`. В `text.delta` попадает только `agent_message_chunk`.
 * Tool — `tool.start` / `tool.result`. `session_info_update.title` — название сессии, не строка ленты.
 * `plan` с entries, мысли, реплика пользователя и каталог команд — не лента.
 */
export class CursorMapper {
  private messageId = '';
  private text = '';
  private seq = 0;
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown>; started: boolean }>();

  /** Новый ход: сбрасывает накопленный текст предыдущего. */
  startTurn(prompt: string, at = Date.now()): AgentEvent[] {
    this.seq += 1;
    this.messageId = `c${this.seq}`;
    this.text = '';
    this.tools.clear();
    return [{ type: 'turn.start', prompt, at }];
  }

  /**
   * Один `session/update.update`.
   * Текст — только `agent_message_chunk`. Tool — `tool_call` / `tool_call_update`.
   * `session_info_update.title` — `session.title`. Пустой title не событие.
   * `plan` с entries, мысли, реплика пользователя, команды и `current_mode_update` — пусто.
   */
  applyUpdate(update: unknown): AgentEvent[] {
    const kind = sessionUpdateKind(update);
    if (kind === 'tool_call' || kind === 'tool_call_update') return this.toolUpdate(update);
    if (kind === 'session_info_update') {
      const title = sessionInfoTitle(update);
      return title ? [{ type: 'session.title', title }] : [];
    }
    if (kind !== 'agent_message_chunk') return [];
    const text = chunkText(update);
    if (!text) return [];
    if (!this.messageId) {
      this.seq += 1;
      this.messageId = `c${this.seq}`;
    }
    this.text += text;
    return [{ type: 'text.delta', messageId: this.messageId, text }];
  }

  /** Ответ `session/prompt`: `end_turn` — успех, `cancelled` — Stop. */
  finish(result: unknown, startedAt: number, now = Date.now()): AgentEvent[] {
    const stopReason = stopReasonOf(result) ?? 'end_turn';
    return [this.result(stopReason, this.text, Math.max(0, now - startedAt))];
  }

  /** Ход оборвался (stdout закрылся), `stopReason` не пришёл. */
  failOpen(startedAt: number, now = Date.now()): AgentEvent[] {
    return [this.result('error', this.text, Math.max(0, now - startedAt), { ok: false, interrupted: false })];
  }

  /** Stop не дождался `stopReason`: закрыть ход как `cancelled`, очередь не держать. */
  abandon(startedAt: number, now = Date.now()): AgentEvent[] {
    return [this.result('cancelled', this.text, Math.max(0, now - startedAt), { ok: false, interrupted: true })];
  }

  /** Stop раньше `session/prompt`: синтетический ход, процесс жив. */
  interruptBeforeStart(prompt: string, at = Date.now()): AgentEvent[] {
    return [
      { type: 'turn.start', prompt, at },
      this.result('interrupted', '', 0, { ok: false, interrupted: true, numTurns: 0 }),
    ];
  }

  private result(
    subtype: string,
    text: string,
    durationMs: number,
    flags?: { ok: boolean; interrupted: boolean; numTurns?: number },
  ): AgentEvent {
    const interrupted = flags?.interrupted ?? subtype === 'cancelled';
    const ok = flags?.ok ?? subtype === 'end_turn';
    this.text = '';
    this.messageId = '';
    return {
      type: 'turn.result',
      ok,
      subtype,
      interrupted,
      durationMs,
      apiDurationMs: 0,
      numTurns: flags?.numTurns ?? 1,
      usage: { ...ZERO },
      usageKnown: false,
      totalCostUsd: 0,
      permissionDenials: [],
      ...(text ? { text } : {}),
    };
  }

  /**
   * `tool_call` / `tool_call_update`. Id — `toolCallId` кадра; нет id — карточки нет.
   * Пустой `rawInput` ждёт следующий кадр, `in_progress` или `completed`.
   */
  private toolUpdate(update: unknown): AgentEvent[] {
    const row = record(update);
    if (!row) return [];
    const id = row.toolCallId;
    if (typeof id !== 'string' || !id) return [];
    const incoming = cursorToolInput(row);
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { name: cursorToolName(row), input: incoming, started: false };
      this.tools.set(id, tool);
    } else if (!tool.started) {
      if (Object.keys(incoming).length > 0) tool.input = incoming;
      if (typeof row.kind === 'string' && row.kind) tool.name = cursorToolName(row);
    }
    const status = typeof row.status === 'string' ? row.status : '';
    const events: AgentEvent[] = [];
    const terminal = status === 'completed';
    if (!tool.started && (Object.keys(tool.input).length > 0 || status === 'in_progress' || terminal)) {
      tool.started = true;
      events.push({ type: 'tool.start', toolUseId: id, name: tool.name, input: { ...tool.input } });
    }
    if (!terminal) return events;
    const out = toolOutput(row);
    events.push({
      type: 'tool.result',
      toolUseId: id,
      isError: out.isError,
      content: out.content,
      ...(out.result !== undefined ? { result: out.result } : {}),
    });
    this.tools.delete(id);
    return events;
  }
}

/** `session/request_permission` → `permission.request`. Нет `toolCallId` — карточки нет. */
export function permissionRequestFrom(
  params: unknown,
): { toolUseId: string; options: unknown; event: AgentEvent } | undefined {
  const row = record(params);
  const call = record(row?.toolCall);
  const toolUseId = call?.toolCallId;
  if (typeof toolUseId !== 'string' || !toolUseId) return undefined;
  const title = typeof call.title === 'string' && call.title ? call.title : undefined;
  const reason = permissionReason(call.content);
  return {
    toolUseId,
    options: row?.options,
    event: {
      type: 'permission.request',
      toolUseId,
      toolName: cursorToolName(call),
      input: cursorToolInput(call),
      canAlwaysAllow: permissionHasAlways(row?.options),
      ...(title ? { title, description: title } : {}),
      ...(reason ? { reason } : {}),
    },
  };
}

/** `cursor/create_plan` → `plan.request`. Текст — поле `plan`, иначе `overview`. Пути файла в кадре нет. */
export function planRequestFrom(params: unknown): { toolUseId: string; event: AgentEvent } | undefined {
  const row = record(params);
  const toolUseId = row?.toolCallId;
  if (typeof toolUseId !== 'string' || !toolUseId) return undefined;
  const plan = typeof row.plan === 'string' && row.plan ? row.plan : typeof row.overview === 'string' ? row.overview : '';
  if (!plan) return undefined;
  return { toolUseId, event: { type: 'plan.request', toolUseId, plan } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `session_info_update.title`. Пусто, пробелы и не-строка — названия нет. */
function sessionInfoTitle(update: unknown): string | undefined {
  const title = record(update)?.title;
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  return trimmed || undefined;
}

function permissionReason(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const row = record(block);
    const inner = row?.type === 'content' ? record(row.content) : row?.type === 'text' ? row : undefined;
    if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text) parts.push(inner.text);
  }
  return parts.join('\n');
}

function toolOutput(row: Record<string, unknown>): { content: string; result?: unknown; isError: boolean } {
  const raw = record(row.rawOutput);
  const exit = raw && typeof raw.exitCode === 'number' ? raw.exitCode : undefined;
  const isError = exit !== undefined && exit !== 0;
  if (raw && typeof raw.content === 'string') return { content: raw.content, result: raw, isError };
  if (raw && (typeof raw.stdout === 'string' || typeof raw.stderr === 'string')) {
    const stdout = typeof raw.stdout === 'string' ? raw.stdout : '';
    const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';
    return { content: stdout || stderr, result: raw, isError };
  }
  if (Array.isArray(row.content)) {
    const diffs = row.content.filter((block) => record(block)?.type === 'diff');
    if (diffs.length > 0) {
      const content = diffs
        .map((block) => {
          const diff = record(block);
          const path = typeof diff?.path === 'string' ? diff.path : '';
          const next = typeof diff?.newText === 'string' ? diff.newText : '';
          return path ? `${path}\n${next}` : next;
        })
        .join('');
      return { content, result: row.content, isError };
    }
  }
  if (raw) return { content: JSON.stringify(raw), result: raw, isError };
  return { content: '', isError: false };
}
