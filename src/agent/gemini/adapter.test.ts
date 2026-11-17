import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { GEMINI_NOT_FOUND, resolveGeminiExecutable } from './executable';
import { parseGeminiModels } from './models';
import { GeminiAdapter, type GeminiAcpProcess } from './adapter';

class FakeGeminiAcp extends EventEmitter implements GeminiAcpProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: { id?: number | string; method: string; params?: unknown }[] = [];
  readonly handlers = new Map<string, (params: Record<string, unknown>, id: number | string) => unknown>();
  exited = false;
  killed = false;
  private buf = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
        if (msg.method) {
          this.received.push({ id: msg.id, method: msg.method, params: msg.params });
          const fn = this.handlers.get(msg.method);
          if (msg.id !== undefined) {
            Promise.resolve()
              .then(() => (fn ? fn(msg.params ?? {}, msg.id!) : {}))
              .then(
                (result) => this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`),
                (err: unknown) =>
                  this.stdout.write(
                    `${JSON.stringify({
                      jsonrpc: '2.0',
                      id: msg.id,
                      error: {
                        code: (err as { code?: number })?.code ?? -32000,
                        message: err instanceof Error ? err.message : String(err),
                      },
                    })}\n`,
                  ),
              );
          }
        } else {
          this.received.push({ id: msg.id, method: '<response>', params: msg });
        }
      }
    });
  }

  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  handle(method: string, fn: (params: Record<string, unknown>, id: number | string) => unknown): this {
    this.handlers.set(method, fn);
    return this;
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(id: number | string, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }

  replies(): { id?: number | string; result?: unknown }[] {
    return this.received
      .filter((r) => r.method === '<response>')
      .map((r) => r.params as { id?: number | string; result?: unknown });
  }

  kill(): boolean {
    this.killed = true;
    this.exited = true;
    this.emit('exit', 0, null);
    this.stdout.end();
    this.emit('close', 0);
    return true;
  }
}

describe('gemini executable and models', () => {
  it('resolves gemini executable and parses version', async () => {
    const res = await resolveGeminiExecutable('', {
      env: { PATH: '/usr/local/bin' },
      exists: (p) => p === '/usr/local/bin/gemini',
      runVersion: async () => '0.67.0\n',
    });
    expect(res).toMatchObject({ path: '/usr/local/bin/gemini', version: '0.67.0', source: 'system' });

    const miss = await resolveGeminiExecutable('', {
      env: { PATH: '/empty' },
      exists: () => false,
    });
    expect(miss).toEqual({ source: 'none', reason: 'missing', problem: GEMINI_NOT_FOUND });
  });

  it('parses real `gemini --list-models` output', () => {
    const out = [
      'Available Gemini Models:',
      '',
      'auto (Auto)',
      '  Description:   Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-3.5-flash',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
      '',
      'gemini-2.5-pro (gemini-2.5-pro)',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
      '',
      'gemini-3.5-flash (gemini-3.5-flash)',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
      '',
      'gemini-3.1-flash-lite (gemini-3.1-flash-lite)',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
    ].join('\n');

    expect(parseGeminiModels(out)).toEqual([
      {
        value: 'auto',
        displayName: 'Auto',
        supportsEffort: false,
        description: 'Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-3.5-flash',
      },
      { value: 'gemini-2.5-pro', displayName: 'gemini-2.5-pro', supportsEffort: false },
      { value: 'gemini-3.5-flash', displayName: 'gemini-3.5-flash', supportsEffort: false },
      { value: 'gemini-3.1-flash-lite', displayName: 'gemini-3.1-flash-lite', supportsEffort: false },
    ]);
  });
});

describe('GeminiAdapter (ACP)', () => {
  it('detects IneligibleTierError (-32000) in probeAuth without hanging', async () => {
    const fake = new FakeGeminiAcp();
    fake.handle('initialize', () => ({ protocolVersion: 1 }));
    fake.handle('session/new', () => {
      throw Object.assign(
        new Error('IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.'),
        { code: -32000 },
      );
    });
    const adapter = new GeminiAdapter({
      executablePath: '/bin/gemini',
      spawn: () => fake,
    });
    const probe = await adapter.probeAuth('/tmp/w');
    expect(probe.ok).toBe(false);
    expect(probe.needsAuth).toBe(true);
    expect(probe.reason).toContain('IneligibleTierError');
  });

  it('passes hostMcpServers in session/new, streams response, and auto-allows agentura_agents', async () => {
    const fake = new FakeGeminiAcp();
    const spawnedArgs: string[][] = [];
    fake.handle('initialize', () => ({ protocolVersion: 1 }));
    fake.handle('session/new', () => ({
      sessionId: 'gem-sess-1',
      models: {
        currentModelId: 'gemini-2.5-pro',
        availableModels: [{ modelId: 'gemini-2.5-pro', name: 'gemini-2.5-pro' }],
      },
    }));
    fake.handle('session/prompt', async () => {
      fake.request('gperm-1', 'session/request_permission', {
        sessionId: 'gem-sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'mcp_agentura_agents_agent_spawn' },
        options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'deny-1', kind: 'reject_once' }],
      });
      await new Promise((r) => setTimeout(r, 20));
      fake.notify('session/update', {
        sessionId: 'gem-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GEMINI_OK' } },
      });
      return { stopReason: 'end_turn' };
    });

    const adapter = new GeminiAdapter({
      executablePath: '/bin/gemini',
      spawn: (_cmd, args) => {
        spawnedArgs.push(args);
        return fake;
      },
    });
    const session = await adapter.createSession({
      cwd: '/tmp/w',
      permissionMode: 'default',
      model: 'gemini-2.5-pro',
      hostMcpServers: [{ name: 'agentura_agents', url: 'http://127.0.0.1:49999/mcp/tok', builtin: true }],
    });
    const events: AgentEvent[] = [];
    session.events.on((e) => events.push(e));
    session.send('run child');

    await expect.poll(() => events.some((e) => e.type === 'turn.result')).toBe(true);
    expect(spawnedArgs[0]).toEqual(['--acp', '--skip-trust', '--approval-mode', 'default', '--model', 'gemini-2.5-pro']);
    expect(fake.received.find((r) => r.method === 'session/new')?.params).toMatchObject({
      cwd: '/tmp/w',
      mcpServers: [{ type: 'http', name: 'agentura_agents', url: 'http://127.0.0.1:49999/mcp/tok', headers: [] }],
    });
    expect(fake.replies()[0]).toMatchObject({
      id: 'gperm-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow-1' } },
    });
    expect(events.some((e) => e.type === 'permission.request')).toBe(false);
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ ok: true, text: 'GEMINI_OK' });
    session.dispose();
  });
});
