/**
 * Транскрипты субагентов (этап 2 roadmap 0.2, A6). CLI пишет их рядом с транскриптом сессии:
 * `<каталог проекта>/<sessionId>/subagents/agent-<taskId>.jsonl` и `.meta.json`
 * (`{agentType, description, toolUseId}`), записи — `user`/`assistant` с `isSidechain: true`.
 * Отсюда — ход агента для восстановленной истории (вызовы с `agentId`) и текст для «транскрипт»
 * (документ только для чтения). Формат транскрипта внутренний — разбор терпимый.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { streamLines } from '../../data/jsonlStream';
import { hostStrings, type Lang } from '../../shared/l10n';
import type { AgentEvent } from '../types';
import { arr, isObj, obj, str, timestamp, type Json } from './json';

/** Имя задачи из движка — только буквы, цифры, `-`/`_`: в путь файла ничего другого не попадает. */
const TASK_ID = /^[\w-]{1,64}$/;

/** Каталог транскриптов субагентов сессии: рядом с её транскриптом, `<sessionId>/subagents`. */
export function subagentsDir(sessionFile: string, sessionId: string): string | undefined {
  if (!TASK_ID.test(sessionId)) return undefined;
  return join(dirname(sessionFile), sessionId, 'subagents');
}

/**
 * Файл транскрипта субагента в каталоге `subagents`. У воркфлоу файлы лежат глубже
 * (`subagents/workflows/<wf>/agent-<id>.jsonl`) — ищем на два уровня вниз.
 */
export async function subagentFile(root: string, taskId: string): Promise<string | undefined> {
  if (!TASK_ID.test(taskId)) return undefined;
  const name = `agent-${taskId}.jsonl`;
  const direct = join(root, name);
  if (await exists(direct)) return direct;
  if (!(await exists(root))) return undefined;
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    if (depth > 2) return undefined;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      if (await exists(join(sub, name))) return join(sub, name);
      const deeper = await walk(sub, depth + 1);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return walk(root, 1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Записи `user`/`assistant` транскрипта субагента — потоком (этап 5 roadmap 0.2), не строкой файла целиком. */
export async function readSubagentRecords(path: string): Promise<Json[]> {
  const out: Json[] = [];
  await streamLines(
    path,
    (line) => {
      if (!line.trim()) return;
      try {
        const rec: unknown = JSON.parse(line);
        if (isObj(rec) && (rec['type'] === 'user' || rec['type'] === 'assistant')) out.push(rec);
      } catch {
        // битая строка — пропускаем
      }
    },
    // оборванная последняя строка идущего агента не разберётся — пропускается
    { acceptTail: () => true },
  );
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .filter(isObj)
    .map((b) => (b['type'] === 'text' ? (str(b['text']) ?? '') : `[${str(b['type']) ?? 'block'}]`))
    .join('\n');
}

/** Сколько последних событий субагента отдать в историю: длинные агенты делают сотни вызовов. */
const MAX_EVENTS = 400;

/**
 * Ход субагента для восстановленной истории: вызовы и результаты инструментов, рассуждение,
 * модель — те же события с `agentId`, что у живой сессии (их собирает панель «агенты»).
 * Текст ответа не отдаётся: итог приходит `agent.end.summary`, а строке без времени нечего показать.
 */
export function subagentEvents(records: readonly Json[], agentId: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  const started = new Map<string, number>();
  let model: string | undefined;
  for (const rec of records) {
    const msg = obj(rec['message']);
    if (!msg) continue;
    const at = timestamp(rec['timestamp']);
    if (rec['type'] === 'assistant') {
      const m = str(msg['model']);
      const id = str(msg['id']) ?? '';
      if (!model && m && m !== '<synthetic>') {
        model = m;
        out.push({
          type: 'usage.message',
          agentId,
          messageId: id,
          model: m,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          final: false,
          ...(at !== undefined ? { at } : {}),
        });
      }
      for (const b of arr(msg['content']).filter(isObj)) {
        if (b['type'] === 'tool_use') {
          const toolUseId = str(b['id']);
          if (!toolUseId) continue;
          if (at !== undefined) started.set(toolUseId, at);
          out.push({
            type: 'tool.start',
            agentId,
            toolUseId,
            name: str(b['name']) ?? '',
            input: obj(b['input']) ?? {},
            ...(at !== undefined ? { at } : {}),
          });
        } else if (b['type'] === 'thinking' && str(b['thinking']) && at !== undefined) {
          out.push({ type: 'thinking.start', agentId, messageId: id, at });
          out.push({ type: 'thinking.stop', agentId, messageId: id, at });
        }
      }
    } else {
      for (const b of arr(msg['content']).filter(isObj)) {
        if (b['type'] !== 'tool_result') continue;
        const toolUseId = str(b['tool_use_id']);
        if (!toolUseId) continue;
        const s = started.get(toolUseId);
        out.push({
          type: 'tool.result',
          agentId,
          toolUseId,
          isError: b['is_error'] === true,
          content: resultText(b['content']).slice(0, 2000),
          ...(at !== undefined ? { at } : {}),
          ...(at !== undefined && s !== undefined ? { durationMs: Math.max(0, at - s) } : {}),
        });
      }
    }
  }
  if (out.length <= MAX_EVENTS) return out;
  // длинный агент — хвост (как у живого стора, который держит последние строки), модель — из начала
  const head = out[0]?.type === 'usage.message' ? [out[0]] : [];
  return [...head, ...out.slice(-MAX_EVENTS)];
}

const RESULT_LINES = 30;
const RESULT_CHARS = 3000;

function clip(text: string, t: ReturnType<typeof hostStrings>): string {
  const lines = text.split('\n');
  let out = lines.slice(0, RESULT_LINES).join('\n');
  if (out.length > RESULT_CHARS) out = out.slice(0, RESULT_CHARS);
  const cut = out.length < text.length;
  return cut ? `${out}\n${t.agentClipped(text.length)}` : out;
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '~~~~' : '```';
  return `${ticks}\n${text}\n${ticks}`;
}

/**
 * Транскрипт субагента → Markdown для документа «только для чтения»: промпт, по порядку его
 * рассуждение, текст, вызовы с входом и (обрезанными) результатами.
 */
export function subagentMarkdown(
  records: readonly Json[],
  meta: { title: string; agentType?: string; lang?: Lang },
): string {
  const t = hostStrings(meta.lang ?? 'ru');
  const parts: string[] = [`# ${meta.title}${meta.agentType ? ` · ${meta.agentType}` : ''}`, ''];
  parts.push(t.agentReadOnly, '');
  let prompted = false;
  for (const rec of records) {
    const msg = obj(rec['message']);
    if (!msg) continue;
    const content = msg['content'];
    if (rec['type'] === 'user') {
      if (typeof content === 'string') {
        parts.push(prompted ? t.agentMessage : t.agentPrompt, '', content, '');
        prompted = true;
        continue;
      }
      for (const b of arr(content).filter(isObj)) {
        if (b['type'] === 'tool_result') {
          const text = resultText(b['content']);
          parts.push(
            b['is_error'] === true ? t.agentError : t.agentResult,
            '',
            fence(clip(text, t)),
            '',
          );
        } else if (b['type'] === 'text') {
          parts.push(
            prompted ? t.agentMessage : t.agentPrompt,
            '',
            str(b['text']) ?? '',
            '',
          );
          prompted = true;
        }
      }
      continue;
    }
    for (const b of arr(content).filter(isObj)) {
      if (b['type'] === 'text') parts.push(str(b['text']) ?? '', '');
      else if (b['type'] === 'thinking' && str(b['thinking'])) {
        const th = (str(b['thinking']) ?? '').replace(/\s+/g, ' ').trim();
        parts.push(`> ${t.agentThinking} ${th.length > 400 ? `${th.slice(0, 400)}…` : th}`, '');
      } else if (b['type'] === 'tool_use') {
        const input = JSON.stringify(obj(b['input']) ?? {});
        parts.push(
          `**${str(b['name']) ?? 'tool'}** \`${input.length > 300 ? `${input.slice(0, 300)}…` : input}\``,
          '',
        );
      }
    }
  }
  return parts.join('\n');
}

/** `<файл>.meta.json` рядом с транскриптом субагента: тип и описание. */
export async function readSubagentMeta(
  file: string,
): Promise<{ agentType?: string; description?: string }> {
  try {
    const meta: unknown = JSON.parse(
      await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
    );
    if (!isObj(meta)) return {};
    const agentType = str(meta['agentType']);
    const description = str(meta['description']);
    return { ...(agentType ? { agentType } : {}), ...(description ? { description } : {}) };
  } catch {
    return {};
  }
}

/** Сколько последних субагентов истории дополнять их ходом из `subagents/` (каждый — файл на диске). */
const MAX_SUBAGENT_TIMELINES = 30;

/**
 * Ход субагентов для восстановленной истории: события из их транскриптов (`<сессия>/subagents/`)
 * сразу после `agent.start` — карта агентов показывает его так же, как у живого. Нет файла — без хода.
 */
export async function withSubagentTimelines(
  events: AgentEvent[],
  dir: string,
  warn?: (message: string) => void,
): Promise<void> {
  const starts = events
    .map((e, i) => ({ e, i }))
    .filter(
      (x): x is { e: Extract<AgentEvent, { type: 'agent.start' }>; i: number } =>
        x.e.type === 'agent.start' && x.e.taskType === 'local_agent',
    )
    .slice(-MAX_SUBAGENT_TIMELINES);
  // с конца — вставки не сдвигают ещё не обработанные индексы
  for (const { e, i } of starts.reverse()) {
    try {
      const file = await subagentFile(dir, e.taskId);
      if (!file) continue;
      events.splice(i + 1, 0, ...subagentEvents(await readSubagentRecords(file), e.agentId));
    } catch (error) {
      warn?.(`транскрипт субагента ${e.taskId}: ${String(error)}`);
    }
  }
}
