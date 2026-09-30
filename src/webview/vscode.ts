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

/** Сообщения от хоста; возвращает отписку. */
export function onHostMessage(handler: (message: ToWebview) => void): () => void {
  const listener = (e: MessageEvent<ToWebview>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
