import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../types';
import { AsyncQueue } from '../stream';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, engineEnv, promptParent, userContent } from './adapter';
import { projectDir } from '../../data/sessions';

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
      CLAUDE_CODE_ARTIFACT: '1',
      CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentura/1',
    });
  });

  it('значения CLAUDE_CODE_ARTIFACT* из base сохраняются', () => {
    const env = engineEnv({ CLAUDE_CODE_ARTIFACT: '0', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '1' });
    expect(env['CLAUDE_CODE_ARTIFACT']).toBe('0');
    expect(env['CLAUDE_CODE_ARTIFACT_AUTO_OPEN']).toBe('1');
  });
});

describe('userContent (картинки в сообщении, этап 4 roadmap 0.2)', () => {
  const png = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', width: 48, height: 32 };
  const jpg = { mediaType: 'image/jpeg' as const, data: '/9j/4AAQ' };

  it('без картинок — строка, как в 0.1', () => {
    expect(userContent('привет')).toBe('привет');
    expect(userContent('привет', [])).toBe('привет');
  });

  it('картинки по порядку, текст последним; размер и имя в API не уходят', () => {
    expect(userContent('что тут?', [png, jpg])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
      { type: 'text', text: 'что тут?' },
    ]);
  });

  it('пустой текст не шлётся пустым text-блоком', () => {
    expect(userContent('  ', [png])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });
});

describe('userContent (файлы-вложения, этап 8 roadmap 0.2)', () => {
  const png = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
  const txt = { kind: 'text' as const, path: 'notes/a.txt', data: 'секрет', size: 12 };
  const pdf = { kind: 'pdf' as const, path: '/abs/b.pdf', data: 'JVBERi0x', size: 6, pages: 1 };

  it('картинки, затем документы с путём в title, текст последним; размер и страницы в API не уходят', () => {
    expect(userContent('что в файлах?', [png], [txt, pdf])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'секрет' },
        title: 'notes/a.txt',
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
        title: '/abs/b.pdf',
      },
      { type: 'text', text: 'что в файлах?' },
    ]);
  });

  it('только файл без текста — один document-блок; пустые списки — строка', () => {
    expect(userContent('', undefined, [txt])).toEqual([
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'секрет' },
        title: 'notes/a.txt',
      },
    ]);
    expect(userContent('привет', [], [])).toBe('привет');
  });
});

describe('ClaudeAdapter', () => {
  it('send с картинками: content блоками, turn.start несёт картинки (миниатюры в ленте)', async () => {
    const fake = fakeSdk();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk });
    const session = await adapter.createSession({ cwd: '/w' });
    const events: AgentEvent[] = [];
    session.events.on((e) => events.push(e));
    const image = {
      mediaType: 'image/png' as const,
      data: 'AAAA',
      width: 1568,
      height: 1000,
      name: 'скриншот 1',
    };
    session.send('что на скриншоте?', [image]);
    const sent = (await fake.calls[0]!.prompt[Symbol.asyncIterator]().next()).value as {
      uuid: string;
      message: { content: unknown };
    };
    expect(sent.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'что на скриншоте?' },
    ]);
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
    expect(events.find((e) => e.type === 'turn.start')).toMatchObject({
      prompt: 'что на скриншоте?',
      images: [image],
    });
    session.dispose();
  });

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
    expect(options['env']).toEqual({
      HOME: '/h',
      CLAUDE_CODE_ARTIFACT: '1',
      CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0',
    });
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

  it('resume с dropTurn: resumeSessionAt и resumeDropsTurn уходят в query; без него — нет', async () => {
    const fake = fakeSdk();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk });
    await adapter.resumeSession('s-1', {
      cwd: '/w',
      dropTurn: { keepUuid: 'keep-1', promptUuid: 'prompt-1' },
    });
    expect(fake.calls[0]!.options).toMatchObject({
      resume: 's-1',
      resumeSessionAt: 'keep-1',
      resumeDropsTurn: 'prompt-1',
    });
    await adapter.resumeSession('s-2', { cwd: '/w' });
    expect(fake.calls[1]!.options['resumeSessionAt']).toBeUndefined();
    expect(fake.calls[1]!.options['resumeDropsTurn']).toBeUndefined();
    // новая сессия dropTurn игнорирует
    await adapter.createSession({
      cwd: '/w',
      ...({ dropTurn: { keepUuid: 'x', promptUuid: 'y' } } as object),
    });
    expect(fake.calls[2]!.options['resumeSessionAt']).toBeUndefined();
  });

  it('loadHistory(stopBefore) обрезает цепочку перед промптом; retryPoint ищет точку отката в транскрипте', async () => {
    const msgs = [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'раз' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'm1',
          model: 'x',
          role: 'assistant',
          content: [{ type: 'text', text: 'ок' }],
          usage: {},
        },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: 'два' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        uuid: 'a2',
        message: {
          id: 'm2',
          model: 'x',
          role: 'assistant',
          content: [{ type: 'text', text: 'ок' }],
          usage: {},
        },
        parent_tool_use_id: null,
      },
    ];
    const fake = fakeSdk();
    const sdk = { ...(fake.sdk as object), getSessionMessages: async () => msgs } as never;
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk });
    const full = await adapter.loadHistory('s-1', '/w');
    expect(full.turns).toBe(2);
    const cut = await adapter.loadHistory('s-1', '/w', { stopBefore: 'u2' });
    expect(cut.turns).toBe(1);
    expect(await adapter.retryPoint('s-1', '/w', 'два')).toEqual({
      keepUuid: 'a1',
      promptUuid: 'u2',
    });
    expect(await adapter.retryPoint('s-1', '/w', 'другое')).toBeUndefined();
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

  it('обрыв сети посреди хода (ECONNRESET после первых сообщений): события хода доходят, затем error fatal и closed {error}', async () => {
    const queue: unknown[] = [
      init,
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'Начинаю' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
      },
    ];
    const fake = fakeSdk({
      next: async () => {
        if (queue.length > 0) return { value: queue.shift(), done: false };
        throw new Error('read ECONNRESET');
      },
    });
    const session = await new ClaudeAdapter({ loadSdk: async () => fake.sdk }).createSession({
      cwd: '/w',
    });
    await tick();
    const events: AgentEvent[] = [];
    session.events.on((e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['session.init', 'error', 'session.closed']),
    );
    expect(events.at(-2)).toEqual({ type: 'error', fatal: true, message: 'read ECONNRESET' });
    expect(events.at(-1)).toEqual({
      type: 'session.closed',
      reason: 'error',
      message: 'read ECONNRESET',
    });
    // после обрыва отправка отвергается — интерфейс покажет карточку и отключит поле ввода
    expect(session.send('ещё')).toBe(false);
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

  it('complete: один ход без инструментов и MCP, persistSession: false; текст ответа; процесс закрыт', async () => {
    const f = fakeSdk();
    f.push(init, {
      type: 'assistant',
      session_id: 's-1',
      message: { content: [{ type: 'text', text: 'Fix it' }] },
    });
    f.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Fix it\n\nBody',
      session_id: 's-1',
    });
    f.end();
    const adapter = new ClaudeAdapter({ loadSdk: async () => f.sdk, env: { PATH: '/bin' } });
    await expect(
      adapter.complete('/w', { system: 'You write commits.', prompt: 'diff', model: 'sonnet' }),
    ).resolves.toBe('Fix it\n\nBody');
    const { prompt, options } = f.calls[0]!;
    expect(prompt).toBe('diff');
    expect(options).toMatchObject({
      cwd: '/w',
      systemPrompt: 'You write commits.',
      model: 'sonnet',
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
      thinking: { type: 'disabled' },
      permissionMode: 'default',
      // главное: движок не пишет транскрипт — сессия не появится в списке (он читается из ~/.claude/projects)
      persistSession: false,
    });
    expect(options['canUseTool']).toBeUndefined();
    expect(options['resume']).toBeUndefined();
    expect(f.control).toEqual(['close']);
    expect((options['abortController'] as AbortController).signal.aborted).toBe(true);
  });

  it('complete: ошибка движка и пустой поток — исключение; нет ответа — таймаут и закрытие', async () => {
    const err = fakeSdk();
    err.push(init, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['overloaded'],
      session_id: 's-1',
    });
    err.end();
    await expect(
      new ClaudeAdapter({ loadSdk: async () => err.sdk }).complete('/w', {
        system: 's',
        prompt: 'p',
      }),
    ).rejects.toThrow('overloaded');

    const apiErr = fakeSdk();
    apiErr.push({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' });
    apiErr.end();
    await expect(
      new ClaudeAdapter({ loadSdk: async () => apiErr.sdk }).complete('/w', {
        system: 's',
        prompt: 'p',
      }),
    ).rejects.toThrow('Invalid API key');

    const none = fakeSdk();
    none.end();
    await expect(
      new ClaudeAdapter({ loadSdk: async () => none.sdk }).complete('/w', {
        system: 's',
        prompt: 'p',
      }),
    ).rejects.toThrow(/без ответа/);

    const hang = fakeSdk();
    vi.useFakeTimers();
    const p = new ClaudeAdapter({ loadSdk: async () => hang.sdk }).complete('/w', {
      system: 's',
      prompt: 'p',
      timeoutMs: 1000,
    });
    const check = expect(p).rejects.toThrow(/не ответил/);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    vi.useRealTimers();
    expect(hang.control).toEqual(['close']);
  });

  it('complete: движок записал транскрипт вопреки persistSession — файл удалён, в каталоге проекта сессий нет', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentura-complete-'));
    try {
      const dir = projectDir('/w/repo', home);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'other.jsonl'), '{}\n');
      const f = fakeSdk();
      const adapter = new ClaudeAdapter({
        loadSdk: async () => f.sdk,
        env: { PATH: '/bin', CLAUDE_CONFIG_DIR: home },
        log: () => {},
      });
      // «старый» движок: пишет транскрипт, как обычная сессия
      await writeFile(join(dir, 's-1.jsonl'), '{"type":"user"}\n');
      f.push(init, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: 's-1',
      });
      f.end();
      await expect(adapter.complete('/w/repo', { system: 's', prompt: 'p' })).resolves.toBe('ok');
      expect((await readdir(dir)).sort()).toEqual(['other.jsonl']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('capabilities: модели и команды движка; сбой одного запроса не роняет второй', async () => {
    const f = fakeSdk({
      supportedModels: async () => [
        {
          value: 'opus',
          displayName: 'Opus',
          description: 'сложные задачи',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
        },
      ],
      supportedCommands: async () => {
        throw new Error('нет ответа');
      },
    });
    const adapter = new ClaudeAdapter({ loadSdk: async () => f.sdk });
    const session = await adapter.createSession({ cwd: '/w' });
    await expect(session.capabilities()).resolves.toEqual({
      models: [
        {
          value: 'opus',
          displayName: 'Opus',
          description: 'сложные задачи',
          supportsEffort: true,
          effortLevels: ['low', 'high'],
        },
      ],
      commands: [],
    });
    session.dispose();
  });
});

describe('promptParent — точка отката по транскрипту', () => {
  it('parentUuid промпта — последняя запись сохраняемого хода (вложение, которого нет в getSessionMessages)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentura-parent-'));
    const path = join(dir, 's.jsonl');
    try {
      await writeFile(
        path,
        [
          { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
          { type: 'attachment', uuid: 'att1', parentUuid: 'a1' },
          { type: 'user', uuid: 'u2', parentUuid: 'att1' },
          '{"type":"user","uuid":"u3"', // оборванная строка
        ]
          .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
          .join('\n') + '\n',
      );
      expect(await promptParent(path, 'u2')).toBe('att1');
      expect(await promptParent(path, 'u3')).toBeUndefined();
      expect(await promptParent(path, 'нет')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
