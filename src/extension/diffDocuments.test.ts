import { beforeEach, describe, expect, it, vi } from 'vitest';

// минимальный `vscode`: URI строкой, команды — в журнал
const calls: unknown[][] = [];
vi.mock('vscode', () => {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly path: string,
    ) {}
    static from(c: { scheme: string; path: string }) {
      return new Uri(c.scheme, c.path);
    }
    static file(p: string) {
      return new Uri('file', p);
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
  }
  class EventEmitter {
    event = () => undefined;
    fire() {}
    dispose() {}
  }
  return {
    Uri,
    EventEmitter,
    commands: { executeCommand: async (...a: unknown[]) => void calls.push(a) },
  };
});

const { DiffDocuments } = await import('./diffDocuments');
type Uri = { toString(): string };

const file = (filePath: string, key: string, before: string, after: string) => ({
  key,
  filePath,
  before,
  after,
  stage: 'applied' as const,
});

describe('DiffDocuments.openChanges', () => {
  beforeEach(() => void (calls.length = 0));

  it('vscode.changes(title, [ресурс, до, после][]); одинаковые имена файлов не схлопываются', async () => {
    const d = new DiffDocuments();
    await d.openChanges('t', [file('/p/a/x.ts', 'k1', 'a0', 'a1'), file('/p/b/x.ts', 'k2', 'b0', 'b1')]);
    const [cmd, title, list] = calls.at(-1) as [string, string, [Uri, Uri, Uri][]];
    expect(cmd).toBe('vscode.changes');
    expect(title).toBe('t');
    expect(list.map(([r]) => r.toString())).toEqual(['file:/p/a/x.ts', 'file:/p/b/x.ts']);
    const text = (u: Uri) => d.provideTextDocumentContent(u as never);
    expect(list.map(([, l, r]) => [text(l), text(r)])).toEqual([
      ['a0', 'a1'],
      ['b0', 'b1'],
    ]);
  });

  it('мульти-дифф больше лимита пар не вытесняет свои же документы', async () => {
    const d = new DiffDocuments();
    const files = Array.from({ length: 60 }, (_, i) => file(`/p/f${i}.ts`, `k${i}`, `b${i}`, `a${i}`));
    await d.openChanges('t', files);
    const list = (calls.at(-1) as [string, string, [Uri, Uri, Uri][]])[2];
    expect(d.provideTextDocumentContent(list[0]![1] as never)).toBe('b0');
    expect(d.provideTextDocumentContent(list[59]![2] as never)).toBe('a59');
  });

  it('колонка — фокус группы перед vscode.changes', async () => {
    const d = new DiffDocuments();
    await d.openChanges('t', [file('/p/a.ts', 'k', '', 'x')], 2);
    expect(calls.map((c) => c[0])).toEqual([
      'workbench.action.focusSecondEditorGroup',
      'vscode.changes',
    ]);
  });
});
