import { describe, expect, it } from 'vitest';
import {
  applyCompletion,
  buildSlashItems,
  ownCommands,
  detectTrigger,
  filterSlash,
  historyStep,
  pushHistory,
} from './composer';

describe('detectTrigger', () => {
  it('«/» только в начале текста', () => {
    expect(detectTrigger('/pl', 3)).toEqual({ kind: 'slash', query: 'pl', start: 0 });
    expect(detectTrigger('see /pl', 7)).toBeUndefined();
    expect(detectTrigger('/plan x', 7)).toBeUndefined();
  });
  it('«@» в начале слова', () => {
    expect(detectTrigger('посмотри @Coun', 14)).toEqual({ kind: 'at', query: 'Coun', start: 9 });
    expect(detectTrigger('a@b', 3)).toBeUndefined();
    expect(detectTrigger('@', 1)).toEqual({ kind: 'at', query: '', start: 0 });
  });
  it('каретка в середине: смотрим только до неё', () => {
    expect(detectTrigger('@abc def', 2)).toEqual({ kind: 'at', query: 'a', start: 0 });
  });
});

describe('applyCompletion', () => {
  it('подставляет путь и пробел, хвост сохраняется', () => {
    const t = detectTrigger('смотри @Coun тут', 12)!;
    expect(applyCompletion('смотри @Coun тут', 12, t, 'apps/Counter.tsx')).toEqual({
      text: 'смотри @apps/Counter.tsx тут',
      caret: 25,
    });
  });
  it('команда', () => {
    const t = detectTrigger('/pl', 3)!;
    expect(applyCompletion('/pl', 3, t, 'plan')).toEqual({ text: '/plan ', caret: 6 });
  });
});

describe('меню «/»', () => {
  const engine = [
    { name: 'release-notes', description: 'что нового' },
    { name: 'init', description: 'CLAUDE.md' },
    { name: 'compact', description: 'движковый compact' },
  ];
  const items = buildSlashItems(engine, ['init', 'compact'], ['release-notes'], { plan: 'план' });
  it('свои команды первыми, дубли схлопнуты, скиллы помечены', () => {
    expect(items.slice(0, 4).map((i) => i.name)).toEqual(['plan', 'compact', 'clear', 'status']);
    expect(items.filter((i) => i.name === 'compact')).toHaveLength(1);
    expect(items.find((i) => i.name === 'release-notes')?.group).toBe('skill');
    expect(items.find((i) => i.name === 'init')?.group).toBe('command');
  });
  it('фильтр: префикс раньше вхождения', () => {
    expect(filterSlash(items, 'pl').map((i) => i.name)).toEqual(['plan']);
    expect(filterSlash(items, 'n').map((i) => i.name)[0]).toBe(
      'init'.startsWith('n') ? 'init' : 'plan',
    );
    expect(filterSlash(items, '').length).toBe(items.length);
  });
});

describe('история', () => {
  it('↑ из пустого поля берёт последнее, дальше старше, упирается в начало', () => {
    expect(historyStep(3, undefined, -1)).toBe(2);
    expect(historyStep(3, 2, -1)).toBe(1);
    expect(historyStep(3, 0, -1)).toBe(0);
  });
  it('↓ выходит из истории после самого нового', () => {
    expect(historyStep(3, 1, 1)).toBe(2);
    expect(historyStep(3, 2, 1)).toBeUndefined();
    expect(historyStep(3, undefined, 1)).toBeUndefined();
    expect(historyStep(0, undefined, -1)).toBeUndefined();
  });
  it('pushHistory не пишет пустое и повтор, режет по лимиту', () => {
    expect(pushHistory(['a'], ' ')).toEqual(['a']);
    expect(pushHistory(['a'], 'a')).toEqual(['a']);
    expect(pushHistory(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
  });
});

describe('собственные команды по возможностям движка', () => {
  it('Claude — все четыре; Codex — только /clear и /status', () => {
    expect(ownCommands({ modes: true, compact: true })).toEqual([
      'plan',
      'compact',
      'clear',
      'status',
    ]);
    expect(ownCommands({ modes: false, compact: false })).toEqual(['clear', 'status']);
    expect(ownCommands({ modes: false, compact: true })).toEqual(['compact', 'clear', 'status']);
  });

  it('buildSlashItems с урезанным списком не добавляет /plan и /compact', () => {
    const names = buildSlashItems(
      [],
      [],
      [],
      {},
      ownCommands({ modes: false, compact: false }),
    ).map((i) => i.name);
    expect(names).toEqual(['clear', 'status']);
  });
});
