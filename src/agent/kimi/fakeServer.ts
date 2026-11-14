import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { KimiAcpProcess } from './adapter';

type Handler = (params: Record<string, unknown>, id: number | string) => unknown;

export const DEFAULT_KIMI_SESSION_ID = 'session_4d541e14-d99e-4b51-bdf7-d4aa8b4ee3b7';

export function makeKimiConfigOptions(
  model = 'kimi-code/k3.1-pro',
  thinking = 'high',
  mode = 'default',
): Record<string, unknown>[] {
  return [
    {
      type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model,
      options: [
        { value: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview' },
        { value: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Code Highspeed' },
        { value: 'kimi-code/k3', name: 'K3' },
        { value: 'kimi-code/k3-256k', name: 'K3-256k' },
        { value: 'kimi-code/k3.1-pro', name: 'K3.1 Pro' },
        { value: 'kimi-code/k3.1-pro-highspeed', name: 'K3.1 Pro Highspeed 2x Usage Cost' },
      ],
    },
    {
      type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: thinking,
      options: [
        { value: 'low', name: 'Thinking Low' },
        { value: 'high', name: 'Thinking High' },
        { value: 'max', name: 'Thinking Max' },
      ],
    },
    {
      type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
        { value: 'auto', name: 'Auto' },
        { value: 'yolo', name: 'YOLO' },
      ],
    },
  ];
}

export function makeKimiModes(currentModeId = 'default'): Record<string, unknown> {
  return {
    currentModeId,
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
      { id: 'auto', name: 'Auto' },
      { id: 'yolo', name: 'YOLO' },
    ],
  };
}

/** Тестовый NDJSON JSON-RPC процесс; кадры и defaults соответствуют реальным fixtures Kimi 2.6.0. */
export class FakeKimiAcp extends EventEmitter implements KimiAcpProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: { id?: number | string; method: string; params?: unknown }[] = [];
  readonly handlers = new Map<string, Handler>();
  killed = false;
  exited = false;
  ignoreStdinEnd = false;
  ignoreTerm = false;
  readonly signals: NodeJS.Signals[] = [];
  private buffer = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.read(chunk));
    this.stdin.on('end', () => {
      if (!this.ignoreStdinEnd) this.exit(0);
    });
  }

  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  handle(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  methods(): string[] {
    return this.received.map((message) => message.method);
  }

  paramsOf(method: string, index = 0): Record<string, unknown> {
    return this.received.filter((message) => message.method === method)[index]?.params as Record<string, unknown>;
  }

  replies(): { id?: number | string; result?: unknown; error?: unknown }[] {
    return this.received
      .filter((message) => message.method === '<response>')
      .map((message) => message.params as { id?: number | string; result?: unknown; error?: unknown });
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  update(sessionId: string, update: unknown): void {
    this.notify('session/update', { sessionId, update });
  }

  request(id: number | string, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, null);
    this.stdout.end();
    this.emit('close', code);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.ignoreTerm && signal !== 'SIGKILL') return true;
    this.exit(137);
    return true;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(JSON.parse(line) as Record<string, unknown>);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = rpcId(msg);
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (!method) {
      this.received.push({ method: '<response>', ...(id !== undefined ? { id } : {}), params: msg });
      return;
    }
    this.received.push({ method, ...(id !== undefined ? { id } : {}), params: msg.params });
    if (id === undefined) return;
    const handler = this.handlers.get(method);
    if (!handler) {
      this.reply(id, { error: { code: -32601, message: `no handler ${method}` } });
      return;
    }
    try {
      const result = handler((msg.params ?? {}) as Record<string, unknown>, id);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).then(
          (value) => this.reply(id, { result: value }),
          (error: Error | { code?: number; message?: string }) => {
            const code = 'code' in error && typeof error.code === 'number' ? error.code : -32000;
            this.reply(id, { error: { code, message: error.message ?? String(error) } });
          },
        );
        return;
      }
      this.reply(id, { result });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error &&
          typeof (error as { code: unknown }).code === 'number'
        ? (error as { code: number }).code
        : -32000;
      this.reply(id, { error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private reply(id: number | string, body: { result?: unknown; error?: unknown }): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  }
}

function rpcId(value: object): number | string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, 'id')) return undefined;
  const id = (value as { id: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? id : undefined;
}

export function createFakeKimiServer(sessionId = DEFAULT_KIMI_SESSION_ID): FakeKimiAcp {
  const server = new FakeKimiAcp();
  let model = 'kimi-code/k3.1-pro';
  let thinking = 'high';
  let mode = 'default';

  server.handle('initialize', () => ({
    protocolVersion: 1,
    agentInfo: { name: 'Kimi Code CLI', version: '2.6.0' },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {} },
      mcpCapabilities: { http: true, sse: true },
    },
  }));
  server.handle('session/new', () => ({
    sessionId,
    configOptions: makeKimiConfigOptions(model, thinking, mode),
    modes: makeKimiModes(mode),
  }));
  server.handle('session/resume', () => ({
    configOptions: makeKimiConfigOptions(model, thinking, mode),
    modes: makeKimiModes(mode),
  }));
  server.handle('session/close', () => ({}));
  server.handle('session/set_config_option', (params) => {
    const value = String(params.value ?? '');
    if (params.configId === 'model') model = value;
    if (params.configId === 'thinking') thinking = value;
    if (params.configId === 'mode') mode = value;
    const configOptions = makeKimiConfigOptions(model, thinking, mode);
    server.update(sessionId, { sessionUpdate: 'config_option_update', configOptions });
    return { configOptions };
  });
  server.handle('session/set_model', (params) => {
    model = String(params.modelId ?? model);
    server.update(sessionId, {
      sessionUpdate: 'config_option_update', configOptions: makeKimiConfigOptions(model, thinking, mode),
    });
    return {};
  });
  server.handle('session/set_mode', (params) => {
    mode = String(params.modeId ?? mode);
    server.update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode });
    server.update(sessionId, {
      sessionUpdate: 'config_option_update', configOptions: makeKimiConfigOptions(model, thinking, mode),
    });
    return {};
  });
  server.handle('session/prompt', () => {
    server.update(sessionId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Compact the conversation context', input: { hint: '<optional custom summarization instructions>' } },
        { name: 'usage', description: 'Show session token usage' },
        { _commandsCount: 60 },
      ],
    });
    server.update(sessionId, { sessionUpdate: 'session_info_update', title: 'Synthetic smoke' });
    server.update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    server.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } });
    server.update(sessionId, { sessionUpdate: 'usage_update', used: 19219, size: 1048576 });
    return { stopReason: 'end_turn' };
  });
  return server;
}
