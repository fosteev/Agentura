/**
 * Единственное место, которое знает пути хранилища agy (`~/.gemini/antigravity-cli`). Формат НЕДОКУМЕНТИРОВАН:
 * снят с agy 1.2.17 (spikes/antigravity-probe/report.md). Только чтение, никогда запись. Любой сбой (нет
 * файла, не тот формат, огромный файл) — мягкая деградация: пустой результат и строка в журнал, не ошибка.
 */
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGY_STORAGE_VERSION = '1.2.17';

/** Транскрипты длиннее этого не читаем целиком: правка без диффа лучше зависшего хоста. */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export type StorageLog = (level: 'debug' | 'warn', message: string) => void;

/** Корень хранилища agy; параметр везде, чтобы тесты жили во временной папке. */
export function defaultAgyRoot(): string {
  return join(homedir(), '.gemini', 'antigravity-cli');
}

/** Строка `transcript_full.jsonl`: те же поля, что у `transcript.jsonl`, но `tool_calls[].args` типизированы и полны. */
export interface TranscriptStep {
  step_index: number;
  type: string;
  /** `DONE` | `RUNNING` | `ERROR` (фоновая команда — `RUNNING`, пока не кончится). */
  status?: string;
  /** ISO-время записи шага. */
  created_at?: string;
  content?: string;
  /** Текст ошибки шага (отказ по разрешениям, сбой инструмента). */
  error?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  tool_calls?: { name: string; args: Record<string, unknown> }[];
}

export function transcriptFullPath(root: string, conversationId: string): string | undefined {
  // id приходит из stdout agy: в путь — только uuid-подобное, без `..` и разделителей
  if (!/^[0-9A-Za-z-]{8,64}$/.test(conversationId)) return undefined;
  return join(root, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

export interface TranscriptHistory {
  steps: TranscriptStep[];
  /** Ранних ходов не прочитано (файл больше окна). */
  skippedTurns: number;
}

/** Начало строки шага USER_INPUT в компактном JSON agy (внутри строковых значений кавычки экранированы — не совпадёт). */
const USER_INPUT_MARK = Buffer.from('"type":"USER_INPUT"');

/** Сколько раз маркер встречается в первых `bytes` байтах файла — потоком, без разбора JSON. */
export async function countMark(path: string, mark: Buffer, bytes: number, highWaterMark?: number): Promise<number> {
  if (bytes <= 0) return 0;
  let count = 0;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1, ...(highWaterMark ? { highWaterMark } : {}) })) {
    const buf = Buffer.concat([carry, chunk as Buffer]);
    for (let at = buf.indexOf(mark); at >= 0; at = buf.indexOf(mark, at + mark.length)) count++;
    carry = buf.subarray(Math.max(0, buf.length - (mark.length - 1)));
  }
  return count;
}

/**
 * Транскрипт для истории: целиком, а больше `maxBytes` — мягкая деградация: последние `maxBytes` с первого целого
 * хода в окне, ранние ходы только считаются (по маркеру USER_INPUT, потоком) — лента покажет «N ранних ходов скрыто».
 */
export async function readTranscriptHistory(
  root: string,
  conversationId: string,
  log?: StorageLog,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): Promise<TranscriptHistory> {
  const tail = await readTranscriptTail(root, conversationId, maxBytes, log);
  if (!tail) return { steps: [], skippedTurns: 0 };
  if (tail.complete) return { steps: tail.steps, skippedTurns: 0 };
  const first = tail.steps.findIndex((s) => s.type === 'USER_INPUT');
  // один ход больше окна — показываем его хвост без промпта, а не пустоту
  const steps = first > 0 ? tail.steps.slice(first) : tail.steps;
  // ходы до окна считаем только в байтах до него (файл мог дорасти после чтения хвоста); ход, чей хвост показан
  // без промпта, скрытым не считается
  let skipped = 0;
  try {
    skipped = await countMark(transcriptFullPath(root, conversationId) as string, USER_INPUT_MARK, tail.start);
    if (first < 0 && skipped > 0) skipped--;
  } catch (error) {
    log?.('warn', `agy transcript turn count failed: ${String(error)}`);
  }
  log?.('warn', 'agy transcript is too large to read whole: only the latest turns are shown');
  return { steps, skippedTurns: skipped };
}

interface TranscriptTail {
  steps: TranscriptStep[];
  /** Прочитан весь файл (иначе — только хвост `maxBytes`). */
  complete: boolean;
  /** Байтовое смещение первой разобранной строки (до него — непрочитанное начало). */
  start: number;
}

/**
 * Последние `maxBytes` транскрипта (первая, обрезанная строка окна отбрасывается). Правке нужен только
 * хвост: шаг N — последний, а длинная беседа не должна перечитываться целиком на каждую правку.
 * Только обычный файл: FIFO/устройство не открываем.
 */
async function readTranscriptTail(
  root: string,
  conversationId: string,
  maxBytes: number,
  log: StorageLog | undefined,
): Promise<TranscriptTail | undefined> {
  const path = transcriptFullPath(root, conversationId);
  if (!path) return undefined;
  let text: string;
  let complete: boolean;
  let start: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      log?.('warn', 'agy transcript is not a regular file, skipped');
      return undefined;
    }
    const from = Math.max(0, info.size - maxBytes);
    complete = from === 0;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(info.size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      let bytes = buffer.subarray(0, bytesRead);
      start = from;
      if (!complete) {
        // окно началось посреди строки: она отбрасывается (по байтам, до разбора UTF-8)
        const newline = bytes.indexOf(0x0a);
        const skip = newline < 0 ? bytes.length : newline + 1;
        start += skip;
        bytes = bytes.subarray(skip);
      }
      text = bytes.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log?.('warn', `agy transcript read failed: ${String(error)}`);
    return undefined;
  }
  const lines = text.split('\n');
  const steps: TranscriptStep[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw['step_index'] !== 'number' || typeof raw['type'] !== 'string') continue;
      const step: TranscriptStep = { step_index: raw['step_index'], type: raw['type'] };
      if (typeof raw['content'] === 'string') step.content = raw['content'];
      for (const key of ['status', 'created_at', 'error'] as const)
        if (typeof raw[key] === 'string') step[key] = raw[key];
      for (const key of ['input_tokens', 'cache_read_tokens', 'output_tokens'] as const)
        if (typeof raw[key] === 'number') step[key] = raw[key];
      if (Array.isArray(raw['tool_calls'])) {
        step.tool_calls = raw['tool_calls'].flatMap((c: unknown) => {
          const call = c as { name?: unknown; args?: unknown };
          if (typeof call?.name !== 'string') return [];
          const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : {};
          return [{ name: call.name, args }];
        });
      }
      steps.push(step);
    } catch {
      // оборванная последняя строка (agy ещё пишет) или чужой формат — пропускаем
    }
  }
  return { steps, complete, start };
}

export interface EditDetail {
  /** Полные аргументы вызова (`TargetContent`, `ReplacementContent`, `CodeContent`…), `{}` — вызов не нашёлся. */
  args: Record<string, unknown>;
  /** Текст шага-результата (внутри — `[diff_block_start]…`). */
  resultText: string;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Вызов правки и его результат. Шаг tool из стрима с индексом N — это GENERIC-результат N в транскрипте
 * (нумерация сквозная и после `--conversation`), а сам вызов — в ближайшем выше PLANNER_RESPONSE с `tool_calls`:
 * результаты его вызовов идут подряд, поэтому вызов N — тот, чей номер равен числу GENERIC между ними.
 * Дальше назад не ищем (чужая правка того же файла дала бы чужие old/new): не сошлось имя или `TargetFile` —
 * `args = {}`, остаются ханки. Результат не про этот файл (нет его имени в тексте) или ещё не дописан — `undefined`.
 */
export function findEditDetail(
  steps: readonly TranscriptStep[],
  stepIndex: number,
  toolName: string,
  targetFile: string | undefined,
): EditDetail | undefined {
  const result = steps.find((s) => s.step_index === stepIndex && s.type === 'GENERIC');
  if (!result || typeof result.content !== 'string') return undefined;
  if (targetFile !== undefined) {
    const name = baseName(targetFile);
    if (name && !result.content.includes(name) && !result.content.includes(encodeURIComponent(name))) return undefined;
  }
  let planner: TranscriptStep | undefined;
  for (const s of steps) {
    if (s.step_index < stepIndex && s.tool_calls?.length && (!planner || s.step_index > planner.step_index)) planner = s;
  }
  let args: Record<string, unknown> = {};
  if (planner) {
    const from = planner.step_index;
    const ordinal = steps.filter((s) => s.type === 'GENERIC' && s.step_index > from && s.step_index < stepIndex).length;
    const call = planner.tool_calls?.[ordinal];
    if (call && call.name === toolName && (targetFile === undefined || call.args['TargetFile'] === targetFile))
      args = call.args;
  }
  return { args, resultText: result.content };
}

/** Окно хвоста транскрипта для правки; не хватило (вызов выше окна) — расширяем ×4 до `MAX_TRANSCRIPT_BYTES`. */
const EDIT_WINDOW_BYTES = 1024 * 1024;

/**
 * Хвост транскрипта + `findEditDetail` с повторами: agy может дописать транскрипт позже, чем пришёл DONE шага.
 * `signal` (сессия закрыта) прекращает повторы.
 */
export async function readEditDetail(
  root: string,
  conversationId: string,
  stepIndex: number,
  toolName: string,
  targetFile: string | undefined,
  options: { retries?: number; delayMs?: number; log?: StorageLog; signal?: AbortSignal; windowBytes?: number } = {},
): Promise<EditDetail | undefined> {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 120;
  let window = options.windowBytes ?? EDIT_WINDOW_BYTES;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) return undefined;
    // нет файла (agy ещё не создал) — как пустой: повторяем
    const tail = (await readTranscriptTail(root, conversationId, window, options.log)) ?? { steps: [], complete: true, start: 0 };
    const found = findEditDetail(tail.steps, stepIndex, toolName, targetFile);
    // шага с вызовом в окне нет (огромный CodeContent или дифф): шире окно, сразу, без паузы
    const callInWindow = tail.steps.some((s) => s.step_index < stepIndex && s.tool_calls?.length);
    if (!callInWindow && !tail.complete && window < MAX_TRANSCRIPT_BYTES) {
      window = Math.min(window * 4, MAX_TRANSCRIPT_BYTES);
      attempt--;
      continue;
    }
    if (found) return found;
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return undefined;
}

/** Строка `conversation_summaries.db`, нужная для списка (остальные колонки — служебные). */
export interface ConversationSummary {
  id: string;
  /** Пустой у headless-бесед. */
  title: string;
  /** Первый запрос пользователя (у headless — вместо заголовка). */
  preview: string;
  stepCount: number;
  /** Мс с эпохи. */
  lastModified: number;
  /** Пути воркспейсов беседы (из `file://` URI). */
  workspaces: string[];
}

/** Последний прочитанный список по корню: база не менялась (размер и mtime базы и `-wal`) — не копируем заново. */
const summariesCache = new Map<string, { signature: string; rows: ConversationSummary[] }>();

function cloneRows(rows: readonly ConversationSummary[]): ConversationSummary[] {
  return rows.map((row) => ({ ...row, workspaces: [...row.workspaces] }));
}

async function summariesSignature(source: string): Promise<string> {
  const parts: string[] = [];
  for (const path of [source, `${source}-wal`]) {
    const info = await stat(path).catch(() => undefined);
    parts.push(info ? `${info.size}:${info.mtimeMs}` : '-');
  }
  return parts.join('|');
}

/** Файл базы больше этого не копируем (список — не повод держать десятки МБ во временной папке). */
const MAX_SUMMARIES_BYTES = 64 * 1024 * 1024;

/** `2026-10-06 07:51:39.002729+00:00` → мс; не разобрали — `undefined`. */
export function parseSummaryTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function workspacePaths(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const list: unknown = JSON.parse(value);
    if (!Array.isArray(list)) return [];
    return list.flatMap((uri: unknown) => {
      if (typeof uri !== 'string') return [];
      try {
        return [uri.startsWith('file:') ? fileURLToPath(uri) : uri];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Беседы agy из `conversation_summaries.db` через `node:sqlite` (Node ≥ 22.13; в VS Code с Electron на Node 20 его нет).
 * Базу не открываем на месте: agy держит её с WAL, поэтому копия (с `-wal`/`-shm`) во временную папку, чтение,
 * удаление копии. `undefined` — источник недоступен (нет `node:sqlite`, нет файла, схема другая): вызывающий
 * берёт запасной путь. Подбеседы (`parent_conversation_id`) и пустые беседы отбрасываем.
 */
export async function readConversationSummaries(root: string, log?: StorageLog): Promise<ConversationSummary[] | undefined> {
  const source = join(root, 'conversation_summaries.db');
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    log?.('debug', 'node:sqlite is not available in this host, using the Agentura session index');
    return undefined;
  }
  let dir: string | undefined;
  try {
    const info = await stat(source);
    if (!info.isFile() || info.size > MAX_SUMMARIES_BYTES) return undefined;
    const signature = await summariesSignature(source);
    const cached = summariesCache.get(root);
    if (cached?.signature === signature) return cloneRows(cached.rows);
    dir = await mkdtemp(join(tmpdir(), 'agentura-agy-'));
    const copy = join(dir, 'summaries.db');
    await copyFile(source, copy);
    for (const suffix of ['-wal', '-shm']) await copyFile(source + suffix, copy + suffix).catch(() => undefined);
    const db = new sqlite.DatabaseSync(copy);
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
             FROM conversation_summaries
            WHERE parent_conversation_id = '' AND step_count > 0`,
        )
        .all();
      const list: ConversationSummary[] = [];
      for (const row of rows) {
        const id = row['conversation_id'];
        const lastModified = parseSummaryTime(row['last_modified_time']);
        if (typeof id !== 'string' || lastModified === undefined) continue;
        list.push({
          id,
          title: typeof row['title'] === 'string' ? row['title'] : '',
          preview: typeof row['preview'] === 'string' ? row['preview'] : '',
          stepCount: typeof row['step_count'] === 'number' ? row['step_count'] : 0,
          lastModified,
          workspaces: workspacePaths(row['workspace_uris']),
        });
      }
      summariesCache.set(root, { signature, rows: cloneRows(list) });
      return list;
    } finally {
      db.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      summariesCache.delete(root);
      return undefined;
    }
    log?.('warn', `agy conversation summaries read failed: ${String(error)}`);
    // копия снята посреди checkpoint agy и т.п.: прошлый список лучше, чем скачок к запасному индексу
    const cached = summariesCache.get(root);
    return cached ? cloneRows(cached.rows) : undefined;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
