import type { AgentEvent, AgentEventOf, ImageRef, SessionHistory, TokenUsage } from '../types';
import { DEFAULT_MAX_TURNS } from '../claude/history';
import { CodexToolMapper } from './tools';
import type { Thread, ThreadItem, Turn, UserInput } from './protocol';

export interface CodexHistoryOptions {
  /** Сессия идёт сейчас (пересев webview): незавершённый последний ход остаётся открытым. */
  live?: boolean;
  /** Сколько последних ходов отдать; по умолчанию как у Claude. */
  maxTurns?: number;
  /** Подмена часов в тестах: время тех, у кого сервер его не сообщил. */
  now?: () => number;
}

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** `data:image/png;base64,…` → `ImageRef` с данными; другой `url` (http) — только пометка без данных. */
function dataImage(url: string, index: number): ImageRef {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return { name: `image ${index + 1}` };
  return { mediaType: m[1]!, data: m[2]! };
}

/** Текст и картинки реплики пользователя; `mention`/`skill` в ленте — их имя, как набрал бы человек. */
function promptOf(content: readonly UserInput[]): { text: string; images: ImageRef[] } {
  const texts: string[] = [];
  const images: ImageRef[] = [];
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') images.push(dataImage(part.url, images.length));
    else if (part.type === 'localImage') {
      const name = part.path.split(/[\\/]/).pop();
      images.push({ ...(name ? { name } : {}) });
    } else if (part.type === 'mention') texts.push(`@${part.name}`);
    else if (part.type === 'skill') texts.push(`$${part.name}`);
  }
  return { text: texts.join('\n'), images };
}

function reasoningText(item: Extract<ThreadItem, { type: 'reasoning' }>): string {
  const summary = item.summary.filter(Boolean);
  return (summary.length ? summary : item.content.filter(Boolean)).join('\n\n');
}

/**
 * События ленты для одного хода `thread/read`. Те же `AgentEvent`, что у живого хода: `turn.start` с промптом,
 * инструменты — через `CodexToolMapper` (имена Claude), текст ответа целиком одним `text.delta`, итог хода.
 * Запросов подтверждения в истории нет — они живут, пока сервер ждёт ответа.
 */
function turnEvents(
  turn: Turn,
  model: string | null,
  tools: CodexToolMapper,
  open: boolean,
  now: () => number,
): AgentEvent[] {
  const startedAt = (turn.startedAt ?? turn.completedAt ?? 0) * 1000 || now();
  const endedAt = turn.completedAt ? turn.completedAt * 1000 : startedAt;
  const events: AgentEvent[] = [];
  let started = false;
  let finalText: string | undefined;
  let lastText: string | undefined;
  const start = (prompt: string | undefined, images: ImageRef[]): void => {
    const e: AgentEventOf<'turn.start'> = { type: 'turn.start', at: startedAt };
    if (prompt !== undefined) e.prompt = prompt;
    if (images.length) e.images = images;
    events.push(e);
    started = true;
  };
  for (const item of turn.items) {
    if (item.type === 'userMessage') {
      const { text, images } = promptOf(item.content);
      if (!started) start(text, images);
      else {
        // второе сообщение внутри хода (человек дописал во время работы) — влито в ход, своего `turn.start` нет
        const e: AgentEventOf<'turn.input'> = { type: 'turn.input', prompt: text, at: startedAt };
        if (images.length) e.images = images;
        events.push(e);
      }
      continue;
    }
    // ход начал сам движок (нет сообщения пользователя): `turn.start` без промпта
    if (!started) start(undefined, []);
    if (item.type === 'agentMessage') {
      if (!item.text) continue;
      events.push({ type: 'text.delta', messageId: item.id, text: item.text });
      lastText = item.text;
      if (item.phase === 'final_answer') finalText = item.text;
    } else if (item.type === 'reasoning') {
      const text = reasoningText(item);
      if (!text) continue;
      events.push({ type: 'thinking.start', messageId: item.id, at: startedAt });
      events.push({ type: 'thinking.delta', messageId: item.id, text });
      events.push({ type: 'thinking.stop', messageId: item.id, at: startedAt });
    } else {
      events.push(...tools.completed(item, endedAt));
    }
  }
  if (!started) start(undefined, []);
  // идёт ли ход: `inProgress` у живой сессии (пересев) остаётся открытым; в остальных случаях — процесс умер на
  // полпути или транскрипт оборван, ленте нужен конец хода
  if (turn.status === 'inProgress' && open) return events;
  const interrupted = turn.status === 'interrupted' || turn.status === 'inProgress';
  const ok = turn.status === 'completed';
  const durationMs = turn.durationMs ?? Math.max(0, endedAt - startedAt);
  const result: AgentEventOf<'turn.result'> = {
    type: 'turn.result',
    ok,
    subtype: ok ? 'success' : interrupted ? 'interrupted' : 'error',
    interrupted,
    durationMs,
    apiDurationMs: durationMs,
    numTurns: 1,
    // `thread/read` токенов хода не отдаёт; нули — «неизвестно», как стоимость
    usage: { ...NO_USAGE },
    totalCostUsd: 0,
    permissionDenials: [],
  };
  if (model) result.model = model;
  if (turn.status === 'failed') result.terminalReason = 'failed';
  const message = turn.error?.message;
  if (message) result.errors = [message];
  const text = finalText ?? lastText;
  if (text) result.text = text;
  events.push(result);
  return events;
}

/**
 * История Codex-треда (`thread/read` с `includeTurns`) → `SessionHistory`. Последние `maxTurns` ходов;
 * `model` — модель треда (с ней продолжаем), `mode` нет: у Codex нет режимов Claude.
 */
export function buildCodexHistory(thread: Thread, options: CodexHistoryOptions = {}): SessionHistory {
  const now = options.now ?? Date.now;
  const turns = thread.turns ?? [];
  const max = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const skipped = Math.max(0, turns.length - max);
  const shown = skipped ? turns.slice(skipped) : turns;
  // один маппер на всю историю: id элементов уникальны в треде, а состояние маппера между ходами не нужно
  const tools = new CodexToolMapper(now);
  const events: AgentEvent[] = [];
  shown.forEach((turn, i) => {
    const last = i === shown.length - 1;
    events.push(...turnEvents(turn, thread.model, tools, !!options.live && last, now));
  });
  const history: SessionHistory = { events, turns: turns.length, skippedTurns: skipped };
  if (thread.model) history.model = thread.model;
  return history;
}
