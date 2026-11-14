import type { EffortLevel, PermissionMode } from '../types';

export interface KimiSessionSettings {
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
}

/** Подмножество `vscode.Memento` (`globalState`), без зависимости адаптера от `vscode`. */
export interface KimiStateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

const NAMES_KEY = 'agentura.kimi.names';
const SETTINGS_KEY = 'agentura.kimi.sessionSettings';
const MAX_NAME = 200;

export function memoryStore(): KimiStateStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T) => (map.has(key) ? map.get(key) as T : fallback),
    update: (key, value) => void map.set(key, value),
  };
}

function objectEntries(value: unknown): [string, unknown][] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
}

/** ACP rename не объявлен: имена и подтверждённые настройки живут только в индексе Agentura. */
export class KimiSessionIndex {
  constructor(private readonly store: KimiStateStore = memoryStore()) {}

  nameOf(id: string): string | undefined {
    const names = this.names();
    return Object.hasOwn(names, id) ? names[id] : undefined;
  }

  async rename(id: string, title: string): Promise<void> {
    const names = this.names();
    const name = title.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (name) names[id] = name;
    else delete names[id];
    await this.store.update(NAMES_KEY, names);
  }

  settingsOf(id: string): KimiSessionSettings | undefined {
    const settings = this.store.get<Record<string, KimiSessionSettings>>(SETTINGS_KEY, {});
    return Object.hasOwn(settings, id) ? settings[id] : undefined;
  }

  async saveSettings(id: string, settings: KimiSessionSettings): Promise<void> {
    const all = this.store.get<Record<string, KimiSessionSettings>>(SETTINGS_KEY, {});
    await this.store.update(SETTINGS_KEY, { ...all, [id]: settings });
  }

  private names(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, name] of objectEntries(this.store.get<unknown>(NAMES_KEY, undefined))) {
      if (typeof name === 'string' && name) out[id] = name;
    }
    return out;
  }
}
