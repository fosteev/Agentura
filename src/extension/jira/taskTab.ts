import type { AgentEvent } from '../../agent/types';
import {
  isOpenableLink,
  type TaskActionKind,
  type TaskActionMessage,
  type TaskRequest,
  type TaskStateMessage,
  type TaskTransitionsMessage,
} from '../../shared/task';
import { parseTaskKey, type TaskGroups, type TaskKey } from '../taskGroups';
import { WRITE_TIMEOUT_MS } from './agentTools';
import type { JiraWriter } from './source';
import type { TurnSpan } from './taskEvents';
import type { TaskService } from './taskService';

/** Текст ошибки записи во вкладку — не длиннее. */
export const MAX_ACTION_ERROR = 300;

export interface TaskTabDeps {
  service: Pick<
    TaskService,
    'attach' | 'refresh' | 'nudge' | 'afterWrite' | 'commentOf' | 'contextOf' | 'attachmentUrl' | 'issueUrl' | 'sourceFor'
  >;
  groups: Pick<TaskGroups, 'groupOf'>;
  /** Сессия вкладки; нет — вкладка ещё ничего не отправила. */
  sessionId(): string | undefined;
  /** Задача, которую вкладка ждёт (`pendingTask`): первая сессия войдёт в её группу. */
  pending(): TaskKey | undefined;
  visible(): boolean;
  turns(): TurnSpan[];
  post(m: TaskStateMessage | TaskTransitionsMessage | TaskActionMessage): void;
  /** Вставить текст в поле ввода (не отправляя). */
  prefill(text: string): void;
  /** Приложить к полю ввода текстовый файл (контекст задачи `<KEY>.md`); нет — текст уходит в `prefill`. */
  attach?(name: string, text: string): void;
  /** Открыть адрес снаружи (браузер, почта). */
  openUrl(url: string): void;
  /** «Подключить Jira…» (команда подключения). */
  connect?(): void;
  now?(): number;
}

/**
 * Связка вкладки чата с `TaskService`: держит подписку на задачу вкладки (группа сессии или ожидание), пересылает
 * `task.*` запросы webview и подталкивает загрузку после хода и после результата инструмента с ключом задачи.
 */
export class TaskTab {
  private key: TaskKey | undefined;
  private attached: { update(): void; dispose(): void } | undefined;
  private pendingSince = 0;
  private mode: 'group' | 'pending' | undefined;
  /** Записи, которые ещё летят: повторный клик того же вида не уходит вторым запросом (дубль комментария/ворклога). */
  private readonly sending = new Set<TaskActionKind>();

  constructor(private readonly deps: TaskTabDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Задача вкладки и момент, с которого в ленте показываются изменения. */
  private resolve(): { taskKey: TaskKey; openedAt: number } | undefined {
    const id = this.deps.sessionId();
    const g = id ? this.deps.groups.groupOf(id) : undefined;
    if (id && g) return { taskKey: g.taskKey, openedAt: g.group.openedAt[id] ?? 0 };
    const p = this.deps.pending();
    return p ? { taskKey: p, openedAt: this.pendingSince } : undefined;
  }

  /** Задача вкладки сейчас (группа или ожидание); нет — вкладка вне задачи. */
  get taskKey(): TaskKey | undefined {
    return this.key;
  }

  /** Вызывать при смене сессии/привязки, видимости вкладки, `ready` webview, смене групп. Дёшево, если ничего не изменилось. */
  sync(): void {
    const id = this.deps.sessionId();
    const g = id ? this.deps.groups.groupOf(id) : undefined;
    const taskKey = g?.taskKey ?? this.deps.pending();
    const mode = g ? 'group' : taskKey ? 'pending' : undefined;
    // из группы в ожидание (/clear): лента нового чата начинается с этого момента, а не с входа старой сессии
    if (mode === 'pending' && this.mode !== 'pending') this.pendingSince = this.now();
    this.mode = mode;
    if (taskKey === this.key) {
      this.attached?.update();
      return;
    }
    this.attached?.dispose();
    this.attached = undefined;
    const had = this.key !== undefined;
    this.key = taskKey;
    if (!taskKey) {
      if (had) this.deps.post({ type: 'task.state', events: [], fetchedAt: 0, source: 'none' });
      return;
    }
    this.attached = this.deps.service.attach(taskKey, {
      openedAt: () => this.resolve()?.openedAt ?? 0,
      visible: () => this.deps.visible(),
      turns: () => this.deps.turns(),
      post: (m) => this.deps.post(m),
    });
  }

  /** Webview пересоздан: ему нужно состояние заново. */
  resend(): void {
    this.attached?.dispose();
    this.attached = undefined;
    this.key = undefined;
    this.sync();
  }

  handle(m: TaskRequest): void {
    const key = this.key;
    if (!key) return;
    switch (m.type) {
      case 'task.refresh':
        void this.deps.service.refresh(key);
        break;
      case 'task.connect':
        this.deps.connect?.();
        break;
      case 'task.toComposer': {
        if (typeof m.commentId === 'string') {
          const c = this.deps.service.commentOf(key, m.commentId);
          if (c) this.deps.prefill(`${parseTaskKey(key)?.key ?? key} · ${c.author}:\n${c.text}`);
          break;
        }
        // «↳ в чат» карточки (roadmap 20, решение 8): контекст задачи файлом, как при открытии чата по задаче
        let ctx: { key: string; text: string } | undefined;
        try {
          ctx = this.deps.service.contextOf(key);
        } catch {
          ctx = undefined; // ответ источника неожиданной формы — без контекста
        }
        if (!ctx) break;
        if (this.deps.attach) this.deps.attach(`${ctx.key}.md`, ctx.text);
        else this.deps.prefill(ctx.text);
        break;
      }
      case 'task.transitions':
        void this.transitions(key);
        break;
      case 'task.transition': {
        const id = m.transitionId;
        void this.write(key, 'transition', (w, inst, k) => w.transition(inst, k, id));
        break;
      }
      case 'task.comment': {
        const body = m.body;
        void this.write(key, 'comment', (w, inst, k) => w.addComment(inst, k, body));
        break;
      }
      case 'task.logWork': {
        const work = { seconds: m.seconds, date: m.date, comment: m.comment };
        void this.write(key, 'logWork', (w, inst, k) => w.logWork(inst, k, work));
        break;
      }
      case 'task.openLink':
        // ссылка из HTML источника — недоверенная: только http/https/mailto (протокол уже проверен, это второй рубеж)
        if (isOpenableLink(m.url)) this.deps.openUrl(m.url);
        break;
      case 'task.openExternal': {
        if (typeof m.attachmentId === 'string') {
          const url = this.deps.service.attachmentUrl(key, m.attachmentId);
          if (url) this.open(url);
          break;
        }
        const parsed = parseTaskKey(key);
        const src = this.deps.service.sourceFor(key);
        if (parsed && src?.kind === 'jiraffe' && src.openIssue) {
          void src.openIssue(parsed.instanceId, parsed.key, true).catch(() => {
            const url = this.deps.service.issueUrl(key);
            if (url) this.open(url);
          });
        } else {
          const url = this.deps.service.issueUrl(key);
          if (url) this.open(url);
        }
        break;
      }
    }
  }

  /** События движка вкладки: итог хода и результат инструмента, в тексте которого есть ключ задачи, обновляют карточку. */
  onAgentEvent(e: AgentEvent): void {
    const key = this.key;
    if (!key || e.agentId) return;
    if (e.type === 'turn.result') {
      this.deps.service.nudge(key);
    } else if (e.type === 'tool.result') {
      const issue = parseTaskKey(key)?.key;
      if (issue && e.content.toUpperCase().includes(issue)) this.deps.service.nudge(key);
    }
  }

  /** Источник задачи и его запись; нет `writer` (Jiraffe без API v2, источника нет) — `undefined`. */
  private writerFor(key: TaskKey): { writer: JiraWriter; instanceId: string; key: string } | undefined {
    const parsed = parseTaskKey(key);
    const writer = parsed ? this.deps.service.sourceFor(key)?.writer : undefined;
    return parsed && writer ? { writer, instanceId: parsed.instanceId, key: parsed.key } : undefined;
  }

  private async transitions(key: TaskKey): Promise<void> {
    const t = this.writerFor(key);
    if (!t) {
      this.deps.post({ type: 'task.transitions', items: [], error: 'no-writer' });
      return;
    }
    try {
      const list = await withTimeout(t.writer.transitions(t.instanceId, t.key));
      if (this.key !== key) return;
      const items = list.map((x) => ({
        id: x.id,
        name: x.name,
        to: { name: x.to.name, category: x.to.category },
        requiresFields: x.requiresFields,
      }));
      this.deps.post({ type: 'task.transitions', items });
    } catch (e) {
      if (this.key === key) this.deps.post({ type: 'task.transitions', items: [], error: errorText(e) });
    }
  }

  /**
   * Запись от имени пользователя (roadmap 20, решение 7): он нажал сам — без подтверждения и без настроек инструментов
   * агента. Поля уже проверены протоколом, `writer` проверяет их ещё раз. Успех — карточка грузится сразу (мимо окна 5 с).
   */
  private async write(
    key: TaskKey,
    kind: TaskActionKind,
    run: (w: JiraWriter, instanceId: string, key: string) => Promise<unknown>,
  ): Promise<void> {
    const t = this.writerFor(key);
    if (!t) {
      this.deps.post({ type: 'task.action', kind, ok: false, error: 'no-writer' });
      return;
    }
    if (this.sending.has(kind)) return;
    this.sending.add(kind);
    try {
      await withTimeout(run(t.writer, t.instanceId, t.key), true);
      if (this.key === key) this.deps.post({ type: 'task.action', kind, ok: true });
      void Promise.resolve(this.deps.service.afterWrite(key)).catch(() => undefined);
    } catch (e) {
      if (this.key === key) this.deps.post({ type: 'task.action', kind, ok: false, error: errorText(e) });
    } finally {
      this.sending.delete(kind);
    }
  }

  private open(url: string): void {
    if (/^https?:\/\//i.test(url)) this.deps.openUrl(url);
  }

  dispose(): void {
    this.attached?.dispose();
    this.attached = undefined;
    this.key = undefined;
  }
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > MAX_ACTION_ERROR ? `${msg.slice(0, MAX_ACTION_ERROR)}…` : msg;
}

/** Ответ источника (Jiraffe — чужое расширение) ждём не дольше, чем инструменты агента. */
function withTimeout<T>(p: Promise<T>, write = false): Promise<T> {
  let h: ReturnType<typeof setTimeout> | undefined;
  const tail = write ? '; the write may have been saved — refresh the issue' : '';
  const timeout = new Promise<never>((_, reject) => {
    h = setTimeout(() => reject(new Error(`no answer from Jira in ${WRITE_TIMEOUT_MS / 1000} s${tail}`)), WRITE_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(h));
}
