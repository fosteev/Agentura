/**
 * Инструменты agy → привычные карточки ленты (имена и форма входа как у Claude, их понимают toolView/editDiff).
 * Поддерживаются имена oneharness (agy 1.5.3: read_file, write_file, edit_file, run_command, search_web, ask_question)
 * и старые cortex-имена (view_file, write_to_file, replace_file_content...).
 */

export interface MappedTool {
  /** Имя карточки: `Bash`, `Write`, `Edit`, `MultiEdit`, `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `NotebookEdit` или имя agy. */
  name: string;
  input: Record<string, unknown>;
  /** Правка файла. */
  edit?: { targetFile: string | undefined };
}

type Params = Record<string, unknown>;

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

export function mapAgyTool(agyName: string, params: Params | undefined): MappedTool {
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
    default:
      return raw;
  }
}
