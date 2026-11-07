import { describe, expect, it } from 'vitest';
import { mapAgyTool } from './tools';

describe('antigravity tools: mapAgyTool', () => {
  it('maps new agy 1.5.3 oneharness tools', () => {
    // run_command -> Bash
    expect(
      mapAgyTool('run_command', {
        CommandLine: 'ls -la',
        toolSummary: 'List files',
        Cwd: '/work',
      }),
    ).toEqual({
      name: 'Bash',
      input: { command: 'ls -la', description: 'List files', cwd: '/work' },
    });

    // read_file -> Read
    expect(
      mapAgyTool('read_file', {
        Path: '/work/file.txt',
        StartLine: 1,
        EndLine: 10,
      }),
    ).toEqual({
      name: 'Read',
      input: { file_path: '/work/file.txt' },
    });

    // write_file -> Write
    expect(
      mapAgyTool('write_file', {
        Path: '/work/out.txt',
        Content: 'new content\n',
        Overwrite: true,
      }),
    ).toEqual({
      name: 'Write',
      input: { file_path: '/work/out.txt', content: 'new content\n' },
      edit: { targetFile: '/work/out.txt' },
    });

    // edit_file -> Edit
    expect(
      mapAgyTool('edit_file', {
        Path: '/work/out.txt',
        Target: 'old',
        Replacement: 'new',
      }),
    ).toEqual({
      name: 'Edit',
      input: { file_path: '/work/out.txt', old_string: 'old', new_string: 'new' },
      edit: { targetFile: '/work/out.txt' },
    });

    // search_web -> WebSearch
    expect(
      mapAgyTool('search_web', {
        query: 'vitest documentation',
        domain: 'vitest.dev',
      }),
    ).toEqual({
      name: 'WebSearch',
      input: { query: 'vitest documentation', domain: 'vitest.dev' },
    });

    // ask_question -> AskUserQuestion
    expect(
      mapAgyTool('ask_question', {
        questions: [{ question: 'Color?' }],
      }),
    ).toEqual({
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Color?' }] },
    });
  });

  it('maps legacy cortex tools for backward compatibility', () => {
    expect(mapAgyTool('view_file', { AbsolutePath: '/a/b.ts' })).toEqual({
      name: 'Read',
      input: { file_path: '/a/b.ts' },
    });

    expect(mapAgyTool('write_to_file', { TargetFile: '/a/b.ts', CodeContent: 'code' })).toEqual({
      name: 'Write',
      input: { file_path: '/a/b.ts', content: 'code' },
      edit: { targetFile: '/a/b.ts' },
    });

    expect(
      mapAgyTool('replace_file_content', {
        TargetFile: '/a/b.ts',
        TargetContent: 'before',
        ReplacementContent: 'after',
      }),
    ).toEqual({
      name: 'Edit',
      input: { file_path: '/a/b.ts', old_string: 'before', new_string: 'after' },
      edit: { targetFile: '/a/b.ts' },
    });

    expect(
      mapAgyTool('multi_replace_file_content', {
        TargetFile: '/a/b.ts',
        TargetContent: 'before',
        ReplacementContent: 'after',
      }),
    ).toEqual({
      name: 'MultiEdit',
      input: { file_path: '/a/b.ts', old_string: 'before', new_string: 'after' },
      edit: { targetFile: '/a/b.ts' },
    });

    expect(mapAgyTool('grep_search', { Query: 'pattern', SearchPath: '/src' })).toEqual({
      name: 'Grep',
      input: { pattern: 'pattern', path: '/src' },
    });

    expect(mapAgyTool('find_by_name', { Pattern: '*.ts', SearchDirectory: '/src' })).toEqual({
      name: 'Glob',
      input: { pattern: '*.ts', path: '/src' },
    });

    expect(mapAgyTool('read_url_content', { Url: 'https://example.com' })).toEqual({
      name: 'WebFetch',
      input: { url: 'https://example.com' },
    });

    expect(mapAgyTool('notebook_edit', { NotebookPath: '/work/nb.ipynb' })).toEqual({
      name: 'NotebookEdit',
      input: { notebook_path: '/work/nb.ipynb' },
    });
  });

  it('returns raw tool name and params for unknown tools', () => {
    expect(mapAgyTool('custom_tool', { foo: 'bar' })).toEqual({
      name: 'custom_tool',
      input: { foo: 'bar' },
    });
  });
});
