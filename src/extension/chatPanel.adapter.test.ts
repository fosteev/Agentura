import { describe, expect, it, vi } from 'vitest';

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

import type { AgentAdapter } from '../agent/types';
import { adapterOf, engineOf, type ChatServices } from './chatPanel';

function services(): ChatServices & {
  marks: { claude: AgentAdapter; codex: AgentAdapter; agy: AgentAdapter; cursor: AgentAdapter };
} {
  const marks = {
    claude: { id: 'claude' } as unknown as AgentAdapter,
    codex: { id: 'codex' } as unknown as AgentAdapter,
    agy: { id: 'agy' } as unknown as AgentAdapter,
    cursor: { id: 'cursor' } as unknown as AgentAdapter,
  };
  const engines = {
    claude: { id: 'loc-claude' },
    codex: { id: 'loc-codex' },
    agy: { id: 'loc-agy' },
    cursor: { id: 'loc-cursor' },
  };
  return {
    marks,
    adapter: marks.claude,
    codexAdapter: () => marks.codex,
    antigravityAdapter: () => marks.agy,
    cursorAdapter: () => marks.cursor,
    engine: engines.claude,
    codexEngine: engines.codex,
    antigravityEngine: engines.agy,
    cursorEngine: engines.cursor,
  } as unknown as ChatServices & { marks: typeof marks };
}

describe('adapterOf / engineOf', () => {
  it('cursor идёт в свой адаптер и локатор, а не в Claude', () => {
    const s = services();
    expect(adapterOf(s, 'cursor')).toBe(s.marks.cursor);
    expect(adapterOf(s, 'codex')).toBe(s.marks.codex);
    expect(adapterOf(s, 'antigravity')).toBe(s.marks.agy);
    expect(adapterOf(s, 'claude')).toBe(s.marks.claude);
    expect(adapterOf(s, undefined)).toBe(s.marks.claude);
    expect(engineOf(s, 'cursor')).toBe(s.cursorEngine);
    expect(engineOf(s, 'codex')).toBe(s.codexEngine);
    expect(engineOf(s, 'antigravity')).toBe(s.antigravityEngine);
    expect(engineOf(s, 'claude')).toBeUndefined();
    expect(engineOf(s, undefined)).toBeUndefined();
  });
});
