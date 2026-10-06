import type { AgentEvent } from '../types';
import type { FileUpdateChange, ThreadItem } from './protocol';
import { changePath, displayCommand, parseHunks, sidesOfHunks } from './patch';

/** Вывод команды в `tool.result.content`: длиннее — обрезаем (лента и журнал не для мегабайтов). */
const MAX_OUTPUT = 100_000;
/** Не чаще раза в секунду на команду: `tool.progress` только двигает таймер в строке. */
const PROGRESS_EVERY_MS = 1000;
const MAX_TRACKED = 256;

type Item<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;

interface Tracked {
  /** Имя инструмента на ленте. */
  name: string;
  startedAt: number;
  output: string;
  truncated: boolean;
  lastProgress: number;
  /** Для `fileChange`: id вызовов (по одному на файл) и последние известные правки. */
  changes?: FileUpdateChange[];
  started: Set<number>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Текст результата MCP-вызова: текстовые блоки `content`, иначе JSON как есть. */
function mcpText(result: unknown): string {
  if (!isObject(result)) return result == null ? '' : jsonText(result);
  const content = result['content'];
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (isObject(c) && typeof c['text'] === 'string' ? (c['text'] as string) : undefined))
      .filter((t): t is string => t !== undefined);
    if (texts.length) return texts.join('\n');
  }
  return jsonText(result);
}

/**
 * `item/*` инструментов Codex → `tool.*`. Имена — как у Claude, чтобы лента, «изменения» и таймлайн читали их
 * без правок: команда — `Bash` (`input.command`), создание файла — `Write`, правка и удаление — `Edit`
 * (`input.file_path`, результат со `structuredPatch`), MCP — `mcp__<server>__<tool>`, поиск — `WebSearch`.
 * Элемент без `item/started` (resume, потерянное уведомление) получает `tool.start` перед результатом.
 * `item/completed` может прийти и после `turn/completed` — лента находит строку по `toolUseId`.
 */
export class CodexToolMapper {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly now: () => number) {}

  /** Правки, которые затрагивает `fileChange` (для превью в карточке подтверждения). */
  changesOf(itemId: string): FileUpdateChange[] | undefined {
    return this.tracked.get(itemId)?.changes;
  }

  started(item: ThreadItem, atMs: number | undefined): AgentEvent[] {
    switch (item.type) {
      case 'commandExecution':
        return this.startCommand(item, atMs);
      case 'fileChange':
        return this.startFiles(item.id, item.changes, atMs);
      case 'mcpToolCall':
        return this.startSimple(item.id, `mcp__${item.server}__${item.tool}`, argsOf(item.arguments), atMs);
      case 'dynamicToolCall':
        return this.startSimple(item.id, item.tool, argsOf(item.arguments), atMs);
      case 'webSearch':
        return this.startSimple(item.id, 'WebSearch', { query: searchQuery(item) }, atMs);
      default:
        return [];
    }
  }

  completed(item: ThreadItem, atMs: number | undefined): AgentEvent[] {
    switch (item.type) {
      case 'commandExecution':
        return this.finishCommand(item, atMs);
      case 'fileChange':
        return this.finishFiles(item, atMs);
      case 'mcpToolCall': {
        const failed = item.status === 'failed' || item.error != null;
        const error = isObject(item.error) && typeof item.error['message'] === 'string' ? item.error['message'] : undefined;
        return this.finishSimple(
          item.id,
          `mcp__${item.server}__${item.tool}`,
          argsOf(item.arguments),
          failed,
          failed ? (error ?? jsonText(item.error ?? item.status)) : mcpText(item.result),
          item.result,
          item.durationMs,
          atMs,
        );
      }
      case 'dynamicToolCall': {
        const failed = item.success === false || item.status === 'failed';
        return this.finishSimple(item.id, item.tool, argsOf(item.arguments), failed, failed ? item.status : '', undefined, undefined, atMs);
      }
      case 'webSearch':
        return this.finishSimple(item.id, 'WebSearch', { query: searchQuery(item) }, false, '', undefined, undefined, atMs);
      default:
        return [];
    }
  }

  /** `item/commandExecution/outputDelta`: копим вывод и изредка двигаем таймер. */
  output(itemId: string, delta: string): AgentEvent[] {
    const t = this.tracked.get(itemId);
    if (!t || t.name !== 'Bash') return [];
    if (delta && !t.truncated) {
      t.output += delta;
      if (t.output.length > MAX_OUTPUT) {
        t.output = t.output.slice(0, MAX_OUTPUT);
        t.truncated = true;
      }
    }
    const now = this.now();
    if (now - t.lastProgress < PROGRESS_EVERY_MS) return [];
    t.lastProgress = now;
    return [{ type: 'tool.progress', toolUseId: itemId, name: 'Bash', elapsedMs: Math.max(0, now - t.startedAt) }];
  }

  /** `item/fileChange/patchUpdated`: набор файлов уточнился — стартуем строки, которых ещё не было. */
  patchUpdated(itemId: string, changes: FileUpdateChange[]): AgentEvent[] {
    return this.startFiles(itemId, changes, undefined);
  }

  // ---- команды -------------------------------------------------------------------------------

  private track(id: string, name: string, atMs: number | undefined): Tracked {
    let t = this.tracked.get(id);
    if (!t) {
      t = { name, startedAt: atMs ?? this.now(), output: '', truncated: false, lastProgress: 0, started: new Set() };
      this.tracked.set(id, t);
      if (this.tracked.size > MAX_TRACKED) this.tracked.delete(this.tracked.keys().next().value!);
    }
    return t;
  }

  private startCommand(item: Item<'commandExecution'>, atMs: number | undefined): AgentEvent[] {
    if (this.tracked.has(item.id)) return [];
    const t = this.track(item.id, 'Bash', atMs);
    return [
      { type: 'tool.start', toolUseId: item.id, name: 'Bash', input: { command: displayCommand(item.command) }, at: t.startedAt },
    ];
  }

  private finishCommand(item: Item<'commandExecution'>, atMs: number | undefined): AgentEvent[] {
    const events = this.startCommand(item, atMs);
    const t = this.tracked.get(item.id);
    this.tracked.delete(item.id);
    const full = item.aggregatedOutput ?? t?.output ?? '';
    const cut = full.length > MAX_OUTPUT;
    const output = cut ? full.slice(0, MAX_OUTPUT) : full;
    const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
    // вывода нет (живой сервер шлёт `aggregatedOutput: null`): провал не должен выглядеть пустым успехом
    const content =
      output ||
      (item.status === 'declined'
        ? 'declined'
        : item.exitCode != null && item.exitCode !== 0
          ? `exit code ${item.exitCode}`
          : item.status === 'failed'
            ? 'failed'
            : '');
    const at = atMs ?? this.now();
    events.push({
      type: 'tool.result',
      toolUseId: item.id,
      isError: failed,
      content: cut || (t?.truncated && !item.aggregatedOutput) ? `${content}\n[output truncated]` : content,
      result: {
        stdout: output,
        stderr: '',
        ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
        ...(item.status === 'declined' ? { declined: true } : {}),
      },
      at,
      ...(item.durationMs != null ? { durationMs: item.durationMs } : t ? { durationMs: Math.max(0, at - t.startedAt) } : {}),
    });
    return events;
  }

  // ---- правки файлов ---------------------------------------------------------------------------

  private fileCallId(itemId: string, index: number): string {
    return index === 0 ? itemId : `${itemId}#${index}`;
  }

  private startFiles(itemId: string, changes: FileUpdateChange[], atMs: number | undefined): AgentEvent[] {
    const t = this.track(itemId, 'fileChange', atMs);
    t.changes = changes;
    const events: AgentEvent[] = [];
    changes.forEach((change, i) => {
      if (t.started.has(i)) return;
      t.started.add(i);
      events.push({
        type: 'tool.start',
        toolUseId: this.fileCallId(itemId, i),
        name: fileTool(change),
        input: fileInput(change),
        at: t.startedAt,
      });
    });
    return events;
  }

  private finishFiles(item: Item<'fileChange'>, atMs: number | undefined): AgentEvent[] {
    const events = this.startFiles(item.id, item.changes, atMs);
    const t = this.tracked.get(item.id);
    this.tracked.delete(item.id);
    const at = atMs ?? this.now();
    const failed = item.status === 'failed' || item.status === 'declined';
    // правки, о которых сообщили при старте, а в итоге их нет (отказ): закрываем и их, чтобы строка не висела
    const count = Math.max(item.changes.length, t?.started.size ?? 0);
    for (let i = 0; i < count; i++) {
      const change = item.changes[i];
      events.push({
        type: 'tool.result',
        toolUseId: this.fileCallId(item.id, i),
        isError: failed,
        content: failed ? item.status : change ? fileSummary(change) : item.status,
        ...(!failed && change ? { result: fileResult(change) } : {}),
        at,
        ...(t ? { durationMs: Math.max(0, at - t.startedAt) } : {}),
      });
    }
    return events;
  }

  // ---- MCP, поиск, прочее ------------------------------------------------------------------------

  private startSimple(id: string, name: string, input: Record<string, unknown>, atMs: number | undefined): AgentEvent[] {
    if (this.tracked.has(id)) return [];
    const t = this.track(id, name, atMs);
    return [{ type: 'tool.start', toolUseId: id, name, input, at: t.startedAt }];
  }

  private finishSimple(
    id: string,
    name: string,
    input: Record<string, unknown>,
    failed: boolean,
    content: string,
    result: unknown,
    durationMs: number | null | undefined,
    atMs: number | undefined,
  ): AgentEvent[] {
    const events = this.startSimple(id, name, input, atMs);
    const t = this.tracked.get(id);
    this.tracked.delete(id);
    const at = atMs ?? this.now();
    events.push({
      type: 'tool.result',
      toolUseId: id,
      isError: failed,
      content,
      ...(result !== undefined && result !== null ? { result } : {}),
      at,
      ...(durationMs != null ? { durationMs } : t ? { durationMs: Math.max(0, at - t.startedAt) } : {}),
    });
    return events;
  }
}

function argsOf(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  return value === null || value === undefined ? {} : { arguments: value };
}

function searchQuery(item: Item<'webSearch'> | { query?: string; action?: unknown }): string {
  const own = (item as { query?: string }).query;
  if (own) return own;
  const action = (item as { action?: { query?: string | null; queries?: string[] | null; url?: string | null } | null }).action;
  return action?.query ?? action?.queries?.join(', ') ?? action?.url ?? '';
}

/** Создание — `Write`; правка, перенос и удаление — `Edit`: так их читают лента и вкладка «изменения». */
function fileTool(change: FileUpdateChange): 'Write' | 'Edit' {
  return change.kind.type === 'add' ? 'Write' : 'Edit';
}

function fileInput(change: FileUpdateChange): Record<string, unknown> {
  const file_path = changePath(change);
  if (change.kind.type === 'add') return { file_path, content: change.diff };
  if (change.kind.type === 'delete') return { file_path, old_string: change.diff, new_string: '' };
  const { oldText, newText } = sidesOfHunks(parseHunks(change.diff));
  return { file_path, old_string: oldText, new_string: newText };
}

function fileResult(change: FileUpdateChange): Record<string, unknown> {
  const filePath = changePath(change);
  if (change.kind.type === 'add') return { type: 'create', filePath, content: change.diff };
  if (change.kind.type === 'delete') {
    return { type: 'delete', filePath, oldString: change.diff, newString: '', structuredPatch: deletedPatch(change.diff) };
  }
  const hunks = parseHunks(change.diff);
  const { oldText, newText } = sidesOfHunks(hunks);
  return { type: 'update', filePath, oldString: oldText, newString: newText, structuredPatch: hunks };
}

/** Удаление файла как один ханк из `-`-строк: счётчики «изменений» видят удалённые строки. */
function deletedPatch(content: string): unknown[] {
  const lines = content.replace(/\n$/, '').split('\n');
  if (!content) return [];
  return [{ oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: lines.map((l) => `-${l}`) }];
}

function fileSummary(change: FileUpdateChange): string {
  const path = changePath(change);
  return change.kind.type === 'add' ? `Created ${path}` : change.kind.type === 'delete' ? `Deleted ${path}` : `Updated ${path}`;
}
