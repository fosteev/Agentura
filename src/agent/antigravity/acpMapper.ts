import { structuredPatch } from 'diff';
import type { AgentEvent, ImageRef, PromptImage, TokenUsage } from '../types';
import { chunkText, record, sessionTitleOf, sessionUpdateKind, stopReasonOf } from './acpProtocol';
import { mapAgyTool } from './tools';

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Токены хода из `session/prompt.result.usage`. `inputTokens` у agy уже очищен от кэша (кэш повторно не вычитаем),
 * `thoughtTokens` входит в `outputTokens`. Нет объекта `usage` — `undefined` (токены неизвестны).
 */
export function usageOf(result: unknown): TokenUsage | undefined {
  const usage = record(record(result)?.usage);
  if (!usage) return undefined;
  const n = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? (usage[key] as number) : 0);
  return {
    input: n('inputTokens'),
    output: n('outputTokens'),
    cacheRead: n('cachedReadTokens'),
    cacheWrite: n('cachedWriteTokens'),
    ...(typeof usage.thoughtTokens === 'number' ? { thinking: n('thoughtTokens') } : {}),
  };
}

interface ToolState {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Ход `agy acp` → `AgentEvent`.
 * - `agent_message_chunk` → `text.delta`; `agent_thought_chunk` → `thinking.start/delta/stop` (блок закрывается
 *   перед первым text/tool/finish);
 * - `session_info_update.title` → `session.title`;
 * - `tool_call` / `tool_call_update` → `tool.start` (один раз на `toolCallId`) и `tool.result` на терминальном статусе
 *   (`completed` | `failed`); имена отображаются в карточки `Bash`/`Read`/`Edit`/`Write`/`WebSearch`/`AskUserQuestion`;
 * - `user_message_chunk` (эхо промпта), `available_commands_update`, `current_mode_update`, `config_option_update`,
 *   `plan` — не лента.
 */
export class AgyAcpMapper {
  private messageId = '';
  private text = '';
  private seq = 0;
  private thinking: { messageId: string } | undefined;
  private readonly tools = new Map<string, ToolState>();
  private readonly finished = new Set<string>();

  /** Новый ход: сбрасывает накопленный текст предыдущего. `images` — миниатюры реплики в ленте. */
  startTurn(prompt: string, at = Date.now(), images?: readonly PromptImage[]): AgentEvent[] {
    this.seq += 1;
    this.messageId = `a${this.seq}`;
    this.text = '';
    this.thinking = undefined;
    this.tools.clear();
    this.finished.clear();
    return [
      {
        type: 'turn.start',
        prompt,
        at,
        ...(images?.length ? { images: images.map(imageRef) } : {}),
      },
    ];
  }

  /** Один `session/update.update`. */
  applyUpdate(update: unknown, now = Date.now()): AgentEvent[] {
    const kind = sessionUpdateKind(update);
    if (kind === 'agent_message_chunk') {
      const text = chunkText(update);
      if (!text) return [];
      const events = this.closeThinking(now);
      if (!this.messageId) this.messageId = this.nextMessageId();
      this.text += text;
      events.push({ type: 'text.delta', messageId: this.messageId, text });
      return events;
    }
    if (kind === 'agent_thought_chunk') {
      const text = chunkText(update);
      if (!text) return [];
      const events: AgentEvent[] = [];
      if (!this.thinking) {
        this.thinking = { messageId: `t${(this.seq += 1)}` };
        events.push({ type: 'thinking.start', messageId: this.thinking.messageId, at: now });
      }
      events.push({ type: 'thinking.delta', messageId: this.thinking.messageId, text });
      return events;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') return this.toolUpdate(update, now);
    if (kind === 'session_info_update') {
      const title = sessionTitleOf(update);
      return title ? [{ type: 'session.title', title }] : [];
    }
    return [];
  }

  /** Ответ `session/prompt`: `end_turn` — успех, `cancelled` — Stop. */
  finish(result: unknown, startedAt: number, now = Date.now()): AgentEvent[] {
    const stopReason = stopReasonOf(result) ?? 'end_turn';
    const usage = usageOf(result);
    return this.result(stopReason, Math.max(0, now - startedAt), now, { usage });
  }

  /** Ход оборвался (stdout закрылся, ошибка сервера), `stopReason` не пришёл. */
  failOpen(startedAt: number, now = Date.now(), message?: string): AgentEvent[] {
    return this.result('error', Math.max(0, now - startedAt), now, {
      ok: false,
      interrupted: false,
      ...(message ? { errors: [message] } : {}),
    });
  }

  /** Stop не дождался `stopReason`: закрыть ход как `cancelled`, очередь не держать. */
  abandon(startedAt: number, now = Date.now()): AgentEvent[] {
    return this.result('cancelled', Math.max(0, now - startedAt), now, { ok: false, interrupted: true });
  }

  /** Stop раньше `session/prompt`: синтетический ход, процесс жив. */
  interruptBeforeStart(prompt: string, at = Date.now()): AgentEvent[] {
    return [
      { type: 'turn.start', prompt, at },
      ...this.result('interrupted', 0, at, { ok: false, interrupted: true, numTurns: 0 }),
    ];
  }

  private nextMessageId(): string {
    this.seq += 1;
    return `a${this.seq}`;
  }

  private closeThinking(at: number): AgentEvent[] {
    if (!this.thinking) return [];
    const { messageId } = this.thinking;
    this.thinking = undefined;
    return [{ type: 'thinking.stop', messageId, at }];
  }

  private result(
    subtype: string,
    durationMs: number,
    at: number,
    flags: {
      ok?: boolean;
      interrupted?: boolean;
      numTurns?: number;
      usage?: TokenUsage | undefined;
      errors?: string[];
    } = {},
  ): AgentEvent[] {
    const events = this.closeThinking(at);
    const text = this.text;
    this.text = '';
    this.messageId = '';
    this.tools.clear();
    this.finished.clear();
    events.push({
      type: 'turn.result',
      ok: flags.ok ?? subtype === 'end_turn',
      subtype,
      interrupted: flags.interrupted ?? subtype === 'cancelled',
      durationMs,
      apiDurationMs: 0,
      numTurns: flags.numTurns ?? 1,
      usage: flags.usage ? { ...flags.usage } : { ...ZERO },
      usageKnown: flags.usage !== undefined,
      totalCostUsd: 0,
      permissionDenials: [],
      ...(flags.errors ? { errors: flags.errors } : {}),
      ...(text ? { text } : {}),
    });
    return events;
  }

  /**
   * `tool_call` / `tool_call_update`. Id — `toolCallId` кадра; нет id — карточки нет. Одиночный кадр уже в финальном
   * статусе (реплей `session/load`) даёт пару `tool.start` + `tool.result`. Кадры после финала игнорируются.
   */
  private toolUpdate(update: unknown, now: number): AgentEvent[] {
    const row = record(update);
    const id = row?.toolCallId;
    if (!row || typeof id !== 'string' || !id || this.finished.has(id)) return [];
    const events: AgentEvent[] = [];
    let tool = this.tools.get(id);
    if (!tool) {
      events.push(...this.closeThinking(now));
      const rawName = toolName(row);
      const rawInput = toolInput(row);
      const mapped = mapAgyTool(rawName, rawInput);
      tool = { name: mapped.name, input: mapped.input };
      this.tools.set(id, tool);
      events.push({ type: 'tool.start', toolUseId: id, name: tool.name, input: { ...tool.input } });
    }
    const status = typeof row.status === 'string' ? row.status : '';
    if (status !== 'completed' && status !== 'failed') return events;
    const out = toolOutput(row, status === 'failed');
    events.push({
      type: 'tool.result',
      toolUseId: id,
      isError: out.isError,
      content: out.content,
      ...(out.result !== undefined ? { result: out.result } : {}),
    });
    this.tools.delete(id);
    this.finished.add(id);
    return events;
  }
}

function imageRef(image: PromptImage): ImageRef {
  return {
    mediaType: image.mediaType,
    data: image.data,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    ...(image.name !== undefined ? { name: image.name } : {}),
  };
}

/** Имя инструмента как у сервера (`name`: `run_command`, `read_file`…); иначе `kind`, иначе `title`. */
export function toolName(row: Record<string, unknown>): string {
  for (const key of ['name', 'kind']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'tool';
}

/** `rawInput`, иначе `args` (в кадрах `agy` они равны). Нет объекта — пустой input. */
export function toolInput(row: Record<string, unknown>): Record<string, unknown> {
  const raw = record(row.rawInput) ?? record(row.args);
  return raw ? { ...raw } : {};
}

/**
 * Итог инструмента. Ошибка: `status: "failed"` или `rawOutput.exit_code !== 0` (ненулевой код `run_command` приходит
 * со `status: "completed"`). Диффы правок: структурный результат с `structuredPatch` для вкладки changes и счётчиков.
 */
function toolOutput(row: Record<string, unknown>, failed: boolean): { content: string; result?: unknown; isError: boolean } {
  const raw = record(row.rawOutput);
  const exit = raw && typeof raw.exit_code === 'number' ? raw.exit_code : undefined;
  const isError = failed || (exit !== undefined && exit !== 0);
  const blocks = Array.isArray(row.content) ? row.content : [];
  const diffs = blocks.map(record).filter((b): b is Record<string, unknown> => b?.type === 'diff');
  if (diffs.length) {
    const content = diffs
      .map((d) => `${typeof d.path === 'string' ? d.path : ''}\n${typeof d.newText === 'string' ? d.newText : ''}`)
      .join('\n')
      .trim();
    const allHunks = diffs.flatMap((d) => {
      const p = typeof d.path === 'string' ? d.path : '';
      const n = typeof d.newText === 'string' ? d.newText : '';
      const o = typeof d.oldText === 'string' ? d.oldText : '';
      return structuredPatch(p, p, o, n).hunks;
    });
    const first = diffs[0]!;
    const p = typeof first.path === 'string' ? first.path : '';
    const n = typeof first.newText === 'string' ? first.newText : '';
    const isNew = first.oldText === undefined;
    const o = typeof first.oldText === 'string' ? first.oldText : '';
    const result: Record<string, unknown> = {
      filePath: p,
      type: isNew ? 'create' : 'update',
      structuredPatch: allHunks,
      content: n,
      ...(isNew ? {} : { originalFile: o, oldString: o, newString: n }),
    };
    return { content, result, isError };
  }
  if (raw && typeof raw.output === 'string') return { content: raw.output, result: raw, isError };
  const parts: string[] = [];
  for (const block of blocks) {
    const inner = record(block);
    const content = inner?.type === 'content' ? record(inner.content) : inner;
    if (content?.type === 'text' && typeof content.text === 'string' && content.text) parts.push(content.text);
  }
  if (parts.length) return { content: parts.join('\n'), ...(raw ? { result: raw } : {}), isError };
  if (raw) return { content: raw.output === '' ? '' : JSON.stringify(raw), result: raw, isError };
  return { content: '', isError };
}
