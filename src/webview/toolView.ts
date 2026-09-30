/** Как строка инструмента `e` выглядит в ленте: глагол, что, результат справа. Чистые функции. */

export interface ToolView {
  op: string;
  /** Серая часть пути (каталог) или пояснение. */
  dim?: string;
  what: string;
  /** Класс `run` в прототипе — запуск команды. */
  run?: boolean;
  /** Порядок: `dim` перед `what` (пути) или после (grep). */
  dimAfter?: boolean;
  edit?: boolean;
}

const MAX_WHAT = 160;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function clip(s: string, max = MAX_WHAT): string {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Путь относительно cwd (без ведущего `./`); пути вне cwd не трогаем. */
export function relPath(path: string, cwd?: string): string {
  if (!cwd) return path;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** `mcp__server__tool` → `tool`. */
function shortName(name: string): string {
  return name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
}

export function toolView(name: string, input: Record<string, unknown>, cwd?: string): ToolView {
  const file = str(input['file_path']) ?? str(input['notebook_path']);
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const { dir, base } = splitPath(relPath(file ?? '', cwd));
      const op = name === 'Read' ? 'read' : name === 'Write' ? 'write' : 'edit';
      const view: ToolView = { op, what: base || '—' };
      if (dir) view.dim = dir;
      if (op !== 'read') view.edit = true;
      return view;
    }
    case 'Grep': {
      const view: ToolView = {
        op: 'grep',
        what: clip(str(input['pattern']) ?? ''),
        dimAfter: true,
      };
      const at = str(input['path']);
      if (at) view.dim = `в ${relPath(at, cwd)}`;
      return view;
    }
    case 'Glob': {
      const view: ToolView = {
        op: 'glob',
        what: clip(str(input['pattern']) ?? ''),
        dimAfter: true,
      };
      const at = str(input['path']);
      if (at) view.dim = `в ${relPath(at, cwd)}`;
      return view;
    }
    case 'Bash':
      return { op: 'bash', what: clip(str(input['command']) ?? ''), run: true };
    case 'Task':
    case 'Agent':
      return {
        op: 'agent',
        what: clip(str(input['description']) ?? str(input['prompt']) ?? ''),
      };
    case 'WebFetch':
      return { op: 'fetch', what: clip(str(input['url']) ?? '') };
    case 'WebSearch':
      return { op: 'search', what: clip(str(input['query']) ?? '') };
    case 'TodoWrite':
      return { op: 'todo', what: 'список задач' };
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string' && v) as
        string | undefined;
      return { op: shortName(name).toLowerCase().slice(0, 7), what: clip(first ?? '') };
    }
  }
}

/** Строки добавлено/удалено для Edit/Write: по `structuredPatch` результата, иначе по входу. */
export function editStats(
  name: string,
  input: Record<string, unknown>,
  result: unknown,
): { add: number; del: number } | undefined {
  if (name !== 'Edit' && name !== 'MultiEdit' && name !== 'Write') return undefined;
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
  const patch = r?.['structuredPatch'];
  if (Array.isArray(patch) && patch.length > 0) {
    let add = 0;
    let del = 0;
    for (const hunk of patch) {
      const lines = (hunk as { lines?: unknown }).lines;
      if (!Array.isArray(lines)) continue;
      for (const l of lines) {
        if (typeof l !== 'string') continue;
        if (l.startsWith('+')) add++;
        else if (l.startsWith('-')) del++;
      }
    }
    return { add, del };
  }
  const count = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0);
  if (name === 'Write') {
    const content = str(r?.['content']) ?? str(input['content']);
    return { add: count(content), del: 0 };
  }
  if (name === 'Edit') return { add: count(input['new_string']), del: count(input['old_string']) };
  return undefined;
}

/** Число найденного для grep/glob: `numFiles`/`numLines`/`filenames` результата. */
export function matchCount(name: string, result: unknown): number | undefined {
  if (name !== 'Grep' && name !== 'Glob') return undefined;
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r['numFiles'] === 'number') return r['numFiles'];
  if (Array.isArray(r['filenames'])) return r['filenames'].length;
  return undefined;
}

/** `0.4s`, `12s`, `1m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** `1 204`, как в прототипе (пробел — разделитель тысяч). */
export function formatInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatCost(usd: number): string {
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** `claude-opus-5-5` → `opus-5.5`; неизвестное — как есть. */
export function shortModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[.*\])?$/.exec(id);
  if (!m) return id;
  return `${m[1]}-${m[2]}${m[3] && m[3].length < 4 ? `.${m[3]}` : ''}`;
}
