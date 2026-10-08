import type { IssueDetail, Worklog } from '../../data/jira/types';

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
