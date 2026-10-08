// Скопировано из fosteev/jiraffe 0.7.0 src/jira/types.ts.
// Agentura: оставлены только типы карточки задачи (без SearchPage, Version, Progress); токен инстанса — в SecretStorage
// Agentura (`agentura.jira.token.<wsId>.<id>`), а не Jiraffe.
export type InstanceKind = 'dc' | 'cloud';
export interface Instance { id: string; name: string; baseUrl: string; kind: InstanceKind; email?: string;
  epicLinkField?: string; caps?: Capabilities }
export interface Capabilities { tempo: boolean; epicLinkField: string | null; checkedAt: string; serverVersion?: string }
export interface UserRef { id: string; name: string; avatarUrl?: string }   // id = name (DC) | accountId (Cloud)
export type StatusCategory = 'new' | 'indeterminate' | 'done';
export interface IssueSummary { instanceId: string; key: string; summary: string; type: string; typeIconUrl?: string;
  status: string; statusCategory: StatusCategory; priority?: string; assignee?: UserRef; updated: string }
export interface IssueDetail extends IssueSummary { reporter?: UserRef; watchers: UserRef[]; descriptionHtml: string;
  epic?: { key: string; summary?: string }; fixVersions: { id: string; name: string }[]; labels: string[]; components: string[];
  created: string; due?: string; timetracking: { originalSec?: number; remainingSec?: number; spentSec?: number };
  attachments: Attachment[]; comments: Comment[]; history: HistoryEntry[] }
export interface Attachment { id: string; filename: string; size: number; mimeType: string; author?: UserRef; created: string;
  contentUrl: string; thumbnailUrl?: string }
export interface Comment { id: string; author?: UserRef; created: string; bodyHtml: string }
export interface HistoryEntry { author?: UserRef; created: string; items: { field: string; from: string | null; to: string | null }[] }
export interface Worklog { id: string; author?: UserRef; started: string; timeSpentSec: number; comment: string;
  attributes?: Record<string, string> }
