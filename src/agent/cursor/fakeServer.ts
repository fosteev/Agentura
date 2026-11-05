import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CursorProcess } from './adapter';

type Handler = (params: Record<string, unknown>, id: number | string) => unknown;

/**
 * Поддельный `agent acp`: JSON-RPC 2.0 на каждой строке, включая id `0`.
 * Только для тестов.
 */
export class FakeAcp extends EventEmitter implements CursorProcess {
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

  /** Запрос сервера. `id` 0 — живой снимок разрешения, его нельзя потерять. */
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
          (error: Error) => this.reply(id, { error: { code: -32000, message: error.message } }),
        );
        return;
      }
      this.reply(id, { result });
    } catch (error) {
      this.reply(id, { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
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
