import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachBridgeSessionOptions } from '@anthropic-ai/claude-agent-sdk/bridge';
import type { AgentEvent, AgentSession } from '../types';
import { AsyncQueue } from '../stream';
import { ClaudeAdapter } from './adapter';
import {
  promptFrom,
  promptText,
  REMOTE_BASE_URL,
  RemoteBridge,
  type BridgeModule,
  type RemoteConfig,
  type RemoteHost,
} from './remote';

/** Поддельный SDK (как в adapter.test.ts): запоминает опции `query()` и управляющие вызовы. */
function fakeSdk() {
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
      applyFlagSettings: async () => undefined,
      stopTask: async (id: string) => void control.push(`stop:${id}`),
      backgroundTasks: async (id?: string) => (control.push(`bg:${id}`), true),
      getContextUsage: async () => ({ totalTokens: 1, maxTokens: 10, percentage: 10, categories: [] }),
      close: () => void control.push('close'),
    };
  };
  return {
    calls,
    control,
    push: (...messages: unknown[]) => messages.forEach((m) => out.push(m)),
    sdk: { query, listSessions: async () => [] } as never,
  };
}

/** Поддельный транспорт моста: всё, что в него записали. */
function fakeHandle(sessionId: string) {
  const h = {
    sessionId,
    written: [] as unknown[],
    states: [] as string[],
    metadata: [] as unknown[],
    requests: [] as { request_id: string; request: Record<string, unknown> }[],
    cancels: [] as string[],
    results: 0,
    getSequenceNum: () => 42,
    getEpoch: () => 7,
    isConnected: () => true,
    write: (m: unknown) => void h.written.push(m),
    sendResult: () => void h.results++,
    sendControlRequest: (r: { request_id: string; request: Record<string, unknown> }) =>
      void h.requests.push(r),
    sendControlResponse: () => undefined,
    sendControlCancelRequest: (id: string) => void h.cancels.push(id),
    reconnectTransport: vi.fn(async (opts: unknown) => void opts),
    reportState: (s: string) => void h.states.push(s),
    reportMetadata: (m: unknown) => void h.metadata.push(m),
    reportDelivery: () => undefined,
    flush: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  return h;
}
type FakeHandle = ReturnType<typeof fakeHandle>;

const creds = (n = 1) => ({
  worker_jwt: `jwt-${n}`,
  api_base_url: `https://ingress/${n}`,
  expires_in: 100,
  worker_epoch: n,
});

/** Поддельный модуль моста: ответы create/fetch задаются, attach выдаёт новый транспорт. */
function fakeBridge() {
  const state = {
    create: 'cse_1' as unknown,
    fetch: [] as unknown[],
    fetchCount: 0,
    attachError: undefined as Error | undefined,
  };
  const handles: FakeHandle[] = [];
  const attached: AttachBridgeSessionOptions[] = [];
  const createCodeSession = vi.fn(async (...args: unknown[]) => (void args, state.create));
  const fetchRemoteCredentials = vi.fn(async (...args: unknown[]) => {
    void args;
    state.fetchCount++;
    return state.fetch.length ? state.fetch.shift() : creds(state.fetchCount);
  });
  const attachBridgeSession = vi.fn(async (o: AttachBridgeSessionOptions) => {
    if (state.attachError) throw state.attachError;
    attached.push(o);
    const h = fakeHandle(o.sessionId);
    handles.push(h);
    return h;
  });
  const terminal = (r: unknown, v: boolean) =>
    typeof r === 'object' && r !== null && (r as { terminal?: unknown }).terminal === v;
  const mod = {
    createCodeSession,
    fetchRemoteCredentials,
    attachBridgeSession,
    isCredentialsFailure: (r: unknown) => terminal(r, true),
    isCredentialsRejection: (r: unknown) => terminal(r, false),
    isCreateSessionFailure: (r: unknown) => terminal(r, true),
  } as unknown as BridgeModule;
  return {
    state,
    handles,
    attached,
    createCodeSession,
    fetchRemoteCredentials,
    attachBridgeSession,
    mod,
    last: () => attached[attached.length - 1]!,
    handle: () => handles[handles.length - 1]!,
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

async function setup(remote: Partial<RemoteConfig> = {}) {
  const fake = fakeSdk();
  const bridge = fakeBridge();
  const adapter = new ClaudeAdapter({
    loadSdk: async () => fake.sdk,
    remote: {
      loadBridge: async () => bridge.mod,
      readToken: () => 'oauth-token',
      hostname: () => 'mac',
      ...remote,
    },
  });
  const session = (await adapter.createSession({
    cwd: '/w/proj',
    model: 'claude-opus-5-5',
  })) as AgentSession & { setRemote(on: boolean): Promise<void> };
  const events: AgentEvent[] = [];
  session.events.on((e) => events.push(e));
  const remoteStates = () =>
    events.filter((e) => e.type === 'remote.state').map((e) => (e as { state: string }).state);
  const prompts = fake.calls[0]!.prompt[Symbol.asyncIterator]();
  return { fake, bridge, session, events, remoteStates, prompts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteBridge: включение', () => {
  it('create → fetch → attach с аргументами из спайка, connecting → on со ссылкой', async () => {
    const { bridge, session, events } = await setup();
    await session.setRemote(true);
    expect(bridge.createCodeSession).toHaveBeenCalledWith(
      REMOTE_BASE_URL,
      'oauth-token',
      'mac · proj',
      20000,
      [],
      undefined,
      '/w/proj',
      'claude-opus-5-5',
    );
    expect(bridge.fetchRemoteCredentials).toHaveBeenCalledWith(
      'cse_1',
      REMOTE_BASE_URL,
      'oauth-token',
      20000,
    );
    expect(bridge.last()).toMatchObject({
      sessionId: 'cse_1',
      ingressToken: 'jwt-1',
      apiBaseUrl: 'https://ingress/1',
      epoch: 1,
    });
    expect(bridge.last().initialSequenceNum).toBeUndefined();
    expect(bridge.handle().metadata).toEqual([{ cwd: '/w/proj' }]);
    expect(events.filter((e) => e.type === 'remote.state')).toEqual([
      { type: 'remote.state', state: 'connecting' },
      { type: 'remote.state', state: 'on', url: 'https://claude.ai/code/cse_1' },
    ]);
    // повторное включение — no-op
    await session.setRemote(true);
    expect(bridge.createCodeSession).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('префикс имени из настройки', async () => {
    const { bridge, session } = await setup({ namePrefix: () => ' Ноут ' });
    await session.setRemote(true);
    expect(bridge.createCodeSession.mock.calls[0]![2]).toBe('Ноут · proj');
    session.dispose();
  });

  it('нет токена → error no-token, на claude.ai ничего не создаётся', async () => {
    const { bridge, session, events } = await setup({ readToken: () => undefined });
    await session.setRemote(true);
    expect(bridge.createCodeSession).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'remote.state').at(-1)).toEqual({
      type: 'remote.state',
      state: 'error',
      error: 'no-token',
    });
    session.dispose();
  });

  it('oauth_rejected → oauth; отказ сервера → rejected с причиной; null → network', async () => {
    const a = await setup();
    a.bridge.state.create = { terminal: false, reason: 'oauth_rejected' };
    await a.session.setRemote(true);
    expect(a.events.at(-1)).toMatchObject({ type: 'remote.state', state: 'error', error: 'oauth' });
    a.session.dispose();

    const b = await setup();
    b.bridge.state.fetch = [{ terminal: true, reason: 'untrusted_device' }];
    await b.session.setRemote(true);
    expect(b.events.at(-1)).toMatchObject({
      state: 'error',
      error: 'rejected',
      detail: 'untrusted_device',
    });
    b.session.dispose();

    const c = await setup();
    c.bridge.state.create = { terminal: true, reason: 'request_rejected', status: 400, detail: 'bad' };
    await c.session.setRemote(true);
    expect(c.events.at(-1)).toMatchObject({ error: 'rejected', detail: 'request_rejected 400 bad' });
    c.session.dispose();

    const d = await setup();
    d.bridge.state.create = null;
    await d.session.setRemote(true);
    expect(d.events.at(-1)).toMatchObject({ state: 'error', error: 'network' });
    // после ошибки можно включить снова
    d.bridge.state.create = 'cse_2';
    await d.session.setRemote(true);
    expect(d.events.at(-1)).toMatchObject({ state: 'on', url: 'https://claude.ai/code/cse_2' });
    d.session.dispose();
  });

  it('исключение attach → network с текстом', async () => {
    const { bridge, session, events } = await setup();
    bridge.state.attachError = new Error('registerWorker 500');
    await session.setRemote(true);
    expect(events.at(-1)).toMatchObject({ state: 'error', error: 'network', detail: 'registerWorker 500' });
    session.dispose();
  });
});

describe('RemoteBridge: сообщения', () => {
  it('исходящие: stream_event не шлётся, result → sendResult + idle, локальный промпт записан', async () => {
    const { fake, bridge, session } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    session.send('привет');
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'привет' },
      parent_tool_use_id: null,
    });
    expect(h.states).toEqual(['running']);
    const assistant = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm1', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ок' }], usage: {} },
    };
    fake.push(
      init,
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
      assistant,
      { type: 'result', subtype: 'success', is_error: false, result: 'ок', usage: {}, total_cost_usd: 0 },
    );
    await tick();
    expect(h.written.map((m) => (m as { type: string }).type)).toEqual(['user', 'system', 'assistant']);
    expect(h.results).toBe(1);
    expect(h.states).toEqual(['running', 'idle']);
    session.dispose();
  });

  it('до включения и после выключения в мост ничего не пишется', async () => {
    const { fake, bridge, session } = await setup();
    session.send('до');
    await session.setRemote(true);
    const h = bridge.handle();
    await session.setRemote(false);
    session.send('после');
    fake.push(init);
    await tick();
    expect(h.written).toEqual([]);
    session.dispose();
  });

  it('входящие: промпт уходит движку с uuid, notePrompt, remote.prompt web/phone', async () => {
    const { fake, bridge, session, events, prompts } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    await bridge.last().onInboundMessage!({
      type: 'user',
      message: { role: 'user', content: '123' },
      parent_tool_use_id: null,
      uuid: 'u-web',
      client_platform: 'web_claude_ai',
    } as never);
    const sent = (await prompts.next()).value as Record<string, unknown>;
    expect(sent).toEqual({
      type: 'user',
      message: { role: 'user', content: '123' },
      parent_tool_use_id: null,
      uuid: 'u-web',
    });
    expect(events.find((e) => e.type === 'remote.prompt')).toEqual({
      type: 'remote.prompt',
      uuid: 'u-web',
      text: '123',
      from: 'web',
    });
    expect(h.states.at(-1)).toBe('running');
    // маппер знает промпт: ход, начатый с этим uuid, несёт его текст
    fake.push(init, {
      type: 'stream_event',
      parent_tool_use_id: null,
      user_message_uuid: 'u-web',
      event: { type: 'message_start', message: { id: 'm1', model: 'x', usage: {} } },
    });
    await tick();
    expect(events.find((e) => e.type === 'turn.start')).toMatchObject({ prompt: '123' });

    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } };
    await bridge.last().onInboundMessage!({
      type: 'user',
      message: {
        role: 'user',
        content: [image, { type: 'text', text: 'что' }, { type: 'text', text: 'тут?' }],
      },
      parent_tool_use_id: null,
      client_platform: 'ios_app',
    } as never);
    const second = (await prompts.next()).value as { message: { content: unknown }; uuid: string };
    expect(second.message.content).toEqual([
      image,
      { type: 'text', text: 'что' },
      { type: 'text', text: 'тут?' },
    ]);
    expect(second.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.filter((e) => e.type === 'remote.prompt').at(-1)).toMatchObject({
      text: 'что\nтут?',
      from: 'phone',
      uuid: second.uuid,
    });

    // не user — игнор
    await bridge.last().onInboundMessage!({ type: 'assistant' } as never);
    expect(events.filter((e) => e.type === 'remote.prompt')).toHaveLength(2);
    session.dispose();
  });

  it('промпт после закрытия сессии игнорируется', async () => {
    const { bridge, session, events } = await setup();
    await session.setRemote(true);
    const opts = bridge.last();
    session.dispose();
    await opts.onInboundMessage!({ type: 'user', message: { role: 'user', content: 'x' } } as never);
    expect(events.some((e) => e.type === 'remote.prompt')).toBe(false);
  });

  it('promptText и promptFrom', () => {
    expect(promptText('a')).toBe('a');
    expect(promptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(promptText(undefined)).toBe('');
    expect(promptFrom('android')).toBe('phone');
    expect(promptFrom('MOBILE_web')).toBe('phone');
    expect(promptFrom('web_claude_ai')).toBe('web');
    expect(promptFrom(undefined)).toBe('web');
  });
});

describe('RemoteBridge: разрешения', () => {
  it('запрос уходит на claude.ai; удалённый ответ резолвит промис, by remote, bypass из «всегда» выкинут', async () => {
    const { fake, bridge, session, events } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' },
    ];
    const answer = canUseTool('Bash', { command: 'ls' }, {
      toolUseID: 't1',
      suggestions,
      title: 'Run ls?',
      decisionReason: 'rule',
      signal: new AbortController().signal,
    });
    expect(events.some((e) => e.type === 'permission.request')).toBe(true);
    expect(h.requests).toHaveLength(1);
    const req = h.requests[0]!;
    expect(req).toMatchObject({
      type: 'control_request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
        tool_use_id: 't1',
        permission_suggestions: suggestions,
        title: 'Run ls?',
        decision_reason: 'rule',
      },
    });
    expect(req.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.states.at(-1)).toBe('requires_action');

    const onResponse = bridge.last().onPermissionResponse!;
    // чужой и битый ответы — false, запрос ждёт дальше
    expect(
      onResponse({ type: 'control_response', response: { subtype: 'success', request_id: 'nope', response: { behavior: 'allow' } } }),
    ).toBe(false);
    expect(
      onResponse({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'maybe' } } }),
    ).toBe(false);

    const rule = suggestions[0];
    expect(
      onResponse({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: req.request_id,
          response: {
            behavior: 'allow',
            updatedInput: { command: 'ls -la' },
            updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, rule],
          },
        },
      }),
    ).not.toBe(false);
    await expect(answer).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      updatedPermissions: [rule],
    });
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({
      toolUseId: 't1',
      decision: 'allow',
      by: 'remote',
    });
    // ответ с claude.ai — cancel туда не шлём
    expect(h.cancels).toEqual([]);
    expect(h.states.at(-1)).toBe('running');
    session.dispose();
  });

  it('отказ с claude.ai: deny с текстом; без updatedInput — исходный input при allow', async () => {
    const { fake, bridge, session } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    const a = canUseTool('Bash', { command: 'rm' }, { toolUseID: 't1' });
    const b = canUseTool('Read', { file_path: '/x' }, { toolUseID: 't2' });
    const respond = bridge.last().onPermissionResponse!;
    respond({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.requests[0]!.request_id, response: { behavior: 'deny', message: 'нет' } },
    });
    respond({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.requests[1]!.request_id, response: { behavior: 'allow' } },
    });
    await expect(a).resolves.toEqual({ behavior: 'deny', message: 'нет' });
    await expect(b).resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: '/x' } });
    session.dispose();
  });

  it('ответ в ленте снимает запрос на claude.ai (cancel), поздний удалённый ответ отбрасывается', async () => {
    const { fake, bridge, session, events } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    const answer = canUseTool('Bash', { command: 'ls' }, { toolUseID: 't2' });
    const requestId = h.requests[0]!.request_id;
    expect(session.respondPermission('t2', 'allow')).toBe(true);
    await expect(answer).resolves.toMatchObject({ behavior: 'allow' });
    expect(h.cancels).toEqual([requestId]);
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({ by: 'user' });
    expect(
      bridge.last().onPermissionResponse!({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'x' } },
      }),
    ).toBe(false);
    session.dispose();
  });

  it('вопрос и план идут тем же путём', async () => {
    const { fake, bridge, session } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    const q = canUseTool('AskUserQuestion', { questions: [] }, { toolUseID: 'q1' });
    canUseTool('ExitPlanMode', { plan: 'p' }, { toolUseID: 'p1' });
    expect(h.requests.map((r) => r.request['tool_name'])).toEqual(['AskUserQuestion', 'ExitPlanMode']);
    bridge.last().onPermissionResponse!({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: h.requests[0]!.request_id,
        response: { behavior: 'allow', updatedInput: { questions: [], answers: { a: 'b' } } },
      },
    });
    await expect(q).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions: [], answers: { a: 'b' } },
    });
    session.dispose();
  });

  it('закрытие сессии: ждущие запросы отменяются и на claude.ai', async () => {
    const { fake, bridge, session } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    const canUseTool = fake.calls[0]!.options['canUseTool'] as CanUseTool;
    void canUseTool('Bash', { command: 'ls' }, { toolUseID: 't3' });
    session.dispose();
    expect(h.cancels).toEqual([h.requests[0]!.request_id]);
  });
});

describe('RemoteBridge: управление с claude.ai', () => {
  it('bypass без разрешения отклонён; другой режим — setPermissionMode и mode.changed', async () => {
    const { fake, bridge, session, events } = await setup({ allowBypass: () => false });
    await session.setRemote(true);
    const setMode = bridge.last().onSetPermissionMode!;
    expect(setMode('bypassPermissions')).toMatchObject({ ok: false });
    expect(fake.control).not.toContain('mode:bypassPermissions');
    expect(setMode('dontAsk')).toMatchObject({ ok: false });
    expect(setMode('acceptEdits')).toEqual({ ok: true });
    await tick();
    expect(fake.control).toContain('mode:acceptEdits');
    expect(events.find((e) => e.type === 'mode.changed')).toEqual({ type: 'mode.changed', mode: 'acceptEdits' });
    session.dispose();
  });

  it('bypass разрешён настройкой — уходит движку', async () => {
    const { fake, bridge, session } = await setup({ allowBypass: () => true });
    await session.setRemote(true);
    expect(bridge.last().onSetPermissionMode!('bypassPermissions')).toEqual({ ok: true });
    await tick();
    expect(fake.control).toContain('mode:bypassPermissions');
    session.dispose();
  });

  it('interrupt, setModel, stopTask, backgroundTasks — в query', async () => {
    const { fake, bridge, session } = await setup();
    await session.setRemote(true);
    const o = bridge.last();
    o.onInterrupt!();
    expect(await o.onSetModel!('claude-sonnet-5-5')).toEqual({ ok: true });
    await o.onStopTask!('task-1');
    expect(await o.onBackgroundTasks!('tu-1')).toBe(true);
    await tick();
    expect(fake.control).toEqual(['interrupt', 'model:claude-sonnet-5-5', 'stop:task-1', 'bg:tu-1']);
    expect(o.onRenameSession).toBeUndefined();
    expect(o.onSetMaxThinkingTokens).toBeUndefined();
    session.dispose();
  });
});

describe('RemoteBridge: транспорт', () => {
  it('onClose 401 → переподключение со свежими учётными данными и номером последовательности', async () => {
    const { bridge, session, events } = await setup();
    await session.setRemote(true);
    const first = bridge.handle();
    bridge.last().onClose!(401);
    await tick();
    expect(bridge.fetchRemoteCredentials).toHaveBeenCalledTimes(2);
    expect(bridge.attachBridgeSession).toHaveBeenCalledTimes(2);
    expect(bridge.last()).toMatchObject({
      sessionId: 'cse_1',
      ingressToken: 'jwt-2',
      epoch: 2,
      initialSequenceNum: 42,
    });
    expect(first.close).toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'remote.state').at(-1)).toMatchObject({ state: 'on' });
    // запись идёт в новый транспорт
    session.send('снова');
    expect(bridge.handle().written).toHaveLength(1);
    expect(first.written).toHaveLength(0);
    session.dispose();
  });

  it('onClose 4094 и неудачное переподключение → error closed', async () => {
    const { bridge, session, events } = await setup();
    await session.setRemote(true);
    bridge.state.fetch = [null];
    bridge.last().onClose!(4094);
    await tick();
    expect(events.at(-1)).toEqual({ type: 'remote.state', state: 'error', error: 'closed', detail: '4094' });
    session.dispose();
  });

  it('onClose 4090 → off/superseded; прочий код → error closed', async () => {
    const a = await setup();
    await a.session.setRemote(true);
    a.bridge.last().onClose!(4090);
    expect(a.events.at(-1)).toEqual({ type: 'remote.state', state: 'off', error: 'superseded' });
    expect(a.bridge.fetchRemoteCredentials).toHaveBeenCalledTimes(1);
    a.session.dispose();

    const b = await setup();
    await b.session.setRemote(true);
    b.bridge.last().onClose!(403);
    expect(b.events.at(-1)).toEqual({ type: 'remote.state', state: 'error', error: 'closed', detail: '403' });
    b.session.dispose();
  });

  it('disable → flush и close, state off; сессия на claude.ai остаётся', async () => {
    const { bridge, session, events, remoteStates } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    await session.setRemote(false);
    expect(h.flush).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
    expect(remoteStates()).toEqual(['connecting', 'on', 'off']);
    expect(events.at(-1)).toEqual({ type: 'remote.state', state: 'off' });
    // повторное выключение — без событий
    await session.setRemote(false);
    expect(remoteStates()).toEqual(['connecting', 'on', 'off']);
    session.dispose();
  });

  it('dispose сессии закрывает мост', async () => {
    const { bridge, session } = await setup();
    await session.setRemote(true);
    const h = bridge.handle();
    session.dispose();
    await tick();
    expect(h.flush).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
  });
});

/** Мост отдельно от сессии: таймеры. */
function hostStub() {
  const events: AgentEvent[] = [];
  const host: RemoteHost = {
    cwd: '/w',
    title: 'Задача',
    model: () => undefined,
    closed: () => false,
    emit: (e) => void events.push(e),
    prompt: () => undefined,
    resolvePermission: () => true,
    query: {
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      stopTask: async () => undefined,
      backgroundTasks: async () => true,
    } as unknown as RemoteHost['query'],
    log: () => undefined,
  };
  return { host, events };
}

describe('RemoteBridge: таймеры', () => {
  it('обновление JWT на 80% срока → reconnectTransport, таймер перевзводится', async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    const { host } = hostStub();
    const remote = new RemoteBridge(host, { loadBridge: async () => bridge.mod, readToken: () => 't', hostname: () => 'm' });
    await remote.enable();
    expect(bridge.createCodeSession.mock.calls[0]![2]).toBe('m · Задача');
    const h = bridge.handle();
    await vi.advanceTimersByTimeAsync(79_000);
    expect(h.reconnectTransport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridge.fetchRemoteCredentials).toHaveBeenCalledTimes(2);
    expect(h.reconnectTransport).toHaveBeenCalledWith({
      ingressToken: 'jwt-2',
      apiBaseUrl: 'https://ingress/2',
      epoch: 2,
    });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.reconnectTransport).toHaveBeenCalledTimes(2);
    await remote.disable();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(h.reconnectTransport).toHaveBeenCalledTimes(2);
  });

  it('короткий срок — не чаще раза в минуту', async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    bridge.state.fetch = [{ ...creds(1), expires_in: 10 }];
    const { host } = hostStub();
    const remote = new RemoteBridge(host, { loadBridge: async () => bridge.mod, readToken: () => 't' });
    await remote.enable();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(bridge.handle().reconnectTransport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridge.handle().reconnectTransport).toHaveBeenCalledTimes(1);
    await remote.disable();
  });

  it('зависший flush не держит выключение дольше 2 с', async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    const { host, events } = hostStub();
    const remote = new RemoteBridge(host, { loadBridge: async () => bridge.mod, readToken: () => 't' });
    await remote.enable();
    const h = bridge.handle();
    h.flush.mockImplementation(() => new Promise(() => {}));
    const done = remote.disable();
    expect(events.at(-1)).toEqual({ type: 'remote.state', state: 'off' });
    expect(h.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(h.close).toHaveBeenCalled();
  });

  it('выключение во время подключения отменяет его: транспорт закрыт, состояние off', async () => {
    const bridge = fakeBridge();
    const { host, events } = hostStub();
    let release: (v: unknown) => void = () => undefined;
    bridge.createCodeSession.mockImplementation(() => new Promise((r) => (release = r)));
    const remote = new RemoteBridge(host, { loadBridge: async () => bridge.mod, readToken: () => 't' });
    const enabling = remote.enable();
    await tick();
    await remote.disable();
    release('cse_9');
    await enabling;
    expect(bridge.attachBridgeSession).not.toHaveBeenCalled();
    expect(events.map((e) => (e as { state: string }).state)).toEqual(['connecting', 'off']);
    expect(remote.current).toBe('off');
  });
});
