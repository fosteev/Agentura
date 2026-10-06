/**
 * Собственные записи Agentura о беседах agy: (1) имя, заданное пользователем (`renameSession`) — у agy API
 * переименования нет, а `~/.gemini` мы не пишем; (2) индекс бесед, начатых из Agentura (id, папка, первое
 * сообщение) — запасной источник списка, когда `conversation_summaries.db` недоступна (`node:sqlite` нет в
 * Node хоста VS Code). Хранилище — подмножество `vscode.Memento` (`globalState`), без зависимости от `vscode`.
 */

export interface AgyStateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export interface AgyIndexEntry {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  firstPrompt?: string;
}

const SESSIONS_KEY = 'agentura.antigravity.sessions';
/** Имена — отдельным ключом: запись индекса из другого окна (последняя побеждает) не затирает переименование. */
const NAMES_KEY = 'agentura.antigravity.names';
/** Индекс не растёт без границ: старые записи (по `updatedAt`) отбрасываем. */
const MAX_ENTRIES = 500;
const MAX_PROMPT = 300;
const MAX_NAME = 200;

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

/**
 * Чтение-изменение-запись без `await` между ними: `Memento.update` меняет кэш окна синхронно, поэтому записи одного
 * окна не теряются. Между окнами `globalState` синхронизируется VS Code с задержкой — одновременная запись двух окон
 * может потерять одну запись индекса (не имя: у имён свой ключ); для запасного списка это допустимо.
 */
export class AgySessionIndex {
  constructor(private readonly store: AgyStateStore = memoryStore()) {}

  /** Значения `globalState` не доверяем (другая версия расширения, ручная правка): берём только целые записи. */
  private sessions(): Record<string, AgyIndexEntry> {
    const out: Record<string, AgyIndexEntry> = {};
    for (const [id, value] of objectEntries(this.store.get<unknown>(SESSIONS_KEY, undefined))) {
      const e = value as Partial<AgyIndexEntry> | null;
      if (!e || typeof e !== 'object' || e.id !== id || typeof e.cwd !== 'string') continue;
      if (!Number.isFinite(e.createdAt) || !Number.isFinite(e.updatedAt)) continue;
      const entry: AgyIndexEntry = { id, cwd: e.cwd, createdAt: e.createdAt as number, updatedAt: e.updatedAt as number };
      if (typeof e.firstPrompt === 'string' && e.firstPrompt) entry.firstPrompt = e.firstPrompt;
      out[id] = entry;
    }
    return out;
  }

  private names(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, name] of objectEntries(this.store.get<unknown>(NAMES_KEY, undefined)))
      if (typeof name === 'string' && name) out[id] = name;
    return out;
  }

  /** Беседа начата/продолжена из Agentura. `firstPrompt` сохраняется один раз. */
  async note(entry: { id: string; cwd: string; at: number; firstPrompt?: string }): Promise<void> {
    if (!entry.id) return;
    const sessions = this.sessions();
    const prev = sessions[entry.id];
    const next: AgyIndexEntry = {
      id: entry.id,
      cwd: entry.cwd,
      createdAt: prev?.createdAt ?? entry.at,
      updatedAt: entry.at,
    };
    const prompt = prev?.firstPrompt ?? entry.firstPrompt?.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);
    if (prompt) next.firstPrompt = prompt;
    sessions[entry.id] = next;
    const ids = Object.keys(sessions);
    if (ids.length > MAX_ENTRIES) {
      ids.sort((a, b) => (sessions[b]?.updatedAt ?? 0) - (sessions[a]?.updatedAt ?? 0));
      for (const id of ids.slice(MAX_ENTRIES)) delete sessions[id];
    }
    await this.store.update(SESSIONS_KEY, sessions);
  }

  entries(): AgyIndexEntry[] {
    return Object.values(this.sessions());
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
