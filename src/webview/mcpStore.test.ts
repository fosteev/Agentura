// @vitest-environment jsdom
/** Roadmap 21, этап 1: настройки `agentura.mcp.*` из `chat.info` и `skill.files` доходят до signals store. */
import { describe, expect, it } from 'vitest';
import {
  handleHostMessage,
  mcpComposerButton,
  mcpFeedLabels,
  mcpFeedStatus,
  mcpPanelTab,
  skillFiles,
} from './store';

const info = { type: 'chat.info' as const, project: 'p', cwd: '/p', allowBypass: false };

describe('store: MCP и скиллы', () => {
  it('chat.info.mcp → signals; нет поля — по умолчанию', () => {
    handleHostMessage({
      ...info,
      mcp: { feedLabels: false, composerButton: false, panelTab: false, feedStatus: 'start' },
    });
    expect([mcpFeedLabels.value, mcpComposerButton.value, mcpPanelTab.value, mcpFeedStatus.value]).toEqual([
      false,
      false,
      false,
      'start',
    ]);
    handleHostMessage(info);
    expect([mcpFeedLabels.value, mcpComposerButton.value, mcpPanelTab.value, mcpFeedStatus.value]).toEqual([
      true,
      true,
      true,
      'failures',
    ]);
  });

  it('skill.files → множество имён; session.reset очищает', () => {
    handleHostMessage({ type: 'skill.files', names: ['plan', 'plug:mine'] });
    expect([...skillFiles.value]).toEqual(['plan', 'plug:mine']);
    handleHostMessage({ type: 'session.reset' });
    expect(skillFiles.value.size).toBe(0);
  });
});
