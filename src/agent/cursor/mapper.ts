import type { AgentEvent, TokenUsage } from '../types';
import { chunkText, sessionUpdateKind, stopReasonOf } from './protocol';

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Текстовый ход ACP → `AgentEvent`. В `text.delta` попадает только `agent_message_chunk`.
 * `agent_thought_chunk`, `user_message_chunk`, tool, `plan` с entries и каталог команд — не лента этапа 2.
 */
export class CursorMapper {
  private messageId = '';
  private text = '';
  private seq = 0;

  /** Новый ход: сбрасывает накопленный текст предыдущего. */
  startTurn(prompt: string, at = Date.now()): AgentEvent[] {
    this.seq += 1;
    this.messageId = `c${this.seq}`;
    this.text = '';
    return [{ type: 'turn.start', prompt, at }];
  }

  /**
   * Один `session/update.update`. Не `agent_message_chunk` — пусто
   * (мысли, реплика пользователя, tool, план, команды, режим).
   */
  applyUpdate(update: unknown): AgentEvent[] {
    if (sessionUpdateKind(update) !== 'agent_message_chunk') return [];
    const text = chunkText(update);
    if (!text) return [];
    if (!this.messageId) {
      this.seq += 1;
      this.messageId = `c${this.seq}`;
    }
    this.text += text;
    return [{ type: 'text.delta', messageId: this.messageId, text }];
  }

  /** Ответ `session/prompt`: `end_turn` — успех, `cancelled` — Stop. */
  finish(result: unknown, startedAt: number, now = Date.now()): AgentEvent[] {
    const stopReason = stopReasonOf(result) ?? 'end_turn';
    return [this.result(stopReason, this.text, Math.max(0, now - startedAt))];
  }

  /** Ход оборвался (stdout закрылся), `stopReason` не пришёл. */
  failOpen(startedAt: number, now = Date.now()): AgentEvent[] {
    return [this.result('error', this.text, Math.max(0, now - startedAt), { ok: false, interrupted: false })];
  }

  /** Stop не дождался `stopReason`: закрыть ход как `cancelled`, очередь не держать. */
  abandon(startedAt: number, now = Date.now()): AgentEvent[] {
    return [this.result('cancelled', this.text, Math.max(0, now - startedAt), { ok: false, interrupted: true })];
  }

  /** Stop раньше `session/prompt`: синтетический ход, процесс жив. */
  interruptBeforeStart(prompt: string, at = Date.now()): AgentEvent[] {
    return [
      { type: 'turn.start', prompt, at },
      this.result('interrupted', '', 0, { ok: false, interrupted: true, numTurns: 0 }),
    ];
  }

  private result(
    subtype: string,
    text: string,
    durationMs: number,
    flags?: { ok: boolean; interrupted: boolean; numTurns?: number },
  ): AgentEvent {
    const interrupted = flags?.interrupted ?? subtype === 'cancelled';
    const ok = flags?.ok ?? subtype === 'end_turn';
    this.text = '';
    this.messageId = '';
    return {
      type: 'turn.result',
      ok,
      subtype,
      interrupted,
      durationMs,
      apiDurationMs: 0,
      numTurns: flags?.numTurns ?? 1,
      usage: { ...ZERO },
      usageKnown: false,
      totalCostUsd: 0,
      permissionDenials: [],
      ...(text ? { text } : {}),
    };
  }
}
