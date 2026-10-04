import type { FromWebview, ToWebview } from '../protocol';

/**
 * Связь вкладки графа агентов с её вкладкой чата (roadmap 11, этап 2) — без `vscode`, чтобы проверять
 * тестами. Данные — снимок `HudState` от webview чата (`agents.snapshot`), хост только пересылает.
 * Действия графа (`agent.stop`, `agent.transcript`) идут в контроллер своего чата и только для той сессии,
 * которую граф показывает.
 */

type Snapshot = Extract<FromWebview, { type: 'agents.snapshot' }>;

/** Вкладка чата, к которой привязан граф. */
export interface GraphChat {
  /** Текущая сессия вкладки (`ChatController.sessionId`). */
  sessionId(): string | undefined;
  /** Сообщение в webview чата. */
  post(m: ToWebview): void;
  /** Действие графа — тому же обработчику, что и сообщения webview чата. */
  handle(m: FromWebview): unknown;
}

export interface GraphLinkDeps {
  /** Сообщение в webview графа. */
  post(m: ToWebview): void;
  /** Название сессии из снимка (нет — у сессии пока нет названия): заголовок вкладки. */
  setTitle(sessionTitle: string | undefined): void;
  warn(m: string): void;
}

export class AgentsGraphLink {
  private chat: GraphChat | undefined;
  private last: Extract<ToWebview, { type: 'agents.snapshot' }> | undefined;
  /** Webview графа прислал `ready` (после пересоздания — снова). */
  private ready = false;
  /** Агент, которого выбрать, когда webview графа будет готов (одноразово). */
  private focus: string | undefined;
  private closed = false;

  constructor(
    private readonly deps: GraphLinkDeps,
    /** Вкладка графа видна: только тогда чат шлёт снимки. */
    private visible = true,
  ) {}

  /** Привязать к чату (сразу при открытии или после восстановления окна) и попросить снимок. */
  bind(chat: GraphChat): void {
    this.chat = chat;
    this.askChat();
  }

  get bound(): boolean {
    return this.chat !== undefined;
  }

  /**
   * Вкладку графа показали или скрыли. Скрытый граф снимков не получает (webview без
   * `retainContextWhenHidden` выгружается); показали — чат шлёт свежий.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible || this.closed) return;
    this.visible = visible;
    // скрытый webview выгружен: до его нового `ready` выбор агента и снимки копятся, а не уходят в пустоту
    if (!visible) this.ready = false;
    this.chat?.post({ type: 'agents.graph', open: visible });
  }

  /** Webview чата пересоздан (`ready`): он не знает, что граф открыт. */
  chatReady(): void {
    this.askChat();
  }

  /** Снимок от чата: запомнить (для пересозданного webview графа) и переслать. */
  snapshot(m: Snapshot): void {
    if (this.closed) return;
    // во вкладке чата сменилась сессия — выбор агента из прежней не переносим
    // (пустой id — webview чата ещё не знает сессию, например сразу после перезагрузки окна: не смена)
    if (m.sessionId && this.last?.sessionId && this.last.sessionId !== m.sessionId) this.focus = undefined;
    this.last = { type: 'agents.snapshot', sessionId: m.sessionId, graph: m.graph };
    this.deps.setTitle(m.graph.title);
    if (this.ready) this.deps.post(this.last);
  }

  /** Выбрать агента в графе (клик по агенту в ленте); webview не готов — когда будет готов. */
  focusAgent(agentId: string | undefined): void {
    if (!agentId || this.closed) return;
    this.focus = agentId;
    this.flushFocus();
  }

  /** Сообщение webview графа. */
  fromGraph(m: FromWebview): void {
    if (this.closed) return;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.last) this.deps.post(this.last);
        this.flushFocus();
        this.askChat();
        return;
      case 'agent.stop':
      case 'agent.transcript': {
        const current = this.chat?.sessionId();
        // граф мог показать прежнюю сессию вкладки (снимок новой ещё в пути) — чужой сессии не трогаем
        if (!this.chat || !m.sessionId || m.sessionId !== current) {
          this.deps.warn(
            `граф агентов: ${m.type} для сессии ${m.sessionId || '—'}, у чата ${current ?? '—'} — отброшено`,
          );
          return;
        }
        void Promise.resolve(this.chat.handle(m)).catch((e) =>
          this.deps.warn(`граф агентов: ${m.type}: ${String(e)}`),
        );
        return;
      }
      default:
        this.deps.warn(`граф агентов: ${m.type} не обрабатывается`);
    }
  }

  /** Вкладку графа закрыли: чат перестаёт слать снимки. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.chat?.post({ type: 'agents.graph', open: false });
  }

  private askChat(): void {
    if (this.chat && this.visible && !this.closed) this.chat.post({ type: 'agents.graph', open: true });
  }

  private flushFocus(): void {
    if (!this.ready || !this.focus) return;
    this.deps.post({ type: 'agents.focus', agentId: this.focus });
    this.focus = undefined;
  }
}

/**
 * Вкладки графа, восстановленные после перезагрузки окна раньше своей вкладки чата: ждут чат с той же
 * сессией. Не дождались — вкладку закрывает вызывающий (по таймеру).
 */
export class PendingGraphs<T> {
  private readonly items: { sessionId: string; item: T }[] = [];

  add(sessionId: string, item: T): void {
    this.items.push({ sessionId, item });
  }

  /** Забрать граф сессии `sessionId` (первый). */
  claim(sessionId: string): T | undefined {
    const i = this.items.findIndex((x) => x.sessionId === sessionId);
    return i < 0 ? undefined : this.items.splice(i, 1)[0]!.item;
  }

  /** Убрать из ожидания; `false` — его там уже нет (забран чатом). */
  remove(item: T): boolean {
    const i = this.items.findIndex((x) => x.item === item);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
}

/** Id сессии из состояния webview графа (`setState`), которое отдаёт сериализатор. */
export function graphStateSession(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const id = (state as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id ? id : undefined;
}
