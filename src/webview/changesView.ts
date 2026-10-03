/**
 * Вкладка «изменения»: файлы, которые агент правил за сессию (или за последний ход), и последние прогоны
 * проверок. Чистая функция по строкам ленты (`ChatState.rows`) — своего состояния нет.
 */
import type { FeedRow } from './chatState';
import { editStats, relPath, splitPath } from './toolView';

export type ChangesScope = 'session' | 'turn';

type ToolRow = Extract<FeedRow, { kind: 'tool' }>;

export interface ChangeFileView {
  /** Путь относительно cwd. */
  path: string;
  base: string;
  /** `toolUseId` правок файла в охвате (по порядку) — для `diff.changes`. */
  ids: string[];
  /** Суммы по правкам; нет у файла, где цифр взять неоткуда (MultiEdit без патча). */
  stats?: { add: number; del: number };
  /** Первая правка файла в охвате — Write, создавший файл. */
  isNew: boolean;
  /** Номера ходов, где файл правили (по возрастанию). */
  turns: number[];
  /** Файл правится прямо сейчас. */
  live: boolean;
}

export interface ChangeDirView {
  /** Каталог с хвостовым `/`; пусто — корень рабочей папки. */
  dir: string;
  files: ChangeFileView[];
}

export interface CheckView {
  command: string;
  state: 'run' | 'ok' | 'err';
  /** Длительность, мс: для идущего — сколько уже идёт. */
  ms: number;
  turn: number;
}

export interface ChangesView {
  scope: ChangesScope;
  /** Номер последнего хода ленты — подпись кнопки охвата «ход N». */
  lastTurn: number;
  dirs: ChangeDirView[];
  fileCount: number;
  add: number;
  del: number;
  /** `toolUseId` всех правок охвата — «дифф всего». */
  ids: string[];
  checks: CheckView[];
  /** Бейдж вкладки: число файлов за сессию; `live` — в последнем ходе идёт Edit/Write. */
  badge?: { count: number; live: boolean };
}

export const MAX_CHECKS = 6;

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
/** Программы-проверки: сами по себе (`tsc --noEmit`, `node_modules/.bin/vitest`) или первым словом после раннера. */
const CHECK_TOOLS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'playwright', 'eslint', 'tsc']);
/** Слова в имени скрипта/подкоманды раннера: `npm run check`, `npm run test:unit`, `go test`, `make lint`. */
const CHECK_WORDS = new Set(['test', 'tests', 'lint', 'check', 'typecheck', 'e2e']);
const RUNNERS = new Set([
  ...['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'deno'],
  ...['cargo', 'go', 'make', 'python', 'python3', 'uv', 'poetry'],
]);
/** Слова раннера перед именем скрипта: `npm run`, `pnpm exec`, `yarn dlx`, `uv run`. */
const RUNNER_VERBS = new Set(['run', 'run-script', 'exec', 'dlx', 'x']);
/** Обёртки перед программой: `time npm test`, `timeout 60 npm test`, `env CI=1 npm test`. */
const WRAPPERS = new Set(['time', 'timeout', 'env', 'nice', 'command']);

/**
 * Команда Bash похожа на проверку (тесты, линт, типы). Смотрим на программу каждой простой команды
 * (`a && b; c | d`), а не на любое слово в строке: `ls test/`, `git commit -m "fix test"`, `git checkout`
 * проверками не считаются.
 */
export function isCheckCommand(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((part) => isCheckPart(part.trim().split(/\s+/)));
}

/** `playwright` — проверка только `playwright test` (`install`, `codegen` — нет). */
function isCheckTool(tool: string, args: string[]): boolean {
  return tool !== 'playwright' || args[0] === 'test';
}

function isCheckPart(tokens: string[]): boolean {
  let i = 0;
  // `VAR=x`, обёртки и их числовые аргументы (`timeout 60`)
  while (
    i < tokens.length &&
    (/^\w+=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!) || /^\d+[smh]?$/.test(tokens[i]!))
  )
    i++;
  const prog = (tokens[i] ?? '').split('/').pop()!;
  const rest = tokens.slice(i + 1).filter((t) => !t.startsWith('-'));
  if (CHECK_TOOLS.has(prog)) return isCheckTool(prog, rest);
  if (!RUNNERS.has(prog)) return false;
  // первое слово после раннера, без флагов (`-m`, `--silent`) и глаголов (`run`, `exec`)
  const at = rest.findIndex((t) => !RUNNER_VERBS.has(t));
  const arg = rest[at];
  if (!arg) return false;
  if (CHECK_TOOLS.has(arg)) return isCheckTool(arg, rest.slice(at + 1));
  return arg
    .toLowerCase()
    .split(/[:._-]/)
    .some((w) => CHECK_WORDS.has(w));
}

interface Edit {
  row: ToolRow;
  path: string;
  turn: number;
}

export function changesView(
  rows: readonly FeedRow[],
  opts: { scope: ChangesScope; now: number; cwd?: string },
): ChangesView {
  // ход строки — число отправленных (не «в очереди») сообщений до неё, но не меньше 1
  let users = 0;
  const edits: Edit[] = [];
  const checkRows: { row: ToolRow; turn: number }[] = [];
  for (const row of rows) {
    if (row.kind === 'user') {
      // сообщение «в очереди» — ход ещё не начался, номер не сдвигаем
      if (!row.queued) users++;
      continue;
    }
    if (row.kind !== 'tool') continue;
    const turn = Math.max(1, users);
    if (EDIT_TOOLS.has(row.name)) {
      if (row.state === 'err' || row.state === 'stopped') continue;
      const file = row.input['file_path'];
      if (typeof file !== 'string' || !file) continue;
      edits.push({ row, path: relPath(file, opts.cwd), turn });
    } else if (row.name === 'Bash') {
      const command = row.input['command'];
      // фоновый запуск кончается сразу (✓ за 0 с) — исхода проверки в строке нет
      if (row.input['run_in_background'] === true) continue;
      if (typeof command === 'string' && isCheckCommand(command)) checkRows.push({ row, turn });
    }
  }
  const lastTurn = Math.max(1, users);

  const sessionFiles = new Set(edits.map((e) => e.path));
  const live = edits.some((e) => e.turn === lastTurn && e.row.state === 'run');

  const scoped = opts.scope === 'turn' ? edits.filter((e) => e.turn === lastTurn) : edits;
  const byPath = new Map<string, ChangeFileView>();
  for (const e of scoped) {
    let f = byPath.get(e.path);
    if (!f) {
      f = {
        path: e.path,
        base: splitPath(e.path).base,
        ids: [],
        isNew: e.row.name === 'Write' && resultType(e.row.result) === 'create',
        turns: [],
        live: false,
      };
      byPath.set(e.path, f);
    }
    f.ids.push(e.row.toolUseId);
    if (!f.turns.includes(e.turn)) f.turns.push(e.turn);
    if (e.row.state === 'run') f.live = true;
    const st = editStats(e.row.name, e.row.input, e.row.result);
    if (st) {
      f.stats = { add: (f.stats?.add ?? 0) + st.add, del: (f.stats?.del ?? 0) + st.del };
    }
  }

  // папки — в порядке первой правки, файлы внутри — тоже
  const dirs: ChangeDirView[] = [];
  const dirIdx = new Map<string, ChangeDirView>();
  let add = 0;
  let del = 0;
  for (const f of byPath.values()) {
    const dir = splitPath(f.path).dir;
    let d = dirIdx.get(dir);
    if (!d) {
      d = { dir, files: [] };
      dirIdx.set(dir, d);
      dirs.push(d);
    }
    d.files.push(f);
    add += f.stats?.add ?? 0;
    del += f.stats?.del ?? 0;
  }

  // последний прогон каждой команды (ключ — команда после trim), новые сверху
  const last = new Map<string, { row: ToolRow; turn: number }>();
  for (const c of checkRows) {
    const key = (c.row.input['command'] as string).trim();
    last.delete(key); // повторный прогон — в конец порядка вставки
    last.set(key, c);
  }
  const checks = [...last.entries()]
    .reverse()
    .slice(0, MAX_CHECKS)
    .map(([command, { row, turn }]): CheckView => {
      const running = row.state === 'run';
      return {
        command,
        state: running ? 'run' : row.state === 'ok' ? 'ok' : 'err',
        ms: running
          ? (row.elapsedMs ?? Math.max(0, opts.now - row.startedAt))
          : (row.durationMs ?? 0),
        turn,
      };
    });

  const view: ChangesView = {
    scope: opts.scope,
    lastTurn,
    dirs,
    fileCount: byPath.size,
    add,
    del,
    ids: scoped.map((e) => e.row.toolUseId),
    checks,
  };
  if (sessionFiles.size > 0) view.badge = { count: sessionFiles.size, live };
  return view;
}

function resultType(result: unknown): unknown {
  return result && typeof result === 'object' ? (result as Record<string, unknown>)['type'] : undefined;
}
