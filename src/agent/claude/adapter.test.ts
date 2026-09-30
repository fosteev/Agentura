import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../types';
import { AsyncQueue } from '../stream';
import { ClaudeAdapter, engineEnv } from './adapter';

/** Поддельный SDK: запоминает опции `query()`, отдаёт входящие сообщения и выдаёт заданный поток. */
function fakeSdk(extra: Record<string, unknown> = {}) {
  const calls: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }[] = [];
  const out = new AsyncQueue<unknown>();
  const control: string[] = [];
  const query = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    calls.push(params);
    const it = out[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => void control.push('interrupt'),
      setPermissionMode: async (m: string) => void control.push(`mode:${m}`),
      setModel: async (m: string) => void control.push(`model:${m}`),
      applyFlagSettings: async (s: Record<string, unknown>) =>
        void control.push(`flags:${JSON.stringify(s)}`),
      stopTask: async (id: string) => void control.push(`stop:${id}`),
      getContextUsage: async () => ({
        totalTokens: 100,
        maxTokens: 1000,
        percentage: 10,
        categories: [],
      }),
      accountInfo: async () => ({ email: 'a@b', subscriptionType: 'Claude Max' }),
      close: () => void control.push('close'),
      ...extra,
    };
  };
  return {
    calls,
    control,
    push: (...messages: unknown[]) => messages.forEach((m) => out.push(m)),
    end: () => out.end(),
    sdk: { query, listSessions: async () => [] } as never,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 's-1',
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  cwd: '/w',
  tools: [],
  apiKeySource: 'none',
};

type CanUseTool = (
  n: string,
  i: Record<string, unknown>,
  o: Record<string, unknown>,
) => Promise<unknown>;

describe('engineEnv', () => {
  it('без ключей API и маркеров родительской сессии, настройки пользователя CLAUDE_CODE_* остаются', () => {
    const env = engineEnv(
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'sk',
        ANTHROPIC_AUTH_TOKEN: 'tok',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SSE_PORT: '1234',
        CLAUDE_CODE_SESSION_ID: 'x',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'o',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:/bash.exe',
      },
      'agentura/1',
    );
    expect(env).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/bash.exe',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentura/1',
    });
  });
});

describe('ClaudeAdapter', () => {
  it('опции query(): streaming input, частичные сообщения, thinking, все источники настроек, режим default', async () => {
    const fake = fakeSdk();
    const adapter = new ClaudeAdapter({
      loadSdk: async () => fake.sdk,
      env: { ANTHROPIC_API_KEY: 'x', HOME: '/h' },
    });
    const session = await adapter.createSession({
      cwd: '/w',
      model: 'claude-sonnet-5-5',
      effort: 'low',
    });
    const { options, prompt } = fake.calls[0]!;
    expect(options).toMatchObject({
      cwd: '/w',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      permissionMode: 'default',
      includePartialMessages: true,
      forwardSubagentText: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });
    expect(options['env']).toEqual({ HOME: '/h' });
    expect(options['resume']).toBeUndefined();

    expect(session.send('привет')).toBe(true);
    const first = (await prompt[Symbol.asyncIterator]().next()).value as Record<string, unknown>;
    expect(first).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'привет' },
      parent_tool_use_id: null,
    });
    expect(first['uuid']).toMatch(/^[0-9a-f-]{36}$/);
    session.dispose();
    expect(fake.control).toContain('close');
  });

  it('поток → события; промпт привязан по эху uuid; контекст от движка; управление уходит в query', async () => {
    const fake = fakeSdk();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk });
    const session = await adapter.resumeSession('s-1', { cwd: '/w', baselineCostUsd: 1 });
    expect(fake.calls[0]!.options['resume']).toBe('s-1');
    expect(session.id).toBe('s-1');

    const events: AgentEvent[] = [];
    session.events.on((e) => events.push(e));
    session.send('ход');
    const sent = (await fake.calls[0]!.prompt[Symbol.asyncIterator]().next()).value as {
      uuid: string;
    };
    fake.push(init, {
      type: 'stream_event',
      parent_tool_use_id: null,
      user_message_uuid: sent.uuid,
      event: {
        type: 'message_start',
        message: { id: 'm1', model: 'claude-sonnet-5-5', usage: {} },
      },
    });
    await tick();
    expect(events.map((e) => e.type)).toEqual(['session.init', 'context.usage', 'turn.start']);
    expect(events[1]).toMatchObject({ source: 'engine', usedTokens: 100, maxTokens: 1000 });
    expect(events[2]).toMatchObject({ prompt: 'ход' });

    await session.setMode('plan');
    await session.setModel('claude-opus-5-5');
    await session.setEffort('high');
    await session.stopTask('t1');
    await session.interrupt();
    expect(fake.control).toEqual([
      'mode:plan',
      'model:claude-opus-5-5',
      'flags:{"effortLevel":"high"}',
      'stop:t1',
      'interrupt',
    ]);

    // Разрешение через canUseTool доходит до события и резолвится ответом.
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    const pending = canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'b1', suggestions: [] },
    );
    expect(events.at(-1)).toMatchObject({
      type: 'permission.request',
      toolUseId: 'b1',
      toolName: 'Bash',
    });
    expect(session.respondPermission('b1', 'allow')).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    session.dispose();
  });

  it('dispose: сначала отмена ждущих разрешений, потом session.closed; for await завершается; send — отказ', async () => {
    const fake = fakeSdk();
    const session = await new ClaudeAdapter({ loadSdk: async () => fake.sdk }).createSession({
      cwd: '/w',
    });
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    const pending = canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'b1' },
    );

    const seen: string[] = [];
    const loop = (async () => {
      for await (const e of session.events) seen.push(e.type);
      return 'done';
    })();
    await tick();
    session.dispose();
    await expect(loop).resolves.toBe('done');
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(seen).toEqual(['permission.request', 'permission.resolved', 'session.closed']);
    expect(session.send('после закрытия')).toBe(false);
    expect(session.compact()).toBe(false);
  });

  it('движок вышел сам (поток кончился) — session.closed {exit}, поток событий закрыт', async () => {
    const fake = fakeSdk();
    const session = await new ClaudeAdapter({ loadSdk: async () => fake.sdk }).createSession({
      cwd: '/w',
    });
    const events: AgentEvent[] = [];
    const loop = (async () => {
      for await (const e of session.events) events.push(e);
    })();
    fake.end();
    await loop;
    expect(events).toEqual([{ type: 'session.closed', reason: 'exit' }]);
    expect(session.send('ещё')).toBe(false);
  });

  it('обрыв потока — error fatal и session.closed {error}; события до подписки не теряются', async () => {
    const fake = fakeSdk({
      next: async () => {
        throw new Error('CLI упал');
      },
    });
    const session = await new ClaudeAdapter({ loadSdk: async () => fake.sdk }).createSession({
      cwd: '/w',
    });
    await tick();
    const events: AgentEvent[] = [];
    session.events.on((e) => events.push(e));
    expect(events).toEqual([
      { type: 'error', fatal: true, message: 'CLI упал' },
      { type: 'session.closed', reason: 'error', message: 'CLI упал' },
    ]);
  });

  it('accountInfo: ответ и закрытие процесса; без ответа — ошибка по таймауту и тоже закрытие', async () => {
    const ok = fakeSdk();
    const adapter = new ClaudeAdapter({ loadSdk: async () => ok.sdk });
    await expect(adapter.accountInfo('/w')).resolves.toEqual({
      email: 'a@b',
      subscriptionType: 'Claude Max',
    });
    expect(ok.control).toEqual(['close']);
    const abort = ok.calls[0]!.options['abortController'] as AbortController;
    expect(abort.signal.aborted).toBe(true);

    const hang = fakeSdk({ accountInfo: () => new Promise(() => {}) });
    const slow = new ClaudeAdapter({ loadSdk: async () => hang.sdk });
    vi.useFakeTimers();
    const p = slow.accountInfo('/w', 1000);
    const check = expect(p).rejects.toThrow(/не ответил/);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    vi.useRealTimers();
    expect(hang.control).toEqual(['close']);
  });
});
