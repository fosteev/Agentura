import type {
  AgentEvent,
  AgentEventOf,
  ImageRef,
  PermissionMode,
  PromptImage,
  TokenUsage,
} from '../types';
import type { AgyEvent, AgyInit, AgyResult, AgyStep, AgyUsage } from './protocol';

/** Промпт, который сессия записала в stdin: сам agy текст не возвращает (эхо `user_input` без `text_delta`). */
export interface NotedPrompt {
  text: string;
  images?: readonly PromptImage[];
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Токены agy → `TokenUsage`. `input_tokens` у agy включает кэш (как у Gemini), `thinking_tokens` — часть
 * `output_tokens` (14998 + 308 = 15306). Кэш в живых прогонах всегда был 0: вычитание кэша из ввода —
 * допущение по семантике Gemini, не проверено.
 */
export function tokenUsageOf(u: AgyUsage | undefined): TokenUsage {
  const cacheRead = u?.cache_read_tokens ?? 0;
  const usage: TokenUsage = {
    input: Math.max(0, (u?.input_tokens ?? 0) - cacheRead),
    output: u?.output_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
  };
  if ((u?.thinking_tokens ?? 0) > 0) usage.thinking = u?.thinking_tokens;
  return usage;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: TokenUsage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
  const thinking = (a.thinking ?? 0) + (b.thinking ?? 0);
  if (thinking > 0) sum.thinking = thinking;
  return sum;
}

function imageRef(image: PromptImage): ImageRef {
  const ref: ImageRef = { mediaType: image.mediaType, data: image.data };
  if (image.width !== undefined) ref.width = image.width;
  if (image.height !== undefined) ref.height = image.height;
  if (image.name !== undefined) ref.name = image.name;
  return ref;
}

interface ToolState {
  id: string;
  name: string;
  done: boolean;
}

interface Turn {
  startedAt: number;
  usage: TokenUsage;
  apiMs: number;
  agentSteps: Set<number>;
  tools: Map<number, ToolState>;
  /** По шагу: накопленный текст и «хвост» из пробелов, который не отдаём, пока за ним не пришёл текст. */
  texts: Map<number, { text: string; pendingWs: string }>;
  lastTextStep: number | undefined;
  /** Шаги tool, отклонённые по разрешениям (`permission check failed`), по порядку. */
  deniedToolIds: string[];
  errors: string[];
}

/**
 * События agy → `AgentEvent`. Работает на один процесс/диалог. Ход открывается эхом `user_input`
 * (`turn.start` по промпту, объявленному через `notePrompt`) либо первым же событием хода, закрывается
 * `result`. Текст стримится только у финального шага ответа; промежуточные шаги без текста игнорируются,
 * thinking-текста у agy нет (только счётчик токенов). Инструменты: имя как есть, результат — `output`
 * или `error.message`; подробности (диффы, отказы с кнопками) — этап 2 roadmap 16.
 */
export class AgyEventMapper {
  conversationId: string | undefined;
  private model: string | undefined;
  private pending: NotedPrompt | undefined;
  private turn: Turn | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  get turnOpen(): boolean {
    return this.turn !== undefined;
  }

  setModel(model: string): void {
    this.model = model;
  }

  notePrompt(prompt: NotedPrompt): void {
    this.pending = prompt;
  }

  /** Промпт не ушёл: снять, чтобы не приклеился к чужому ходу. */
  dropPrompt(prompt: NotedPrompt): void {
    if (this.pending === prompt) this.pending = undefined;
  }

  init(
    event: AgyInit,
    context: { permissionMode: PermissionMode; engineVersion: string; cwd: string; effort?: AgentEventOf<'session.init'>['effort'] },
  ): AgentEventOf<'session.init'> {
    this.conversationId = event.conversation_id;
    if (event.init.model) this.model = event.init.model;
    const init: AgentEventOf<'session.init'> = {
      type: 'session.init',
      sessionId: event.conversation_id,
      model: event.init.model ?? this.model ?? '',
      cwd: event.init.cwd ?? context.cwd,
      permissionMode: context.permissionMode,
      tools: event.init.tools ?? [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      engineVersion: context.engineVersion,
    };
    if (context.effort) init.effort = context.effort;
    return init;
  }

  /** `init` — через `init()` (нужен контекст сессии), здесь его нет. */
  map(event: AgyEvent): AgentEvent[] {
    if (event.event === 'init') return [];
    // `init` мог не дойти (Stop в первые ~2 с): id беседы есть и в шагах, и в `result` — для `--conversation`
    const id = event.event === 'result' ? event.result.conversation_id : event.step_update.conversation_id;
    if (!this.conversationId && id) this.conversationId = id;
    return event.event === 'result' ? this.result(event.result) : this.step(event.step_update);
  }

  /**
   * Закрыть ход без `result` (Stop, а agy результата не прислал; процесс умер): открытый ход — `turn.result`
   * с тем, что успело прийти; хода не было — синтетический по промпту.
   */
  abandonTurn(outcome: { interrupted: true } | { message: string }): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!this.turn && !this.pending) return events;
    this.open(events);
    const turn = this.turn;
    if (!turn) return events;
    const interrupted = 'interrupted' in outcome;
    if (!interrupted) turn.errors.push(outcome.message);
    this.finish(events, turn, { ok: false, interrupted, text: this.lastText(turn), denied: [] });
    return events;
  }

  /** Ход, которого agy не начал (процесс не поднялся, Stop до отправки): `turn.start` → [`error`] → `turn.result`. */
  syntheticTurn(prompt: NotedPrompt, outcome: { interrupted: true } | { message: string }): AgentEvent[] {
    const start: AgentEventOf<'turn.start'> = { type: 'turn.start', prompt: prompt.text, at: this.now() };
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
      usage: { ...ZERO },
      totalCostUsd: 0,
      permissionDenials: [],
    });
    return events;
  }

  // ---- внутреннее ----------------------------------------------------------------------------------

  /** `turn.start`, если хода ещё нет. Промпт — объявленный сессией (нет — ход начал не он). */
  private open(events: AgentEvent[]): Turn {
    if (this.turn) return this.turn;
    const at = this.now();
    const prompt = this.pending;
    this.pending = undefined;
    const start: AgentEventOf<'turn.start'> = { type: 'turn.start', at };
    if (prompt) {
      start.prompt = prompt.text;
      if (prompt.images?.length) start.images = prompt.images.map(imageRef);
    }
    events.push(start);
    this.turn = {
      startedAt: at,
      usage: { ...ZERO },
      apiMs: 0,
      agentSteps: new Set(),
      tools: new Map(),
      texts: new Map(),
      lastTextStep: undefined,
      deniedToolIds: [],
      errors: [],
    };
    return this.turn;
  }

  private step(step: AgyStep): AgentEvent[] {
    const events: AgentEvent[] = [];
    switch (step.step_type) {
      case 'user_input':
        this.open(events);
        break;
      case 'agent_response':
        this.agentStep(events, this.open(events), step);
        break;
      case 'tool':
        this.toolStep(events, this.open(events), step);
        break;
      default:
        // system_message (на resume) и новые типы agy: в ленту не идут
        break;
    }
    return events;
  }

  private agentStep(events: AgentEvent[], turn: Turn, step: AgyStep): void {
    const messageId = `agy-${step.step_index}`;
    const delta = step.text_delta;
    if (delta) {
      const state = turn.texts.get(step.step_index) ?? { text: '', pendingWs: '' };
      turn.texts.set(step.step_index, state);
      // начало сообщения без пробелов (ведущий `\n` — не текст); конец держим в `pendingWs`
      const all = state.text === '' ? (state.pendingWs + delta).trimStart() : state.pendingWs + delta;
      const body = all.trimEnd();
      state.pendingWs = all.slice(body.length);
      // пробелы/`\n` в конце держим: финальный `"\n"` не плодит пустого сообщения, внутренний переход строки сохраняется
      if (body) {
        state.text += body;
        turn.lastTextStep = step.step_index;
        events.push({ type: 'text.delta', messageId, text: body });
      }
    }
    if (step.state === 'ERROR') turn.errors.push('agent response failed');
    if (step.state === 'DONE' && !turn.agentSteps.has(step.step_index)) {
      turn.agentSteps.add(step.step_index);
      const usage = tokenUsageOf(step.usage);
      turn.usage = addUsage(turn.usage, usage);
      turn.apiMs += Math.round((step.duration_seconds ?? 0) * 1000);
      if (step.usage)
        events.push({ type: 'usage.message', messageId, model: this.model ?? '', usage, final: true, at: this.now() });
    }
  }

  private toolStep(events: AgentEvent[], turn: Turn, step: AgyStep): void {
    const name = step.tool_name ?? step.tool_info?.name ?? 'tool';
    let tool = turn.tools.get(step.step_index);
    if (!tool) {
      tool = { id: `agy-${step.step_index}`, name, done: false };
      turn.tools.set(step.step_index, tool);
      events.push({
        type: 'tool.start',
        toolUseId: tool.id,
        name,
        input: step.tool_info?.parameters ?? {},
        at: this.now(),
      });
    }
    if (tool.done || step.state === 'ACTIVE') return;
    tool.done = true;
    const isError = step.state === 'ERROR';
    const message = step.tool_info?.error?.message;
    if (isError && message && /permission check failed/i.test(message)) turn.deniedToolIds.push(tool.id);
    const result: AgentEventOf<'tool.result'> = {
      type: 'tool.result',
      toolUseId: tool.id,
      isError,
      content: isError ? (message ?? 'tool failed') : (step.tool_info?.output ?? ''),
      at: this.now(),
    };
    if (step.duration_seconds !== undefined) result.durationMs = Math.round(step.duration_seconds * 1000);
    events.push(result);
  }

  private result(result: AgyResult['result']): AgentEvent[] {
    const events: AgentEvent[] = [];
    const turn = this.open(events);
    const ok = result.status === 'SUCCESS';
    const interrupted = !ok && /interrupted/i.test(result.error ?? '');
    if (!ok && !interrupted) turn.errors.push(result.error?.trim() || 'agy returned an error');
    const response = result.response?.trimEnd();
    const denied = (result.denied_actions ?? []).map((a, i) => ({
      toolName: a.display_name || a.action || 'tool',
      // действие отказа (`write_file`) не совпадает с именем шага (`write_to_file`): сопоставляем по порядку
      toolUseId: turn.deniedToolIds.length === (result.denied_actions ?? []).length ? (turn.deniedToolIds[i] ?? '') : '',
    }));
    this.finish(events, turn, { ok, interrupted, text: response || this.lastText(turn), denied });
    return events;
  }

  private lastText(turn: Turn): string | undefined {
    return turn.lastTextStep === undefined ? undefined : turn.texts.get(turn.lastTextStep)?.text;
  }

  /** Незакрытые инструменты → `tool.result` (иначе в ленте вечный спиннер), затем `turn.result`. */
  private finish(
    events: AgentEvent[],
    turn: Turn,
    outcome: { ok: boolean; interrupted: boolean; text: string | undefined; denied: { toolName: string; toolUseId: string }[] },
  ): void {
    for (const tool of turn.tools.values()) {
      if (tool.done) continue;
      tool.done = true;
      events.push({
        type: 'tool.result',
        toolUseId: tool.id,
        isError: true,
        content: outcome.interrupted ? 'interrupted' : 'tool did not finish',
        at: this.now(),
      });
    }
    const result: AgentEventOf<'turn.result'> = {
      type: 'turn.result',
      ok: outcome.ok,
      subtype: outcome.ok ? 'success' : outcome.interrupted ? 'interrupted' : 'error',
      interrupted: outcome.interrupted,
      durationMs: Math.max(0, this.now() - turn.startedAt),
      apiDurationMs: turn.apiMs,
      numTurns: turn.agentSteps.size,
      usage: turn.usage,
      // подписка, цены неизвестны: стоимость не считаем
      totalCostUsd: 0,
      permissionDenials: outcome.denied,
    };
    if (this.model) result.model = this.model;
    if (turn.errors.length > 0) result.errors = turn.errors;
    if (outcome.text) result.text = outcome.text;
    events.push(result);
    this.turn = undefined;
  }
}
