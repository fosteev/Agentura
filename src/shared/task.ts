import type { AgentProvider } from '../agent/types';

/**
 * Карточка задачи Jira и лента её изменений для вкладки чата (roadmap 19, этап 2). Без `vscode`: типы общие для хоста
 * (`extension/jira/*`) и webview (этап 5). Тексты — обычные строки (описание и комментарии уже прогнаны через `htmlToText`).
 * Roadmap 20: рядом с текстом идёт HTML источника (`descriptionHtml`, `TaskComment.html`) — **недоверенный** (своё
 * подключение его не санитизирует), webview рисует его только через свой санитайзер.
 */

/** Откуда пришли данные: расширение Jiraffe, своё подключение Agentura, источника нет (`off` или не подключён). */
export type TaskSourceKind = 'jiraffe' | 'own' | 'none';

export type TaskStatusCategory = 'new' | 'indeterminate' | 'done';

/**
 * Код причины, по которой карточки нет или она устарела:
 * `off` — `agentura.jira.source` = off; `no-source` — нет ни Jiraffe, ни своих подключений; `unknown-instance` — источник
 * есть, но этого инстанса в нём нет (Jiraffe: вне набора воркспейса); `auth` — 401/403; `not-found` — 404;
 * `network` — нет связи/таймаут; `other` — прочее.
 */
export type TaskErrorCode = 'off' | 'no-source' | 'unknown-instance' | 'auth' | 'not-found' | 'network' | 'other';

export interface TaskError {
  code: TaskErrorCode;
  /** Текст на языке хоста; для `off`/`no-source` — подсказка, что делать. */
  message: string;
}

export interface TaskAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  /** Адрес в Jira (только http/https): чип открывает его в браузере через `task.openExternal { attachmentId }`. */
  url: string;
}

export interface TaskComment {
  id: string;
  author: string;
  /** Автор — текущий пользователь Jira (токен Agentura/Jiraffe). */
  mine: boolean;
  /** Мс эпохи; 0 — дата не разобрана. */
  at: number;
  text: string;
  /** HTML тела комментария из источника (до 200 000 символов), недоверенный — см. шапку файла. */
  html: string;
}

/** Запись истории задачи: кто, когда и какие поля поменял. */
export interface TaskHistory {
  /** Мс эпохи; 0 — дата не разобрана. */
  at: number;
  author: string;
  items: { field: string; from: string | null; to: string | null }[];
}

export interface TaskWorklog {
  id: string;
  author: string;
  /** Автор — текущий пользователь Jira. */
  mine: boolean;
  /** Мс эпохи `started` (когда работа сделана). */
  at: number;
  seconds: number;
  comment: string;
}

/** Переход статуса (`task.transitions`): та же форма, что `TransitionInfo` источника. */
export interface TaskTransition {
  id: string;
  name: string;
  to: { name: string; category: TaskStatusCategory };
  /** У перехода есть экран с полями — во вкладке не выполняется («откройте в Jira/Jiraffe»). */
  requiresFields: boolean;
}

/** Потолки записи — как у Jiraffe API v2 (комментарий 32 000, комментарий ворклога 30 000, ворклог до суток). */
export const TASK_LIMITS = { comment: 32_000, workComment: 30_000, workSeconds: 86_400 } as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата `YYYY-MM-DD`, которая существует в календаре. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Ссылка, которую можно открыть снаружи (`task.openLink`): только http/https/mailto, не длиннее 4000. */
export function isOpenableLink(u: unknown): u is string {
  if (typeof u !== 'string' || !u || u.length > 4_000) return false;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:' || p === 'mailto:';
  } catch {
    return false;
  }
}

export interface TaskCard {
  key: string;
  instanceId: string;
  /** Название инстанса (имя подключения). */
  instanceName: string;
  title: string;
  type: string;
  status: string;
  statusCategory: TaskStatusCategory;
  assignee?: string;
  priority?: string;
  /** Ссылка на задачу в браузере. */
  url: string;
  /** Мс эпохи `updated` задачи; 0 — не разобрана. */
  updatedAt: number;
  /** Описание текстом (`htmlToText`), до 20 000 символов. */
  description: string;
  /** HTML описания из источника (до 200 000 символов), недоверенный — см. шапку файла. */
  descriptionHtml: string;
  reporter?: string;
  /** Мс эпохи `created`; 0 — не разобрана. */
  created: number;
  /** Срок `YYYY-MM-DD` как пришёл из Jira. */
  due?: string;
  labels: string[];
  components: string[];
  /** Имена версий исправления. */
  fixVersions: string[];
  epic?: { key: string; summary?: string };
  /** Учёт времени задачи, секунды. */
  time: { originalSec?: number; remainingSec?: number; spentSec?: number };
  attachments: TaskAttachment[];
  /** Все комментарии, новые снизу. */
  comments: TaskComment[];
  /** Последние 200 записей истории, новые снизу. */
  history: TaskHistory[];
  /** Последние 200 ворклогов в порядке источника. */
  worklogs: TaskWorklog[];
  /** Источник умеет писать (своё подключение; Jiraffe — с API v2): кнопки статуса/комментария/ворклога активны. */
  canWrite: boolean;
}

export type TaskEventKind = 'status' | 'field' | 'comment' | 'worklog';

/** Событие ленты изменений. Лента — новые сверху, только то, что произошло после `openedAt` сессии. */
export interface TaskEvent {
  /** Стабильный id: `comment:<id>`, `worklog:<id>`, `hist:<created>:<n>`; для `task.toComposer` у комментария — `commentId`. */
  id: string;
  kind: TaskEventKind;
  /** Мс эпохи. Для ворклога — `started` (когда работа сделана), не момент записи. */
  at: number;
  author: string;
  /** Автор — текущий пользователь Jira. */
  mine: boolean;
  /** Эвристика: `mine` и время внутри хода этой сессии (+60 с). */
  fromThisChat: boolean;
  /** Время внутри хода этой сессии (без запаса); комментарий не `mine` с этим флагом — плашка «пока агент работал». */
  duringTurn: boolean;
  /** Готовая строка: `статус: Open → In Progress`, текст комментария, `1h 30m · комментарий`. */
  text: string;
  /** `status`/`field`: поле и значения «было → стало». */
  field?: string;
  from?: string | null;
  to?: string | null;
  /** `comment`: id комментария в Jira. */
  commentId?: string;
}

/** Хост → вкладка чата. Нет `taskKey` — вкладка вне задачи (отвязана): сбросить карточку. */
export interface TaskStateMessage {
  type: 'task.state';
  taskKey?: string;
  /** Нет — карточка ещё не загружена или недоступна (см. `error`). Есть и `error` — устаревшая карточка. */
  card?: TaskCard;
  events: TaskEvent[];
  error?: TaskError;
  /** Мс эпохи последней удачной загрузки; 0 — не было. */
  fetchedAt: number;
  source: TaskSourceKind;
  /** `agentura.tasks.humanChanges`: `false` — ленту и плашку «пока агент работал» не показывать. Нет — `true`. */
  humanChanges?: boolean;
}

/** Хост → вкладка: ответ на `task.transitions`. `error` — переходы не получены (`no-writer` или текст источника). */
export interface TaskTransitionsMessage {
  type: 'task.transitions';
  items: TaskTransition[];
  error?: string;
}

export type TaskActionKind = 'transition' | 'comment' | 'logWork';

/**
 * Хост → вкладка: итог записи от имени пользователя. `error` — `no-writer` (источник не пишет: Jiraffe без API v2) или
 * текст ошибки источника (до 300 символов). После `ok` хост сам перезагружает карточку.
 */
export interface TaskActionMessage {
  type: 'task.action';
  kind: TaskActionKind;
  ok: boolean;
  error?: string;
}

/** Строка блока «Чаты по задаче» вкладки (этап 5): чат группы, к которой привязана вкладка. */
export interface TaskChatRow {
  id: string;
  /** Нет — Claude. */
  provider?: AgentProvider;
  title: string;
  /** Мс эпохи последней активности. */
  updatedAt: number;
  state: 'idle' | 'live' | 'waiting' | 'error' | 'limit';
  /** Чат этой вкладки. */
  current: boolean;
}

/** Хост → вкладка: чаты группы задачи вкладки (новые сверху). Нет `taskKey` — вкладка вне задачи. */
export interface TaskChatsMessage {
  type: 'task.chats';
  taskKey?: string;
  chats: TaskChatRow[];
}

/** Вкладка → хост. Задача — та, к которой привязана вкладка. */
export type TaskRequest =
  | { type: 'task.refresh' }
  /**
   * Вставить текст комментария (`TaskEvent.commentId` / `TaskComment.id`) в поле ввода; не отправляет. Без `commentId` —
   * контекст всей задачи файлом `<KEY>.md` (как при открытии чата по задаче).
   */
  | { type: 'task.toComposer'; commentId?: string }
  /** Переходы статуса для меню «<статус> ▾»; ответ — `task.transitions`. */
  | { type: 'task.transitions' }
  /** Запись от имени пользователя (он нажал сам, без подтверждения); ответ — `task.action`. */
  | { type: 'task.transition'; transitionId: string }
  | { type: 'task.comment'; body: string }
  | { type: 'task.logWork'; seconds: number; date: string; comment: string }
  /** Ссылка из HTML описания/комментария: хост открывает только http/https/mailto. */
  | { type: 'task.openLink'; url: string }
  /** Открыть задачу («в Jiraffe ↗» при источнике Jiraffe, иначе в браузере) или вложение `attachmentId` в браузере. */
  | { type: 'task.openExternal'; attachmentId?: string }
  /** Открыть чат из блока «Чаты по задаче» (должен быть в группе задачи вкладки — хост проверяет). */
  | { type: 'task.openChat'; sessionId: string }
  /** Нет подключения/токен не подошёл: открыть «Agentura: Подключить Jira…». */
  | { type: 'task.connect' };

export function isTaskRequest<T extends { type: string }>(m: T): m is T & TaskRequest {
  return m.type.startsWith('task.');
}
