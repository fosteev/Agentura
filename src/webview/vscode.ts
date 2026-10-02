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

/** Состояние правой панели вкладки чата (широкий режим): свои значения у каждой вкладки. */
export interface PanelState {
  /** Ширина, px. */
  w?: number;
  /** Свёрнута в полосу. */
  off?: boolean;
  /** Активная вкладка панели. */
  tab?: 'turn' | 'agents';
}

/** Всё, что webview кладёт в `setState`: id сессии (для сериализатора) и панель. Поля независимы. */
export interface WebviewState {
  sessionId?: string;
  panel?: PanelState;
}

function readState(): WebviewState {
  try {
    const st = host().getState?.();
    return st && typeof st === 'object' ? (st as WebviewState) : {};
  } catch {
    return {};
  }
}

function writeState(state: WebviewState): void {
  try {
    host().setState?.(state);
  } catch {
    // состояние необязательно: без него вкладка откроется пустой, панель — со значениями по умолчанию
  }
}

/** Запомнить id сессии вкладки: по нему сериализатор панели возобновит её после перезагрузки окна. */
export function persistSession(sessionId: string): void {
  writeState({ ...readState(), sessionId });
}

/**
 * Вкладка бросила сессию (новая, `/clear`, сброс хостом): забыть id, иначе после перезагрузки окна
 * сериализатор воскресит брошенную сессию (а она могла быть уже открыта в другой вкладке).
 * Состояние панели остаётся: ширина и вид панели принадлежат вкладке, а не сессии.
 */
export function forgetSession(): void {
  const st = readState();
  writeState(st.panel ? { panel: st.panel } : {});
}

/**
 * Сохранённое состояние панели (пусто — значения по умолчанию). Состояние переживает обновления
 * расширения, поэтому чужие типы полей отбрасываются: кривое поле — как отсутствующее.
 */
export function readPanel(): PanelState {
  const p = readState().panel as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return {};
  const out: PanelState = {};
  if (typeof p.w === 'number' && Number.isFinite(p.w) && p.w > 0) out.w = p.w;
  if (typeof p.off === 'boolean') out.off = p.off;
  if (p.tab === 'turn' || p.tab === 'agents') out.tab = p.tab;
  return out;
}

/** Дописать поля в состояние панели, не трогая остальное состояние (в том числе `sessionId`). */
export function savePanel(patch: PanelState): void {
  writeState({ ...readState(), panel: { ...readPanel(), ...patch } });
}

/** Сообщения от хоста; возвращает отписку. */
export function onHostMessage(handler: (message: ToWebview) => void): () => void {
  const listener = (e: MessageEvent<ToWebview>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
