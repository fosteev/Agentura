import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CursorRpcClient, MAX_LINE_BYTES, type RpcProcess } from './client';

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function open(options?: ConstructorParameters<typeof CursorRpcClient>[1]) {
  const process = new FakeProcess();
  const sent: unknown[] = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (line: string) => sent.push(JSON.parse(line)));
  const client = new CursorRpcClient(process as unknown as RpcProcess, options);
  return { process, client, sent };
}

describe('CursorRpcClient', () => {
  it('лимит строки по умолчанию — 64 МБ, короче лимита не рвёт поток', () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('ответ, notification и запрос сервера — разные кадры; без jsonrpc 2.0 поток умирает', async () => {
    const note = { seen: '' };
    const { process, client } = open({ onNotification: (method) => (note.seen = method) });
    const pending = client.request('initialize', { protocolVersion: 1 });
    process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"update":{}}}\n');
    expect(note.seen).toBe('session/update');
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    process.stdout.write('{"id":1,"result":{}}\n');
    await expect(pending).rejects.toThrow(/jsonrpc/);

    const again = open();
    const ok = again.client.request('initialize');
    again.process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
    await expect(ok).resolves.toEqual({ protocolVersion: 1 });
    expect(again.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    again.client.notify('session/cancel', { sessionId: 's' });
    expect(again.sent[1]).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });
    expect(again.sent[1]).not.toHaveProperty('id');
  });

  it('id 0 у session/request_permission — отказ формой спайка, не пропуск поля', async () => {
    const { process, client, sent } = open();
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: { sessionId: 's', options: [{ optionId: 'reject-once', kind: 'reject_once' }] },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
      },
    ]);
    client.dispose();
  });

  it('true из onServerRequest — клиент не шлёт второй кадр', async () => {
    const box: { client?: CursorRpcClient } = {};
    const opened = open({
      onServerRequest(id) {
        box.client?.respond(id, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
        return true;
      },
    });
    box.client = opened.client;
    opened.process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} })}\n`,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(opened.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      },
    ]);
  });

  it('неизвестный метод, даже с id 0, — ошибка JSON-RPC, запрос не зависает', async () => {
    const { process, sent } = open();
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'cursor/create_plan', params: {} })}\n`,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32601, message: 'Method not found: cursor/create_plan' },
      },
    ]);
  });

  it('строка длиннее лимита рвёт клиент', async () => {
    const { process, client } = open({ maxLineBytes: 8 });
    const pending = client.request('initialize');
    process.stdout.write('{"jsonrpc":"2.0"}\n');
    await expect(pending).rejects.toThrow(/larger than 8/);
  });
});
