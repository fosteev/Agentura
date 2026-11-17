import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { ZCODE_NOT_FOUND, parseZCodeDoctor, parseZCodeVersion, resolveZCodeExecutable } from './executable';
import { isZCodeAuthFailure, parseZCodeModelSelection, parseZCodeModelsFromSettings } from './protocol';
import { ZCodeAdapter, type ZCodeProcess } from './adapter';

class FakeZCodeProc extends EventEmitter implements ZCodeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: { id?: number | string; method: string; params?: unknown }[] = [];
  readonly handlers = new Map<string, (params: Record<string, unknown>, id: number | string) => unknown>();
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
                      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
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

  kill(): boolean {
    this.emit('exit', 0, null);
    this.stdout.end();
    this.emit('close', 0);
    return true;
  }
}

describe('zcode executable, doctor, and fixtures', () => {
  it('resolves zcode binary via doctor JSON and rejects non-zcode binary', async () => {
    const doctorOut = JSON.stringify({ cli: { name: 'zcode', version: '0.17.1' } });
    expect(parseZCodeVersion(doctorOut)).toBe('0.17.1');
    expect(parseZCodeDoctor(doctorOut)).toEqual({ cliName: 'zcode', version: '0.17.1' });

    const ok = await resolveZCodeExecutable('', {
      env: { PATH: '/usr/local/bin' },
      exists: (p) => p === '/usr/local/bin/zcode',
      runDoctorOrVersion: async () => doctorOut,
    });
    expect(ok).toMatchObject({ path: '/usr/local/bin/zcode', version: '0.17.1', source: 'system' });

    const wrong = await resolveZCodeExecutable('/bin/other', {
      runDoctorOrVersion: async () => JSON.stringify({ cli: { name: 'other', version: '1.0.0' } }),
    });
    expect(wrong.reason).toBe('wrong');

    const miss = await resolveZCodeExecutable('', {
      env: { PATH: '/none' },
      exists: () => false,
    });
    expect(miss).toEqual({ source: 'none', reason: 'missing', problem: ZCODE_NOT_FOUND });
  });

  it('recognizes sanitized spike fixtures (project_token_login_failed & 1113 auth blockers)', () => {
    const sample = JSON.parse(
      readFileSync(join(__dirname, '../../../test/fixtures/zcode/session-sample.json'), 'utf8'),
    ) as {
      sessionCreateResult: unknown;
      sessionListResult: { sessions: { sessionId: string }[] };
    };
    expect(parseZCodeModelsFromSettings(sample.sessionCreateResult)).toEqual([]);
    expect(sample.sessionListResult.sessions[0]?.sessionId).toBe('sess_uuid-02');

    const lines = readFileSync(join(__dirname, '../../../test/fixtures/zcode/pong.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; payload: { error?: { message?: string } } });
    const failed = lines.find((l) => l.type === 'turn.failed')!;
    expect(isZCodeAuthFailure(failed.payload.error?.message ?? '')).toBe(true);
    expect(isZCodeAuthFailure('HTTP 429 [1113] Insufficient balance or no resource package')).toBe(true);
    expect(parseZCodeModelSelection('agentura-zai-key/glm-5.3')).toEqual({
      providerId: 'agentura-zai-key',
      modelId: 'glm-5.3',
    });
  });
});

describe('ZCodeAdapter (app-server --stdio)', () => {
  it('inspectRuntime reports needs-auth / unauthenticated honestly when model.available is empty', async () => {
    const proc = new FakeZCodeProc();
    proc.handle('runtime/capabilities', () => ({ protocol: { name: 'ZCode Protocol', version: 1 } }));
    proc.handle('session/create', () => ({
      session: { sessionId: 's-1', mode: 'guarded' },
      settings: { model: { available: [] } },
    }));
    const adapter = new ZCodeAdapter({
      executablePath: '/bin/zcode',
      doctor: async () => ({ cliName: 'zcode', version: '0.17.1' }),
      spawn: () => proc,
      env: {},
    });
    const res = await adapter.inspectRuntime('/tmp/w');
    expect(res.authenticated).toBe(false);
    expect(res.models).toEqual([]);
    expect(res.reason).toContain('project_token_login_failed');
  });

  it('parses zcode 0.17 ref models and surfaces provider/testModelConnectivity billing errors', async () => {
    const proc = new FakeZCodeProc();
    proc.handle('runtime/capabilities', () => ({ sessionLifecycleWorkspace: true }));
    proc.handle('session/create', () => {
      proc.request('srv-1', 'session/requestRuntimePreferences', {});
      proc.request('srv-2', 'interaction/requestOfficialMcpAuthHeaders', {});
      return {
        session: { sessionId: 's-2', mode: 'guarded', model: { providerId: 'agentura-zai-key', modelId: 'glm-5.3' } },
        settings: {
          model: {
            available: [{ ref: { providerId: 'agentura-zai-key', modelId: 'glm-5.3' }, label: 'glm-5.3', providerLabel: 'Z.ai Coding Plan key' }],
          },
        },
      };
    });
    proc.handle('provider/testModelConnectivity', () => {
      throw new Error('[1113][Insufficient balance or no resource package. Please recharge.]');
    });
    const adapter = new ZCodeAdapter({
      executablePath: '/bin/zcode',
      doctor: async () => ({ cliName: 'zcode', version: '0.17.1' }),
      spawn: () => proc,
      env: {},
    });
    const res = await adapter.inspectRuntime('/tmp/w');
    expect(res.authenticated).toBe(false);
    expect(res.models).toEqual([
      { value: 'agentura-zai-key/glm-5.3', displayName: 'glm-5.3 (Z.ai Coding Plan key)', supportsEffort: false },
    ]);
    expect(res.reason).toContain('1113');
    expect(proc.received.find((r) => r.method === 'session/create')?.params).toMatchObject({
      workspace: { workspacePath: '/tmp/w', workspaceKey: '/tmp/w' },
    });
  });

  it('streams turn.completed and exposes project_token_login_failed cleanly when turn fails', async () => {
    const proc = new FakeZCodeProc();
    proc.handle('session/create', () => ({
      session: { sessionId: 'z-1', mode: 'guarded' },
      settings: { model: { available: [{ providerId: 'zai', modelId: 'glm-5.3', name: 'GLM 5.3' }] } },
    }));
    proc.handle('session/subscribe', () => ({ eventSeq: 0, events: [], sessionId: 'z-1' }));
    proc.handle('session/send', async () => {
      queueMicrotask(() => {
        proc.notify('session/event', {
          sessionId: 'z-1',
          type: 'model.streaming',
          payload: { kind: 'text', delta: 'ZCODE_OK' },
        });
        proc.notify('session/event', {
          sessionId: 'z-1',
          type: 'turn.completed',
          payload: { resultType: 'success', response: 'ZCODE_OK', duration: 15 },
        });
      });
      return { accepted: true, sessionId: 'z-1', stateRevision: 1 };
    });

    const warnings: string[] = [];
    const adapter = new ZCodeAdapter({
      executablePath: '/bin/zcode',
      spawn: () => proc,
      log: (lvl, msg) => {
        if (lvl === 'warn') warnings.push(msg);
      },
    });
    const session = await adapter.createSession({
      cwd: '/tmp/w',
      model: 'zai/glm-5.3',
      hostMcpServers: [{ name: 'agentura_agents', url: 'http://127.0.0.1:41000/mcp/tok', builtin: true }],
    });
    const events: AgentEvent[] = [];
    session.events.on((e) => events.push(e));
    session.send('hello');

    await expect.poll(() => events.some((e) => e.type === 'turn.result')).toBe(true);
    expect(warnings[0]).toContain('does not support per-session HTTP mcpServers');
    expect(events.find((e) => e.type === 'turn.result')).toMatchObject({ ok: true, text: 'ZCODE_OK' });
    session.dispose();
  });
});
