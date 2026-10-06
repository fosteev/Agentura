import { execFile } from 'node:child_process';

/** Строка квоты agy: семейство моделей, сколько осталось (0…100) и когда сброс (мс). */
export interface AgyQuotaRow {
  /** Короткая подпись: `Gemini`, `Claude/GPT`; незнакомое семейство — имя как есть. */
  label: string;
  /** Имя семейства, как его напечатал agy (`Gemini Models`). */
  name: string;
  /** Осталось, % (0…100). */
  remaining: number;
  resetsAt?: number;
}

function shortLabel(name: string): string {
  if (/gemini/i.test(name)) return 'Gemini';
  if (/claude|gpt/i.test(name)) return 'Claude/GPT';
  return name;
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
  for (const line of output.split('\n')) {
    const fields = line
      .replace(/\r$/, '')
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
    rows.push({
      label: shortLabel(name),
      name,
      remaining: used ? 100 - value : value,
      ...(Number.isFinite(at) ? { resetsAt: at } : {}),
    });
  }
  return rows;
}

export type RunAgyUsage = (path: string) => Promise<string>;

/** Сторож поверх таймаута `execFile`: тот шлёт SIGTERM только самому процессу и ждёт закрытия stdio. */
const WATCHDOG_MS = 35_000;

/** `agy -p "/usage"`: короткоживущий процесс (~7 с), модель не нужна, stdin закрыт. Завис — SIGKILL и отказ. */
export const runAgyUsage: RunAgyUsage = (path) =>
  new Promise((resolve, reject) => {
    let done = false;
    const child = execFile(path, ['-p', '/usage'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }, (error, stdout) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      if (error) reject(error);
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
