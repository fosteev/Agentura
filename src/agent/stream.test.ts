import { describe, expect, it } from 'vitest';
import { EventHub } from './stream';

describe('EventHub', () => {
  it('до первого подписчика копит события и отдаёт их ему; дальше — всем с момента подписки', () => {
    const hub = new EventHub<number>();
    hub.emit(1);
    hub.emit(2);
    const a: number[] = [];
    const b: number[] = [];
    hub.on((n) => a.push(n));
    hub.emit(3);
    hub.on((n) => b.push(n));
    hub.emit(4);
    expect(a).toEqual([1, 2, 3, 4]);
    expect(b).toEqual([4]);
  });

  it('после close события не принимаются, for await завершается', async () => {
    const hub = new EventHub<number>();
    const got: number[] = [];
    const loop = (async () => {
      for await (const n of hub) got.push(n);
    })();
    hub.emit(1);
    hub.close();
    hub.emit(2);
    await loop;
    expect(got).toEqual([1]);
  });

  it('закрыт без подписчиков — поздний итератор получает накопленное и завершается', async () => {
    const hub = new EventHub<string>();
    hub.emit('error');
    hub.emit('closed');
    hub.close();
    const got: string[] = [];
    for await (const e of hub) got.push(e);
    expect(got).toEqual(['error', 'closed']);
  });

  it('упавший подписчик не мешает остальным', () => {
    const errors: unknown[] = [];
    const hub = new EventHub<number>((e) => errors.push(e));
    const got: number[] = [];
    hub.on(() => {
      throw new Error('bad');
    });
    hub.on((n) => got.push(n));
    hub.emit(1);
    expect(got).toEqual([1]);
    expect(errors).toHaveLength(1);
  });
});
