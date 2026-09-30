import type { AgentEvent } from './types';

/** Состояние чата: одно на сессию, общее для ленты (webview) и маркера во вкладке (хост). */
export type ChatStatus = 'idle' | 'working' | 'waiting' | 'error' | 'limited';

/**
 * Переход состояния по событию. События субагентов состояние не меняют — кроме запросов
 * разрешения, вопроса и плана: субагент ждёт человека так же, как основной агент.
 * `pending` — сколько запросов ещё ждут ответа *после* события (`updatePending`); пока есть
 * хоть один, состояние `waiting` (ответ на один из двух запросов не возвращает в `working`).
 * `limited` держится до следующего `turn.start`: лимит упёрся — «работа» в этот момент неправда.
 */
export function nextStatus(
  prev: ChatStatus,
  event: AgentEvent,
  pending = 0,
  inTurn = true,
): ChatStatus {
  switch (event.type) {
    case 'permission.request':
    case 'question.request':
    case 'plan.request':
      return 'waiting';
    case 'permission.resolved':
      if (pending > 0) return 'waiting';
      // запрос фонового субагента после конца хода: ответили — снова покой, а не «работа»
      return prev === 'waiting' ? (inTurn ? 'working' : 'idle') : prev;
    default:
      break;
  }
  if (event.agentId) return prev;
  switch (event.type) {
    case 'turn.start':
      return pending > 0 ? 'waiting' : 'working';
    case 'turn.result':
      if (prev === 'limited' || prev === 'error') return prev;
      return pending > 0 ? 'waiting' : 'idle';
    case 'limit.update':
      return event.status === 'rejected' ? 'limited' : prev;
    case 'error':
      if (event.code === 'limit') return 'limited';
      // повтор запроса движком — ход продолжается, «!» во вкладке был бы ложной тревогой
      if (event.code === 'api_retry') return prev;
      return 'error';
    case 'session.closed':
      return event.reason === 'error'
        ? 'error'
        : prev === 'working' || prev === 'waiting'
          ? 'idle'
          : prev;
    default:
      return prev;
  }
}

/**
 * Идёт ли ход основного агента после события: от `turn.start` до `turn.result` (или закрытия
 * сессии). Нужен `nextStatus`, чтобы после ответа на запрос субагента вернуться туда, где были.
 */
export function updateInTurn(inTurn: boolean, event: AgentEvent): boolean {
  if (event.type === 'session.closed') return false;
  if (event.agentId) return inTurn;
  if (event.type === 'turn.start') return true;
  if (event.type === 'turn.result') return false;
  return inTurn;
}

/** Id запросов (разрешение, вопрос, план), ждущих ответа, после события. */
export function updatePending(pending: readonly string[], event: AgentEvent): string[] {
  switch (event.type) {
    case 'permission.request':
    case 'question.request':
    case 'plan.request':
      return pending.includes(event.toolUseId) ? [...pending] : [...pending, event.toolUseId];
    case 'permission.resolved':
      return pending.filter((id) => id !== event.toolUseId);
    case 'session.closed':
      return [];
    default:
      return [...pending];
  }
}

/** Маркер состояния в заголовке вкладки (B1): ● работа, ? ждёт, ! ошибка или лимит. */
export function statusMarker(status: ChatStatus): string {
  switch (status) {
    case 'working':
      return '●';
    case 'waiting':
      return '?';
    case 'error':
    case 'limited':
      return '!';
    case 'idle':
      return '';
  }
}

export function tabTitle(status: ChatStatus, title?: string): string {
  const marker = statusMarker(status);
  const base = title ? `Agentura · ${title}` : 'Agentura';
  return marker ? `${marker} ${base}` : base;
}
