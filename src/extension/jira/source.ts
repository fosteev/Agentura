import { createJiraClient, type JiraClient } from '../../data/jira/client';
import type { IssueDetail, Worklog } from '../../data/jira/types';
import type { JiraSourceSetting } from '../../settings';
import type { JiraffeApi } from './jiraffeApi';
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

/** Источник данных Jira: Jiraffe (его API v1) или своё подключение Agentura — один интерфейс для сервиса задачи. */
export interface JiraSource {
  readonly kind: 'jiraffe' | 'own';
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
  constructor(private readonly api: JiraffeApi) {}

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

  constructor(
    private readonly store: Pick<OwnInstanceStore, 'list' | 'get' | 'token'>,
    private readonly makeClient: (inst: OwnInstance, token: string) => JiraClient = createJiraClient,
  ) {}

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
