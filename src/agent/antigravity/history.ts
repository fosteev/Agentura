/**
 * Лента истории беседы agy: шаги `transcript_full.jsonl` → те же `AgentEvent`, что у живой сессии (`mapper.ts`).
 * Чистая функция: чтение файла — `storage.ts`. Соответствие шагов: USER_INPUT → `turn.start`; PLANNER_RESPONSE →
 * `usage.message`, `text.delta` и `tool.start` на каждый вызов; следующие за ним GENERIC (по порядку) → `tool.result`
 * вызовов (тот же `agy-<индекс GENERIC>` id, что у живого шага tool). Thinking-текст (`thinking` в транскрипте)
 * в ленту не идёт: живой стрим его не отдаёт, лента должна совпадать с живой. SYSTEM_MESSAGE пропускаем.
 */
import type { AgentEvent, AgentEventOf, SessionHistory, TokenUsage } from '../types';
import { editResultFrom } from './edits';
import { tokenUsageOf } from './mapper';
import type { TranscriptStep } from './storage';
import { mapAgyTool } from './tools';

export const DEFAULT_MAX_TURNS = 200;

/** Текст запроса пользователя без служебных обёрток agy (`<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`). */
export function userRequestText(content: string): string {
  const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  if (request) return (request[1] ?? '').trim();
  return content
    .replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|USER_REQUEST)>[\s\S]*?<\/\1>/g, '')
    .trim();
}

/** Результат инструмента без шапки `Created At:`/`Completed At:`. */
function resultText(content: string | undefined): string {
  return (content ?? '').replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '').trim();
}

function timeOf(step: TranscriptStep | undefined, fallback: number): number {
  const ms = step?.created_at ? Date.parse(step.created_at) : NaN;
  return Number.isNaN(ms) ? fallback : ms;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: TokenUsage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
  const thinking = (a.thinking ?? 0) + (b.thinking ?? 0);
  if (thinking > 0) sum.thinking = thinking;
  return sum;
}

export interface AgyHistoryOptions {
  /** Беседа идёт сейчас (пересев webview): последний ход остаётся открытым. */
  live?: boolean;
  maxTurns?: number;
  /** Служебные сообщения агенту (повтор после отказа): ход показывается без пузыря пользователя, как в живой ленте. */
  silentPrompts?: readonly string[];
  /** Ранних ходов, не попавших в `steps` (транскрипт прочитан с хвоста): добавляются к `skippedTurns`. */
  skippedBefore?: number;
}

/**
 * Шаги, начиная с USER_INPUT, до следующего. Шаги до первого USER_INPUT (хвост огромного транскрипта) — ход без
 * промпта, но только если в нём есть ответ агента: одни служебные шаги ход-призрак не дают.
 */
function splitTurns(steps: readonly TranscriptStep[]): TranscriptStep[][] {
  const turns: TranscriptStep[][] = [];
  for (const step of [...steps].sort((a, b) => a.step_index - b.step_index)) {
    if (step.type === 'USER_INPUT' || turns.length === 0) turns.push([]);
    turns[turns.length - 1]?.push(step);
  }
  return turns.filter((t) => t[0]?.type === 'USER_INPUT' || t.some((s) => s.type === 'PLANNER_RESPONSE'));
}

function turnEvents(steps: readonly TranscriptStep[], open: boolean, silent: readonly string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const first = steps[0];
  const startedAt = timeOf(first, 0);
  const start: AgentEventOf<'turn.start'> = { type: 'turn.start', at: startedAt };
  if (first?.type === 'USER_INPUT') {
    const prompt = userRequestText(first.content ?? '');
    if (prompt && !silent.includes(prompt)) start.prompt = prompt;
  }
  events.push(start);

  let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let planners = 0;
  let text: string | undefined;
  let lastAt = startedAt;
  const openTools = new Set<string>();
  const denied: { toolName: string; toolUseId: string }[] = [];
  const errors: string[] = [];

  const body = steps.filter((s) => s.type !== 'USER_INPUT' && s.type !== 'SYSTEM_MESSAGE');
  for (let i = 0; i < body.length; i++) {
    const step = body[i] as TranscriptStep;
    if (step.type !== 'PLANNER_RESPONSE') continue; // GENERIC разбираем вместе со своим вызовом
    planners++;
    lastAt = timeOf(step, lastAt);
    if (step.status === 'ERROR') errors.push(step.error?.trim() || 'agent response failed');
    const messageId = `agy-${step.step_index}`;
    const content = step.content?.trim();
    if (content) {
      text = content;
      events.push({ type: 'text.delta', messageId, text: content });
    }
    if (step.input_tokens !== undefined || step.output_tokens !== undefined) {
      const stepUsage = tokenUsageOf({
        input_tokens: step.input_tokens ?? 0,
        output_tokens: step.output_tokens ?? 0,
        cache_read_tokens: step.cache_read_tokens ?? 0,
      });
      usage = addUsage(usage, stepUsage);
      events.push({ type: 'usage.message', messageId, model: '', usage: stepUsage, final: true, at: lastAt });
    }
    // результаты вызовов — GENERIC подряд до следующего шага planner
    const results: TranscriptStep[] = [];
    for (let j = i + 1; j < body.length && body[j]?.type !== 'PLANNER_RESPONSE'; j++)
      if (body[j]?.type === 'GENERIC') results.push(body[j] as TranscriptStep);
    const calls = step.tool_calls ?? [];
    const cards = calls.map((call, n) => {
      const result = results[n];
      const mapped = mapAgyTool(call.name, call.args);
      // нет результата: в идущем ходе — id будущего шага tool (agy нумерует их подряд за planner), чтобы живое
      // продолжение после пересева склеилось с карточкой; в закрытом — свой, ни с чем не совпадающий
      const id = result ? `agy-${result.step_index}` : open ? `agy-${step.step_index + 1 + n}` : `agy-${step.step_index}-${n}`;
      events.push({ type: 'tool.start', toolUseId: id, name: mapped.name, input: mapped.input, at: lastAt });
      openTools.add(id);
      return { call, mapped, result, id };
    });
    for (const { call, mapped, result, id } of cards) {
      if (!result) continue; // результата нет (ход оборван) — закроется в конце хода как «interrupted»
      const at = timeOf(result, lastAt);
      lastAt = Math.max(lastAt, at);
      const isError = result.status === 'ERROR';
      const message = result.error ?? resultText(result.content);
      if (isError && /permission check failed/i.test(message)) denied.push({ toolName: mapped.name, toolUseId: id });
      const event: AgentEventOf<'tool.result'> = {
        type: 'tool.result',
        toolUseId: id,
        isError,
        content: isError ? message || 'tool failed' : resultText(result.content),
        at,
      };
      if (mapped.edit && !isError) {
        const extra = editResultFrom(
          { args: call.args, resultText: result.content ?? '' },
          mapped.name,
          mapped.edit.targetFile,
        );
        if (extra) event.result = extra;
      }
      events.push(event);
      openTools.delete(id);
    }
  }

  const last = body[body.length - 1];
  const finished = last?.type === 'PLANNER_RESPONSE' && !last.tool_calls?.length;
  if (open && !finished) return events; // идущий ход: незакрытые инструменты — ещё в работе
  const failed = finished && last.status === 'ERROR';
  const complete = finished && !failed;
  const interrupted = !finished;
  for (const id of openTools) {
    // как у живой ленты при Stop: ход оборван — «interrupted»
    events.push({ type: 'tool.result', toolUseId: id, isError: true, content: 'interrupted', at: lastAt });
  }
  const result: AgentEventOf<'turn.result'> = {
    type: 'turn.result',
    ok: complete,
    subtype: complete ? 'success' : failed ? 'error' : 'interrupted',
    interrupted,
    durationMs: Math.max(0, lastAt - startedAt),
    apiDurationMs: 0,
    numTurns: planners,
    usage,
    totalCostUsd: 0,
    permissionDenials: denied,
  };
  if (text) result.text = text;
  if (errors.length > 0) result.errors = errors;
  events.push(result);
  return events;
}

/**
 * История беседы для ленты. Режим и модель транскрипт не хранит (в нём лишь «Gemini 3.8 Flash (Low)» человеческим
 * названием в служебной вставке) — `SessionHistory.mode`/`model` не задаём: продолжение берёт их из опций.
 */
export function buildAgyHistory(steps: readonly TranscriptStep[], options: AgyHistoryOptions = {}): SessionHistory {
  const turns = splitTurns(steps);
  const max = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const skipped = Math.max(0, turns.length - max);
  const before = Math.max(0, options.skippedBefore ?? 0);
  const events: AgentEvent[] = [];
  turns.slice(skipped).forEach((turn, i, shown) => {
    events.push(...turnEvents(turn, i === shown.length - 1 && options.live === true, options.silentPrompts ?? []));
  });
  return { events, turns: turns.length + before, skippedTurns: skipped + before };
}
