import { describe, expect, it } from 'vitest';
import {
  isCodexNotification,
  isCodexServerRequest,
  type CodexRequests,
  type TurnStartParams,
} from './protocol';

describe('codex protocol', () => {
  it('различает server request (approval) и notification', () => {
    expect(isCodexServerRequest('item/commandExecution/requestApproval')).toBe(true);
    expect(isCodexServerRequest('item/tool/requestUserInput')).toBe(true);
    expect(isCodexServerRequest('turn/started')).toBe(false);
    expect(isCodexNotification('item/agentMessage/delta')).toBe(true);
    expect(isCodexNotification('item/commandExecution/requestApproval')).toBe(false);
    expect(isCodexNotification('toString')).toBe(false);
  });

  it('типы запросов собираются: turn/start принимает текстовый ввод', () => {
    const params: CodexRequests['turn/start'][0] = {
      threadId: 't',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    } satisfies TurnStartParams;
    expect(params.input).toHaveLength(1);
  });
});
