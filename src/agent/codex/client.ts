import type { Writable } from 'node:stream';
import type { Readable } from 'node:stream';

export interface RpcProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
}

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

/** `RequestId` протокола: строка или число. */
export type RpcId = string | number;

interface RpcResponse {
  jsonrpc?: string;
  id?: RpcId;
  result?: unknown;
  error?: RpcErrorShape;
}

interface RpcNotification {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

export interface CodexRpcClientOptions {
  timeoutMs?: number;
  maxLineBytes?: number;
  onNotification?(method: string, params: unknown): void;
  /**
   * Запрос от сервера (approval, user input): ответить нужно `respond(id, …)` / `respondError(id, …)`.
   * Не задан или бросил — клиент сам отвечает ошибкой `-32601` / `-32603`, чтобы turn не завис.
   */
  onServerRequest?(id: RpcId, method: string, params: unknown): void | Promise<void>;
  onStderr?(line: string): void;
  /**
   * Клиент умер (процесс вышел, поток закрылся, протокол сломан, `dispose`): один раз. Без этого владелец не
   * узнал бы, что notifications кончились, и turn висел бы вечно.
   */
  onClose?(error: CodexRpcError): void;
}

/** Сколько ждать `close`/конца stdout после `exit`, прежде чем считать клиент мёртвым. */
const EXIT_GRACE_MS = 1000;

/** JSON-RPC 2.0 поверх newline-delimited stdin/stdout Codex app-server. */
export class CodexRpcClient {
  private nextId = 1;
  private buffer = '';
  /** Хвост stderr без перевода строки: redact видит строку целиком, а не обрывки чанков. */
  private stderrTail = '';
  private exitMessage: string | undefined;
  private closed: CodexRpcError | undefined;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(
    private readonly process: RpcProcess,
    private readonly options: CodexRpcClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxLineBytes = options.maxLineBytes ?? 1_048_576;
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    process.stdout.on('data', (data: string | Buffer) => this.read(String(data)));
    process.stdout.on('end', () => this.fail(this.exitMessage ?? 'Codex app-server stdout closed.'));
    process.stderr.on('data', (data: string | Buffer) => this.stderr(String(data)));
    process.stderr.on('end', () => this.flushStderr());
    // EPIPE после смерти процесса приходит событием, а не исключением из write: без слушателя — uncaught
    process.stdin.on('error', (error) => this.fail(`Codex app-server stdin error: ${String(error)}`));
    process.on('error', (error) => this.fail(`Codex app-server error: ${String(error)}`));
    // `exit` приходит раньше, чем дочитан stdout: последний ответ не теряем — ждём `close`/конца stdout,
    // а если поток держит внук процесса, через короткую паузу всё равно закрываемся
    process.on('exit', (code, signal) => {
      this.exitMessage = `Codex app-server exited (${String(code)}${signal ? `, ${String(signal)}` : ''}).`;
      setTimeout(() => this.fail(this.exitMessage!), EXIT_GRACE_MS).unref?.();
    });
    process.on('close', () => this.fail(this.exitMessage ?? 'Codex app-server closed.'));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex RPC ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.process.stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex RPC ${method} could not be written: ${String(error)}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
    try {
      this.process.stdin.write(`${message}\n`);
    } catch (error) {
      this.fail(`Codex RPC ${method} could not be written: ${String(error)}`);
    }
  }

  /** Ответить на server request результатом. */
  respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Ответить на server request ошибкой. */
  respondError(id: RpcId, message: string, code = -32603, data?: unknown): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  private write(message: object): void {
    if (this.closed) return;
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(`Codex RPC response could not be written: ${String(error)}`);
    }
  }

  dispose(): void {
    this.fail('Codex RPC client disposed.');
  }

  private read(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.fail(`Codex app-server emitted a line larger than ${this.maxLineBytes} bytes.`);
        return;
      }
      if (line) this.handleLine(line);
      if (this.closed) return;
    }
    // хвост без перевода строки тоже ограничен: иначе буфер растёт без предела
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes)
      this.fail(`Codex app-server emitted a line larger than ${this.maxLineBytes} bytes.`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail('Codex app-server emitted malformed JSON-RPC.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.fail('Codex app-server emitted an invalid JSON-RPC message.');
      return;
    }
    const value = parsed as RpcResponse & RpcNotification;
    if (value.jsonrpc !== '2.0') {
      this.fail('Codex app-server emitted JSON-RPC with an unsupported version.');
      return;
    }
    // есть и `method`, и `id` — запрос сервера; только `id` — ответ на наш запрос
    if (
      typeof value.method === 'string' &&
      (typeof value.id === 'number' || typeof value.id === 'string')
    ) {
      this.serverRequest(value.id, value.method, value.params);
      return;
    }
    if (typeof value.id === 'number') {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (value.error)
        pending.reject(
          new CodexRpcError(
            value.error.message ?? 'Codex RPC failed.',
            value.error.code,
            value.error.data,
          ),
        );
      else pending.resolve(value.result);
      return;
    }
    if (typeof value.method === 'string') {
      // бросивший обработчик не должен рвать разбор: остаток чанка ещё в буфере, ответы в нём ждут
      try {
        this.options.onNotification?.(value.method, value.params);
      } catch (error) {
        this.options.onStderr?.(`Agentura: notification ${value.method} handler failed: ${String(error)}`);
      }
      return;
    }
    // `id: null` + error — сервер не разобрал наш запрос: это фатально, но с его текстом
    if (value.error)
      this.fail(`Codex app-server rejected a request: ${value.error.message ?? 'unknown error'}.`);
    else this.fail('Codex app-server emitted an invalid JSON-RPC message.');
  }

  private serverRequest(id: RpcId, method: string, params: unknown): void {
    const handler = this.options.onServerRequest;
    if (!handler) {
      this.respondError(id, `Method not found: ${method}`, -32601);
      return;
    }
    const failed = (error: unknown) =>
      this.respondError(id, `Server request ${method} failed: ${String(error)}`);
    try {
      void Promise.resolve(handler(id, method, params)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  private stderr(chunk: string): void {
    const lines = (this.stderrTail + chunk).split(/\r?\n/);
    this.stderrTail = lines.pop() ?? '';
    // строка без конца не копится бесконечно: отдаём её куском того же предела, что и stdout
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
    this.closed = new CodexRpcError(message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closed);
    }
    this.pending.clear();
    try {
      this.options.onClose?.(this.closed);
    } catch {
      // владелец уже знает достаточно; исключение отсюда ушло бы в обработчик потока
    }
  }
}

/** Не пишем в лог ключи, если CLI всё же вывел их в stderr. */
export function redact(value: string): string {
  return value
    .replace(
      /(OPENAI_API_KEY|CODEX_[A-Z0-9_]*TOKEN|authorization)\s*[=:]\s*(?:(?:Bearer|Basic)\s+)?[^\s,]+/gi,
      '$1=[REDACTED]',
    )
    // JSON-форма и OAuth-поля: "authorization": "Bearer x", "access_token": "…"
    .replace(
      /("(?:authorization|api[_-]?key|access_token|refresh_token|id_token|token)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /\b(api[_-]?key|access_token|refresh_token|id_token)\s*[=:]\s*[^\s,"]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
}
