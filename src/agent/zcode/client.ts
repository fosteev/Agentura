import type { Readable, Writable } from 'node:stream';

export type ZCodeRpcId = number | string;

export interface ZCodeRpcProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): this;
}

export class ZCodeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ZCodeRpcError';
  }
}

export interface ZCodeRpcOptions {
  timeoutMs?: number;
  maxLineBytes?: number;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (id: ZCodeRpcId, method: string, params: unknown) => boolean;
  onStderr?: (line: string) => void;
  onClose?: (error: Error) => void;
}

export const ZCODE_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class ZCodeRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout | undefined;
    }
  >();
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private stderrBuf = '';
  private closed = false;
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(
    private readonly proc: ZCodeRpcProcess,
    private readonly options: ZCodeRpcOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxLineBytes = options.maxLineBytes ?? ZCODE_MAX_LINE_BYTES;
    proc.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer | string) => this.onStderr(chunk));
    proc.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    proc.on('close', (code) => this.failAll(new Error(`zcode app-server exited (code ${String(code ?? 'unknown')})`)));
    proc.stdout.on('end', () => this.failAll(new Error('zcode app-server stdout closed')));
  }

  request(method: string, params: unknown, timeoutMs: number | null = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`zcode RPC closed (${method})`));
    const id = this.nextId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== null && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(key)) return;
          reject(new Error(`zcode RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(key, { method, resolve, reject, timer });
      try {
        this.writeFrame({ id, method, params });
      } catch (err) {
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  respond(id: ZCodeRpcId, result: unknown): void {
    if (this.closed) return;
    this.writeFrame({ id, result });
  }

  respondError(id: ZCodeRpcId, code: number, message: string): void {
    if (this.closed) return;
    this.writeFrame({ id, error: { code, message } });
  }

  dispose(): void {
    if (this.closed) return;
    this.failAll(new Error('ZCode RPC client disposed.'));
  }

  private writeFrame(frame: unknown): void {
    this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private onData(chunk: Buffer | string): void {
    if (this.closed) return;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.chunks.push(buf);
    this.bufferedBytes += buf.length;
    if (this.bufferedBytes > this.maxLineBytes) {
      this.failAll(new Error(`zcode stdout exceeded maxLineBytes (${this.maxLineBytes})`));
      return;
    }
    const merged = Buffer.concat(this.chunks);
    let start = 0;
    while (start < merged.length) {
      const nl = merged.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = merged.subarray(start, nl).toString('utf8').replace(/\r$/, '');
      start = nl + 1;
      if (line.trim()) this.handleLine(line);
    }
    const rem = merged.subarray(start);
    this.chunks = rem.length > 0 ? [rem] : [];
    this.bufferedBytes = rem.length;
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : undefined;
    const method = typeof msg.method === 'string' ? msg.method : undefined;

    if (id !== undefined && method !== undefined) {
      const handled = this.options.onServerRequest?.(id, method, msg.params) ?? false;
      if (!handled) this.respondError(id, -32601, `Method not handled: ${method}`);
      return;
    }
    if (method !== undefined) {
      this.options.onNotification?.(method, msg.params);
      return;
    }
    if (id !== undefined) {
      const key = String(id);
      const waiter = this.pending.get(key);
      if (!waiter) return;
      this.pending.delete(key);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as { code?: unknown; message?: unknown; data?: unknown };
        waiter.reject(
          new ZCodeRpcError(
            typeof e.code === 'number' ? e.code : -32000,
            typeof e.message === 'string' ? e.message : `zcode RPC error on ${waiter.method}`,
            e.data,
          ),
        );
      } else {
        waiter.resolve(msg.result);
      }
    }
  }

  private onStderr(chunk: Buffer | string): void {
    this.stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl).trimEnd();
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (line) this.options.onStderr?.(line);
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.options.onClose?.(error);
  }
}
