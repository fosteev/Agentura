/** Стор чата webview на сигналах: состояние ленты, контекст редактора, поле ввода. */
import { computed, signal } from '@preact/signals';
import type {
  AgentEvent,
  CommandOption,
  EffortLevel,
  ModelOption,
  PermissionDecision,
  PermissionMode,
} from '../agent/types';
import { attachmentKey, type Attachment, type FileHit } from '../shared/prompt';
import type {
  EditorContext,
  LimitWindowSummary,
  PlanChoice,
  SessionSummary,
  ToWebview,
} from '../protocol';
import {
  addSys,
  answersOf,
  applyEvent,
  attachPreview,
  initialState,
  markPermission,
  markPlan,
  markRetrying,
  markQuestionSent,
  pickOption,
  queueUser,
  questionReady,
  resetSession,
  seedHistory,
  setCustomAnswer,
  type ChatState,
  type QuestionCard,
} from './chatState';
import { pushHistory } from './composer';
import { applyHud, initialHud, resetHud, type HudState } from './hudState';
import { cacheView, contextView, limitsView } from './hudView';
import { limitBlock, type LimitBlock } from './limitView';
import { ui } from './strings';
import { shortModel } from './toolView';
import { forgetSession, persistSession, send } from './vscode';

export const chat = signal<ChatState>(initialState());
/** Агрегаты приборов: контекст, кэш, итоги сессии, таймлайн хода, агенты (`hudState.ts`). */
export const hudState = signal<HudState>(initialHud());
/** Лимиты подписки от хоста (`limits.update`); `updatedAt: 0` — ещё не получены. */
export const limits = signal<{
  windows: LimitWindowSummary[];
  updatedAt: number;
  error?: string;
}>({ windows: [], updatedAt: 0 });
export const capabilities = signal<{ models: ModelOption[]; commands: CommandOption[] }>({
  models: [],
  commands: [],
});
export const editor = signal<EditorContext>({});
export const recent = signal<SessionSummary[]>([]);
/** Сессия активной вкладки (`sessions.update.current`) — строка `cur` в списках. */
export const currentSession = signal<string | undefined>(undefined);
/** Ключи автоконтекста, снятые крестиком. */
export const dismissed = signal<ReadonlySet<string>>(new Set());
/** Чипы, добавленные через «@»/«+». */
export const extra = signal<Attachment[]>([]);
export const autoFile = signal(true);
export const autoSelection = signal(true);
export const showThinking = signal(true);
export const history = signal<string[]>([]);
export const fileHits = signal<{ requestId: number; items: FileHit[] }>({
  requestId: 0,
  items: [],
});
/**
 * Куда уйдёт следующий текст поля ввода (этап 5): свой ответ на вопрос агента или доработка
 * плана — вместо сообщения агенту.
 */
export type ReplyTarget =
  { kind: 'question'; toolUseId: string; question: string } | { kind: 'plan'; toolUseId: string };
export const replyTarget = signal<ReplyTarget | undefined>(undefined);

/** Тик раз в секунду, пока идёт ход: таймеры в ленте. */
export const tick = signal(Date.now());

/** Сброс окна подписки, блокировку по которому человек снял «Попробовать снова» (данные могли устареть). */
const limitDismissed = signal<number | undefined>(undefined);

/**
 * Отправка заблокирована лимитом (этап 7): своя сессия упёрлась или окно подписки на 100 % со сбросом в
 * будущем — общий на аккаунт `limits.update` доходит до всех вкладок. Пересчитывается секундным тиком.
 */
export const limitBlocked = computed<LimitBlock | undefined>(() =>
  limitBlock(
    {
      status: chat.value.status,
      resetsAt: chat.value.limitResetsAt,
      windows: limits.value.windows,
      dismissed: limitDismissed.value,
    },
    tick.value,
  ),
);

/** Значения приборов у поля ввода: пересчитываются по событиям и по секундному тику. */
export const meters = computed(() => {
  const now = tick.value;
  const h = hudState.value;
  return {
    context: contextView(h),
    cache: cacheView(h, now),
    limits: limitsView(limits.value.windows, now),
  };
});

/**
 * Сессия, которую webview уже бросил (`session.new`/`session.reset`): её события, успевшие уйти
 * от хоста до закрытия, не должны попасть в ленту и приборы новой.
 */
let abandonedSessionId: string | undefined;

function abandonSession(): void {
  if (chat.value.sessionId) abandonedSessionId = chat.value.sessionId;
  forgetSession();
}

export function handleHostMessage(m: ToWebview): void {
  switch (m.type) {
    case 'agent.event':
      if (abandonedSessionId !== undefined && m.sessionId === abandonedSessionId) break;
      // новая сессия поднялась — фильтр больше не нужен; возобновление той же сессии снимает его на
      // `session.history` (иначе её `init` отфильтровался бы как событие брошенной)
      if (m.event.type === 'session.init') {
        abandonedSessionId = undefined;
        persistSession(m.event.sessionId);
      }
      dispatchEvent(m.event);
      break;
    case 'session.history': {
      // хост шлёт историю строго после всех событий прежней сессии: брошенных «хвостов» больше не будет
      abandonedSessionId = undefined;
      replyTarget.value = undefined;
      extra.value = [];
      const now = Date.now();
      chat.value = seedHistory(chat.value, m, m.events, now);
      let hud = resetHud(hudState.value);
      for (const e of m.events) hud = applyHud(hud, e, now);
      hudState.value = hud;
      persistSession(m.sessionId);
      break;
    }
    case 'chat.command':
      if (m.name === 'status') showStatus();
      break;
    case 'chat.info':
      chat.value = { ...chat.value, project: m.project, cwd: m.cwd, allowBypass: m.allowBypass };
      if (m.contextThresholds?.length) {
        hudState.value = { ...hudState.value, thresholds: [...m.contextThresholds] };
      }
      break;
    case 'limits.update':
      limits.value = {
        // ошибка опроса без окон не стирает прежние проценты
        windows: m.windows.length || !m.error ? m.windows : limits.value.windows,
        updatedAt: m.updatedAt,
        ...(m.error ? { error: m.error } : {}),
      };
      break;
    case 'capabilities':
      capabilities.value = { models: m.models, commands: m.commands };
      break;
    case 'editor.context':
      editor.value = {
        ...(m.file ? { file: m.file } : {}),
        ...(m.selection ? { selection: m.selection } : {}),
      };
      break;
    case 'files.result':
      // ответы на поиск могут прийти не по порядку — устаревший не затирает свежий
      if (m.requestId >= fileHits.value.requestId) {
        fileHits.value = { requestId: m.requestId, items: m.items };
      }
      break;
    case 'attach.picked':
      for (const hit of m.items) addExtra({ kind: hit.isDir ? 'folder' : 'file', path: hit.path });
      break;
    case 'sessions.update':
      recent.value = m.sessions;
      currentSession.value = m.current;
      break;
    case 'diff.preview':
      if (abandonedSessionId !== undefined && m.sessionId === abandonedSessionId) break;
      chat.value = attachPreview(chat.value, m.toolUseId, m.preview);
      break;
    case 'session.reset':
      abandonSession();
      replyTarget.value = undefined;
      chat.value = resetSession(chat.value);
      hudState.value = resetHud(hudState.value);
      extra.value = [];
      break;
    default:
      break;
  }
}

export function dispatchEvent(event: AgentEvent, now = Date.now()): void {
  chat.value = applyEvent(chat.value, event, now);
  // карточка, которой адресован ответ из поля, закрыта (ответ, отмена движком) — поле снова обычное
  const t = replyTarget.value;
  if (t && event.type === 'permission.resolved' && event.toolUseId === t.toolUseId) {
    replyTarget.value = undefined;
  }
  hudState.value = applyHud(hudState.value, event, now);
  // лимит от движка — запас, пока хост не прислал данные `/api/oauth/usage`
  if (event.type === 'limit.update' && !event.agentId && limits.value.updatedAt === 0) {
    limits.value = { windows: event.windows, updatedAt: now };
  }
}

/** `/status` — строка в ленту: модель, режим, папка (из поля ввода и из боковой панели). */
export function showStatus(): void {
  const st = chat.value;
  chat.value = addSys(st, [
    ui.sys.status(st.model ? shortModel(st.model) : '—', ui.modes[st.mode]?.[0] ?? st.mode, st.cwd),
  ]);
}

export function compact(): void {
  send({ type: 'compact', sessionId: chat.value.sessionId });
}

export function stopAgent(taskId: string): void {
  send({ type: 'agent.stop', sessionId: chat.value.sessionId, taskId });
}

export function addExtra(a: Attachment): void {
  if (extra.value.some((x) => attachmentKey(x) === attachmentKey(a))) return;
  extra.value = [...extra.value, a];
}

export function removeExtra(key: string): void {
  extra.value = extra.value.filter((x) => attachmentKey(x) !== key);
}

export function dismiss(key: string): void {
  dismissed.value = new Set([...dismissed.value, key]);
}

/** Автоконтекст в виде вложений: открытый файл и выделение минус снятое и выключенное. */
export function autoAttachments(
  ctx: EditorContext,
  flags: { file: boolean; selection: boolean },
  skip: ReadonlySet<string>,
): Attachment[] {
  const out: Attachment[] = [];
  if (flags.file && ctx.file) out.push({ kind: 'file', path: ctx.file.path });
  if (flags.selection && ctx.selection) {
    out.push({
      kind: 'selection',
      path: ctx.selection.path,
      startLine: ctx.selection.startLine,
      endLine: ctx.selection.endLine,
    });
  }
  return out.filter((a) => !skip.has(attachmentKey(a)));
}

export function currentAttachments(): Attachment[] {
  const auto = autoAttachments(
    editor.value,
    { file: autoFile.value, selection: autoSelection.value },
    dismissed.value,
  );
  const autoKeys = new Set(auto.map(attachmentKey));
  return [...auto, ...extra.value.filter((x) => !autoKeys.has(attachmentKey(x)))];
}

export function sendMessage(text: string, withContext = true): boolean {
  const s = chat.value;
  if (s.closed) return false;
  const attachments = withContext ? currentAttachments() : [];
  chat.value = queueUser(s, text);
  history.value = pushHistory(history.value, text);
  extra.value = [];
  send({
    type: 'send',
    sessionId: s.sessionId,
    text,
    ...(attachments.length ? { attachments } : {}),
  });
  return true;
}

export function interrupt(): void {
  send({ type: 'interrupt', sessionId: chat.value.sessionId });
}

export function setMode(mode: PermissionMode): void {
  chat.value = { ...chat.value, mode };
  send({ type: 'mode.set', sessionId: chat.value.sessionId, mode });
}

export function setModel(model: string): void {
  chat.value = { ...chat.value, model };
  send({ type: 'model.set', sessionId: chat.value.sessionId, model });
}

export function setEffort(effort: EffortLevel): void {
  chat.value = { ...chat.value, effort };
  send({ type: 'effort.set', sessionId: chat.value.sessionId, effort });
}

function questionCard(toolUseId: string): QuestionCard | undefined {
  return chat.value.rows.find(
    (r): r is QuestionCard => r.kind === 'question' && r.toolUseId === toolUseId,
  );
}

/** Кнопка карточки разрешения. */
export function respondPermission(toolUseId: string, decision: PermissionDecision): void {
  const card = chat.value.rows.find((r) => r.kind === 'perm' && r.toolUseId === toolUseId);
  if (!card || (card.kind === 'perm' && card.sent)) return;
  chat.value = markPermission(chat.value, toolUseId, decision);
  send({ type: 'permission.respond', sessionId: chat.value.sessionId, toolUseId, decision });
}

/** Вариант ответа: один вопрос с одним выбором — ответ уходит сразу, иначе — кнопка «Ответить». */
export function chooseOption(toolUseId: string, question: string, label: string): void {
  chat.value = pickOption(chat.value, toolUseId, question, label);
  const t = replyTarget.value;
  if (t?.kind === 'question' && t.toolUseId === toolUseId && t.question === question) {
    replyTarget.value = undefined;
  }
  const card = questionCard(toolUseId);
  if (card && card.questions.length === 1 && !card.questions[0]!.multiSelect) {
    submitQuestion(toolUseId);
  }
}

/** «Свой вариант»: следующий текст поля ввода станет ответом на этот вопрос. */
export function replyToQuestion(toolUseId: string, question: string): void {
  replyTarget.value = { kind: 'question', toolUseId, question };
}

export function submitQuestion(toolUseId: string): void {
  const card = questionCard(toolUseId);
  if (!card || card.state !== 'pending' || !questionReady(card)) return;
  const answers = answersOf(card);
  chat.value = markQuestionSent(chat.value, toolUseId);
  if (replyTarget.value?.toolUseId === toolUseId) replyTarget.value = undefined;
  send({ type: 'question.answer', sessionId: chat.value.sessionId, toolUseId, answers });
}

/** Esc / «Отклонить» на вопросе: отказ, модель продолжит без ответа. */
export function declineQuestion(toolUseId: string): void {
  const card = questionCard(toolUseId);
  if (!card || card.state !== 'pending') return;
  chat.value = markQuestionSent(chat.value, toolUseId);
  if (replyTarget.value?.toolUseId === toolUseId) replyTarget.value = undefined;
  send({
    type: 'permission.respond',
    sessionId: chat.value.sessionId,
    toolUseId,
    decision: 'deny',
  });
}

/** Кнопка плана. «Доработать» без текста — ждём его из поля ввода. */
export function decidePlan(toolUseId: string, choice: PlanChoice, feedback?: string): void {
  const card = chat.value.rows.find((r) => r.kind === 'plan' && r.toolUseId === toolUseId);
  if (!card || card.kind !== 'plan' || card.state !== 'pending') return;
  const text = feedback?.trim();
  if (choice === 'refine' && !text) {
    replyTarget.value = { kind: 'plan', toolUseId };
    return;
  }
  chat.value = markPlan(chat.value, toolUseId, choice, text);
  if (replyTarget.value?.toolUseId === toolUseId) replyTarget.value = undefined;
  send({
    type: 'plan.decide',
    sessionId: chat.value.sessionId,
    toolUseId,
    decision: choice,
    ...(choice === 'refine' && text ? { feedback: text } : {}),
  });
}

/** Текст поля ввода при `replyTarget`: ответ карточке вместо сообщения. `false` — цели нет. */
export function submitReply(text: string): boolean {
  const t = replyTarget.value;
  if (!t) return false;
  if (t.kind === 'plan') {
    decidePlan(t.toolUseId, 'refine', text);
    return true;
  }
  chat.value = setCustomAnswer(chat.value, t.toolUseId, t.question, text);
  replyTarget.value = undefined;
  const card = questionCard(t.toolUseId);
  if (card && card.questions.length === 1) submitQuestion(t.toolUseId);
  return true;
}

/** «Повторить ход» на карточке ошибки: хост возобновляет сессию и отправляет промпт ещё раз. */
export function retryTurn(): void {
  const card = [...chat.value.rows].reverse().find((r) => r.kind === 'fail' && r.state === 'open');
  const turn = card?.kind === 'fail' && card.turn;
  chat.value = markRetrying(chat.value);
  send({ type: 'turn.retry', sessionId: chat.value.sessionId, turn });
}

export function showLog(): void {
  send({ type: 'log.show' });
}

/**
 * «Попробовать снова» в баннере лимита: блокировка по своему ходу снимается (лимит мог сброситься,
 * время сброса хост не знал), блокировка по данным подписки — для этого сброса окна (данные могли
 * устареть, или расход докуплен). Не так — движок откажет и блокировка вернётся по его ответу.
 */
export function releaseLimit(): void {
  const b = limitBlocked.value;
  if (b?.soft && b.until !== undefined) limitDismissed.value = b.until;
  const { limitResetsAt: _l, ...rest } = chat.value;
  void _l;
  chat.value = rest.status === 'limited' ? { ...rest, status: 'idle' } : rest;
  send({ type: 'limits.refresh' });
}

export function newSession(): void {
  replyTarget.value = undefined;
  abandonSession();
  chat.value = resetSession(chat.value);
  hudState.value = resetHud(hudState.value);
  extra.value = [];
  send({ type: 'session.new' });
}
