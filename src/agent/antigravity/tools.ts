/**
 * Инструменты agy → привычные карточки ленты (имена и форма входа как у Claude, их понимают toolView/editDiff).
 * Имена и параметры: `init.tools` (60 имён) и логи спайка; сверено живьём — run_command, write_to_file,
 * replace_file_content, view_file; остальные ключи параметров — по именам agy, не сняты (поиск и список
 * по нескольким кандидатам, не нашли — общая карточка с именем agy и сырыми параметрами).
 */

export interface MappedTool {
  /** Имя карточки: `Bash`, `Write`, `Edit`, `MultiEdit`, `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `NotebookEdit` или имя agy. */
  name: string;
  input: Record<string, unknown>;
  /** Правка файла: после DONE подтянуть дифф из транскрипта. */
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

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

export function mapAgyTool(agyName: string, params: Params | undefined): MappedTool {
  const p = params ?? {};
  const raw: MappedTool = { name: agyName, input: p };
  switch (agyName) {
    case 'run_command': {
      const command = pick(p, 'CommandLine');
      return command === undefined
        ? raw
        : { name: 'Bash', input: compact({ command, description: pick(p, 'toolSummary', 'Description'), cwd: pick(p, 'Cwd') }) };
    }
    case 'write_to_file': {
      const file = pick(p, 'TargetFile');
      return file === undefined
        ? raw
        : { name: 'Write', input: compact({ file_path: file, content: pick(p, 'CodeContent') }), edit: { targetFile: file } };
    }
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const file = pick(p, 'TargetFile');
      if (file === undefined) return raw;
      return {
        name: agyName === 'replace_file_content' ? 'Edit' : 'MultiEdit',
        input: compact({
          file_path: file,
          old_string: pick(p, 'TargetContent'),
          new_string: pick(p, 'ReplacementContent'),
        }),
        edit: { targetFile: file },
      };
    }
    case 'view_file': {
      const file = pick(p, 'AbsolutePath', 'FilePath', 'Path');
      return file === undefined ? raw : { name: 'Read', input: { file_path: file } };
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
    case 'search_web': {
      const query = pick(p, 'query', 'Query');
      return query === undefined ? raw : { name: 'WebSearch', input: { query } };
    }
    case 'notebook_edit': {
      const file = pick(p, 'TargetFile', 'NotebookPath', 'Path');
      return file === undefined ? raw : { name: 'NotebookEdit', input: { notebook_path: file } };
    }
    default:
      return raw;
  }
}
