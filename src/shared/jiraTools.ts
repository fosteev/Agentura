/**
 * Инструменты Jira для агента (roadmap 19, этап 8, решение 13): имена MCP-инструментов, настройка
 * `agentura.jira.agentTools` и строка результата, по которой вкладка «задача» находит событие. Без vscode — хост и webview.
 */
import type { TaskEventKind } from './task';

/**
 * Имя in-process MCP-сервера: инструменты приходят движку как `mcp__agentura_jira__<инструмент>`. Не `jira` (приёмка этапа 8):
 * у пользователя может быть свой MCP-сервер `jira` — его правила разрешений (`mcp__jira__*`) и «Всегда разрешать» к нашим
 * инструментам не относятся, а наши — к его.
 */
export const JIRA_MCP_SERVER = 'agentura_jira';
export const JIRA_TOOLS = ['comment', 'transition', 'worklog'] as const;
export type JiraToolName = (typeof JIRA_TOOLS)[number];

export const jiraMcpName = (t: JiraToolName): string => `mcp__${JIRA_MCP_SERVER}__${t}`;

/** `mcp__agentura_jira__comment` → `comment`; чужое имя (в том числе `mcp__jira__comment` чужого сервера) — `undefined`. */
export function jiraToolOf(name: string): JiraToolName | undefined {
  const prefix = `mcp__${JIRA_MCP_SERVER}__`;
  if (!name.startsWith(prefix)) return undefined;
  const t = name.slice(prefix.length);
  return (JIRA_TOOLS as readonly string[]).includes(t) ? (t as JiraToolName) : undefined;
}

/**
 * Комментарий в задачу чата без вопроса (решение 13) — только короткий и без похожего на секрет (приёмка этапа 8: текст задачи —
 * недоверенный, инъекция в описании могла бы попросить выложить ключи из репо комментарием). Остальное — карточкой разрешения.
 */
export const AUTO_COMMENT_MAX = 2000;
const SECRET_LIKE: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
  /^\s*(?:export\s+)?[\w.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd)[\w.-]*\s*[=:]\s*\S{6,}/im,
  /[A-Za-z0-9+_-]{48,}={0,2}/,
];

export function autoCommentOk(text: unknown): boolean {
  return typeof text === 'string' && text.length <= AUTO_COMMENT_MAX && !SECRET_LIKE.some((r) => r.test(text));
}

/** `agentura.jira.agentTools`: какие инструменты агент получает (все `true` по умолчанию). */
export type AgentToolsSetting = Record<JiraToolName, boolean>;
export const DEFAULT_AGENT_TOOLS: AgentToolsSetting = { comment: true, transition: true, worklog: true };

/** Значение из settings.json: не объект — по умолчанию; поле не `false` — включено. */
export function readAgentTools(v: unknown): AgentToolsSetting {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { comment: o['comment'] !== false, transition: o['transition'] !== false, worklog: o['worklog'] !== false };
}

/** Проверка записи из страницы настроек: ровно три флажка. */
export function isAgentToolsSetting(v: unknown): v is AgentToolsSetting {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).every((k) => (JIRA_TOOLS as readonly string[]).includes(k)) && JIRA_TOOLS.every((k) => typeof o[k] === 'boolean');
}

/** Вид события ленты задачи, которое оставляет инструмент. */
export const JIRA_TOOL_EVENT: Record<JiraToolName, TaskEventKind> = { comment: 'comment', transition: 'status', worklog: 'worklog' };

/**
 * Последняя строка результата инструмента: `event: comment:10234` (id события ленты, `TaskEvent.id`) или `event: status`
 * (id неизвестен — вкладка берёт самое свежее «моё» событие этого вида). Модель её видит — она безвредна.
 */
export const eventLine = (ref: string): string => `event: ${ref}`;

/** Ссылка на событие из текста результата: `{kind, id?}`; нет строки или мусор — `undefined`. */
export function eventRefOf(content: string): { kind: TaskEventKind; id?: string } | undefined {
  const m = /^event: (comment|status|worklog)(?::([\w.-]{1,50}))?\s*$/m.exec(content);
  if (!m) return undefined;
  const kind = m[1] as TaskEventKind;
  return m[2] ? { kind, id: `${kind}:${m[2]}` } : { kind };
}

/** `5400` → `1h 30m`, `60` → `1m`, `45` → `45s`. */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0m';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}
