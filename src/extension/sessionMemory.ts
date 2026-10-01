/** Минимум от `vscode.Memento`: тесты обходятся картой. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const OPEN = 'agentura.openSessions';
const ENGINE = 'agentura.engineVersion';

/**
 * Память воркспейса (`workspaceState`, этап 6): открытые вкладки (запас к состоянию webview для
 * сериализатора) и версия движка.
 */
export class SessionMemory {
  constructor(private readonly state: MementoLike) {}

  openSessions(): string[] {
    const v = this.state.get<unknown>(OPEN);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  setOpenSessions(ids: readonly string[]): void {
    void this.state.update(OPEN, [...new Set(ids)]);
  }

  engineVersion(): string | undefined {
    const v = this.state.get<unknown>(ENGINE);
    return typeof v === 'string' ? v : undefined;
  }

  setEngineVersion(label: string): void {
    void this.state.update(ENGINE, label);
  }
}
