import type { AgentEvent, FileRef, ImageRef } from '../types';
import { arr, isObj, obj, str, timestamp, type Json } from './json';
import { ClaudeEventMapper } from './mapper';
import { optionsFromProbe, PermissionBroker, type ToolPermissionResult } from './permissions';

/**
 * Прогон лога пробы (`spikes/sdk-probe/logs/*.jsonl`) через маппер и брокер разрешений — тот же
 * путь, что у живой сессии, только сообщения SDK берутся из файла, а ответы пользователя —
 * из строк пробы `canUseTool_result`. Нужен тестам и скрипту генерации ожиданий.
 */
export interface ReplayResult {
  events: AgentEvent[];
  /** Что брокер вернул движку на каждый `canUseTool`, по порядку. */
  permissionResults: { toolUseId: string; result: ToolPermissionResult }[];
}

/**
 * База стоимости для логов возобновлённых сессий: `total_cost_usd` до resume.
 * 08-sessions-resume продолжает сессию 01-basic-control — значение из `08-sessions-list:15`.
 */
export const PROBE_BASELINES: Readonly<Record<string, number>> = {
  '08-sessions-resume': 0.07249180000000001,
};

export async function replayProbeLog(lines: unknown[], baselineCostUsd = 0): Promise<ReplayResult> {
  let clock = 0;
  const events: AgentEvent[] = [];
  const mapper = new ClaudeEventMapper({ now: () => clock, baselineCostUsd });
  const broker = new PermissionBroker(
    (e) => events.push(e),
    (id) => mapper.agentIdForTask(id),
  );
  const permissionResults: ReplayResult['permissionResults'] = [];
  const waits: Promise<void>[] = [];

  for (const line of lines) {
    if (!isObj(line)) continue;
    const ts = timestamp(line['timestamp']);
    if (ts !== undefined) clock = ts;
    if (line['type'] !== 'probe') {
      events.push(...mapper.map(line));
      continue;
    }
    switch (line['kind']) {
      case 'send':
        // `uuid` пишет agents-smoke (живой движок отвечает эхом uuid); у логов пробы его нет — по очереди
        // `images` пишет image-smoke (этап 4 roadmap 0.2): картинки сообщения → `turn.start.images`;
        // `files` — attach-smoke (этап 8): файлы → `turn.start.files`
        mapper.notePrompt(
          str(line['text']) ?? '',
          str(line['uuid']),
          arr(line['images']).filter(isObj) as ImageRef[],
          arr(line['files']).filter(isObj) as unknown as FileRef[],
        );
        break;
      case 'canUseTool': {
        const options = optionsFromProbe(line['options']);
        const toolUseId = options.toolUseID ?? '';
        waits.push(
          broker
            .canUseTool(str(line['toolName']) ?? '', obj(line['input']) ?? {}, options)
            .then((result) => void permissionResults.push({ toolUseId, result })),
        );
        break;
      }
      case 'canUseTool_result':
        answer(broker, line);
        break;
      case 'control':
        if (line['method'] === 'getContextUsage' && line['ok'] === true) {
          const event = mapper.contextFromEngine(line['result']);
          if (event) events.push(event);
        }
        break;
      default:
        break;
    }
  }
  broker.cancelAll();
  await Promise.all(waits);
  return { events, permissionResults };
}

/** Строка `canUseTool_result` пробы → вызов того же API, которым отвечает интерфейс. */
function answer(broker: PermissionBroker, line: Json): void {
  const toolUseId = str(line['toolUseID']) ?? '';
  const toolName = str(line['toolName']);
  const result = obj(line['result']) ?? {};
  const allow = result['behavior'] === 'allow';
  const message = str(result['message']) ?? '';
  const updated = obj(result['updatedInput']) ?? {};
  const perms = arr(result['updatedPermissions']).filter(isObj);

  if (toolName === 'AskUserQuestion' && allow) {
    const answers = obj(updated['answers']) ?? {};
    broker.answerQuestion(
      toolUseId,
      Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v)])),
    );
  } else if (toolName === 'ExitPlanMode') {
    const setMode = perms.find((p) => p['type'] === 'setMode');
    const mode = setMode?.['mode'];
    broker.decidePlan(
      toolUseId,
      allow
        ? { approve: true, ...(mode === 'acceptEdits' || mode === 'default' ? { mode } : {}) }
        : { approve: false, feedback: message },
    );
  } else {
    broker.respondPermission(
      toolUseId,
      allow ? (perms.length > 0 ? 'allow-always' : 'allow') : 'deny',
      message,
    );
  }
}

// ——— проекция для файлов ожиданий ———

const MAX_STRING = 160;
const MAX_LIST = 8;

/**
 * Событие → компактный вид для `*.expected.json`: подряд идущие `text.delta` / `thinking.delta`
 * одного сообщения склеены, длинные строки и списки обрезаны с пометкой длины. Проекция
 * детерминированная — сравнение по ней ловит любые изменения маппинга, а файл читается глазами.
 */
export function projectEvents(events: AgentEvent[]): unknown[] {
  const out: Json[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (
      prev &&
      (event.type === 'text.delta' || event.type === 'thinking.delta') &&
      prev['type'] === event.type &&
      prev['messageId'] === event.messageId &&
      prev['agentId'] === event.agentId
    ) {
      prev['text'] = String(prev['text']) + event.text;
      prev['chunks'] = Number(prev['chunks'] ?? 1) + 1;
      if (event.type === 'thinking.delta' && event.estimatedTokens !== undefined) {
        prev['estimatedTokens'] = event.estimatedTokens;
      }
      continue;
    }
    out.push({ ...(event as unknown as Json) });
  }
  for (const e of out) {
    if (
      (e['type'] === 'text.delta' || e['type'] === 'thinking.delta') &&
      typeof e['text'] === 'string'
    ) {
      e['length'] = e['text'].length;
    }
  }
  return out.map((e) => shrink(e));
}

function shrink(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, 100)}…[${value.length}]` : value;
  }
  if (Array.isArray(value)) {
    const items = value.length > MAX_LIST ? [...value.slice(0, 5), `…+${value.length - 5}`] : value;
    return items.map(shrink);
  }
  if (isObj(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]));
  return value;
}
