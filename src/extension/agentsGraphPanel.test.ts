import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWebview, ToWebview } from '../protocol';
import type { AgentGraphView } from '../shared/agentsGraph';

/** Вкладка-webview без VS Code: сообщения в журнал, `dispose` зовёт подписчиков `onDidDispose`. */
class FakePanel {
  title: string;
  visible = true;
  iconPath: unknown;
  disposed = false;
  readonly posted: ToWebview[] = [];
  readonly reveals: unknown[][] = [];
  private readonly onDispose: (() => void)[] = [];
  private readonly onView: ((e: { webviewPanel: FakePanel }) => void)[] = [];
  /** Обработчик сообщений webview — ставит `attachMessaging`. */
  receive: ((m: FromWebview) => void) | undefined;
  readonly webview = {
    options: {},
    html: '',
    postMessage: async (m: ToWebview) => {
      this.posted.push(m);
      return true;
    },
  };
  constructor(
    readonly viewType: string,
    title: string,
    readonly column: unknown,
  ) {
    this.title = title;
  }
  reveal(...a: unknown[]) {
    this.reveals.push(a);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose.splice(0).forEach((f) => f());
  }
  onDidDispose(f: () => void) {
    this.onDispose.push(f);
    return { dispose: () => {} };
  }
  onDidChangeViewState(f: (e: { webviewPanel: FakePanel }) => void) {
    this.onView.push(f);
    return { dispose: () => {} };
  }
  setVisible(v: boolean) {
    this.visible = v;
    this.onView.forEach((f) => f({ webviewPanel: this }));
  }
}

const created: FakePanel[] = [];
vi.mock('vscode', () => ({
  ViewColumn: { Beside: -2, Active: -1 },
  Uri: { joinPath: (...p: unknown[]) => p.join('/') },
  window: {
    createWebviewPanel: (type: string, title: string, column: unknown) => {
      const p = new FakePanel(type, title, column);
      created.push(p);
      return p;
    },
  },
}));
vi.mock('./webviewHost', () => ({
  attachMessaging: (webview: FakePanel['webview'], _s: string, _v: string, _l: unknown, on: (m: FromWebview) => void) => {
    const panel = created.find((p) => p.webview === webview) ?? restored.find((p) => p.webview === webview);
    panel!.receive = on;
    return { dispose: () => {} };
  },
  renderWebview: () => '<html></html>',
  currentLanguage: () => 'ru',
  userFontsDir: () => 'fonts',
  webviewOptions: () => ({}),
}));

const restored: FakePanel[] = [];
const { AGENTS_GRAPH_VIEW_TYPE, AgentsGraphPanel, ChatGraphSlot, GRAPH_RESTORE_MS, graphSerializer } = await import(
  './agentsGraphPanel'
);

const context = {
  extensionUri: 'ext',
  globalStorageUri: 'storage',
  extension: { packageJSON: { version: '0.2.0' } },
} as never;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const view: AgentGraphView = {
  title: 'починка табло',
  main: { limit: 200_000, state: 'working', turnNo: 1 },
  turns: [],
  agents: [],
};

/** Вкладка чата: сессия, её webview (журнал) и обработчик действий. */
function chat(sessionId: string | undefined) {
  const posted: ToWebview[] = [];
  const handled: FromWebview[] = [];
  let id = sessionId;
  const slot = new ChatGraphSlot(
    {
      sessionId: () => id,
      post: (m) => posted.push(m),
      handle: (m) => void handled.push(m),
    },
    () => AgentsGraphPanel.create(context, log),
  );
  return { slot, posted, handled, setSession: (s: string | undefined) => (id = s) };
}

const flags = (msgs: ToWebview[]) =>
  msgs.filter((m) => m.type === 'agents.graph').map((m) => (m as { open: boolean }).open);

beforeEach(() => {
  created.length = 0;
  restored.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('ChatGraphSlot + AgentsGraphPanel', () => {
  it('одна вкладка графа на чат: рядом (Beside), повторное открытие — reveal и выбор агента', () => {
    const c = chat('s1');
    c.slot.show();
    expect(created).toHaveLength(1);
    const p = created[0]!;
    expect(p.viewType).toBe(AGENTS_GRAPH_VIEW_TYPE);
    expect(p.column).toMatchObject({ viewColumn: -2 });
    expect(p.title).toBe('Агенты');
    p.receive!({ type: 'ready' });
    c.slot.show('tool-2');
    expect(created).toHaveLength(1);
    expect(p.reveals.at(-1)).toEqual([undefined, false]);
    expect(p.posted.at(-1)).toEqual({ type: 'agents.focus', agentId: 'tool-2' });
  });

  it('снимок чата доходит до вкладки графа, заголовок «Агенты · <сессия>»; stop из графа — в свой чат', () => {
    const c = chat('s1');
    c.slot.show();
    const p = created[0]!;
    expect(flags(c.posted)).toEqual([true]);
    p.receive!({ type: 'ready' });
    c.slot.snapshot({ type: 'agents.snapshot', sessionId: 's1', graph: view });
    expect(p.posted.at(-1)).toEqual({ type: 'agents.snapshot', sessionId: 's1', graph: view });
    expect(p.title).toBe('Агенты · починка табло');
    p.receive!({ type: 'agent.stop', sessionId: 's1', taskId: 't1' });
    expect(c.handled).toEqual([{ type: 'agent.stop', sessionId: 's1', taskId: 't1' }]);
  });

  it('два чата — два графа, действия каждого — в свой чат', () => {
    const a = chat('s1');
    const b = chat('s2');
    a.slot.show();
    b.slot.show();
    expect(created).toHaveLength(2);
    created[1]!.receive!({ type: 'agent.stop', sessionId: 's2', taskId: 't' });
    created[1]!.receive!({ type: 'agent.stop', sessionId: 's1', taskId: 't' });
    expect(a.handled).toHaveLength(0);
    expect(b.handled).toEqual([{ type: 'agent.stop', sessionId: 's2', taskId: 't' }]);
  });

  it('закрытие чата закрывает граф; чат снова открывает новый', () => {
    const c = chat('s1');
    c.slot.show();
    c.slot.close();
    expect(created[0]!.disposed).toBe(true);
    expect(c.slot.open).toBe(false);
    expect(flags(c.posted)).toEqual([true, false]);
    c.slot.show();
    expect(created).toHaveLength(2);
  });

  it('граф закрыли руками — слот пуст, чат перестаёт слать снимки', () => {
    const c = chat('s1');
    c.slot.show();
    created[0]!.dispose();
    expect(c.slot.open).toBe(false);
    expect(flags(c.posted)).toEqual([true, false]);
  });

  it('вкладку графа скрыли и показали — чату «закрыт» / «открыт»', () => {
    const c = chat('s1');
    c.slot.show();
    created[0]!.setVisible(false);
    created[0]!.setVisible(true);
    expect(flags(c.posted)).toEqual([true, false, true]);
  });
});

describe('graphSerializer: перезагрузка окна', () => {
  const restore = async (slots: ReturnType<typeof chat>[], state: unknown) => {
    const p = new FakePanel(AGENTS_GRAPH_VIEW_TYPE, 'Агенты', 1);
    restored.push(p);
    await graphSerializer(context, log, () => slots.map((s) => s.slot)).deserializeWebviewPanel(
      p as never,
      state,
    );
    return p;
  };

  it('граф возвращается к чату своей сессии, не к чужому', async () => {
    const other = chat('s0');
    const own = chat('s1');
    const p = await restore([other, own], { sessionId: 's1', graph: { turn: 3 } });
    expect(p.disposed).toBe(false);
    expect(own.slot.open).toBe(true);
    expect(other.slot.open).toBe(false);
    expect(flags(own.posted)).toEqual([true]);
    expect(p.webview.html).toBe('<html></html>');
  });

  it('у графа не было сессии — вкладка закрывается', async () => {
    const p = await restore([chat(undefined)], {});
    expect(p.disposed).toBe(true);
  });

  it('чат восстановлен позже — забирает свой граф; не дождались — граф закрыт', async () => {
    vi.useFakeTimers();
    const late = chat(undefined);
    const p = await restore([late], { sessionId: 's1' });
    expect(p.disposed).toBe(false);
    expect(late.slot.open).toBe(false);
    late.setSession('s1');
    late.slot.claimPending();
    expect(late.slot.open).toBe(true);
    vi.advanceTimersByTime(GRAPH_RESTORE_MS + 1);
    expect(p.disposed).toBe(false);

    const q = await restore([], { sessionId: 's9' });
    vi.advanceTimersByTime(GRAPH_RESTORE_MS + 1);
    expect(q.disposed).toBe(true);
    // закрытый по таймеру граф чат той же сессии уже не заберёт
    const s9 = chat('s9');
    s9.slot.claimPending();
    expect(s9.slot.open).toBe(false);
  });
});
