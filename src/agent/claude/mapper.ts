import type { AgentEvent, AgentEventOf, LimitWindow, PermissionMode, TokenUsage } from '../types';
import { arr, isObj, num, obj, str, strings, timestamp, type Json } from './json';

/**
 * Сообщения Claude Agent SDK → `AgentEvent`. Чистое состояние без ввода-вывода: адаптер кормит
 * его живым потоком, тесты — логами пробы (`spikes/sdk-probe/logs`).
 *
 * Факты SDK, на которых стоит разбор (docs/spikes/sdk-probe.md):
 * - `system/init` приходит перед каждым ходом, в том числе ходом-пробуждением после фоновой задачи;
 * - одно API-сообщение — несколько `assistant` с одним `message.id` (по блоку), usage в них одинаковый,
 *   `output_tokens` — плейсхолдер; настоящий вывод — в `stream_event` `message_delta`;
 * - `stream_event` приходят только от основного агента; сообщения субагента помечены
 *   `parent_tool_use_id` и могут прийти после `result` хода, который его запустил;
 * - `total_cost_usd` и `modelUsage` в `result` нарастающие за сессию, `usage` — за ход.
 */
export interface MapperOptions {
  /** Часы для `at` событий без собственного времени (`turn.start`, `thinking.*`). */
  now?: () => number;
  /** Последний известный `total_cost_usd` (resume). Для новой сессии — 0. */
  baselineCostUsd?: number;
}

interface PendingUsage {
  model: string;
  usage: TokenUsage;
  at?: number;
  agentId?: string;
}

const PERMISSION_MODES: ReadonlySet<string> = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]);

export class ClaudeEventMapper {
  private readonly now: () => number;
  private turnActive = false;
  /** Отправленные тексты, ещё не привязанные к ходу. `uuid` — наш `SDKUserMessage.uuid`. */
  private readonly prompts: { text: string; uuid?: string }[] = [];
  /** `init` / `requesting` открыли ход, `turn.start` ждёт первого сообщения с эхом `user_message_uuid`. */
  private turnStartPending = false;
  /** Между ходами закончилась фоновая задача — следующий ход, скорее всего, пробуждение движка. */
  private wakeExpected = false;
  /** Промпт, приписанный ходу по очереди (без эха): вернуть, если ход окажется пробуждением. */
  private fifoPrompt: { text: string; uuid?: string } | undefined;
  private lastInitKey: string | undefined;
  private mode: PermissionMode | undefined;
  private model: string | undefined;
  private sessionIdValue: string | undefined;

  /** Потоковые ответы основного агента: id → usage из `message_start`, пока не пришёл `message_delta`. */
  private readonly streaming = new Map<string, PendingUsage>();
  private readonly streamedIds = new Set<string>();
  private readonly usageEmitted = new Set<string>();
  private currentMessageId: string | undefined;
  private readonly blocks = new Map<number, string>();
  private thinkingEstimate: number | undefined;

  private readonly toolStartedAt = new Map<string, number | undefined>();
  private readonly toolsStarted = new Set<string>();
  /** Вызов инструмента → субагент, который его сделал (для задач, запущенных субагентом). */
  private readonly toolOwner = new Map<string, string>();
  private readonly taskToAgent = new Map<string, string>();

  private turnUsage: TokenUsage = emptyUsage();
  private lastTotalCost: number | undefined;
  private readonly contextWindows = new Map<string, number>();

  constructor(options: MapperOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lastTotalCost = options.baselineCostUsd;
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  get permissionMode(): PermissionMode | undefined {
    return this.mode;
  }

  get currentModel(): string | undefined {
    return this.model;
  }

  get inTurn(): boolean {
    return this.turnActive;
  }

  contextWindow(model = this.model): number | undefined {
    return model ? this.contextWindows.get(model) : undefined;
  }

  /** Текст, отправленный движку: станет `prompt` ближайшего `turn.start`. */
  notePrompt(text: string, uuid?: string): void {
    this.prompts.push(uuid !== undefined ? { text, uuid } : { text });
  }

  /** `agentID` из `canUseTool` (id задачи) → id субагента в событиях (id вызова `Agent`). */
  agentIdForTask(taskId: string | undefined): string | undefined {
    if (taskId === undefined) return undefined;
    return this.taskToAgent.get(taskId) ?? taskId;
  }

  /** Режим сменили вызовом `setPermissionMode` — подтверждение придёт `system/status`. */
  map(message: unknown): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (!isObj(message)) return out;
    switch (message['type']) {
      case 'system':
        this.system(message, out);
        break;
      case 'stream_event':
        this.streamEvent(message, out);
        break;
      case 'assistant':
        this.assistant(message, out);
        break;
      case 'user':
        this.user(message, out);
        break;
      case 'result':
        this.result(message, out);
        break;
      case 'rate_limit_event': {
        const info = obj(message['rate_limit_info']);
        if (info) out.push(limitEvent(info));
        break;
      }
      case 'tool_progress': {
        const toolUseId = str(message['tool_use_id']);
        if (toolUseId) {
          out.push({
            type: 'tool.progress',
            ...this.agentOf(message),
            toolUseId,
            name: str(message['tool_name']) ?? '',
            elapsedMs: Math.round((num(message['elapsed_time_seconds']) ?? 0) * 1000),
          });
        }
        break;
      }
      case 'auth_status': {
        const error = str(message['error']);
        if (error) out.push({ type: 'error', message: error, fatal: false, code: 'auth' });
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** Ответ `getContextUsage()` → событие. */
  contextFromEngine(raw: unknown): AgentEventOf<'context.usage'> | undefined {
    const r = obj(raw);
    const used = num(r?.['totalTokens']);
    if (!r || used === undefined) return undefined;
    const event: AgentEventOf<'context.usage'> = {
      type: 'context.usage',
      usedTokens: used,
      source: 'engine',
    };
    const max = num(r['maxTokens']);
    if (max !== undefined) event.maxTokens = max;
    const pct = num(r['percentage']);
    if (pct !== undefined) event.percentage = pct;
    const threshold = num(r['autoCompactThreshold']);
    if (threshold !== undefined) event.autoCompactThreshold = threshold;
    const categories = arr(r['categories'])
      .filter(isObj)
      .map((c) => ({
        name: str(c['name']) ?? '',
        tokens: num(c['tokens']) ?? 0,
        kind: str(c['kind']) ?? 'used',
      }));
    if (categories.length > 0) event.categories = categories;
    const model = str(r['model']);
    if (model && max !== undefined) this.contextWindows.set(model, max);
    return event;
  }

  // ——— system ———

  private system(m: Json, out: AgentEvent[]): void {
    switch (m['subtype']) {
      case 'init':
        this.init(m, out);
        break;
      case 'status': {
        const status = m['status'];
        if (status === 'compacting') {
          this.ensureTurn(out, m);
          out.push({ type: 'compaction.start' });
        } else if (status === 'requesting') {
          this.openTurn();
        }
        if (m['compact_result'] === 'failed') {
          const error = str(m['compact_error']);
          out.push({ type: 'compaction.end', ok: false, ...(error ? { error } : {}) });
        }
        const mode = permissionMode(m['permissionMode']);
        if (mode && mode !== this.mode) {
          this.mode = mode;
          out.push({ type: 'mode.changed', mode });
        }
        break;
      }
      case 'compact_boundary': {
        const meta = obj(m['compact_metadata']) ?? {};
        const event: AgentEventOf<'compaction.end'> = { type: 'compaction.end', ok: true };
        const trigger = meta['trigger'];
        if (trigger === 'manual' || trigger === 'auto') event.trigger = trigger;
        const pre = num(meta['pre_tokens']);
        if (pre !== undefined) event.preTokens = pre;
        const post = num(meta['post_tokens']);
        if (post !== undefined) event.postTokens = post;
        const duration = num(meta['duration_ms']);
        if (duration !== undefined) event.durationMs = duration;
        out.push(event);
        break;
      }
      case 'session_title_changed': {
        const title = str(m['title']);
        if (title) out.push({ type: 'session.title', title });
        break;
      }
      case 'thinking_tokens':
        this.thinkingEstimate = num(m['estimated_tokens']) ?? this.thinkingEstimate;
        break;
      case 'task_started': {
        const taskId = str(m['task_id']);
        if (!taskId) break;
        const agentId = str(m['tool_use_id']) ?? taskId;
        this.taskToAgent.set(taskId, agentId);
        const event: AgentEventOf<'agent.start'> = {
          type: 'agent.start',
          agentId,
          taskId,
          description: str(m['description']) ?? '',
          taskType: str(m['task_type']) ?? 'unknown',
          background: m['is_backgrounded'] === true,
        };
        const subagentType = str(m['subagent_type']);
        if (subagentType) event.subagentType = subagentType;
        const prompt = str(m['prompt']);
        if (prompt) event.prompt = prompt;
        const parent = this.toolOwner.get(agentId);
        if (parent !== undefined) event.parentAgentId = parent;
        out.push(event);
        break;
      }
      case 'task_progress': {
        const taskId = str(m['task_id']);
        if (!taskId) break;
        const usage = obj(m['usage']) ?? {};
        const event: AgentEventOf<'agent.progress'> = {
          type: 'agent.progress',
          agentId: this.agentForTask(taskId, m),
          taskId,
        };
        const description = str(m['description']);
        if (description) event.description = description;
        const lastTool = str(m['last_tool_name']);
        if (lastTool) event.lastToolName = lastTool;
        assignUsage(event, usage);
        out.push(event);
        break;
      }
      case 'task_updated': {
        const taskId = str(m['task_id']);
        const patch = obj(m['patch']);
        const status = str(patch?.['status']);
        if (!taskId || !status) break;
        out.push({ type: 'agent.progress', agentId: this.agentForTask(taskId, m), taskId, status });
        break;
      }
      case 'task_notification': {
        const taskId = str(m['task_id']);
        if (!taskId) break;
        const status =
          m['status'] === 'failed' || m['status'] === 'stopped' ? m['status'] : 'completed';
        const event: AgentEventOf<'agent.end'> = {
          type: 'agent.end',
          agentId: this.agentForTask(taskId, m),
          taskId,
          status,
        };
        const summary = str(m['summary']);
        if (summary) event.summary = summary;
        assignUsage(event, obj(m['usage']) ?? {});
        out.push(event);
        if (!this.turnActive || this.turnStartPending) this.wakeExpected = true;
        break;
      }
      case 'api_retry': {
        const attempt = num(m['attempt']) ?? 0;
        const max = num(m['max_retries']) ?? 0;
        const status = num(m['error_status']);
        out.push({
          type: 'error',
          fatal: false,
          code: 'api_retry',
          message: `Повтор запроса к API ${attempt}/${max}${status ? ` (HTTP ${status})` : ''}`,
        });
        break;
      }
      default:
        break;
    }
  }

  private init(m: Json, out: AgentEvent[]): void {
    const sessionId = str(m['session_id']) ?? '';
    const model = str(m['model']) ?? '';
    const mode = permissionMode(m['permissionMode']) ?? 'default';
    this.sessionIdValue = sessionId || this.sessionIdValue;
    this.model = model || this.model;
    const key = `${sessionId}|${model}|${mode}`;
    if (key !== this.lastInitKey) {
      this.lastInitKey = key;
      out.push({
        type: 'session.init',
        sessionId,
        model,
        cwd: str(m['cwd']) ?? '',
        permissionMode: mode,
        tools: strings(m['tools']),
        slashCommands: strings(m['slash_commands']),
        skills: strings(m['skills']),
        agents: strings(m['agents']),
        apiKeySource: str(m['apiKeySource']) ?? '',
        engineVersion: str(m['claude_code_version']) ?? '',
      });
    }
    this.mode = mode;
    this.openTurn();
  }

  // ——— поток основного агента ———

  private streamEvent(m: Json, out: AgentEvent[]): void {
    const e = obj(m['event']);
    if (!e) return;
    if (m['parent_tool_use_id']) return; // субагенты без потока; на всякий случай не смешиваем
    this.ensureTurn(out, m);
    switch (e['type']) {
      case 'message_start': {
        const msg = obj(e['message']) ?? {};
        const id = str(msg['id']);
        if (!id) return;
        this.currentMessageId = id;
        this.blocks.clear();
        this.streamedIds.add(id);
        const model = str(msg['model']) ?? this.model ?? '';
        this.streaming.set(id, { model, usage: usageFrom(obj(msg['usage'])) });
        break;
      }
      case 'content_block_start': {
        const index = num(e['index']);
        const block = obj(e['content_block']);
        const type = str(block?.['type']);
        if (index === undefined || !type || !this.currentMessageId) return;
        this.blocks.set(index, type);
        if (type === 'thinking') {
          this.thinkingEstimate = undefined;
          out.push({ type: 'thinking.start', messageId: this.currentMessageId, at: this.now() });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = obj(e['delta']);
        const messageId = this.currentMessageId;
        if (!delta || !messageId) return;
        if (delta['type'] === 'text_delta') {
          const text = str(delta['text']);
          if (text) out.push({ type: 'text.delta', messageId, text });
        } else if (delta['type'] === 'thinking_delta') {
          const text = str(delta['thinking']);
          if (text) {
            out.push({
              type: 'thinking.delta',
              messageId,
              text,
              ...(this.thinkingEstimate !== undefined
                ? { estimatedTokens: this.thinkingEstimate }
                : {}),
            });
          }
        }
        break;
      }
      case 'content_block_stop': {
        const index = num(e['index']);
        if (index === undefined || !this.currentMessageId) return;
        if (this.blocks.get(index) === 'thinking') {
          out.push({
            type: 'thinking.stop',
            messageId: this.currentMessageId,
            at: this.now(),
            ...(this.thinkingEstimate !== undefined
              ? { estimatedTokens: this.thinkingEstimate }
              : {}),
          });
        }
        this.blocks.delete(index);
        break;
      }
      case 'message_delta': {
        const id = this.currentMessageId;
        const pending = id ? this.streaming.get(id) : undefined;
        if (!id || !pending) return;
        const final = usageFrom(obj(e['usage']));
        // В `message_delta` нет разбивки записи кэша по TTL — она из `message_start`.
        const usage: TokenUsage = {
          ...final,
          ...(pending.usage.cacheWrite5m !== undefined
            ? { cacheWrite5m: pending.usage.cacheWrite5m }
            : {}),
          ...(pending.usage.cacheWrite1h !== undefined
            ? { cacheWrite1h: pending.usage.cacheWrite1h }
            : {}),
        };
        this.streaming.delete(id);
        this.emitUsage(id, { ...pending, usage }, true, out);
        break;
      }
      default:
        break;
    }
  }

  // ——— assistant / user ———

  private assistant(m: Json, out: AgentEvent[]): void {
    const msg = obj(m['message']);
    if (!msg) return;
    const agent = this.agentOf(m);
    const isMain = agent.agentId === undefined;
    if (isMain) this.ensureTurn(out, m);
    const id = str(msg['id']) ?? '';
    const model = str(msg['model']) ?? '';
    const at = timestamp(m['timestamp']);
    // Синтетическое сообщение движка (ошибка API, «лимит исчерпан», вывод локальной команды):
    // не ответ модели — ни usage, ни смены модели и окна.
    if (model === SYNTHETIC_MODEL || str(m['error']) !== undefined) {
      this.synthetic(m, msg, agent, out);
      return;
    }
    if (isMain && model) this.model = model;

    const streamed = this.streamedIds.has(id);
    if (streamed) {
      const pending = this.streaming.get(id);
      if (pending && pending.at === undefined && at !== undefined) pending.at = at;
    } else if (id && !this.usageEmitted.has(id)) {
      this.emitUsage(
        id,
        {
          model,
          usage: usageFrom(obj(msg['usage'])),
          ...(at !== undefined ? { at } : {}),
          ...agent,
        },
        false,
        out,
      );
    }

    for (const block of arr(msg['content'])) {
      if (!isObj(block)) continue;
      const type = block['type'];
      if (type === 'tool_use') {
        const toolUseId = str(block['id']);
        if (!toolUseId || this.toolsStarted.has(toolUseId)) continue;
        this.toolsStarted.add(toolUseId);
        this.toolStartedAt.set(toolUseId, at);
        if (agent.agentId !== undefined) this.toolOwner.set(toolUseId, agent.agentId);
        out.push({
          type: 'tool.start',
          ...agent,
          toolUseId,
          name: str(block['name']) ?? '',
          input: obj(block['input']) ?? {},
          ...(at !== undefined ? { at } : {}),
        });
      } else if (!streamed && type === 'text') {
        const text = str(block['text']);
        if (text) out.push({ type: 'text.delta', ...agent, messageId: id, text });
      } else if (!streamed && type === 'thinking') {
        const text = str(block['thinking']);
        if (!text) continue;
        const t = at ?? this.now();
        out.push({ type: 'thinking.start', ...agent, messageId: id, at: t });
        out.push({ type: 'thinking.delta', ...agent, messageId: id, text });
        out.push({ type: 'thinking.stop', ...agent, messageId: id, at: t });
      }
    }
  }

  private synthetic(m: Json, msg: Json, agent: { agentId?: string }, out: AgentEvent[]): void {
    const text = arr(msg['content'])
      .filter(isObj)
      .map((b) => (b['type'] === 'text' ? (str(b['text']) ?? '') : ''))
      .join('\n')
      .trim();
    const error = str(m['error']);
    if (error === undefined) {
      if (text) out.push({ type: 'text.delta', ...agent, messageId: str(msg['id']) ?? '', text });
      return;
    }
    const limit = error === 'rate_limit' || LIMIT_TEXT.test(text);
    out.push({
      type: 'error',
      ...agent,
      fatal: false,
      code: limit ? 'limit' : error,
      message: text || error,
    });
  }

  private user(m: Json, out: AgentEvent[]): void {
    const msg = obj(m['message']);
    const content = msg?.['content'];
    if (!Array.isArray(content)) return; // текст: сводка компакции, «[Request interrupted…]», эхо команд
    const results = content.filter((b): b is Json => isObj(b) && b['type'] === 'tool_result');
    const at = timestamp(m['timestamp']);
    const agent = this.agentOf(m);
    for (const block of results) {
      const toolUseId = str(block['tool_use_id']);
      if (!toolUseId) continue;
      const started = this.toolStartedAt.get(toolUseId);
      const event: AgentEventOf<'tool.result'> = {
        type: 'tool.result',
        ...agent,
        toolUseId,
        isError: block['is_error'] === true,
        content: resultText(block['content']),
      };
      if (results.length === 1 && m['tool_use_result'] !== undefined)
        event.result = m['tool_use_result'];
      if (at !== undefined) {
        event.at = at;
        if (started !== undefined) event.durationMs = Math.max(0, at - started);
      }
      out.push(event);
    }
  }

  // ——— result ———

  private result(m: Json, out: AgentEvent[]): void {
    // Оборванные ответы (прерывание): `message_delta` не придёт — отдаём usage с плейсхолдером вывода.
    for (const [id, pending] of this.streaming) this.emitUsage(id, pending, false, out);
    this.streaming.clear();
    // Прерывание посреди рассуждения: `content_block_stop` не придёт — закрываем сами.
    if (this.currentMessageId) {
      for (const type of this.blocks.values()) {
        if (type !== 'thinking') continue;
        out.push({
          type: 'thinking.stop',
          messageId: this.currentMessageId,
          at: this.now(),
          ...(this.thinkingEstimate !== undefined
            ? { estimatedTokens: this.thinkingEstimate }
            : {}),
        });
      }
    }
    this.currentMessageId = undefined;
    this.blocks.clear();

    const subtype = str(m['subtype']) ?? 'unknown';
    const terminal = str(m['terminal_reason']);
    const interrupted = terminal === 'aborted_streaming' || terminal === 'aborted_tools';
    const total = num(m['total_cost_usd']) ?? 0;
    const modelUsage = obj(m['modelUsage']) ?? {};
    for (const [model, u] of Object.entries(modelUsage)) {
      if (model === SYNTHETIC_MODEL) continue;
      const window = num(obj(u)?.['contextWindow']);
      if (window !== undefined) this.contextWindows.set(model, window);
    }

    let usage = usageFrom(obj(m['usage']));
    if (interrupted && isZero(usage)) usage = this.turnUsage;

    const event: AgentEventOf<'turn.result'> = {
      type: 'turn.result',
      ok: m['is_error'] !== true,
      subtype,
      interrupted,
      durationMs: num(m['duration_ms']) ?? 0,
      apiDurationMs: num(m['duration_api_ms']) ?? 0,
      numTurns: num(m['num_turns']) ?? 0,
      usage,
      totalCostUsd: total,
      permissionDenials: arr(m['permission_denials'])
        .filter(isObj)
        .map((d) => ({
          toolName: str(d['tool_name']) ?? '',
          toolUseId: str(d['tool_use_id']) ?? '',
        })),
    };
    if (this.lastTotalCost !== undefined)
      event.costUsd = round6(Math.max(0, total - this.lastTotalCost));
    const model = this.model ?? Object.keys(modelUsage)[0];
    if (model) {
      event.model = model;
      const window = this.contextWindows.get(model);
      if (window !== undefined) event.contextWindow = window;
    }
    const stop = str(m['stop_reason']);
    if (stop) event.stopReason = stop;
    if (terminal) event.terminalReason = terminal;
    const origin = str(obj(m['origin'])?.['kind']);
    if (origin) event.origin = origin;
    this.ensureTurn(out, m);
    // Ход оказался пробуждением, а промпт ему достался по очереди — вернуть промпт следующему ходу.
    if (origin === 'task-notification' && this.fifoPrompt) this.prompts.unshift(this.fifoPrompt);
    this.fifoPrompt = undefined;
    const errors = strings(m['errors']);
    if (errors.length > 0) event.errors = errors;
    const text = str(m['result']);
    if (text) event.text = text;

    out.push(event);
    this.lastTotalCost = total;
    this.turnActive = false;
    this.turnUsage = emptyUsage();
  }

  // ——— помощники ———

  /** `init` и `status: requesting` открывают ход, но эха `user_message_uuid` в них нет — ждём его. */
  private openTurn(): void {
    if (this.turnActive) return;
    this.turnActive = true;
    this.turnStartPending = true;
    this.turnUsage = emptyUsage();
  }

  /**
   * Первое сообщение хода с содержимым: выдать `turn.start`. Промпт — по эху `user_message_uuid(s)`
   * (адаптер шлёт свои uuid); без эха (старый CLI, логи пробы) — по очереди отправленного, но не
   * ходу, который похож на пробуждение после фоновой задачи. Эхо посреди хода — сообщение,
   * которое движок влил в текущий ход: снимаем его с очереди.
   */
  private ensureTurn(out: AgentEvent[], m: Json): void {
    const uuids = uuidsOf(m);
    if (this.turnActive && !this.turnStartPending) {
      for (const uuid of uuids) {
        const text = this.takePrompt(uuid);
        if (text !== undefined) out.push({ type: 'turn.input', prompt: text, at: this.now() });
      }
      return;
    }
    if (!this.turnActive) this.turnUsage = emptyUsage();
    this.turnActive = true;
    this.turnStartPending = false;
    let prompt: string | undefined;
    let prompts: string[] | undefined;
    if (uuids.length > 0) {
      const texts = uuids
        .map((u) => this.takePrompt(u))
        .filter((t): t is string => t !== undefined);
      if (texts.length > 0) prompt = texts.join('\n\n');
      if (texts.length > 1) prompts = texts;
    } else if (!this.wakeExpected) {
      this.fifoPrompt = this.prompts.shift();
      prompt = this.fifoPrompt?.text;
    }
    this.wakeExpected = false;
    out.push({
      type: 'turn.start',
      ...(prompt !== undefined ? { prompt } : {}),
      ...(prompts ? { prompts } : {}),
      at: this.now(),
    });
  }

  private takePrompt(uuid: string): string | undefined {
    const i = this.prompts.findIndex((p) => p.uuid === uuid);
    if (i < 0) return undefined;
    return this.prompts.splice(i, 1)[0]?.text;
  }

  private emitUsage(id: string, p: PendingUsage, final: boolean, out: AgentEvent[]): void {
    if (this.usageEmitted.has(id)) return;
    this.usageEmitted.add(id);
    out.push({
      type: 'usage.message',
      ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
      messageId: id,
      model: p.model,
      usage: p.usage,
      final,
      ...(p.at !== undefined ? { at: p.at } : {}),
    });
    if (p.agentId !== undefined) return;
    addUsage(this.turnUsage, p.usage);
    const used = p.usage.input + p.usage.cacheRead + p.usage.cacheWrite;
    const max = this.contextWindows.get(p.model);
    out.push({
      type: 'context.usage',
      usedTokens: used,
      source: 'usage',
      ...(max !== undefined ? { maxTokens: max } : {}),
    });
  }

  private agentOf(m: Json): { agentId?: string } {
    const parent = str(m['parent_tool_use_id']);
    return parent ? { agentId: parent } : {};
  }

  private agentForTask(taskId: string, m: Json): string {
    return this.taskToAgent.get(taskId) ?? str(m['tool_use_id']) ?? taskId;
  }
}

// ——— чистые функции ———

const SYNTHETIC_MODEL = '<synthetic>';
const LIMIT_TEXT = /usage limit|limit reached|rate limit|лимит/i;

/** Эхо наших `SDKUserMessage.uuid` на сообщениях хода. */
function uuidsOf(m: Json): string[] {
  const list = strings(m['user_message_uuids']);
  if (list.length > 0) return list;
  const one = str(m['user_message_uuid']);
  return one ? [one] : [];
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** usage API (`input_tokens`, `cache_*`) → `TokenUsage`. */
export function usageFrom(raw: Json | undefined): TokenUsage {
  if (!raw) return emptyUsage();
  const usage: TokenUsage = {
    input: num(raw['input_tokens']) ?? 0,
    output: num(raw['output_tokens']) ?? 0,
    cacheRead: num(raw['cache_read_input_tokens']) ?? 0,
    cacheWrite: num(raw['cache_creation_input_tokens']) ?? 0,
  };
  const creation = obj(raw['cache_creation']);
  const w5 = num(creation?.['ephemeral_5m_input_tokens']);
  const w1 = num(creation?.['ephemeral_1h_input_tokens']);
  if (w5 !== undefined) usage.cacheWrite5m = w5;
  if (w1 !== undefined) usage.cacheWrite1h = w1;
  const thinking = num(obj(raw['output_tokens_details'])?.['thinking_tokens']);
  if (thinking !== undefined) usage.thinking = thinking;
  return usage;
}

function addUsage(into: TokenUsage, u: TokenUsage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  if (u.cacheWrite5m !== undefined) into.cacheWrite5m = (into.cacheWrite5m ?? 0) + u.cacheWrite5m;
  if (u.cacheWrite1h !== undefined) into.cacheWrite1h = (into.cacheWrite1h ?? 0) + u.cacheWrite1h;
  if (u.thinking !== undefined) into.thinking = (into.thinking ?? 0) + u.thinking;
}

function isZero(u: TokenUsage): boolean {
  return u.input + u.output + u.cacheRead + u.cacheWrite === 0;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function permissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string' || !PERMISSION_MODES.has(value)) return undefined;
  // `dontAsk` и `auto` расширение не выставляет, но движок может в них быть — показываем как есть.
  return value as PermissionMode;
}

function assignUsage(
  event: { totalTokens?: number; toolUses?: number; durationMs?: number },
  usage: Json,
): void {
  const total = num(usage['total_tokens']);
  if (total !== undefined) event.totalTokens = total;
  const tools = num(usage['tool_uses']);
  if (tools !== undefined) event.toolUses = tools;
  const duration = num(usage['duration_ms']);
  if (duration !== undefined) event.durationMs = duration;
}

/** `tool_result.content`: строка или блоки (текст, картинки) → текст. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .filter(isObj)
    .map((b) => (b['type'] === 'text' ? (str(b['text']) ?? '') : `[${str(b['type']) ?? 'block'}]`))
    .join('\n');
}

/**
 * `rate_limit_event.rate_limit_info` → окна лимитов. Основной источник — недокументированное
 * `unifiedWindows` (оба окна, доля 0…1, сброс в секундах); без него — одно окно из
 * `rateLimitType` + `utilization`, если они есть.
 */
export function windowsFromRateLimit(info: Json): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const unified = obj(info['unifiedWindows']);
  const push = (kind: LimitWindow['kind'], raw: Json | undefined) => {
    const utilization = num(raw?.['utilization']);
    const resets = num(raw?.['resetsAt']);
    if (utilization === undefined || resets === undefined) return;
    windows.push({ kind, percent: Math.round(utilization * 1000) / 10, resetsAt: resets * 1000 });
  };
  if (unified) {
    push('five-hour', obj(unified['five_hour']));
    push('weekly', obj(unified['seven_day']));
  } else {
    const type = info['rateLimitType'];
    const kind = type === 'five_hour' ? 'five-hour' : type === 'seven_day' ? 'weekly' : undefined;
    if (kind) push(kind, info);
  }
  return windows;
}

function limitEvent(info: Json): AgentEventOf<'limit.update'> {
  const event: AgentEventOf<'limit.update'> = {
    type: 'limit.update',
    source: 'engine',
    windows: windowsFromRateLimit(info),
  };
  const status = info['status'];
  if (status === 'allowed' || status === 'allowed_warning' || status === 'rejected')
    event.status = status;
  const resets = num(info['resetsAt']);
  if (resets !== undefined) event.resetsAt = resets * 1000;
  return event;
}
