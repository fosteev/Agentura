import * as path from 'node:path';
import type { AgentProvider } from '../../agent/types';
import { isProvider } from '../../settings';
import { splitPrompt } from '../../shared/prompt';
import {
  isNewChatCarry,
  NEW_CHAT_PROMPT_LIMIT,
  type CodeRepo,
  type NewChatCarry,
  type NewChatWhere,
} from '../../shared/task';

/**
 * Новый чат внутри задачи (roadmap 26): чистые функции передачи — вход итога чата-источника из событий его истории,
 * текст «изменений задачи» из итога вкладки «код», имена файлов-вложений, выбор номера своей git worktree.
 * Без `vscode`, git и движка: данные собирает `agentura.chatForTask`.
 */

/**
 * Опции `agentura.chatForTask` (второй аргумент): поля `task.newChat` без `type`/`taskKey` + чат-источник `from`
 * (заполняет хост вкладки: движок, id сессии — если есть, рабочая папка).
 */
export interface NewChatOptions {
  provider?: AgentProvider;
  prompt?: string;
  carry?: NewChatCarry;
  where?: NewChatWhere;
  beside?: boolean;
  from?: { provider: AgentProvider; id?: string; cwd: string };
}

/** Проверить недоверенный второй аргумент команды: кривые поля отбрасываются по одному. */
export function newChatOptions(v: unknown): NewChatOptions {
  if (!v || typeof v !== 'object') return {};
  const { provider, prompt, carry, where, beside, from } = v as Record<string, unknown>;
  const src = from && typeof from === 'object' ? (from as Record<string, unknown>) : undefined;
  const okFrom =
    src &&
    isProvider(src.provider) &&
    typeof src.cwd === 'string' &&
    path.isAbsolute(src.cwd) &&
    src.cwd.length <= 1_024 &&
    !src.cwd.includes('\0');
  const id = src && typeof src.id === 'string' && src.id && src.id.length <= 200 ? src.id : undefined;
  const text = typeof prompt === 'string' ? prompt.trim().slice(0, NEW_CHAT_PROMPT_LIMIT) : '';
  return {
    ...(isProvider(provider) ? { provider } : {}),
    ...(text ? { prompt: text } : {}),
    ...(isNewChatCarry(carry) ? { carry } : {}),
    ...(where === 'same' || where === 'worktree' ? { where } : {}),
    ...(beside === true ? { beside: true } : {}),
    ...(okFrom ? { from: { provider: src.provider as AgentProvider, ...(id ? { id } : {}), cwd: src.cwd as string } } : {}),
  };
}

/**
 * Опции публичной команды `agentura.chatForTask` (её зовёт любое расширение и `command:`-ссылка, Д4 доводки 1): только
 * движок, первое сообщение и «контекст задачи». Чат-источник (`from`), своя worktree, «рядом», итог и изменения —
 * только внутренний вызов из вкладки чата: иначе снаружи можно было бы сделать `git worktree add` в любом репозитории
 * или пересказать чужой чат.
 */
export function publicNewChatOptions(v: unknown): NewChatOptions {
  const { provider, prompt, carry } = newChatOptions(v);
  return {
    ...(provider ? { provider } : {}),
    ...(prompt ? { prompt } : {}),
    ...(carry && carry.task !== undefined ? { carry: { task: carry.task } } : {}),
  };
}

/** Последних символов истории чата, которые уходят модели на итог. */
export const HANDOFF_INPUT_CHARS = 60_000;
/** Модель итога (только Claude умеет `complete`). */
export const HANDOFF_MODEL = 'sonnet';
/** Нет ответа модели за это время — чат открывается без итога. */
export const HANDOFF_TIMEOUT_MS = 90_000;
/** Коммитов на репозиторий в «изменениях задачи». */
export const CHANGES_COMMITS = 20;
/** Длина пути/команды инструмента во входе итога. */
const TOOL_DETAIL_CHARS = 200;

export const HANDOFF_SYSTEM = [
  'You prepare a handoff note: the work in this chat is being passed to another AI coding agent that has not seen it.',
  'Cover: the goal; what has been done (commits, files changed); what is not finished; decisions taken and why;',
  'concrete next steps. At most 250 words. Write in the same language the user writes in the chat.',
  'No preamble, no closing remarks, no quoting of the transcript; output the note only.',
].join(' ');

/** Только то, что вход итога читает из событий истории (`AgentEvent` подходит как есть). */
export interface HandoffEvent {
  type: string;
  agentId?: unknown;
  prompt?: unknown;
  prompts?: unknown;
  messageId?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

/** Путь, команда или шаблон инструмента — без вывода; нет — пусто. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const k of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'description']) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) {
      const one = v.replace(/\s+/g, ' ').trim();
      return one.length > TOOL_DETAIL_CHARS ? `${one.slice(0, TOOL_DETAIL_CHARS)}…` : one;
    }
  }
  return '';
}

/**
 * Вход итога: реплики пользователя (без блока контекста Agentura), текст ответов основного агента, имена инструментов
 * с путём/командой (без вывода). Субагенты не входят. Длиннее `max` — последние `max` символов с пометкой в начале.
 */
export function handoffInput(events: readonly HandoffEvent[], max = HANDOFF_INPUT_CHARS): string {
  const lines: string[] = [];
  let reply: { id: unknown; text: string } | undefined;
  const flush = (): void => {
    if (reply?.text.trim()) lines.push(`Assistant: ${reply.text.trim()}`);
    reply = undefined;
  };
  for (const e of events) {
    if (e.agentId !== undefined) continue;
    if (e.type === 'text.delta' && typeof e.text === 'string') {
      if (reply && reply.id !== e.messageId) flush();
      reply ??= { id: e.messageId, text: '' };
      reply.text += e.text;
      continue;
    }
    if (e.type === 'turn.start') {
      flush();
      // движок склеил несколько сообщений в один ход: у каждого свой блок контекста — разбираем по одному
      const parts =
        Array.isArray(e.prompts) && e.prompts.length
          ? e.prompts.filter((x): x is string => typeof x === 'string')
          : typeof e.prompt === 'string'
            ? [e.prompt]
            : [];
      for (const p of parts) {
        const text = splitPrompt(p).text.trim();
        if (text) lines.push(`User: ${text}`);
      }
      continue;
    }
    if (e.type === 'tool.start' && typeof e.name === 'string' && e.name) {
      flush();
      const detail = toolDetail(e.input);
      lines.push(`Tool: ${e.name}${detail ? ` ${detail}` : ''}`);
    }
  }
  flush();
  const all = lines.join('\n\n');
  if (all.length <= max) return all;
  const tail = all.slice(all.length - max);
  // с начала записи, если она есть недалеко: обрывок реплики модели не нужен
  const gap = tail.indexOf('\n\n');
  return `[…earlier part of the chat omitted]\n${gap >= 0 && gap < 2_000 ? tail.slice(gap + 2) : tail}`;
}

/** Промпт одноразового запроса итога. */
export function handoffPrompt(title: string, provider: string, transcript: string): string {
  return `Chat «${title}» (${provider}). Transcript, oldest first:\n\n${transcript}`;
}

/** Файл итога: шапка и ответ модели. */
export function handoffFile(title: string, provider: string, summary: string): string {
  return `# Handoff from chat «${title}» (${provider})\n\n${summary.trim()}\n`;
}

/** Имена вложений нового чата задачи: контекст задачи, итог чата-источника, изменения задачи. */
export function handoffNames(key: string): { task: string; summary: string; changes: string } {
  return { task: `${key}.md`, summary: `${key}-handoff.md`, changes: `${key}-changes.md` };
}

function day(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?';
}

function plusMinus(add: number | undefined, del: number | undefined, binary?: boolean): string {
  if (binary) return 'binary';
  return `+${add ?? 0} −${del ?? 0}`;
}

/**
 * «Изменения задачи» из итога вкладки «код»: на репозиторий — ветки задачи (→ база, коммитов сверх неё, ±), до
 * `CHANGES_COMMITS` коммитов, незакоммиченные файлы агентов с ±. Пусто — одна строка.
 */
export function changesText(key: string, repos: readonly CodeRepo[]): string {
  const blocks: string[] = [];
  for (const r of repos) {
    const out: string[] = [];
    if (r.error) out.push(`- error: ${r.error}`);
    for (const b of r.branches) {
      out.push(`- branch ${b.name} → ${r.base ?? '?'}: ahead ${b.ahead}, ${plusMinus(b.add, b.del)}`);
    }
    if (r.commits.length) {
      out.push('', 'Commits:');
      for (const c of r.commits.slice(0, CHANGES_COMMITS)) {
        out.push(`- ${c.short} ${c.subject} (${c.author}, ${day(c.at)})`);
      }
      if (r.commits.length > CHANGES_COMMITS) out.push(`- … ${r.commits.length - CHANGES_COMMITS} more`);
    }
    if (r.dirty.length) {
      out.push('', 'Uncommitted agent edits:');
      for (const f of r.dirty) out.push(`- ${f.status} ${f.path} ${plusMinus(f.add, f.del, f.binary)}`);
    }
    if (out.length) blocks.push(`## ${r.name}\n\n${out.join('\n')}`);
  }
  if (!blocks.length) return `# Changes for ${key}\n\nNo commits or uncommitted agent edits found for ${key}.\n`;
  return `# Changes for ${key}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * Репозиторий своей worktree для рабочей папки `cwd`: корень, внутри которого она лежит; нет такого — единственный
 * вложенный; иначе (нет репозиториев или их несколько) — `undefined`. `roots` — как отдаёт `GitService.rootsFor`.
 */
export function worktreeRepo(cwd: string, roots: readonly string[]): string | undefined {
  const norm = (p: string): string => path.resolve(p);
  const c = norm(cwd);
  const outer = roots.find((r) => {
    const rel = path.relative(norm(r), c);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (outer) return outer;
  return roots.length === 1 ? roots[0] : undefined;
}

/**
 * Основной репозиторий для имени и места своей worktree (Д7 доводки 1): из worktree-чата новая worktree — соседка
 * основного (`app-K-1-3`), а не `app-K-1-2-K-1-2`. `commonDir` — вывод `git rev-parse --git-common-dir` в `repo`
 * (относительный — от `repo`); его папка `.git` → родитель, иначе (голый репозиторий) — она сама. Пусто — `repo`.
 */
export function mainRepoDir(repo: string, commonDir: string): string {
  const raw = commonDir.trim();
  if (!raw) return repo;
  const abs = path.resolve(repo, raw);
  return path.basename(abs) === '.git' ? path.dirname(abs) : abs;
}

/**
 * Рабочая папка нового чата в своей worktree `dir` (Д7): источник в подпапке репозитория `repo` — та же подпапка в
 * worktree; источник в корне или вне репозитория — корень worktree.
 */
export function worktreeCwd(repo: string, cwd: string, dir: string): string {
  const rel = path.relative(path.resolve(repo), path.resolve(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return dir;
  return path.join(dir, rel);
}

/** Ветка своей worktree. */
export function worktreeBranch(key: string, n: number): string {
  return `feature/${key}-${n}`;
}

/** Папка своей worktree (соседняя с репозиторием). */
export function worktreeDir(repoName: string, key: string, n: number): string {
  return `${repoName}-${key}-${n}`;
}

/**
 * Наименьший `n ≥ 2`, при котором нет ни папки `<repoName>-<KEY>-<n>` среди `dirs` (имена в родительской папке
 * репозитория), ни локальной ветки `feature/<KEY>-<n>` среди `branches`.
 */
export function worktreeN(
  repoName: string,
  key: string,
  dirs: readonly string[],
  branches: readonly string[],
): number {
  const d = new Set(dirs.map((x) => x.toLowerCase()));
  const b = new Set(branches);
  for (let n = 2; ; n++) {
    if (!d.has(worktreeDir(repoName, key, n).toLowerCase()) && !b.has(worktreeBranch(key, n))) return n;
  }
}
