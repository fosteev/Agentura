// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { providerFeatures } from '../agent/features';
import type { McpServerInfo } from '../agent/types';
import { initialState } from './chatState';
import { McpSections } from './components/McpRows';
import { chat, features } from './store';
import * as vscode from './vscode';

const flush = () => new Promise((r) => setTimeout(r, 30));
let host: HTMLDivElement;
const servers: McpServerInfo[] = [
  { name: 'serena', status: 'connected', tools: 21 },
  { name: 'webstorm', status: 'failed', error: 'ECONNREFUSED' },
  { name: 'sentry', status: 'needs-auth' },
  { name: 'old', status: 'disabled' },
  { name: 'waiting', status: 'pending' },
  { name: 'jira', status: 'connected', builtin: true },
  { name: 'plugin', status: 'connected', scope: 'plugin' },
];
const click = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!.click();
const row = (name: string) => host.querySelector<HTMLElement>(`[data-name="${name}"]`)!;
beforeEach(async () => {
  vi.spyOn(vscode, 'send').mockImplementation(() => undefined);
  chat.value = { ...initialState(), engine: 'codex', project: 'demo', mcp: { servers, at: 0 } };
  features.value = providerFeatures('codex');
  host = document.createElement('div');
  document.body.append(host);
  render(h(McpSections, { variant: 'pane' }), host);
  await flush();
});
afterEach(() => { render(null, host); host.remove(); vi.restoreAllMocks(); });

it('groups failures first, keeps pending/disabled visible, filters by name and live status', async () => {
  expect([...host.querySelectorAll('.mcp-server')].map((r) => r.getAttribute('data-name')))
    .toEqual(['webstorm', 'sentry', 'serena', 'jira', 'plugin', 'waiting', 'old']);
  // Unknown tool counts must not be presented as a complete total.
  expect(host.querySelector('.mcp-head p')!.textContent).toBe('3 из 7 подключены');
  click('.mcp-filters button:last-child');
  await flush();
  expect(host.querySelectorAll('.mcp-server')).toHaveLength(2);
  chat.value = { ...chat.value, mcp: { at: 1, servers: servers.map((s) => ({ ...s, status: 'connected' })) } };
  await flush();
  expect(host.querySelector('.mcp-empty')!.textContent).toBe('Все подключения в порядке');
  click('.mcp-filters button:first-child');
  const search = host.querySelector<HTMLInputElement>('input')!;
  search.value = ' SERENA ';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(host.querySelectorAll('.mcp-server')).toHaveLength(1);
  expect(row('serena')).not.toBeNull();
  search.value = 'not-found';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(host.querySelector('.mcp-empty')!.textContent).toBe('Серверы не найдены');
});

it('preserves Codex toggle restrictions, sends host actions, waits for host status', async () => {
  expect(row('jira').querySelector('[role="switch"]')).toBeNull();
  expect(row('plugin').querySelector('[role="switch"]')).toBeNull();
  click('[data-name="serena"] [role="switch"]');
  expect(vscode.send).toHaveBeenCalledWith({ type: 'mcp.toggle', name: 'serena', enabled: false });
  expect(row('serena').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
  click('[data-name="old"] [role="switch"]');
  expect(vscode.send).toHaveBeenCalledWith({ type: 'mcp.toggle', name: 'old', enabled: true });
  click('.mcp-title button');
  expect(vscode.send).toHaveBeenCalledWith({ type: 'mcp.refresh' });
  click('.mcp-head > button');
  expect(vscode.send).toHaveBeenCalledWith({ type: 'mcp.reloadAll' });
});

it('expands errors and auth without calls, respects provider reconnect capability', async () => {
  click('[data-name="webstorm"] .mcp-server-open');
  click('[data-name="sentry"] .mcp-server-open');
  await flush();
  expect(row('webstorm').textContent).toContain('ECONNREFUSED');
  expect(row('webstorm').querySelector('.mcp-action')).toBeNull();
  expect(row('sentry').textContent).toContain('codex mcp login sentry');
  features.value = providerFeatures('claude');
  chat.value = { ...chat.value, engine: 'claude' };
  await flush();
  click('[data-name="webstorm"] .mcp-action');
  expect(vscode.send).toHaveBeenCalledWith({ type: 'mcp.reconnect', name: 'webstorm' });
  expect(row('plugin').querySelector('[role="switch"]')).not.toBeNull();
});
