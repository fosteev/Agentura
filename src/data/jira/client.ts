// Скопировано из fosteev/jiraffe 0.7.0 src/jira/client.ts. Правки помечены «Agentura:».
// Agentura: оставлены `myself`, `issue`, `watchers`, `worklogs`, `issueDetail`; поиск, переходы, ворклоги-запись, эпики,
// проекты, версии, вложения-скачивание — не копировались (этап 8 дописывает `addComment`). В `issueDetail` убран best-effort
// запрос названия эпика DC: у своего подключения нет определения поля Epic Link.
import { HttpClient, JiraError, type HttpOptions } from './http';
import { mapIssueDetail, mapUser, mapWorklog } from './mappers';
import type { Instance, InstanceKind, IssueDetail, UserRef, Worklog } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const asArray = (r: unknown): Raw[] => (Array.isArray(r) ? (r as Raw[]) : []);

export interface MyselfInfo { id: string; name: string; displayName: string; email?: string }

export class JiraClient {
  constructor(
    public readonly instanceId: string,
    public readonly kind: InstanceKind,
    public readonly http: HttpClient,
  ) {}

  async myself(): Promise<MyselfInfo> {
    const r = await this.http.getJson<Raw>('/rest/api/2/myself');
    const id = String(this.kind === 'cloud' ? r.accountId : r.name);
    return { id, name: String(r.name ?? id), displayName: String(r.displayName ?? id), ...(r.emailAddress ? { email: String(r.emailAddress) } : {}) };
  }

  /** Сырой ответ; для карточки — `issueDetail`. */
  issue(key: string, expand: string | string[] = []): Promise<Raw> {
    const e = Array.isArray(expand) ? expand.join(',') : expand;
    return this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}`, e ? { expand: e } : undefined);
  }

  /** Наблюдатели. Нет прав на просмотр (403/404) — пустой список, карточка от этого не падает. */
  async watchers(key: string): Promise<UserRef[]> {
    try {
      const r = await this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}/watchers`);
      return asArray(r?.watchers).flatMap((w) => mapUser(w, this.kind) ?? []);
    } catch (e) {
      if (e instanceof JiraError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  }

  /** Стандартный журнал работ (Tempo-атрибуты — этап 6). Старые записи — как отдал Jira, без догрузки страниц. */
  async worklogs(key: string): Promise<Worklog[]> {
    try {
      const path = `/rest/api/2/issue/${encodeURIComponent(key)}/worklog`;
      const r = await this.http.getJson<Raw>(path);
      const all = asArray(r?.worklogs);
      // DC обычно отдаёт весь журнал, Cloud — до 5000; если ответ всё же постраничный — дочитываем (не больше 10 страниц).
      const total = typeof r?.total === 'number' ? r.total : all.length;
      for (let page = 0; page < 10 && all.length < total; page++) {
        const more = asArray((await this.http.getJson<Raw>(path, { startAt: all.length }))?.worklogs);
        if (!more.length) break;
        all.push(...more);
      }
      return all.map((w) => mapWorklog(this.kind, w));
    } catch (e) {
      if (e instanceof JiraError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  }

  /**
   * Всё для карточки тремя параллельными GET. HTML в результате не санитизирован.
   * Падение запроса самой задачи — ошибка.
   */
  async issueDetail(
    key: string,
    instance: Pick<Instance, 'id' | 'kind' | 'epicLinkField' | 'caps'>,
  ): Promise<{ issue: IssueDetail; worklogs: Worklog[]; worklogError?: string }> {
    // Наблюдатели и журнал не должны ронять карточку: любая их ошибка (500, таймаут) — пустой список; для журнала ещё и текст.
    let worklogError: string | undefined;
    const [raw, watchers, worklogs] = await Promise.all([
      this.issue(key, ['renderedFields', 'changelog']),
      this.watchers(key).catch((): UserRef[] => []),
      this.worklogs(key).catch((e: unknown): Worklog[] => {
        worklogError = e instanceof Error ? e.message : String(e);
        return [];
      }),
    ]);
    const issue = mapIssueDetail(instance, raw, watchers);
    return { issue, worklogs, ...(worklogError ? { worklogError } : {}) };
  }
}

export function createJiraClient(
  instance: { id: string; kind: InstanceKind; baseUrl: string; email?: string },
  token: string,
  extra: Pick<HttpOptions, 'fetchImpl' | 'timeoutMs'> = {},
): JiraClient {
  const http = new HttpClient({ baseUrl: instance.baseUrl, kind: instance.kind, token, email: instance.email, ...extra });
  return new JiraClient(instance.id, instance.kind, http);
}
