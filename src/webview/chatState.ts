/**
 * Состояние чата webview: чистый редьюсер событий агента в строки ленты. Без Preact и DOM —
 * проверяется юнит-тестами; стор на сигналах (`store.ts`) только хранит результат.
 */
import type { AgentEvent, EffortLevel, PermissionMode } from '../agent/types';
import { nextStatus, type ChatStatus } from '../agent/status';
import { splitPrompt } from '../shared/prompt';
import type { Seg } from './fixtures/chat';
import { formatCost, formatDuration, formatInt } from './toolView';
import { ui } from './strings';

export type FeedRow =
  | { id: number; kind: 'sys'; tone?: 'ok' | 'bad'; text: Seg[]; at?: string }
  | { id: number; kind: 'user'; text: string; at?: string; queued?: boolean; context?: string }
  | {
      id: number;
      kind: 'think';
      messageId: string;
      text: string;
      startedAt: number;
      endedAt?: number;
    }
  | {
      id: number;
      kind: 'tool';
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      startedAt: number;
      state: 'run' | 'ok' | 'err' | 'stopped';
      durationMs?: number;
      elapsedMs?: number;
      content?: string;
      result?: unknown;
    }
  | { id: number; kind: 'text'; messageId: string; text: string; streaming: boolean }
  | { id: number; kind: 'sum'; parts: string[]; cost?: string; time: string };

export interface ChatState {
  rows: FeedRow[];
  nextId: number;
  status: ChatStatus;
  sessionId: string;
  project: string;
  cwd: string;
  allowBypass: boolean;
  title?: string;
  model?: string;
  engineVersion?: string;
  mode: PermissionMode;
  effort?: EffortLevel;
  /** Из `session.init` и `supportedCommands()`. */
  skills: string[];
  slashCommands: string[];
  turnStartedAt?: number;
  compactingRow?: number;
  closed?: { reason: 'exit' | 'error' | 'disposed'; message?: string };
}

export function initialState(): ChatState {
  return {
    rows: [],
    nextId: 1,
    status: 'idle',
    sessionId: '',
    project: '',
    cwd: '',
    allowBypass: false,
    mode: 'default',
    skills: [],
    slashCommands: [],
  };
}

/** Новая сессия: лента и сессионные поля сбрасываются, сведения о воркспейсе остаются. */
export function resetSession(s: ChatState): ChatState {
  return { ...initialState(), project: s.project, cwd: s.cwd, allowBypass: s.allowBypass };
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function push(s: ChatState, row: DistributiveOmit<FeedRow, 'id'>): ChatState {
  return { ...s, rows: [...s.rows, { ...row, id: s.nextId } as FeedRow], nextId: s.nextId + 1 };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function replaceAt(s: ChatState, index: number, row: FeedRow): ChatState {
  const rows = s.rows.slice();
  rows[index] = row;
  return { ...s, rows };
}

function lastIndex(rows: FeedRow[], pred: (r: FeedRow) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i]!)) return i;
  return -1;
}

/** Локальная системная строка (результат `/status`, `/plan`). */
export function addSys(s: ChatState, text: Seg[], tone?: 'ok' | 'bad'): ChatState {
  return push(s, { kind: 'sys', text, ...(tone ? { tone } : {}) });
}

/** Сообщение пользователя отправлено, `turn.start` ещё не пришёл — «в очереди». */
export function queueUser(s: ChatState, text: string): ChatState {
  return push(s, { kind: 'user', text, queued: true });
}

function closeOpenRows(s: ChatState, interrupted: boolean, at: number): ChatState {
  const rows = s.rows.map((r): FeedRow => {
    if (r.kind === 'text' && r.streaming) return { ...r, streaming: false };
    if (r.kind === 'think' && r.endedAt === undefined) return { ...r, endedAt: at };
    if (r.kind === 'tool' && r.state === 'run')
      return { ...r, state: interrupted ? 'stopped' : 'err' };
    return r;
  });
  return { ...s, rows };
}

export function applyEvent(s: ChatState, event: AgentEvent, now = Date.now()): ChatState {
  const status = nextStatus(s.status, event);
  const next = reduce({ ...s, status }, event, now);
  return next;
}

function reduce(s: ChatState, e: AgentEvent, now: number): ChatState {
  // Субагенты: в ленте основного агента их строк нет (панель «агенты» — этап 4).
  if (
    e.agentId &&
    e.type !== 'agent.start' &&
    e.type !== 'agent.progress' &&
    e.type !== 'agent.end'
  ) {
    return s;
  }
  switch (e.type) {
    case 'session.init': {
      const out: ChatState = {
        ...s,
        sessionId: e.sessionId,
        model: e.model,
        engineVersion: e.engineVersion,
        mode: e.permissionMode,
        skills: e.skills,
        slashCommands: e.slashCommands,
      };
      return out;
    }
    case 'session.title':
      return { ...s, title: e.title };
    case 'mode.changed':
      return { ...s, mode: e.mode };
    case 'turn.start': {
      let out: ChatState = { ...s, turnStartedAt: e.at };
      if (e.prompt !== undefined) {
        const { text, context } = splitPrompt(e.prompt);
        const at = clock(e.at);
        const idx = s.rows.findIndex(
          (r) => r.kind === 'user' && r.queued && r.text.trim() === text.trim(),
        );
        if (idx >= 0) {
          const row = s.rows[idx] as Extract<FeedRow, { kind: 'user' }>;
          const updated: Extract<FeedRow, { kind: 'user' }> = { ...row, queued: false, at };
          if (context) updated.context = context;
          out = replaceAt(out, idx, updated);
        } else {
          out = push(out, { kind: 'user', text, at, ...(context ? { context } : {}) });
        }
      }
      return out;
    }
    case 'thinking.start':
      return push(s, { kind: 'think', messageId: e.messageId, text: '', startedAt: e.at });
    case 'thinking.delta': {
      const i = lastIndex(s.rows, (r) => r.kind === 'think' && r.messageId === e.messageId);
      if (i < 0) {
        return push(s, { kind: 'think', messageId: e.messageId, text: e.text, startedAt: now });
      }
      const row = s.rows[i] as Extract<FeedRow, { kind: 'think' }>;
      return replaceAt(s, i, { ...row, text: row.text + e.text });
    }
    case 'thinking.stop': {
      const i = lastIndex(s.rows, (r) => r.kind === 'think' && r.messageId === e.messageId);
      if (i < 0) return s;
      const row = s.rows[i] as Extract<FeedRow, { kind: 'think' }>;
      return replaceAt(s, i, { ...row, endedAt: e.at });
    }
    case 'text.delta': {
      const last = s.rows[s.rows.length - 1];
      if (last && last.kind === 'text' && last.messageId === e.messageId && last.streaming) {
        return replaceAt(s, s.rows.length - 1, { ...last, text: last.text + e.text });
      }
      return push(s, { kind: 'text', messageId: e.messageId, text: e.text, streaming: true });
    }
    case 'tool.start': {
      const closed = s.rows.map((r): FeedRow =>
        r.kind === 'text' && r.streaming ? { ...r, streaming: false } : r,
      );
      return push(
        { ...s, rows: closed },
        {
          kind: 'tool',
          toolUseId: e.toolUseId,
          name: e.name,
          input: e.input,
          startedAt: e.at ?? now,
          state: 'run',
        },
      );
    }
    case 'tool.progress': {
      const i = lastIndex(s.rows, (r) => r.kind === 'tool' && r.toolUseId === e.toolUseId);
      if (i < 0) return s;
      const row = s.rows[i] as Extract<FeedRow, { kind: 'tool' }>;
      return replaceAt(s, i, { ...row, elapsedMs: e.elapsedMs });
    }
    case 'tool.result': {
      const i = lastIndex(s.rows, (r) => r.kind === 'tool' && r.toolUseId === e.toolUseId);
      if (i < 0) return s;
      const row = s.rows[i] as Extract<FeedRow, { kind: 'tool' }>;
      const done: Extract<FeedRow, { kind: 'tool' }> = {
        ...row,
        state: e.isError ? 'err' : 'ok',
        content: e.content,
        result: e.result,
      };
      if (e.durationMs !== undefined) done.durationMs = e.durationMs;
      else if (e.at !== undefined) done.durationMs = Math.max(0, e.at - row.startedAt);
      return replaceAt(s, i, done);
    }
    case 'permission.request':
      return push(s, {
        kind: 'sys',
        tone: 'bad',
        text: [ui.stubs.permission(e.toolName)],
      });
    case 'question.request':
      return push(s, { kind: 'sys', tone: 'bad', text: [ui.stubs.question] });
    case 'plan.request':
      return push(s, { kind: 'sys', tone: 'bad', text: [ui.stubs.plan] });
    case 'compaction.start': {
      const out = push(s, { kind: 'sys', text: [ui.sys.compacting] });
      return { ...out, compactingRow: out.rows[out.rows.length - 1]!.id };
    }
    case 'compaction.end': {
      const row: DistributiveOmit<FeedRow, 'id'> = e.ok
        ? { kind: 'sys', text: compactionText(e, now) }
        : { kind: 'sys', tone: 'bad', text: [ui.sys.compactFailed(e.error)] };
      const i = s.rows.findIndex((r) => r.id === s.compactingRow);
      const { compactingRow: _drop, ...rest } = s;
      void _drop;
      if (i >= 0) return replaceAt(rest, i, { ...row, id: s.rows[i]!.id } as FeedRow);
      return push(rest, row);
    }
    case 'turn.result': {
      let out = closeOpenRows(s, e.interrupted, now);
      const { turnStartedAt: _t, ...rest } = out;
      void _t;
      out = rest;
      const u = e.usage;
      const parts = [
        `in ${formatInt(u.input)}`,
        `out ${formatInt(u.output)}`,
        `cache r${formatInt(u.cacheRead)} w${formatInt(u.cacheWrite)}`,
      ];
      const sum: DistributiveOmit<FeedRow, 'id'> = {
        kind: 'sum',
        parts,
        time: formatDuration(e.durationMs),
        ...(e.costUsd !== undefined ? { cost: formatCost(e.costUsd) } : {}),
      };
      out = push(out, sum);
      if (e.interrupted) out = push(out, { kind: 'sys', text: [ui.sys.interrupted] });
      else if (!e.ok && e.errors?.length) {
        out = push(out, { kind: 'sys', tone: 'bad', text: [e.errors.join('; ')] });
      }
      return out;
    }
    case 'error':
      return push(s, {
        kind: 'sys',
        tone: 'bad',
        text: [e.code === 'limit' ? ui.sys.limit(e.message) : e.message],
      });
    case 'session.closed': {
      const out = closeOpenRows(s, true, now);
      return push(
        { ...out, closed: { reason: e.reason, ...(e.message ? { message: e.message } : {}) } },
        {
          kind: 'sys',
          tone: e.reason === 'error' ? 'bad' : undefined,
          text: [ui.sys.closed(e.reason, e.message)],
        },
      );
    }
    default:
      return s;
  }
}

function compactionText(e: Extract<AgentEvent, { type: 'compaction.end' }>, now: number): Seg[] {
  const how = e.trigger === 'auto' ? ui.sys.compactedAuto : ui.sys.compactedManual;
  if (e.preTokens === undefined) return [`${clock(now)} · ${how}`];
  const range =
    e.postTokens !== undefined
      ? `${formatInt(e.preTokens)} → ${formatInt(e.postTokens)}`
      : formatInt(e.preTokens);
  return [`${clock(now)} · ${how}: `, { b: range }, ' токенов'];
}
