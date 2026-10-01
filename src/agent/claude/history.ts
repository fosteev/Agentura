/**
 * История сессии → события ленты (этап 6). Вход — сообщения `getSessionMessages()` (user/assistant
 * целиком, без потока) и структурные результаты инструментов из транскрипта (`toolUseResult`:
 * `SessionMessage` их не отдаёт, а без них нет ни `diff` у правок, ни счётчиков `+N −M`).
 * Выход — те же `AgentEvent`, что у живой сессии: лента и приборы webview проходят через тот же
 * редьюсер, хост — через тот же разбор правок (`ChatController`), поэтому `diff` в восстановленной
 * истории работает так же, как в живой. Чистая функция, без ввода-вывода.
 */
import type { AgentEvent, ImageRef, PermissionMode, SessionHistory, TokenUsage } from '../types';
import { imageSize } from '../../shared/images';
import { cost } from '../../data/pricing';
import { arr, isObj, num, obj, str, timestamp, type Json } from './json';
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
  /**
   * Процесс движка жив (пересев webview открытой сессии): задачи без конца в транскрипте ещё идут —
   * не закрывать их «остановлено». По умолчанию — как `live`.
   */
  tasksAlive?: boolean;
  /** Сколько последних ходов показать. */
  maxTurns?: number;
  /** Сколько последних картинок отдать с данными (по умолчанию `MAX_HISTORY_IMAGES`). */
  maxImages?: number;
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

/**
 * Картинки реплики пользователя (этап 4 roadmap 0.2). CLI хранит base64 в транскрипте целиком
 * (живой прогон `scripts/image-smoke.mjs`); блок без данных (ссылка, url) — плашка «скриншот».
 */
function imagesOf(content: unknown): ImageRef[] {
  const out: ImageRef[] = [];
  for (const b of arr(content).filter(isObj)) {
    if (b['type'] !== 'image') continue;
    const source = obj(b['source']);
    const mediaType = str(source?.['media_type']);
    const data = source?.['type'] === 'base64' ? str(source['data']) : undefined;
    const size = data ? imageSize(mediaType, data) : undefined;
    out.push({
      ...(mediaType ? { mediaType } : {}),
      ...(data ? { data } : {}),
      ...(size ?? {}),
    });
  }
  return out;
}

/** Сколько картинок истории уходит в webview с данными; более ранние — плашкой без миниатюры. */
export const MAX_HISTORY_IMAGES = 12;
/** И не больше этого base64 суммарно (сообщение `session.history` идёт в webview целиком). */
export const MAX_HISTORY_IMAGE_CHARS = 24 * 1024 * 1024;

function withoutData(i: ImageRef): ImageRef {
  const out: ImageRef = { ...i };
  delete out.data;
  return out;
}

/** С конца истории: последние картинки — с данными, остальные — без (плашка «скриншот»). */
function limitHistoryImages(events: AgentEvent[], maxImages: number): void {
  let count = 0;
  let chars = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'turn.start' || !e.images) continue;
    const images = [...e.images];
    for (let j = images.length - 1; j >= 0; j--) {
      const img = images[j];
      if (!img?.data) continue;
      if (count < maxImages && chars + img.data.length <= MAX_HISTORY_IMAGE_CHARS) {
        count++;
        chars += img.data.length;
        continue;
      }
      images[j] = withoutData(img);
    }
    events[i] = { ...e, images };
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .filter(isObj)
    .map((b) => (b['type'] === 'text' ? (str(b['text']) ?? '') : `[${str(b['type']) ?? 'block'}]`))
    .join('\n');
}

/**
 * Отчёт субагента в результате `Agent`: движок оборачивает его рамкой «[Subagent hand-back] …
 * The report follows:» и сдвигает строки на два пробела. Для итога в карте — только сам отчёт.
 */
export function handBackText(text: string): string {
  const mark = 'The report follows:';
  const i = text.indexOf(mark);
  if (!text.startsWith('[Subagent hand-back]') || i < 0) return text;
  return text
    .slice(i + mark.length)
    .replace(/^\n/, '')
    .split('\n')
    .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
    .join('\n')
    .trim();
}

/** Уведомление о фоновой задаче, которое движок кладёт в транскрипт сообщением пользователя. */
const TASK_NOTIFICATION = /^<task-notification>/;

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1]!.trim() : undefined;
}

function tagNumber(text: string, name: string): number | undefined {
  const v = tag(text, name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** `<task-notification>` → `agent.end` (как `task_notification` живого потока). */
export function notificationEnd(
  text: string,
  at: number | undefined,
): Extract<AgentEvent, { type: 'agent.end' }> | undefined {
  const taskId = tag(text, 'task-id');
  if (!taskId) return undefined;
  const raw = tag(text, 'status');
  const status =
    raw === 'failed' || raw === 'stopped' || raw === 'killed'
      ? raw === 'failed'
        ? 'failed'
        : 'stopped'
      : 'completed';
  const summary = tag(text, 'result') ?? tag(text, 'summary');
  const tokens = tagNumber(text, 'subagent_tokens') ?? tagNumber(text, 'total_tokens');
  const uses = tagNumber(text, 'tool_uses');
  const duration = tagNumber(text, 'duration_ms');
  return {
    type: 'agent.end',
    agentId: tag(text, 'tool-use-id') ?? taskId,
    taskId,
    status,
    ...(summary ? { summary } : {}),
    ...(tokens !== undefined ? { totalTokens: tokens } : {}),
    ...(uses !== undefined ? { toolUses: uses } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(at ? { at } : {}),
  };
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
  /** Вызовы `Agent`/`Task` основного — их результаты закрывают агентов. */
  const agentCalls = new Set<string>();
  /** Запущенные задачи без конца: id вызова → id задачи. */
  const openAgents = new Map<string, string>();

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

  const newTurn = (at: number): Turn => ({
    startAt: at,
    lastAt: at,
    interrupted: false,
    calls: new Map(),
    assistantMessages: 0,
  });

  const startTurn = (prompt: string, at: number, images: ImageRef[] = []): void => {
    closeTurn(false);
    if (events.length) perTurn.push(events);
    events = [];
    turns++;
    turn = newTurn(at);
    events.push({ type: 'turn.start', prompt, ...(images.length ? { images } : {}), at });
  };

  /**
   * Уведомление о фоновой задаче: её конец и ход-пробуждение движка (без промпта). Пробуждение
   * остаётся в блоке хода пользователя — `maxTurns` режет по ходам пользователя.
   */
  const wake = (text: string, at: number): void => {
    closeTurn(false);
    // движок может склеить несколько уведомлений в одну реплику — закрыть каждую задачу
    const blocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [text];
    for (const block of blocks) {
      const end = notificationEnd(block, at);
      if (!end) continue;
      events.push(end);
      openAgents.delete(end.agentId);
    }
    turn = newTurn(at);
    events.push({ type: 'turn.start', at });
  };

  /** Вызов `Agent`/`Task` или фоновый `Bash` — задача для панели «агенты» (как `task_started`). */
  const agentStart = (name: string, toolUseId: string, input: Json, at: number): void => {
    const structured = obj(toolResults.get(toolUseId));
    if (name === 'Agent' || name === 'Task') {
      const subagentType = str(input['subagent_type']);
      const prompt = str(input['prompt']);
      events.push({
        type: 'agent.start',
        agentId: toolUseId,
        taskId: str(structured?.['agentId']) ?? toolUseId,
        description: str(input['description']) ?? '',
        taskType: 'local_agent',
        ...(subagentType ? { subagentType } : {}),
        background: input['run_in_background'] === true,
        ...(prompt ? { prompt } : {}),
        ...(at ? { at } : {}),
      });
      agentCalls.add(toolUseId);
      openAgents.set(toolUseId, str(structured?.['agentId']) ?? toolUseId);
    } else if (name === 'Bash' && input['run_in_background'] === true) {
      const taskId = str(structured?.['backgroundTaskId']);
      if (!taskId) return;
      events.push({
        type: 'agent.start',
        agentId: toolUseId,
        taskId,
        description: str(input['description']) ?? str(input['command']) ?? '',
        taskType: 'local_bash',
        background: true,
        ...(at ? { at } : {}),
      });
      openAgents.set(toolUseId, taskId);
    }
  };

  /** Результат `Agent` переднего плана — конец агента; фоновый («async_launched») закончится уведомлением. */
  const agentEnd = (toolUseId: string, isError: boolean, content: string, at: number): void => {
    if (!agentCalls.has(toolUseId)) return;
    const structured = obj(toolResults.get(toolUseId));
    const status = str(structured?.['status']);
    if (status === 'async_launched' || (!structured && content.startsWith('Async agent launched')))
      return;
    const taskId = str(structured?.['agentId']) ?? toolUseId;
    const text =
      arr(structured?.['content'])
        .filter(isObj)
        .map((b) => str(b['text']) ?? '')
        .join('\n') || handBackText(content);
    const tokens = num(structured?.['totalTokens']);
    const uses = num(structured?.['totalToolUseCount']);
    const duration = num(structured?.['totalDurationMs']);
    events.push({
      type: 'agent.end',
      agentId: toolUseId,
      taskId,
      status: isError ? (/interrupted/i.test(content) ? 'stopped' : 'failed') : 'completed',
      ...(text ? { summary: text } : {}),
      ...(tokens !== undefined ? { totalTokens: tokens } : {}),
      ...(uses !== undefined ? { toolUses: uses } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(at ? { at } : {}),
    });
    openAgents.delete(toolUseId);
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
          agentEnd(toolUseId, event.isError, event.content, at);
        }
        continue;
      }
      const images = imagesOf(content);
      const text = textOf(content) ?? '';
      if (text.trim() === '' && images.length === 0) continue;
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
      if (TASK_NOTIFICATION.test(t)) {
        wake(t, at);
        continue;
      }
      startTurn(text, at, images);
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
          const input = obj(block['input']) ?? ({} as Json);
          events.push({
            type: 'tool.start',
            toolUseId,
            name,
            input,
            ...(at ? { at } : {}),
          });
          agentStart(name, toolUseId, input, at);
          break;
        }
        default:
          break;
      }
    }
  }
  const lastAt = turn?.lastAt;
  closeTurn(options.live === true);
  // Задача без конца в транскрипте (сессию закрыли посреди работы агента): процесса движка уже нет —
  // агент остановлен, иначе карта «бежала» бы вечно с ■ в никуда. У идущей сессии (`live`) — ждём.
  if (!(options.tasksAlive ?? options.live)) {
    for (const [agentId, taskId] of openAgents) {
      events.push({
        type: 'agent.end',
        agentId,
        taskId,
        status: 'stopped',
        ...(lastAt ? { at: lastAt } : {}),
      });
    }
  }
  if (events.length) perTurn.push(events);

  // Последние `maxTurns` ходов; «нулевой» блок (до первого промпта) — только если ходов не отрезали.
  const max = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const hasPreamble = perTurn.length > turns;
  const skipped = Math.max(0, turns - max);
  const kept = perTurn.slice((hasPreamble ? 1 : 0) + skipped);
  const head = hasPreamble && skipped === 0 ? (perTurn[0] ?? []) : [];
  const out = [...head, ...kept.flat()];
  limitHistoryImages(out, options.maxImages ?? MAX_HISTORY_IMAGES);
  return {
    events: out,
    turns,
    skippedTurns: skipped,
    ...(lastModel ? { model: lastModel } : {}),
  };
}
