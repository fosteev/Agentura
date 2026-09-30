/**
 * Протокол extension ↔ webview. Типы и заглушки под события этапа 2:
 * полный `AgentEvent` появится в `src/agent/types.ts`, здесь — имена и форма полезной нагрузки
 * в объёме, нужном, чтобы webview не менялся при подключении адаптера.
 */

/** Имена событий агента (этап 2). Нагрузка пока не типизирована. */
export const AGENT_EVENT_TYPES = [
  'session.init',
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
  'error',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** Заглушка события агента; уточняется на этапе 2. */
export interface AgentEventStub {
  type: AgentEventType;
  /** Субагент, если событие пришло не от основного агента. */
  agentId?: string;
  payload?: unknown;
}

export type PermissionDecision = 'allow' | 'allow-always' | 'deny';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** Extension → webview. */
export type ToWebview =
  | { type: 'init'; surface: 'chat' | 'sidebar'; version: string }
  | { type: 'agent.event'; sessionId: string; event: AgentEventStub }
  | { type: 'sessions.update'; sessions: SessionSummary[] }
  | {
      type: 'limits.update';
      windows: LimitWindowSummary[];
      /** Когда данные получены от источника (мс); при кулдауне — время прошлого запроса. */
      updatedAt: number;
      error?: string;
    };

/** Webview → extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string }
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
  costUsd: number;
  state: 'idle' | 'live' | 'waiting' | 'error' | 'limit';
  updatedAt: number;
}

export interface LimitWindowSummary {
  kind: 'five-hour' | 'weekly';
  percent: number;
  resetsAt: number;
}

const FROM_WEBVIEW_TYPES: ReadonlySet<string> = new Set<FromWebview['type']>([
  'ready',
  'send',
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
