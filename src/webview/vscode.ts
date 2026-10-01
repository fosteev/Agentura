import { postToHost, type FromWebview, type ToWebview, type VsCodeApiLike } from '../protocol';

declare function acquireVsCodeApi(): VsCodeApiLike;

let api: VsCodeApiLike | undefined;

/** `acquireVsCodeApi()` можно вызвать один раз — кэшируем. Вне VS Code (тесты, браузер) — заглушка. */
export function host(): VsCodeApiLike {
  if (!api) {
    api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} };
  }
  return api;
}

export function send(message: FromWebview): void {
  postToHost(host(), message);
}

/** Запомнить id сессии вкладки: по нему сериализатор панели возобновит её после перезагрузки окна. */
export function persistSession(sessionId: string): void {
  try {
    host().setState?.({ sessionId });
  } catch {
    // состояние необязательно: без него вкладка откроется пустой
  }
}

/**
 * Вкладка бросила сессию (новая, `/clear`, сброс хостом): забыть id, иначе после перезагрузки окна
 * сериализатор воскресит брошенную сессию (а она могла быть уже открыта в другой вкладке).
 */
export function forgetSession(): void {
  try {
    host().setState?.({});
  } catch {
    // состояние необязательно
  }
}

/** Сообщения от хоста; возвращает отписку. */
export function onHostMessage(handler: (message: ToWebview) => void): () => void {
  const listener = (e: MessageEvent<ToWebview>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
