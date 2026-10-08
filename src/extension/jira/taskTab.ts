import type { AgentEvent } from '../../agent/types';
import type { TaskRequest, TaskStateMessage } from '../../shared/task';
import { parseTaskKey, type TaskGroups, type TaskKey } from '../taskGroups';
import type { TurnSpan } from './taskEvents';
import type { TaskService } from './taskService';

export interface TaskTabDeps {
  service: Pick<TaskService, 'attach' | 'refresh' | 'nudge' | 'commentOf' | 'attachmentUrl' | 'issueUrl' | 'sourceFor'>;
  groups: Pick<TaskGroups, 'groupOf'>;
  /** Сессия вкладки; нет — вкладка ещё ничего не отправила. */
  sessionId(): string | undefined;
  /** Задача, которую вкладка ждёт (`pendingTask`): первая сессия войдёт в её группу. */
  pending(): TaskKey | undefined;
  visible(): boolean;
  turns(): TurnSpan[];
  post(m: TaskStateMessage): void;
  /** Вставить текст в поле ввода (не отправляя). */
  prefill(text: string): void;
  /** Открыть адрес в браузере. */
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
        const c = this.deps.service.commentOf(key, m.commentId);
        if (c) this.deps.prefill(`${parseTaskKey(key)?.key ?? key} · ${c.author}:\n${c.text}`);
        break;
      }
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

  private open(url: string): void {
    if (/^https?:\/\//i.test(url)) this.deps.openUrl(url);
  }

  dispose(): void {
    this.attached?.dispose();
    this.attached = undefined;
    this.key = undefined;
  }
}
