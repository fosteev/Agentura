/**
 * Единственное место, которое знает пути хранилища agy (`~/.gemini/antigravity-cli`). Формат НЕДОКУМЕНТИРОВАН:
 * снят с agy 1.2.17 (spikes/antigravity-probe/report.md). Только чтение, никогда запись. Любой сбой (нет
 * файла, не тот формат, огромный файл) — мягкая деградация: пустой результат и строка в журнал, не ошибка.
 */
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  content?: string;
  tool_calls?: { name: string; args: Record<string, unknown> }[];
}

export function transcriptFullPath(root: string, conversationId: string): string | undefined {
  // id приходит из stdout agy: в путь — только uuid-подобное, без `..` и разделителей
  if (!/^[0-9A-Za-z-]{8,64}$/.test(conversationId)) return undefined;
  return join(root, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

export async function readTranscriptFull(
  root: string,
  conversationId: string,
  log?: StorageLog,
): Promise<TranscriptStep[]> {
  return (await readTranscriptTail(root, conversationId, MAX_TRANSCRIPT_BYTES, log, true))?.steps ?? [];
}

interface TranscriptTail {
  steps: TranscriptStep[];
  /** Прочитан весь файл (иначе — только хвост `maxBytes`). */
  complete: boolean;
}

/**
 * Последние `maxBytes` транскрипта (первая, обрезанная строка окна отбрасывается). Правке нужен только
 * хвост: шаг N — последний, а длинная беседа не должна перечитываться целиком на каждую правку.
 * `whole` — файл больше окна не читать вовсе (история). Только обычный файл: FIFO/устройство не открываем.
 */
async function readTranscriptTail(
  root: string,
  conversationId: string,
  maxBytes: number,
  log: StorageLog | undefined,
  whole = false,
): Promise<TranscriptTail | undefined> {
  const path = transcriptFullPath(root, conversationId);
  if (!path) return undefined;
  let text: string;
  let complete: boolean;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      log?.('warn', 'agy transcript is not a regular file, skipped');
      return undefined;
    }
    if (whole && info.size > maxBytes) {
      log?.('warn', `agy transcript is too large (${info.size} bytes), skipped`);
      return undefined;
    }
    const from = Math.max(0, info.size - maxBytes);
    complete = from === 0;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(info.size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log?.('warn', `agy transcript read failed: ${String(error)}`);
    return undefined;
  }
  const lines = text.split('\n');
  if (!complete) lines.shift(); // окно началось посреди строки
  const steps: TranscriptStep[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw['step_index'] !== 'number' || typeof raw['type'] !== 'string') continue;
      const step: TranscriptStep = { step_index: raw['step_index'], type: raw['type'] };
      if (typeof raw['content'] === 'string') step.content = raw['content'];
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
  return { steps, complete };
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
    const tail = (await readTranscriptTail(root, conversationId, window, options.log)) ?? { steps: [], complete: true };
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
