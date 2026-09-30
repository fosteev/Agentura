import type { EventStream, Unsubscribe } from './types';

/**
 * Асинхронная очередь: `push` из любого места, `for await` с другой стороны.
 * Нужна для streaming input mode SDK (prompt — `AsyncIterable`) и для `for await` по событиям.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  get closed(): boolean {
    return this.ended;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as T;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

/**
 * Рассылка событий нескольким подписчикам; ошибка одного подписчика не ломает остальных.
 * Пока подписчиков нет, события копятся и достаются первому (ошибка запуска движка может
 * прийти раньше, чем интерфейс подписался).
 */
export class EventHub<T> implements EventStream<T> {
  private readonly listeners = new Set<(event: T) => void>();
  private readonly iterators = new Set<AsyncQueue<T>>();
  private backlog: T[] | undefined = [];
  private closed = false;

  constructor(private readonly onListenerError: (error: unknown) => void = () => {}) {}

  emit(event: T): void {
    if (this.closed) return;
    if (this.backlog) {
      if (this.backlog.length < 10_000) this.backlog.push(event);
      return;
    }
    this.deliver(event);
  }

  private flushBacklog(): void {
    const backlog = this.backlog;
    this.backlog = undefined;
    for (const event of backlog ?? []) this.deliver(event);
  }

  private deliver(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
    for (const queue of this.iterators) queue.push(event);
  }

  on(listener: (event: T) => void): Unsubscribe {
    this.listeners.add(listener);
    this.flushBacklog();
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const queue of this.iterators) queue.end();
    this.iterators.clear();
    this.listeners.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const queue = new AsyncQueue<T>();
    if (this.closed) {
      // Закрыт без подписчиков: накопленное (в том числе событие закрытия) — этому итератору.
      for (const event of this.backlog ?? []) queue.push(event);
      this.backlog = undefined;
      queue.end();
    } else {
      this.iterators.add(queue);
      this.flushBacklog();
    }
    const inner = queue[Symbol.asyncIterator]();
    return {
      next: () => inner.next(),
      return: async () => {
        this.iterators.delete(queue);
        queue.end();
        return { done: true, value: undefined };
      },
    };
  }
}
