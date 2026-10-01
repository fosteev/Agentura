/**
 * История сессии → события ленты (этап 6). Вход — сообщения `getSessionMessages()` (user/assistant
 * целиком, без потока) и структурные результаты инструментов из транскрипта (`toolUseResult`:
 * `SessionMessage` их не отдаёт, а без них нет ни `diff` у правок, ни счётчиков `+N −M`).
 * Выход — те же `AgentEvent`, что у живой сессии: лента и приборы webview проходят через тот же
 * редьюсер, хост — через тот же разбор правок (`ChatController`), поэтому `diff` в восстановленной
 * истории работает так же, как в живой. Чистая функция, без ввода-вывода.
 */
import type { AgentEvent, PermissionMode, SessionHistory, TokenUsage } from '../types';
import { cost } from '../../data/pricing';
import { arr, isObj, obj, str, timestamp, type Json } from './json';
import { usageFrom } from './mapper';

/** Сообщение `getSessionMessages()` — только то, что нам нужно. */
export interface HistoryMessage {
  type: string;
  uuid?: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  timestamp?: string;
}

export interface BuildOptions {
  /** `toolUseResult` записей транскрипта по `tool_use_id`. */
  toolResults?: ReadonlyMap<string, unknown>;
  /** Последний ход не закрывать `turn.result` — сессия сейчас идёт. */
  live?: boolean;
  /** Сколько последних ходов показать. */
  maxTurns?: number;
}

export const DEFAULT_MAX_TURNS = 200;

/** Сводка компакции, которую движок кладёт в транскрипт пользовательским сообщением. */
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/;
/** Служебные «пользовательские» записи: эхо команд и пометка прерывания. */
const INTERRUPTED = '[Request interrupted';

interface Turn {
  startAt: number;
  lastAt: number;
  interrupted: boolean;
  /** API-ответы хода: id → итоговый usage и модель. */
  calls: Map<string, { usage: TokenUsage; model: string }>;
  assistantMessages: number;
}

function addTo(into: TokenUsage, u: TokenUsage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  if (u.cacheWrite5m !== undefined) into.cacheWrite5m = (into.cacheWrite5m ?? 0) + u.cacheWrite5m;
  if (u.cacheWrite1h !== undefined) into.cacheWrite1h = (into.cacheWrite1h ?? 0) + u.cacheWrite1h;
  if (u.thinking !== undefined) into.thinking = (into.thinking ?? 0) + u.thinking;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  const parts = arr(content)
    .filter(isObj)
    .filter((b) => b['type'] === 'text')
    .map((b) => str(b['text']) ?? '');
  return parts.length ? parts.join('\n') : undefined;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .filter(isObj)
    .map((b) => (b['type'] === 'text' ? (str(b['text']) ?? '') : `[${str(b['type']) ?? 'block'}]`))
    .join('\n');
}

/** Режим из записи транскрипта; `auto`/`dontAsk` расширение не ведёт — как `default`. */
export function modeFromTranscript(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'plan' || value === 'acceptEdits' || value === 'bypassPermissions') return value;
  return 'default';
}

export function buildHistory(
  messages: readonly HistoryMessage[],
  options: BuildOptions = {},
): SessionHistory {
  const toolResults = options.toolResults ?? new Map<string, unknown>();
  const main = messages.filter(
    (m) => (m.type === 'user' || m.type === 'assistant') && !m.parent_tool_use_id,
  );

  // Итоговый usage каждого API-ответа: запись пишется по блокам, последняя — с настоящим выводом.
  const finalUsage = new Map<string, TokenUsage>();
  for (const m of main) {
    if (m.type !== 'assistant') continue;
    const msg = obj(m.message);
    const id = str(msg?.['id']);
    const usage = obj(msg?.['usage']);
    if (id && usage) finalUsage.set(id, usageFrom(usage));
  }

  // События по ходам: всё до первого промпта (сводка компакции, служебное) — «нулевой» ход.
  const perTurn: AgentEvent[][] = [];
  let events: AgentEvent[] = [];
  let turn: Turn | undefined;
  let runningCost = 0;
  let turns = 0;
  let lastModel: string | undefined;
  const toolStartedAt = new Map<string, number>();
  const usageEmitted = new Set<string>();

  const closeTurn = (open: boolean): void => {
    if (!turn) return;
    const t = turn;
    turn = undefined;
    if (open) return;
    const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let usd = 0;
    let unpriced = false;
    let model: string | undefined;
    for (const call of t.calls.values()) {
      addTo(usage, call.usage);
      const c = cost(call.usage, call.model);
      if (c === undefined) unpriced = true;
      else usd += c;
      model = call.model;
    }
    if (!unpriced) runningCost += usd;
    events.push({
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: t.interrupted,
      durationMs: Math.max(0, t.lastAt - t.startAt),
      apiDurationMs: 0,
      numTurns: t.calls.size, // API-вызовы хода (записей ассистента больше: CLI пишет по записи на блок)
      usage,
      ...(t.calls.size > 0 && !unpriced ? { costUsd: usd } : {}),
      totalCostUsd: runningCost,
      ...(model ? { model } : {}),
      permissionDenials: [],
    });
  };

  const startTurn = (prompt: string, at: number): void => {
    closeTurn(false);
    if (events.length) perTurn.push(events);
    events = [];
    turns++;
    turn = {
      startAt: at,
      lastAt: at,
      interrupted: false,
      calls: new Map(),
      assistantMessages: 0,
    };
    events.push({ type: 'turn.start', prompt, at });
  };

  for (const m of main) {
    const at = timestamp(m.timestamp) ?? turn?.lastAt ?? 0;
    const msg = obj(m.message);
    if (!msg) continue;
    // время хода — до последнего ответа или результата инструмента; следующий промпт ход не продлевает
    const touch = (): void => {
      if (turn) turn.lastAt = Math.max(turn.lastAt, at);
    };

    if (m.type === 'user') {
      const content = msg['content'];
      const results = arr(content)
        .filter(isObj)
        .filter((b) => b['type'] === 'tool_result');
      if (results.length > 0) {
        touch();
        for (const block of results) {
          const toolUseId = str(block['tool_use_id']);
          if (!toolUseId) continue;
          const started = toolStartedAt.get(toolUseId);
          const event: Extract<AgentEvent, { type: 'tool.result' }> = {
            type: 'tool.result',
            toolUseId,
            isError: block['is_error'] === true,
            content: resultText(block['content']),
          };
          const structured = toolResults.get(toolUseId);
          if (results.length === 1 && structured !== undefined) event.result = structured;
          if (at) {
            event.at = at;
            if (started !== undefined) event.durationMs = Math.max(0, at - started);
          }
          events.push(event);
        }
        continue;
      }
      const text = textOf(content);
      if (text === undefined || text.trim() === '') continue;
      const t = text.trimStart();
      if (COMPACT_SUMMARY.test(t)) {
        events.push({ type: 'compaction.end', ok: true });
        continue;
      }
      if (t.startsWith(INTERRUPTED)) {
        if (turn) turn.interrupted = true;
        continue;
      }
      if (t.startsWith('<command-') || t.startsWith('<local-command-')) continue;
      startTurn(text, at);
      continue;
    }

    // assistant
    touch();
    const id = str(msg['id']) ?? '';
    const model = str(msg['model']) ?? '';
    const synthetic = model === '<synthetic>';
    if (!synthetic && model) lastModel = model;
    if (turn && !synthetic) {
      turn.assistantMessages++;
      const usage = finalUsage.get(id);
      if (id && usage && !turn.calls.has(id)) turn.calls.set(id, { usage, model });
    }
    if (id && !synthetic && !usageEmitted.has(id)) {
      const usage = finalUsage.get(id);
      if (usage) {
        usageEmitted.add(id);
        events.push({ type: 'usage.message', messageId: id, model, usage, final: true, at });
        events.push({
          type: 'context.usage',
          usedTokens: usage.input + usage.cacheRead + usage.cacheWrite,
          source: 'usage',
        });
      }
    }
    for (const block of arr(msg['content']).filter(isObj)) {
      switch (block['type']) {
        case 'text': {
          const text = str(block['text']);
          if (!text) break;
          if (synthetic) events.push({ type: 'error', message: text, fatal: false });
          else events.push({ type: 'text.delta', messageId: id, text });
          break;
        }
        case 'thinking': {
          const text = str(block['thinking']);
          // показ thinking — `summarized`: в транскрипте часто пустая строка, строку рисовать не из чего
          if (!text) break;
          events.push({ type: 'thinking.start', messageId: id, at });
          events.push({ type: 'thinking.delta', messageId: id, text });
          events.push({ type: 'thinking.stop', messageId: id, at });
          break;
        }
        case 'tool_use': {
          const toolUseId = str(block['id']);
          const name = str(block['name']);
          if (!toolUseId || !name) break;
          toolStartedAt.set(toolUseId, at);
          events.push({
            type: 'tool.start',
            toolUseId,
            name,
            input: obj(block['input']) ?? ({} as Json),
            ...(at ? { at } : {}),
          });
          break;
        }
        default:
          break;
      }
    }
  }
  closeTurn(options.live === true);
  if (events.length) perTurn.push(events);

  // Последние `maxTurns` ходов; «нулевой» блок (до первого промпта) — только если ходов не отрезали.
  const max = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const hasPreamble = perTurn.length > turns;
  const skipped = Math.max(0, turns - max);
  const kept = perTurn.slice((hasPreamble ? 1 : 0) + skipped);
  const head = hasPreamble && skipped === 0 ? (perTurn[0] ?? []) : [];
  return {
    events: [...head, ...kept.flat()],
    turns,
    skippedTurns: skipped,
    ...(lastModel ? { model: lastModel } : {}),
  };
}
