import { describe, expect, it } from 'vitest';
import { CLAUDE_FEATURES, CODEX_FEATURES, providerFeatures } from './features';

describe('providerFeatures', () => {
  it('Claude: все возможности включены', () => {
    expect(Object.values(providerFeatures('claude')).every(Boolean)).toBe(true);
  });

  it('Codex: ни режимов, ни compact, ни приборов, ни субагентов, плана, вопросов и файлов; картинки есть', () => {
    expect(providerFeatures('codex')).toEqual({
      modes: false,
      compact: false,
      metrics: false,
      subagents: false,
      plan: false,
      questions: false,
      images: true,
      files: false,
    });
  });

  it('копия: правка результата не портит константы', () => {
    providerFeatures('codex').modes = true;
    expect(CODEX_FEATURES.modes).toBe(false);
    expect(CLAUDE_FEATURES.modes).toBe(true);
  });
});
