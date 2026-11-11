// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SidebarTaskPicker } from './components/SidebarTaskPicker';
import type { ToWebview, FromWebview } from '../protocol';
import type { TaskPickerResult } from '../shared/taskPicker';
import * as vscode from './vscode';
let host: HTMLElement;
let sent: FromWebview[];
const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const post = (data: ToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
const found: TaskPickerResult = {
  kind: 'found',
  key: 'P7-1',
  title: 'Issue one',
  taskKey: 'jira:j:P7-1',
  instance: { id: 'j', name: 'Jira', baseUrl: 'https://jira.example' },
  existing: true,
  chats: [{ id: 'c1', provider: 'codex', title: 'Review', updatedAt: 1, archived: true }],
};
beforeEach(async () => {
  sent = [];
  vi.spyOn(vscode, 'send').mockImplementation((m) => void sent.push(m));
  host = document.createElement('div');
  document.body.append(host);
  render(h(SidebarTaskPicker, { detailed: false }), host);
  await flush();
});
afterEach(() => {
  render(null, host);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
async function open() {
  get('button.add').click();
  await flush();
  document.querySelectorAll<HTMLButtonElement>('.sp-menu button')[1]!.click();
  await flush();
}
async function find(query = 'P7-1') {
  const input = get<HTMLInputElement>('#sp-query');
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  get('.sp-link button').click();
  await flush();
  const m = [...sent].reverse().find((m) => m.type === 'task.picker.find');
  if (m?.type !== 'task.picker.find') throw Error('no request');
  return m.requestId;
}
it('plus offers plain chat and Jira; plain chat retains the original message', async () => {
  get('button.add').click();
  await flush();
  expect(document.querySelectorAll('.sp-menu button')).toHaveLength(2);
  get('.sp-menu button').click();
  expect(sent.at(-1)).toEqual({ type: 'session.new' });
});
it('existing task lists archived chats; open does not ask to create', async () => {
  await open();
  const id = await find();
  post({ type: 'task.picker.result', requestId: id, result: found });
  await flush();
  expect(get('.sp-chats').textContent).toContain('в архиве');
  expect(document.querySelector('.sp-create')).toBeNull();
  get('.ft .go').click();
  expect(sent.at(-1)).toEqual({ type: 'task.picker.act', requestId: id, mode: 'open' });
  post({ type: 'task.picker.done', requestId: id });
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('selecting a listed chat sends its id and provider', async () => {
  await open();
  const id = await find();
  post({ type: 'task.picker.result', requestId: id, result: found });
  await flush();
  get('.sp-chats button').click();
  expect(sent.at(-1)).toMatchObject({
    type: 'task.picker.act',
    mode: 'open',
    sessionId: 'c1',
    provider: 'codex',
  });
});
it('new chat in existing task is explicit and preserves user input', async () => {
  await open();
  const id = await find();
  post({ type: 'task.picker.result', requestId: id, result: found });
  await flush();
  get('.sp-new').click();
  await flush();
  document.querySelectorAll<HTMLButtonElement>('.engines button')[1]!.click();
  const ta = get<HTMLTextAreaElement>('#sp-prompt');
  ta.value = 'Review this';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  get('.ft .go').click();
  await flush();
  get('.ft .go').click();
  expect(sent.filter((m) => m.type === 'task.picker.act')).toEqual([
    {
      type: 'task.picker.act',
      requestId: id,
      mode: 'create',
      provider: 'codex',
      prompt: 'Review this',
    },
  ]);
  post({ type: 'task.picker.done', requestId: id, error: 'failed' });
  await flush();
  expect(get<HTMLTextAreaElement>('#sp-prompt').value).toBe('Review this');
});
it('new task shows settings immediately; stale replies and edited query cannot enable actions', async () => {
  await open();
  const first = await find();
  const second = await find('P7-2');
  post({ type: 'task.picker.result', requestId: first, result: found });
  await flush();
  expect(document.querySelector('.sp-card')).toBeNull();
  post({
    type: 'task.picker.result',
    requestId: second,
    result: { ...found, existing: false, chats: [] },
  });
  await flush();
  expect(document.querySelector('.sp-create')).not.toBeNull();
  const input = get<HTMLInputElement>('#sp-query');
  input.value = 'P7-3';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(get<HTMLButtonElement>('.ft .go').disabled).toBe(true);
  expect(document.querySelector('.sp-card')).toBeNull();
});
it('instance selection repeats lookup with explicit instance; error offers connection and Escape closes', async () => {
  await open();
  const id = await find();
  post({
    type: 'task.picker.result',
    requestId: id,
    result: {
      kind: 'instances',
      instances: [{ id: 'j', name: 'Jira', baseUrl: 'https://jira.example' }],
    },
  });
  await flush();
  get('.sp-instances button').click();
  await flush();
  expect(sent.at(-1)).toMatchObject({ type: 'task.picker.find', instanceId: 'j' });
  const request = sent.at(-1);
  if (request?.type !== 'task.picker.find') throw Error();
  post({
    type: 'task.picker.result',
    requestId: request.requestId,
    result: { kind: 'error', code: 'no-source' },
  });
  await flush();
  get('.sp-notice button').click();
  expect(sent.at(-1)).toEqual({ type: 'task.connect' });
  get('#sp-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(get('button.add'));
});
