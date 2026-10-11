import { describe, expect, it } from 'vitest';
import type { McpServerInfo } from '../agent/types';
import type { FeedRow } from './chatState';
import { loginCommand, mcpCounts, mcpSurfaceShown, usageByServer } from './mcpView';

const srv = (name: string, status: McpServerInfo['status']): McpServerInfo => ({ name, status });
const tool = (id: number, name: string): FeedRow =>
  ({ kind: 'tool', id, toolUseId: `t${id}`, name, input: {}, status: 'ok', at: 0 }) as unknown as FeedRow;

describe('mcpView', () => {
  it('mcpCounts: N подключено, M без выключенных, bad — failed и needs-auth', () => {
    expect(
      mcpCounts([
        srv('a', 'connected'),
        srv('b', 'pending'),
        srv('c', 'failed'),
        srv('d', 'needs-auth'),
        srv('e', 'disabled'),
      ]),
    ).toEqual({ n: 1, m: 4, bad: 2 });
  });

  it('usageByServer: ключ — имя сервера из статуса; claude.ai и сырое имя Codex сопоставляются, чужой сервер пропускается', () => {
    const servers = [srv('claude.ai Gmail', 'connected'), srv('my server', 'connected')];
    const rows = [
      tool(1, 'mcp__claude_ai_Gmail__search_threads'),
      tool(2, 'mcp__claude_ai_Gmail__search_threads'),
      tool(3, 'mcp__my server__run'), // Codex кладёт сырое имя
      tool(4, 'mcp__ghost__x'),
    ];
    const u = usageByServer(servers, rows);
    expect([...u.keys()]).toEqual(['claude.ai Gmail', 'my server']);
    expect(u.get('claude.ai Gmail')!.total).toBe(2);
    expect([...u.get('my server')!.tools]).toEqual([['run', 1]]);
  });

  it('loginCommand и mcpSurfaceShown', () => {
    expect(loginCommand('codex', 'sentry')).toBe('codex mcp login sentry');
    expect(loginCommand('claude', 'sentry')).toBe('/mcp');
    expect(mcpSurfaceShown(true, true, [srv('a', 'connected')])).toBe(true);
    expect(mcpSurfaceShown(true, true, [])).toBe(false);
    expect(mcpSurfaceShown(true, true, undefined)).toBe(false);
    expect(mcpSurfaceShown(false, true, [srv('a', 'connected')])).toBe(false);
    expect(mcpSurfaceShown(true, false, [srv('a', 'connected')])).toBe(false);
  });
});
