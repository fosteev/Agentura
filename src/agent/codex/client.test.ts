import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CodexRpcClient, redact, type RpcProcess } from './client';

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function fake(): { process: FakeProcess; client: CodexRpcClient; sent: unknown[] } {
  const process = new FakeProcess();
  const sent: unknown[] = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (line: string) => sent.push(JSON.parse(line)));
  return { process, client: new CodexRpcClient(process as unknown as RpcProcess), sent };
}

describe('CodexRpcClient', () => {
  it('маршрутизирует ответ и notification; id монотонный', async () => {
    const process = new FakeProcess();
    const note = vi.fn();
    const sent: unknown[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (line: string) => sent.push(JSON.parse(line)));
    const client = new CodexRpcClient(process as unknown as RpcProcess, { onNotification: note });
    const first = client.request('initialize', { x: 1 });
    const second = client.request('model/list');
    process.stdout.write('{"jsonrpc":"2.0","method":"thread/started","params":{"id":"t"}}\n');
    process.stdout.write('{"jsonrpc":"2.0","id":2,"result":{"models":[]}}\n');
    process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ models: [] });
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { x: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'model/list' },
    ]);
    expect(note).toHaveBeenCalledWith('thread/started', { id: 't' });
  });

  it('держит хвост неполной строки и отклоняет ошибочный response', async () => {
    const { process, client } = fake();
    const response = client.request('thread/start');
    process.stdout.write('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"nope"}');
    process.stdout.write('}\n');
    await expect(response).rejects.toMatchObject({ message: 'nope', code: -1 });
  });

  it('ломает все pending при malformed JSON, закрытии stdout и exit', async () => {
    const a = fake();
    const pending = a.client.request('turn/start');
    a.process.stdout.write('not json\n');
    await expect(pending).rejects.toThrow(/malformed/);

    const b = fake();
    const closed = b.client.request('turn/start');
    b.process.stdout.end();
    await expect(closed).rejects.toThrow(/stdout closed/);

    const c = fake();
    const exited = c.client.request('turn/start');
    c.process.emit('exit', 1, null);
    c.process.emit('close', 1, null);
    await expect(exited).rejects.toThrow(/exited \(1\)/);
  });

  it('exit раньше конца stdout: последний ответ доходит; без close клиент закрывается после паузы', async () => {
    vi.useFakeTimers();
    try {
      const closed = vi.fn();
      const process = new FakeProcess();
      const client = new CodexRpcClient(process as unknown as RpcProcess, { onClose: closed });
      const last = client.request('thread/read');
      const stuck = client.request('turn/start');
      process.emit('exit', 0, null);
      process.stdout.write('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
      await expect(last).resolves.toBe('ok');
      expect(closed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      await expect(stuck).rejects.toThrow(/exited \(0\)/);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('бросивший onNotification не рвёт разбор чанка; null и id:null+error закрывают клиент с текстом', async () => {
    const process = new FakeProcess();
    const stderr: string[] = [];
    const client = new CodexRpcClient(process as unknown as RpcProcess, {
      onNotification: () => {
        throw new Error('mapper bug');
      },
      onStderr: (l) => stderr.push(l),
    });
    const own = client.request('turn/start');
    process.stdout.write(
      '{"jsonrpc":"2.0","method":"item/started","params":{}}\n{"jsonrpc":"2.0","id":1,"result":1}\n',
    );
    await expect(own).resolves.toBe(1);
    expect(stderr[0]).toMatch(/item\/started handler failed: Error: mapper bug/);

    const b = fake();
    const p1 = b.client.request('x');
    b.process.stdout.write('null\n');
    await expect(p1).rejects.toThrow(/invalid JSON-RPC/);

    const c = fake();
    const p2 = c.client.request('x');
    c.process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n');
    await expect(p2).rejects.toThrow(/rejected a request: Parse error/);
  });

  it('async-обработчик server request, отклонивший промис, даёт ответ -32603', async () => {
    const { process, sent } = (() => {
      const process = new FakeProcess();
      const sent: unknown[] = [];
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (line: string) => sent.push(JSON.parse(line)));
      new CodexRpcClient(process as unknown as RpcProcess, {
        onServerRequest: () => Promise.reject(new Error('ui gone')),
      });
      return { process, sent };
    })();
    process.stdout.write('{"jsonrpc":"2.0","id":7,"method":"item/tool/requestUserInput","params":{}}\n');
    await new Promise((r) => setImmediate(r));
    expect(sent).toMatchObject([{ id: 7, error: { code: -32603 } }]);
  });

  it('отклоняет timeout и чрезмерно длинную строку', async () => {
    const { process, client } = fake();
    await expect(client.request('initialize', undefined, 5)).rejects.toThrow(/timed out/);
    const oversized = new CodexRpcClient(process as unknown as RpcProcess, { maxLineBytes: 4 });
    const pending = oversized.request('turn/start');
    process.stdout.write('12345');
    await expect(pending).rejects.toThrow(/larger/);
  });

  it('редактирует вероятные секреты из stderr', () => {
    expect(redact('OPENAI_API_KEY=sk-secret authorization: Bearer-token')).toBe(
      'OPENAI_API_KEY=[REDACTED] authorization=[REDACTED]',
    );
    expect(redact('Authorization: Bearer abc.def-123456')).toBe('Authorization=[REDACTED]');
    expect(redact('header: Bearer abcdefgh12345678 ok')).toBe('header: Bearer [REDACTED] ok');
    expect(redact('key sk-proj-abcdefghijklmnop1234 used')).toBe('key [REDACTED] used');
    expect(redact('{"authorization":"Bearer x","access_token":"y","ok":"z"}')).toBe(
      '{"authorization":"[REDACTED]","access_token":"[REDACTED]","ok":"z"}',
    );
    expect(redact('refresh_token=abc id_token: def')).toBe('refresh_token=[REDACTED] id_token=[REDACTED]');
  });

  it('stderr собирается в строки до redact: ключ, разорванный чанками, не утекает', async () => {
    const process = new FakeProcess();
    const lines: string[] = [];
    new CodexRpcClient(process as unknown as RpcProcess, { onStderr: (l) => lines.push(l) });
    process.stderr.write('warn OPENAI_API_KEY=sk-sec');
    process.stderr.write('ret-value\nnext');
    process.stderr.end();
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual(['warn OPENAI_API_KEY=[REDACTED]', 'next']);
  });

  it('хвост длиннее лимита после последнего перевода строки тоже ломает клиент', async () => {
    const process = new FakeProcess();
    const client = new CodexRpcClient(process as unknown as RpcProcess, { maxLineBytes: 8 });
    const pending = client.request('turn/start');
    process.stdout.write('{"jsonrpc":"2.0","method":"a"}\n123456789');
    await expect(pending).rejects.toThrow(/larger/);
  });

  it('ошибка stdin (EPIPE после смерти процесса) ломает pending, а не роняет хост', async () => {
    const { process, client } = fake();
    const pending = client.request('turn/start');
    process.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(pending).rejects.toThrow(/stdin error/);
  });

  it('server request (id + method) идёт в onServerRequest, не в notifications и не в pending', async () => {
    const process = new FakeProcess();
    const note = vi.fn();
    const serverRequest = vi.fn();
    const sent: unknown[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (line: string) => sent.push(JSON.parse(line)));
    const client = new CodexRpcClient(process as unknown as RpcProcess, {
      onNotification: note,
      onServerRequest: serverRequest,
    });
    const own = client.request('thread/start'); // id 1 — совпадает по числу с id запроса сервера
    process.stdout.write(
      '{"jsonrpc":"2.0","id":1,"method":"item/commandExecution/requestApproval","params":{"command":"ls"}}\n',
    );
    process.stdout.write(
      '{"jsonrpc":"2.0","id":"s-7","method":"item/tool/requestUserInput","params":{}}\n',
    );
    expect(serverRequest).toHaveBeenNthCalledWith(1, 1, 'item/commandExecution/requestApproval', {
      command: 'ls',
    });
    expect(serverRequest).toHaveBeenNthCalledWith(2, 's-7', 'item/tool/requestUserInput', {});
    expect(note).not.toHaveBeenCalled();
    process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"thread":1}}\n');
    await expect(own).resolves.toEqual({ thread: 1 });
  });

  it('respond / respondError пишут JSON-RPC ответ с исходным id', () => {
    const { client, sent } = fake();
    client.respond(5, { decision: 'accept' });
    client.respondError('s-7', 'denied', -32000);
    client.respondError(9, 'boom');
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 5, result: { decision: 'accept' } },
      { jsonrpc: '2.0', id: 's-7', error: { code: -32000, message: 'denied' } },
      { jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'boom' } },
    ]);
  });

  it('без обработчика server request получает ошибку -32601; бросивший обработчик — -32603', () => {
    const a = fake();
    a.process.stdout.write(
      '{"jsonrpc":"2.0","id":3,"method":"item/fileChange/requestApproval","params":{}}\n',
    );
    expect(a.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: -32601, message: 'Method not found: item/fileChange/requestApproval' },
      },
    ]);
    const process = new FakeProcess();
    const sent: unknown[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (line: string) => sent.push(JSON.parse(line)));
    new CodexRpcClient(process as unknown as RpcProcess, {
      onServerRequest: () => {
        throw new Error('bad');
      },
    });
    process.stdout.write('{"jsonrpc":"2.0","id":4,"method":"x","params":{}}\n');
    expect(sent).toMatchObject([{ id: 4, error: { code: -32603 } }]);
  });

  it('после закрытия ответы не пишутся', () => {
    const { client, sent } = fake();
    client.dispose();
    client.respond(1, {});
    expect(sent).toEqual([]);
  });
});
