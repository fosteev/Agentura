import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgyChild, AgySpawn } from './process';
import type { AgyStep } from './protocol';

export const FAKE_CONVERSATION = '00000000-0000-4000-8000-000000000001';

/**
 * Поддельный `agy` для тестов: читает NDJSON со stdin (строки `user` отдаёт в `onUser`), пишет события в stdout.
 * По SIGINT ведёт себя как живой: stderr `error: interrupted`, `result` ERROR `interrupted`, выход с кодом 1
 * (`ignoreSigint` — не реагировать, проверка эскалации до SIGKILL). Только для тестов.
 */
export class FakeAgy extends EventEmitter implements AgyChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  /** Всё, что получено в stdin: разобранные строки. */
  readonly received: Record<string, unknown>[] = [];
  /** Сигналы, которыми процесс пытались убить. */
  readonly signals: NodeJS.Signals[] = [];
  exited = false;
  stdinEnded = false;
  ignoreSigint = false;
  conversationId = FAKE_CONVERSATION;
  model = 'fake-model';
  /** Вызывается на каждое сообщение пользователя; `n` — номер сообщения этого процесса с нуля. */
  onUser: (text: string, n: number) => void = () => {};
  private buffer = '';
  private users = 0;
  private stepIndex = 0;

  constructor(readonly args: string[]) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.read(chunk));
    this.stdin.on('end', () => {
      this.stdinEnded = true;
      // закрытие stdin: доиграть ход и выйти 0 (тесты ходов в полёте управляют сами)
      if (!this.holdOnEnd) this.exit(0);
    });
  }
  /** Не выходить на конец stdin (проверка kill после grace). */
  holdOnEnd = false;

  on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exited) return false;
    if (signal === 'SIGKILL') this.exit(null, 'SIGKILL');
    else if (signal === 'SIGINT' && !this.ignoreSigint) {
      this.err('error: interrupted');
      this.result({ status: 'ERROR', error: 'interrupted', response: '' });
      this.exit(1);
    }
    return true;
  }

  // ---- вывод ---------------------------------------------------------------------------------------

  private write(value: unknown): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  err(line: string): void {
    if (!this.exited) this.stderr.write(`${line}\n`);
  }

  init(): void {
    this.write({
      event: 'init',
      conversation_id: this.conversationId,
      init: { model: this.model, cwd: '/tmp/agentura-agy', tools: ['run_command', 'write_to_file'], permission_mode: 'request-review' },
    });
  }

  step(step: Omit<AgyStep, 'step_index' | 'conversation_id'> & { step_index?: number }): number {
    const index = step.step_index ?? this.stepIndex++;
    this.stepIndex = Math.max(this.stepIndex, index + 1);
    this.write({ event: 'step_update', step_update: { conversation_id: this.conversationId, ...step, step_index: index } });
    return index;
  }

  /** Эхо `user_input` и один шаг ответа: ACTIVE-дельта и DONE с токенами. */
  answer(text: string, usage = { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, total_tokens: 110 }): void {
    this.step({ state: 'DONE', step_type: 'user_input' });
    const index = this.step({ state: 'ACTIVE', step_type: 'agent_response', text_delta: text });
    this.step({ step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 1.5, usage });
    this.result({ status: 'SUCCESS', response: `${text}\n`, usage });
  }

  result(result: Record<string, unknown>): void {
    this.write({ event: 'result', result: { conversation_id: this.conversationId, duration_seconds: 1, num_turns: 1, ...result } });
  }

  /** Закрыть процесс: stdout/stderr закончены, `close` с кодом. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }

  /** Нет такого процесса: `error` вместо запуска (ENOENT). */
  failToStart(message = 'spawn agy ENOENT'): void {
    this.exited = true;
    this.pid = undefined;
    setImmediate(() => this.emit('error', new Error(message)));
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      this.received.push(msg);
      if (msg.event === 'user') {
        const content = (msg.message as { content: unknown }).content;
        this.onUser(typeof content === 'string' ? content : JSON.stringify(content), this.users++);
      }
    }
  }
}

/** Фабрика `spawn` для адаптера: каждый запуск — новый `FakeAgy`, `setup` его настраивает (по умолчанию — `init` через тик). */
export function fakeSpawn(setup?: (agy: FakeAgy, spawnIndex: number) => void): { spawn: AgySpawn; spawns: FakeAgy[] } {
  const spawns: FakeAgy[] = [];
  const spawn: AgySpawn = (_path, args) => {
    const agy = new FakeAgy(args);
    const index = spawns.push(agy) - 1;
    agy.pid = 4242 + index;
    if (setup) setup(agy, index);
    else {
      agy.onUser = (text) => agy.answer(`echo: ${text}`);
      setTimeout(() => agy.init(), 0);
    }
    return agy;
  };
  return { spawn, spawns };
}
