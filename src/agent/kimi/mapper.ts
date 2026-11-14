import { structuredPatch } from 'diff';
import type { AgentEvent, FileRef, ImageRef, PromptFile, PromptImage, TokenUsage } from '../types';
import { chunkText, record, sessionTitleOf, sessionUpdateKind, stopReasonOf, usageOf } from './protocol';

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface ToolState {
  name: string;
  input: Record<string, unknown>;
  started: boolean;
  startedAt: number;
  progress: string;
  diffs: Record<string, unknown>[];
  rawOutput?: unknown;
}

/** Kimi ACP → существующие AgentEvent. Per-turn usage у протокола нет: `usageKnown` всегда false. */
export class KimiMapper {
  private messageId = '';
  private text = '';
  private seq = 0;
  private service = false;
  private thinking: { messageId: string } | undefined;
  private readonly tools = new Map<string, ToolState>();
  private readonly finished = new Set<string>();

  startTurn(
    prompt: string,
    at = Date.now(),
    images?: readonly PromptImage[],
    files?: readonly PromptFile[],
    service = false,
  ): AgentEvent[] {
    this.seq += 1;
    this.messageId = `k${this.seq}`;
    this.text = '';
    this.service = service;
    this.thinking = undefined;
    this.tools.clear();
    this.finished.clear();
    return [{
      type: 'turn.start', prompt, at,
      ...(images?.length ? { images: images.map(imageRef) } : {}),
      ...(files?.length ? { files: files.map(fileRef) } : {}),
    }];
  }

  applyUpdate(update: unknown, now = Date.now()): AgentEvent[] {
    const kind = sessionUpdateKind(update);
    if (kind === 'agent_message_chunk') {
      const text = chunkText(update);
      if (!text) return [];
      const events = this.closeThinking(now);
      if (!this.messageId) this.messageId = `k${++this.seq}`;
      this.text += text;
      if (!this.service) events.push({ type: 'text.delta', messageId: this.messageId, text });
      return events;
    }
    if (kind === 'agent_thought_chunk') {
      const text = chunkText(update);
      if (!text) return [];
      const events: AgentEvent[] = [];
      if (!this.thinking) {
        this.thinking = { messageId: `kt${++this.seq}` };
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
    if (kind === 'usage_update') {
      const usage = usageOf(update);
      return usage ? [{
        type: 'context.usage',
        usedTokens: usage.used,
        maxTokens: usage.size,
        percentage: Math.min(100, usage.used / usage.size * 100),
        source: 'engine',
      }] : [];
    }
    return [];
  }

  finish(result: unknown, startedAt: number, now = Date.now()): AgentEvent[] {
    if (this.service && /^Unknown ACP command:/.test(this.text)) {
      return this.result('error', Math.max(0, now - startedAt), {
        ok: false, interrupted: false, errors: [this.text],
      }, now);
    }
    return this.result(stopReasonOf(result) ?? 'end_turn', Math.max(0, now - startedAt), {}, now);
  }

  failOpen(startedAt: number, now = Date.now(), message?: string): AgentEvent[] {
    return this.result('error', Math.max(0, now - startedAt), {
      ok: false, interrupted: false, ...(message ? { errors: [message] } : {}),
    }, now);
  }

  abandon(startedAt: number, now = Date.now()): AgentEvent[] {
    return this.result('cancelled', Math.max(0, now - startedAt), { ok: false, interrupted: true }, now);
  }

  interruptBeforeStart(prompt: string, at = Date.now()): AgentEvent[] {
    return [
      { type: 'turn.start', prompt, at },
      ...this.result('interrupted', 0, { ok: false, interrupted: true, numTurns: 0 }, at),
    ];
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
    flags: { ok?: boolean; interrupted?: boolean; numTurns?: number; errors?: string[] } = {},
    now = Date.now(),
  ): AgentEvent[] {
    const events = this.closeThinking(now);
    const text = this.service ? '' : this.text;
    this.text = '';
    this.service = false;
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
      usage: { ...ZERO },
      usageKnown: false,
      totalCostUsd: 0,
      permissionDenials: [],
      ...(flags.errors ? { errors: flags.errors } : {}),
      ...(text ? { text } : {}),
    });
    return events;
  }

  /** Lazy pending ждёт canonical rawInput; diff запоминается с in_progress до terminal update. */
  private toolUpdate(update: unknown, now: number): AgentEvent[] {
    const row = record(update);
    const id = row?.toolCallId;
    if (!row || typeof id !== 'string' || !id || this.finished.has(id)) return [];
    const status = typeof row.status === 'string' ? row.status : '';
    const terminal = status === 'completed' || status === 'failed';
    let tool = this.tools.get(id);
    if (!tool) {
      tool = {
        name: toolName(row), input: {}, started: false, startedAt: now, progress: '', diffs: [],
      };
      this.tools.set(id, tool);
    }
    if (!tool.started && ['title', 'name', 'rawName', 'kind'].some((key) => typeof row[key] === 'string')) {
      tool.name = toolName(row);
    }
    const rawInput = record(row.rawInput) ?? record(row.args);
    if (rawInput) tool.input = mapToolInput(tool.name, rawInput);
    const diffs = Array.isArray(row.content)
      ? row.content.map(record).filter((block): block is Record<string, unknown> => block?.type === 'diff')
      : [];
    for (const diff of diffs) {
      const key = JSON.stringify([diff.path, diff.oldText, diff.newText]);
      if (!tool.diffs.some((old) => JSON.stringify([old.path, old.oldText, old.newText]) === key)) {
        tool.diffs.push(diff);
      }
    }
    if (Object.prototype.hasOwnProperty.call(row, 'rawOutput')) tool.rawOutput = row.rawOutput;

    const events: AgentEvent[] = [];
    const canStart = Object.keys(tool.input).length > 0 || status === 'in_progress' || terminal || tool.diffs.length > 0;
    if (!tool.started && canStart) {
      events.push(...this.closeThinking(now));
      tool.started = true;
      tool.startedAt = now;
      events.push({ type: 'tool.start', toolUseId: id, name: tool.name, input: { ...tool.input }, at: now });
      tool.progress = progressKey(row, tool);
    } else if (tool.started && !terminal) {
      const progress = progressKey(row, tool);
      if (progress !== tool.progress) {
        events.push({
          type: 'tool.progress', toolUseId: id, name: tool.name,
          elapsedMs: Math.max(0, now - tool.startedAt),
        });
        tool.progress = progress;
      }
    }
    if (!terminal) return events;

    const out = toolOutput(row, tool, status === 'failed');
    events.push({
      type: 'tool.result', toolUseId: id, isError: out.isError, content: out.content,
      ...(out.result !== undefined ? { result: out.result } : {}),
      at: now, durationMs: Math.max(0, now - tool.startedAt),
    });
    this.tools.delete(id);
    this.finished.add(id);
    return events;
  }
}

function imageRef(image: PromptImage): ImageRef {
  return {
    mediaType: image.mediaType, data: image.data,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    ...(image.name !== undefined ? { name: image.name } : {}),
  };
}

function fileRef(file: PromptFile): FileRef {
  return {
    kind: file.kind,
    path: file.path,
    size: file.size,
    ...(file.pages !== undefined ? { pages: file.pages } : {}),
  };
}

function progressKey(row: Record<string, unknown>, tool: ToolState): string {
  return JSON.stringify([row.title, row.status, tool.input, tool.diffs]);
}

/** Title у lazy/canonical кадров информативнее generic kind (`read` у Read и Grep). */
export function toolName(row: Record<string, unknown>): string {
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const titled = nameFromTitle(title);
  if (titled) return titled;
  const raw = typeof row.name === 'string' && row.name.trim()
    ? row.name.trim()
    : typeof row.rawName === 'string' && row.rawName.trim() ? row.rawName.trim() : '';
  if (raw) return raw;
  if (row.kind === 'execute') return 'Bash';
  if (row.kind === 'read') return 'Read';
  if (row.kind === 'edit') return 'Edit';
  return title || (typeof row.kind === 'string' && row.kind ? row.kind : 'tool');
}

function nameFromTitle(title: string): string | undefined {
  if (/^Read(?:ing)?\b/i.test(title)) return 'Read';
  if (/^(?:Grep|Searching)\b/i.test(title)) return 'Grep';
  if (/^(?:Bash|Running)\b/i.test(title)) return 'Bash';
  if (/^Edit(?:ing)?\b/i.test(title)) return 'Edit';
  if (/^Write(?:ing)?\b/i.test(title)) return 'Write';
  if (/^Launching\b.*\bagent\b/i.test(title)) return 'Agent';
  for (const name of ['AgentSwarm', 'Agent', 'Skill', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode', 'Task']) {
    if (title === name || title.startsWith(`${name}:`)) return name;
  }
  return undefined;
}

export function mapToolInput(name: string, raw: Record<string, unknown>): Record<string, unknown> {
  if (!['Read', 'Grep', 'Edit', 'Write'].includes(name)) return { ...raw };
  const input = { ...raw };
  const path = input.path;
  delete input.path;
  return { ...input, ...(typeof path === 'string' ? { file_path: path } : {}) };
}

function toolOutput(
  row: Record<string, unknown>,
  tool: ToolState,
  failed: boolean,
): { content: string; result?: unknown; isError: boolean } {
  const raw = tool.rawOutput;
  const rawRow = record(raw);
  const exit = rawRow && typeof rawRow.exit_code === 'number'
    ? rawRow.exit_code
    : rawRow && typeof rawRow.exitCode === 'number' ? rawRow.exitCode : undefined;
  const isError = failed || (exit !== undefined && exit !== 0);
  if (tool.diffs.length) {
    const allHunks = tool.diffs.flatMap((diff) => {
      const path = typeof diff.path === 'string' ? diff.path : '';
      const oldText = typeof diff.oldText === 'string' ? diff.oldText : '';
      const newText = typeof diff.newText === 'string' ? diff.newText : '';
      return structuredPatch(path, path, oldText, newText).hunks;
    });
    const first = tool.diffs[0]!;
    const filePath = typeof first.path === 'string' ? first.path : '';
    const oldText = typeof first.oldText === 'string' ? first.oldText : '';
    const newText = typeof first.newText === 'string' ? first.newText : '';
    const isNew = first.oldText === undefined;
    return {
      content: rawText(raw) || contentText(row) || `${filePath}\n${newText}`,
      result: {
        filePath,
        type: isNew ? 'create' : 'update',
        structuredPatch: allHunks,
        content: newText,
        ...(isNew ? {} : { originalFile: oldText, oldString: oldText, newString: newText }),
      },
      isError,
    };
  }
  if (raw !== undefined) return { content: rawText(raw) || contentText(row), result: raw, isError };
  return { content: contentText(row), isError };
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const row = record(raw);
  if (!row) return '';
  for (const key of ['output', 'stdout', 'content']) {
    if (typeof row[key] === 'string' && row[key]) return row[key] as string;
  }
  return JSON.stringify(raw);
}

function contentText(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const block of Array.isArray(row.content) ? row.content : []) {
    const wrapper = record(block);
    const content = wrapper?.type === 'content' ? record(wrapper.content) : wrapper;
    if (content?.type === 'text' && typeof content.text === 'string' && content.text) parts.push(content.text);
  }
  return parts.join('\n');
}
