import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from '../types';
import { KimiAdapter } from './adapter';
import { createFakeKimiServer } from './fakeServer';

interface Frame {
  dir: string;
  scenario: string;
  msg: { method?: string; params?: { update?: unknown } };
}

function updates(file: string, scenario: string): unknown[] {
  return readFileSync(join(__dirname, '../../../test/fixtures/kimi', file), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Frame)
    .filter((frame) => frame.dir === 'out' && frame.scenario === scenario && frame.msg.method === 'session/update')
    .map((frame) => frame.msg.params?.update);
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((event) => events.push(event));
  return events;
}

async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout: ${what}`);
}

describe('Kimi local slash commands', () => {
  it('maps only the compact start ack, suppresses service text and never invents quota/MCP/task success', async () => {
    const server = createFakeKimiServer();
    server.handle('session/prompt', (params) => {
      const blocks = params.prompt as { type: string; text?: string }[];
      const text = blocks.find((block) => block.type === 'text')?.text ?? '';
      const scenario = text.slice(1);
      const file = 'acp-attachments.ndjson';
      for (const update of updates(file, scenario)) server.update(String(params.sessionId), update);
      return { stopReason: 'end_turn' };
    });
    const session = await new KimiAdapter({ executablePath: '/bin/kimi', spawn: () => server, graceMs: 20 })
      .createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();

    expect(session.send('/compact')).toBe(true);
    await until(() => events.some((event) => event.type === 'compaction.end'), 'compact ack');
    expect(events.filter((event) => event.type === 'compaction.start')).toHaveLength(1);
    expect(events.find((event) => event.type === 'compaction.end')).toMatchObject({
      ok: false, trigger: 'manual', error: expect.stringContaining('completion is not reported'),
    });
    expect(events.some((event) => event.type === 'context.usage' && event.usedTokens === 23894)).toBe(true);

    for (const command of ['/usage', '/mcp', '/tasks']) {
      session.send(command);
      await until(() => events.filter((event) => event.type === 'turn.start').length ===
        (command === '/usage' ? 1 : command === '/mcp' ? 2 : 3), command);
    }
    await until(() => events.filter((event) => event.type === 'turn.result').length === 3, 'service results');
    expect(events.filter((event) => event.type === 'text.delta')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn.result').every((event) => !event.text)).toBe(true);
    expect(events.some((event) => ['limit.update', 'mcp.status', 'agent.end'].includes(event.type))).toBe(false);
    session.dispose();
  });

  it('reports an unknown command as an error, not a successful Agentura action or model answer', async () => {
    const server = createFakeKimiServer();
    server.handle('session/prompt', (params) => {
      for (const update of updates('acp-agentswarm-rejected.ndjson', 'swarm-enable')) {
        server.update(String(params.sessionId), update);
      }
      return { stopReason: 'end_turn' };
    });
    const session = await new KimiAdapter({ executablePath: '/bin/kimi', spawn: () => server, graceMs: 20 })
      .createSession({ cwd: '/work' });
    const events = collect(session);
    await session.capabilities();
    session.send('/swarm');
    await until(() => events.some((event) => event.type === 'turn.result'), 'unknown result');
    expect(events.find((event) => event.type === 'turn.result')).toMatchObject({
      ok: false, subtype: 'error', errors: ['Unknown ACP command: /swarm. Use /help to see available commands.'],
    });
    expect(events.some((event) => event.type === 'text.delta')).toBe(false);
    expect(events.some((event) => event.type === 'agent.start')).toBe(false);
    session.dispose();
  });
});
