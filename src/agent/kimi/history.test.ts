import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from '../types';
import { KimiAdapter } from './adapter';
import { DEFAULT_KIMI_SESSION_ID, FakeKimiAcp, createFakeKimiServer } from './fakeServer';
import { buildKimiHistory } from './history';
import { KimiSessionIndex, memoryStore } from './sessionIndex';

interface Frame {
  dir: string;
  scenario: string;
  msg: { method?: string; params?: { update?: unknown }; result?: unknown };
}

async function historyFrames(): Promise<Frame[]> {
  return (await readFile(join(__dirname, '../../../test/fixtures/kimi/acp-history.ndjson'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Frame);
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((event) => events.push(event));
  return events;
}

async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout: ${what}`);
}

function adapter(server: FakeKimiAcp, state = memoryStore()): KimiAdapter {
  return new KimiAdapter({ executablePath: '/bin/kimi', spawn: () => server, state, graceMs: 20 });
}

describe('Kimi ACP history and globalState index', () => {
  it('replays real main user/text/thinking/tool frames without relying on synthetic turn prefixes', async () => {
    const frames = await historyFrames();
    const load = frames.filter((frame) => frame.scenario === 'session/load');
    const updates = load.filter((frame) => frame.dir === 'out' && frame.msg.method === 'session/update')
      .map((frame) => frame.msg.params?.update);
    const result = load.find((frame) => frame.msg.result)?.msg.result;
    const history = buildKimiHistory(updates, result, { now: () => 1000 });
    expect(history.turns).toBeGreaterThan(10);
    expect(history).toMatchObject({ skippedTurns: 0, model: 'kimi-code/k3.1-pro', mode: 'default' });
    expect(history.events.filter((event) => event.type === 'tool.start').map((event) => event.name))
      .toEqual(expect.arrayContaining(['Read', 'Grep', 'Bash', 'Write', 'Edit']));
    expect(history.events.filter((event) => event.type === 'tool.result').length).toBeGreaterThan(5);
    expect(history.events.some((event) => event.type === 'text.delta' && event.text === 'STREAM_MARKER_101')).toBe(true);
    expect(history.events.some((event) => event.type === 'tool.start' && event.toolUseId === '2:tool_vLw7WXVtrnTkRFZWshD0CL7P')).toBe(true);

    const tail = buildKimiHistory(updates, result, { maxTurns: 2, live: true, now: () => 2000 });
    expect(tail).toMatchObject({ turns: history.turns, skippedTurns: history.turns - 2 });
    expect(tail.events.filter((event) => event.type === 'turn.start')).toHaveLength(2);
    expect(tail.events.filter((event) => event.type === 'turn.result')).toHaveLength(1);
    expect(tail.events.at(-1)?.type).not.toBe('turn.result');

    const thinking = buildKimiHistory([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'think' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    ], result, { now: () => 3000 });
    expect(thinking.events.map((event) => event.type)).toEqual([
      'turn.start', 'thinking.start', 'thinking.delta', 'thinking.stop', 'text.delta', 'turn.result',
    ]);
  });

  it('loadHistory uses session/load and honors live/maxTurns through the adapter', async () => {
    const server = createFakeKimiServer();
    const frames = await historyFrames();
    const load = frames.filter((frame) => frame.scenario === 'session/load');
    server.handle('session/load', (params) => {
      for (const frame of load) {
        if (frame.dir === 'out' && frame.msg.method === 'session/update') {
          server.update(String(params.sessionId), frame.msg.params?.update);
        }
      }
      return load.find((frame) => frame.msg.result)?.msg.result;
    });
    const history = await adapter(server).loadHistory(DEFAULT_KIMI_SESSION_ID, '/work', { maxTurns: 1, live: true });
    expect(history.turns).toBeGreaterThan(10);
    expect(history.skippedTurns).toBe(history.turns - 1);
    expect(history.events.map((event) => event.type)).toEqual(['turn.start']);
    expect(server.paramsOf('session/load')).toEqual({
      sessionId: DEFAULT_KIMI_SESSION_ID, cwd: '/work', mcpServers: [],
    });
    expect(server.methods()).toContain('session/close');
    expect(server.methods()).not.toContain('session/delete');
  });

  it('listSessions filters cwd/realpath, sorts and overlays rename without session/delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentura-kimi-list-'));
    const alias = join(root, 'alias');
    try {
      await symlink(root, alias, 'dir');
      const server = createFakeKimiServer();
      server.handle('session/list', () => ({
        sessions: [
          { sessionId: 'older', cwd: root, title: 'Native old', updatedAt: '2026-11-12T20:00:00Z' },
          { sessionId: 'newer', cwd: root, title: 'Native new', updatedAt: '2026-11-13T20:00:00Z' },
          { sessionId: 'other', cwd: '/other', title: 'Other', updatedAt: '2026-11-14T20:00:00Z' },
        ],
      }));
      const state = memoryStore();
      const engine = adapter(server, state);
      await engine.renameSession('older', '  User\nname  ');
      const sessions = await engine.listSessions(alias);
      expect(sessions.map((session) => session.id)).toEqual(['newer', 'older']);
      expect(sessions[1]).toMatchObject({ title: 'User name', provider: 'kimi', cwd: alias });
      expect(server.paramsOf('session/list')).toEqual({ cwd: alias });
      expect(server.methods()).not.toContain('session/delete');
      await engine.renameSession('older', '');
      expect(new KimiSessionIndex(state).nameOf('older')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('listSessions filters empty unstarted sessions and preserves active or renamed ones', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentura-kimi-home-'));
    const work = join(home, 'work');
    try {
      await mkdir(work, { recursive: true });

      const idEmptyNoWire = 'session_a6b9fb6b-7f7d-404e-9cd1-000000000001';
      const idEmptyMetaOnly = 'session_a6b9fb6b-7f7d-404e-9cd1-000000000002';
      const idRenamedEmpty = 'session_a6b9fb6b-7f7d-404e-9cd1-000000000003';
      const idActiveWire = 'session_a6b9fb6b-7f7d-404e-9cd1-000000000004';
      const idNativeTitle = 'session_a6b9fb6b-7f7d-404e-9cd1-000000000005';

      const writeSession = async (id: string, wireLines?: string[]) => {
        const root = join(home, 'sessions/wd_test', id);
        await mkdir(join(root, 'agents/main'), { recursive: true });
        await writeFile(join(root, 'state.json'), JSON.stringify({
          version: 2, id, agents: { main: { type: 'main' } },
        }));
        if (wireLines) {
          await writeFile(join(root, 'agents/main/wire.jsonl'), wireLines.join('\n') + '\n');
        }
      };

      const meta = JSON.stringify({ type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' });
      const record = JSON.stringify({ type: 'context.append_loop_event', time: 1000 });

      // 1: empty session without wire.jsonl
      await writeSession(idEmptyNoWire);
      // 2: empty session with only metadata in wire.jsonl
      await writeSession(idEmptyMetaOnly, [meta]);
      // 4: active session with real turn event in wire.jsonl
      await writeSession(idActiveWire, [meta, record]);

      const server = createFakeKimiServer();
      server.handle('session/list', () => ({
        sessions: [
          { sessionId: idEmptyNoWire, cwd: work, title: '', updatedAt: '2026-11-15T10:00:00Z' },
          { sessionId: idEmptyMetaOnly, cwd: work, title: idEmptyMetaOnly, updatedAt: '2026-11-15T11:00:00Z' },
          { sessionId: idRenamedEmpty, cwd: work, title: '', updatedAt: '2026-11-15T12:00:00Z' },
          { sessionId: idActiveWire, cwd: work, title: idActiveWire, updatedAt: '2026-11-15T13:00:00Z' },
          { sessionId: idNativeTitle, cwd: work, title: 'Native Active', updatedAt: '2026-11-15T14:00:00Z' },
        ],
      }));

      const state = memoryStore();
      const engine = new KimiAdapter({
        executablePath: '/bin/kimi',
        spawn: () => server,
        state,
        graceMs: 20,
        env: { KIMI_CODE_HOME: home },
      });

      // 3: session without title, but renamed by user in KimiSessionIndex
      await engine.renameSession(idRenamedEmpty, 'User Renamed Draft');

      const sessions = await engine.listSessions(work);
      expect(sessions.map((s) => s.id)).toEqual([idNativeTitle, idActiveWire, idRenamedEmpty]);
      expect(sessions.find((s) => s.id === idEmptyNoWire)).toBeUndefined();
      expect(sessions.find((s) => s.id === idEmptyMetaOnly)).toBeUndefined();
      expect(sessions.find((s) => s.id === idRenamedEmpty)?.title).toBe('User Renamed Draft');
      expect(sessions.find((s) => s.id === idActiveWire)?.title).toBe(idActiveWire);
      expect(sessions.find((s) => s.id === idNativeTitle)?.title).toBe('Native Active');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('session_info_update cannot overwrite a custom live title; accountInfo stays factual', async () => {
    const state = memoryStore();
    const server = createFakeKimiServer();
    const engine = adapter(server, state);
    await engine.renameSession(DEFAULT_KIMI_SESSION_ID, 'User title');
    const session = await engine.createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('title');
    await until(() => events.some((event) => event.type === 'turn.result'), 'title turn');
    const titles = events.filter((event) => event.type === 'session.title');
    expect(titles.at(-1)).toMatchObject({ title: 'User title' });
    expect(titles.some((event) => event.title === 'Synthetic smoke')).toBe(false);
    expect(await engine.accountInfo('/work')).toEqual({});
    session.dispose();
  });
});
