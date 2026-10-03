/**
 * Состояние чата webview: чистый редьюсер событий агента в строки ленты. Без Preact и DOM —
 * проверяется юнит-тестами; стор на сигналах (`store.ts`) только хранит результат.
 */
import type {
  AgentEvent,
  DiffPreview,
  EffortLevel,
  PermissionAlways,
  PermissionDecision,
  FileRef,
  ImageRef,
  PermissionMode,
  Question,
} from '../agent/types';
import { nextStatus, updateInTurn, updatePending, type ChatStatus } from '../agent/status';
import type { EditPreview, PlanChoice } from '../protocol';
import { splitPrompt } from '../shared/prompt';
import type { Seg } from './fixtures/chat';
import { compactTokens, formatCost, formatDuration, formatInt } from './toolView';
import { imagesTokens } from '../shared/images';
import { ui } from './strings';

export type FeedRow =
  | {
      id: number;
      kind: 'sys';
      tone?: 'ok' | 'bad';
      text: Seg[];
      at?: string;
      /**
       * `limit` — строка «ход не начат» (одна на упор в лимит), `retry` — повтор запроса к API (схлопываются),
       * `fail` — погашенная карточка ошибки (ею кончается оборванный ход, см. `feedTurns`).
       */
      tag?: 'limit' | 'retry' | 'fail';
    }
  | {
      id: number;
      kind: 'user';
      text: string;
      at?: string;
      queued?: boolean;
      context?: string;
      /** Картинки сообщения (этап 4 roadmap 0.2); без `data` — плашка «скриншот». */
      images?: ImageRef[];
      /** Файлы сообщения (этап 8): чип с именем и размером, содержимое в ленту не выводится. */
      files?: FileRef[];
    }
  | {
      id: number;
      kind: 'think';
      messageId: string;
      text: string;
      startedAt: number;
      endedAt?: number;
    }
  | {
      id: number;
      kind: 'tool';
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      startedAt: number;
      state: 'run' | 'ok' | 'err' | 'stopped';
      durationMs?: number;
      elapsedMs?: number;
      content?: string;
      result?: unknown;
    }
  | { id: number; kind: 'text'; messageId: string; text: string; streaming: boolean }
  | { id: number; kind: 'sum'; parts: string[]; cost?: string; time: string }
  | PermCard
  | QuestionCard
  | PlanCard
  | FailCard;

/**
 * Карточка ошибки движка (этап 7, экран error): «Движок остановился» с текстом ошибки и кнопками
 * «Повторить ход» / «Открыть журнал расширения». `retrying` — кнопка нажата, ждём `session.history`.
 */
export interface FailCard {
  id: number;
  kind: 'fail';
  /** Движок упал (`fatal`) или ход не удался при живой сессии. */
  fatal: boolean;
  message: string;
  code?: string;
  at: string;
  /** Ход был оборван посреди работы: «Повторить ход», иначе «Возобновить сессию». */
  turn: boolean;
  state: 'open' | 'retrying';
}

/**
 * Карточки `.ask` (этап 5). Живут строками ленты там, где пришёл запрос. `sent` — кнопка нажата,
 * ответ ушёл хосту, ждём `permission.resolved`; итог решения — системной строкой рядом.
 */
export interface PermCard {
  id: number;
  kind: 'perm';
  toolUseId: string;
  agentId?: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  reason?: string;
  blockedPath?: string;
  always?: PermissionAlways;
  diff?: DiffPreview;
  /** Ханки с номерами строк от хоста (`diff.preview`), приходят вдогонку. */
  preview?: EditPreview;
  sent?: PermissionDecision;
}

export interface QuestionCard {
  id: number;
  kind: 'question';
  toolUseId: string;
  agentId?: string;
  questions: Question[];
  /** Выбранные варианты по тексту вопроса (метки). */
  picks: Record<string, string[]>;
  /** Свой ответ по тексту вопроса (из поля ввода). */
  custom: Record<string, string>;
  state: 'pending' | 'sent' | 'answered' | 'declined' | 'cancelled';
}

export interface PlanCard {
  id: number;
  kind: 'plan';
  toolUseId: string;
  agentId?: string;
  plan: string;
  planFilePath?: string;
  state: 'pending' | 'sent' | 'done' | 'cancelled';
  choice?: PlanChoice;
  feedback?: string;
}

export type Card = PermCard | QuestionCard | PlanCard;

export interface ChatState {
  rows: FeedRow[];
  nextId: number;
  status: ChatStatus;
  sessionId: string;
  project: string;
  cwd: string;
  allowBypass: boolean;
  title?: string;
  model?: string;
  engineVersion?: string;
  mode: PermissionMode;
  effort?: EffortLevel;
  /** Из `session.init` и `supportedCommands()`. */
  skills: string[];
  slashCommands: string[];
  turnStartedAt?: number;
  /** Оценка токенов картинок текущего хода (этап 4 roadmap 0.2) — в итог хода. */
  turnImageTokens?: number;
  /** Сброс окна, упёршегося в лимит (`limit.update` со статусом `rejected`) — для строки «ход не начат». */
  limitResetsAt?: number;
  compactingRow?: number;
  closed?: { reason: 'exit' | 'error' | 'disposed'; message?: string };
  /** Запросы, ждущие ответа (`updatePending`): пока есть — состояние `waiting`. */
  pending: string[];
  /** Идёт ход основного агента (`updateInTurn`) — куда вернуться после ответа на запрос. */
  inTurn?: boolean;
}

export function initialState(): ChatState {
  return {
    rows: [],
    nextId: 1,
    status: 'idle',
    sessionId: '',
    project: '',
    cwd: '',
    allowBypass: false,
    mode: 'default',
    skills: [],
    slashCommands: [],
    pending: [],
  };
}

/** Новая сессия: лента и сессионные поля сбрасываются, сведения о воркспейсе остаются. */
export function resetSession(s: ChatState): ChatState {
  return { ...initialState(), project: s.project, cwd: s.cwd, allowBypass: s.allowBypass };
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Время сброса: сегодня — `17:00`, иначе `пт 09:00`. */
export function resetLabel(resetsAt: number, now: number): string {
  const d = new Date(resetsAt);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return sameDay ? clock(resetsAt) : `${ui.time.weekdaysShort[d.getDay()]} ${clock(resetsAt)}`;
}

function push(s: ChatState, row: DistributiveOmit<FeedRow, 'id'>): ChatState {
  return { ...s, rows: [...s.rows, { ...row, id: s.nextId } as FeedRow], nextId: s.nextId + 1 };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function replaceAt(s: ChatState, index: number, row: FeedRow): ChatState {
  const rows = s.rows.slice();
  rows[index] = row;
  return { ...s, rows };
}

function lastIndex(rows: FeedRow[], pred: (r: FeedRow) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i]!)) return i;
  return -1;
}

/** Локальная системная строка (результат `/status`, `/plan`). */
export function addSys(s: ChatState, text: Seg[], tone?: 'ok' | 'bad'): ChatState {
  return push(s, { kind: 'sys', text, ...(tone ? { tone } : {}) });
}

/** Строка «в очереди» с текстом промпта (без блока контекста); -1 — нет. */
function queuedRow(s: ChatState, prompt: string): number {
  const text = splitPrompt(prompt).text.trim();
  return s.rows.findIndex((r) => r.kind === 'user' && r.queued && r.text.trim() === text);
}

/** Сообщение пользователя отправлено, `turn.start` ещё не пришёл — «в очереди». */
export function queueUser(
  s: ChatState,
  text: string,
  images?: readonly ImageRef[],
  files?: readonly FileRef[],
): ChatState {
  return push(retireFails(s), {
    kind: 'user',
    text,
    queued: true,
    ...(images?.length ? { images: [...images] } : {}),
    ...(files?.length ? { files: [...files] } : {}),
  });
}

/**
 * Карточки ошибки → красные строки: человек пошёл дальше (новое сообщение, начался ход) или это история.
 * Кнопка «Повторить» на старой карточке иначе перезапустила бы движок посреди нового хода.
 */
function retireFails(s: ChatState): ChatState {
  if (!s.rows.some((r) => r.kind === 'fail')) return s;
  return {
    ...s,
    rows: s.rows.map((r): FeedRow =>
      r.kind === 'fail'
        ? { id: r.id, kind: 'sys', tone: 'bad', tag: 'fail', text: [r.message], at: r.at }
        : r,
    ),
  };
}

function closeOpenRows(s: ChatState, interrupted: boolean, at: number): ChatState {
  const rows = s.rows.map((r): FeedRow => {
    if (r.kind === 'text' && r.streaming) return { ...r, streaming: false };
    if (r.kind === 'think' && r.endedAt === undefined) return { ...r, endedAt: at };
    if (r.kind === 'tool' && r.state === 'run')
      return { ...r, state: interrupted ? 'stopped' : 'err' };
    return r;
  });
  return { ...s, rows };
}

/**
 * Сообщение дошло до движка: строка «в очереди» с тем же текстом становится обычной, иначе
 * добавляется новая. Блок контекста отделяется от текста.
 */
function deliverUser(
  s: ChatState,
  prompt: string,
  atMs: number,
  images?: readonly ImageRef[],
  files?: readonly FileRef[],
  /** Новый ход (`turn.start`): своя строка «в очереди» встаёт в конец ленты, а не остаётся посреди прошлого хода. */
  toEnd = false,
): ChatState {
  const { text, context } = splitPrompt(prompt);
  const at = clock(atMs);
  const idx = queuedRow(s, prompt);
  const queued = idx >= 0 ? (s.rows[idx] as Extract<FeedRow, { kind: 'user' }>) : undefined;
  // в итог хода — картинки своей строки «в очереди», если она есть, иначе — из события
  const tokens = imagesTokens(queued?.images?.length ? queued.images : images);
  if (tokens > 0) s = { ...s, turnImageTokens: (s.turnImageTokens ?? 0) + tokens };
  if (idx < 0)
    return push(s, {
      kind: 'user',
      text,
      at,
      ...(context ? { context } : {}),
      ...(images?.length ? { images: [...images] } : {}),
      ...(files?.length ? { files: [...files] } : {}),
    });
  const row = s.rows[idx] as Extract<FeedRow, { kind: 'user' }>;
  const updated: Extract<FeedRow, { kind: 'user' }> = { ...row, queued: false, at };
  if (context) updated.context = context;
  // своя строка «в очереди» уже держит картинки (из поля ввода) — событие их не заменяет
  if (!row.images?.length && images?.length) updated.images = [...images];
  // файлы — так же: у строки из поля ввода они с содержимым (копия для просмотра), у события — без
  if (!row.files?.length && files?.length) updated.files = [...files];
  if (toEnd) {
    // в конец, но перед остальными строками «в очереди» — их ходы ещё впереди
    const rows = [...s.rows.slice(0, idx), ...s.rows.slice(idx + 1)];
    let at = rows.length;
    while (at > idx && rows[at - 1]?.kind === 'user' && (rows[at - 1] as { queued?: boolean }).queued) at--;
    rows.splice(at, 0, updated);
    return { ...s, rows };
  }
  return replaceAt(s, idx, updated);
}

/** Заголовок `session.history`: что хост знает о сессии помимо событий. */
export interface HistorySeed {
  sessionId: string;
  title?: string;
  model?: string;
  mode?: PermissionMode;
  skippedTurns: number;
}

/**
 * Лента восстановленной сессии: сброс, сведения о сессии, события истории тем же редьюсером, что и
 * живые. Незакрытые строки (обрыв посреди хода при закрытии окна) закрываются как прерванные,
 * состояние — покой, если ход не открыт (история не должна оставлять «ошибку» от давней записи).
 */
export function seedHistory(
  s: ChatState,
  seed: HistorySeed,
  events: readonly AgentEvent[],
  now = Date.now(),
): ChatState {
  let out: ChatState = {
    ...resetSession(s),
    sessionId: seed.sessionId,
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.mode ? { mode: seed.mode } : {}),
  };
  if (seed.skippedTurns > 0) out = addSys(out, [ui.sys.historyTrimmed(seed.skippedTurns)]);
  for (const e of events) out = applyEvent(out, e, now);
  out = closeOpenRows(out, true, now);
  // давняя ошибка из транскрипта — строка, а не карточка с кнопкой «Повторить»: повторять уже нечего
  out = retireFails(out);
  const { limitResetsAt: _l, closed: _c, ...rest } = out;
  void _l;
  void _c;
  return { ...rest, status: rest.inTurn ? 'working' : 'idle', pending: [] };
}

export function applyEvent(s: ChatState, event: AgentEvent, now = Date.now()): ChatState {
  const pending = updatePending(s.pending, event);
  const inTurn = updateInTurn(!!s.inTurn, event);
  const status = nextStatus(s.status, event, pending.length, inTurn);
  const { inTurn: _was, ...rest } = s;
  void _was;
  const next = reduce({ ...rest, status, pending, ...(inTurn ? { inTurn } : {}) }, event, now);
  return next;
}

/** События субагентов, которые всё же попадают в ленту: их запросы ждут человека. */
const SUBAGENT_FEED: ReadonlySet<AgentEvent['type']> = new Set([
  'agent.start',
  'agent.progress',
  'agent.end',
  'permission.request',
  'question.request',
  'plan.request',
  'permission.resolved',
]);

function reduce(s: ChatState, e: AgentEvent, now: number): ChatState {
  // Субагенты: в ленте основного агента их строк нет (панель «агенты» — этап 4), кроме карточек.
  if (e.agentId && !SUBAGENT_FEED.has(e.type)) return s;
  switch (e.type) {
    case 'session.init': {
      const out: ChatState = {
        ...s,
        sessionId: e.sessionId,
        model: e.model,
        engineVersion: e.engineVersion,
        mode: e.permissionMode,
        ...(e.effort ? { effort: e.effort } : {}),
        skills: e.skills,
        slashCommands: e.slashCommands,
      };
      return out;
    }
    case 'session.title':
      return { ...s, title: e.title };
    case 'mode.changed': {
      // режим, выбранный из интерфейса, уже стоит в состоянии — строка только для смены движком
      if (e.mode === s.mode) return s;
      const out = addSys({ ...s, mode: e.mode }, [
        ui.sys.modeChanged(ui.modes[e.mode]?.[0] ?? e.mode),
      ]);
      const last = out.rows[out.rows.length - 1] as Extract<FeedRow, { kind: 'sys' }>;
      return replaceAt(out, out.rows.length - 1, { ...last, at: clock(now) });
    }
    case 'limit.update':
      if (e.status !== 'rejected') return s;
      return limitRow(
        e.resetsAt !== undefined ? { ...s, limitResetsAt: e.resetsAt } : s,
        undefined,
        now,
      );
    case 'turn.start': {
      const { limitResetsAt: _l, turnImageTokens: _i, ...base } = s;
      void _l;
      void _i;
      // начался ход — старые карточки ошибки больше не повторяются
      const out: ChatState = retireFails({ ...base, turnStartedAt: e.at });
      // склеенные движком сообщения — каждое своей строкой
      const prompts = e.prompts ?? (e.prompt !== undefined ? [e.prompt] : []);
      // картинки склеенных сообщений не разделить по сообщениям — у последнего. Если хоть одно
      // из них — своя строка «в очереди», картинки уже у своих строк: событие их не дублирует
      // (иначе скрин A повис бы и под B)
      const own = prompts.some((p) => queuedRow(out, p) >= 0);
      const images = own ? undefined : e.images;
      const files = own ? undefined : e.files;
      // строка «в очереди», отправленная посреди прошлого хода, переезжает в конец — туда, где начался её ход
      return prompts.reduce(
        (acc, p, i) =>
          i === prompts.length - 1
            ? deliverUser(acc, p, e.at, images, files, true)
            : deliverUser(acc, p, e.at, undefined, undefined, true),
        out,
      );
    }
    case 'turn.input':
      return deliverUser(s, e.prompt, e.at, e.images, e.files);
    case 'thinking.start':
      return push(s, { kind: 'think', messageId: e.messageId, text: '', startedAt: e.at });
    case 'thinking.delta': {
      const i = lastIndex(s.rows, (r) => r.kind === 'think' && r.messageId === e.messageId);
      if (i < 0) {
        return push(s, { kind: 'think', messageId: e.messageId, text: e.text, startedAt: now });
      }
      const row = s.rows[i] as Extract<FeedRow, { kind: 'think' }>;
      return replaceAt(s, i, { ...row, text: row.text + e.text });
    }
    case 'thinking.stop': {
      const i = lastIndex(s.rows, (r) => r.kind === 'think' && r.messageId === e.messageId);
      if (i < 0) return s;
      const row = s.rows[i] as Extract<FeedRow, { kind: 'think' }>;
      return replaceAt(s, i, { ...row, endedAt: e.at });
    }
    case 'text.delta': {
      const last = s.rows[s.rows.length - 1];
      if (last && last.kind === 'text' && last.messageId === e.messageId && last.streaming) {
        return replaceAt(s, s.rows.length - 1, { ...last, text: last.text + e.text });
      }
      return push(s, { kind: 'text', messageId: e.messageId, text: e.text, streaming: true });
    }
    case 'tool.start': {
      const closed = s.rows.map((r): FeedRow =>
        r.kind === 'text' && r.streaming ? { ...r, streaming: false } : r,
      );
      return push(
        { ...s, rows: closed },
        {
          kind: 'tool',
          toolUseId: e.toolUseId,
          name: e.name,
          input: e.input,
          startedAt: e.at ?? now,
          state: 'run',
        },
      );
    }
    case 'tool.progress': {
      const i = lastIndex(s.rows, (r) => r.kind === 'tool' && r.toolUseId === e.toolUseId);
      if (i < 0) return s;
      const row = s.rows[i] as Extract<FeedRow, { kind: 'tool' }>;
      return replaceAt(s, i, { ...row, elapsedMs: e.elapsedMs });
    }
    case 'tool.result': {
      const i = lastIndex(s.rows, (r) => r.kind === 'tool' && r.toolUseId === e.toolUseId);
      if (i < 0) return s;
      const row = s.rows[i] as Extract<FeedRow, { kind: 'tool' }>;
      const done: Extract<FeedRow, { kind: 'tool' }> = {
        ...row,
        state: e.isError ? 'err' : 'ok',
        content: e.content,
        result: e.result,
      };
      if (e.durationMs !== undefined) done.durationMs = e.durationMs;
      else if (e.at !== undefined) done.durationMs = Math.max(0, e.at - row.startedAt);
      return replaceAt(s, i, done);
    }
    case 'permission.request':
      if (findCard(s, e.toolUseId) >= 0) return s;
      return push(s, {
        kind: 'perm',
        toolUseId: e.toolUseId,
        ...(e.agentId ? { agentId: e.agentId } : {}),
        toolName: e.toolName,
        input: e.input,
        ...(e.description ? { description: e.description } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.blockedPath ? { blockedPath: e.blockedPath } : {}),
        ...(e.always ? { always: e.always } : {}),
        ...(e.diff ? { diff: e.diff } : {}),
      });
    case 'question.request':
      if (findCard(s, e.toolUseId) >= 0) return s;
      return push(s, {
        kind: 'question',
        toolUseId: e.toolUseId,
        ...(e.agentId ? { agentId: e.agentId } : {}),
        questions: e.questions,
        picks: {},
        custom: {},
        state: 'pending',
      });
    case 'plan.request':
      if (findCard(s, e.toolUseId) >= 0) return s;
      return push(s, {
        kind: 'plan',
        toolUseId: e.toolUseId,
        ...(e.agentId ? { agentId: e.agentId } : {}),
        plan: e.plan,
        ...(e.planFilePath ? { planFilePath: e.planFilePath } : {}),
        state: 'pending',
      });
    case 'permission.resolved':
      return resolveCard(s, e, now);
    case 'compaction.start': {
      const out = push(s, { kind: 'sys', text: [ui.sys.compacting] });
      return { ...out, compactingRow: out.rows[out.rows.length - 1]!.id };
    }
    case 'compaction.end': {
      const row: DistributiveOmit<FeedRow, 'id'> = e.ok
        ? { kind: 'sys', text: compactionText(e, now) }
        : { kind: 'sys', tone: 'bad', text: [ui.sys.compactFailed(e.error)] };
      const i = s.rows.findIndex((r) => r.id === s.compactingRow);
      const { compactingRow: _drop, ...rest } = s;
      void _drop;
      if (i >= 0) return replaceAt(rest, i, { ...row, id: s.rows[i]!.id } as FeedRow);
      return push(rest, row);
    }
    case 'turn.result': {
      let out = closeOpenRows(s, e.interrupted, now);
      const { turnStartedAt: _t, turnImageTokens: imageTokens, ...rest } = out;
      void _t;
      out = rest;
      const u = e.usage;
      const parts = [
        `in ${formatInt(u.input)}`,
        `out ${formatInt(u.output)}`,
        // движок не отделяет токены картинок от input — оценка ш×в/750, с «≈»
        ...(imageTokens ? [ui.log.imagesTokens(compactTokens(imageTokens))] : []),
        `cache r${formatInt(u.cacheRead)} w${formatInt(u.cacheWrite)}`,
      ];
      const sum: DistributiveOmit<FeedRow, 'id'> = {
        kind: 'sum',
        parts,
        time: formatDuration(e.durationMs),
        ...(e.costUsd !== undefined ? { cost: formatCost(e.costUsd) } : {}),
      };
      out = push(out, sum);
      if (e.interrupted) out = push(out, { kind: 'sys', text: [ui.sys.interrupted] });
      else if (!e.ok && e.errors?.length) {
        out = push(out, { kind: 'sys', tone: 'bad', text: [e.errors.join('; ')] });
      }
      return out;
    }
    case 'error': {
      if (e.code === 'limit') return limitRow(s, e.message, now);
      if (e.code === 'api_retry') return retryRow(s, e.message);
      return failRow(
        s,
        { fatal: e.fatal, message: e.message, ...(e.code ? { code: e.code } : {}) },
        now,
      );
    }
    case 'session.closed': {
      // оборвало ход или упало с ошибкой — карточка; тихое закрытие в покое — строка
      const wasTurn = openTurn(s.rows);
      const out = closeOpenRows(s, true, now);
      const closed = { reason: e.reason, ...(e.message ? { message: e.message } : {}) };
      if (e.reason === 'error' || (e.reason === 'exit' && wasTurn)) {
        const last = out.rows[out.rows.length - 1];
        // `error fatal` и `session.closed` приходят парой — одна карточка
        if (last?.kind === 'fail') return { ...out, closed };
        return failRow(
          { ...out, closed },
          { fatal: true, message: e.message ?? ui.sys.closed(e.reason) },
          now,
        );
      }
      return push({ ...out, closed }, { kind: 'sys', text: [ui.sys.closed(e.reason, e.message)] });
    }
    default:
      return s;
  }
}

/** Ход открыт: после последней строки `sum` есть сообщение пользователя (ответ не дописан). */
function openTurn(rows: readonly FeedRow[]): boolean {
  const user = lastIndex(rows as FeedRow[], (r) => r.kind === 'user' && !r.queued);
  return user > lastIndex(rows as FeedRow[], (r) => r.kind === 'sum');
}

/** «ход не начат»: одна строка на упор в лимит; повторное событие уточняет текст, а не дублирует. */
function limitRow(s: ChatState, message: string | undefined, now: number): ChatState {
  // недельный сброс через несколько дней — с днём недели, как в баннере
  const reset =
    s.limitResetsAt !== undefined ? ` · ${ui.sys.resetAt(resetLabel(s.limitResetsAt, now))}` : '';
  const row: DistributiveOmit<FeedRow, 'id'> = {
    kind: 'sys',
    tone: 'bad',
    tag: 'limit',
    at: clock(now),
    text: [ui.sys.turnNotStarted(message ?? ui.sys.limitDefault) + reset],
  };
  const i = s.rows.length - 1;
  const last = s.rows[i];
  if (last?.kind === 'sys' && last.tag === 'limit') {
    // событие без текста не затирает уже известную причину
    if (message === undefined)
      return replaceAt(s, i, { ...row, id: last.id, text: last.text } as FeedRow);
    return replaceAt(s, i, { ...row, id: last.id } as FeedRow);
  }
  return push(s, row);
}

/** Повтор запроса движком — не ошибка: подряд идущие попытки сливаются в одну строку. */
function retryRow(s: ChatState, message: string): ChatState {
  const i = s.rows.length - 1;
  const last = s.rows[i];
  if (last?.kind === 'sys' && last.tag === 'retry') {
    return replaceAt(s, i, { ...last, text: [message] });
  }
  return push(s, { kind: 'sys', tag: 'retry', text: [message] });
}

function failRow(
  s: ChatState,
  f: { fatal: boolean; message: string; code?: string },
  now: number,
): ChatState {
  const turn = openTurn(s.rows);
  // упавший повтор: прежняя карточка («повторяю…») заменяется новой
  const closed = closeOpenRows(s, f.fatal, now);
  const base: ChatState = {
    ...closed,
    rows: closed.rows.filter((r) => !(r.kind === 'fail' && r.state === 'retrying')),
  };
  return push(base, {
    kind: 'fail',
    fatal: f.fatal,
    message: f.message,
    ...(f.code ? { code: f.code } : {}),
    at: clock(now),
    turn,
    state: 'open',
  });
}

/** «Повторить ход» нажата: кнопки гаснут до `session.history` (или новой ошибки). */
export function markRetrying(s: ChatState): ChatState {
  const i = lastIndex(s.rows, (r) => r.kind === 'fail' && r.state === 'open');
  if (i < 0) return s;
  return replaceAt(s, i, { ...(s.rows[i] as FailCard), state: 'retrying' });
}

/**
 * «Повторить ход» не дождалась ответа хоста (повтор молча пропущен: двойной клик, идёт ход): кнопки
 * снова доступны. Закрытая или заменённая карточка (пришла история, начался ход) — ничего не меняет.
 */
export function unmarkRetrying(s: ChatState): ChatState {
  const i = lastIndex(s.rows, (r) => r.kind === 'fail' && r.state === 'retrying');
  if (i < 0) return s;
  return replaceAt(s, i, { ...(s.rows[i] as FailCard), state: 'open' });
}

function findCard(s: ChatState, toolUseId: string): number {
  return s.rows.findIndex(
    (r) =>
      (r.kind === 'perm' || r.kind === 'question' || r.kind === 'plan') &&
      r.toolUseId === toolUseId,
  );
}

function insertAfter(s: ChatState, index: number, row: DistributiveOmit<FeedRow, 'id'>): ChatState {
  const rows = s.rows.slice();
  rows.splice(index + 1, 0, { ...row, id: s.nextId } as FeedRow);
  return { ...s, rows, nextId: s.nextId + 1 };
}

/**
 * Запрос закрыт. Разрешение: карточка снимается, на её месте — строка итога для «отклонено» и
 * «всегда» (простое «разрешить» видно по строке инструмента). Вопрос и план остаются в ленте
 * отвеченными, итог — строкой под ними. Отмена движком (`abort`) итоговых строк не даёт.
 */
function resolveCard(
  s: ChatState,
  e: Extract<AgentEvent, { type: 'permission.resolved' }>,
  now: number,
): ChatState {
  const i = findCard(s, e.toolUseId);
  if (i < 0) return s;
  const card = s.rows[i] as Card;
  const at = clock(now);
  const byUser = e.by === 'user';
  switch (card.kind) {
    case 'perm': {
      const decision: PermissionDecision =
        e.decision === 'deny' ? 'deny' : card.sent && card.sent !== 'deny' ? card.sent : 'allow';
      const summary = byUser ? permissionSummary(card, decision) : undefined;
      if (!summary) return { ...s, rows: s.rows.filter((_, k) => k !== i) };
      return replaceAt(s, i, { ...summary, id: card.id, at } as FeedRow);
    }
    case 'question': {
      if (!byUser) return replaceAt(s, i, { ...card, state: 'cancelled' });
      if (e.decision === 'deny') {
        const out = replaceAt(s, i, { ...card, state: 'declined' });
        return insertAfter(out, i, { kind: 'sys', text: [ui.sys.questionDeclined], at });
      }
      const out = replaceAt(s, i, { ...card, state: 'answered' });
      return insertAfter(out, i, { kind: 'sys', text: answerSummary(card), at });
    }
    case 'plan': {
      if (!byUser) return replaceAt(s, i, { ...card, state: 'cancelled' });
      const choice: PlanChoice =
        e.decision === 'allow'
          ? card.choice === 'run-edits'
            ? 'run-edits'
            : 'run'
          : card.choice === 'refine'
            ? 'refine'
            : 'reject';
      const out = replaceAt(s, i, { ...card, state: 'done', choice });
      const text =
        ui.sys.plan[choice] + (choice === 'refine' && card.feedback ? `: ${card.feedback}` : '');
      return insertAfter(out, i, {
        kind: 'sys',
        ...(choice === 'reject'
          ? { tone: 'bad' as const }
          : choice === 'refine'
            ? {}
            : { tone: 'ok' as const }),
        text: [text],
        at,
      });
    }
  }
}

function permissionSummary(
  card: PermCard,
  decision: PermissionDecision,
): DistributiveOmit<FeedRow, 'id'> | undefined {
  const what = permissionSubject(card);
  if (decision === 'deny')
    return { kind: 'sys', tone: 'bad', text: [ui.sys.denied, { code: what }] };
  if (decision === 'allow-always' && card.always) {
    const rules = card.always.rules.join(', ');
    const where = ui.cards.destination(card.always.destination);
    if (rules) return { kind: 'sys', text: [ui.sys.alwaysRule, { code: rules }, ` → ${where}`] };
  }
  return undefined;
}

/** Что просили разрешить — одной строкой: команда, файл, иначе имя инструмента. */
export function permissionSubject(
  card: Pick<PermCard, 'toolName' | 'input' | 'description'>,
): string {
  const cmd = card.input['command'];
  if (typeof cmd === 'string' && cmd) return cmd.split('\n', 1)[0]!;
  const file = card.input['file_path'];
  if (typeof file === 'string' && file) return file.split('/').pop() || file;
  return card.description || card.toolName;
}

/** Ответы на `AskUserQuestion`: вопрос → метка; несколько меток — через запятую; свой ответ — текстом. */
export function answersOf(card: QuestionCard): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of card.questions) {
    const custom = card.custom[q.question];
    const picks = card.picks[q.question] ?? [];
    const value = custom ?? picks.join(', ');
    if (value) out[q.question] = value;
  }
  return out;
}

/** Все вопросы карточки отвечены — можно отправлять. */
export function questionReady(card: QuestionCard): boolean {
  return card.questions.every(
    (q) => (card.custom[q.question] ?? '') !== '' || (card.picks[q.question]?.length ?? 0) > 0,
  );
}

/** «выбран вариант 2», «выбраны варианты 1, 3», «свой ответ: …»; у нескольких вопросов — с заголовком. */
export function answerSummary(card: QuestionCard): Seg[] {
  const parts = card.questions.map((q) => {
    const custom = card.custom[q.question];
    let text: string;
    if (custom !== undefined) text = ui.sys.customAnswer(custom);
    else {
      const nums = (card.picks[q.question] ?? [])
        .map((label) => q.options.findIndex((o) => o.label === label) + 1)
        .filter((n) => n > 0);
      text = ui.sys.picked(nums);
    }
    return card.questions.length > 1 ? `${q.header ?? q.question}: ${text}` : text;
  });
  return [parts.join(' · ')];
}

/** Карточка, которой адресованы Enter/Esc/цифры: первая ждущая разрешения или вопроса. */
export function activeCard(s: ChatState): PermCard | QuestionCard | undefined {
  for (const r of s.rows) {
    if (r.kind === 'perm' && !r.sent) return r;
    if (r.kind === 'question' && r.state === 'pending') return r;
  }
  return undefined;
}

/** Ждущая решения карточка плана. */
export function pendingPlan(s: ChatState): PlanCard | undefined {
  return s.rows.find((r): r is PlanCard => r.kind === 'plan' && r.state === 'pending');
}

function updateCard<K extends Card['kind']>(
  s: ChatState,
  toolUseId: string,
  kind: K,
  f: (c: Extract<Card, { kind: K }>) => Extract<Card, { kind: K }>,
): ChatState {
  const i = findCard(s, toolUseId);
  if (i < 0 || s.rows[i]!.kind !== kind) return s;
  return replaceAt(s, i, f(s.rows[i] as Extract<Card, { kind: K }>));
}

/** Кнопка разрешения нажата: ответ ушёл, кнопки гаснут до `permission.resolved`. */
export function markPermission(
  s: ChatState,
  toolUseId: string,
  decision: PermissionDecision,
): ChatState {
  return updateCard(s, toolUseId, 'perm', (c) => (c.sent ? c : { ...c, sent: decision }));
}

/** Превью ханков от хоста. */
export function attachPreview(s: ChatState, toolUseId: string, preview: EditPreview): ChatState {
  return updateCard(s, toolUseId, 'perm', (c) => ({ ...c, preview }));
}

/** Выбор варианта: одиночный — заменяет, множественный — переключает; снимает свой ответ. */
export function pickOption(
  s: ChatState,
  toolUseId: string,
  question: string,
  label: string,
): ChatState {
  return updateCard(s, toolUseId, 'question', (c) => {
    if (c.state !== 'pending') return c;
    const q = c.questions.find((x) => x.question === question);
    if (!q) return c;
    const cur = c.picks[question] ?? [];
    const next = q.multiSelect
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label];
    const { [question]: _drop, ...custom } = c.custom;
    void _drop;
    return { ...c, picks: { ...c.picks, [question]: next }, custom };
  });
}

/** Свой ответ из поля ввода. */
export function setCustomAnswer(
  s: ChatState,
  toolUseId: string,
  question: string,
  text: string,
): ChatState {
  return updateCard(s, toolUseId, 'question', (c) =>
    c.state !== 'pending'
      ? c
      : { ...c, custom: { ...c.custom, [question]: text }, picks: { ...c.picks, [question]: [] } },
  );
}

export function markQuestionSent(s: ChatState, toolUseId: string): ChatState {
  return updateCard(s, toolUseId, 'question', (c) =>
    c.state === 'pending' ? { ...c, state: 'sent' } : c,
  );
}

export function markPlan(
  s: ChatState,
  toolUseId: string,
  choice: PlanChoice,
  feedback?: string,
): ChatState {
  return updateCard(s, toolUseId, 'plan', (c) =>
    c.state !== 'pending' ? c : { ...c, state: 'sent', choice, ...(feedback ? { feedback } : {}) },
  );
}

function compactionText(e: Extract<AgentEvent, { type: 'compaction.end' }>, now: number): Seg[] {
  const how = e.trigger === 'auto' ? ui.sys.compactedAuto : ui.sys.compactedManual;
  if (e.preTokens === undefined) return [`${clock(now)} · ${how}`];
  const range =
    e.postTokens !== undefined
      ? `${formatInt(e.preTokens)} → ${formatInt(e.postTokens)}`
      : formatInt(e.preTokens);
  return [`${clock(now)} · ${how}: `, { b: range }, ui.sys.tokensSuffix];
}
