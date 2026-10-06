import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventOf, AgentSession } from '../types';
import { AGY_RETRY_PROMPT, AntigravityAdapter, isAgySession, type AntigravityAdapterConfig } from './adapter';
import { FAKE_CONVERSATION, fakeSpawn, type FakeAgy } from './fakeAgy';

const FILE = '/tmp/agentura-agy/hello.txt';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agy-edits-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function putTranscript(): Promise<void> {
  const dir = join(root, 'brain', FAKE_CONVERSATION, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'transcript_full.jsonl'),
    readFileSync(new URL('../../../test/fixtures/antigravity/transcript_full.jsonl', import.meta.url), 'utf8'),
  );
}

function setup(script: Parameters<typeof fakeSpawn>[0], config: Partial<AntigravityAdapterConfig> = {}) {
  const { spawn, spawns } = fakeSpawn(script);
  const logs: string[] = [];
  const adapter = new AntigravityAdapter({
    executablePath: '/bin/agy',
    spawn,
    graceMs: 30,
    agyRoot: root,
    transcriptRetries: 1,
    transcriptDelayMs: 5,
    log: (level, message) => logs.push(`${level}: ${message}`),
    listProcesses: async () => [],
    killPid: () => undefined,
    ...config,
  });
  return { adapter, spawns, logs };
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((e) => events.push(e));
  return events;
}
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is AgentEventOf<T> => e.type === type);
const results = (events: AgentEvent[]) => of(events, 'turn.result');
const arg = (agy: FakeAgy, name: string) => agy.args[agy.args.indexOf(name) + 1];

/** Ход с одной правкой (шаг tool 4 — как в записанном transcript_full) и ответом. */
const editTurn = (agy: FakeAgy) => {
  agy.onUser = () => {
    agy.step({ state: 'DONE', step_type: 'user_input' });
    const tool = { tool_name: 'replace_file_content', step_type: 'tool' } as const;
    agy.step({ step_index: 4, state: 'ACTIVE', ...tool, tool_info: { name: tool.tool_name, parameters: { TargetFile: FILE } } });
    agy.step({ step_index: 4, state: 'DONE', ...tool, duration_seconds: 0.1, tool_info: { name: tool.tool_name, parameters: { TargetFile: FILE } } });
    agy.step({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'done', usage: { input_tokens: 10, output_tokens: 2 } });
    agy.result({ status: 'SUCCESS', response: 'done' });
  };
  setTimeout(() => agy.init(), 0);
};

describe('AntigravityAdapter: диффы правок', () => {
  it('DONE правки → tool.result со structuredPatch из транскрипта, до turn.result', async () => {
    await putTranscript();
    const { adapter } = setup(editTurn);
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    const events = collect(session);
    session.send('edit');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    const start = of(events, 'tool.start')[0];
    expect(start).toMatchObject({ name: 'Edit', input: { file_path: FILE } });
    const result = of(events, 'tool.result')[0];
    expect(result?.isError).toBe(false);
    expect(result?.result).toMatchObject({
      filePath: FILE,
      oldString: 'hi',
      newString: 'hello world',
      structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-hi', '+hello world', ' '] }],
    });
    const order = events.map((e) => e.type);
    expect(order.indexOf('tool.result')).toBeLessThan(order.indexOf('turn.result'));
    expect(order.indexOf('tool.start')).toBeLessThan(order.indexOf('tool.result'));
    session.dispose();
  });

  it('транскрипта нет: карточка без диффа, без ошибки, ход заканчивается', async () => {
    const { adapter, logs } = setup(editTurn);
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    const events = collect(session);
    session.send('edit');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    const result = of(events, 'tool.result')[0];
    expect(result).toMatchObject({ toolUseId: 'agy-4', isError: false });
    expect(result?.result).toBeUndefined();
    expect(of(events, 'error')).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([]);
    expect(results(events)[0]?.ok).toBe(true);
    session.dispose();
  });

  it('порядок событий сохраняется, пока дифф подгружается: следующие шаги ждут', async () => {
    await putTranscript();
    const { adapter } = setup(editTurn);
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    const events = collect(session);
    session.send('edit');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(events.map((e) => e.type).filter((t) => t !== 'session.init')).toEqual([
      'turn.start',
      'tool.start',
      'tool.result',
      'text.delta',
      'usage.message',
      'turn.result',
    ]);
    session.dispose();
  });
});

describe('AntigravityAdapter: дифф не держит ленту', () => {
  it('чтение транскрипта дольше editTimeoutMs — tool.result без диффа, ход закрывается', async () => {
    const { adapter, logs } = setup(editTurn, { transcriptRetries: 1000, transcriptDelayMs: 20, editTimeoutMs: 60 });
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    const events = collect(session);
    session.send('edit');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(of(events, 'tool.result')[0]?.result).toBeUndefined();
    expect(logs.some((l) => /timed out/.test(l))).toBe(true);
    session.dispose();
  });

  it('Stop, пока дифф подгружается: interrupt завершается, ход закрыт', async () => {
    const slow = (agy: FakeAgy) => {
      agy.onUser = () => {
        agy.step({ state: 'DONE', step_type: 'user_input' });
        const tool = { tool_name: 'replace_file_content', step_type: 'tool' } as const;
        agy.step({ step_index: 4, state: 'DONE', ...tool, tool_info: { name: tool.tool_name, parameters: { TargetFile: FILE } } });
      };
      setTimeout(() => agy.init(), 0);
    };
    const { adapter } = setup(slow, { transcriptRetries: 1000, transcriptDelayMs: 20, editTimeoutMs: 150 });
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    const events = collect(session);
    session.send('edit');
    await vi.waitFor(() => expect(of(events, 'turn.start')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    await session.interrupt();
    expect(results(events)).toHaveLength(1);
    expect(results(events)[0]).toMatchObject({ interrupted: true });
    session.dispose();
  });
});

describe('AntigravityAdapter: отказы и повтор с режимом', () => {
  const deniedTurn = (agy: FakeAgy, n: number) => {
    agy.onUser = () => {
      if (n === 0) {
        agy.step({ state: 'DONE', step_type: 'user_input' });
        agy.step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: FILE } } });
        agy.step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', error: { message: 'permission check failed for write_file: user denied permission' } } });
        agy.result({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteToFile' }] });
      } else agy.answer('retried');
    };
    setTimeout(() => agy.init(), 0);
  };

  it('отказ сам режим не меняет: процесс остаётся без флагов, bypass не включается', async () => {
    const { adapter, spawns } = setup((agy, n) => deniedTurn(agy, n));
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy', allowBypassPermissions: true });
    const events = collect(session);
    session.send('write');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(results(events)[0]?.permissionDenials).toEqual([{ toolName: 'Write', toolUseId: 'agy-2' }]);
    expect(of(events, 'mode.changed')).toHaveLength(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args).not.toContain('--mode');
    expect(spawns[0]?.args).not.toContain('--dangerously-skip-permissions');
    session.dispose();
  });

  it('retryWithMode(acceptEdits): новый процесс с --conversation и --mode accept-edits, служебный повтор без пузыря', async () => {
    const { adapter, spawns } = setup((agy, n) => deniedTurn(agy, n));
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    expect(isAgySession(session)).toBe(true);
    if (!isAgySession(session)) return;
    const events = collect(session);
    session.send('write');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));

    expect(await session.retryWithMode('acceptEdits')).toBe(true);
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect(of(events, 'mode.changed')).toEqual([{ type: 'mode.changed', mode: 'acceptEdits' }]);
    expect(spawns).toHaveLength(2);
    const second = spawns[1] as FakeAgy;
    expect(arg(second, '--conversation')).toBe(FAKE_CONVERSATION);
    expect(arg(second, '--mode')).toBe('accept-edits');
    expect(second.received).toEqual([{ event: 'user', message: { role: 'user', content: AGY_RETRY_PROMPT } }]);
    const starts = of(events, 'turn.start');
    expect(starts[0]?.prompt).toBe('write');
    expect(starts[1]?.prompt).toBeUndefined();
    session.dispose();
  });

  it('retryWithMode(bypassPermissions) без разрешения в настройках — false, процесс не трогаем', async () => {
    const { adapter, spawns, logs } = setup((agy, n) => deniedTurn(agy, n));
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy' });
    if (!isAgySession(session)) throw new Error('not an agy session');
    const events = collect(session);
    session.send('write');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(await session.retryWithMode('bypassPermissions')).toBe(false);
    expect(spawns).toHaveLength(1);
    expect(of(events, 'mode.changed')).toHaveLength(0);
    expect(logs.some((l) => /bypassPermissions is not allowed/.test(l))).toBe(true);
    session.dispose();
  });

  it('retryWithMode(bypassPermissions) с разрешением — --dangerously-skip-permissions; закрытая сессия — false', async () => {
    const { adapter, spawns } = setup((agy, n) => deniedTurn(agy, n));
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy', allowBypassPermissions: true });
    if (!isAgySession(session)) throw new Error('not an agy session');
    const events = collect(session);
    session.send('write');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(await session.retryWithMode('bypassPermissions')).toBe(true);
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect(spawns[1]?.args).toContain('--dangerously-skip-permissions');
    session.dispose();
    expect(await session.retryWithMode('acceptEdits')).toBe(false);
  });

  it('retryWithMode: чужой режим, тот же режим или понижение из bypass — false', async () => {
    const { adapter, spawns } = setup((agy, n) => deniedTurn(agy, n));
    const session = await adapter.createSession({ cwd: '/tmp/agentura-agy', permissionMode: 'acceptEdits', allowBypassPermissions: true });
    if (!isAgySession(session)) throw new Error('not an agy session');
    expect(await session.retryWithMode('plan' as never)).toBe(false);
    expect(await session.retryWithMode('acceptEdits')).toBe(false);
    await session.setMode('bypassPermissions');
    expect(await session.retryWithMode('acceptEdits')).toBe(false);
    expect(spawns).toHaveLength(1);
    session.dispose();
  });
});
