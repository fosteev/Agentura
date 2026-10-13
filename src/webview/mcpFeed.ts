/**
 * MCP и скиллы в ленте (roadmap 21, этап 2): чистые функции над строками ленты и списком серверов. Счётчики и
 * скиллы сессии не хранятся — считаются по `rows`, поэтому пересев и история их восстанавливают сами (решения 4–5).
 */
import type { McpServerInfo } from '../agent/types';
import type { FeedRow } from './chatState';
import { mcpToolParts } from './toolView';
import { isPluginSkill } from '../shared/skills';

/**
 * CLI делает из имени сервера префикс инструмента: всё, кроме `[A-Za-z0-9_-]`, → `_` (`claude.ai Gmail` →
 * `claude_ai_Gmail`); у коннекторов claude.ai ещё схлопывает `_+` и срезает `_` по краям (так в SDK).
 */
export function mcpPrefix(serverName: string): string {
  const p = serverName.replace(/[^A-Za-z0-9_-]/g, '_');
  return serverName.startsWith('claude.ai ') ? p.replace(/_+/g, '_').replace(/^_+|_+$/g, '') : p;
}

/**
 * Сервер из статуса по префиксу из имени инструмента. Нормализуются обе стороны: Claude кладёт в имя уже
 * нормализованный префикс, Codex — имя сервера как есть (`codex/tools.ts`).
 */
export function serverByPrefix(
  servers: readonly McpServerInfo[] | undefined,
  prefix: string,
): McpServerInfo | undefined {
  const p = mcpPrefix(prefix);
  return servers?.find((s) => mcpPrefix(s.name) === p);
}

/** Сбой: сервер не поднялся или ждёт входа. */
export const isBadServer = (s: McpServerInfo): boolean => s.status === 'failed' || s.status === 'needs-auth';

export interface McpUsage {
  /** Вызовов всего. */
  total: number;
  /** Вызовов по тулам, в порядке первого появления. */
  tools: Map<string, number>;
}

/** Вызовы MCP по серверам (ключ — префикс из имени инструмента): `tool.start` с `mcp__<server>__<tool>` в ленте. */
export function mcpUsage(rows: readonly FeedRow[]): Map<string, McpUsage> {
  const out = new Map<string, McpUsage>();
  for (const r of rows) {
    if (r.kind !== 'tool') continue;
    const p = mcpToolParts(r.name);
    if (!p) continue;
    let u = out.get(p.server);
    if (!u) out.set(p.server, (u = { total: 0, tools: new Map() }));
    u.total++;
    u.tools.set(p.tool, (u.tools.get(p.tool) ?? 0) + 1);
  }
  return out;
}

export interface SessionSkill {
  name: string;
  /** `agent` — вызвал сам агент (`Skill`), `slash` — пользователь набрал `/имя`. */
  how: 'agent' | 'slash';
  /** id строки ленты, в которой это произошло (порядок и якорь). */
  id: number;
}

/** Имя скилла из вызова `Skill` (`/plan` → `plan`). */
export function skillOfTool(r: Extract<FeedRow, { kind: 'tool' }>): string | undefined {
  if (r.name !== 'Skill') return undefined;
  const v = r.input['skill'];
  return typeof v === 'string' && v ? v.replace(/^\//, '') : undefined;
}

/** `/имя` в начале сообщения → имя, если оно есть среди доступных скиллов. */
export function slashSkill(text: string, available: readonly string[]): string | undefined {
  const m = /^\/([^\s]+)(?:\s|$)/.exec(text.trimStart());
  return m && available.includes(m[1]!) ? m[1] : undefined;
}

/** Скиллы сессии: вызовы `Skill` и сообщения `/имя` (решение 5), повторы одного скилла — одной записью (первый). */
export function sessionSkills(rows: readonly FeedRow[], available: readonly string[]): SessionSkill[] {
  const out: SessionSkill[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let name: string | undefined;
    let how: SessionSkill['how'] = 'agent';
    if (r.kind === 'tool') name = skillOfTool(r);
    else if (r.kind === 'user' && !r.queued) {
      name = slashSkill(r.text, available);
      how = 'slash';
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, how, id: r.id });
  }
  return out;
}

/** Ссылка «открыть SKILL.md» — только у скилла, для которого хост нашёл файл, и никогда у плагинного (`a:b`). */
export function canOpenSkill(name: string, files: ReadonlySet<string>): boolean {
  return !isPluginSkill(name) && files.has(name);
}

/** Счётчики итога хода: вызовы MCP и скиллов среди строк хода (`rows` — строки с прошлого итога). */
export function turnCounts(rows: readonly FeedRow[]): { mcp: number; skill: number } {
  let mcp = 0;
  let skill = 0;
  for (const r of rows) {
    if (r.kind !== 'tool') continue;
    if (mcpToolParts(r.name)) mcp++;
    else if (skillOfTool(r)) skill++;
  }
  return { mcp, skill };
}

/** Данные системной строки MCP: полный список на момент события и кто в сбое. */
export interface McpNote {
  variant: 'start' | 'fail' | 'toggle';
  servers: { name: string; status: McpServerInfo['status']; error?: string }[];
  /** Имена серверов в сбое: при `start` — все такие, при `fail` — только упавшие в этом событии; при `toggle` пусто. */
  bad: string[];
  /** `toggle` (roadmap 22): серверы, ставшие `disabled` в этом событии, и число их тулов по прошлому статусу. */
  off?: { name: string; tools?: number }[];
  /** `toggle`: серверы, вышедшие из `disabled` в этом событии. */
  on?: string[];
}

/**
 * Что писать в ленту по новому `mcp.status` (решение 11). Первый статус сессии — `start`; дальше — `fail`, если
 * сервер перешёл в `failed`/`needs-auth` из любого другого состояния (или появился уже упавшим). Пустой список — ничего.
 */
export function mcpNote(prev: readonly McpServerInfo[] | undefined, next: readonly McpServerInfo[]): McpNote | undefined {
  if (!next.length) return undefined;
  const servers = next.map((s) => ({ name: s.name, status: s.status, ...(s.error ? { error: s.error } : {}) }));
  // пустой прошлый список (серверов ещё не было) — тоже старт
  if (!prev?.length) return { variant: 'start', servers, bad: next.filter(isBadServer).map((s) => s.name) };
  const was = new Map(prev.map((s) => [s.name, s.status]));
  const bad = next
    .filter((s) => isBadServer(s) && was.get(s.name) !== 'failed' && was.get(s.name) !== 'needs-auth')
    .map((s) => s.name);
  if (bad.length) return { variant: 'fail', servers, bad };
  // сбой в том же событии приоритетнее (выше); иначе — тумблер (roadmap 22, решение 7)
  const off: { name: string; tools?: number }[] = [];
  const on: string[] = [];
  for (const s of next) {
    const w = was.get(s.name);
    if (w === undefined) continue;
    if (s.status === 'disabled' && w !== 'disabled') {
      const tools = prev.find((p) => p.name === s.name)?.tools;
      off.push({ name: s.name, ...(tools !== undefined ? { tools } : {}) });
    } else if (s.status !== 'disabled' && w === 'disabled') on.push(s.name);
  }
  return off.length || on.length
    ? { variant: 'toggle', servers, bad: [], ...(off.length ? { off } : {}), ...(on.length ? { on } : {}) }
    : undefined;
}

/**
 * Старт ещё «оседает»: последняя строка MCP — сводка `start` с серверами в `pending`, и ход, в котором она встала, не
 * закончился (после неё нет итога). Тогда следующий статус уточняет эту сводку (Claude: init даёт `pending`, сразу за
 * ним `mcpServerStatus` — `connected`/`failed`), а не пишет «отключился» про сервер, который и не поднимался.
 * Возвращает индекс строки или -1.
 */
export function settlingStart(rows: readonly FeedRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === 'sum') return -1;
    if (r.kind !== 'sys' || !r.mcp) continue;
    return r.mcp.variant === 'start' && r.mcp.servers.some((x) => x.status === 'pending') ? i : -1;
  }
  return -1;
}

/** Показывать ли системную строку при настройке `agentura.mcp.feedStatus` (`toggle` виден при `failures` и `start`). */
export function noteVisible(n: McpNote, mode: 'failures' | 'start' | 'off'): boolean {
  if (mode === 'off') return false;
  if (mode === 'start') return true;
  return n.variant === 'toggle' || n.bad.length > 0;
}
