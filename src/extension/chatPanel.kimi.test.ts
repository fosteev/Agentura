import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ adapter: vi.fn(), resolve: vi.fn() }));
vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => () => undefined;
    fire(): void {}
    dispose(): void {}
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }), fs: {} },
  window: {},
  env: { openExternal: () => undefined },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }), parse: (s: string) => s },
  ViewColumn: { Active: -1 },
  FileType: { File: 1, Directory: 2 },
  Range: class Range {},
  commands: { executeCommand: () => undefined },
}));
vi.mock('../agent/kimi/adapter', () => ({
  KimiAdapter: class {
    readonly id = 'kimi';
    constructor(config: unknown) { h.adapter(config); }
  },
}));
vi.mock('../agent/kimi/executable', () => ({
  KIMI_NOT_FOUND: 'missing',
  resolveKimiExecutable: h.resolve,
}));

import { createAdapter } from './chatPanel';

describe('createAdapter: Kimi', () => {
  it('adapter и resolver ленивы: активация не выбирает Kimi и не запускает его процесс', () => {
    h.adapter.mockClear();
    h.resolve.mockReset();
    const services = createAdapter({ info: vi.fn(), warn: vi.fn() } as never, 'test');
    expect(h.adapter).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
    const first = services.kimiAdapter();
    expect(services.kimiAdapter()).toBe(first);
    expect(h.adapter).toHaveBeenCalledTimes(1);
    expect(h.resolve).not.toHaveBeenCalled(); // constructor/index не запускают даже --version
  });
});
