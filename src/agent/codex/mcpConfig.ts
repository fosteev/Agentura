import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseTOML, type AST } from 'toml-eslint-parser';

/** Меняем только значение enabled или вставляем ключ в его таблицу; комментарии и прочий TOML сохраняются. */
export function mcpEnabledConfig(source: string, name: string, enabled: boolean): string {
  const ast = parseTOML(source);
  const target = ['mcp_servers', name, 'enabled'];
  const prefix = (path: (string | number)[]) => path.every((key, i) => key === target[i]);
  let container: AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable = ast.body[0];
  let depth = 0;
  let value: AST.TOMLContentNode | undefined;
  const visit = (node: AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable, path: (string | number)[]) => {
    if (!prefix(path)) return;
    if (path.length >= depth) { container = node; depth = path.length; }
    for (const entry of node.body) {
      if (entry.type === 'TOMLTable') {
        if (entry.kind === 'standard') visit(entry, entry.resolvedKey);
        continue;
      }
      const keys = [...path, ...entry.key.keys.map((k) => k.type === 'TOMLBare' ? k.name : k.value)];
      if (!prefix(keys)) continue;
      if (keys.length === target.length) value = entry.value;
      else if (entry.value.type === 'TOMLInlineTable') visit(entry.value, keys);
      else throw new Error('MCP configuration is not a table.');
    }
  };
  visit(ast.body[0], []);
  let result: string;
  if (value) {
    result = source.slice(0, value.range[0]) + String(enabled) + source.slice(value.range[1]);
  } else {
    const key = target.slice(depth).map((s) => JSON.stringify(s)).join('.');
    const assignment = `${key} = ${enabled}`;
    // TypeScript не отслеживает присваивание container внутри visit.
    const selected = container as AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;
    if (selected.type === 'TOMLInlineTable') {
      const at = selected.range[1] - 1;
      result = source.slice(0, at) + `${selected.body.length ? ', ' : ''}${assignment}` + source.slice(at);
    } else if (selected.type === 'TOMLTable') {
      const newline = source.indexOf('\n', selected.key.range[1]);
      const at = newline < 0 ? source.length : newline + 1;
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      result = source.slice(0, at) + (newline < 0 ? eol : '') + assignment + eol + source.slice(at);
    } else result = assignment + (source.includes('\r\n') ? '\r\n' : '\n') + source;
  }
  parseTOML(result); // Не записываем результат, если нарушили структуру TOML.
  return result;
}

const writes = new Map<string, Promise<void>>();
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Только cwd/.codex/config.toml. Общий config.toml и ссылки на него не трогаем. */
export async function setProjectMcpEnabled(cwd: string, name: string, enabled: boolean): Promise<void> {
  const dir = resolve(cwd, '.codex');
  const file = join(dir, 'config.toml');
  const previous = writes.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const folder = await lstat(dir).catch((e) => { if (!missing(e)) throw e; });
    if (folder?.isSymbolicLink()) throw new Error('Project .codex is a symbolic link.');
    await mkdir(dir, { recursive: true });
    const stat = await lstat(file).catch((e) => { if (!missing(e)) throw e; });
    if (stat && !stat.isFile()) throw new Error('Project config.toml is not a regular file.');
    const read = () => readFile(file, 'utf8').catch((e) => { if (!missing(e)) throw e; return ''; });
    const source = await read();
    const result = mcpEnabledConfig(source, name, enabled);
    if (source === result) return;
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, result, { mode: stat ? stat.mode & 0o777 : 0o600, flag: 'wx' });
      if (await read() !== source) throw new Error('Project config.toml changed during the update. Retry.');
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  });
  writes.set(file, pending);
  try { await pending; } finally { if (writes.get(file) === pending) writes.delete(file); }
}
