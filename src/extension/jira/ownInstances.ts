import { createHash } from 'node:crypto';
import type { Instance, InstanceKind } from '../../data/jira/types';
import type { MementoLike } from '../sessionMemory';

/** Минимум от `vscode.SecretStorage`. */
export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

/** Своё подключение: инстансы воркспейса; токен — в SecretStorage, не здесь. Без `caps`/`epicLinkField` (решение 4). */
export type OwnInstance = Pick<Instance, 'id' | 'name' | 'baseUrl' | 'kind' | 'email'>;

export const OWN_INSTANCES_KEY = 'agentura.jira.instances';
export const ownTokenKey = (wsId: string, instanceId: string): string => `agentura.jira.token.${wsId}.${instanceId}`;

/** sha1 от URI первой папки воркспейса; без папки — `global`. SecretStorage общий для всех окон, поэтому токен привязан к воркспейсу. */
export function workspaceId(firstFolderUri: string | undefined): string {
  return firstFolderUri ? createHash('sha1').update(firstFolderUri).digest('hex') : 'global';
}

const ID_RE = /^[a-z0-9-]{1,200}$/;
const MAX_NAME = 200;

/** Из `workspaceState` приходит что угодно (файл состояния можно править): невалидные записи отбрасываются. */
export function readOwnInstances(raw: unknown): OwnInstance[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OwnInstance[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const { id, name, baseUrl, kind, email } = r;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) continue;
    if (kind !== 'dc' && kind !== 'cloud') continue;
    seen.add(id);
    out.push({
      id,
      name: name.trim().slice(0, MAX_NAME),
      baseUrl: baseUrl.replace(/\/+$/, ''),
      kind: kind as InstanceKind,
      ...(typeof email === 'string' && email ? { email } : {}),
    });
  }
  return out;
}

/** Хранилище своих подключений Jira в воркспейсе (решение 4). */
export class OwnInstanceStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly state: MementoLike,
    private readonly secrets: SecretsLike,
    private readonly wsId: string,
  ) {}

  list(): OwnInstance[] {
    return readOwnInstances(this.state.get<unknown>(OWN_INSTANCES_KEY));
  }

  get(id: string): OwnInstance | undefined {
    return this.list().find((i) => i.id === id);
  }

  /** Токен подключения; нет — `undefined` (удалён из SecretStorage). */
  token(id: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(ownTokenKey(this.wsId, id)));
  }

  /** Добавить или заменить подключение с тем же id. */
  async add(inst: OwnInstance, token: string): Promise<void> {
    await this.secrets.store(ownTokenKey(this.wsId, inst.id), token);
    await this.state.update(OWN_INSTANCES_KEY, [...this.list().filter((i) => i.id !== inst.id), inst]);
    this.emit();
  }

  async remove(id: string): Promise<void> {
    await this.state.update(OWN_INSTANCES_KEY, this.list().filter((i) => i.id !== id));
    await this.secrets.delete(ownTokenKey(this.wsId, id));
    this.emit();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
