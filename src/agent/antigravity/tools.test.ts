import { describe, expect, it } from 'vitest';
import { mapAgyTool } from './tools';

describe('mapAgyTool', () => {
  it('run_command → Bash с командой и описанием', () => {
    expect(mapAgyTool('run_command', { CommandLine: 'echo done', Cwd: '/tmp/x', toolSummary: 'Run echo done' })).toEqual({
      name: 'Bash',
      input: { command: 'echo done', description: 'Run echo done', cwd: '/tmp/x' },
    });
  });

  it('write_to_file / replace_file_content / multi_replace → Write / Edit / MultiEdit, помечены как правки', () => {
    expect(mapAgyTool('write_to_file', { TargetFile: '/a', CodeContent: 'hi' })).toEqual({
      name: 'Write',
      input: { file_path: '/a', content: 'hi' },
      edit: { targetFile: '/a' },
    });
    // в стриме параметры короткие — только TargetFile
    expect(mapAgyTool('replace_file_content', { TargetFile: '/a' })).toEqual({
      name: 'Edit',
      input: { file_path: '/a' },
      edit: { targetFile: '/a' },
    });
    expect(mapAgyTool('multi_replace_file_content', { TargetFile: '/a' }).name).toBe('MultiEdit');
  });

  it('чтение, поиск, сеть', () => {
    expect(mapAgyTool('view_file', { AbsolutePath: '/a' })).toEqual({ name: 'Read', input: { file_path: '/a' } });
    expect(mapAgyTool('grep_search', { Query: 'x', SearchPath: '/d' })).toEqual({ name: 'Grep', input: { pattern: 'x', path: '/d' } });
    expect(mapAgyTool('find_by_name', { Pattern: '*.md', SearchDirectory: '/d' })).toEqual({ name: 'Glob', input: { pattern: '*.md', path: '/d' } });
    expect(mapAgyTool('read_url_content', { Url: 'https://e.x' })).toEqual({ name: 'WebFetch', input: { url: 'https://e.x' } });
    expect(mapAgyTool('search_web', { query: 'q' })).toEqual({ name: 'WebSearch', input: { query: 'q' } });
  });

  it('незнакомый инструмент или неожиданные параметры — имя agy и сырые параметры, без падения', () => {
    expect(mapAgyTool('browser_click_element', { Id: 3 })).toEqual({ name: 'browser_click_element', input: { Id: 3 } });
    expect(mapAgyTool('run_command', { Other: 1 })).toEqual({ name: 'run_command', input: { Other: 1 } });
    expect(mapAgyTool('write_to_file', undefined)).toEqual({ name: 'write_to_file', input: {} });
  });
});
