import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CodexProcess } from './adapter';

type Handler = (params: Record<string, unknown>, id: number) => unknown;

/**
 * Поддельный `codex app-server` для тестов: читает JSON-RPC со stdin, отвечает handler'ами по методу и пишет
 * notifications в stdout. Как живой сервер, не ставит `jsonrpc` в ответах. Только для тестов.
 */
export class FakeAppServer extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Всё, что получено от клиента, по порядку (запросы и notifications). */
  readonly received: { id?: number; method: string; params?: unknown }[] = [];
  readonly handlers = new Map<string, Handler>();
  killed = false;
  exited = false;
  /** Не закрываться на конец stdin (проверка kill после grace). */
  ignoreStdinEnd = false;
  /** Не выходить по SIGTERM (проверка эскалации до SIGKILL). */
  ignoreTerm = false;
  /** Сигналы, которыми процесс пытались убить. */
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

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  /** Запрос от сервера клиенту (approval). */
  request(id: number | string, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
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
      if (line) this.dispatch(JSON.parse(line) as { id?: number; method?: string; params?: unknown });
    }
  }

  private dispatch(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }): void {
    if (!msg.method) {
      // ответ клиента на наш запрос
      this.received.push({ ...(msg.id !== undefined ? { id: msg.id } : {}), method: '<response>', params: msg });
      return;
    }
    this.received.push({
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      method: msg.method,
      params: msg.params,
    });
    if (msg.id === undefined) return;
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.stdout.write(`${JSON.stringify({ id: msg.id, error: { code: -32601, message: `no handler ${msg.method}` } })}\n`);
      return;
    }
    void Promise.resolve()
      .then(() => handler((msg.params ?? {}) as Record<string, unknown>, msg.id as number))
      .then(
        (result) => this.stdout.write(`${JSON.stringify({ id: msg.id, result })}\n`),
        (error: Error) =>
          this.stdout.write(`${JSON.stringify({ id: msg.id, error: { code: -32000, message: error.message } })}\n`),
      );
  }
}
