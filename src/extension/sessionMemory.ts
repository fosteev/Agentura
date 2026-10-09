import type { SessionRef } from '../agent/types';
import { isProvider } from '../settings';
/** Минимум от `vscode.Memento`: тесты обходятся картой. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const OPEN = 'agentura.openSessions';
const ENGINE = 'agentura.engineVersion';

/**
 * Память воркспейса (`workspaceState`, этап 6): открытые вкладки (запас к состоянию webview для
 * сериализатора), версия движка. Сессии по задачам — `TaskGroups` (`taskGroups.ts`).
 */
export class SessionMemory {
  constructor(private readonly state: MementoLike) {}

  /** Старый `string[]` мигрируется как Claude-сессии. */
  openSessions(): SessionRef[] {
    const v = this.state.get<unknown>(OPEN);
    if (!Array.isArray(v)) return [];
    const refs = v.flatMap((x): SessionRef[] => {
      if (typeof x === 'string') return [{ provider: 'claude', id: x }];
      if (
        x &&
        typeof x === 'object' &&
        isProvider((x as SessionRef).provider) &&
        typeof (x as SessionRef).id === 'string' &&
        (x as SessionRef).id
      )
        return [{ provider: (x as SessionRef).provider, id: (x as SessionRef).id }];
      return [];
    });
    return refs.filter((ref, index) => refs.findIndex((x) => x.provider === ref.provider && x.id === ref.id) === index);
  }

  setOpenSessions(refs: readonly SessionRef[]): void {
    const unique = refs.filter(
      (ref, index) => refs.findIndex((x) => x.provider === ref.provider && x.id === ref.id) === index,
    );
    void this.state.update(OPEN, unique);
  }

  engineVersion(): string | undefined {
    const v = this.state.get<unknown>(ENGINE);
    return typeof v === 'string' ? v : undefined;
  }

  setEngineVersion(label: string): void {
    void this.state.update(ENGINE, label);
  }
}
