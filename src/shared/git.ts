/**
 * Вкладка «git» (roadmap 12): снимок рабочего дерева и запросы webview → хост. Общий модуль хоста и
 * webview — без `vscode` и без `git.d.ts` (там `const enum`, при `isolatedModules` их значения недоступны).
 */

/** Буква статуса файла в строке вкладки. `C` — конфликт, а не «скопирован». */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'T';

export interface GitFileView {
  /** Путь от корня репозитория, разделитель `/`. */
  path: string;
  status: GitFileStatus;
  /** Прежний путь (переименование `R`), от корня репозитория. */
  from?: string;
  /** Строки +/−: только пока вкладка открыта хоть в одной панели (`git.watch`). */
  add?: number;
  del?: number;
  binary?: boolean;
}

export interface GitCommitView {
  /** Первые 7 символов. */
  hash: string;
  subject: string;
  /** Время коммита, мс; 0 — неизвестно. */
  at: number;
  /** Среди первых `ahead` коммитов — ещё не в upstream. */
  unpushed: boolean;
}

/** Идущая операция репозитория — кнопки вкладки гаснут. */
export type GitBusy =
  'stage' | 'unstage' | 'discard' | 'commit' | 'fetch' | 'pull' | 'push' | 'checkout';

export interface GitRepoView {
  /** Корень, абсолютный путь (как `fsPath`). */
  root: string;
  /** Корень от cwd чата, разделитель `/`: `''` — сам cwd, `..` — cwd внутри репозитория глубже корня. */
  rel: string;
  name: string;
  /** Имя ветки; detached HEAD — первые 7 символов коммита. */
  branch?: string;
  detached?: boolean;
  /** `origin/main`. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Есть upstream (detached HEAD — тоже `true`: публиковать нечего). */
  published: boolean;
  op?: 'merge' | 'rebase';
  busy?: GitBusy;
  unstaged: GitFileView[];
  staged: GitFileView[];
  /** Последние коммиты — читаются вместе с цифрами +/−, без открытой вкладки пусто. */
  log: GitCommitView[];
}

export interface GitSnapshot {
  /** `unavailable` — нет расширения `vscode.git` или оно выключено; `none` — репозиториев для cwd нет. */
  state: 'ok' | 'unavailable' | 'none';
  /** Почему `unavailable` — текст для пользователя на языке интерфейса. */
  reason?: string;
  repos: GitRepoView[];
}

export type GitSyncOp = 'fetch' | 'pull' | 'push';

/** Операция в `git.error`. */
export type GitOp =
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'commit'
  | GitSyncOp
  | 'branch'
  | 'open'
  | 'openFile'
  /** ✦ сообщение коммита моделью. */
  | 'message';

/** Запросы вкладки «git» (часть `FromWebview`). Пути — от корня репозитория `root`. */
export type GitRequest =
  /** Вкладка «git» открыта (видна) в этой панели — хост считает +/− и лог. */
  | { type: 'git.watch'; on: boolean }
  | { type: 'git.stage'; root: string; paths: string[] }
  | { type: 'git.unstage'; root: string; paths: string[] }
  /** Модальное подтверждение — на хосте. */
  | { type: 'git.discard'; root: string; paths: string[] }
  /**
   * По очереди в каждый `root`; ошибка в одном не отменяет остальные. `all` — «Коммит всех изменений»
   * (`commit({ all: true })`, без индекса). Итог — `git.commit.result`.
   */
  | {
      type: 'git.commit';
      roots: string[];
      message: string;
      amend: boolean;
      push: boolean;
      all?: boolean;
    }
  /** Без `root` — во всех репозиториях панели. */
  | { type: 'git.sync'; root?: string; op: GitSyncOp }
  | { type: 'git.branch'; root: string }
  | { type: 'git.open'; root: string; path: string; staged: boolean }
  | { type: 'git.openFile'; root: string; path: string }
  /** Пустое состояние: команда VS Code `git.openRepository` (выбрать папку с репозиторием). */
  | { type: 'git.openRepository' }
  /**
   * ✦: сообщение коммита пишет модель по индексу `roots` (в `unified` — всех отмеченных, одним запросом).
   * Ответ — `git.message.result` с теми же `roots` или `git.error {op: 'message'}`.
   */
  | { type: 'git.message'; roots: string[] };

/** Итог коммита в одном репозитории. */
export interface GitCommitResult {
  root: string;
  ok: boolean;
  /** Коммит прошёл, push — нет (`push: true`). */
  pushed?: boolean;
  error?: string;
}

/** Сообщения хоста вкладке «git» (часть `ToWebview`). */
export type GitNotice =
  | { type: 'git.state'; snapshot: GitSnapshot }
  | { type: 'git.error'; root?: string; op: GitOp; message: string }
  | { type: 'git.commit.result'; results: GitCommitResult[] }
  /** Ответ на `git.message`: `roots` — как в запросе (по ним webview находит черновик). */
  | { type: 'git.message.result'; roots: string[]; summary: string; desc: string };

/**
 * Значения `Status` из `git.d.ts` (`const enum`, порядок объявления). Сверка с типами — в `gitService.ts`
 * (`STATUS_CHECK`): разъедутся — не скомпилируется.
 */
export const GIT_STATUS = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const;

const LETTERS: Partial<Record<number, GitFileStatus>> = {
  [GIT_STATUS.INDEX_MODIFIED]: 'M',
  [GIT_STATUS.INDEX_ADDED]: 'A',
  [GIT_STATUS.INDEX_DELETED]: 'D',
  [GIT_STATUS.INDEX_RENAMED]: 'R',
  // копия в индексе — новый файл
  [GIT_STATUS.INDEX_COPIED]: 'A',
  [GIT_STATUS.MODIFIED]: 'M',
  [GIT_STATUS.DELETED]: 'D',
  [GIT_STATUS.UNTRACKED]: 'U',
  [GIT_STATUS.INTENT_TO_ADD]: 'U',
  [GIT_STATUS.INTENT_TO_RENAME]: 'R',
  [GIT_STATUS.TYPE_CHANGED]: 'T',
  [GIT_STATUS.ADDED_BY_US]: 'C',
  [GIT_STATUS.ADDED_BY_THEM]: 'C',
  [GIT_STATUS.DELETED_BY_US]: 'C',
  [GIT_STATUS.DELETED_BY_THEM]: 'C',
  [GIT_STATUS.BOTH_ADDED]: 'C',
  [GIT_STATUS.BOTH_DELETED]: 'C',
  [GIT_STATUS.BOTH_MODIFIED]: 'C',
};

/** Буква статуса по `Status` встроенного git; `undefined` — файл во вкладку не идёт (`IGNORED`, неизвестный). */
export function gitStatus(status: number): GitFileStatus | undefined {
  return LETTERS[status];
}

/** Запрос вкладки «git» — его разбирает `GitService`, а не контроллер чата. */
export function isGitRequest<T extends { type: string }>(m: T): m is T & GitRequest {
  return m.type.startsWith('git.');
}
