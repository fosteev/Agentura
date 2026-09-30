/** Стор чата webview на сигналах: состояние ленты, контекст редактора, поле ввода. */
import { signal } from '@preact/signals';
import type {
  AgentEvent,
  CommandOption,
  EffortLevel,
  ModelOption,
  PermissionMode,
} from '../agent/types';
import { attachmentKey, type Attachment, type FileHit } from '../shared/prompt';
import type { EditorContext, SessionSummary, ToWebview } from '../protocol';
import { applyEvent, initialState, queueUser, resetSession, type ChatState } from './chatState';
import { pushHistory } from './composer';
import { send } from './vscode';

export const chat = signal<ChatState>(initialState());
export const capabilities = signal<{ models: ModelOption[]; commands: CommandOption[] }>({
  models: [],
  commands: [],
});
export const editor = signal<EditorContext>({});
export const recent = signal<SessionSummary[]>([]);
/** Ключи автоконтекста, снятые крестиком. */
export const dismissed = signal<ReadonlySet<string>>(new Set());
/** Чипы, добавленные через «@»/«+». */
export const extra = signal<Attachment[]>([]);
export const autoFile = signal(true);
export const autoSelection = signal(true);
export const showThinking = signal(true);
export const history = signal<string[]>([]);
export const fileHits = signal<{ requestId: number; items: FileHit[] }>({
  requestId: 0,
  items: [],
});
/** Тик раз в секунду, пока идёт ход: таймеры в ленте. */
export const tick = signal(Date.now());

export function handleHostMessage(m: ToWebview): void {
  switch (m.type) {
    case 'agent.event':
      dispatchEvent(m.event);
      break;
    case 'chat.info':
      chat.value = { ...chat.value, project: m.project, cwd: m.cwd, allowBypass: m.allowBypass };
      break;
    case 'capabilities':
      capabilities.value = { models: m.models, commands: m.commands };
      break;
    case 'editor.context':
      editor.value = {
        ...(m.file ? { file: m.file } : {}),
        ...(m.selection ? { selection: m.selection } : {}),
      };
      break;
    case 'files.result':
      fileHits.value = { requestId: m.requestId, items: m.items };
      break;
    case 'attach.picked':
      for (const hit of m.items) addExtra({ kind: hit.isDir ? 'folder' : 'file', path: hit.path });
      break;
    case 'sessions.update':
      recent.value = m.sessions;
      break;
    case 'session.reset':
      chat.value = resetSession(chat.value);
      extra.value = [];
      break;
    default:
      break;
  }
}

export function dispatchEvent(event: AgentEvent, now = Date.now()): void {
  chat.value = applyEvent(chat.value, event, now);
}

export function addExtra(a: Attachment): void {
  if (extra.value.some((x) => attachmentKey(x) === attachmentKey(a))) return;
  extra.value = [...extra.value, a];
}

export function removeExtra(key: string): void {
  extra.value = extra.value.filter((x) => attachmentKey(x) !== key);
}

export function dismiss(key: string): void {
  dismissed.value = new Set([...dismissed.value, key]);
}

/** Автоконтекст в виде вложений: открытый файл и выделение минус снятое и выключенное. */
export function autoAttachments(
  ctx: EditorContext,
  flags: { file: boolean; selection: boolean },
  skip: ReadonlySet<string>,
): Attachment[] {
  const out: Attachment[] = [];
  if (flags.file && ctx.file) out.push({ kind: 'file', path: ctx.file.path });
  if (flags.selection && ctx.selection) {
    out.push({
      kind: 'selection',
      path: ctx.selection.path,
      startLine: ctx.selection.startLine,
      endLine: ctx.selection.endLine,
    });
  }
  return out.filter((a) => !skip.has(attachmentKey(a)));
}

export function currentAttachments(): Attachment[] {
  const auto = autoAttachments(
    editor.value,
    { file: autoFile.value, selection: autoSelection.value },
    dismissed.value,
  );
  const autoKeys = new Set(auto.map(attachmentKey));
  return [...auto, ...extra.value.filter((x) => !autoKeys.has(attachmentKey(x)))];
}

export function sendMessage(text: string, withContext = true): boolean {
  const s = chat.value;
  if (s.closed) return false;
  const attachments = withContext ? currentAttachments() : [];
  chat.value = queueUser(s, text);
  history.value = pushHistory(history.value, text);
  extra.value = [];
  send({
    type: 'send',
    sessionId: s.sessionId,
    text,
    ...(attachments.length ? { attachments } : {}),
  });
  return true;
}

export function interrupt(): void {
  send({ type: 'interrupt', sessionId: chat.value.sessionId });
}

export function setMode(mode: PermissionMode): void {
  chat.value = { ...chat.value, mode };
  send({ type: 'mode.set', sessionId: chat.value.sessionId, mode });
}

export function setModel(model: string): void {
  chat.value = { ...chat.value, model };
  send({ type: 'model.set', sessionId: chat.value.sessionId, model });
}

export function setEffort(effort: EffortLevel): void {
  chat.value = { ...chat.value, effort };
  send({ type: 'effort.set', sessionId: chat.value.sessionId, effort });
}

export function newSession(): void {
  chat.value = resetSession(chat.value);
  extra.value = [];
  send({ type: 'session.new' });
}
