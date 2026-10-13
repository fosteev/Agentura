import type { MementoLike } from './sessionMemory';

const KEY = 'agentura.archivedSessions';

/**
 * Архив чатов в боковой панели (`workspaceState`, ключ `agentura.archivedSessions`): id скрытых из основного списка
 * сессий, новые в конце. Надстройка Agentura — движки о ней не знают, файлы сессий не трогаются.
 */
export class ArchivedSessions {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly state: MementoLike) {}

  private read(): string[] {
    const raw = this.state.get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string' && v !== '');
  }

  ids(): ReadonlySet<string> {
    return new Set(this.read());
  }

  has(id: string): boolean {
    return this.read().includes(id);
  }

  add(id: string): void {
    if (!id) return;
    const all = this.read();
    if (all.includes(id)) return;
    this.save([...all, id]);
  }

  remove(id: string): void {
    const all = this.read();
    if (!all.includes(id)) return;
    this.save(all.filter((v) => v !== id));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private save(ids: string[]): void {
    void this.state.update(KEY, ids.length ? ids : undefined);
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // слушатель не должен ломать запись
      }
    }
  }
}
