/**
 * Новый чат по задаче из вкладки чата (roadmap 26, решения 12–14): «＋ чат» в полосе, «＋» внутренних вкладок и
 * `/new`/`/fork` в поле ввода. Клик — всплывашка, ⌥/Alt+клик — сразу, без вопросов (движок вкладки, контекст задачи).
 */
import type { AgentProvider } from '../agent/types';
import { NEW_CHAT_PROMPT_LIMIT } from '../shared/task';
import { newChatPopover, provider, tabChats, taskState } from './store';
import { send } from './vscode';

/** Разбор `/new [движок] [текст]`: движок — первое слово, если оно называет движок. */
export function parseNewCommand(args: string, fallback: AgentProvider): { provider: AgentProvider; prompt: string } {
  const text = args.trim();
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const word = m?.[1]?.toLowerCase();
  const engine: AgentProvider | undefined =
    word === 'claude' ? 'claude' : word === 'codex' ? 'codex' : word === 'agy' || word === 'antigravity' ? 'antigravity' : undefined;
  if (!engine) return { provider: fallback, prompt: text };
  return { provider: engine, prompt: (m?.[2] ?? '').trim() };
}

/** Клик по «＋ чат» / «＋»: с ⌥ — новый чат сразу, иначе открыть (или закрыть) всплывашку под кнопкой. */
export function startNewChat(e: MouseEvent, taskKey: string): void {
  if (e.altKey) {
    newChatPopover.value = undefined;
    send({ type: 'task.newChat', taskKey, provider: provider.value, carry: { task: true } });
    return;
  }
  if (newChatPopover.value) {
    newChatPopover.value = undefined;
    return;
  }
  const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  newChatPopover.value = { left: Math.max(4, r?.left ?? 12), top: (r?.bottom ?? 30) + 4 };
}

/** Ключ группы задачи этой вкладки (`jira:<инстанс>:<KEY>`); нет — вкладка вне задачи. */
export function currentTaskKey(): string | undefined {
  return tabChats.value?.taskKey ?? taskState.value?.taskKey;
}

/**
 * `/new [движок] [текст]` и `/fork [текст]` (решение 14): `/fork` — то же движком вкладки, но с итогом этого чата.
 * Возвращает `false`, если вкладка не на задаче (команда уходит движку обычным текстом).
 */
export function runNewChatCommand(name: 'new' | 'fork', args: string): boolean {
  const taskKey = currentTaskKey();
  if (!taskKey) return false;
  const { provider: engine, prompt } = name === 'new' ? parseNewCommand(args, provider.value) : { provider: provider.value, prompt: args.trim() };
  send({
    type: 'task.newChat',
    taskKey,
    provider: engine,
    ...(prompt ? { prompt: prompt.slice(0, NEW_CHAT_PROMPT_LIMIT) } : {}),
    carry: name === 'new' ? { task: true } : { task: true, summary: true },
  });
  return true;
}
