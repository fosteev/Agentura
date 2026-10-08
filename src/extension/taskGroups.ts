import type { SessionRef } from '../agent/types';
import { isProvider } from '../settings';
import type { SessionSummary, TaskGroupSummary } from '../protocol';
import type { MementoLike } from './sessionMemory';

/** Ключ группы: `jira:<instanceId>:<KEY>`. Старый `jiraffe:<instanceId>:<KEY>` принимается как синоним (`parseTaskKey`). */
export type TaskKey = string;

export type StatusCategory = 'new' | 'indeterminate' | 'done';

/** Что известно о задаче без запроса в Jira: приходит вместе с запросом на открытие чата. */
export interface TaskMeta {
  /** `NEWMFC-1482`. */
  key: string;
  /** `instanceIdFromUrl(baseUrl)` — тот же алгоритм у Jiraffe и своего подключения. */
  instanceId: string;
  title: string;
  status?: string;
  statusCategory?: StatusCategory;
  /** Ссылка на задачу в браузере; нет — пустая строка. */
  url: string;
}

export interface TaskGroup {
  task: TaskMeta;
  sessions: SessionRef[];
  /** Когда сессия вошла в группу (мс) — от этой точки лента изменений задачи относится к чату. */
  openedAt: Record<string, number>;
}

const GROUPS = 'agentura.taskGroups';
const LEGACY_KEYED = 'agentura.keyedSessions';

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const INSTANCE_RE = /^[a-z0-9-]{1,200}$/i;
const TASK_KEY_RE = /^(?:jira|jiraffe):([a-z0-9-]{1,200}):([A-Za-z][A-Za-z0-9_]*-\d+)$/i;
const CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];

const MAX_TITLE = 500;
const MAX_STATUS = 100;
const MAX_URL = 2_000;

export function taskKeyOf(instanceId: string, key: string): TaskKey {
  return `jira:${instanceId.toLowerCase()}:${key.toUpperCase()}`;
}

/** Разобрать ключ группы (`jira:` и старый `jiraffe:`); результат нормализован. */
export function parseTaskKey(
  value: unknown,
): { taskKey: TaskKey; instanceId: string; key: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const m = TASK_KEY_RE.exec(value.trim());
  if (!m) return undefined;
  const instanceId = m[1]!.toLowerCase();
  const key = m[2]!.toUpperCase();
  return { taskKey: taskKeyOf(instanceId, key), instanceId, key };
}

function httpUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_URL) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

/** Проверить `TaskMeta` из недоверенного ввода (аргумент команды, память воркспейса); мусор — `undefined`. */
export function taskMeta(value: unknown): TaskMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) return undefined;
  if (typeof o.instanceId !== 'string' || !INSTANCE_RE.test(o.instanceId)) return undefined;
  const key = o.key.toUpperCase();
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE) : '';
  const status = typeof o.status === 'string' ? o.status.trim().slice(0, MAX_STATUS) : '';
  return {
    key,
    instanceId: o.instanceId.toLowerCase(),
    title: title || key,
    ...(status ? { status } : {}),
    ...(typeof o.statusCategory === 'string' && CATEGORIES.includes(o.statusCategory)
      ? { statusCategory: o.statusCategory as StatusCategory }
      : {}),
    url: httpUrl(o.url),
  };
}

/**
 * Новые метаданные поверх старых. «Голые» (название = ключ, ссылки нет — привязка и миграция без Jira) хорошее
 * название и ссылку не затирают. Ключ и инстанс не меняются.
 */
function mergeMeta(old: TaskMeta, next: Partial<TaskMeta>): TaskMeta {
  const bare = !next.title || next.title === old.key;
  return {
    ...old,
    ...next,
    key: old.key,
    instanceId: old.instanceId,
    title: bare ? old.title : next.title!,
    url: next.url || old.url,
  };
}

function sessionRef(v: unknown): SessionRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { provider, id } = v as SessionRef;
  return isProvider(provider) && typeof id === 'string' && id && id.length <= 200 && id !== '__proto__'
    ? { provider, id }
    : undefined;
}

function readGroups(state: MementoLike): Record<TaskKey, TaskGroup> {
  const raw = state.get<unknown>(GROUPS);
  const out: Record<TaskKey, TaskGroup> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [taskKey, g] of Object.entries(raw as Record<string, unknown>)) {
    if (!g || typeof g !== 'object') continue;
    const task = taskMeta((g as { task?: unknown }).task);
    const list = (g as { sessions?: unknown }).sessions;
    // ключ группы обязан совпадать с задачей внутри (и не быть `__proto__` и прочим мусором)
    if (!task || !Array.isArray(list) || taskKey !== taskKeyOf(task.instanceId, task.key)) continue;
    const sessions = list
      .map(sessionRef)
      .filter((r): r is SessionRef => !!r)
      .filter((r, i, all) => all.findIndex((x) => x.provider === r.provider && x.id === r.id) === i);
    if (sessions.length === 0) continue;
    const opened = (g as { openedAt?: unknown }).openedAt;
    const openedAt: Record<string, number> = {};
    for (const s of sessions) {
      const t = opened && typeof opened === 'object' ? (opened as Record<string, unknown>)[s.id] : undefined;
      openedAt[s.id] = typeof t === 'number' && Number.isFinite(t) ? t : 0;
    }
    out[taskKey] = { task, sessions, openedAt };
  }
  return out;
}

/**
 * Группы чатов по задачам (`workspaceState`, ключ `agentura.taskGroups`). Сессия входит максимум в одну
 * группу. Группа без сессий не хранится. Jira не запрашивается: метаданные приходят из запроса на открытие.
 */
export class TaskGroups {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly state: MementoLike) {
    this.migrate();
  }

  /**
   * Записи `agentura.keyedSessions` с префиксом `jiraffe:` переезжают в группы (название = ключ задачи до первого
   * обновления, ссылки нет). Чужие ключи остаются на месте нетронутыми: `sessionKey` без задачи больше не
   * возобновляет сессию, но данные не теряются.
   */
  private migrate(): void {
    const legacy = this.state.get<unknown>(LEGACY_KEYED);
    if (!legacy || typeof legacy !== 'object') return;
    const rest: Record<string, unknown> = {};
    const groups = readGroups(this.state);
    let moved = false;
    for (const [k, v] of Object.entries(legacy as Record<string, unknown>)) {
      const parsed = k.startsWith('jiraffe:') ? parseTaskKey(k) : undefined;
      const ref = sessionRef(v);
      if (!parsed || !ref) {
        // битая запись jiraffe: — выбрасываем, чужие ключи оставляем
        if (!k.startsWith('jiraffe:')) rest[k] = v;
        continue;
      }
      const group = (groups[parsed.taskKey] ??= {
        task: { key: parsed.key, instanceId: parsed.instanceId, title: parsed.key, url: '' },
        sessions: [],
        openedAt: {},
      });
      if (!group.sessions.some((s) => s.id === ref.id && s.provider === ref.provider)) {
        // сессия уже в другой группе — остаётся в первой
        if (!Object.values(groups).some((g) => g.sessions.some((s) => s.id === ref.id))) {
          group.sessions.push(ref);
          group.openedAt[ref.id] = 0;
        }
      }
      moved = true;
    }
    if (!moved && Object.keys(rest).length === Object.keys(legacy).length) return;
    for (const [k, g] of Object.entries(groups)) if (g.sessions.length === 0) delete groups[k];
    void this.state.update(GROUPS, groups);
    void this.state.update(LEGACY_KEYED, Object.keys(rest).length ? rest : undefined);
  }

  groups(): Record<TaskKey, TaskGroup> {
    return readGroups(this.state);
  }

  group(taskKey: TaskKey): TaskGroup | undefined {
    return this.groups()[taskKey];
  }

  groupOf(sessionId: string): { taskKey: TaskKey; group: TaskGroup } | undefined {
    for (const [taskKey, group] of Object.entries(this.groups())) {
      if (group.sessions.some((s) => s.id === sessionId)) return { taskKey, group };
    }
    return undefined;
  }

  /**
   * Добавить сессию в группу (создать её). Из другой группы сессия уходит; уже состоящая в этой — сохраняет
   * свой `openedAt`. Метаданные обновляются новыми (поля, которых нет в новых, остаются прежними).
   */
  add(taskKey: TaskKey, meta: TaskMeta, ref: SessionRef, openedAt: number): void {
    // группа с ключом не своей задачи или битый id отбросились бы при следующем чтении — не пишем вовсе
    if (taskKey !== taskKeyOf(meta.instanceId, meta.key) || !sessionRef(ref)) return;
    const all = this.groups();
    let kept = openedAt;
    for (const [k, g] of Object.entries(all)) {
      if (!g.sessions.some((s) => s.id === ref.id)) continue;
      if (k === taskKey) kept = g.openedAt[ref.id] ?? openedAt;
      else this.drop(all, k, ref.id);
    }
    const group = (all[taskKey] ??= { task: meta, sessions: [], openedAt: {} });
    group.task = mergeMeta(group.task, meta);
    if (!group.sessions.some((s) => s.id === ref.id)) group.sessions.push({ provider: ref.provider, id: ref.id });
    group.openedAt[ref.id] = kept;
    this.save(all);
  }

  /** Убрать сессию из её группы («Отвязать от задачи»). Нет такой — ничего не делает. */
  remove(sessionId: string): void {
    const all = this.groups();
    let changed = false;
    for (const k of Object.keys(all)) {
      if (all[k]!.sessions.some((s) => s.id === sessionId)) {
        this.drop(all, k, sessionId);
        changed = true;
      }
    }
    if (changed) this.save(all);
  }

  updateMeta(taskKey: TaskKey, patch: Partial<TaskMeta>): void {
    const all = this.groups();
    const g = all[taskKey];
    if (!g) return;
    g.task = mergeMeta(g.task, patch);
    this.save(all);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private drop(all: Record<TaskKey, TaskGroup>, taskKey: TaskKey, sessionId: string): void {
    const g = all[taskKey]!;
    g.sessions = g.sessions.filter((s) => s.id !== sessionId);
    delete g.openedAt[sessionId];
    if (g.sessions.length === 0) delete all[taskKey];
  }

  private save(all: Record<TaskKey, TaskGroup>): void {
    void this.state.update(GROUPS, all);
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* подписчик отвечает за свои ошибки */
      }
    }
  }
}

/** Строка ответа служебной команды `agentura.taskSessions` (контракт для Jiraffe, решение 7). */
export interface TaskSessionRow {
  id: string;
  provider: SessionRef['provider'];
  title: string;
  updatedAt: number;
  /** Сессия идёт или ждёт ответа в этом окне. */
  live: boolean;
}

type ListedRow = Pick<SessionSummary, 'id' | 'title' | 'updatedAt' | 'state' | 'provider'>;

/** Чаты группы, которые есть в списке сессий (ещё не отправленных там нет), новые сверху. */
export function taskSessionRows(group: TaskGroup | undefined, rows: readonly ListedRow[]): TaskSessionRow[] {
  if (!group) return [];
  const out: TaskSessionRow[] = [];
  for (const ref of group.sessions) {
    const row = rows.find((r) => r.id === ref.id && (r.provider ?? 'claude') === ref.provider);
    if (!row) continue;
    out.push({
      id: ref.id,
      provider: ref.provider,
      title: row.title,
      updatedAt: row.updatedAt,
      live: row.state === 'live' || row.state === 'waiting',
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Маршрут `openWithContext` внутри группы: `session` — id группы → возобновить; `'new'` → новая вкладка;
 * не задан → последний чат группы (по `updatedAt`), иначе новый. Неизвестный id (нет в группе) — как не заданный.
 */
export function routeTaskOpen(
  group: TaskGroup | undefined,
  rows: readonly ListedRow[],
  session: string | undefined,
): { kind: 'resume'; ref: SessionRef } | { kind: 'new' } {
  if (session === 'new') return { kind: 'new' };
  const list = taskSessionRows(group, rows);
  const pick = (session ? list.find((r) => r.id === session) : undefined) ?? list[0];
  return pick ? { kind: 'resume', ref: { provider: pick.provider, id: pick.id } } : { kind: 'new' };
}

/** Метки задач для списка сессий: `SessionSummary.task` и `sessions.update.tasks`. */
export function decorateSessions(
  rows: readonly SessionSummary[],
  groups: Record<TaskKey, TaskGroup>,
): { sessions: SessionSummary[]; tasks: TaskGroupSummary[] } {
  const byId = new Map<string, TaskMeta>();
  const tasks: TaskGroupSummary[] = [];
  for (const [taskKey, g] of Object.entries(groups)) {
    const present = g.sessions.filter((s) => rows.some((r) => r.id === s.id));
    if (present.length === 0) continue;
    for (const s of present) byId.set(s.id, g.task);
    tasks.push({
      taskKey,
      meta: g.task,
      sessionIds: rows.filter((r) => present.some((s) => s.id === r.id)).map((r) => r.id),
    });
  }
  const sessions = rows.map((r): SessionSummary => {
    const t = byId.get(r.id);
    if (!t) return r;
    return {
      ...r,
      task: {
        key: t.key,
        title: t.title,
        ...(t.status ? { status: t.status } : {}),
        ...(t.statusCategory ? { statusCategory: t.statusCategory } : {}),
      },
    };
  });
  return { sessions, tasks };
}

/** Задача вкладки: в группе (`member`) или ждёт первую сессию (`pending`). */
export interface TabTask {
  taskKey: TaskKey;
  meta: TaskMeta;
}

export interface TabTaskState {
  pending?: TabTask;
  member?: TabTask;
}

/**
 * Что делает вкладка с задачей, когда её сессия меняется (`onSession`):
 * - пришёл id — ожидающая задача берёт сессию в группу (`join`), иначе вкладка узнаёт свою группу;
 * - `/clear` (`clear`) — новая сессия остаётся в группе той же задачи (решение владельца 2026-10-08): задача из группы
 *   переходит в ожидание, ключ в заголовке не снимается;
 * - сбой возобновления (id нет, не `/clear`) — группу не наследуем: заменяющая сессия вне группы, ожидание сохраняется.
 */
export function nextTabTask(
  prev: TabTaskState,
  ev: { id?: string; clear?: boolean },
  groupOf: (sessionId: string) => { taskKey: TaskKey; group: TaskGroup } | undefined,
): TabTaskState & { join?: TabTask } {
  if (ev.id) {
    if (prev.pending) return { member: prev.pending, join: prev.pending };
    const g = groupOf(ev.id);
    return g ? { member: { taskKey: g.taskKey, meta: g.group.task } } : {};
  }
  if (ev.clear && prev.member) return { pending: prev.member };
  return prev.pending ? { pending: prev.pending } : {};
}
