import { createJiraClient, startedWithOffset, type JiraClient } from '../../data/jira/client';
import type { IssueDetail, StatusCategory, TransitionInfo, Worklog } from '../../data/jira/types';
import type { JiraSourceSetting } from '../../settings';
import { isIsoDate, TASK_LIMITS } from '../../shared/task';
import { hasJiraffeWrite, type JiraffeApi } from './jiraffeApi';
import type { OwnInstance, OwnInstanceStore } from './ownInstances';

export interface JiraInstanceRef {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'dc' | 'cloud';
}

export interface MyselfResult {
  accountId?: string;
  name?: string;
  displayName: string;
}

/** Ворклог агента: секунды (целое 1…86 400), дата `YYYY-MM-DD` (локальная), комментарий (может быть пустым). */
export interface WorkInput {
  seconds: number;
  date: string;
  comment: string;
  /** Токены ИИ: Tempo — атрибут AI Tokens (Jiraffe), своё подключение — «(AI Tokens: N)» в конце комментария. */
  aiTokens?: number;
}

/** Потолки записи — как у Jiraffe API v2 (общие с проверкой протокола webview — `TASK_LIMITS`). */
export const MAX_COMMENT = TASK_LIMITS.comment;
export const MAX_WORK_COMMENT = TASK_LIMITS.workComment;
export const MAX_WORK_SECONDS = TASK_LIMITS.workSeconds;

/**
 * Запись в Jira от имени пользователя (этап 8 roadmap 19, инструменты агента): у своего подключения — копия клиента
 * Jiraffe, у Jiraffe — его API v2. Ключ задачи проверяется; ошибки — reject.
 */
export interface JiraWriter {
  addComment(instanceId: string, key: string, body: string): Promise<{ id?: string }>;
  transitions(instanceId: string, key: string): Promise<TransitionInfo[]>;
  transition(instanceId: string, key: string, transitionId: string): Promise<void>;
  logWork(instanceId: string, key: string, work: WorkInput): Promise<{ id?: string }>;
}

/** Дата `YYYY-MM-DD`, которая существует в календаре (живёт в `shared/task` — её проверяет и протокол webview). */
export { isIsoDate };

/** Проверка записи до запроса (общая для обоих источников): мусор не уходит ни в Jira, ни в чужое расширение. */
function checkComment(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) throw new Error('comment body is empty');
  if (body.length > MAX_COMMENT) throw new Error(`comment is longer than ${MAX_COMMENT} characters`);
  return body;
}

function checkWork(w: WorkInput): WorkInput {
  if (!Number.isInteger(w.seconds) || w.seconds < 1 || w.seconds > MAX_WORK_SECONDS) throw new Error(`seconds must be an integer from 1 to ${MAX_WORK_SECONDS}`);
  if (!isIsoDate(w.date)) throw new Error(`invalid date "${String(w.date).slice(0, 20)}"`);
  if (typeof w.comment !== 'string' || w.comment.length > MAX_WORK_COMMENT) throw new Error(`worklog comment is longer than ${MAX_WORK_COMMENT} characters`);
  if (w.aiTokens !== undefined && (!Number.isInteger(w.aiTokens) || w.aiTokens < 0)) throw new Error('aiTokens must be a non-negative integer');
  return w;
}

/** Без Tempo AI Tokens дописываются в конец комментария — как у Jiraffe (`appendAiTokens`). */
export const appendAiTokens = (comment: string, tokens: number): string => `${comment ? `${comment} ` : ''}(AI Tokens: ${tokens})`;

const CATEGORIES: readonly StatusCategory[] = ['new', 'indeterminate', 'done'];

/** Переходы из чужого расширения: только записи правильной формы, не больше 100. */
function cleanTransitions(raw: unknown): TransitionInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: TransitionInfo[] = [];
  for (const t of raw.slice(0, 100) as Partial<TransitionInfo>[]) {
    if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 50) continue;
    const to = t.to && typeof t.to === 'object' ? t.to : undefined;
    const cat = to?.category;
    out.push({
      id: t.id,
      name: typeof t.name === 'string' ? t.name.slice(0, 200) : '',
      to: {
        name: typeof to?.name === 'string' ? to.name.slice(0, 200) : '',
        category: cat && CATEGORIES.includes(cat) ? cat : 'indeterminate',
      },
      requiresFields: t.requiresFields === true,
    });
  }
  return out;
}

const idOf = (r: unknown): { id?: string } => {
  const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? { id: String(id).slice(0, 50) } : {};
};

/** Источник данных Jira: Jiraffe (его API v1) или своё подключение Agentura — один интерфейс для сервиса задачи. */
export interface JiraSource {
  readonly kind: 'jiraffe' | 'own';
  /** Запись (этап 8): своё подключение — всегда, Jiraffe — только с API v2; нет — источник только читает. */
  readonly writer?: JiraWriter | undefined;
  instances(): JiraInstanceRef[];
  issue(instanceId: string, key: string): Promise<{ issue: IssueDetail; worklogs: Worklog[] }>;
  myself(instanceId: string): Promise<MyselfResult>;
  /** Открыть карточку в самом источнике (Jiraffe); у своего подключения нет — открывается ссылка в браузере. */
  openIssue?(instanceId: string, key: string, beside?: boolean): Promise<void>;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Ключ задачи в запросах: тримится и приводится к верхнему регистру; не ключ — ошибка (запрос в Jira не уходит). */
export function normalizeIssueKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key.trim())) throw new Error(`invalid issue key "${String(key).slice(0, 50)}"`);
  return key.trim().toUpperCase();
}

export class JiraffeSource implements JiraSource {
  readonly kind = 'jiraffe' as const;
  readonly writer: JiraWriter | undefined;

  constructor(private readonly api: JiraffeApi) {
    if (!hasJiraffeWrite(api)) return;
    // API v2: ответы чужого расширения — по форме, ключ и тело проверены до вызова
    this.writer = {
      addComment: async (inst, key, body) => idOf(await api.addComment(inst, normalizeIssueKey(key), checkComment(body))),
      transitions: async (inst, key) => cleanTransitions(await api.transitions(inst, normalizeIssueKey(key))),
      transition: async (inst, key, id) => {
        await api.transition(inst, normalizeIssueKey(key), id);
      },
      logWork: async (inst, key, w) => {
        const { seconds, date, comment, aiTokens } = checkWork(w);
        const r: unknown = await api.logWork(inst, normalizeIssueKey(key), {
          seconds,
          started: date,
          ...(comment ? { comment } : {}),
          ...(aiTokens !== undefined ? { aiTokens } : {}),
        });
        // id Tempo — не id ворклога Jira в ленте задачи: событие найдётся по виду
        return r && typeof r === 'object' && (r as { via?: unknown }).via === 'jira' ? idOf(r) : {};
      },
    };
  }

  /** Ответ чужого расширения: не массив / бросил — пусто; записи без строковых `id`/`baseUrl` отбрасываются. */
  instances(): JiraInstanceRef[] {
    let raw: unknown;
    try {
      raw = this.api.instances();
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: JiraInstanceRef[] = [];
    for (const r of raw as Partial<JiraInstanceRef>[]) {
      if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 200 || typeof r.baseUrl !== 'string' || !/^https?:\/\//i.test(r.baseUrl)) continue;
      out.push({
        id: r.id,
        name: typeof r.name === 'string' && r.name ? r.name.slice(0, 200) : r.id,
        baseUrl: r.baseUrl,
        kind: r.kind === 'cloud' ? 'cloud' : 'dc',
      });
    }
    return out;
  }

  async issue(instanceId: string, key: string): Promise<{ issue: IssueDetail; worklogs: Worklog[] }> {
    return this.api.issue(instanceId, normalizeIssueKey(key));
  }

  myself(instanceId: string): Promise<MyselfResult> {
    return this.api.myself(instanceId);
  }

  async openIssue(instanceId: string, key: string, beside?: boolean): Promise<void> {
    return this.api.openIssue(instanceId, normalizeIssueKey(key), beside);
  }
}

export class OwnSource implements JiraSource {
  readonly kind = 'own' as const;
  readonly writer: JiraWriter;

  constructor(
    private readonly store: Pick<OwnInstanceStore, 'list' | 'get' | 'token'>,
    private readonly makeClient: (inst: OwnInstance, token: string) => JiraClient = createJiraClient,
  ) {
    this.writer = {
      addComment: async (inst, key, body) => {
        const k = normalizeIssueKey(key);
        const text = checkComment(body);
        return (await this.client(inst)).client.addComment(k, text);
      },
      transitions: async (inst, key) => {
        const k = normalizeIssueKey(key);
        return (await this.client(inst)).client.transitions(k);
      },
      transition: async (inst, key, id) => {
        const k = normalizeIssueKey(key);
        const { client } = await this.client(inst);
        // как у Jiraffe API v2: только переход из свежего списка и без обязательных полей экрана
        const t = (await client.transitions(k)).find((x) => x.id === id);
        if (!t) throw new Error(`transition "${String(id).slice(0, 50)}" is not available for ${k}`);
        if (t.requiresFields) throw new Error(`transition "${t.name}" requires screen fields; do it in Jira`);
        await client.transition(k, t.id);
      },
      logWork: async (inst, key, w) => {
        const k = normalizeIssueKey(key);
        const { seconds, date, comment, aiTokens } = checkWork(w);
        // своё подключение пишет стандартный worklog Jira (Tempo — только через Jiraffe; решение этапа 8)
        return (await this.client(inst)).client.addWorklog(k, { started: startedWithOffset(date), timeSpentSec: seconds, comment: aiTokens !== undefined ? appendAiTokens(comment, aiTokens) : comment });
      },
    };
  }

  instances(): JiraInstanceRef[] {
    return this.store.list().map(({ id, name, baseUrl, kind }) => ({ id, name, baseUrl, kind }));
  }

  private async client(instanceId: string): Promise<{ client: JiraClient; inst: OwnInstance }> {
    const inst = this.store.get(instanceId);
    if (!inst) throw new Error(`unknown instance "${instanceId.slice(0, 50)}"`);
    const token = await this.store.token(instanceId);
    if (!token) throw new Error('token not found in SecretStorage — connect the instance again');
    return { client: this.makeClient(inst, token), inst };
  }

  async issue(instanceId: string, key: string): Promise<{ issue: IssueDetail; worklogs: Worklog[] }> {
    const k = normalizeIssueKey(key);
    const { client, inst } = await this.client(instanceId);
    const { issue, worklogs } = await client.issueDetail(k, inst);
    return { issue, worklogs };
  }

  async myself(instanceId: string): Promise<MyselfResult> {
    const { client, inst } = await this.client(instanceId);
    const me = await client.myself();
    // как у Jiraffe: Cloud — только accountId, DC — только name
    return inst.kind === 'cloud' ? { accountId: me.id, displayName: me.displayName } : { name: me.name, displayName: me.displayName };
  }
}

export interface Availability {
  /** Jiraffe установлен и отдаёт API v1+. */
  jiraffe: boolean;
  /** Есть хотя бы одно своё подключение. */
  own: boolean;
}

/** Решение 3: какой источник работает при настройке `setting`. `auto` — Jiraffe, иначе свои; `jiraffe`/`own` — без подмены. */
export function resolveSourceKind(setting: JiraSourceSetting, av: Availability): 'jiraffe' | 'own' | undefined {
  switch (setting) {
    case 'off':
      return undefined;
    case 'jiraffe':
      return av.jiraffe ? 'jiraffe' : undefined;
    case 'own':
      return av.own ? 'own' : undefined;
    default:
      return av.jiraffe ? 'jiraffe' : av.own ? 'own' : undefined;
  }
}

/**
 * Состояние Jiraffe для страницы настроек (этап 6): нет расширения / нет API (старая версия, недоверенный воркспейс) / готов /
 * установлен, но не используется (`jira.source` = `own`|`off`: расширение не активируем, его API не держим).
 */
export type JiraffeState = 'absent' | 'no-api' | 'ready' | 'inactive';

export interface SourcesDeps {
  setting(): JiraSourceSetting;
  /** Установлено ли расширение Jiraffe (без активации). */
  jiraffeInstalled(): boolean;
  /** Активировать Jiraffe и вернуть его `exports` (может быть `undefined`); бросает, если активация не удалась. */
  jiraffeExports(): Promise<unknown>;
  own: OwnSource;
  parse(exports: unknown): JiraffeApi | undefined;
}

/**
 * Текущий источник Jira. `refresh()` пересчитывает состояние (старт, смена настройки, установка/удаление расширений,
 * изменение инстансов); `current()` и `forInstance()` — синхронные, по последнему результату. Jiraffe активируется только
 * при `auto`/`jiraffe`: при `own`/`off` расширение не трогаем.
 */
export class JiraSources {
  private jiraffe: JiraffeSource | undefined;
  private jiraffeState: JiraffeState = 'absent';
  private jiraffeSub: { dispose(): unknown } | undefined;
  private jiraffeApi: JiraffeApi | undefined;
  private readonly listeners = new Set<() => void>();
  private signature = '';
  private generation = 0;

  constructor(private readonly deps: SourcesDeps) {}

  setting(): JiraSourceSetting {
    return this.deps.setting();
  }

  jiraffeStatus(): { state: JiraffeState; instances: number; apiVersion?: number } {
    return {
      state: this.jiraffeState,
      instances: this.jiraffe?.instances().length ?? 0,
      ...(this.jiraffeApi ? { apiVersion: this.jiraffeApi.apiVersion } : {}),
    };
  }

  /** Инстансы Jiraffe (имена для страницы настроек); пусто, если API нет. */
  jiraffeInstances(): JiraInstanceRef[] {
    return this.jiraffe?.instances() ?? [];
  }

  /** Какой источник работает сейчас. */
  activeKind(): 'jiraffe' | 'own' | undefined {
    return this.current()?.kind;
  }

  /** Текущий источник умеет писать (свои подключения — да, Jiraffe — с API v2): страница «Интеграции», этап 8. */
  canWrite(): boolean {
    return !!this.current()?.writer;
  }

  ownInstances(): JiraInstanceRef[] {
    return this.deps.own.instances();
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    const setting = this.deps.setting();
    if (!this.deps.jiraffeInstalled()) {
      this.setJiraffe(undefined, 'absent');
    } else if (setting === 'auto' || setting === 'jiraffe') {
      let api: JiraffeApi | undefined;
      try {
        api = this.deps.parse(await this.deps.jiraffeExports());
      } catch {
        api = undefined;
      }
      if (gen !== this.generation) return; // за время активации пришёл более свежий refresh
      this.setJiraffe(api, api ? 'ready' : 'no-api');
    } else {
      this.setJiraffe(undefined, 'inactive');
    }
    this.notifyIfChanged();
  }

  private setJiraffe(api: JiraffeApi | undefined, state: JiraffeState): void {
    this.jiraffeState = state;
    if (api === this.jiraffeApi) return;
    this.jiraffeSub?.dispose();
    this.jiraffeSub = undefined;
    this.jiraffeApi = api;
    this.jiraffe = api ? new JiraffeSource(api) : undefined;
    // инстансы Jiraffe поменялись (добавили, сменили набор воркспейса) — пересчитать и сообщить
    try {
      this.jiraffeSub = api?.onDidChangeInstances?.(() => this.notifyIfChanged(true));
    } catch {
      this.jiraffeSub = undefined;
    }
  }

  /** Источник по настройке (решение 3). */
  current(): JiraSource | undefined {
    const kind = resolveSourceKind(this.deps.setting(), { jiraffe: !!this.jiraffe, own: this.deps.own.instances().length > 0 });
    return kind === 'jiraffe' ? this.jiraffe : kind === 'own' ? this.deps.own : undefined;
  }

  /**
   * Источник для инстанса задачи. При `auto` основной источник (Jiraffe) может не знать инстанс (вне набора воркспейса) —
   * тогда его знает второй, если он есть; при явных `jiraffe`/`own` подмены нет.
   */
  forInstance(instanceId: string): JiraSource | undefined {
    const cur = this.current();
    if (!cur) return undefined;
    if (cur.instances().some((i) => i.id === instanceId)) return cur;
    if (this.deps.setting() !== 'auto') return undefined;
    const other: JiraSource | undefined = cur.kind === 'jiraffe' ? this.deps.own : this.jiraffe;
    return other?.instances().some((i) => i.id === instanceId) ? other : undefined;
  }

  /** Все известные инстансы текущих источников (для выбора в командах): id → адрес. */
  allInstances(): JiraInstanceRef[] {
    const seen = new Map<string, JiraInstanceRef>();
    const cur = this.current();
    const sources: JiraSource[] = this.deps.setting() === 'auto' ? [cur, this.jiraffe, this.deps.own].filter((s): s is JiraSource => !!s) : cur ? [cur] : [];
    for (const s of sources) for (const i of s.instances()) if (!seen.has(i.id)) seen.set(i.id, i);
    return [...seen.values()];
  }

  onDidChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Подключения/настройка изменились без `refresh()` Jiraffe (свой список, `onDidChangeInstances`). */
  notifyIfChanged(force = false): void {
    const sig = JSON.stringify([
      this.deps.setting(),
      this.jiraffeState,
      !!this.jiraffe?.writer,
      this.jiraffe?.instances().map((i) => i.id) ?? [],
      this.deps.own.instances().map((i) => i.id),
    ]);
    if (!force && sig === this.signature) return;
    this.signature = sig;
    for (const l of [...this.listeners]) l();
  }

  dispose(): void {
    this.jiraffeSub?.dispose();
    this.listeners.clear();
  }
}
