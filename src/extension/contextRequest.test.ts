import { describe, expect, it } from 'vitest';
import { contextRequest, MAX_CONTEXT_CHARS } from './contextRequest';

describe('contextRequest', () => {
  it('без контекста — отказ', () => {
    expect(contextRequest(undefined)).toBeUndefined();
    expect(contextRequest('text')).toBeUndefined();
    expect(contextRequest({ context: '  ' })).toBeUndefined();
    expect(contextRequest({ context: 1 })).toBeUndefined();
  });

  it('имя — один сегмент пути, по умолчанию context.md', () => {
    expect(contextRequest({ context: 'x' })).toEqual({ name: 'context.md', context: 'x' });
    expect(contextRequest({ context: 'x', name: '../a/b.md' })?.name).toBe('.._a_b.md');
    expect(contextRequest({ context: 'x', name: '..' })?.name).toBe('context.md');
    expect(contextRequest({ context: 'x', name: 'GARM-710.md' })?.name).toBe('GARM-710.md');
  });

  it('ключ сессии — только непустая строка; контекст обрезается', () => {
    expect(contextRequest({ context: 'x', sessionKey: '' })).not.toHaveProperty('sessionKey');
    expect(contextRequest({ context: 'x', sessionKey: 5 })).not.toHaveProperty('sessionKey');
    expect(contextRequest({ context: 'x', sessionKey: 'jiraffe:a:K-1' })?.sessionKey).toBe(
      'jiraffe:a:K-1',
    );
    expect(contextRequest({ context: 'y'.repeat(MAX_CONTEXT_CHARS + 5) })?.context).toHaveLength(
      MAX_CONTEXT_CHARS,
    );
  });

  it('prompt — только непустая строка', () => {
    expect(contextRequest({ context: 'x', prompt: ' ' })).not.toHaveProperty('prompt');
    expect(contextRequest({ context: 'x', prompt: 'https://j.test/browse/K-1 ' })?.prompt).toBe(
      'https://j.test/browse/K-1 ',
    );
  });
});
