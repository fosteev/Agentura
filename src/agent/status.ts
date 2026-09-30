import type { AgentEvent } from './types';

/** Состояние чата: одно на сессию, общее для ленты (webview) и маркера во вкладке (хост). */
export type ChatStatus = 'idle' | 'working' | 'waiting' | 'error' | 'limited';

/**
 * Переход состояния по событию основного агента. События субагентов состояние не меняют.
 * `limited` держится до следующего `turn.start`: лимит упёрся — «работа» в этот момент неправда.
 */
export function nextStatus(prev: ChatStatus, event: AgentEvent): ChatStatus {
  if (event.agentId) return prev;
  switch (event.type) {
    case 'turn.start':
      return 'working';
    case 'permission.request':
    case 'question.request':
    case 'plan.request':
      return 'waiting';
    case 'permission.resolved':
      return prev === 'waiting' ? 'working' : prev;
    case 'turn.result':
      if (prev === 'limited' || prev === 'error') return prev;
      return 'idle';
    case 'limit.update':
      return event.status === 'rejected' ? 'limited' : prev;
    case 'error':
      if (event.code === 'limit') return 'limited';
      // повтор запроса движком — ход продолжается, «!» во вкладке был бы ложной тревогой
      if (event.code === 'api_retry') return prev;
      return 'error';
    case 'session.closed':
      return event.reason === 'error' ? 'error' : prev === 'working' ? 'idle' : prev;
    default:
      return prev;
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
