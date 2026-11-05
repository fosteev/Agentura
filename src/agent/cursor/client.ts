import type { Readable, Writable } from 'node:stream';
import { JSONRPC, PERMISSION_METHOD, permissionRefusal } from './protocol';

export interface RpcProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
}

/** `id` JSON-RPC: число (включая 0) или строка. Отсутствие поля — не id. */
export type RpcId = string | number;

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

export class CursorRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CursorRpcError';
  }
}

export interface CursorRpcClientOptions {
  timeoutMs?: number;
  /** Лимит одной строки stdout. По умолчанию 64 МБ. */
  maxLineBytes?: number;
  onNotification?(method: string, params: unknown): void;
  /**
   * Запрос сервера. `true` — ответ уже отправлен, клиент молчит.
   * Иначе клиент отвечает сам: разрешение — отказом, прочее — ошибкой JSON-RPC.
   */
  onServerRequest?(id: RpcId, method: string, params: unknown): boolean | Promise<boolean | void> | void;
  onStderr?(line: string): void;
  onClose?(error: CursorRpcError): void;
}

/** Сколько ждать хвост stdout после `exit`, прежде чем считать клиент мёртвым. */
const EXIT_GRACE_MS = 1000;

/** Строка длиннее этого — обрыв протокола, а не кадр. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * JSON-RPC 2.0, один JSON на строку, поверх stdin/stdout `agent acp`.
 * Поле `jsonrpc` обязано быть `"2.0"` (живая фикстура; в отличие от Codex app-server, который его опускает).
 * Id `0` — обычный id: проверяется наличие поля, не truthiness.
 */
export class CursorRpcClient {
  private nextId = 1;
  private buffer = '';
  private bufferBytes = 0;
  private stderrTail = '';
  private exitMessage: string | undefined;
  private closed: CursorRpcError | undefined;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(
    private readonly process: RpcProcess,
    private readonly options: CursorRpcClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    process.stdout.on('data', (data: string | Buffer) => this.read(String(data)));
    process.stdout.on('end', () => this.fail(this.exitMessage ?? 'Cursor ACP stdout closed.'));
    process.stderr.on('data', (data: string | Buffer) => this.stderr(String(data)));
    process.stderr.on('end', () => this.flushStderr());
    process.stdin.on('error', (error) => this.fail(`Cursor ACP stdin error: ${String(error)}`));
    process.on('error', (error) => this.fail(`Cursor ACP error: ${String(error)}`));
    process.on('exit', (code, signal) => {
      this.exitMessage = `Cursor ACP exited (${String(code)}${signal ? `, ${String(signal)}` : ''}).`;
      setTimeout(() => this.fail(this.exitMessage!), EXIT_GRACE_MS).unref?.();
    });
    process.on('close', () => this.fail(this.exitMessage ?? 'Cursor ACP closed.'));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const message = JSON.stringify({
      jsonrpc: JSONRPC,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CursorRpcError(`Cursor RPC ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.process.stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CursorRpcError(`Cursor RPC ${method} could not be written: ${String(error)}`));
      }
    });
  }

  /** Уведомление без id (`session/cancel`). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message = JSON.stringify({
      jsonrpc: JSONRPC,
      method,
      ...(params === undefined ? {} : { params }),
    });
    try {
      this.process.stdin.write(`${message}\n`);
    } catch (error) {
      this.fail(`Cursor RPC ${method} could not be written: ${String(error)}`);
    }
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: JSONRPC, id, result });
  }

  respondError(id: RpcId, message: string, code = -32603, data?: unknown): void {
    this.write({
      jsonrpc: JSONRPC,
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  private write(message: object): void {
    if (this.closed) return;
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(`Cursor RPC response could not be written: ${String(error)}`);
    }
  }

  dispose(): void {
    this.fail('Cursor RPC client disposed.');
  }

  private read(chunk: string): void {
    if (this.closed) return;
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf('\n', start)) >= 0) {
      const line = (this.buffer + chunk.slice(start, newline)).replace(/\r$/, '');
      start = newline + 1;
      this.buffer = '';
      this.bufferBytes = 0;
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.fail(`Cursor ACP emitted a line larger than ${this.maxLineBytes} bytes.`);
        return;
      }
      if (line) this.handleLine(line);
      if (this.closed) return;
    }
    const rest = chunk.slice(start);
    if (!rest) return;
    this.buffer += rest;
    this.bufferBytes += Buffer.byteLength(rest);
    if (this.bufferBytes > this.maxLineBytes)
      this.fail(`Cursor ACP emitted a line larger than ${this.maxLineBytes} bytes.`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail('Cursor ACP emitted malformed JSON-RPC.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.fail('Cursor ACP emitted an invalid JSON-RPC message.');
      return;
    }
    const value = parsed as Record<string, unknown>;
    if (value.jsonrpc !== JSONRPC) {
      this.fail('Cursor ACP emitted JSON-RPC without jsonrpc "2.0".');
      return;
    }
    const id = rpcId(value);
    if (typeof value.method === 'string' && id !== undefined) {
      this.serverRequest(id, value.method, value.params);
      return;
    }
    if (id !== undefined && typeof id === 'number' && ('result' in value || 'error' in value)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = value.error;
      if (error && typeof error === 'object') {
        const err = error as RpcErrorShape;
        pending.reject(new CursorRpcError(err.message ?? 'Cursor RPC failed.', err.code, err.data));
      } else pending.resolve(value.result);
      return;
    }
    if (typeof value.method === 'string') {
      try {
        this.options.onNotification?.(value.method, value.params);
      } catch (error) {
        this.options.onStderr?.(`Agentura: notification ${value.method} handler failed: ${String(error)}`);
      }
      return;
    }
    if (value.error && typeof value.error === 'object') {
      const err = value.error as RpcErrorShape;
      this.fail(`Cursor ACP rejected a request: ${err.message ?? 'unknown error'}.`);
    } else this.fail('Cursor ACP emitted an invalid JSON-RPC message.');
  }

  private serverRequest(id: RpcId, method: string, params: unknown): void {
    const finish = (handled: boolean | void): void => {
      if (handled === true) return;
      if (method === PERMISSION_METHOD) {
        this.respond(id, permissionRefusal());
        return;
      }
      this.respondError(id, `Method not found: ${method}`, -32601);
    };
    const handler = this.options.onServerRequest;
    if (!handler) {
      finish(false);
      return;
    }
    try {
      void Promise.resolve(handler(id, method, params)).then(finish, (error: unknown) => {
        this.respondError(id, `Server request ${method} failed: ${String(error)}`);
      });
    } catch (error) {
      this.respondError(id, `Server request ${method} failed: ${String(error)}`);
    }
  }

  private stderr(chunk: string): void {
    const lines = (this.stderrTail + chunk).split(/\r?\n/);
    this.stderrTail = lines.pop() ?? '';
    if (this.stderrTail.length > this.maxLineBytes) {
      lines.push(this.stderrTail);
      this.stderrTail = '';
    }
    for (const line of lines) if (line) this.options.onStderr?.(redact(line));
  }

  private flushStderr(): void {
    const line = this.stderrTail;
    this.stderrTail = '';
    if (line) this.options.onStderr?.(redact(line));
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = new CursorRpcError(message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closed);
    }
    this.pending.clear();
    try {
      this.options.onClose?.(this.closed);
    } catch {
      // владелец уже закрывается
    }
  }
}

/** Поле `id` есть и это число или строка. `0` подходит; пропуск поля — нет. */
function rpcId(value: object): RpcId | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, 'id')) return undefined;
  const id = (value as { id: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? id : undefined;
}

/** Не пишем в лог ключи, если CLI всё же вывел их в stderr. */
export function redact(value: string): string {
  return value
    .replace(
      /(CURSOR_API_KEY|CURSOR_AUTH_TOKEN|authorization)\s*[=:]\s*(?:(?:Bearer|Basic)\s+)?[^\s,]+/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /("(?:authorization|api[_-]?key|access_token|refresh_token|id_token|token)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
}
