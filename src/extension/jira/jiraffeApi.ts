import type { IssueDetail, StatusCategory, Worklog } from '../../data/jira/types';

/**
 * Контракт Jiraffe API v1 (roadmap 19, решение 6; реализация — fosteev/jiraffe 0.8.0 `src/api.ts`). Типы `IssueDetail`/`Worklog`
 * — копия Jiraffe (`data/jira/types.ts`). Ошибки — reject (`Jiraffe: unknown instance`, `invalid issue key`, нет токена…).
 */
export interface JiraffeApi {
  apiVersion: number;
  /** Инстансы в scope воркспейса (`jiraffe.instances`). */
  instances(): { id: string; name: string; baseUrl: string; kind: 'dc' | 'cloud' }[];
  /** Задача с ворклогами; HTML санитизирован Jiraffe. */
  issue(instanceId: string, key: string): Promise<{ issue: IssueDetail; worklogs: Worklog[] }>;
  /** Cloud — `{accountId, displayName}`, DC — `{name, displayName}`; email не отдаётся. */
  myself(instanceId: string): Promise<{ accountId?: string; name?: string; displayName: string }>;
  openIssue(instanceId: string, key: string, beside?: boolean): Promise<void>;
  onDidChangeInstances: (listener: () => unknown) => { dispose(): unknown };
  // v2 (этап 8 roadmap 19, Jiraffe 0.8.0; сессия 8b): запись от имени пользователя, все ошибки — reject, диалогов нет;
  // повторная запись того же вида в ту же задачу, пока предыдущая идёт, — reject «already being sent».
  /** Комментарий (wiki-текст, непустой, ≤ 32 000 символов). */
  addComment?(instanceId: string, key: string, body: string): Promise<{ id?: string }>;
  /** Переходы задачи; `requiresFields` — у перехода есть обязательные поля экрана (через API не выполнить). */
  transitions?(
    instanceId: string,
    key: string,
  ): Promise<{ id: string; name: string; to: { name: string; category: StatusCategory }; requiresFields: boolean }[]>;
  /** Перевести задачу; `transitionId` — только из свежего `transitions()`, переход с обязательными полями — reject. */
  transition?(instanceId: string, key: string, transitionId: string): Promise<void>;
  /** Ворклог (Tempo или Jira): `seconds` — целое 1…86 400, `started` — `YYYY-MM-DD` или ISO, `comment` ≤ 30 000. */
  logWork?(
    instanceId: string,
    key: string,
    work: { seconds: number; started?: string; comment?: string; aiTokens?: number },
  ): Promise<{ via: 'tempo' | 'jira'; id?: string }>;
}

/** API v2 Jiraffe с записью: `apiVersion >= 2` и все четыре метода — функции. */
export function hasJiraffeWrite(api: JiraffeApi): api is JiraffeApi & Required<Pick<JiraffeApi, 'addComment' | 'transitions' | 'transition' | 'logWork'>> {
  return (
    api.apiVersion >= 2 &&
    typeof api.addComment === 'function' &&
    typeof api.transitions === 'function' &&
    typeof api.transition === 'function' &&
    typeof api.logWork === 'function'
  );
}

/**
 * `exports` расширения Jiraffe → API или `undefined`: расширение без API (Jiraffe < 0.8.0), недоверенный воркспейс
 * (Jiraffe не активируется, `exports` — undefined) или чужая форма. Принимается `apiVersion >= 1`.
 */
export function parseJiraffeApi(exports: unknown): JiraffeApi | undefined {
  if (!exports || typeof exports !== 'object') return undefined;
  const a = exports as Partial<Record<keyof JiraffeApi, unknown>>;
  if (typeof a.apiVersion !== 'number' || !(a.apiVersion >= 1)) return undefined;
  for (const f of ['instances', 'issue', 'myself', 'openIssue'] as const) if (typeof a[f] !== 'function') return undefined;
  return exports as JiraffeApi;
}
