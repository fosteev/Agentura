// Скопировано из fosteev/jiraffe 0.7.0 src/jira/mappers.ts. Правки помечены «Agentura:».
// Agentura: `mapVersion`/`versionDate` (релизы) не копировались.
import type { Attachment, Comment, HistoryEntry, Instance, InstanceKind, IssueDetail, IssueSummary, StatusCategory, UserRef, Worklog } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function mapUser(raw: Raw | null | undefined, kind: InstanceKind): UserRef | undefined {
  if (!raw) return undefined;
  const id = kind === 'cloud' ? raw.accountId : raw.name;
  if (!id) return undefined;
  const avatar = raw.avatarUrls?.['48x48'] ?? raw.avatarUrls?.['32x32'];
  return { id: String(id), name: String(raw.displayName ?? id), ...(avatar ? { avatarUrl: String(avatar) } : {}) };
}

export function mapStatusCategory(raw: Raw | null | undefined): StatusCategory {
  const key = raw?.statusCategory?.key;
  return key === 'done' || key === 'indeterminate' ? key : 'new';
}

export function mapIssueSummary(instanceId: string, kind: InstanceKind, raw: Raw): IssueSummary {
  const f: Raw = raw.fields ?? {};
  return {
    instanceId,
    key: String(raw.key),
    summary: String(f.summary ?? ''),
    type: String(f.issuetype?.name ?? ''),
    ...(f.issuetype?.iconUrl ? { typeIconUrl: String(f.issuetype.iconUrl) } : {}),
    status: String(f.status?.name ?? ''),
    statusCategory: mapStatusCategory(f.status),
    ...(f.priority?.name ? { priority: String(f.priority.name) } : {}),
    ...(mapUser(f.assignee, kind) ? { assignee: mapUser(f.assignee, kind) } : {}),
    updated: String(f.updated ?? ''),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const escHtml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plainHtml = (t: string): string => `<p>${escHtml(t).replace(/\n/g, '<br>')}</p>`;

/** Поле Epic Link на DC: переопределение в настройках инстанса, иначе найденное в caps (контракт этапа 2). */
export function epicFieldOf(instance: Pick<Instance, 'kind' | 'epicLinkField' | 'caps'>): string | null {
  if (instance.kind === 'cloud') return null;
  return instance.epicLinkField ?? instance.caps?.epicLinkField ?? null;
}

/**
 * Ключ эпика задачи. DC — значение поля Epic Link; Cloud — `fields.parent`, только если это уровень 1 (эпик),
 * а не родитель подзадачи. Название эпика на Cloud берётся из parent, на DC дозапрашивается клиентом.
 */
export function mapEpic(kind: InstanceKind, epicField: string | null, fields: Raw): { key: string; summary?: string } | undefined {
  if (kind === 'cloud') {
    const p = fields.parent;
    if (!p || p.fields?.issuetype?.hierarchyLevel !== 1 || !p.key) return undefined;
    const summary = str(p.fields?.summary);
    return { key: String(p.key), ...(summary ? { summary } : {}) };
  }
  if (!epicField) return undefined;
  const v = fields[epicField];
  return typeof v === 'string' && v ? { key: v } : undefined;
}

export function mapAttachment(kind: InstanceKind, a: Raw): Attachment {
  return {
    id: String(a.id), filename: String(a.filename ?? ''), size: num(a.size) ?? 0, mimeType: String(a.mimeType ?? ''),
    ...(mapUser(a.author, kind) ? { author: mapUser(a.author, kind) } : {}),
    created: String(a.created ?? ''), contentUrl: String(a.content ?? ''),
    ...(a.thumbnail ? { thumbnailUrl: String(a.thumbnail) } : {}),
  };
}

/** Комментарии: HTML берём из renderedFields по id, без него — экранированный plain-текст. */
export function mapComments(kind: InstanceKind, fields: Raw, rendered: Raw | undefined): Comment[] {
  const html = new Map<string, string>();
  for (const c of (rendered?.comment?.comments as Raw[] | undefined) ?? []) if (c?.id != null && typeof c.body === 'string') html.set(String(c.id), c.body);
  return ((fields.comment?.comments as Raw[] | undefined) ?? []).map((c) => ({
    id: String(c.id),
    ...(mapUser(c.author, kind) ? { author: mapUser(c.author, kind) } : {}),
    created: String(c.created ?? ''),
    bodyHtml: html.get(String(c.id)) ?? plainHtml(String(c.body ?? '')),
  }));
}

/** Служебные записи changelog, которые в UI только шумят (идентификатор ворклога, секунды). */
const NOISE_FIELDS = new Set(['worklogid', 'timespent', 'timeestimate', 'timeoriginalestimate']);

/** Новые записи — сверху. «Было → стало» по человекочитаемым fromString/toString. */
export function mapHistory(kind: InstanceKind, changelog: Raw | undefined): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const h of (changelog?.histories as Raw[] | undefined) ?? []) {
    const items = ((h.items as Raw[] | undefined) ?? [])
      .filter((i) => !NOISE_FIELDS.has(String(i.field ?? '').toLowerCase()))
      .map((i) => ({ field: String(i.field ?? ''), from: str(i.fromString) ?? null, to: str(i.toString) ?? null }));
    if (!items.length) continue;
    out.push({ ...(mapUser(h.author, kind) ? { author: mapUser(h.author, kind) } : {}), created: String(h.created ?? ''), items });
  }
  return out.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

export function mapWorklog(kind: InstanceKind, w: Raw): Worklog {
  return {
    id: String(w.id),
    ...(mapUser(w.author, kind) ? { author: mapUser(w.author, kind) } : {}),
    started: String(w.started ?? ''),
    timeSpentSec: num(w.timeSpentSeconds) ?? 0,
    comment: typeof w.comment === 'string' ? w.comment : '',
  };
}

/**
 * Сырой ответ `GET issue?expand=renderedFields,changelog` → IssueDetail. HTML здесь НЕ санитизирован:
 * перед отправкой в webview прогоняется через `sanitizeDetail` (src/jira/sanitize.ts).
 */
export function mapIssueDetail(
  instance: Pick<Instance, 'id' | 'kind' | 'epicLinkField' | 'caps'>,
  raw: Raw,
  watchers: UserRef[] = [],
): IssueDetail {
  const f: Raw = raw.fields ?? {};
  const kind = instance.kind;
  const tt: Raw = f.timetracking ?? {};
  const epic = mapEpic(kind, epicFieldOf(instance), f);
  const due = str(f.duedate);
  const reporter = mapUser(f.reporter, kind);
  const original = num(tt.originalEstimateSeconds) ?? num(f.timeoriginalestimate);
  const remaining = num(tt.remainingEstimateSeconds);
  const spent = num(tt.timeSpentSeconds) ?? num(f.timespent);
  return {
    ...mapIssueSummary(instance.id, kind, raw),
    ...(reporter ? { reporter } : {}),
    watchers,
    // Без renderedFields (прокси срезал expand, нестандартный рендерер) — экранированный plain, как у комментариев.
    descriptionHtml: typeof raw.renderedFields?.description === 'string'
      ? raw.renderedFields.description
      : typeof f.description === 'string' && f.description ? plainHtml(f.description) : '',
    ...(epic ? { epic } : {}),
    fixVersions: ((f.fixVersions as Raw[] | undefined) ?? []).map((v) => ({ id: String(v.id), name: String(v.name ?? '') })),
    labels: ((f.labels as unknown[] | undefined) ?? []).map(String),
    components: ((f.components as Raw[] | undefined) ?? []).map((c) => String(c.name ?? '')),
    created: String(f.created ?? ''),
    ...(due ? { due } : {}),
    timetracking: {
      ...(original !== undefined ? { originalSec: original } : {}),
      ...(remaining !== undefined ? { remainingSec: remaining } : {}),
      ...(spent !== undefined ? { spentSec: spent } : {}),
    },
    attachments: ((f.attachment as Raw[] | undefined) ?? []).map((a) => mapAttachment(kind, a)),
    comments: mapComments(kind, f, raw.renderedFields),
    history: mapHistory(kind, raw.changelog),
  };
}
