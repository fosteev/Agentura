/**
 * Карточка задачи Jira и лента её изменений для вкладки чата (roadmap 19, этап 2). Без `vscode`: типы общие для хоста
 * (`extension/jira/*`) и webview (этап 5). Тексты — обычные строки (описание и комментарии уже прогнаны через `htmlToText`),
 * HTML в webview не уходит.
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
  attachments: TaskAttachment[];
  /** Все комментарии, новые снизу. */
  comments: TaskComment[];
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
}

/** Вкладка → хост. Задача — та, к которой привязана вкладка. */
export type TaskRequest =
  | { type: 'task.refresh' }
  /** Вставить текст комментария (`TaskEvent.commentId` / `TaskComment.id`) в поле ввода; не отправляет. */
  | { type: 'task.toComposer'; commentId: string }
  /** Открыть задачу («в Jiraffe ↗» при источнике Jiraffe, иначе в браузере) или вложение `attachmentId` в браузере. */
  | { type: 'task.openExternal'; attachmentId?: string };

export function isTaskRequest<T extends { type: string }>(m: T): m is T & TaskRequest {
  return m.type.startsWith('task.');
}
