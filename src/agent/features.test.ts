import { describe, expect, it } from 'vitest';
import { CLAUDE_FEATURES, CODEX_FEATURES, providerFeatures } from './features';

describe('providerFeatures', () => {
  it('Claude: все возможности включены, кроме «перезапустить все MCP» (это Codex)', () => {
    const { mcpReloadAll, ...rest } = providerFeatures('claude');
    expect(Object.values(rest).every(Boolean)).toBe(true);
    expect(mcpReloadAll).toBe(false);
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
      mcp: true,
      mcpReconnect: false,
      mcpReloadAll: true,
      skills: false,
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
      mcp: false,
      mcpReconnect: false,
      mcpReloadAll: false,
      skills: false,
    });
  });

  it('копия: правка результата не портит константы', () => {
    providerFeatures('codex').modes = true;
    expect(CODEX_FEATURES.modes).toBe(false);
    expect(CLAUDE_FEATURES.modes).toBe(true);
  });
});
