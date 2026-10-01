import { stat } from 'node:fs/promises';
import type { CostExtras } from './pricing';
import { isJsonLine, readByteAt, streamLines } from './jsonlStream';

/**
 * Итоги транскрипта, накопленные с сохранённого смещения (этап 5 roadmap 0.2): идущий ход дописывает в
 * `.jsonl` строки, а список сессий пересчитывается каждые несколько секунд — перечитывать 50 МБ с base64
 * картинок и pdf на каждый тик нельзя (замер: ~370 мс блокировки хоста на тик). Читается только хвост.
 *
 * Правила — те же, что у парсера Agentmeter (`agentmeter/sources/claude/parse.ts`, vendored байт в байт и
 * не правится): запрос = записи ассистента с одним `requestId`, токены — максимум по записям; модель — из
 * первой записи запроса (или первой модели сессии); между соседними запросами, если `cacheRead` вырос больше,
 * чем кэш предыдущего, — восстановленная запись кэша. Ходы и надбавки к цене — как `countTurns` и
 * `requestExtras`. Равенство с полным разбором проверяет `transcriptTally.test.ts`, с Agentmeter —
 * `scripts/sessions-verify.mjs`.
 */

interface Draft {
  requestId: string;
  model: string;
  isSidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** Запрос для итогов (как `Request` Agentmeter, только нужные поля). */
export interface TallyRequest {
  requestId: string;
  model: string;
  isSidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  contextTokens: number;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const objOf = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

export class FileTally {
  /** Смещение после последней разобранной строки. */
  offset = 0;
  /** Байт перед `offset`: не совпал — файл переписали, считаем заново. */
  private lastByte = -1;
  /** `dev:ino` файла: другой — файл заменили. */
  private identity: string | undefined;
  private readonly drafts = new Map<string, Draft>();
  private sessionModel: string | undefined;
  turns = 0;
  readonly extras = new Map<string, CostExtras>();

  /** Дочитать файл с сохранённого смещения. Файл короче или другой — с начала. */
  async advance(path: string): Promise<void> {
    const st = await stat(path);
    const identity = `${st.dev}:${st.ino}`;
    let fresh = this.identity !== identity || st.size < this.offset;
    if (!fresh && this.offset > 0) {
      // тот же файл, но переписан под тем же или большим размером — байт перед смещением другой
      fresh = (await readByteAt(path, this.offset - 1)) !== this.lastByte;
    }
    if (fresh) this.reset(identity);
    if (st.size === this.offset) return;
    const r = await streamLines(path, (line) => this.consume(line), {
      start: this.offset,
      end: st.size,
      acceptTail: isJsonLine,
    });
    this.offset = r.offset;
    this.lastByte = r.lastByte;
  }

  private reset(identity: string): void {
    this.identity = identity;
    this.offset = 0;
    this.lastByte = -1;
    this.drafts.clear();
    this.sessionModel = undefined;
    this.turns = 0;
    this.extras.clear();
  }

  /** Одна строка транскрипта. */
  consume(line: string): void {
    if (line.trim() === '') return;
    let rec: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      const o = objOf(parsed);
      if (!o) return;
      rec = o;
    } catch {
      return;
    }
    if (rec['type'] === 'assistant') this.assistant(rec);
    else if (rec['type'] === 'user' && isTurn(rec)) this.turns++;
  }

  private assistant(rec: Json): void {
    const msg = objOf(rec['message']);
    const usage = objOf(msg?.['usage']);
    // надбавки к цене (`requestExtras`): ключ — requestId, иначе id сообщения
    if (usage) {
      const key = str(rec['requestId']) ?? str(msg?.['id']);
      if (key) {
        const extras: CostExtras = { ...this.extras.get(key) };
        const geo = str(usage['inference_geo']);
        if (geo !== undefined) extras.inferenceGeo = geo;
        const web = num(objOf(usage['server_tool_use'])?.['web_search_requests']);
        if (web !== undefined)
          extras.webSearchRequests = Math.max(extras.webSearchRequests ?? 0, web);
        this.extras.set(key, extras);
      }
    }
    // запрос (`consumeAssistant` Agentmeter): без requestId или message — не запрос
    const requestId = str(rec['requestId']);
    if (!requestId || !msg) return;
    const model = str(msg['model']) ?? this.sessionModel ?? 'unknown';
    if (!this.sessionModel && model !== 'unknown') this.sessionModel = model;
    const sidechain = rec['isSidechain'] === true;
    let d = this.drafts.get(requestId);
    if (!d) {
      d = {
        requestId,
        model,
        isSidechain: sidechain,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      this.drafts.set(requestId, d);
    }
    d.isSidechain = d.isSidechain || sidechain;
    if (!usage) return;
    d.input = Math.max(d.input, num(usage['input_tokens']) ?? 0);
    d.output = Math.max(d.output, num(usage['output_tokens']) ?? 0);
    d.cacheWrite = Math.max(d.cacheWrite, num(usage['cache_creation_input_tokens']) ?? 0);
    d.cacheRead = Math.max(d.cacheRead, num(usage['cache_read_input_tokens']) ?? 0);
    const creation = objOf(usage['cache_creation']);
    const w5 = creation ? num(creation['ephemeral_5m_input_tokens']) : undefined;
    const w1 = creation ? num(creation['ephemeral_1h_input_tokens']) : undefined;
    if (w5 !== undefined) d.cacheWrite5m = Math.max(d.cacheWrite5m ?? 0, w5);
    if (w1 !== undefined) d.cacheWrite1h = Math.max(d.cacheWrite1h ?? 0, w1);
  }

  /** Запросы в порядке появления плюс восстановленные записи кэша (`buildRequests` Agentmeter). */
  requests(): TallyRequest[] {
    const out: TallyRequest[] = [];
    let previous: TallyRequest | undefined;
    for (const d of this.drafts.values()) {
      const current: TallyRequest = {
        requestId: d.requestId,
        model: d.model,
        isSidechain: d.isSidechain,
        input: d.input,
        output: d.output,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
        contextTokens: d.input + d.cacheRead + d.cacheWrite,
      };
      if (d.cacheWrite5m !== undefined) current.cacheWrite5m = d.cacheWrite5m;
      if (d.cacheWrite1h !== undefined) current.cacheWrite1h = d.cacheWrite1h;
      if (previous) {
        const expected = previous.cacheRead + previous.cacheWrite;
        if (current.cacheRead > expected) {
          out.push({
            requestId: `reconstructed:${previous.requestId}`,
            model: previous.model,
            isSidechain: previous.isSidechain,
            input: 0,
            output: 0,
            cacheWrite: current.cacheRead - expected,
            cacheRead: expected,
            contextTokens: current.cacheRead,
          });
        }
      }
      out.push(current);
      previous = current;
    }
    return out;
  }
}

/**
 * Ход = промпт пользователя в основной ветке (`countTurns`): запись `user` с текстом, не результат инструмента,
 * не служебная (`isMeta`, сводка компакции, эхо команд, «[Request interrupted…]»); картинка или файл без
 * текста — тоже ход (этапы 4 и 8).
 */
export function isTurn(rec: Json): boolean {
  if (rec['type'] !== 'user' || rec['isSidechain'] === true || rec['isMeta'] === true) return false;
  if (rec['isCompactSummary'] === true) return false;
  const content = objOf(rec['message'])?.['content'];
  let text: string | undefined;
  let attachment = false;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => objOf(b)?.['type'] === 'tool_result')) return false;
    text = str(content.map(objOf).find((b) => b?.['type'] === 'text')?.['text']);
    attachment = content.some((b) => {
      const type = objOf(b)?.['type'];
      return type === 'image' || type === 'document';
    });
  }
  if (!text) return attachment;
  const t = text.trimStart();
  return !(
    t.startsWith('<command-') ||
    t.startsWith('<local-command-') ||
    t.startsWith('[Request interrupted')
  );
}
