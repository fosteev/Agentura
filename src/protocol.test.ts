import { describe, expect, it, vi } from 'vitest';
import { isFromWebview, postToHost, postToWebview, AGENT_EVENT_TYPES } from './protocol';

describe('protocol', () => {
  it('принимает известные сообщения webview и отбрасывает мусор', () => {
    expect(isFromWebview({ type: 'ready' })).toBe(true);
    expect(isFromWebview({ type: 'limits.refresh' })).toBe(true);
    expect(isFromWebview({ type: 'send', sessionId: 's', text: 'привет' })).toBe(true);
    expect(isFromWebview({ type: 'preview.open', path: '/a/x.html' })).toBe(true);
    expect(isFromWebview({ type: 'link.open', url: 'https://claude.ai/artifact/1' })).toBe(true);
    expect(isFromWebview({ type: 'diff.changes', sessionId: 's', toolUseIds: ['t'] })).toBe(true);
    expect(isFromWebview({ type: 'unknown' })).toBe(false);
    expect(isFromWebview({ type: 'toString' })).toBe(false);
    expect(isFromWebview(null)).toBe(false);
    expect(isFromWebview('ready')).toBe(false);
  });

  it('обёртки postMessage передают сообщение как есть', () => {
    const toWebview = vi.fn().mockResolvedValue(true);
    postToWebview({ postMessage: toWebview }, { type: 'init', surface: 'chat', version: '0.0.1' });
    expect(toWebview).toHaveBeenCalledWith({ type: 'init', surface: 'chat', version: '0.0.1' });

    const toHost = vi.fn();
    postToHost({ postMessage: toHost }, { type: 'ready' });
    expect(toHost).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('список событий этапа 2 без дублей', () => {
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
  });
});
