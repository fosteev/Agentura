import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { streamLines } from '../../data/jsonlStream';
import { hostStrings, type Lang } from '../../shared/l10n';
import type { AgentEvent, AgentEventOf, TokenUsage } from '../types';
import { buildAgyContextUsage, DEFAULT_AGY_DATA_DIR } from './context';
import { mapAgyTool } from './tools';

const AGY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BG_TASK_RE =
  /Tool is running as a background task with task id:\s*(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(task-\d+))/i;
const EXIT_CODE_RE = /\bCommand exited with code (-?\d+)\b/;
const HEADER_STRIP_RE = /^(?:(?:Created|Completed) At:[^\n]*\n)+/i;
const SYSTEM_MSG_BLOCK_RE = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/gi;
const MESSAGE_PREFIX_RE = /^\[Message\][^\n]*?\bcontent=([\s\S]*)$/;
const SENDER_RE = /\[Message\][^\n]*?\bsender=([^\s]+)/;

export const DEFAULT_WAITING_THRESHOLD_MS = 2500;
export const DEFAULT_SUBAGENT_POLL_MS = 400;
export const MAX_SUBAGENT_TIMELINES = 30;
export const MAX_SUBAGENT_EVENTS = 400;
const MAX_NESTED_DEPTH = 2;
const RESULT_LINES = 30;
const RESULT_CHARS = 3000;

export interface AgySubagentMeta {
  description?: string;
  agentType?: string;
}

export interface ManagedSubagentsResult {
  action: 'list' | 'kill' | 'kill_all' | undefined;
  waitingIds: string[];
  killedIds: string[];
  killAll: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function hasErrorField(err: unknown): boolean {
  return err !== undefined && err !== null && err !== false && err !== '';
}

export function isValidAgyUuid(id: unknown): id is string {
  return typeof id === 'string' && AGY_UUID_RE.test(id);
}

export function agyTranscriptPath(
  sessionId: string,
  dataDir: string = DEFAULT_AGY_DATA_DIR,
): string | undefined {
  if (!isValidAgyUuid(sessionId)) return undefined;
  return path.join(dataDir, 'brain', sessionId.toLowerCase(), '.system_generated', 'logs', 'transcript.jsonl');
}

export function nonZeroExitCode(content: string): boolean {
  const m = EXIT_CODE_RE.exec(content);
  if (!m) return false;
  const code = Number.parseInt(m[1]!, 10);
  return Number.isFinite(code) && code !== 0;
}

/**
 * Извлекает валидный `conversationId` из вывода `invoke_subagent`.
 * Отвергает любые не-UUID строки (защита от path traversal).
 */
export function parseCreatedSubagent(content: string): string | undefined {
  if (!content) return undefined;
  const trimmed = content.replace(HEADER_STRIP_RE, '').trim();
  if (!trimmed) return undefined;

  const tryJson = (raw: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed) && isValidAgyUuid(parsed['conversationId'])) {
        return parsed['conversationId'].toLowerCase();
      }
    } catch {
      // fallback below
    }
    return undefined;
  };

  if (trimmed.startsWith('{')) {
    const direct = tryJson(trimmed);
    if (direct) return direct;
  }

  const markerIdx = trimmed.toLowerCase().indexOf('created the following subagent');
  if (markerIdx >= 0) {
    const after = trimmed.slice(markerIdx);
    const braceStart = after.indexOf('{');
    const braceEnd = after.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      const fromJson = tryJson(after.slice(braceStart, braceEnd + 1));
      if (fromJson) return fromJson;
    }
    const m = /"conversationId"\s*:\s*"([^"]+)"/i.exec(after);
    if (m && isValidAgyUuid(m[1])) return m[1].toLowerCase();
  }

  return undefined;
}

/**
 * Разбирает вызов и вывод `manage_subagents` (`list` | `kill` | `kill_all`):
 * - `waitingIds`: `conversationId` со статусом `waiting_for_input` из `list`;
 * - `killedIds` / `killAll`: остановленные субагенты из `kill` / `kill_all`.
 */
export function parseManagedSubagents(
  input: Record<string, unknown>,
  content: string,
  isError = false,
): ManagedSubagentsResult {
  const rawAction = pickStr(input, 'Action', 'action')?.toLowerCase();
  const action =
    rawAction === 'list' || rawAction === 'kill' || rawAction === 'kill_all' ? rawAction : undefined;
  if (isError || !action) {
    return { action, waitingIds: [], killedIds: [], killAll: false };
  }

  if (action === 'list') {
    const waiting = new Set<string>();
    const body = content.replace(HEADER_STRIP_RE, '').trim();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (!isPlainObject(node)) return;
      const cid = node['conversationId'] ?? node['id'];
      const st = node['state'] ?? node['status'];
      if (
        isValidAgyUuid(cid) &&
        typeof st === 'string' &&
        st.toLowerCase() === 'waiting_for_input'
      ) {
        waiting.add(cid.toLowerCase());
      }
      for (const val of Object.values(node)) {
        if (val && typeof val === 'object') visit(val);
      }
    };

    let parsedOk = false;
    const candidates = [body];
    const firstBracket = body.search(/[[{]/);
    if (firstBracket > 0) candidates.push(body.slice(firstBracket));
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        visit(JSON.parse(candidate));
        parsedOk = true;
        break;
      } catch {
        // try fallback
      }
    }

    if (!parsedOk && body.includes('waiting_for_input')) {
      const objRe = /\{[^{}]*\}/g;
      let m: RegExpExecArray | null;
      while ((m = objRe.exec(body)) !== null) {
        const block = m[0];
        if (!/waiting_for_input/i.test(block)) continue;
        const idMatch = /"(?:conversationId|id)"\s*:\s*"([^"]+)"/i.exec(block);
        if (idMatch && isValidAgyUuid(idMatch[1])) {
          waiting.add(idMatch[1].toLowerCase());
        }
      }
      for (const line of body.split('\n')) {
        if (!/waiting_for_input/i.test(line)) continue;
        const uuidMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(line);
        if (uuidMatch && isValidAgyUuid(uuidMatch[1])) {
          waiting.add(uuidMatch[1].toLowerCase());
        }
      }
    }

    return { action, waitingIds: [...waiting], killedIds: [], killAll: false };
  }

  const killed = new Set<string>();
  const rawIds = input['ConversationIds'] ?? input['conversationIds'];
  if (Array.isArray(rawIds)) {
    for (const item of rawIds) {
      if (isValidAgyUuid(item)) killed.add(item.toLowerCase());
    }
  }
  const uuidGlobal = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  let match: RegExpExecArray | null;
  while ((match = uuidGlobal.exec(content)) !== null) {
    if (isValidAgyUuid(match[0])) killed.add(match[0].toLowerCase());
  }

  return {
    action,
    waitingIds: [],
    killedIds: [...killed],
    killAll: action === 'kill_all',
  };
}

/**
 * Аккуратно извлекает тело сообщения из обёртки `<SYSTEM_MESSAGE>\n[Message] ... content=...`.
 */
export function unwrapAgySystemMessage(raw: string): string {
  if (!raw) return '';
  const blocks: string[] = [];
  SYSTEM_MSG_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SYSTEM_MSG_BLOCK_RE.exec(raw)) !== null) {
    const inner = m[1]!.trim();
    const msgMatch = MESSAGE_PREFIX_RE.exec(inner);
    blocks.push((msgMatch ? msgMatch[1]! : inner).trim());
  }
  if (blocks.length > 0) {
    return blocks.filter(Boolean).join('\n\n');
  }
  const msgMatch = MESSAGE_PREFIX_RE.exec(raw.trim());
  return (msgMatch ? msgMatch[1]! : raw).trim();
}

function extractSystemSender(raw: string): string | undefined {
  const m = SENDER_RE.exec(raw);
  return m?.[1]?.trim();
}

function stepTokensOf(record: Record<string, unknown>): { total: number; usage: TokenUsage } | undefined {
  const isValid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const inTok = record['input_tokens'];
  const cacheRead = record['cache_read_tokens'];
  const cacheWrite = record['cache_write_tokens'];
  const outTok = record['output_tokens'];
  if (!isValid(inTok) && !isValid(cacheRead) && !isValid(cacheWrite) && !isValid(outTok)) {
    return undefined;
  }
  const input = isValid(inTok) ? inTok : 0;
  const cr = isValid(cacheRead) ? cacheRead : 0;
  const cw = isValid(cacheWrite) ? cacheWrite : 0;
  const output = isValid(outTok) ? outTok : 0;
  return {
    total: input + cr + cw + output,
    usage: { input, output, cacheRead: cr, cacheWrite: cw },
  };
}

function pickSubagentSummary(
  sendMessageText: string | undefined,
  finalContent: string | undefined,
): string | undefined {
  const msg = sendMessageText?.trim() || undefined;
  const fin = finalContent?.trim() || undefined;
  if (msg && (!fin || fin.length <= 160 || msg.length >= fin.length)) {
    return msg;
  }
  return fin ?? msg;
}

interface PendingSubagentTool {
  toolUseId: string;
  rawName: string;
  rawArgs: Record<string, unknown>;
  mappedName: string;
  mappedInput: Record<string, unknown>;
  stepIndex: number;
  callIndex: number;
  at: number;
  seenAt: number;
}

interface ActiveBgTask {
  agentId: string;
  taskId: string;
  startedAt: number;
}

function blockingDescription(tool: PendingSubagentTool): string {
  if (tool.mappedName === 'Bash') {
    const cmd = pickStr(tool.mappedInput, 'command', 'description');
    return cmd ? `Bash: ${cmd.slice(0, 80)}` : 'Bash';
  }
  const file = pickStr(tool.mappedInput, 'file_path', 'notebook_path');
  if (file) return `${tool.mappedName}: ${path.basename(file)}`;
  return tool.mappedName;
}

/**
 * Инкрементальный байтовый курсор для чтения `transcript.jsonl` строго по дописанному хвосту:
 * читает `fs.open` / `fh.read` с `byteOffset` только когда `stat.size > byteOffset`,
 * а незавершённую строку без финального `\n` держит в `Buffer` до следующего чтения.
 */
class ByteLineTailer {
  private byteOffset = 0;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(private readonly filePath: string) {}

  get offset(): number {
    return this.byteOffset;
  }

  async readNewLines(): Promise<string[]> {
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(this.filePath, 'r');
      const { size } = await fh.stat();
      if (size < this.byteOffset) {
        // Файл пересоздан с меньшим размером — сбрасываем курсор.
        this.byteOffset = 0;
        this.remainder = Buffer.alloc(0);
      }
      if (size <= this.byteOffset) return [];

      const toRead = size - this.byteOffset;
      const chunk = Buffer.allocUnsafe(toRead);
      let readTotal = 0;
      while (readTotal < toRead) {
        const { bytesRead } = await fh.read(chunk, readTotal, toRead - readTotal, this.byteOffset + readTotal);
        if (bytesRead === 0) break;
        readTotal += bytesRead;
      }
      if (readTotal === 0) return [];
      this.byteOffset += readTotal;

      const slice = readTotal === toRead ? chunk : chunk.subarray(0, readTotal);
      const combined = this.remainder.length > 0 ? Buffer.concat([this.remainder, slice]) : slice;
      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl === -1) {
        this.remainder = Buffer.from(combined);
        return [];
      }
      const text = combined.subarray(0, lastNl).toString('utf8');
      this.remainder = Buffer.from(combined.subarray(lastNl + 1));
      return text.split('\n');
    } catch {
      return [];
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  /** Сдвигает курсор в конец текущего файла (используется для синхронизации родительского транскрипта после ACP-хода). */
  async skipToEnd(): Promise<{ maxStepIndex: number; usedTokens?: number }> {
    const lines = await this.readNewLines();
    let maxStepIndex = -1;
    let usedTokens: number | undefined;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const rec: unknown = JSON.parse(line);
        if (!isPlainObject(rec)) continue;
        if (typeof rec['step_index'] === 'number' && Number.isFinite(rec['step_index'])) {
          maxStepIndex = Math.max(maxStepIndex, rec['step_index']);
        }
        if (rec['type'] === 'PLANNER_RESPONSE' && rec['status'] === 'DONE') {
          const tok = stepTokensOf(rec);
          if (tok) usedTokens = tok.total;
        }
      } catch {
        // ignore malformed line
      }
    }
    return { maxStepIndex, ...(usedTokens !== undefined ? { usedTokens } : {}) };
  }
}

export interface AgySubagentReaderOptions {
  agentId: string;
  childUuid: string;
  dataDir?: string;
  mcpServers?: readonly string[];
  waitingThresholdMs?: number;
  depth?: number;
  maxDepth?: number;
  parentAgentId?: string;
  parentSessionId?: string;
  description?: string;
  subagentType?: string;
  prompt?: string;
  model?: string;
  startedAt?: number;
  visitedUuids?: ReadonlySet<string>;
  onSubagentMeta?: (childUuid: string, meta: AgySubagentMeta) => void;
}

/**
 * Инкрементальный read-only ридер `brain/<childUuid>/.system_generated/logs/transcript.jsonl`.
 */
export class AgySubagentReader {
  readonly agentId: string;
  readonly childUuid: string;
  private readonly dataDir: string;
  private readonly mcpServers: readonly string[] | undefined;
  private readonly waitingThresholdMs: number;
  private readonly depth: number;
  private readonly maxDepth: number;
  private readonly parentAgentId: string | undefined;
  private readonly parentSessionId: string | undefined;
  private description: string;
  private subagentType: string | undefined;
  private prompt: string | undefined;
  private model: string | undefined;
  private readonly visitedUuids: Set<string>;
  private readonly onSubagentMeta: ((childUuid: string, meta: AgySubagentMeta) => void) | undefined;
  private readonly tailer: ByteLineTailer | undefined;

  private startedAt: number;
  private startedAtLocked = false;
  private lastProcessedStep = -1;
  private completedStepIndex = -1;
  private rounds = 1;
  private roundCompleted = false;
  private stopped = false;
  private waitingEmitted = false;
  private totalTokens: number | undefined;
  private toolUses = 0;
  private lastToolName: string | undefined;
  private lastSendMessageSummary: string | undefined;
  private readonly openTools: PendingSubagentTool[] = [];
  private readonly activeBgTasks = new Map<string, ActiveBgTask>();
  private readonly nestedReaders = new Map<string, AgySubagentReader>();

  constructor(options: AgySubagentReaderOptions) {
    this.agentId = options.agentId;
    this.childUuid = options.childUuid.toLowerCase();
    this.dataDir = options.dataDir ?? DEFAULT_AGY_DATA_DIR;
    this.mcpServers = options.mcpServers;
    this.waitingThresholdMs = options.waitingThresholdMs ?? DEFAULT_WAITING_THRESHOLD_MS;
    this.depth = options.depth ?? 1;
    this.maxDepth = options.maxDepth ?? MAX_NESTED_DEPTH;
    this.parentAgentId = options.parentAgentId;
    this.parentSessionId = options.parentSessionId?.toLowerCase();
    this.description = options.description || options.subagentType || 'subagent';
    this.subagentType = options.subagentType;
    this.prompt = options.prompt;
    this.model = options.model;
    this.startedAt = options.startedAt ?? Date.now();
    this.startedAtLocked = options.startedAt !== undefined;
    this.visitedUuids = new Set(options.visitedUuids ?? []);
    this.visitedUuids.add(this.childUuid);
    this.onSubagentMeta = options.onSubagentMeta;
    const filePath = agyTranscriptPath(this.childUuid, this.dataDir);
    this.tailer = filePath ? new ByteLineTailer(filePath) : undefined;
  }

  get byteOffset(): number {
    return this.tailer?.offset ?? 0;
  }

  isRoundCompleted(): boolean {
    return this.roundCompleted;
  }

  roundsCount(): number {
    return this.rounds;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  isActive(): boolean {
    if (this.stopped) return false;
    if (!this.roundCompleted) return true;
    for (const nested of this.nestedReaders.values()) {
      if (nested.isActive()) return true;
    }
    return false;
  }

  buildStartEvent(at?: number): AgentEventOf<'agent.start'> {
    return {
      type: 'agent.start',
      agentId: this.agentId,
      taskId: this.childUuid,
      description: this.description,
      taskType: 'subagent',
      ...(this.subagentType ? { subagentType: this.subagentType } : {}),
      ...(this.parentAgentId ? { parentAgentId: this.parentAgentId } : {}),
      ...(this.prompt ? { prompt: this.prompt } : {}),
      ...(this.model ? { model: this.model } : {}),
      background: true,
      ...(at !== undefined ? { at } : {}),
    };
  }

  /** Переоткрывает завершённого субагента при новом сообщении `send_message` от родителя. */
  reopen(now = Date.now(), prompt?: string): AgentEvent[] {
    this.stopped = false;
    this.roundCompleted = false;
    this.waitingEmitted = false;
    this.lastSendMessageSummary = undefined;
    if (prompt) this.prompt = prompt;
    return [this.buildStartEvent(now)];
  }

  reopenByUuid(targetUuid: string, now = Date.now(), prompt?: string): AgentEvent[] {
    const norm = targetUuid.toLowerCase();
    if (norm === this.childUuid) return this.reopen(now, prompt);
    for (const nested of this.nestedReaders.values()) {
      const evs = nested.reopenByUuid(norm, now, prompt);
      if (evs.length > 0) return evs;
    }
    return [];
  }

  /** Внешний сигнал `manage_subagents(list)` со `state === 'waiting_for_input'`. */
  markWaitingByUuid(targetUuid: string, now = Date.now()): AgentEvent[] {
    const norm = targetUuid.toLowerCase();
    if (norm === this.childUuid) {
      return this.emitWaitingOnce(now);
    }
    for (const nested of this.nestedReaders.values()) {
      const evs = nested.markWaitingByUuid(norm, now);
      if (evs.length > 0) return evs;
    }
    return [];
  }

  /** Останавливает субагента и всех его активных потомков (`manage_subagents(kill | kill_all)` или закрытая история). */
  stopAll(now = Date.now()): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const nested of this.nestedReaders.values()) {
      if (nested.isActive()) {
        out.push(...nested.stopAll(now));
      }
    }
    out.push(...this.closeAllBgTasks('stopped', now));
    this.openTools.length = 0;
    this.waitingEmitted = false;
    if (!this.stopped && !this.roundCompleted) {
      this.stopped = true;
      this.roundCompleted = true;
      out.push({
        type: 'agent.end',
        agentId: this.agentId,
        taskId: this.childUuid,
        status: 'stopped',
        ...(this.totalTokens !== undefined ? { totalTokens: this.totalTokens } : {}),
        toolUses: this.toolUses,
        durationMs: Math.max(0, now - this.startedAt),
        at: now,
      });
    } else {
      this.stopped = true;
    }
    return out;
  }

  stopByUuid(targetUuid: string, now = Date.now()): AgentEvent[] {
    const norm = targetUuid.toLowerCase();
    if (norm === this.childUuid) {
      this.stopped = false;
      this.roundCompleted = false;
      return this.stopAll(now);
    }
    const nested = this.nestedReaders.get(norm);
    if (nested) {
      return nested.stopByUuid(norm, now);
    }
    for (const child of this.nestedReaders.values()) {
      const evs = child.stopByUuid(norm, now);
      if (evs.length > 0) return evs;
    }
    return [];
  }

  async poll(now = Date.now()): Promise<AgentEvent[]> {
    if (!this.tailer || this.stopped) return [];
    const out: AgentEvent[] = [];
    const lines = await this.tailer.readNewLines();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(row)) continue;
      out.push(...this.processRecord(row, now));
    }

    // Проверяем зависание открытого тула без парного GENERIC дольше waitingThresholdMs
    if (!this.roundCompleted && !this.waitingEmitted && this.openTools.length > 0) {
      const head = this.openTools[0]!;
      if (now - head.seenAt >= this.waitingThresholdMs) {
        out.push(...this.emitWaitingOnce(now));
      }
    }

    // Рекурсивно опрашиваем вложенных субагентов (до глубины maxDepth)
    for (const nested of this.nestedReaders.values()) {
      if (!nested.isStopped()) {
        out.push(...(await nested.poll(now)));
      }
    }

    return out;
  }

  private emitWaitingOnce(now: number): AgentEvent[] {
    if (this.waitingEmitted || this.roundCompleted || this.stopped) return [];
    this.waitingEmitted = true;
    const head = this.openTools[0];
    const desc = head ? blockingDescription(head) : 'waiting_for_input';
    return [
      {
        type: 'agent.progress',
        agentId: this.agentId,
        taskId: this.childUuid,
        status: 'waiting_for_input',
        description: desc,
        ...(head ? { lastToolName: head.mappedName } : this.lastToolName ? { lastToolName: this.lastToolName } : {}),
        ...(this.totalTokens !== undefined ? { totalTokens: this.totalTokens } : {}),
        toolUses: this.toolUses,
        durationMs: Math.max(0, now - this.startedAt),
      },
    ];
  }

  private closeAllBgTasks(status: 'completed' | 'failed' | 'stopped', at: number): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const [key, bg] of this.activeBgTasks) {
      this.activeBgTasks.delete(key);
      out.push({
        type: 'agent.end',
        agentId: bg.agentId,
        taskId: bg.taskId,
        status,
        durationMs: Math.max(0, at - bg.startedAt),
        at,
      });
    }
    return out;
  }

  private processRecord(row: Record<string, unknown>, now: number): AgentEvent[] {
    const stepIndex =
      typeof row['step_index'] === 'number' && Number.isFinite(row['step_index'])
        ? row['step_index']
        : this.lastProcessedStep + 1;
    if (stepIndex <= this.lastProcessedStep) return [];

    const rowType = typeof row['type'] === 'string' ? row['type'] : '';
    const status = typeof row['status'] === 'string' ? row['status'] : 'DONE';
    const at = parseTimestamp(row['created_at']) ?? now;
    if (!this.startedAtLocked && this.lastProcessedStep < 0 && parseTimestamp(row['created_at']) !== undefined) {
      this.startedAt = at;
      this.startedAtLocked = true;
    }

    if (rowType === 'SYSTEM_MESSAGE' || rowType === 'USER_INPUT') {
      this.lastProcessedStep = stepIndex;
      const out: AgentEvent[] = [];
      const rawContent = typeof row['content'] === 'string' ? row['content'] : '';
      const sender = extractSystemSender(rawContent);
      if (sender && this.activeBgTasks.has(sender)) {
        const bg = this.activeBgTasks.get(sender)!;
        this.activeBgTasks.delete(sender);
        const body = unwrapAgySystemMessage(rawContent);
        const bgStatus: 'completed' | 'failed' | 'stopped' = /was cancel+ed/i.test(body)
          ? 'stopped'
          : nonZeroExitCode(body)
            ? 'failed'
            : 'completed';
        out.push({
          type: 'agent.end',
          agentId: bg.agentId,
          taskId: bg.taskId,
          status: bgStatus,
          durationMs: Math.max(0, at - bg.startedAt),
          at,
        });
      }

      const cleanPrompt = unwrapAgySystemMessage(rawContent);
      if (!this.prompt && cleanPrompt && stepIndex === 0) {
        this.prompt = cleanPrompt;
      }

      if (this.roundCompleted && stepIndex > this.completedStepIndex) {
        this.rounds += 1;
        this.roundCompleted = false;
        this.waitingEmitted = false;
        this.lastSendMessageSummary = undefined;
        out.push(this.buildStartEvent(at));
      }
      return out;
    }

    if (rowType === 'PLANNER_RESPONSE') {
      if (status !== 'DONE') return [];
      this.lastProcessedStep = stepIndex;
      const out: AgentEvent[] = [];

      if (this.roundCompleted) {
        this.roundCompleted = false;
        this.waitingEmitted = false;
        this.lastSendMessageSummary = undefined;
        out.push(this.buildStartEvent(at));
      }

      // Если предыдущий PLANNER_RESPONSE имел несколько tool_calls, а GENERIC пришёл пачкой — дозакрываем остаток
      while (this.openTools.length > 0 && this.openTools[0]!.stepIndex < stepIndex) {
        const orphan = this.openTools.shift()!;
        out.push({
          type: 'tool.result',
          agentId: this.agentId,
          toolUseId: orphan.toolUseId,
          isError: false,
          content: '',
          at,
          durationMs: Math.max(0, at - orphan.at),
        });
      }

      this.waitingEmitted = false;
      const tok = stepTokensOf(row);
      if (tok) this.totalTokens = tok.total;

      const thinking = typeof row['thinking'] === 'string' ? row['thinking'].trim() : '';
      if (thinking) {
        const msgId = `agy-th:${this.childUuid}:${stepIndex}`;
        out.push({ type: 'thinking.start', agentId: this.agentId, messageId: msgId, at });
        out.push({ type: 'thinking.stop', agentId: this.agentId, messageId: msgId, at });
      }

      const rawCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : [];
      const calls = rawCalls.filter(isPlainObject);
      if (calls.length > 0) {
        calls.forEach((call, callIndex) => {
          const rawName = typeof call['name'] === 'string' && call['name'].trim() ? call['name'].trim() : 'tool';
          const rawArgs = isPlainObject(call['args']) ? call['args'] : {};
          const mapped = mapAgyTool(rawName, rawArgs, this.mcpServers);
          const toolUseId = `agy-tc:${this.childUuid}:${stepIndex}:${callIndex}`;
          this.toolUses += 1;
          this.lastToolName = mapped.name;

          if (rawName === 'send_message') {
            const msg = pickStr(rawArgs, 'Message', 'message');
            const recipient = pickStr(rawArgs, 'Recipient', 'recipient')?.toLowerCase();
            if (msg) {
              if (!this.parentSessionId || !recipient || recipient === this.parentSessionId) {
                this.lastSendMessageSummary = msg;
              } else if (!this.lastSendMessageSummary && !this.nestedReaders.has(recipient)) {
                this.lastSendMessageSummary = msg;
              }
            }
          }

          this.openTools.push({
            toolUseId,
            rawName,
            rawArgs,
            mappedName: mapped.name,
            mappedInput: mapped.input,
            stepIndex,
            callIndex,
            at,
            seenAt: now,
          });
          out.push({
            type: 'tool.start',
            agentId: this.agentId,
            toolUseId,
            name: mapped.name,
            input: { ...mapped.input },
            at,
          });
        });

        out.push({
          type: 'agent.progress',
          agentId: this.agentId,
          taskId: this.childUuid,
          ...(this.lastToolName ? { lastToolName: this.lastToolName } : {}),
          ...(this.totalTokens !== undefined ? { totalTokens: this.totalTokens } : {}),
          toolUses: this.toolUses,
          durationMs: Math.max(0, at - this.startedAt),
        });
        return out;
      }

      if (this.openTools.length === 0) {
        const finalText = typeof row['content'] === 'string' ? row['content'] : undefined;
        const summary = pickSubagentSummary(this.lastSendMessageSummary, finalText);
        out.push(...this.closeAllBgTasks('completed', at));
        this.roundCompleted = true;
        this.completedStepIndex = stepIndex;
        out.push({
          type: 'agent.end',
          agentId: this.agentId,
          taskId: this.childUuid,
          status: 'completed',
          ...(summary ? { summary } : {}),
          ...(this.totalTokens !== undefined ? { totalTokens: this.totalTokens } : {}),
          toolUses: this.toolUses,
          durationMs: Math.max(0, at - this.startedAt),
          at,
        });
      }
      return out;
    }

    if (rowType === 'GENERIC') {
      if (
        status !== 'DONE' &&
        status !== 'ERROR' &&
        status !== 'CANCELED' &&
        status !== 'CANCELLED'
      ) {
        return [];
      }
      this.lastProcessedStep = stepIndex;
      this.waitingEmitted = false;
      const pending = this.openTools.shift();
      if (!pending) return [];

      const content =
        typeof row['content'] === 'string'
          ? row['content']
          : hasErrorField(row['error'])
            ? typeof row['error'] === 'string'
              ? row['error']
              : JSON.stringify(row['error'])
            : '';
      const isError =
        status !== 'DONE' || hasErrorField(row['error']) || nonZeroExitCode(content);
      const out: AgentEvent[] = [
        {
          type: 'tool.result',
          agentId: this.agentId,
          toolUseId: pending.toolUseId,
          isError,
          content: content.slice(0, 4000),
          at,
          durationMs: Math.max(0, at - pending.at),
        },
      ];

      // 1) Фоновая команда внутри субагента -> local_bash с parentAgentId
      if (pending.rawName === 'run_command' && !isError) {
        const bgMatch = BG_TASK_RE.exec(content);
        if (bgMatch) {
          const fullTaskId = bgMatch[1]!;
          const taskSuffix = bgMatch[3]!.toLowerCase();
          const bgAgentId = `agy-task:${this.childUuid}:${taskSuffix}`;
          const desc =
            pickStr(pending.rawArgs, 'toolSummary', 'CommandLine', 'command') ?? taskSuffix;
          this.activeBgTasks.set(fullTaskId, {
            agentId: bgAgentId,
            taskId: fullTaskId,
            startedAt: at,
          });
          out.push({
            type: 'agent.start',
            agentId: bgAgentId,
            taskId: fullTaskId,
            description: desc,
            taskType: 'local_bash',
            background: true,
            parentAgentId: this.agentId,
            at,
          });
        }
      }

      // 2) Остановка фоновой команды через manage_task(kill)
      if (pending.rawName === 'manage_task' && !isError) {
        const action = pickStr(pending.rawArgs, 'Action', 'action')?.toLowerCase();
        const taskId = pickStr(pending.rawArgs, 'TaskId', 'taskId');
        if (action === 'kill' && taskId && this.activeBgTasks.has(taskId)) {
          const bg = this.activeBgTasks.get(taskId)!;
          this.activeBgTasks.delete(taskId);
          out.push({
            type: 'agent.end',
            agentId: bg.agentId,
            taskId: bg.taskId,
            status: 'stopped',
            durationMs: Math.max(0, at - bg.startedAt),
            at,
          });
        }
      }

      // 3) Вложенный invoke_subagent (рекурсивно до maxDepth = 2)
      if (pending.rawName === 'invoke_subagent' && !isError && this.depth < this.maxDepth) {
        const nestedUuid = parseCreatedSubagent(content);
        if (nestedUuid && !this.visitedUuids.has(nestedUuid)) {
          const nestedAgentId = `agy-sub:${this.childUuid}:${pending.stepIndex}:${pending.callIndex}`;
          const subType = pickStr(pending.rawArgs, 'TypeName', 'subagent_type');
          const desc = pickStr(pending.rawArgs, 'Role', 'TypeName', 'description') ?? 'subagent';
          const prompt = pickStr(pending.rawArgs, 'Prompt', 'prompt');
          const rawModel = pickStr(pending.rawArgs, 'Model', 'model');
          const nestedModel =
            rawModel && rawModel !== 'inherit' ? rawModel : this.model;
          this.onSubagentMeta?.(nestedUuid, {
            description: desc,
            ...(subType ? { agentType: subType } : {}),
          });
          const nestedReader = new AgySubagentReader({
            agentId: nestedAgentId,
            childUuid: nestedUuid,
            dataDir: this.dataDir,
            ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
            waitingThresholdMs: this.waitingThresholdMs,
            depth: this.depth + 1,
            maxDepth: this.maxDepth,
            parentAgentId: this.agentId,
            parentSessionId: this.childUuid,
            description: desc,
            ...(subType ? { subagentType: subType } : {}),
            ...(prompt ? { prompt } : {}),
            ...(nestedModel ? { model: nestedModel } : {}),
            startedAt: at,
            visitedUuids: this.visitedUuids,
            ...(this.onSubagentMeta ? { onSubagentMeta: this.onSubagentMeta } : {}),
          });
          this.nestedReaders.set(nestedUuid, nestedReader);
          out.push(nestedReader.buildStartEvent(at));
        }
      }

      // 4) send_message вложенному субагенту
      if (pending.rawName === 'send_message' && !isError) {
        const recipient = pickStr(pending.rawArgs, 'Recipient', 'recipient')?.toLowerCase();
        const msg = pickStr(pending.rawArgs, 'Message', 'message');
        if (recipient && this.nestedReaders.has(recipient)) {
          out.push(...this.nestedReaders.get(recipient)!.reopen(at, msg));
        }
      }

      // 5) manage_subagents внутри субагента
      if (pending.rawName === 'manage_subagents') {
        const managed = parseManagedSubagents(pending.rawArgs, content, isError);
        if (managed.action === 'list') {
          for (const id of managed.waitingIds) {
            const nested = this.nestedReaders.get(id);
            if (nested) out.push(...nested.markWaitingByUuid(id, at));
          }
        } else if (managed.action === 'kill_all') {
          for (const nested of this.nestedReaders.values()) {
            if (nested.isActive()) out.push(...nested.stopAll(at));
          }
        } else if (managed.action === 'kill') {
          for (const id of managed.killedIds) {
            const nested = this.nestedReaders.get(id);
            if (nested) out.push(...nested.stopByUuid(id, at));
          }
        }
      }

      return out;
    }

    return [];
  }
}

interface PendingParentSilentTool {
  toolUseId: string;
  mappedName: string;
  mappedInput: Record<string, unknown>;
  stepIndex: number;
  at: number;
}

/**
 * Инкрементальный наблюдатель родительского `transcript.jsonl` для подхвата тихого реактивного хода
 * родителя в `agy acp 1.5.7` (когда hub-демон дописывает `SYSTEM_MESSAGE` → `PLANNER_RESPONSE`
 * без пуша `session/update` в ACP stdout).
 */
export class AgyParentTranscriptTailer {
  private readonly tailer: ByteLineTailer | undefined;
  private seq = 0;
  private silentTurn:
    | {
        startedAt: number;
        text: string;
        lastUsage: TokenUsage | undefined;
        openTools: PendingParentSilentTool[];
      }
    | undefined;
  /** Признак входящего SYSTEM_MESSAGE, открывающего реактивный ход родителя. */
  private reactiveTriggerSeen = false;

  constructor(
    sessionId: string,
    dataDir: string = DEFAULT_AGY_DATA_DIR,
    private readonly mcpServers?: readonly string[],
  ) {
    const filePath = agyTranscriptPath(sessionId, dataDir);
    this.tailer = filePath ? new ByteLineTailer(filePath) : undefined;
  }

  hasOpenTurn(): boolean {
    return this.silentTurn !== undefined;
  }

  discardOpenTurn(): void {
    this.silentTurn = undefined;
    this.reactiveTriggerSeen = false;
  }

  async syncToEnd(): Promise<{ maxStepIndex: number; usedTokens?: number }> {
    if (!this.silentTurn) this.reactiveTriggerSeen = false;
    if (!this.tailer) return { maxStepIndex: -1 };
    return this.tailer.skipToEnd();
  }

  flushOpenTurn(interrupted = false, now = Date.now()): AgentEvent[] {
    const st = this.silentTurn;
    if (!st) return [];
    this.silentTurn = undefined;
    this.reactiveTriggerSeen = false;
    const out: AgentEvent[] = [];
    for (const pending of st.openTools) {
      out.push({
        type: 'tool.result',
        toolUseId: pending.toolUseId,
        isError: interrupted,
        content: interrupted ? 'Interrupted' : '',
        at: now,
        durationMs: Math.max(0, now - pending.at),
      });
    }
    const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    out.push({
      type: 'turn.result',
      ok: !interrupted,
      subtype: interrupted ? 'cancelled' : 'end_turn',
      interrupted,
      durationMs: Math.max(0, now - st.startedAt),
      apiDurationMs: 0,
      numTurns: 1,
      usage: st.lastUsage ? { ...st.lastUsage } : ZERO,
      usageKnown: st.lastUsage !== undefined,
      totalCostUsd: 0,
      permissionDenials: [],
      ...(st.text ? { text: st.text } : {}),
    });
    return out;
  }

  async pollSilentTurn(
    lastStepIndex: number,
    model: string | undefined,
    now = Date.now(),
  ): Promise<{
    events: AgentEvent[];
    lastStepIndex: number;
    usedTokens?: number;
    completedTurn: boolean;
  }> {
    if (!this.tailer) {
      return { events: [], lastStepIndex, completedTurn: false };
    }
    const lines = await this.tailer.readNewLines();
    if (lines.length === 0) {
      return { events: [], lastStepIndex, completedTurn: false };
    }

    const events: AgentEvent[] = [];
    let maxStep = lastStepIndex;
    let latestTokens: number | undefined;
    let completedTurn = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(row)) continue;
      const stepIndex =
        typeof row['step_index'] === 'number' && Number.isFinite(row['step_index'])
          ? row['step_index']
          : -1;
      if (stepIndex <= maxStep) continue;

      const rowType = typeof row['type'] === 'string' ? row['type'] : '';
      const status = typeof row['status'] === 'string' ? row['status'] : 'DONE';
      const at = parseTimestamp(row['created_at']) ?? now;

      if (rowType === 'USER_INPUT') {
        maxStep = stepIndex;
        this.reactiveTriggerSeen = false;
        continue;
      }

      if (rowType === 'SYSTEM_MESSAGE') {
        maxStep = stepIndex;
        this.reactiveTriggerSeen = true;
        continue;
      }

      if (!this.reactiveTriggerSeen && !this.silentTurn) {
        maxStep = stepIndex;
        const tok = stepTokensOf(row);
        if (tok) latestTokens = tok.total;
        continue;
      }

      if (rowType === 'PLANNER_RESPONSE') {
        if (status !== 'DONE') continue;
        maxStep = stepIndex;
        const tok = stepTokensOf(row);
        if (tok) latestTokens = tok.total;

        if (!this.silentTurn) {
          this.silentTurn = {
            startedAt: at,
            text: '',
            lastUsage: tok?.usage,
            openTools: [],
          };
          events.push({ type: 'turn.start', at });
        } else if (tok?.usage) {
          this.silentTurn.lastUsage = tok.usage;
        }

        while (
          this.silentTurn.openTools.length > 0 &&
          this.silentTurn.openTools[0]!.stepIndex < stepIndex
        ) {
          const orphan = this.silentTurn.openTools.shift()!;
          events.push({
            type: 'tool.result',
            toolUseId: orphan.toolUseId,
            isError: false,
            content: '',
            at,
            durationMs: Math.max(0, at - orphan.at),
          });
        }

        const thinking = typeof row['thinking'] === 'string' ? row['thinking'] : '';
        if (thinking.trim()) {
          const thId = `st${++this.seq}`;
          events.push({ type: 'thinking.start', messageId: thId, at });
          events.push({ type: 'thinking.delta', messageId: thId, text: thinking });
          events.push({ type: 'thinking.stop', messageId: thId, at });
        }

        const rawCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : [];
        const calls = rawCalls.filter(isPlainObject);
        if (calls.length > 0) {
          calls.forEach((call, callIdx) => {
            const rawName =
              typeof call['name'] === 'string' && call['name'].trim() ? call['name'].trim() : 'tool';
            const rawArgs = isPlainObject(call['args']) ? call['args'] : {};
            const mapped = mapAgyTool(rawName, rawArgs, this.mcpServers);
            const toolUseId = `agy-parent:${stepIndex}:${callIdx}`;
            this.silentTurn!.openTools.push({
              toolUseId,
              mappedName: mapped.name,
              mappedInput: mapped.input,
              stepIndex,
              at,
            });
            events.push({
              type: 'tool.start',
              toolUseId,
              name: mapped.name,
              input: { ...mapped.input },
              at,
            });
          });
        }

        const content = typeof row['content'] === 'string' ? row['content'] : '';
        if (content) {
          const msgId = `sa${++this.seq}`;
          this.silentTurn.text += content;
          events.push({ type: 'text.delta', messageId: msgId, text: content });
        }

        if (calls.length === 0 && this.silentTurn.openTools.length === 0) {
          if (latestTokens !== undefined) {
            events.push(buildAgyContextUsage(latestTokens, model));
          }
          events.push(...this.flushOpenTurn(false, now));
          completedTurn = true;
        }
        continue;
      }

      if (rowType === 'GENERIC' && this.silentTurn) {
        if (
          status !== 'DONE' &&
          status !== 'ERROR' &&
          status !== 'CANCELED' &&
          status !== 'CANCELLED'
        ) {
          continue;
        }
        maxStep = stepIndex;
        const pending = this.silentTurn.openTools.shift();
        if (!pending) continue;
        const content =
          typeof row['content'] === 'string'
            ? row['content']
            : hasErrorField(row['error'])
              ? typeof row['error'] === 'string'
                ? row['error']
                : JSON.stringify(row['error'])
              : '';
        const isError =
          status !== 'DONE' || hasErrorField(row['error']) || nonZeroExitCode(content);
        events.push({
          type: 'tool.result',
          toolUseId: pending.toolUseId,
          isError,
          content: content.slice(0, 4000),
          at,
          durationMs: Math.max(0, at - pending.at),
        });
      }
    }

    return {
      events,
      lastStepIndex: maxStep,
      ...(latestTokens !== undefined ? { usedTokens: latestTokens } : {}),
      completedTurn,
    };
  }
}

function clipText(text: string, t: ReturnType<typeof hostStrings>): string {
  const lines = text.split('\n');
  let out = lines.slice(0, RESULT_LINES).join('\n');
  if (out.length > RESULT_CHARS) out = out.slice(0, RESULT_CHARS);
  const cut = out.length < text.length;
  return cut ? `${out}\n${t.agentClipped(text.length)}` : out;
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '~~~~' : '```';
  return `${ticks}\n${text}\n${ticks}`;
}

/**
 * Генерирует read-only Markdown транскрипта субагента Antigravity для `AntigravityAdapter.agentTranscript`.
 */
export async function agySubagentMarkdown(
  childUuid: string,
  dataDir: string = DEFAULT_AGY_DATA_DIR,
  meta: {
    title?: string;
    agentType?: string;
    lang?: Lang;
    mcpServers?: readonly string[];
  } = {},
): Promise<string | undefined> {
  const filePath = agyTranscriptPath(childUuid, dataDir);
  if (!filePath) return undefined;

  try {
    await fs.access(filePath);
  } catch {
    return undefined;
  }

  const records: Record<string, unknown>[] = [];
  try {
    await streamLines(
      filePath,
      (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const rec: unknown = JSON.parse(trimmed);
          if (isPlainObject(rec)) records.push(rec);
        } catch {
          // битая строка — пропускаем
        }
      },
      { acceptTail: () => true },
    );
  } catch {
    return undefined;
  }

  const lang = meta.lang ?? 'ru';
  const t = hostStrings(lang);
  const normalizedUuid = childUuid.toLowerCase();
  const title = meta.title?.trim() || normalizedUuid;
  const openLabel = lang === 'en' ? 'Open session' : 'Открыть сессию';

  const parts: string[] = [
    `# ${title}${meta.agentType ? ` · ${meta.agentType}` : ''}`,
    '',
    `[${openLabel}](conversation://${normalizedUuid})`,
    '',
    t.agentReadOnly,
    '',
  ];

  let prompted = false;
  for (const rec of records) {
    const rowType = typeof rec['type'] === 'string' ? rec['type'] : '';
    const status = typeof rec['status'] === 'string' ? rec['status'] : 'DONE';

    if (rowType === 'SYSTEM_MESSAGE' || rowType === 'USER_INPUT') {
      const raw = typeof rec['content'] === 'string' ? rec['content'] : '';
      const body = unwrapAgySystemMessage(raw);
      if (body) {
        parts.push(prompted ? t.agentMessage : t.agentPrompt, '', body, '');
        prompted = true;
      }
      continue;
    }

    if (rowType === 'PLANNER_RESPONSE') {
      if (status !== 'DONE') continue;
      const thinking = typeof rec['thinking'] === 'string' ? rec['thinking'].trim() : '';
      if (thinking) {
        const th = thinking.replace(/\s+/g, ' ').trim();
        parts.push(`> ${t.agentThinking} ${th.length > 400 ? `${th.slice(0, 400)}…` : th}`, '');
      }
      const text = typeof rec['content'] === 'string' ? rec['content'].trim() : '';
      if (text) {
        parts.push(text, '');
      }
      const rawCalls = Array.isArray(rec['tool_calls']) ? rec['tool_calls'] : [];
      for (const call of rawCalls) {
        if (!isPlainObject(call)) continue;
        const rawName = typeof call['name'] === 'string' && call['name'] ? call['name'] : 'tool';
        const rawArgs = isPlainObject(call['args']) ? call['args'] : {};
        const mapped = mapAgyTool(rawName, rawArgs, meta.mcpServers);
        const input = JSON.stringify(mapped.input);
        parts.push(
          `**${mapped.name}** \`${input.length > 300 ? `${input.slice(0, 300)}…` : input}\``,
          '',
        );
      }
      continue;
    }

    if (rowType === 'GENERIC') {
      if (
        status !== 'DONE' &&
        status !== 'ERROR' &&
        status !== 'CANCELED' &&
        status !== 'CANCELLED'
      ) {
        continue;
      }
      const text =
        typeof rec['content'] === 'string'
          ? rec['content']
          : hasErrorField(rec['error'])
            ? typeof rec['error'] === 'string'
              ? rec['error']
              : JSON.stringify(rec['error'])
            : '';
      const isErr = status !== 'DONE' || hasErrorField(rec['error']) || nonZeroExitCode(text);
      parts.push(isErr ? t.agentError : t.agentResult, '', fence(clipText(text, t)), '');
    }
  }

  return parts.join('\n');
}

export interface AgyTimelineOptions {
  live?: boolean;
  tasksAlive?: boolean;
  parentModel?: string;
  parentSessionId?: string;
  waitingThresholdMs?: number;
  onSubagentMeta?: (childUuid: string, meta: AgySubagentMeta) => void;
  warn?: (message: string) => void;
}

/**
 * Ограничивает число сегментных событий (`thinking.*` / `tool.*`) каждого `agentId` до `MAX_SUBAGENT_EVENTS`,
 * схлопывает промежуточные пары `agent.end` → повторный `agent.start` одного раунда истории
 * и гарантирует отсутствие оборванных `tool.result`/`thinking.stop` в начале среза.
 */
function normalizeHistorySubagentEvents(rawEvents: readonly AgentEvent[]): AgentEvent[] {
  // Схлопываем промежуточный agent.end, если следом в том же транскрипте идёт повторный agent.start того же agentId
  const reopenedAfter = new Set<number>();
  const lastEndByAgent = new Map<string, number>();
  const seenStartByAgent = new Set<string>();

  rawEvents.forEach((ev, idx) => {
    if (ev.type === 'agent.start') {
      const prevEnd = lastEndByAgent.get(ev.agentId);
      if (prevEnd !== undefined) {
        reopenedAfter.add(prevEnd);
        reopenedAfter.add(idx);
        lastEndByAgent.delete(ev.agentId);
      }
      seenStartByAgent.add(ev.agentId);
    } else if (ev.type === 'agent.end') {
      if (seenStartByAgent.has(ev.agentId)) {
        lastEndByAgent.set(ev.agentId, idx);
      }
    }
  });

  const filtered = rawEvents.filter((_, idx) => !reopenedAfter.has(idx));

  // Считаем события по каждому agentId и обрезаем сегментные события так, чтобы итог <= MAX_SUBAGENT_EVENTS
  const segIndicesByAgent = new Map<string, number[]>();
  const lifecycleCountByAgent = new Map<string, number>();
  filtered.forEach((ev, idx) => {
    if (!ev.agentId) return;
    if (
      ev.type === 'tool.start' ||
      ev.type === 'tool.result' ||
      ev.type === 'thinking.start' ||
      ev.type === 'thinking.stop'
    ) {
      let list = segIndicesByAgent.get(ev.agentId);
      if (!list) {
        list = [];
        segIndicesByAgent.set(ev.agentId, list);
      }
      list.push(idx);
    } else {
      lifecycleCountByAgent.set(ev.agentId, (lifecycleCountByAgent.get(ev.agentId) ?? 0) + 1);
    }
  });

  const dropIndices = new Set<number>();
  for (const [agentId, indices] of segIndicesByAgent) {
    const budget = Math.max(2, MAX_SUBAGENT_EVENTS - (lifecycleCountByAgent.get(agentId) ?? 0));
    if (indices.length <= budget) continue;
    const cutCount = indices.length - budget;
    for (let i = 0; i < cutCount; i++) {
      dropIndices.add(indices[i]!);
    }
    // Убираем ведущие осиротевшие tool.result / thinking.stop, чей start попал под срез
    const keptTools = new Set<string>();
    const keptThoughts = new Set<string>();
    for (let i = cutCount; i < indices.length; i++) {
      const evIdx = indices[i]!;
      const ev = filtered[evIdx]!;
      if (ev.type === 'tool.start') keptTools.add(ev.toolUseId);
      else if (ev.type === 'thinking.start') keptThoughts.add(ev.messageId);
      else if (ev.type === 'tool.result' && !keptTools.has(ev.toolUseId)) dropIndices.add(evIdx);
      else if (ev.type === 'thinking.stop' && !keptThoughts.has(ev.messageId)) dropIndices.add(evIdx);
    }
  }

  return dropIndices.size === 0 ? filtered : filtered.filter((_, idx) => !dropIndices.has(idx));
}

/**
 * Реконструкция графа и таймлайнов субагентов для `AntigravityAdapter.loadHistory`:
 * - связывает пары `tool.start` (`Agent`) + `tool.result` (`invoke_subagent`) с `agent.start` (`agentId = toolUseId`, `taskId = childUuid`);
 * - подгружает дочерние транскрипты последних `MAX_SUBAGENT_TIMELINES = 30` субагентов (до `MAX_SUBAGENT_EVENTS = 400` событий на агента);
 * - учитывает `send_message` и `manage_subagents(list | kill | kill_all)`;
 * - закрывает незавершённых субагентов `agent.end` (`status: 'stopped'`), если `!(options.live || options.tasksAlive)`.
 */
export async function withAgySubagentTimelines(
  events: readonly AgentEvent[],
  dataDir: string = DEFAULT_AGY_DATA_DIR,
  mcpServers?: readonly string[],
  options: AgyTimelineOptions = {},
): Promise<AgentEvent[]> {
  const out = [...events];
  const keepAlive = Boolean(options.live || options.tasksAlive);
  const startsById = new Map<string, Extract<AgentEvent, { type: 'tool.start' }>>();

  interface LaunchEntry {
    resultIndex: number;
    toolStart: Extract<AgentEvent, { type: 'tool.start' }>;
    toolResult: Extract<AgentEvent, { type: 'tool.result' }>;
    childUuid: string;
    killed: boolean;
    waitingReported: boolean;
    sendCount: number;
    lastSentPrompt?: string;
  }

  const launches: LaunchEntry[] = [];
  const launchesByUuid = new Map<string, LaunchEntry>();

  for (let i = 0; i < out.length; i++) {
    const ev = out[i]!;
    if (ev.agentId) continue;

    if (ev.type === 'tool.start') {
      startsById.set(ev.toolUseId, ev);
      continue;
    }

    if (ev.type === 'tool.result') {
      const start = startsById.get(ev.toolUseId);
      if (!start) continue;

      if (start.name === 'Agent' && !ev.isError) {
        const childUuid = parseCreatedSubagent(ev.content);
        if (childUuid) {
          const entry: LaunchEntry = {
            resultIndex: i,
            toolStart: start,
            toolResult: ev,
            childUuid,
            killed: false,
            waitingReported: false,
            sendCount: 0,
          };
          launches.push(entry);
          launchesByUuid.set(childUuid, entry);
        }
      } else if (start.name === 'send_message' && !ev.isError) {
        const recipient = pickStr(start.input, 'Recipient', 'recipient')?.toLowerCase();
        const msg = pickStr(start.input, 'Message', 'message');
        const target = recipient ? launchesByUuid.get(recipient) : undefined;
        if (target && !target.killed) {
          target.sendCount += 1;
          if (msg) target.lastSentPrompt = msg;
        }
      } else if (start.name === 'manage_subagents') {
        const managed = parseManagedSubagents(start.input, ev.content, ev.isError);
        if (managed.action === 'list') {
          for (const id of managed.waitingIds) {
            const target = launchesByUuid.get(id);
            if (target) target.waitingReported = true;
          }
        } else if (managed.action === 'kill_all') {
          for (const entry of launches) {
            entry.killed = true;
          }
        } else if (managed.action === 'kill') {
          for (const id of managed.killedIds) {
            const target = launchesByUuid.get(id);
            if (target) target.killed = true;
          }
        }
      }
    }
  }

  if (launches.length === 0) return out;

  const tailCutoff = Math.max(0, launches.length - MAX_SUBAGENT_TIMELINES);

  // Идём с конца, чтобы splice не сдвигал индексы ещё не обработанных запусков
  for (let idx = launches.length - 1; idx >= 0; idx--) {
    const entry = launches[idx]!;
    const { toolStart, childUuid } = entry;
    const subType = pickStr(toolStart.input, 'subagent_type', 'TypeName');
    const desc =
      pickStr(toolStart.input, 'description', 'Role', 'subagent_type', 'TypeName') ?? 'subagent';
    const prompt = pickStr(toolStart.input, 'prompt', 'Prompt');
    const rawModel = pickStr(toolStart.input, 'model', 'Model');
    const model = rawModel && rawModel !== 'inherit' ? rawModel : options.parentModel;
    const startedAt = toolStart.at;

    options.onSubagentMeta?.(childUuid, {
      description: desc,
      ...(subType ? { agentType: subType } : {}),
    });

    if (idx < tailCutoff) {
      const minimal: AgentEvent[] = [
        {
          type: 'agent.start',
          agentId: toolStart.toolUseId,
          taskId: childUuid,
          description: desc,
          taskType: 'subagent',
          ...(subType ? { subagentType: subType } : {}),
          ...(prompt ? { prompt } : {}),
          ...(model ? { model } : {}),
          background: true,
          ...(startedAt !== undefined ? { at: startedAt } : {}),
        },
      ];
      if (entry.killed || !keepAlive) {
        minimal.push({
          type: 'agent.end',
          agentId: toolStart.toolUseId,
          taskId: childUuid,
          status: entry.killed ? 'stopped' : 'completed',
          ...(startedAt !== undefined ? { at: startedAt } : {}),
        });
      }
      out.splice(entry.resultIndex + 1, 0, ...minimal);
      continue;
    }

    try {
      const reader = new AgySubagentReader({
        agentId: toolStart.toolUseId,
        childUuid,
        dataDir,
        ...(mcpServers ? { mcpServers } : {}),
        waitingThresholdMs: options.waitingThresholdMs ?? DEFAULT_WAITING_THRESHOLD_MS,
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        description: desc,
        ...(subType ? { subagentType: subType } : {}),
        ...(prompt ? { prompt } : {}),
        ...(model ? { model } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(options.onSubagentMeta ? { onSubagentMeta: options.onSubagentMeta } : {}),
      });

      const collected: AgentEvent[] = [reader.buildStartEvent(startedAt)];
      collected.push(...(await reader.poll()));

      if (!entry.killed && entry.sendCount >= reader.roundsCount() && !reader.isActive()) {
        collected.push(...reader.reopen(startedAt, entry.lastSentPrompt));
      }

      if (entry.killed) {
        if (reader.isActive()) {
          collected.push(...reader.stopAll());
        } else {
          // Явный kill в истории: заменяем финальный статус этого узла на stopped
          for (let k = collected.length - 1; k >= 0; k--) {
            const ev = collected[k]!;
            if (ev.type === 'agent.end' && ev.agentId === toolStart.toolUseId) {
              const { summary: _s, ...rest } = ev;
              void _s;
              collected[k] = { ...rest, status: 'stopped' };
              break;
            }
          }
        }
      } else if (reader.isActive()) {
        if (entry.waitingReported) {
          collected.push(...reader.markWaitingByUuid(childUuid));
        }
        if (!keepAlive) {
          collected.push(...reader.stopAll());
        }
      }

      const normalized = normalizeHistorySubagentEvents(collected);
      out.splice(entry.resultIndex + 1, 0, ...normalized);
    } catch (error) {
      options.warn?.(`agy subagent timeline ${childUuid}: ${String(error)}`);
    }
  }
  return out;
}
