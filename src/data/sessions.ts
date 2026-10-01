import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, SessionInfo, TokenUsage } from '../agent/types';
import type { SessionSummary } from '../protocol';
import { readJsonlLines } from './agentmeter/sources/jsonl.ts';
import { parseSessionFile, parseSubagents } from './agentmeter/sources/claude/parse.ts';
import type { Request } from './agentmeter/sources/types.ts';
import { cost, type CostExtras } from './pricing';

/**
 * Список сессий для боковой панели (A10): `listSessions()` движка + итоги по транскрипту
 * (ходы, токены, стоимость по `pricing`) + статус живых сессий из собственного реестра.
 * `listSessions()` не отдаёт ни токенов, ни стоимости (docs/spikes/sdk-probe.md, раздел 13).
 */

export type SessionState = SessionSummary['state'];

export interface TranscriptTotals {
  turns: number;
  tokens: TokenUsage;
  /**
   * Оценка по таблице цен. Модели без цены в сумму не входят и ставят `costPartial`; если цены нет
   * ни у одного запроса — `costUsd` нет вовсе (не $0).
   */
  costUsd?: number;
  costPartial?: boolean;
  /** Контекст последнего запроса основной ветки. */
  contextTokens?: number;
  model?: string;
}

export interface SessionRow extends SessionInfo {
  state: SessionState;
  turns: number;
  tokens: TokenUsage;
  costUsd?: number;
  /** Оценка по транскрипту без части запросов (модель без цены). */
  costPartial?: boolean;
  /** `engine` — `total_cost_usd` живой сессии; `pricing` — оценка по транскрипту. */
  costSource?: 'engine' | 'pricing';
  contextTokens?: number;
}

interface LiveEntry {
  state: SessionState;
  totalCostUsd?: number;
}

/** Реестр запущенных в этом окне сессий: статус для списка и последний `total_cost_usd` движка. */
export class LiveSessions {
  private readonly entries = new Map<string, LiveEntry>();
  private readonly listeners = new Set<() => void>();

  set(id: string, state: SessionState, totalCostUsd?: number): void {
    const prev = this.entries.get(id);
    this.entries.set(id, { state, totalCostUsd: totalCostUsd ?? prev?.totalCostUsd });
    // статус строки списка (идёт ход, ждёт ответа) сменился — список пересобрать
    if (prev?.state !== state || totalCostUsd !== undefined) this.notify();
  }

  delete(id: string): void {
    if (this.entries.delete(id)) this.notify();
  }

  /** Подписка на изменения реестра (список сессий в боковой панели). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  get(id: string): LiveEntry | undefined {
    return this.entries.get(id);
  }
}

/** Предел длины имени каталога проекта у CLI; длиннее — обрезка и хэш пути. */
const MAX_PROJECT_DIR = 200;

/**
 * Имя каталога проекта как у CLI 2.1.285 (`sdk.mjs`, функции `Da`/`Nc`/`Y_`): всё кроме
 * `[A-Za-z0-9]` → `-`; длиннее 200 символов — первые 200 + `-` + хэш исходного пути
 * (`h = h*31 + code | 0`, `Math.abs`, основание 36).
 */
export function projectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_PROJECT_DIR) return name;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, MAX_PROJECT_DIR)}-${Math.abs(h).toString(36)}`;
}

/** Каталог транскриптов проекта: `~/.claude/projects/<projectDirName(cwd)>`. */
export function projectDir(cwd: string, claudeHome = defaultClaudeHome()): string {
  return join(claudeHome, 'projects', projectDirName(cwd));
}

/**
 * Файл транскрипта сессии. Для обрезанных имён хэш у CLI может посчитаться по-другому
 * (другая нормализация пути) — тогда ищем каталог по 200-символьному префиксу.
 */
export function transcriptPath(
  cwd: string,
  sessionId: string,
  claudeHome = defaultClaudeHome(),
): string {
  const direct = join(projectDir(cwd, claudeHome), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // CLI называет каталог по реальному пути: папка воркспейса может быть симлинком (`/var` → `/private/var`)
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) {
      const viaReal = join(projectDir(real, claudeHome), `${sessionId}.jsonl`);
      if (existsSync(viaReal)) return viaReal;
    }
  } catch {
    // папки нет — остаётся прямой путь
  }
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_PROJECT_DIR) return direct;
  const projects = join(claudeHome, 'projects');
  const prefix = `${name.slice(0, MAX_PROJECT_DIR)}-`;
  try {
    for (const dir of readdirSync(projects)) {
      if (!dir.startsWith(prefix)) continue;
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Каталога нет — вернём прямой путь, кэш скажет «нет файла».
  }
  return direct;
}

export function defaultClaudeHome(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
}

/**
 * Надбавки к цене по записям транскрипта: `usage.inference_geo` и число веб-поисков на API-запрос.
 * Парсер Agentmeter этих полей не отдаёт; ключ — `requestId` записи (как у него), иначе `message.id`.
 */
export function requestExtras(path: string): Map<string, CostExtras> {
  const out = new Map<string, CostExtras>();
  for (const line of readJsonlLines(path, true).lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec['type'] !== 'assistant') continue;
    const msg = rec['message'] as { id?: string; usage?: Record<string, unknown> } | undefined;
    const usage = msg?.usage;
    if (!usage) continue;
    const key = (typeof rec['requestId'] === 'string' ? rec['requestId'] : undefined) ?? msg?.id;
    if (!key) continue;
    const extras: CostExtras = { ...out.get(key) };
    if (typeof usage['inference_geo'] === 'string') extras.inferenceGeo = usage['inference_geo'];
    const web = (usage['server_tool_use'] as { web_search_requests?: unknown } | undefined)
      ?.web_search_requests;
    if (typeof web === 'number') {
      extras.webSearchRequests = Math.max(extras.webSearchRequests ?? 0, web);
    }
    out.set(key, extras);
  }
  return out;
}

/** Итоги сессии по транскрипту: парсер Agentmeter (дедуп по requestId) + сабагенты + таблица цен. */
export function transcriptTotals(path: string): TranscriptTotals {
  const main = parseSessionFile(path);
  const requests: Request[] = [...main.requests];
  const extras = requestExtras(path);
  for (const sub of parseSubagents(path)) {
    requests.push(...sub.requests);
    for (const [k, v] of requestExtras(sub.session.sourcePath)) extras.set(k, v);
  }

  const tokens: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of requests) {
    const u: TokenUsage = {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
    };
    if (r.cacheWrite5m !== undefined) u.cacheWrite5m = r.cacheWrite5m;
    if (r.cacheWrite1h !== undefined) u.cacheWrite1h = r.cacheWrite1h;
    tokens.input += u.input;
    tokens.output += u.output;
    tokens.cacheRead += u.cacheRead;
    tokens.cacheWrite += u.cacheWrite;
    tokens.cacheWrite5m = (tokens.cacheWrite5m ?? 0) + (u.cacheWrite5m ?? 0);
    tokens.cacheWrite1h = (tokens.cacheWrite1h ?? 0) + (u.cacheWrite1h ?? 0);
    const c = cost(u, r.model, extras.get(r.requestId));
    if (c === undefined) unpriced++;
    else {
      usd += c;
      priced++;
    }
  }
  const last = [...main.requests].reverse().find((r) => !r.isSidechain);
  const totals: TranscriptTotals = { turns: countTurns(path), tokens };
  if (priced > 0 || unpriced === 0) totals.costUsd = usd;
  if (unpriced > 0) totals.costPartial = true;
  if (last) {
    totals.contextTokens = last.contextTokens;
    totals.model = last.model;
  }
  return totals;
}

/**
 * Ходы = промпты пользователя в основной ветке: запись `user` с текстом, не результат инструмента,
 * не служебная (`isMeta`, сводка компакции, эхо команд `<command-…>` / `<local-command-…>`,
 * «[Request interrupted…]»).
 */
export function countTurns(path: string): number {
  let turns = 0;
  for (const line of readJsonlLines(path, true).lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec['type'] !== 'user' || rec['isSidechain'] === true || rec['isMeta'] === true) continue;
    if (rec['isCompactSummary'] === true) continue;
    const content = (rec['message'] as { content?: unknown } | undefined)?.content;
    let text: string | undefined;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      if (content.some((b) => (b as { type?: string })?.type === 'tool_result')) continue;
      text = (
        content.find((b) => (b as { type?: string })?.type === 'text') as
          { text?: string } | undefined
      )?.text;
    }
    if (!text) continue;
    const t = text.trimStart();
    if (
      t.startsWith('<command-') ||
      t.startsWith('<local-command-') ||
      t.startsWith('[Request interrupted')
    )
      continue;
    turns++;
  }
  return turns;
}

/** Кэш итогов по файлу: пересчёт только при смене размера или времени изменения. */
export class TranscriptCache {
  private readonly cache = new Map<string, { key: string; totals: TranscriptTotals }>();

  get(path: string): TranscriptTotals | undefined {
    if (!existsSync(path)) return undefined;
    const st = statSync(path);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = this.cache.get(path);
    if (hit?.key === key) return hit.totals;
    const totals = transcriptTotals(path);
    this.cache.set(path, { key, totals });
    return totals;
  }
}

export interface ListOptions {
  cwd: string;
  live: LiveSessions;
  cache?: TranscriptCache;
  claudeHome?: string;
  /** Ошибка разбора одного транскрипта не роняет список. */
  onError?: (sessionId: string, error: unknown) => void;
}

export async function listSessionRows(
  adapter: AgentAdapter,
  options: ListOptions,
): Promise<SessionRow[]> {
  const sessions = await adapter.listSessions(options.cwd);
  const cache = options.cache ?? new TranscriptCache();
  return sessions.map((s): SessionRow => {
    const live = options.live.get(s.id);
    const row: SessionRow = {
      ...s,
      state: live?.state ?? 'idle',
      turns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    try {
      // `listSessions` отдаёт и сессии из worktree проекта — у них свой каталог транскриптов.
      const totals = cache.get(transcriptPath(s.cwd ?? options.cwd, s.id, options.claudeHome));
      if (totals) {
        row.turns = totals.turns;
        row.tokens = totals.tokens;
        if (totals.contextTokens !== undefined) row.contextTokens = totals.contextTokens;
        if (totals.costUsd !== undefined) {
          row.costUsd = totals.costUsd;
          row.costSource = 'pricing';
        }
        if (totals.costPartial) row.costPartial = true;
      }
    } catch (error) {
      options.onError?.(s.id, error);
    }
    if (live?.totalCostUsd !== undefined) {
      row.costUsd = live.totalCostUsd;
      row.costSource = 'engine';
      delete row.costPartial;
    }
    return row;
  });
}

/** Строка для webview (`sessions.update`). */
export function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    turns: row.turns,
    ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    ...(row.costPartial ? { costPartial: true } : {}),
    state: row.state,
    updatedAt: row.updatedAt,
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
  };
}
