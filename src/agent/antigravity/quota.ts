import { execFile } from 'node:child_process';
import { stripAgySpinnerLine } from './executable';

export type AgyUsageWindow = 'fiveHour' | 'weekly';

/** Строка квоты agy: семейство моделей, сколько осталось (0…100) и когда сброс (мс). */
export interface AgyQuotaRow {
  /** Короткая подпись: `Gemini 5ч`, `Gemini 7д`, `Claude/GPT 5ч`, `Claude/GPT 7д`, `Gemini 4 Argon 7д`; незнакомое — имя как есть. */
  label: string;
  /** Имя семейства, как его напечатал agy (`Gemini Models`, `Gemini 4 Argon`). */
  name: string;
  /** Осталось, % (0…100). */
  remaining: number;
  resetsAt?: number;
  /** Тип окна квоты (5-часовое или недельное). */
  window?: AgyUsageWindow;
}

function parseFamily(name: string): string {
  const clean = name.trim();
  if (/^gemini(?:\s+models)?$/i.test(clean)) return 'Gemini';
  if (/claude|gpt/i.test(clean)) return 'Claude/GPT';
  return clean;
}

function parseWindow(caption: string): AgyUsageWindow | undefined {
  if (/five\s*hour|5\s*h(our)?/i.test(caption)) return 'fiveHour';
  if (/week|7\s*d(ay)?/i.test(caption)) return 'weekly';
  return undefined;
}

function shortLabel(name: string, window?: AgyUsageWindow): string {
  const family = parseFamily(name);
  if (window === 'fiveHour') return `${family} 5ч`;
  if (window === 'weekly') return `${family} 7д`;
  return family;
}

/**
 * Вывод `agy -p "/usage"`: по строке на семейство, поля через TAB —
 * `Gemini Models<TAB>Weekly Limit Remaining<TAB>26%<TAB>2026-10-12T16:21:42Z`. Парсер мягкий: поля — TAB или 2+ пробела,
 * берётся имя (первое поле), первый `NN%` (дробь через точку или запятую) и первое поле-дата; строка без процента
 * пропускается. Процент — остаток; если подпись колонки говорит «used» (и не «remaining»/«left»), он переворачивается.
 * Ничего не разобрали — пустой список (не показываем).
 */
export function parseAgyUsage(output: string): AgyQuotaRow[] {
  const rows: AgyQuotaRow[] = [];
  for (const rawLine of output.split('\n')) {
    const fields = stripAgySpinnerLine(rawLine)
      .split(/\t| {2,}/)
      .map((f) => f.trim())
      .filter((f) => f !== '');
    const name = fields[0];
    if (!name || fields.length < 2) continue;
    const rest = fields.slice(1);
    const pct = rest.map((f) => /^(\d+(?:[.,]\d+)?)\s*%$/.exec(f)).find((m) => m !== null && m !== undefined);
    if (!pct?.[1]) continue;
    const value = Math.max(0, Math.min(100, Math.round(Number(pct[1].replace(',', '.')))));
    const dateField = rest.find((f) => /^\d{4}-\d\d-\d\dT/.test(f));
    const caption = rest.filter((f) => f !== dateField && /[a-z]/i.test(f)).join(' ');
    // строка квоты — с подписью про лимит или с временем сброса; прогресс и прочий шум в stdout не берём
    if (!dateField && !/limit|remaining|quota|\bused\b|\bleft\b/i.test(caption)) continue;
    const used = /\bused\b|consumed/i.test(caption) && !/remaining|\bleft\b/i.test(caption);
    const at = dateField ? Date.parse(dateField) : NaN;
    const window = parseWindow(caption);
    rows.push({
      label: shortLabel(name, window),
      name,
      remaining: used ? 100 - value : value,
      ...(Number.isFinite(at) ? { resetsAt: at } : {}),
      ...(window ? { window } : {}),
    });
  }
  return rows;
}

/** Снимает ANSI-последовательности, `\r`-спиннер и ведущий префикс `error:`. */
export function cleanAgyCliText(raw: string): string {
  const lines = raw
    .split('\n')
    .map((l) => stripAgySpinnerLine(l).trim())
    .filter((l) => l !== '' && !/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]*fetching\b/i.test(l));
  return lines.join(' ').replace(/^error:\s*/i, '').trim();
}

export function cleanAgyUsageError(error: Error, stdout = '', stderr = ''): Error {
  const msg =
    cleanAgyCliText(stderr) ||
    cleanAgyCliText(stdout) ||
    cleanAgyCliText(error.message.replace(/^Command failed:[^\n]*\n?/i, '')) ||
    cleanAgyCliText(error.message) ||
    'agy -p /usage failed';
  return new Error(msg);
}

/** Признак явного разлогина/невалидной авторизации `agy` (не региональный отказ `Eligibility check failed` и не сеть). */
export function isAgyAuthError(errOrOutput: unknown): boolean {
  const raw = errOrOutput instanceof Error ? errOrOutput.message : typeof errOrOutput === 'string' ? errOrOutput : '';
  const msg = cleanAgyCliText(raw);
  if (!msg) return false;
  if (/eligibility check failed|not currently available in your location|not eligible for antigravity/i.test(msg)) {
    return false;
  }
  if (
    /i\/o timeout|tls handshake timeout|context deadline exceeded|client\.timeout|connection reset|econnreset|econnrefused|etimedout|enotfound|eai_again|enetunreach|ehostunreach|no such host|dial tcp|\beof\b/i.test(
      msg,
    )
  ) {
    return false;
  }
  return /not logged in|please (?:log|sign) in|run agy\b.*\bsign in|\bsign in\b|\blog in\b|login required|auth(?:entication)? required|unauthenticated|\bunauthori[sz]ed\b|\b401\b|invalid_grant|(?:invalid|expired|missing) credentials/i.test(
    msg,
  );
}

export type RunAgyUsage = (path: string) => Promise<string>;

/** Сторож поверх таймаута `execFile`: тот шлёт SIGTERM только самому процессу и ждёт закрытия stdio. */
const WATCHDOG_MS = 35_000;

/** `agy -p "/usage"`: короткоживущий процесс (~7 с), модель не нужна, stdin закрыт. Завис — SIGKILL и отказ. */
export const runAgyUsage: RunAgyUsage = (path) =>
  new Promise((resolve, reject) => {
    let done = false;
    const child = execFile(path, ['-p', '/usage'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      if (error) reject(cleanAgyUsageError(error, stdout, stderr));
      else resolve(stdout);
    });
    const watchdog = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error('agy -p /usage: no answer'));
    }, WATCHDOG_MS);
    watchdog.unref?.();
    child.stdin?.end();
  });
