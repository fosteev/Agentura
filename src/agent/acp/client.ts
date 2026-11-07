import type { Readable, Writable } from 'node:stream';

export interface RpcProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => unknown): unknown;
}

/** `id` JSON-RPC: число (включая 0) или строка (`"1"` у серверных запросов `agy acp`). Отсутствие поля — не id. */
export type RpcId = string | number;

export const JSONRPC = '2.0' as const;

/** `session/request_permission`. Клиент отвечает сам, если адаптер не забрал запрос. */
export const PERMISSION_METHOD = 'session/request_permission';

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

export class AcpRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
    engine?: string,
  ) {
    super(message);
    this.name = engine ? `${engine}RpcError` : 'AcpRpcError';
  }
}

export interface AcpRpcClientOptions {
  /** Метка движка в сообщениях и имени ошибки: `Cursor` → «Cursor ACP stdout closed.». По умолчанию `Agent`. */
  engine?: string;
  timeoutMs?: number;
  /** Лимит одной строки stdout. По умолчанию 64 МБ. */
  maxLineBytes?: number;
  onNotification?(method: string, params: unknown): void;
  /**
   * Запрос сервера. `true` — ответ уже отправлен, клиент молчит.
   * Иначе клиент отвечает сам: разрешение — отказом, прочее — ошибкой JSON-RPC.
   */
  onServerRequest?(id: RpcId, method: string, params: unknown): boolean | Promise<boolean | void> | void;
  /**
   * Тело ответа на `session/request_permission`, которое адаптер не забрал.
   * По умолчанию — `optionId` опции `kind: "reject_once"` из кадра, иначе `reject-once`.
   */
  refusePermission?(params: unknown): unknown;
  onStderr?(line: string): void;
  onClose?(error: AcpRpcError): void;
}

/** Сколько ждать хвост stdout после `exit`, прежде чем считать клиент мёртвым. */
const EXIT_GRACE_MS = 1000;

/** Строка длиннее этого — обрыв протокола, а не кадр. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * JSON-RPC 2.0, один JSON на строку, поверх stdin/stdout ACP-агента (`agent acp`, `agy acp`).
 * Поле `jsonrpc` обязано быть `"2.0"` (живые фикстуры; в отличие от Codex app-server, который его опускает).
 * Id `0` и строковый id — обычные id: проверяется наличие поля, не truthiness.
 */
export class AcpRpcClient {
  private nextId = 1;
  private buffer = '';
  private bufferBytes = 0;
  private stderrTail = '';
  private exitMessage: string | undefined;
  private closed: AcpRpcError | undefined;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void; timer: NodeJS.Timeout | undefined }
  >();
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;
  /** `Cursor`, `Antigravity`: метка движка в тексте ошибок. */
  readonly engine: string;

  constructor(
    private readonly process: RpcProcess,
    private readonly options: AcpRpcClientOptions = {},
  ) {
    this.engine = options.engine ?? 'Agent';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    process.stdout.on('data', (data: string | Buffer) => this.read(String(data)));
    process.stdout.on('end', () => this.fail(this.exitMessage ?? `${this.engine} ACP stdout closed.`));
    process.stderr.on('data', (data: string | Buffer) => this.stderr(String(data)));
    process.stderr.on('end', () => this.flushStderr());
    process.stdin.on('error', (error) => this.fail(`${this.engine} ACP stdin error: ${String(error)}`));
    process.on('error', (error) => this.fail(`${this.engine} ACP error: ${String(error)}`));
    process.on('exit', (code, signal) => {
      this.exitMessage = `${this.engine} ACP exited (${String(code)}${signal ? `, ${String(signal)}` : ''}).`;
      setTimeout(() => this.fail(this.exitMessage!), EXIT_GRACE_MS).unref?.();
    });
    process.on('close', () => this.fail(this.exitMessage ?? `${this.engine} ACP closed.`));
  }

  /** Сообщение `onClose` после `dispose()`: владелец отличает им свой же вызов от аварии. */
  get disposedMessage(): string {
    return `${this.engine} RPC client disposed.`;
  }

  /** `timeoutMs: null` — ждать до ответа или закрытия транспорта (долгий session/prompt). */
  request<T = unknown>(method: string, params?: unknown, timeoutMs: number | null = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const message = JSON.stringify({
      jsonrpc: JSONRPC,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(this.error(`${this.engine} RPC ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.process.stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.error(`${this.engine} RPC ${method} could not be written: ${String(error)}`));
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
      this.fail(`${this.engine} RPC ${method} could not be written: ${String(error)}`);
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
      this.fail(`${this.engine} RPC response could not be written: ${String(error)}`);
    }
  }

  dispose(): void {
    this.fail(this.disposedMessage);
  }

  private error(message: string, code?: number, data?: unknown): AcpRpcError {
    return new AcpRpcError(message, code, data, this.engine);
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
        this.fail(`${this.engine} ACP emitted a line larger than ${this.maxLineBytes} bytes.`);
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
      this.fail(`${this.engine} ACP emitted a line larger than ${this.maxLineBytes} bytes.`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(`${this.engine} ACP emitted malformed JSON-RPC.`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.fail(`${this.engine} ACP emitted an invalid JSON-RPC message.`);
      return;
    }
    const value = parsed as Record<string, unknown>;
    if (value.jsonrpc !== JSONRPC) {
      this.fail(`${this.engine} ACP emitted JSON-RPC without jsonrpc "2.0".`);
      return;
    }
    const id = rpcId(value);
    if (typeof value.method === 'string' && id !== undefined) {
      this.serverRequest(id, value.method, value.params);
      return;
    }
    // Ответы на наши запросы несут числовой id; строковый id без method — не наш ответ.
    if (id !== undefined && typeof id === 'number' && ('result' in value || 'error' in value)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = value.error;
      if (error && typeof error === 'object') {
        const err = error as RpcErrorShape;
        pending.reject(this.error(err.message ?? `${this.engine} RPC failed.`, err.code, err.data));
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
      this.fail(`${this.engine} ACP rejected a request: ${err.message ?? 'unknown error'}.`);
    } else this.fail(`${this.engine} ACP emitted an invalid JSON-RPC message.`);
  }

  private serverRequest(id: RpcId, method: string, params: unknown): void {
    const finish = (handled: boolean | void): void => {
      if (handled === true) return;
      if (method === PERMISSION_METHOD) {
        this.respond(id, (this.options.refusePermission ?? defaultPermissionRefusal)(params));
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
    this.closed = this.error(message);
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

/**
 * Отказ формой, которую принимают Cursor и Antigravity: `{outcome:{outcome:"selected", optionId}}`.
 * `optionId` — у опции `kind: "reject_once"` из кадра (`reject-once` у Cursor, `deny` у `agy`); нет опции — `reject-once`.
 */
export function defaultPermissionRefusal(params: unknown): { outcome: { outcome: 'selected'; optionId: string } } {
  const options = (typeof params === 'object' && params !== null ? (params as { options?: unknown }).options : undefined);
  if (Array.isArray(options)) {
    for (const item of options) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as { optionId?: unknown; kind?: unknown };
      if (row.kind === 'reject_once' && typeof row.optionId === 'string' && row.optionId)
        return { outcome: { outcome: 'selected', optionId: row.optionId } };
    }
  }
  return { outcome: { outcome: 'selected', optionId: 'reject-once' } };
}

/** Не пишем в лог ключи, если CLI всё же вывел их в stderr. */
export function redact(value: string): string {
  return value
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)|authorization)\s*[=:]\s*(?:(?:Bearer|Basic)\s+)?[^\s,]+/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /("(?:authorization|api[_-]?key|access_token|refresh_token|id_token|token)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bya29\.[A-Za-z0-9._-]{8,}/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
}
