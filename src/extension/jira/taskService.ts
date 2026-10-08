import { JiraError } from '../../data/jira/http';
import type { TaskRefreshMode } from '../../settings';
import type { TaskError, TaskErrorCode, TaskSourceKind, TaskStateMessage } from '../../shared/task';
import { parseTaskKey, type TaskGroup, type TaskKey, type TaskMeta } from '../taskGroups';
import type { JiraSource } from './source';
import { buildSnapshot, eventsSince, meRef, type MeRef, type TaskSnapshot, type TurnSpan } from './taskEvents';

/** Опрос видимой вкладки задачи (решение 11). */
export const POLL_MS = 30_000;
/** Не чаще одной загрузки на задачу — для опроса, ↻, «после хода» и «после результата инструмента» одинаково. */
export const MIN_GAP_MS = 5_000;
/** Потолок паузы автоматических загрузок после сбоев подряд (429, сеть): 30 с → 60 → 120 → … → 10 мин. */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** Текст ошибки источника (в том числе чужого расширения) в вкладку — не длиннее. */
const MAX_ERROR = 500;
/** Ответ источника (Jiraffe — чужое расширение, его промис может не завершиться) ждём не дольше: иначе `inflight` навсегда. */
export const SOURCE_TIMEOUT_MS = 45_000;

/** Вкладка чата, смотрящая на задачу: сервис спрашивает у неё сессию, видимость и ходы и шлёт ей состояние. */
export interface TaskView {
  /** Когда сессия вошла в группу (мс); 0 — с начала (мигрированные сессии). */
  openedAt(): number;
  visible(): boolean;
  turns(): TurnSpan[];
  post(m: TaskStateMessage): void;
}

export interface TaskServiceDeps {
  sources: {
    setting(): string;
    current(): JiraSource | undefined;
    forInstance(instanceId: string): JiraSource | undefined;
  };
  groups: {
    group(taskKey: TaskKey): TaskGroup | undefined;
    updateMeta(taskKey: TaskKey, patch: Partial<TaskMeta>): void;
  };
  settings(): { refresh: TaskRefreshMode; humanChanges: boolean };
  /** Тексты ошибок без источника — на языке хоста. */
  messages: { off: string; noSource: string; timeout: string; unknownInstance: (instanceId: string) => string };
  now?(): number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
}

interface Entry {
  taskKey: TaskKey;
  viewers: Set<TaskView>;
  snap?: TaskSnapshot;
  source: TaskSourceKind;
  error?: TaskError;
  fetchedAt: number;
  /** Начало последней загрузки (для MIN_GAP_MS). */
  lastStart: number;
  inflight?: Promise<void>;
  /** Сбоев подряд: автоматические загрузки (таймер, nudge) реже; ↻ — без паузы. */
  failures: number;
  /** Растёт на `reconfigure`: результат загрузки, начатой до смены источника, отбрасывается. */
  gen: number;
  restart?: boolean;
  timer?: unknown;
  me?: { sourceKind: string; value: MeRef };
}

function classify(e: unknown): TaskErrorCode {
  if (e instanceof JiraError) {
    if (e.status === 401 || e.status === 403) return 'auth';
    if (e.status === 404) return 'not-found';
    if (e.code === 'network' || e.status === 0) return 'network';
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /unknown instance/i.test(msg) ? 'unknown-instance' : 'other';
}

/**
 * Данные задачи для вкладок чата: одна загрузка на задачу (кеш общий для всех вкладок группы), опрос, пока видна хотя бы
 * одна вкладка, и состояние `task.state` каждой вкладке со своей лентой (по `openedAt` и ходам её сессии).
 */
export class TaskService {
  private readonly entries = new Map<TaskKey, Entry>();
  private readonly now: () => number;
  private readonly timers: NonNullable<TaskServiceDeps['timers']>;

  constructor(private readonly deps: TaskServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  /** Вкладка начинает смотреть на задачу. Сразу получает то, что есть в кеше; при необходимости запускается загрузка. */
  attach(taskKey: TaskKey, view: TaskView): { update(): void; dispose(): void } {
    const e = this.entry(taskKey);
    e.viewers.add(view);
    this.postTo(e, view);
    this.wake(e, false);
    return {
      update: () => {
        if (this.entries.get(taskKey) === e) this.wake(e, false);
      },
      dispose: () => {
        e.viewers.delete(view);
        this.reschedule(e);
        this.forgetIfIdle(e);
      },
    };
  }

  /** На задачу никто не смотрит и загрузки нет — запись (снимок) не держим. Следующая вкладка начнёт с загрузки. */
  private forgetIfIdle(e: Entry): void {
    if (e.viewers.size === 0 && !e.inflight && this.entries.get(e.taskKey) === e) this.entries.delete(e.taskKey);
  }

  /**
   * Изменились `agentura.tasks.*` (опрос, «изменения от людей»): таймеры по новому режиму и ленты заново, без сброса кеша,
   * окна 5 с и паузы после сбоя (полный сброс — `reconfigure`, при смене источника).
   */
  settingsChanged(): void {
    for (const e of this.entries.values()) {
      this.emit(e);
      this.wake(e, false);
    }
  }

  /** ↻ во вкладке: загрузка не чаще раза в 5 с, иначе вкладка получает кеш. */
  refresh(taskKey: TaskKey): Promise<void> {
    const e = this.entries.get(taskKey);
    return e ? this.load(e) : Promise.resolve();
  }

  /** После хода и после результата инструмента с ключом задачи; `manual` выключает только таймер (решение владельца 2026-10-08). */
  nudge(taskKey: TaskKey): void {
    const e = this.entries.get(taskKey);
    if (!e || !this.anyVisible(e) || !this.autoAllowed(e)) return;
    void this.load(e);
  }

  /** Настройка или источник изменились: перезапустить таймеры и перезагрузить задачи, на которые смотрят. */
  reconfigure(): void {
    for (const e of this.entries.values()) {
      e.snap = undefined;
      e.error = undefined;
      e.fetchedAt = 0;
      e.me = undefined;
      e.lastStart = 0;
      e.failures = 0;
      e.gen++;
      this.emit(e);
      this.wake(e, true);
    }
  }

  /** Текст комментария из последнего снимка (`task.toComposer`). */
  commentOf(taskKey: TaskKey, commentId: string): { author: string; text: string } | undefined {
    const c = this.entries.get(taskKey)?.snap?.card.comments.find((x) => x.id === commentId);
    return c ? { author: c.author, text: c.text } : undefined;
  }

  attachmentUrl(taskKey: TaskKey, attachmentId: string): string | undefined {
    return this.entries.get(taskKey)?.snap?.card.attachments.find((a) => a.id === attachmentId)?.url || undefined;
  }

  issueUrl(taskKey: TaskKey): string | undefined {
    return this.entries.get(taskKey)?.snap?.card.url || this.deps.groups.group(taskKey)?.task.url || undefined;
  }

  /** Какой источник отдаёт эту задачу сейчас (для «в Jiraffe ↗»). */
  sourceFor(taskKey: TaskKey): JiraSource | undefined {
    const p = parseTaskKey(taskKey);
    return p ? this.deps.sources.forInstance(p.instanceId) : undefined;
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      if (e.timer !== undefined) this.timers.clear(e.timer);
      e.timer = undefined;
      e.viewers.clear();
    }
    this.entries.clear();
  }

  private entry(taskKey: TaskKey): Entry {
    let e = this.entries.get(taskKey);
    if (!e) {
      e = { taskKey, viewers: new Set(), source: 'none', fetchedAt: 0, lastStart: 0, failures: 0, gen: 0 };
      this.entries.set(taskKey, e);
    }
    return e;
  }

  private anyVisible(e: Entry): boolean {
    for (const v of e.viewers) if (v.visible()) return true;
    return false;
  }

  /** Видимость/настройки изменились: таймер опроса и, если данные устарели или их нет, загрузка. */
  private wake(e: Entry, force: boolean): void {
    this.reschedule(e);
    if (!this.anyVisible(e)) return;
    const stale = !e.snap || this.now() - e.fetchedAt >= POLL_MS;
    if (force || (stale && !e.error) || (e.error && this.autoAllowed(e))) void this.load(e);
  }

  /**
   * Можно ли грузить без просьбы человека (таймер, nudge, видимость). 401/403 — нет: опрос с плохим токеном на DC
   * доводит учётку до CAPTCHA; ждём ↻ или смены подключения/настройки. Прочие сбои (429, сеть) — пауза удваивается.
   */
  private autoAllowed(e: Entry): boolean {
    if (!e.error) return true;
    if (e.error.code === 'auth') return false;
    const pause = Math.min(POLL_MS * 2 ** Math.max(0, e.failures - 1), MAX_BACKOFF_MS);
    return this.now() - e.lastStart >= pause;
  }

  private reschedule(e: Entry): void {
    const want = this.deps.settings().refresh === '30s' && this.anyVisible(e) && this.deps.sources.current() !== undefined;
    if (want && e.timer === undefined) {
      e.timer = this.timers.set(() => {
        if (this.anyVisible(e) && this.autoAllowed(e)) void this.load(e);
      }, POLL_MS);
    } else if (!want && e.timer !== undefined) {
      this.timers.clear(e.timer);
      e.timer = undefined;
    }
  }

  private load(e: Entry): Promise<void> {
    if (e.inflight) return e.inflight;
    if (this.now() - e.lastStart < MIN_GAP_MS && (e.snap || e.error)) {
      this.emit(e); // слишком часто: просто пересылаем кеш (↻ получает ответ)
      return Promise.resolve();
    }
    e.lastStart = this.now();
    e.inflight = this.fetch(e).finally(() => {
      e.inflight = undefined;
      if (e.restart) {
        e.restart = false;
        this.wake(e, true);
      }
      this.forgetIfIdle(e);
    });
    return e.inflight;
  }

  private async fetch(e: Entry): Promise<void> {
    const gen = e.gen;
    const parsed = parseTaskKey(e.taskKey);
    const setting = this.deps.sources.setting();
    const src = parsed ? this.deps.sources.forInstance(parsed.instanceId) : undefined;
    if (!parsed || !src) {
      e.source = 'none';
      e.snap = undefined;
      const m = this.deps.messages;
      const off = setting === 'off';
      const known = this.deps.sources.current() !== undefined;
      e.error = off
        ? { code: 'off', message: m.off }
        : known
          ? { code: 'unknown-instance', message: m.unknownInstance(parsed?.instanceId ?? '') }
          : { code: 'no-source', message: m.noSource };
      this.emit(e);
      return;
    }
    e.source = src.kind;
    try {
      const inst = src.instances().find((i) => i.id === parsed.instanceId);
      const [{ issue, worklogs }, me] = await this.withTimeout(
        Promise.all([src.issue(parsed.instanceId, parsed.key), this.myself(e, src, parsed.instanceId)]),
      );
      if (gen !== e.gen) return this.restart(e);
      const baseUrl = inst?.baseUrl ?? this.deps.groups.group(e.taskKey)?.task.url.replace(/\/browse\/[^/]*$/, '') ?? '';
      e.snap = buildSnapshot({ instance: { id: parsed.instanceId, name: inst?.name ?? parsed.instanceId, baseUrl }, issue, worklogs, me });
      e.error = undefined;
      e.failures = 0;
      e.fetchedAt = this.now();
      this.syncMeta(e);
    } catch (err) {
      if (gen !== e.gen) return this.restart(e);
      // карточка остаётся прежней (устаревшей), рядом — причина
      const message = err instanceof Error ? err.message : String(err);
      e.error = { code: classify(err), message: message.length > MAX_ERROR ? `${message.slice(0, MAX_ERROR)}…` : message };
      e.failures++;
    }
    this.emit(e);
  }

  private withTimeout<T>(p: Promise<T>, ms = SOURCE_TIMEOUT_MS): Promise<T> {
    let h: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      h = setTimeout(() => reject(new JiraError(0, this.deps.messages.timeout, '', 'network')), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(h));
  }

  /** Источник сменился, пока шла загрузка: её результат выброшен, видимые вкладки грузят заново, когда `inflight` снят. */
  private restart(e: Entry): void {
    e.restart = true;
  }

  private async myself(e: Entry, src: JiraSource, instanceId: string): Promise<MeRef | undefined> {
    const tag = `${src.kind}:${instanceId}`;
    if (e.me?.sourceKind === tag) return e.me.value;
    try {
      // «я» не ответил быстро — карточка не ждёт его до общего таймаута
      const value = meRef(await this.withTimeout(src.myself(instanceId), SOURCE_TIMEOUT_MS / 3));
      e.me = { sourceKind: tag, value };
      return value;
    } catch {
      return undefined; // «я» неизвестен: все авторы считаются людьми, карточка от этого не падает
    }
  }

  /** Метаданные группы — после каждой загрузки; не пишем, если ничего не изменилось (иначе перерисовка сайдбара каждые 30 с). */
  private syncMeta(e: Entry): void {
    const card = e.snap?.card;
    const cur = this.deps.groups.group(e.taskKey)?.task;
    if (!card || !cur) return;
    const patch: Partial<TaskMeta> = { title: card.title, status: card.status, statusCategory: card.statusCategory, url: card.url };
    if (cur.title === patch.title && cur.status === patch.status && cur.statusCategory === patch.statusCategory && cur.url === patch.url) return;
    this.deps.groups.updateMeta(e.taskKey, patch);
  }

  private emit(e: Entry): void {
    for (const v of [...e.viewers]) this.postTo(e, v);
  }

  private postTo(e: Entry, v: TaskView): void {
    const { humanChanges } = this.deps.settings();
    const setting = this.deps.sources.setting();
    let error = e.error;
    // ещё ни одной загрузки, а источника нет — вкладка не должна ждать опроса, чтобы узнать причину
    if (!e.snap && !error && !e.inflight && e.fetchedAt === 0 && e.lastStart === 0) {
      const parsed = parseTaskKey(e.taskKey);
      if (setting === 'off') error = { code: 'off', message: this.deps.messages.off };
      else if (!this.deps.sources.current()) error = { code: 'no-source', message: this.deps.messages.noSource };
      else if (parsed && !this.deps.sources.forInstance(parsed.instanceId)) {
        error = { code: 'unknown-instance', message: this.deps.messages.unknownInstance(parsed.instanceId) };
      }
    }
    // до первого ответа `e.source` ещё 'none': берём источник, который будет опрашивать, — иначе вкладка при
    // `tasks.card = split` с Jiraffe на время первой загрузки показывает вкладку «задача» (этап 5)
    let source = e.source;
    if (source === 'none' && !e.snap && !error) {
      const parsed = parseTaskKey(e.taskKey);
      source = (parsed && this.deps.sources.forInstance(parsed.instanceId)?.kind) || 'none';
    }
    const now = this.now();
    v.post({
      type: 'task.state',
      taskKey: e.taskKey,
      ...(e.snap ? { card: e.snap.card } : {}),
      events: e.snap ? eventsSince(e.snap, v.openedAt(), v.turns(), { now, humanChanges }) : [],
      ...(error ? { error } : {}),
      fetchedAt: e.fetchedAt,
      source,
      humanChanges,
    });
  }
}
