import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapAgyTool, readAgyMcpServers } from './tools';

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

  it('reads MCP server directories sorted longest-first and handles missing dirs safely', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-test-'));
    try {
      expect(readAgyMcpServers(tmp)).toEqual([]);

      const mcpDir = path.join(tmp, 'mcp');
      const extTarget = path.join(tmp, 'external-server');
      mkdirSync(mcpDir);
      mkdirSync(extTarget);
      mkdirSync(path.join(mcpDir, 'hansard_history'));
      mkdirSync(path.join(mcpDir, 'gemini-api_gemini-api-docs'));
      mkdirSync(path.join(mcpDir, '.hidden_server'));
      writeFileSync(path.join(mcpDir, 'README.md'), 'not a server');
      symlinkSync(extTarget, path.join(mcpDir, 'flutter_dart-mcp-server'));
      symlinkSync(path.join(tmp, 'missing-target'), path.join(mcpDir, 'broken_link'));

      expect(readAgyMcpServers(tmp)).toEqual([
        'gemini-api_gemini-api-docs',
        'flutter_dart-mcp-server',
        'hansard_history',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('maps lazy MCP tools (call_mcp_tool, list_resources, read_resource) to mcp__<server>__<tool>', () => {
    expect(
      mapAgyTool('call_mcp_tool', {
        ServerName: 'hansard_history',
        ToolName: 'search_past_sessions',
        Arguments: { query: 'subagent', repo: 'agentura' },
      }),
    ).toEqual({
      name: 'mcp__hansard_history__search_past_sessions',
      input: { query: 'subagent', repo: 'agentura' },
    });

    expect(
      mapAgyTool('call_mcp_tool', {
        ServerName: 'flutter_dart-mcp-server',
        ToolName: 'roots',
      }),
    ).toEqual({
      name: 'mcp__flutter_dart-mcp-server__roots',
      input: {},
    });

    expect(mapAgyTool('call_mcp_tool', { ToolName: 'orphan' })).toEqual({
      name: 'call_mcp_tool',
      input: { ToolName: 'orphan' },
    });

    expect(mapAgyTool('list_resources', { ServerName: 'hansard_history' })).toEqual({
      name: 'mcp__hansard_history__list_resources',
      input: {},
    });

    expect(
      mapAgyTool('read_resource', {
        ServerName: 'hansard_history',
        Uri: 'session://123',
      }),
    ).toEqual({
      name: 'mcp__hansard_history__read_resource',
      input: { uri: 'session://123' },
    });
  });

  it('maps eager MCP tools using longest known server prefix with fallback to first underscore', () => {
    const servers = [
      'gemini-api_gemini-api-docs',
      'flutter_dart-mcp-server',
      'hansard_history',
      'gemini-api',
    ];

    expect(
      mapAgyTool('mcp_hansard_history_search_past_sessions', { query: 'auth' }, servers),
    ).toEqual({
      name: 'mcp__hansard_history__search_past_sessions',
      input: { query: 'auth' },
    });

    expect(
      mapAgyTool(
        'mcp_gemini-api_gemini-api-docs_gemini_search_docs',
        { query: 'links.create', toolSummary: 'Search docs' },
        servers,
      ),
    ).toEqual({
      name: 'mcp__gemini-api_gemini-api-docs__gemini_search_docs',
      input: { query: 'links.create', toolSummary: 'Search docs' },
    });

    expect(
      mapAgyTool('mcp_flutter_dart-mcp-server_analyze_files', { toolSummary: 'Analyze' }, servers),
    ).toEqual({
      name: 'mcp__flutter_dart-mcp-server__analyze_files',
      input: { toolSummary: 'Analyze' },
    });

    // Fallback when server is not in mcpServers
    expect(mapAgyTool('mcp_custom_list_items', { limit: 10 }, servers)).toEqual({
      name: 'mcp__custom__list_items',
      input: { limit: 10 },
    });

    // Already canonical mcp__<server>__<tool> is not mangled
    expect(mapAgyTool('mcp__serena__find_symbol', { name_path: 'Foo' }, servers)).toEqual({
      name: 'mcp__serena__find_symbol',
      input: { name_path: 'Foo' },
    });

    // Malformed mcp_ without tool tail stays raw
    expect(mapAgyTool('mcp_notool', {}, servers)).toEqual({
      name: 'mcp_notool',
      input: {},
    });
  });

  it('maps invoke_subagent to Agent and keeps SKILL.md read_file as Read', () => {
    expect(
      mapAgyTool('invoke_subagent', {
        TypeName: 'research',
        Role: 'Codebase Researcher',
        Prompt: 'Inspect adapter.ts',
        Model: 'inherit',
        Workspace: 'inherit',
      }),
    ).toEqual({
      name: 'Agent',
      input: {
        description: 'Codebase Researcher',
        prompt: 'Inspect adapter.ts',
        subagent_type: 'research',
        model: 'inherit',
        workspace: 'inherit',
      },
    });

    expect(
      mapAgyTool('read_file', {
        Path: '/Users/fost/.gemini/config/skills/plan/SKILL.md',
      }),
    ).toEqual({
      name: 'Read',
      input: { file_path: '/Users/fost/.gemini/config/skills/plan/SKILL.md' },
    });
  });
});
