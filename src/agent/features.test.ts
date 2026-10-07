import { describe, expect, it } from 'vitest';
import { CLAUDE_FEATURES, CODEX_FEATURES, providerFeatures } from './features';

describe('providerFeatures', () => {
  it('Claude: все возможности включены', () => {
    expect(Object.values(providerFeatures('claude')).every(Boolean)).toBe(true);
  });

  it('Codex: контекст, субагенты, вопросы и картинки есть; режимов, compact, цены, плана и файлов нет', () => {
    expect(providerFeatures('codex')).toEqual({
      modes: false,
      compact: false,
      context: true,
      cost: false,
      subagents: true,
      plan: false,
      questions: true,
      images: true,
      files: false,
      remote: false,
    });
  });

  it('Antigravity: режимы есть; compact, приборов, субагентов, плана, вопросов, картинок и файлов нет', () => {
    expect(providerFeatures('antigravity')).toEqual({
      modes: true,
      compact: false,
      context: false,
      cost: false,
      subagents: false,
      plan: false,
      questions: false,
      images: false,
      files: false,
      remote: false,
    });
  });

  it('копия: правка результата не портит константы', () => {
    providerFeatures('codex').modes = true;
    expect(CODEX_FEATURES.modes).toBe(false);
    expect(CLAUDE_FEATURES.modes).toBe(true);
  });
});
