import type {
  AgentEvent,
  AgentEventOf,
  ImageRef,
  McpServerInfo,
  McpServerStatus,
  PromptImage,
  TokenUsage,
} from '../types';
import { CodexToolMapper } from './tools';
import type {
  CodexMcpServerStatus,
  CodexNotifications,
  FileUpdateChange,
  McpServerConnectionStatus,
  CollabAgentState,
  ThreadItem,
  ThreadSession,
  TokenUsageBreakdown,
  Turn,
  TurnError,
} from './protocol';

/** Промпт, который адаптер отдал `turn/start`: нужен `turn.start`, сам app-server текст не возвращает до `item/started`. */
export interface NotedPrompt {
  text: string;
  images?: readonly PromptImage[];
}

const ZERO: TokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Разность счётчиков; не уходит в минус (сброс `total` сервером) и терпит отсутствующее поле. */
function diff(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  const d = (x: number | undefined, y: number | undefined): number => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    totalTokens: d(a.totalTokens, b.totalTokens),
    inputTokens: d(a.inputTokens, b.inputTokens),
    cachedInputTokens: d(a.cachedInputTokens, b.cachedInputTokens),
    cacheWriteInputTokens: d(a.cacheWriteInputTokens, b.cacheWriteInputTokens),
    outputTokens: d(a.outputTokens, b.outputTokens),
    reasoningOutputTokens: d(a.reasoningOutputTokens, b.reasoningOutputTokens),
  };
}
function add(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

/**
 * У Codex `inputTokens` включает кэш (`cachedInputTokens` и запись в кэш — его части), у Agentura
 * `input` — только некэшированный ввод, как у Anthropic.
 */
export function tokenUsageOf(b: TokenUsageBreakdown): TokenUsage {
  const usage: TokenUsage = {
    input: Math.max(0, b.inputTokens - b.cachedInputTokens - b.cacheWriteInputTokens),
    output: b.outputTokens,
    cacheRead: b.cachedInputTokens,
    cacheWrite: b.cacheWriteInputTokens,
  };
  if (b.reasoningOutputTokens > 0) usage.thinking = b.reasoningOutputTokens;
  return usage;
}

function imageRef(image: PromptImage): ImageRef {
  const ref: ImageRef = { mediaType: image.mediaType, data: image.data };
  if (image.width !== undefined) ref.width = image.width;
  if (image.height !== undefined) ref.height = image.height;
  if (image.name !== undefined) ref.name = image.name;
  return ref;
}

function errorCode(info: TurnError['codexErrorInfo']): string | undefined {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') return Object.keys(info)[0];
  return undefined;
}

/** Уведомления о запуске серверов, пришедшие, пока `mcpServerStatus/list` был в пути: имя → статус и ошибка. */
export type McpListing = Map<string, Pick<McpServerInfo, 'status' | 'error'>>;

/** `runtimeStatus` Codex → общий статус (roadmap 21, решение 1); `null` и неизвестное — `pending`. */
export function mcpRuntimeStatus(s: McpServerConnectionStatus | null | undefined): McpServerStatus {
  switch (s) {
    case 'connected':
      return 'connected';
    case 'authenticationRequired':
      return 'needs-auth';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'disabled':
      return 'disabled';
    default:
      return 'pending';
  }
}

/**
 * Notifications app-server → `AgentEvent`. Работает на один тред: `session.init` строится из ответа
 * `thread/start|resume`, `turn.start` — из `turn/started` и промпта, который адаптер объявил через
 * `notePrompt`. Всё, чего нет в таблице («Поправки к ТЗ» roadmap 15), игнорируется. Команды, правки
 * файлов, MCP и поиск — `tools.ts`, approval — `approvals.ts`.
 */
export class CodexEventMapper {
  threadId: string | undefined;
  /** Модель треда: из ответа `thread/start|resume`, сменить может только `setModel` адаптера. */
  private model: string | undefined;
  private readonly prompts: NotedPrompt[] = [];
  private turnId: string | undefined;
  /** Закрытые ходы: поздний `turn/completed` после принудительного закрытия не даёт второй `turn.result`. */
  private readonly finished = new Set<string>();
  private turnStartedAt = 0;
  /** Сообщения, по которым пришёл хотя бы один `delta` (иначе текст берём из `item/completed`). */
  private readonly streamed = new Set<string>();
  private readonly thinking = new Map<string, { lastIndex: number | undefined }>();
  private lastText = '';
  private finalText: string | undefined;
  private errorMessages: string[] = [];
  private prevTotal: TokenUsageBreakdown | undefined;
  private turnUsage: TokenUsageBreakdown = ZERO;
  private lastCall: TokenUsageBreakdown | undefined;
  private contextWindow: number | null = null;
  private readonly tools: CodexToolMapper;
  /** Метаданные дочерних тредов приходят в `spawnAgent`, а их жизнь — отдельными item. */
  private readonly subagents = new Map<string, { parentThreadId: string; prompt?: string; model?: string }>();
  private readonly startedSubagents = new Set<string>();
  private readonly endedSubagents = new Set<string>();
  /** MCP-серверы (roadmap 21): последний список; уведомление о запуске правит один сервер в нём. */
  private mcp: McpServerInfo[] = [];
  /** `mcpServerStatus/list` в пути (`mcpListStart`): уведомления, пришедшие до ответа. */
  private readonly mcpListings = new Set<McpListing>();

  constructor(private readonly now: () => number = Date.now) {
    this.tools = new CodexToolMapper(now);
  }

  /** Правки `fileChange`-элемента (`item/started`): превью в карточке подтверждения. */
  changesOf(itemId: string): FileUpdateChange[] | undefined {
    return this.tools.changesOf(itemId);
  }

  /** Идёт ли ход, по мнению маппера (между `turn/started` и `turn/completed`). */
  get activeTurnId(): string | undefined {
    return this.turnId;
  }

  notePrompt(prompt: NotedPrompt): void {
    this.prompts.push(prompt);
  }

  /** Промпт не ушёл (`turn/start` отклонён): убрать из очереди, чтобы не приклеить к чужому ходу. */
  dropPrompt(prompt: NotedPrompt): void {
    const i = this.prompts.indexOf(prompt);
    if (i >= 0) this.prompts.splice(i, 1);
  }

  init(session: ThreadSession, effort?: AgentEventOf<'session.init'>['effort']): AgentEventOf<'session.init'> {
    this.threadId = session.thread.id;
    this.model = session.model;
    const event: AgentEventOf<'session.init'> = {
      type: 'session.init',
      sessionId: session.thread.id,
      model: session.model,
      cwd: session.cwd,
      // approval Codex — не режимы Claude (ТЗ §4); `default` — «спрашивает по своей политике»
      permissionMode: 'default',
      tools: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: session.thread.cliVersion,
    };
    if (effort) event.effort = effort;
    return event;
  }

  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Закрыть ход без `turn/completed` (Stop, а сервер так и не ответил завершением): идёт — `turn.result`
   * `interrupted` с тем, что успело прийти; `turn/started` не было — синтетический ход по промпту.
   */
  abandonTurn(turnId: string | undefined, prompt: NotedPrompt): AgentEvent[] {
    if (this.turnId) {
      const turn = { id: this.turnId, items: [], status: 'interrupted', error: null } as unknown as Turn;
      return this.turnCompleted(turn);
    }
    if (turnId) this.markFinished(turnId);
    if (!this.prompts.includes(prompt)) return [];
    this.dropPrompt(prompt);
    return this.syntheticTurn(prompt, { interrupted: true });
  }

  private markFinished(turnId: string): void {
    this.finished.add(turnId);
    if (this.finished.size > 64) this.finished.delete(this.finished.values().next().value!);
  }

  /**
   * Ход, которого app-server не начал (`turn/start`/`thread/start` отклонены) или который сняли до старта
   * (Stop при запуске): `turn.start` → [`error`] → `turn.result`, чтобы лента не осталась в «идёт».
   */
  syntheticTurn(
    prompt: NotedPrompt,
    outcome: { interrupted: true } | { message: string },
  ): AgentEvent[] {
    const at = this.now();
    const start: AgentEventOf<'turn.start'> = { type: 'turn.start', prompt: prompt.text, at };
    if (prompt.images?.length) start.images = prompt.images.map(imageRef);
    const interrupted = 'interrupted' in outcome;
    const events: AgentEvent[] = [start];
    if ('message' in outcome) events.push({ type: 'error', message: outcome.message, fatal: false });
    events.push({
      type: 'turn.result',
      ok: false,
      subtype: interrupted ? 'interrupted' : 'error',
      interrupted,
      durationMs: 0,
      apiDurationMs: 0,
      numTurns: 0,
      usage: tokenUsageOf(ZERO),
      totalCostUsd: 0,
      permissionDenials: [],
    });
    return events;
  }

  map(method: string, params: unknown): AgentEvent[] {
    const p = params as { threadId?: string } | undefined;
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return [];
    switch (method) {
      case 'turn/started':
        return this.turnStarted((params as CodexNotifications['turn/started']).turn);
      case 'turn/completed': {
        const turn = (params as CodexNotifications['turn/completed']).turn;
        // `turn/completed` чужого хода (не тот, что открыл `turn/started`) или уже закрытого ленту не закрывает
        if (turn.id && this.finished.has(turn.id)) return [];
        if (this.turnId && turn.id && turn.id !== this.turnId) return [];
        return this.turnCompleted(turn);
      }
      case 'item/agentMessage/delta': {
        const m = params as CodexNotifications['item/agentMessage/delta'];
        if (!m.delta) return [];
        this.streamed.add(m.itemId);
        this.lastText += m.delta;
        return [{ type: 'text.delta', messageId: m.itemId, text: m.delta }];
      }
      case 'item/reasoning/summaryTextDelta': {
        const m = params as CodexNotifications['item/reasoning/summaryTextDelta'];
        return this.reasoningDelta(m.itemId, m.delta, m.summaryIndex);
      }
      case 'item/reasoning/textDelta': {
        const m = params as CodexNotifications['item/reasoning/textDelta'];
        return this.reasoningDelta(m.itemId, m.delta, undefined);
      }
      case 'item/started': {
        const m = params as CodexNotifications['item/started'];
        const agents = this.collaborationItem(m.item);
        if (agents.length) return agents;
        return this.tools.started(m.item, m.startedAtMs);
      }
      case 'item/completed': {
        const m = params as CodexNotifications['item/completed'];
        const own = this.itemCompleted(m.item);
        if (own.length) return own;
        const agents = this.collaborationItem(m.item);
        return agents.length ? agents : this.tools.completed(m.item, m.completedAtMs);
      }
      case 'item/commandExecution/outputDelta': {
        const m = params as CodexNotifications['item/commandExecution/outputDelta'];
        return this.tools.output(m.itemId, m.delta);
      }
      case 'item/fileChange/patchUpdated': {
        const m = params as CodexNotifications['item/fileChange/patchUpdated'];
        return this.tools.patchUpdated(m.itemId, m.changes);
      }
      case 'thread/tokenUsage/updated': {
        const m = params as CodexNotifications['thread/tokenUsage/updated'];
        const total = m.tokenUsage.total;
        const base = this.prevTotal ?? diff(total, m.tokenUsage.last);
        this.turnUsage = add(this.turnUsage, diff(total, base));
        this.prevTotal = total;
        this.lastCall = m.tokenUsage.last;
        this.contextWindow = m.tokenUsage.modelContextWindow;
        return [];
      }
      case 'error': {
        const m = params as CodexNotifications['error'];
        // повтор — Codex пробует сам; фатальность решит `turn/completed`
        if (m.willRetry) return [];
        this.errorMessages.push(m.error.message);
        const event: AgentEventOf<'error'> = { type: 'error', message: m.error.message, fatal: false };
        const code = errorCode(m.error.codexErrorInfo);
        if (code) event.code = code;
        return [event];
      }
      case 'mcpServer/startupStatus/updated':
        return [this.mcpStartup(params as CodexNotifications['mcpServer/startupStatus/updated'])];
      default:
        return [];
    }
  }

  /**
   * Ответ `mcpServerStatus/list` (все страницы) → полный `mcp.status`; список заменяет прежний целиком.
   * Ошибку и версию из прежнего списка не тянем: ответ свежее уведомлений.
   */
  mcpList(servers: readonly CodexMcpServerStatus[], listing?: McpListing): AgentEventOf<'mcp.status'> {
    if (listing) this.mcpListings.delete(listing);
    this.mcp = servers.map((s) => {
      const info: McpServerInfo = { name: s.name, status: mcpRuntimeStatus(s.runtimeStatus) };
      if (s.toolsError) info.error = s.toolsError;
      if (s.serverInfo?.version) info.version = s.serverInfo.version;
      if (s.tools && typeof s.tools === 'object') info.tools = Object.keys(s.tools).length;
      if (s.pluginId) info.scope = 'plugin';
      // уведомление пришло, пока список был в пути: снимок мог быть снят раньше — статус берём из уведомления
      const fresh = listing?.get(s.name);
      if (fresh) {
        info.status = fresh.status;
        if (fresh.error) info.error = fresh.error;
        else delete info.error;
      }
      return info;
    });
    return this.mcpEvent();
  }

  /**
   * Начало `mcpServerStatus/list`: до ответа уведомления о запуске серверов запоминаются, ответ их не откатит
   * (Codex после хода статус не переспрашивает — сервер застрял бы в `pending`). Отдать в `mcpList`.
   */
  mcpListStart(): McpListing {
    const listing: McpListing = new Map();
    this.mcpListings.add(listing);
    return listing;
  }

  /** Список не пришёл (ошибка): запомненное больше не нужно. */
  mcpListFailed(listing: McpListing): void {
    this.mcpListings.delete(listing);
  }

  /** `mcpServer/startupStatus/updated`: один сервер в сохранённом списке (нет — добавить), наружу — весь список. */
  private mcpStartup(m: CodexNotifications['mcpServer/startupStatus/updated']): AgentEventOf<'mcp.status'> {
    const status: McpServerStatus =
      m.failureReason === 'reauthenticationRequired'
        ? 'needs-auth'
        : m.status === 'ready'
          ? 'connected'
          : m.status === 'starting'
            ? 'pending'
            : m.status === 'failed' || m.status === 'cancelled'
              ? 'failed'
              : 'pending';
    const i = this.mcp.findIndex((s) => s.name === m.name);
    const next: McpServerInfo = { ...(i >= 0 ? this.mcp[i] : undefined), name: m.name, status };
    if (m.error) next.error = m.error;
    else delete next.error;
    if (i >= 0) this.mcp[i] = next;
    else this.mcp.push(next);
    for (const listing of this.mcpListings) listing.set(m.name, { status, ...(m.error ? { error: m.error } : {}) });
    return this.mcpEvent();
  }

  private mcpEvent(): AgentEventOf<'mcp.status'> {
    return { type: 'mcp.status', servers: this.mcp.map((s) => ({ ...s })), at: this.now() };
  }

  /** Точный размер контекста по последнему ответу модели; нет данных — `undefined`. */
  contextEvent(): AgentEventOf<'context.usage'> | undefined {
    if (!this.lastCall) return undefined;
    // в окне после ответа — и ввод (с кэшем), и сам ответ: следующий запрос несёт их оба
    const usedTokens = this.lastCall.totalTokens;
    const event: AgentEventOf<'context.usage'> = { type: 'context.usage', usedTokens, source: 'usage' };
    if (this.contextWindow && this.contextWindow > 0) {
      event.maxTokens = this.contextWindow;
      event.percentage = Math.min(100, (usedTokens / this.contextWindow) * 100);
    }
    return event;
  }

  private turnStarted(turn: Turn): AgentEvent[] {
    this.turnId = turn.id;
    this.finished.delete(turn.id);
    this.turnStartedAt = turn.startedAt ? turn.startedAt * 1000 : this.now();
    this.streamed.clear();
    this.thinking.clear();
    this.lastText = '';
    this.finalText = undefined;
    this.errorMessages = [];
    this.turnUsage = ZERO;
    const prompt = this.prompts.shift();
    const event: AgentEventOf<'turn.start'> = { type: 'turn.start', at: this.turnStartedAt };
    if (prompt) {
      event.prompt = prompt.text;
      if (prompt.images?.length) event.images = prompt.images.map(imageRef);
    }
    return [event];
  }

  private reasoningDelta(itemId: string, text: string, index: number | undefined): AgentEvent[] {
    if (!text) return [];
    const events: AgentEvent[] = [];
    let state = this.thinking.get(itemId);
    if (!state) {
      state = { lastIndex: index };
      this.thinking.set(itemId, state);
      events.push({ type: 'thinking.start', messageId: itemId, at: this.now() });
    } else if (index !== undefined && state.lastIndex !== undefined && index !== state.lastIndex) {
      // следующая часть сводки — новый абзац
      state.lastIndex = index;
      text = `\n\n${text}`;
    } else if (index !== undefined) state.lastIndex = index;
    events.push({ type: 'thinking.delta', messageId: itemId, text });
    return events;
  }

  private stopThinking(itemId: string): AgentEvent[] {
    if (!this.thinking.delete(itemId)) return [];
    return [{ type: 'thinking.stop', messageId: itemId, at: this.now() }];
  }

  private itemCompleted(item: ThreadItem): AgentEvent[] {
    if (item.type === 'reasoning') return this.stopThinking(item.id);
    if (item.type !== 'agentMessage') return [];
    this.finalText = item.text;
    // текст без потока (короткий ответ, повтор): отдаём целиком, чтобы лента его не потеряла
    if (!this.streamed.has(item.id) && item.text) {
      this.streamed.add(item.id);
      this.lastText += item.text;
      return [{ type: 'text.delta', messageId: item.id, text: item.text }];
    }
    return [];
  }

  private collaborationItem(item: ThreadItem): AgentEvent[] {
    if (item.type === 'collabAgentToolCall') {
      const events: AgentEvent[] = [];
      if (item.tool === 'spawnAgent') {
        for (const agentId of item.receiverThreadIds) {
          this.subagents.set(agentId, {
            parentThreadId: item.senderThreadId,
            ...(item.prompt ? { prompt: item.prompt } : {}),
            ...(item.model ? { model: item.model } : {}),
          });
          events.push(...this.startSubagent(agentId));
        }
      }
      // `interruptAgent`/`wait` тоже обновляют состояние уже известного дочернего треда.
      for (const [agentId, state] of Object.entries(item.agentsStates))
        if (state && this.startedSubagents.has(agentId)) events.push(...this.subagentState(agentId, state));
      return events;
    }
    if (item.type !== 'subAgentActivity') return [];
    if (item.kind === 'started') return this.startSubagent(item.agentThreadId);
    if (item.kind === 'interacted')
      return this.endedSubagents.has(item.agentThreadId)
        ? []
        : [{ type: 'agent.progress', agentId: item.agentThreadId, taskId: item.agentThreadId, status: 'working' }];
    return this.endSubagent(item.agentThreadId, item.kind === 'completed' ? 'completed' : 'stopped');
  }

  private startSubagent(agentId: string): AgentEvent[] {
    if (this.startedSubagents.has(agentId) || this.endedSubagents.has(agentId)) return [];
    this.startedSubagents.add(agentId);
    const meta = this.subagents.get(agentId);
    const event: AgentEventOf<'agent.start'> = {
      type: 'agent.start',
      agentId,
      taskId: agentId,
      description: meta?.prompt ?? 'Codex subagent',
      taskType: 'subagent',
      subagentType: meta?.model,
      background: false,
    };
    if (meta?.parentThreadId && meta.parentThreadId !== this.threadId) event.parentAgentId = meta.parentThreadId;
    return [event];
  }

  private subagentState(agentId: string, state: CollabAgentState): AgentEvent[] {
    if (state.status === 'completed') return this.endSubagent(agentId, 'completed', state.message);
    if (state.status === 'interrupted' || state.status === 'shutdown') return this.endSubagent(agentId, 'stopped', state.message);
    if (state.status === 'errored' || state.status === 'notFound') return this.endSubagent(agentId, 'failed', state.message);
    return this.endedSubagents.has(agentId)
      ? []
      : [{ type: 'agent.progress', agentId, taskId: agentId, status: state.status, ...(state.message ? { description: state.message } : {}) }];
  }

  private endSubagent(
    agentId: string,
    status: AgentEventOf<'agent.end'>['status'],
    summary?: string | null,
  ): AgentEvent[] {
    if (this.endedSubagents.has(agentId)) return [];
    this.endedSubagents.add(agentId);
    return [{ type: 'agent.end', agentId, taskId: agentId, status, ...(summary ? { summary } : {}) }];
  }

  private turnCompleted(turn: Turn): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const id of [...this.thinking.keys()]) events.push(...this.stopThinking(id));
    const interrupted = turn.status === 'interrupted';
    const ok = turn.status === 'completed';
    const now = this.now();
    const durationMs = turn.durationMs ?? Math.max(0, now - this.turnStartedAt);
    const result: AgentEventOf<'turn.result'> = {
      type: 'turn.result',
      ok,
      subtype: ok ? 'success' : interrupted ? 'interrupted' : 'error',
      interrupted,
      durationMs,
      apiDurationMs: durationMs,
      numTurns: 1,
      usage: tokenUsageOf(this.turnUsage),
      // Codex не сообщает стоимость; 0 здесь — «неизвестно», а не «бесплатно» (HUD для Codex прячет этап 3)
      totalCostUsd: 0,
      permissionDenials: [],
    };
    if (this.model) result.model = this.model;
    if (this.contextWindow) result.contextWindow = this.contextWindow;
    if (turn.status === 'failed') result.terminalReason = 'failed';
    const message = turn.error?.message;
    if (message && !this.errorMessages.includes(message)) result.errors = [message];
    const text = this.finalText ?? (this.lastText || undefined);
    if (text) result.text = text;
    events.push(result);
    if (turn.id) this.markFinished(turn.id);
    this.turnId = undefined;
    return events;
  }
}
