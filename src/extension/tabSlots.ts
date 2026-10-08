/**
 * Внутренние вкладки вкладки задачи (roadmap 19, этап 7) без vscode: какой чат показан, кому из чатов идут
 * сообщения webview, что уходит в webview. Фоновый чат пишет в пустоту — его контроллер живёт дальше (ход идёт,
 * события копятся в нём), а при показе получает синтетический `ready` и пересеивает ленту (`ChatController.reseed`).
 * Порядок при показе важен: сначала `tab.chats` с новой активной (webview сбрасывает сессионное состояние), потом
 * `ready` новому чату.
 */
import type { AgentProvider } from '../agent/types';
import type { ChatStatus } from '../agent/status';
import type { FromWebview, ToWebview } from '../protocol';
import { isTabRequest, nextActive, taskTabTitle, type TabChatRow, type TabChatsMessage } from '../shared/taskTab';

/** Что чат сообщает о себе для внутренней вкладки и состояния сериализатора. */
export interface SlotInfo {
  sessionId?: string | undefined;
  provider: AgentProvider;
  title?: string | undefined;
  status: ChatStatus;
}

interface Disposable {
  dispose(): void;
}

interface Slot {
  id: string;
  describe: () => SlotInfo | undefined;
  readonly msg: Set<(m: FromWebview) => void>;
  readonly view: Set<() => void>;
  readonly gone: Set<() => void>;
}

export interface TabSlotsIo {
  /** В webview вкладки (`postToWebview`). */
  post(m: ToWebview): void;
  /** Заголовок вкладки редактора. */
  setTitle(title: string): void;
  /** Ключ задачи для заголовка (`NEWMFC-1482`). */
  displayKey: string;
  /** «＋» внутренних вкладок: новый чат по задаче. */
  onNew(): void;
  /** Закрыли последний чат — вкладке редактора больше нечего показывать. */
  onEmpty(): void;
  /**
   * «×» чата с идущим ходом или ждущим ответа (решение владельца 2026-10-08): модальный вопрос «Остановить ход и закрыть
   * чат?»; `false` — не закрывать. Нет — закрывается сразу.
   */
  confirmClose?(title: string | undefined): Promise<boolean>;
}

function subscribe<T>(set: Set<T>, cb: T): Disposable {
  set.add(cb);
  return { dispose: () => void set.delete(cb) };
}

export class TabSlots {
  private readonly slots: Slot[] = [];
  private activeId: string | undefined;
  /** Webview прислал `ready`: до этого синтетический `ready` чату не шлём — его получит настоящий. */
  private ready = false;
  private seq = 0;
  private lastChats = '';
  private lastTitle = '';
  /** Чаты, по которым сейчас открыт вопрос «закрыть?» — повторный «×» второй вопрос не открывает. */
  private readonly asking = new Set<string>();

  constructor(
    readonly taskKey: string,
    private readonly io: TabSlotsIo,
  ) {}

  /** Новый чат вкладки (не показан, пока не вызван `activate`). */
  add(describe: () => SlotInfo | undefined): string {
    const id = `c${++this.seq}`;
    this.slots.push({ id, describe, msg: new Set(), view: new Set(), gone: new Set() });
    return id;
  }

  get ids(): string[] {
    return this.slots.map((s) => s.id);
  }

  get active(): string | undefined {
    return this.activeId;
  }

  isActive(id: string): boolean {
    return this.activeId === id;
  }

  /** Сообщение чата `id` в webview: только у показанного. */
  post(id: string, m: ToWebview): void {
    if (this.activeId === id) this.io.post(m);
  }

  onMessage(id: string, cb: (m: FromWebview) => void): Disposable {
    return subscribe(this.slot(id)?.msg ?? new Set(), cb);
  }

  onView(id: string, cb: () => void): Disposable {
    return subscribe(this.slot(id)?.view ?? new Set(), cb);
  }

  onGone(id: string, cb: () => void): Disposable {
    return subscribe(this.slot(id)?.gone ?? new Set(), cb);
  }

  /** Показать чат `id`: прежний уходит в фон, новый получает `tab.chats` и (если webview готов) `ready`. */
  activate(id: string): void {
    const next = this.slot(id);
    if (!next || this.activeId === id) return;
    const prev = this.activeId !== undefined ? this.slot(this.activeId) : undefined;
    this.activeId = id;
    this.refresh(true);
    // видимость: прежний перестал быть видимым, новый стал (ленивый движок восстановленного чата стартует)
    for (const cb of [...(prev?.view ?? []), ...next.view]) cb();
    if (this.ready) for (const cb of [...next.msg]) cb({ type: 'ready' });
  }

  /** Сообщение от webview: запросы внутренних вкладок — здесь, остальное — показанному чату. */
  receive(m: FromWebview): void {
    if (m.type === 'ready') {
      this.ready = true;
      this.refresh(true);
    }
    if (isTabRequest(m)) {
      if (m.type === 'tab.select') this.activate(m.id);
      else if (m.type === 'tab.close') void this.requestClose(m.id);
      else this.io.onNew();
      return;
    }
    // webview помечает сообщение показанным у себя чатом: хост уже переключил чат (＋, сайдбар, Jiraffe), а webview
    // ещё нет — промпт, ответ на разрешение или «стоп» прежнего чата не должен уйти новому
    const tag = (m as { tab?: unknown }).tab;
    if (typeof tag === 'string' && tag !== this.activeId) return;
    const s = this.activeId !== undefined ? this.slot(this.activeId) : undefined;
    for (const cb of [...(s?.msg ?? [])]) cb(m);
  }

  /** «×» внутренней вкладки: в простое — сразу, при ходе или ждущем запросе — после подтверждения (`confirmClose`). */
  async requestClose(id: string): Promise<void> {
    const info = this.slot(id)?.describe();
    if (!info) {
      this.close(id);
      return;
    }
    const busy = info.status === 'working' || info.status === 'waiting';
    if (busy && this.io.confirmClose) {
      if (this.asking.has(id)) return;
      this.asking.add(id);
      let ok: boolean;
      try {
        ok = await this.io.confirmClose(info.title);
      } catch {
        ok = false;
      } finally {
        this.asking.delete(id);
      }
      // пока висел вопрос, чат могли закрыть другим путём (вкладка редактора, отвязка)
      if (!ok || !this.slot(id)) return;
    }
    this.close(id);
  }

  /** Закрыть чат `id` (внутренняя вкладка «×»): его `ChatPanel` закрывается, показывается соседний. */
  close(id: string): void {
    const s = this.slot(id);
    if (!s) return;
    const next = nextActive(this.ids, id, this.activeId);
    this.slots.splice(this.slots.indexOf(s), 1);
    if (this.activeId === id) this.activeId = undefined;
    for (const cb of [...s.gone]) cb();
    if (!this.slots.length) {
      this.io.onEmpty();
      return;
    }
    if (next && next !== this.activeId) this.activate(next);
    else this.refresh();
  }

  /** Вкладка редактора закрыта: закрыть все чаты. */
  disposeAll(): void {
    const all = this.slots.splice(0);
    this.activeId = undefined;
    for (const s of all) for (const cb of [...s.gone]) cb();
  }

  /** Видимость или фокус вкладки редактора изменились. */
  viewChanged(): void {
    for (const s of [...this.slots]) for (const cb of [...s.view]) cb();
  }

  /** Заголовок вкладки и внутренние вкладки (`force` — даже без изменений: webview пересоздан, сменился чат). */
  refresh(force = false): void {
    const rows: TabChatRow[] = [];
    const persist: TabChatsMessage['persist'] = { taskKey: this.taskKey, chats: [] };
    for (const s of this.slots) {
      const info = s.describe();
      if (!info) continue;
      const active = s.id === this.activeId;
      rows.push({ id: s.id, title: info.title ?? '', provider: info.provider, status: info.status, active });
      if (info.sessionId) {
        persist.chats.push({ provider: info.provider, id: info.sessionId });
        if (active) persist.active = info.sessionId;
      }
    }
    const title = taskTabTitle(
      this.io.displayKey,
      rows.map((r) => r.status),
    );
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.io.setTitle(title);
    }
    const msg: TabChatsMessage = { type: 'tab.chats', taskKey: this.taskKey, chats: rows, persist };
    const json = JSON.stringify(msg);
    if (!this.ready || (!force && json === this.lastChats)) return;
    this.lastChats = json;
    this.io.post(msg);
  }

  private slot(id: string): Slot | undefined {
    return this.slots.find((s) => s.id === id);
  }
}
