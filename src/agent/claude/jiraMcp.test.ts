/**
 * MCP-сервер `agentura_jira` (roadmap 19, этап 8) на настоящем SDK 0.3.285 и zod: что видит модель (`tools/list`) и как вызов
 * доходит до хоста (`tools/call`). Клиент MCP подключён к серверу из `createSdkMcpServer` через in-memory транспорт.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { TaskTools, TaskToolsSpec } from '../types';
import { buildJiraServer, specSignature, type McpKit } from './jiraMcp';

const kit: McpKit = { createSdkMcpServer, tool, z };

function host(run: TaskTools['run'] = async () => ({ text: 'ok' }), spec: () => TaskToolsSpec | undefined = () => SPEC): TaskTools {
  return { spec, onDidChange: () => () => undefined, run: vi.fn(run) };
}

async function connect(spec: TaskToolsSpec, tools: TaskTools) {
  const server = buildJiraServer(kit, spec, tools);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return { server, client };
}

const SPEC: TaskToolsSpec = { issue: 'NEWMFC-1482', instance: 'Jira DC', tools: ['comment', 'transition', 'worklog'] };

describe('buildJiraServer', () => {
  it('сервер `agentura_jira` (type sdk) с тремя инструментами и схемами; описание — ключ задачи', async () => {
    const { server, client } = await connect(SPEC, host());
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('agentura_jira');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['comment', 'transition', 'worklog']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['comment']!.description).toContain('NEWMFC-1482');
    expect(byName['comment']!.inputSchema.required).toEqual(['text']);
    expect(Object.keys(byName['comment']!.inputSchema.properties ?? {})).toEqual(['text', 'issue']);
    expect(byName['transition']!.inputSchema.required).toEqual(['to']);
    expect(byName['worklog']!.inputSchema.required).toEqual(['minutes']);
    expect(Object.keys(byName['worklog']!.inputSchema.properties ?? {})).toEqual(['minutes', 'date', 'comment', 'issue']);
    expect(client.getInstructions()).toContain('NEWMFC-1482');
    await client.close();
  });

  it('только включённые инструменты', async () => {
    const { client } = await connect({ ...SPEC, tools: ['comment'] }, host());
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['comment']);
    await client.close();
  });

  it('вызов уходит хосту с аргументами модели; ошибка хоста — isError, исключение — тоже текстом', async () => {
    const tools = host(async (name, args) =>
      name === 'comment' ? { text: `done ${String(args['text'])}\nevent: comment:1` } : { text: 'Error: nope', isError: true },
    );
    const { client } = await connect(SPEC, tools);
    const ok = await client.callTool({ name: 'comment', arguments: { text: 'h3. Итог' } });
    expect(ok).toMatchObject({ content: [{ type: 'text', text: 'done h3. Итог\nevent: comment:1' }] });
    expect(ok.isError).toBeFalsy();
    expect(tools.run).toHaveBeenCalledWith('comment', { text: 'h3. Итог' });
    const bad = await client.callTool({ name: 'transition', arguments: { to: 'Done' } });
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'Error: nope' }] });
    vi.mocked(tools.run).mockRejectedValueOnce(new Error('boom'));
    const thrown = await client.callTool({ name: 'worklog', arguments: { minutes: 30 } });
    expect(thrown).toMatchObject({ isError: true, content: [{ text: 'Error: boom' }] });
    await client.close();
  });

  it('схема отсекает мусор до хоста: минуты не целые, дата не YYYY-MM-DD, пустой текст', async () => {
    const tools = host();
    const { client } = await connect(SPEC, tools);
    for (const [name, args] of [
      ['worklog', { minutes: 1.5 }],
      ['worklog', { minutes: 10, date: 'вчера' }],
      ['comment', { text: '' }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
    }
    expect(tools.run).not.toHaveBeenCalled();
    await client.close();
  });

  it('чат перепривязали к другой задаче, пока висела карточка, — отказ, хост не вызывается', async () => {
    let now: TaskToolsSpec | undefined = SPEC;
    const tools = host(undefined, () => now);
    const { client } = await connect(SPEC, tools);
    now = { ...SPEC, issue: 'NEWMFC-2' };
    const r = await client.callTool({ name: 'comment', arguments: { text: 'x' } });
    expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('now attached to NEWMFC-2 instead of NEWMFC-1482') }] });
    now = undefined;
    expect((await client.callTool({ name: 'transition', arguments: { to: 'Done' } })).isError).toBe(true);
    expect(tools.run).not.toHaveBeenCalled();
    await client.close();
  });

  it('specSignature: порядок инструментов не важен; нет набора — пусто', () => {
    expect(specSignature(SPEC)).toBe(specSignature({ ...SPEC, tools: ['worklog', 'comment', 'transition'] }));
    expect(specSignature(undefined)).toBe('');
    expect(specSignature({ ...SPEC, issue: 'X-1' })).not.toBe(specSignature(SPEC));
  });
});
