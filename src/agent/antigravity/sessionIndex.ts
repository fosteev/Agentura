import type { EffortLevel, PermissionMode } from '../types';

export interface AgySessionSettings {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

/**
 * Пользовательские имена сессий Antigravity (`renameSession`): у agy своего API
 * переименования нет, а `~/.gemini` мы не пишем.
 * Хранилище — подмножество `vscode.Memento` (`globalState`), без зависимости от `vscode`.
 */

export interface AgyStateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

const NAMES_KEY = 'agentura.antigravity.names';
const MAX_NAME = 200;
const SETTINGS_KEY = 'agentura.antigravity.sessionSettings';

export function memoryStore(): AgyStateStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T) => (map.has(key) ? (map.get(key) as T) : fallback),
    update: (key, value) => void map.set(key, value),
  };
}

function objectEntries(value: unknown): [string, unknown][] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
}

export class AgySessionIndex {
  constructor(private readonly store: AgyStateStore = memoryStore()) {}

  settingsOf(id: string): AgySessionSettings | undefined {
    const settings = this.store.get<Record<string, AgySessionSettings>>(SETTINGS_KEY, {});
    return Object.hasOwn(settings, id) ? settings[id] : undefined;
  }

  async saveSettings(id: string, settings: AgySessionSettings): Promise<void> {
    const all = this.store.get<Record<string, AgySessionSettings>>(SETTINGS_KEY, {});
    await this.store.update(SETTINGS_KEY, { ...all, [id]: settings });
  }

  private names(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, name] of objectEntries(this.store.get<unknown>(NAMES_KEY, undefined))) {
      if (typeof name === 'string' && name) out[id] = name;
    }
    return out;
  }

  nameOf(id: string): string | undefined {
    const names = this.names();
    return Object.hasOwn(names, id) ? names[id] : undefined;
  }

  /** Пустое имя снимает своё имя — снова заголовок agy. */
  async rename(id: string, title: string): Promise<void> {
    const names = this.names();
    const name = title.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (name) names[id] = name;
    else delete names[id];
    await this.store.update(NAMES_KEY, names);
  }
}
