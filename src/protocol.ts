/**
 * Протокол extension ↔ webview. События агента — `AgentEvent` из `src/agent/types.ts` (этап 2):
 * webview получает их как есть в сообщении `agent.event`.
 */
import type {
  AgentEvent,
  CommandOption,
  LimitWindow,
  ModelOption,
  PermissionDecision,
  PermissionMode,
} from './agent/types';
import type { Attachment, FileHit } from './shared/prompt';

export type {
  AgentEvent,
  Attachment,
  CommandOption,
  FileHit,
  ModelOption,
  PermissionDecision,
  PermissionMode,
};

/** Открытый файл и выделение активного редактора (автоконтекст, B3). */
export interface EditorContext {
  file?: { path: string; name: string };
  selection?: { path: string; name: string; startLine: number; endLine: number };
}

/**
 * Имена событий агента. Список этапа 1 плюс три события, добавленных на этапе 2 (записаны в
 * roadmap, «Решения по итогам сессии 2»): `session.title`, `permission.resolved`, `session.closed`.
 */
export const AGENT_EVENT_TYPES = [
  'session.init',
  'session.title', // этап 2: system/session_title_changed — название для заголовка и списка сессий
  'turn.start',
  'text.delta',
  'thinking.start',
  'thinking.delta',
  'thinking.stop',
  'tool.start',
  'tool.progress',
  'tool.result',
  'permission.request',
  'question.request',
  'plan.request',
  'permission.resolved', // этап 2: запрос закрыт (ответ или отмена движком) — снять карточку
  'usage.message',
  'context.usage',
  'turn.result',
  'compaction.start',
  'compaction.end',
  'agent.start',
  'agent.progress',
  'agent.end',
  'limit.update',
  'mode.changed',
  'session.closed', // этап 2 (приёмка): движок завершился / сессия закрыта — последнее событие потока
  'error',
] as const satisfies readonly AgentEvent['type'][];

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// Список и union совпадают: новое событие без записи в список не соберётся.
type MissingEventType = Exclude<AgentEvent['type'], AgentEventType>;
const _allEventTypesListed: MissingEventType extends never ? true : MissingEventType = true;
void _allEventTypesListed;

/**
 * Extension → webview.
 *
 * Этап 3 добавил: `chat.info`, `capabilities`, `editor.context`, `files.result`, `attach.picked`,
 * `session.reset` (записаны в roadmap, «Решения по итогам сессии 3»). Одна вкладка чата = одна
 * сессия: `sessionId` в сообщениях webview → хост информативен, хост направляет сообщение в
 * текущую сессию вкладки (до первого `session.init` id ещё пуст).
 */
export type ToWebview =
  | { type: 'init'; surface: 'chat' | 'sidebar'; version: string }
  | { type: 'agent.event'; sessionId: string; event: AgentEvent }
  | {
      type: 'chat.info';
      /** Имя папки воркспейса и путь к ней. */
      project: string;
      cwd: string;
      allowBypass: boolean;
    }
  | { type: 'capabilities'; sessionId: string; models: ModelOption[]; commands: CommandOption[] }
  | ({ type: 'editor.context' } & EditorContext)
  | { type: 'files.result'; requestId: number; items: FileHit[] }
  | { type: 'attach.picked'; items: FileHit[] }
  /** Начата новая сессия (команда, `/clear`, `new`): очистить ленту. */
  | { type: 'session.reset' }
  | { type: 'sessions.update'; sessions: SessionSummary[] }
  | {
      type: 'limits.update';
      windows: LimitWindowSummary[];
      /** Когда данные получены от источника (мс); при кулдауне — время прошлого запроса. */
      updatedAt: number;
      error?: string;
    };

/**
 * Webview → extension. Этап 3 добавил `files.find`, `attach.pick`, `sessions.show`, `diff.open` и
 * поле `attachments` у `send` (roadmap, «Решения по итогам сессии 3»). `diff.open` пока только
 * пишется в журнал — открытие диффа на этапе 5.
 */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string; attachments?: Attachment[] }
  | { type: 'files.find'; requestId: number; query: string }
  | { type: 'attach.pick' }
  | { type: 'sessions.show' }
  | { type: 'diff.open'; sessionId: string; toolUseId: string }
  | { type: 'interrupt'; sessionId: string }
  | {
      type: 'permission.respond';
      sessionId: string;
      toolUseId: string;
      decision: PermissionDecision;
    }
  | {
      type: 'question.answer';
      sessionId: string;
      toolUseId: string;
      answers: Record<string, string>;
    }
  | { type: 'plan.decide'; sessionId: string; toolUseId: string; approve: boolean }
  | { type: 'mode.set'; sessionId: string; mode: PermissionMode }
  | { type: 'model.set'; sessionId: string; model: string }
  | { type: 'effort.set'; sessionId: string; effort: string }
  | { type: 'compact'; sessionId: string }
  | { type: 'agent.stop'; sessionId: string; taskId: string }
  | { type: 'session.new' }
  | { type: 'limits.refresh' }
  | { type: 'session.resume'; sessionId: string };

export interface SessionSummary {
  id: string;
  title: string;
  turns: number;
  /** Нет — стоимость неизвестна (модель без цены), показывать «—», не $0. */
  costUsd?: number;
  /** Оценка без части запросов (модели без цены) — показывать с пометкой. */
  costPartial?: boolean;
  state: 'idle' | 'live' | 'waiting' | 'error' | 'limit';
  updatedAt: number;
}

/** Окно лимита: `kind`, проценты 0…100, сброс в мс. */
export type LimitWindowSummary = LimitWindow;

const FROM_WEBVIEW_TYPES: ReadonlySet<string> = new Set<FromWebview['type']>([
  'ready',
  'send',
  'files.find',
  'attach.pick',
  'sessions.show',
  'diff.open',
  'interrupt',
  'permission.respond',
  'question.answer',
  'plan.decide',
  'mode.set',
  'model.set',
  'effort.set',
  'compact',
  'agent.stop',
  'session.new',
  'limits.refresh',
  'session.resume',
]);

/** Проверка входящего от webview сообщения: снаружи приходит `unknown`. */
export function isFromWebview(value: unknown): value is FromWebview {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && FROM_WEBVIEW_TYPES.has(type);
}

/** Минимум от `vscode.Webview`, нужный для отправки; позволяет тестировать без vscode. */
export interface WebviewLike {
  postMessage(message: unknown): Thenable<boolean> | Promise<boolean>;
}

export function postToWebview(webview: WebviewLike, message: ToWebview): void {
  void webview.postMessage(message);
}

/** Минимум от `acquireVsCodeApi()`. */
export interface VsCodeApiLike {
  postMessage(message: unknown): void;
}

export function postToHost(api: VsCodeApiLike, message: FromWebview): void {
  api.postMessage(message);
}
