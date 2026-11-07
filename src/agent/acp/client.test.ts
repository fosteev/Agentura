import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AcpRpcClient, AcpRpcError, MAX_LINE_BYTES, redact, type RpcProcess } from './client';

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function open(options?: ConstructorParameters<typeof AcpRpcClient>[1]) {
  const process = new FakeProcess();
  const sent: unknown[] = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) sent.push(JSON.parse(line));
  });
  const client = new AcpRpcClient(process as unknown as RpcProcess, options);
  return { process, client, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const frame = (value: object) => `${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`;

describe('AcpRpcClient', () => {
  it('лимит строки по умолчанию — 64 МБ', () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('ответ, notification и запрос сервера — разные кадры; без jsonrpc 2.0 поток умирает', async () => {
    const note = { seen: '' };
    const { process, client } = open({ onNotification: (method) => (note.seen = method) });
    const pending = client.request('initialize', { protocolVersion: 1 });
    process.stdout.write(frame({ method: 'session/update', params: { update: {} } }));
    expect(note.seen).toBe('session/update');
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    await tick();
    expect(settled).toBe(false);
    process.stdout.write('{"id":1,"result":{}}\n');
    await expect(pending).rejects.toThrow(/jsonrpc/);

    const again = open();
    const ok = again.client.request('initialize');
    again.process.stdout.write(frame({ id: 1, result: { protocolVersion: 1 } }));
    await expect(ok).resolves.toEqual({ protocolVersion: 1 });
    expect(again.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    again.client.notify('session/cancel', { sessionId: 's' });
    expect(again.sent[1]).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });
    expect(again.sent[1]).not.toHaveProperty('id');
  });

  it('метка движка попадает в ошибки и имя ошибки; по умолчанию — Agent', async () => {
    const a = open({ engine: 'Antigravity' });
    const pending = a.client.request('initialize');
    a.process.stdout.write(frame({ id: 1, error: { code: -32602, message: 'bad' } }));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcpRpcError);
    expect(error).toMatchObject({ message: 'bad', code: -32602, name: 'AntigravityRpcError' });

    const timed = open({ engine: 'Antigravity', timeoutMs: 5 });
    await expect(timed.client.request('session/new')).rejects.toThrow('Antigravity RPC session/new timed out after 5 ms.');

    const closed = open({ engine: 'Antigravity' });
    const waiting = closed.client.request('initialize');
    closed.process.stdout.end();
    await expect(waiting).rejects.toThrow('Antigravity ACP stdout closed.');

    const plain = open();
    const waitingPlain = plain.client.request('initialize');
    plain.client.dispose();
    await expect(waitingPlain).rejects.toThrow('Agent RPC client disposed.');
    expect(plain.client.disposedMessage).toBe('Agent RPC client disposed.');
  });

  it('id 0 и строковый id запроса сервера: отказ по kind reject_once, optionId берётся из кадра', async () => {
    const { process, sent, client } = open();
    process.stdout.write(
      frame({
        id: 0,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'reject-once', kind: 'reject_once' }] },
      }),
    );
    process.stdout.write(
      frame({
        id: '1',
        method: 'session/request_permission',
        params: {
          options: [
            { optionId: 'allow', kind: 'allow_once' },
            { optionId: 'deny', kind: 'reject_once' },
          ],
        },
      }),
    );
    process.stdout.write(frame({ id: '2', method: 'session/request_permission', params: {} }));
    await tick();
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
      { jsonrpc: '2.0', id: '1', result: { outcome: { outcome: 'selected', optionId: 'deny' } } },
      { jsonrpc: '2.0', id: '2', result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ]);
    client.dispose();
  });

  it('refusePermission подменяет форму отказа', async () => {
    const { process, sent } = open({ refusePermission: () => ({ custom: true }) });
    process.stdout.write(frame({ id: '1', method: 'session/request_permission', params: {} }));
    await tick();
    expect(sent).toEqual([{ jsonrpc: '2.0', id: '1', result: { custom: true } }]);
  });

  it('true из onServerRequest — клиент не шлёт второй кадр; id возвращается как пришёл', async () => {
    const box: { client?: AcpRpcClient } = {};
    const seen: unknown[] = [];
    const opened = open({
      onServerRequest(id, method) {
        seen.push([id, typeof id, method]);
        box.client?.respond(id, { action: 'decline' });
        return true;
      },
    });
    box.client = opened.client;
    opened.process.stdout.write(frame({ id: '1', method: 'elicitation/create', params: {} }));
    await tick();
    expect(seen).toEqual([['1', 'string', 'elicitation/create']]);
    expect(opened.sent).toEqual([{ jsonrpc: '2.0', id: '1', result: { action: 'decline' } }]);
  });

  it('неизвестный метод, даже с id 0 или строкой, — ошибка JSON-RPC, запрос не зависает', async () => {
    const { process, sent } = open();
    process.stdout.write(frame({ id: 0, method: 'x/unknown', params: {} }));
    process.stdout.write(frame({ id: '7', method: 'elicitation/create', params: {} }));
    await tick();
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found: x/unknown' } },
      { jsonrpc: '2.0', id: '7', error: { code: -32601, message: 'Method not found: elicitation/create' } },
    ]);
  });

  it('обработчик запроса, бросивший исключение, получает ошибку JSON-RPC', async () => {
    const { process, sent } = open({
      onServerRequest() {
        throw new Error('boom');
      },
    });
    process.stdout.write(frame({ id: '3', method: 'session/request_permission', params: {} }));
    await tick();
    expect(sent[0]).toMatchObject({ id: '3', error: { code: -32603 } });
  });

  it('строковый id без method — не ответ на наш числовой запрос: поток считается сломанным', async () => {
    const { process, client } = open({ engine: 'Antigravity' });
    const pending = client.request('initialize');
    process.stdout.write(frame({ id: '1', result: {} }));
    await expect(pending).rejects.toThrow('Antigravity ACP emitted an invalid JSON-RPC message.');
  });

  it('строка длиннее лимита рвёт клиент', async () => {
    const { process, client } = open({ maxLineBytes: 8, engine: 'Antigravity' });
    const pending = client.request('initialize');
    process.stdout.write('{"jsonrpc":"2.0"}\n');
    await expect(pending).rejects.toThrow(/Antigravity ACP emitted a line larger than 8/);
  });

  it('stderr строками и с маскировкой ключей', async () => {
    const lines: string[] = [];
    const { process } = open({ onStderr: (l) => lines.push(l) });
    process.stderr.write('GEMINI_API_KEY=abc123 token\nBearer abcdefghijkl\n');
    await tick();
    expect(lines).toEqual(['GEMINI_API_KEY=[REDACTED] token', 'Bearer [REDACTED]']);
    expect(redact('CURSOR_API_KEY: secret')).toBe('CURSOR_API_KEY=[REDACTED]');
  });
});
