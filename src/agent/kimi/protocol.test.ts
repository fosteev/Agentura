import { describe, expect, it } from 'vitest';
import type { PromptFile, PromptImage } from '../types';
import {
  KIMI_CLIENT_CAPABILITIES,
  KIMI_PROTOCOL_VERSION,
  commandsOf,
  isEffort,
  modelOptionsFrom,
  parseConfig,
  permissionModeOf,
  promptBlocks,
} from './protocol';
import { makeKimiConfigOptions } from './fakeServer';

describe('Kimi ACP protocol', () => {
  it('declares protocol 1 with fs/terminal off and elicitation.form enabled', () => {
    expect(KIMI_PROTOCOL_VERSION).toBe(1);
    expect(KIMI_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} },
    });
  });

  it('parses real config shape and keeps boolean thinking out of EffortLevel', () => {
    const config = parseConfig({ configOptions: makeKimiConfigOptions() });
    expect(modelOptionsFrom(config).find((model) => model.value === 'kimi-code/k3.1-pro')).toMatchObject({
      supportsEffort: true, effortLevels: ['low', 'high', 'max'],
    });
    const booleanConfig = parseConfig({
      configOptions: [{
        id: 'model', currentValue: 'kimi-code/kimi-for-coding-highspeed',
        options: [{ value: 'kimi-code/kimi-for-coding-highspeed', name: 'Highspeed' }],
      }, {
        id: 'thinking', currentValue: 'on', options: [{ value: 'on', name: 'Thinking On' }],
      }],
    });
    expect(modelOptionsFrom(booleanConfig)[0]).toMatchObject({ supportsEffort: false });
    expect(isEffort('on')).toBe(false);
    expect(isEffort('max')).toBe(true);
    expect(permissionModeOf('auto', false)).toBe('acceptEdits');
    expect(permissionModeOf('yolo', false)).toBe('default');
    expect(permissionModeOf('yolo', true)).toBe('bypassPermissions');
  });

  it('drops _commandsCount and preserves command hints', () => {
    expect(commandsOf({
      availableCommands: [
        { name: 'compact', description: 'Compact', input: { hint: '<optional>' } },
        { name: 'usage' }, { _commandsCount: 60 },
      ],
    })).toEqual([
      { name: 'compact', description: 'Compact', argumentHint: '<optional>' },
      { name: 'usage', description: '' },
    ]);
  });

  it('formats images and embedded text resources without turning PDF into a successful block', () => {
    const image: PromptImage = { mediaType: 'image/png', data: 'QUJD' };
    const files: PromptFile[] = [
      { kind: 'text', path: 'notes/a.txt', data: 'RESOURCE_MARKER_1002', size: 20 },
      { kind: 'pdf', path: 'a.pdf', data: 'JVBERi0=', size: 8 },
    ];
    expect(promptBlocks('/work', 'inspect', [image], files)).toEqual([
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      {
        type: 'resource',
        resource: { uri: 'file:///work/notes/a.txt', mimeType: 'text/plain', text: 'RESOURCE_MARKER_1002' },
      },
      { type: 'text', text: 'inspect' },
    ]);
    expect(promptBlocks('/work', '', [], [])).toEqual([]);
  });
});
