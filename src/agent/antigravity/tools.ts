/**
 * Инструменты agy → привычные карточки ленты (имена и форма входа как у Claude, их понимают toolView/editDiff).
 * Поддерживаются имена oneharness (agy 1.5.x: read_file, write_file, edit_file, run_command, search_web, ask_question,
 * MCP и оркестрация субагентов) и старые cortex-имена (view_file, write_to_file, replace_file_content...).
 */
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_AGY_DATA_DIR } from './context';

export interface MappedTool {
  /** Имя карточки: `Bash`, `Write`, `Edit`, `MultiEdit`, `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `NotebookEdit`, `Agent`, `mcp__<server>__<tool>` или имя agy. */
  name: string;
  input: Record<string, unknown>;
  /** Правка файла. */
  edit?: { targetFile: string | undefined };
}

type Params = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Читает имена известных MCP-серверов из подкаталогов `<dataDir>/mcp` (read-only),
 * отсортированные по убыванию длины, чтобы `mcp_<server>_<tool>` не рвался по внутреннему `_`.
 */
export function readAgyMcpServers(dataDir: string = DEFAULT_AGY_DATA_DIR): string[] {
  const mcpDir = path.join(dataDir, 'mcp');
  try {
    const entries = readdirSync(mcpDir, { withFileTypes: true });
    const servers: string[] = [];
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        servers.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(path.join(mcpDir, entry.name)).isDirectory()) {
            servers.push(entry.name);
          }
        } catch {
          // битый симлинк пропускаем
        }
      }
    }
    servers.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return servers;
  } catch {
    return [];
  }
}

function pick(params: Params, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function pickStr(params: Params, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

function omitCompact(input: Params, keys: readonly string[]): Record<string, unknown> {
  const skip = new Set(keys);
  return Object.fromEntries(
    Object.entries(input).filter(([k, v]) => !skip.has(k) && v !== undefined),
  );
}

export function mapAgyTool(
  agyName: string,
  params: Params | undefined,
  mcpServers?: readonly string[],
): MappedTool {
  const p = params ?? {};
  const raw: MappedTool = { name: agyName, input: p };
  switch (agyName) {
    case 'run_command': {
      const command = pick(p, 'CommandLine', 'command');
      return command === undefined
        ? raw
        : {
            name: 'Bash',
            input: compact({
              command,
              description: pick(p, 'toolSummary', 'Description', 'description'),
              cwd: pick(p, 'Cwd', 'cwd'),
            }),
          };
    }
    case 'read_file':
    case 'view_file': {
      const file = pick(p, 'Path', 'AbsolutePath', 'FilePath');
      return file === undefined ? raw : { name: 'Read', input: { file_path: file } };
    }
    case 'write_file':
    case 'write_to_file': {
      const file = pick(p, 'Path', 'TargetFile');
      if (file === undefined) return raw;
      const content = pickStr(p, 'Content', 'CodeContent');
      return {
        name: 'Write',
        input: compact({ file_path: file, ...(content !== undefined ? { content } : {}) }),
        edit: { targetFile: file },
      };
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const file = pick(p, 'Path', 'TargetFile');
      if (file === undefined) return raw;
      const old_string = pickStr(p, 'Target', 'TargetContent');
      const new_string = pickStr(p, 'Replacement', 'ReplacementContent');
      return {
        name: agyName === 'multi_replace_file_content' ? 'MultiEdit' : 'Edit',
        input: compact({
          file_path: file,
          ...(old_string !== undefined ? { old_string } : {}),
          ...(new_string !== undefined ? { new_string } : {}),
        }),
        edit: { targetFile: file },
      };
    }
    case 'search_web': {
      const query = pick(p, 'query', 'Query');
      return query === undefined ? raw : { name: 'WebSearch', input: compact({ query, domain: pick(p, 'domain', 'Domain') }) };
    }
    case 'ask_question': {
      return { name: 'AskUserQuestion', input: p };
    }
    case 'grep_search': {
      const pattern = pick(p, 'Query', 'Pattern');
      return pattern === undefined
        ? raw
        : { name: 'Grep', input: compact({ pattern, path: pick(p, 'SearchPath', 'SearchDirectory', 'Path') }) };
    }
    case 'find_by_name': {
      const pattern = pick(p, 'Pattern', 'Query');
      return pattern === undefined
        ? raw
        : { name: 'Glob', input: compact({ pattern, path: pick(p, 'SearchDirectory', 'SearchPath', 'Path') }) };
    }
    case 'read_url_content': {
      const url = pick(p, 'Url', 'URL');
      return url === undefined ? raw : { name: 'WebFetch', input: { url } };
    }
    case 'notebook_edit': {
      const file = pick(p, 'TargetFile', 'NotebookPath', 'Path');
      return file === undefined ? raw : { name: 'NotebookEdit', input: { notebook_path: file } };
    }
    case 'invoke_subagent': {
      return {
        name: 'Agent',
        input: compact({
          description: pick(p, 'Role', 'TypeName', 'description'),
          prompt: pick(p, 'Prompt', 'prompt'),
          subagent_type: pick(p, 'TypeName', 'subagent_type'),
          model: pick(p, 'Model', 'model'),
          workspace: pick(p, 'Workspace', 'workspace'),
        }),
      };
    }
    case 'call_mcp_tool': {
      const server = pick(p, 'ServerName', 'serverName');
      const tool = pick(p, 'ToolName', 'toolName');
      if (!server || !tool) return raw;
      const args = p['Arguments'] ?? p['arguments'];
      const input = isPlainObject(args) ? { ...args } : compact({ arguments: args });
      return { name: `mcp__${server}__${tool}`, input };
    }
    case 'list_resources': {
      const server = pick(p, 'ServerName', 'serverName');
      if (!server) return raw;
      return {
        name: `mcp__${server}__list_resources`,
        input: omitCompact(p, ['ServerName', 'serverName']),
      };
    }
    case 'read_resource': {
      const server = pick(p, 'ServerName', 'serverName');
      if (!server) return raw;
      const uri = pick(p, 'Uri', 'uri');
      return {
        name: `mcp__${server}__read_resource`,
        input: {
          ...(uri !== undefined ? { uri } : {}),
          ...omitCompact(p, ['ServerName', 'serverName', 'Uri', 'uri']),
        },
      };
    }
    default: {
      if (agyName.startsWith('mcp_') && !agyName.startsWith('mcp__')) {
        const mapped = mapEagerMcp(agyName, p, mcpServers);
        if (mapped) return mapped;
      }
      return raw;
    }
  }
}

function mapEagerMcp(
  agyName: string,
  input: Params,
  mcpServers: readonly string[] | undefined,
): MappedTool | undefined {
  const rest = agyName.slice(4);
  let matchedServer: string | undefined;
  if (mcpServers) {
    for (const s of mcpServers) {
      if (
        s &&
        rest.length > s.length + 1 &&
        rest.startsWith(s) &&
        rest[s.length] === '_' &&
        (!matchedServer || s.length > matchedServer.length)
      ) {
        matchedServer = s;
      }
    }
  }
  if (matchedServer) {
    return { name: `mcp__${matchedServer}__${rest.slice(matchedServer.length + 1)}`, input };
  }
  const idx = rest.indexOf('_');
  if (idx > 0 && idx + 1 < rest.length) {
    return { name: `mcp__${rest.slice(0, idx)}__${rest.slice(idx + 1)}`, input };
  }
  return undefined;
}
