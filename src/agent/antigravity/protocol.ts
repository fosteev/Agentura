/**
 * Протокол `agy` (Antigravity CLI) 1.2.17, headless: `agy -p= --input-format stream-json
 * --output-format stream-json`. Снят живыми прогонами (roadmap 16, `spikes/antigravity-probe/report.md`),
 * схемы у agy нет: типы описывают только то, что видели; всё прочее приходит как есть и игнорируется.
 * Поля, которых в логах не было, помечены необязательными.
 */

/** Версия agy, по которой сняты типы и фикстуры. */
export const AGY_PROTOCOL_VERSION = '1.2.17';

// ---- вход (stdin, NDJSON) ----------------------------------------------------------------------------

/** Блок содержимого сообщения: проверен только текстовый (image-блоки в бинарнике есть, не проверены). */
export interface AgyTextBlock {
  type: 'text';
  text: string;
}

/** `{"event":"user","message":{"role":"user","content":…}}`. Ошибка декодирования фатальна (процесс выходит с 1). */
export interface AgyUserInput {
  event: 'user';
  message: { role: 'user'; content: string | AgyTextBlock[] };
}

// ---- выход (stdout, NDJSON) --------------------------------------------------------------------------

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Входит в `output_tokens` (14998 + 308 = 15306 = total при thinking 192). */
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** `init`: приходит ~2 с после старта, ещё до ввода; на `--conversation` — с тем же `conversation_id`. */
export interface AgyInit {
  event: 'init';
  conversation_id: string;
  init: {
    model?: string;
    cwd?: string;
    tools?: string[];
    /** Внутренний режим agy (`request-review`), не режим Agentura. */
    permission_mode?: string;
  };
}

export type AgyStepState = 'ACTIVE' | 'DONE' | 'ERROR';
export type AgyStepType = 'user_input' | 'agent_response' | 'tool' | 'system_message';

export interface AgyToolInfo {
  name?: string;
  /** Только короткие параметры (`TargetFile`, `CommandLine`): тел правок и диффа в потоке нет. */
  parameters?: Record<string, unknown>;
  /** Только на DONE (`done\r\n`). */
  output?: string;
  error?: { type?: string; message?: string };
}

export interface AgyStep {
  conversation_id?: string;
  step_index: number;
  state: AgyStepState;
  /** Тип без известных значений (agy добавит новые) не роняет разбор. */
  step_type: AgyStepType | (string & {});
  /** Стримится только у финального шага ответа; промежуточные шаги приходят одним DONE без текста. */
  text_delta?: string;
  duration_seconds?: number;
  /** На DONE шага `agent_response`. */
  usage?: AgyUsage;
  tool_name?: string;
  tool_info?: AgyToolInfo;
}

export interface AgyStepUpdate {
  event: 'step_update';
  step_update: AgyStep;
}

export interface AgyDeniedAction {
  /** Имя разрешения (`write_file`) — не совпадает с `tool_name` шага (`write_to_file`). */
  action?: string;
  display_name?: string;
}

/** `result`: один на ход. `usage`/`duration_seconds`/`num_turns` накопительные за процесс. */
export interface AgyResult {
  event: 'result';
  result: {
    conversation_id?: string;
    status: 'SUCCESS' | 'ERROR' | (string & {});
    /** Последний текст ответа. */
    response?: string;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AgyUsage;
    denied_actions?: AgyDeniedAction[];
  };
}

export type AgyEvent = AgyInit | AgyStepUpdate | AgyResult;

/** Строка stdout → событие; не JSON, не объект или неизвестное `event` — `undefined`. */
export function parseAgyLine(line: string): AgyEvent | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { event?: unknown; step_update?: unknown; result?: unknown; init?: unknown };
  if (v.event === 'init' && typeof (value as AgyInit).conversation_id === 'string')
    return { ...(value as AgyInit), init: (v.init as AgyInit['init'] | undefined) ?? {} };
  if (v.event === 'step_update' && v.step_update && typeof v.step_update === 'object')
    return value as AgyStepUpdate;
  if (v.event === 'result' && v.result && typeof v.result === 'object') return value as AgyResult;
  return undefined;
}

/** Строка stdin: одно сообщение пользователя. */
export function userInputLine(text: string): string {
  const input: AgyUserInput = { event: 'user', message: { role: 'user', content: text } };
  return `${JSON.stringify(input)}\n`;
}

/**
 * stderr: свободный текст; строка `AGY_ERROR: {…}` — ошибка модели/API (по changelog; формат JSON в живых
 * прогонах не снимали, поэтому поля читаем осторожно).
 */
export function parseAgyError(line: string): { message: string; code?: string } | undefined {
  const m = /^AGY_ERROR:\s*(.*)$/.exec(line.trim());
  if (!m) return undefined;
  const body = (m[1] ?? '').trim();
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const message = [o.message, o.error, o.msg].find((x) => typeof x === 'string' && x) as string | undefined;
      const code = [o.code, o.type, o.status].find((x) => (typeof x === 'string' || typeof x === 'number') && x !== '');
      return { message: message ?? body, ...(code !== undefined ? { code: String(code) } : {}) };
    }
  } catch {
    // не JSON — берём строку как есть
  }
  return { message: body || 'AGY_ERROR' };
}
