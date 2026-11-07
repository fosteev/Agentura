import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgyAcpProcess } from './adapter';

type Handler = (params: Record<string, unknown>, id: number | string) => unknown;

export const DEFAULT_SESSION_ID = '87fec712-5cac-48d9-81da-cfd57b6b8baf';

export const FAKE_MODELS = {
  currentModelId: 'gemini-4-argon-medium',
  availableModels: [
    { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
    { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
    { modelId: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
    { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    { modelId: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
    { modelId: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
    { modelId: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
    { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
};

export const FAKE_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
    { id: 'accept-edits', name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
    { id: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
  ],
};

export function makeConfigOptions(model = 'gemini-4-argon', thoughtLevel = 'medium', mode = 'default') {
  const modelOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  };

  const thoughtOption = {
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: thoughtLevel,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  };

  const modeOption = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'plan', name: 'Plan' },
    ],
  };

  return model === 'gpt-oss-120b-medium' ? [modelOption, modeOption] : [modelOption, thoughtOption, modeOption];
}

/**
 * Поддельный `agy acp`: JSON-RPC 2.0 на каждой строке, включая строковые и числовые id.
 * Только для тестов.
 */
export class FakeAgyAcp extends EventEmitter implements AgyAcpProcess {
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
    return this.received.map((m) => m.method);
  }

  paramsOf(method: string, index = 0): Record<string, unknown> {
    return this.received.filter((m) => m.method === method)[index]?.params as Record<string, unknown>;
  }

  replies(): { id?: number | string; result?: unknown; error?: unknown }[] {
    return this.received
      .filter((m) => m.method === '<response>')
      .map((m) => m.params as { id?: number | string; result?: unknown; error?: unknown });
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Запрос сервера (строковый или числовой id). */
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
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
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
    this.received.push({
      method,
      ...(id !== undefined ? { id } : {}),
      params: msg.params,
    });
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
      const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'number'
        ? (error as { code: number }).code
        : -32000;
      const message = error instanceof Error ? error.message : String(error);
      this.reply(id, { error: { code, message } });
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

export function createFakeAgyServer(sessionId = DEFAULT_SESSION_ID): FakeAgyAcp {
  const s = new FakeAgyAcp();
  let currentModel = 'gemini-4-argon';
  let currentThought = 'medium';
  let currentMode = 'default';

  s.handle('initialize', () => ({
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.3' },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
      _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
    },
  }));

  s.handle('session/new', () => ({
    sessionId,
    models: FAKE_MODELS,
    modes: FAKE_MODES,
    configOptions: makeConfigOptions(currentModel, currentThought, currentMode),
    _meta: {
      antigravity: {
        tier: { name: 'Google AI Pro', id: 'g1-pro-tier' },
      },
    },
  }));

  s.handle('session/resume', (params) => ({
    sessionId: (params.sessionId as string) || sessionId,
    models: FAKE_MODELS,
    modes: FAKE_MODES,
    configOptions: makeConfigOptions(currentModel, currentThought, currentMode),
    _meta: {
      antigravity: {
        tier: { name: 'Google AI Pro', id: 'g1-pro-tier' },
      },
    },
  }));

  s.handle('session/set_config_option', (params) => {
    const configId = params.configId as string;
    const value = params.value as string;
    if (configId === 'model') {
      currentModel = value;
      return { configOptions: makeConfigOptions(currentModel, currentThought, currentMode) };
    }
    if (configId === 'thought_level') {
      if (currentModel === 'gpt-oss-120b-medium') {
        const error = new Error(`Thinking level "${value}" is not offered for model "GPT-OSS 120B (Medium)"`);
        (error as unknown as { code: number }).code = -32602;
        throw error;
      }
      currentThought = value;
      return { configOptions: makeConfigOptions(currentModel, currentThought, currentMode) };
    }
    if (configId === 'mode') {
      currentMode = value;
      return { configOptions: makeConfigOptions(currentModel, currentThought, currentMode) };
    }
    return { configOptions: makeConfigOptions(currentModel, currentThought, currentMode) };
  });

  s.handle('session/set_mode', (params) => {
    currentMode = (params.modeId as string) || currentMode;
    return {};
  });

  s.handle('session/cancel', () => ({}));

  s.handle('session/prompt', () => ({
    stopReason: 'end_turn',
    usage: {
      inputTokens: 15,
      outputTokens: 25,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      thoughtTokens: 0,
      totalTokens: 40,
    },
  }));

  return s;
}
