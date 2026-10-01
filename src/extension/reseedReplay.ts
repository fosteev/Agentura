import type { AgentEvent } from '../agent/types';

/**
 * Пересев webview при идущем ходе (этап 5 roadmap 0.2). Пока хост читает транскрипт, движок шлёт события;
 * раньше они уходили в webview до `session.history` и стирались ею (`seedHistory` сбрасывает ленту). Теперь
 * хост копит их и доигрывает после истории. Часть из них транскрипт к моменту чтения уже содержал — такие
 * отбрасываются по ключам: вызов и результат инструмента (`toolUseId`), текст и рассуждение ответа
 * (`messageId` — CLI пишет блок в транскрипт, когда он закончен), итог запроса, начало/конец агента.
 *
 * Ход: история читается с `live` по состоянию на начало чтения. Если ход начался во время чтения и его промпт
 * уже попал в транскрипт, история закрыла бы его синтезированным `turn.result` — тогда этот итог из истории
 * убирается, а `turn.start` из накопленного — нет (он уже в истории).
 */
export function mergeReplay(
  history: readonly AgentEvent[],
  pending: readonly AgentEvent[],
): { history: AgentEvent[]; replay: AgentEvent[] } {
  const hist = [...history];
  const tools = new Set<string>();
  const results = new Set<string>();
  const texts = new Set<string>();
  const thoughts = new Set<string>();
  const usages = new Set<string>();
  const started = new Set<string>();
  const ended = new Set<string>();
  for (const e of hist) {
    switch (e.type) {
      case 'tool.start':
        tools.add(e.toolUseId);
        break;
      case 'tool.result':
        results.add(e.toolUseId);
        break;
      case 'text.delta':
        texts.add(e.messageId);
        break;
      case 'thinking.start':
      case 'thinking.delta':
      case 'thinking.stop':
        thoughts.add(e.messageId);
        break;
      case 'usage.message':
        if (e.final) usages.add(e.messageId);
        break;
      case 'agent.start':
        started.add(e.taskId);
        break;
      case 'agent.end':
        ended.add(e.taskId);
        break;
      default:
        break;
    }
  }

  const lastHistStart = lastIndexOf(hist, (e) => e.type === 'turn.start' && !e.agentId);
  const lastPrompts = new Set(
    lastHistStart >= 0
      ? promptsOf(hist[lastHistStart] as Extract<AgentEvent, { type: 'turn.start' }>)
      : [],
  );
  // ход, начатый во время чтения и уже записанный: последний turn.start истории с тем же промптом
  const firstStart = pending.find(
    (e): e is Extract<AgentEvent, { type: 'turn.start' }> => e.type === 'turn.start' && !e.agentId,
  );
  let skipStart: AgentEvent | undefined;
  if (firstStart) {
    const lastStart = lastHistStart;
    const h = hist[lastStart] as Extract<AgentEvent, { type: 'turn.start' }> | undefined;
    if (h && samePrompts(h, firstStart)) {
      skipStart = firstStart;
      const end = lastIndexOf(hist, (e) => e.type === 'turn.result' && !e.agentId);
      if (end > lastStart) hist.splice(end, 1);
    }
  }
  // ход истории закрыт (итог синтезирован или пришёл до чтения) — итог из накопленного без нового хода лишний
  let open =
    lastIndexOf(hist, (e) => e.type === 'turn.start' && !e.agentId) >
    lastIndexOf(hist, (e) => e.type === 'turn.result' && !e.agentId);

  // итог хода, закрытого до записанного нового хода: история его уже закрыла (синтезированным итогом), а живой
  // доиграл бы поверх открытого нового хода и закрыл бы его
  let beforeSkip = skipStart !== undefined;
  const replay: AgentEvent[] = [];
  for (const e of pending) {
    if (e === skipStart) {
      open = true;
      beforeSkip = false;
      continue;
    }
    switch (e.type) {
      case 'tool.start':
        if (tools.has(e.toolUseId)) continue;
        break;
      case 'tool.result':
        if (results.has(e.toolUseId)) continue;
        break;
      case 'text.delta':
        if (texts.has(e.messageId)) continue;
        break;
      case 'thinking.start':
      case 'thinking.delta':
      case 'thinking.stop':
        // рассуждение без текста в транскрипте (summarized) при записанном ответе встало бы после ответа
        if (thoughts.has(e.messageId) || texts.has(e.messageId)) continue;
        break;
      case 'turn.input':
        // сообщение, влитое в ход, транскрипт записал отдельной репликой — история её уже показала
        if (!e.agentId && lastPrompts.has(e.prompt)) continue;
        break;
      case 'usage.message':
        if (usages.has(e.messageId)) continue;
        break;
      case 'agent.start':
        if (started.has(e.taskId)) continue;
        break;
      case 'agent.end':
        if (ended.has(e.taskId)) continue;
        break;
      case 'turn.start':
        if (!e.agentId) open = true;
        break;
      case 'turn.result':
        if (!e.agentId) {
          if (!open || beforeSkip) continue;
          open = false;
        }
        break;
      default:
        break;
    }
    replay.push(e);
  }
  return { history: hist, replay };
}

function promptsOf(e: Extract<AgentEvent, { type: 'turn.start' }>): string[] {
  return e.prompts ?? (e.prompt !== undefined ? [e.prompt] : []);
}

function samePrompts(
  a: Extract<AgentEvent, { type: 'turn.start' }>,
  b: Extract<AgentEvent, { type: 'turn.start' }>,
): boolean {
  const pa = promptsOf(a);
  const pb = promptsOf(b);
  // ход-пробуждение без промпта не сопоставить — считаем новым
  if (pa.length === 0 || pb.length === 0) return false;
  return pa.join('\n') === pb.join('\n');
}

function lastIndexOf<T>(list: readonly T[], pred: (x: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) return i;
  return -1;
}

/**
 * Хвост текущего ответа основного агента: дельты текста и рассуждения сообщения, которое ещё пишется. Его нет в
 * транскрипте (блок пишется целиком, когда закончен), и при пересеве дельты, пришедшие до начала чтения, иначе
 * пропали бы — текст в ленте начинался бы с середины.
 */
export class StreamTail {
  private messageId: string | undefined;
  private events: AgentEvent[] = [];

  note(e: AgentEvent): void {
    if (e.agentId) return;
    switch (e.type) {
      case 'text.delta':
      case 'thinking.start':
      case 'thinking.delta':
      case 'thinking.stop':
        if (e.messageId !== this.messageId) {
          this.messageId = e.messageId;
          this.events = [];
        }
        this.events.push(e);
        break;
      case 'turn.start':
      case 'turn.result':
        this.clear();
        break;
      default:
        break;
    }
  }

  snapshot(): AgentEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.messageId = undefined;
    this.events = [];
  }
}
