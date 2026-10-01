/**
 * История сессии → события ленты (этап 6). Вход — сообщения `getSessionMessages()` (user/assistant
 * целиком, без потока) и структурные результаты инструментов из транскрипта (`toolUseResult`:
 * `SessionMessage` их не отдаёт, а без них нет ни `diff` у правок, ни счётчиков `+N −M`).
 * Выход — те же `AgentEvent`, что у живой сессии: лента и приборы webview проходят через тот же
 * редьюсер, хост — через тот же разбор правок (`ChatController`), поэтому `diff` в восстановленной
 * истории работает так же, как в живой. Чистая функция, без ввода-вывода.
 */
import type {
  AgentEvent,
  FileRef,
  ImageRef,
  PermissionMode,
  RetryPoint,
  SessionHistory,
  TokenUsage,
} from '../types';
import { imageSize, base64Bytes } from '../../shared/images';
import { documentKind, pdfPages, sessionPdfPages, utf8Bytes } from '../../shared/files';
import { splitPrompt } from '../../shared/prompt';
import { cost } from '../../data/pricing';
import { arr, isObj, num, obj, str, timestamp, withoutImageData, type Json } from './json';
import { usageFrom } from './mapper';

/** Сообщение `getSessionMessages()` — только то, что нам нужно. */
export interface HistoryMessage {
  type: string;
  uuid?: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  timestamp?: string;
}

/** Инструменты без побочных эффектов: ход только с ними можно отбросить и начать заново. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
]);

/**
 * Точка отката для «Повторить ход»: `messages` — цепочка транскрипта, `prompt` — текст пользователя
 * оборванного хода. Берётся последнее сообщение пользователя без результатов инструментов; оно
 * должно совпасть с промптом, быть не первым, а всё после него — только ответы и результаты
 * инструментов (иначе SDK откажет: в отбрасываемом диапазоне чужие сообщения — влитые, уведомления).
 */
export function findRetryPoint(
  messages: readonly HistoryMessage[],
  prompt: string,
): RetryPoint | undefined {
  const main = messages.filter(
    (m) => (m.type === 'user' || m.type === 'assistant') && !m.parent_tool_use_id,
  );
  const isPrompt = (m: HistoryMessage): boolean => {
    if (m.type !== 'user') return false;
    const content = obj(m.message)?.['content'];
    return !arr(content)
      .filter(isObj)
      .some((b) => b['type'] === 'tool_result');
  };
  let i = main.length - 1;
  while (i >= 0 && !isPrompt(main[i]!)) i--;
  if (i < 1) return undefined;
  const at = main[i]!;
  const text = textOf(obj(at.message)?.['content']);
  if (text === undefined || splitPrompt(text).text.trim() !== prompt.trim()) return undefined;
  // оборванный ход успел что-то изменить (правка, команда, субагент) — не отбрасываем: модель
  // забыла бы о сделанном и начала заново поверх изменённых файлов. Пусть лучше промпт будет дважды
  const acted = main.slice(i + 1).some((m) =>
    arr(obj(m.message)?.['content'])
      .filter(isObj)
      .some((b) => b['type'] === 'tool_use' && !READ_ONLY_TOOLS.has(str(b['name']) ?? '')),
  );
  if (acted) return undefined;
  const keep = main[i - 1]!;
  if (!at.uuid || !keep.uuid) return undefined;
  return { keepUuid: keep.uuid, promptUuid: at.uuid };
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
  /** Сколько последних файлов отдать с содержимым (по умолчанию `MAX_HISTORY_FILES`). */
  maxFiles?: number;
  /**
   * `uuid` записей-ошибок API (`isApiErrorMessage` транскрипта; `getSessionMessages` флага не отдаёт). Ход, который
   * ими закончился, — `turn.result` с `ok: false`. Не передан — ошибкой считается любой ответ `<synthetic>`.
   */
  apiErrors?: ReadonlySet<string>;
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
  /** Последний ответ хода — ошибка API (`<synthetic>`): ход закончился ошибкой, а не ответом. */
  failed: boolean;
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

function pdfPagesOf(data: string): number | undefined {
  try {
    return pdfPages(atob(data));
  } catch {
    return undefined;
  }
}

/**
 * Файлы реплики пользователя (этап 8 roadmap 0.2): `document`-блоки с текстом или pdf. CLI хранит их
 * в транскрипте целиком (живой прогон `scripts/attach-smoke.mjs`); путь — из `title`. Чужие
 * документы (url, file id) пропускаем: показать нечего и открыть нечего.
 */
function filesOf(content: unknown): FileRef[] {
  const out: FileRef[] = [];
  for (const b of arr(content).filter(isObj)) {
    if (b['type'] !== 'document') continue;
    const source = obj(b['source']);
    const kind = documentKind(source);
    const data = str(source?.['data']);
    if (!kind || data === undefined) continue;
    const pages = kind === 'pdf' ? pdfPagesOf(data) : undefined;
    out.push({
      kind,
      path: str(b['title']) || (kind === 'pdf' ? 'документ.pdf' : 'документ.txt'),
      size: kind === 'pdf' ? base64Bytes(data) : utf8Bytes(data),
      ...(pages !== undefined ? { pages } : {}),
      data,
    });
  }
  return out;
}

/** Сколько картинок истории уходит в webview с данными; более ранние — плашкой без миниатюры. */
export const MAX_HISTORY_IMAGES = 12;
/** Сколько файлов истории уходит с содержимым; более ранние — чипом без копии для просмотра. */
export const MAX_HISTORY_FILES = 12;
/**
 * И не больше этого символов данных суммарно — картинки и файлы вместе (сообщение
 * `session.history` идёт в webview целиком).
 */
export const MAX_HISTORY_IMAGE_CHARS = 24 * 1024 * 1024;

function withoutData<T extends { data?: string }>(i: T): T {
  const out: T = { ...i };
  delete out.data;
  return out;
}

/**
 * С конца истории: последние картинки и файлы — с данными, остальные — без (плашка «скриншот»,
 * чип файла без копии). Бюджет символов общий.
 */
function limitHistoryAttachments(events: AgentEvent[], maxImages: number, maxFiles: number): void {
  let images = 0;
  let files = 0;
  let chars = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'turn.start' || (!e.images && !e.files)) continue;
    const next = { ...e };
    if (e.files) {
      const list = [...e.files];
      for (let j = list.length - 1; j >= 0; j--) {
        const f = list[j];
        if (!f?.data) continue;
        if (files < maxFiles && chars + f.data.length <= MAX_HISTORY_IMAGE_CHARS) {
          files++;
          chars += f.data.length;
          continue;
        }
        list[j] = withoutData(f);
      }
      next.files = list;
    }
    if (e.images) {
      const list = [...e.images];
      for (let j = list.length - 1; j >= 0; j--) {
        const img = list[j];
        if (!img?.data) continue;
        if (images < maxImages && chars + img.data.length <= MAX_HISTORY_IMAGE_CHARS) {
          images++;
          chars += img.data.length;
          continue;
        }
        list[j] = withoutData(img);
      }
      next.images = list;
    }
    events[i] = next;
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
  // вложения с последней компакции — до обрезки данных в `limitHistoryAttachments`
  let attach = { pdfPages: 0, chars: 0 };
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
  /** В `runningCost` нет части ходов (модель без цены) — итог с пометкой. */
  let costPartial = false;
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
    else costPartial = true;
    events.push({
      type: 'turn.result',
      // как у движка: ошибка API — `subtype: success` с `is_error: true`
      ok: !t.failed,
      subtype: 'success',
      interrupted: t.interrupted,
      durationMs: Math.max(0, t.lastAt - t.startAt),
      apiDurationMs: 0,
      numTurns: t.calls.size, // API-вызовы хода (записей ассистента больше: CLI пишет по записи на блок)
      usage,
      ...(t.calls.size > 0 && !unpriced ? { costUsd: usd } : {}),
      totalCostUsd: runningCost,
      ...(costPartial ? { costPartial: true } : {}),
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
    failed: false,
  });

  const startTurn = (
    prompt: string,
    at: number,
    images: ImageRef[] = [],
    files: FileRef[] = [],
  ): void => {
    closeTurn(false);
    if (events.length) perTurn.push(events);
    events = [];
    turns++;
    turn = newTurn(at);
    events.push({
      type: 'turn.start',
      prompt,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
      at,
    });
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
          if (results.length === 1 && structured !== undefined)
            event.result = withoutImageData(structured);
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
      const files = filesOf(content);
      const text = textOf(content) ?? '';
      if (text.trim() === '' && images.length === 0 && files.length === 0) continue;
      const t = text.trimStart();
      if (COMPACT_SUMMARY.test(t)) {
        events.push({ type: 'compaction.end', ok: true });
        // после компакции картинки и документы из запросов уходят — счёт вложений сессии с нуля
        attach = { pdfPages: 0, chars: 0 };
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
      for (const i of images) attach.chars += i.data?.length ?? 0;
      for (const f of files) {
        attach.chars += f.data?.length ?? 0;
        attach.pdfPages += sessionPdfPages({
          kind: f.kind,
          size: f.size ?? 0,
          ...(f.pages ? { pages: f.pages } : {}),
        });
      }
      startTurn(text, at, images, files);
      continue;
    }

    // assistant
    touch();
    const id = str(msg['id']) ?? '';
    const model = str(msg['model']) ?? '';
    const synthetic = model === '<synthetic>';
    if (!synthetic && model) lastModel = model;
    // ошибка API, после которой движок ответил (повтор, следующий запрос), ход не роняет; служебный
    // `<synthetic>` без флага ошибки («No response requested.») состояние хода не меняет
    const apiError = options.apiErrors ? !!m.uuid && options.apiErrors.has(m.uuid) : synthetic;
    if (turn && apiError) turn.failed = true;
    else if (turn && !synthetic) turn.failed = false;
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
  limitHistoryAttachments(
    out,
    options.maxImages ?? MAX_HISTORY_IMAGES,
    options.maxFiles ?? MAX_HISTORY_FILES,
  );
  return {
    events: out,
    turns,
    skippedTurns: skipped,
    ...(lastModel ? { model: lastModel } : {}),
    ...(attach.chars > 0 || attach.pdfPages > 0 ? { attach } : {}),
  };
}
