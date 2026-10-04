/**
 * Протокол extension ↔ webview. События агента — `AgentEvent` из `src/agent/types.ts` (этап 2):
 * webview получает их как есть в сообщении `agent.event`.
 */
import type {
  AgentEvent,
  CommandOption,
  EffortLevel,
  LimitWindow,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PromptFile,
  PromptImage,
} from './agent/types';
import type { Attachment, FileHit } from './shared/prompt';
import type { ImageProblem } from './shared/images';
import type { FileProblem } from './shared/files';
import type {
  EngineCheck,
  AgentsView,
  FeedStyle,
  SessionListMode,
  SettingKey,
  SidebarTopMode,
  SettingsValues,
} from './settings';

export type {
  AgentEvent,
  Attachment,
  CommandOption,
  FileHit,
  ModelOption,
  PermissionDecision,
  PermissionMode,
};

/**
 * Превью правки для карточки разрешения (этап 5): хост читает файл, строит дифф «до → после»
 * (`src/extension/editDiff.ts`) и присылает ханки с номерами строк.
 */
export interface EditPreview {
  filePath: string;
  add: number;
  del: number;
  hunks: { header: string; lines: string[] }[];
  /** Сколько строк ханков не поместилось в превью (полный дифф — «открыть дифф»). */
  hidden: number;
  /** Новый файл (Write без файла на диске). */
  isNew: boolean;
  /**
   * `fragment` — `old_string` в файле не найден (или файл не прочитан): превью по фрагментам
   * правки без номеров строк; `too-large` — дифф не посчитан, только счётчики.
   */
  note?: 'fragment' | 'too-large';
}

/** Решение по карточке плана (этап 5): кнопки «Выполнять», «…принимая правки», «Доработать», «Отклонить». */
export type PlanChoice = 'run' | 'run-edits' | 'refine' | 'reject';

/** Открытый файл и выделение активного редактора (автоконтекст, B3). */
export interface EditorContext {
  file?: { path: string; name: string };
  selection?: { path: string; name: string; startLine: number; endLine: number };
}

/**
 * Имена событий агента. Список этапа 1 плюс три события, добавленных на этапе 2 (записаны в
 * roadmap, «Решения по итогам сессии 2»): `session.title`, `permission.resolved`, `session.closed`.
 */
export const AGENT_EVENT_TYPES = [
  'session.init',
  'session.title', // этап 2: system/session_title_changed — название для заголовка и списка сессий
  'turn.start',
  'turn.input', // приёмка этапа 3: сообщение влито движком в идущий ход — снять «в очереди»
  'text.delta',
  'thinking.start',
  'thinking.delta',
  'thinking.stop',
  'tool.start',
  'tool.progress',
  'tool.result',
  'permission.request',
  'question.request',
  'plan.request',
  'permission.resolved', // этап 2: запрос закрыт (ответ или отмена движком) — снять карточку
  'usage.message',
  'context.usage',
  'turn.result',
  'compaction.start',
  'compaction.end',
  'agent.start',
  'agent.progress',
  'agent.end',
  'limit.update',
  'mode.changed',
  'session.closed', // этап 2 (приёмка): движок завершился / сессия закрыта — последнее событие потока
  'error',
] as const satisfies readonly AgentEvent['type'][];

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// Список и union совпадают: новое событие без записи в список не соберётся.
type MissingEventType = Exclude<AgentEvent['type'], AgentEventType>;
const _allEventTypesListed: MissingEventType extends never ? true : MissingEventType = true;
void _allEventTypesListed;

/**
 * Extension → webview.
 *
 * Этап 3 добавил: `chat.info`, `capabilities`, `editor.context`, `files.result`, `attach.picked`,
 * `session.reset` (записаны в roadmap, «Решения по итогам сессии 3»), этап 5 — `diff.preview`. Одна вкладка чата = одна
 * сессия: `sessionId` в сообщениях webview → хост информативен, хост направляет сообщение в
 * текущую сессию вкладки (до первого `session.init` id ещё пуст).
 */
export type ToWebview =
  | { type: 'init'; surface: 'chat' | 'sidebar' | 'settings'; version: string }
  /**
   * Шрифты, размер ленты и интерфейса (`agentura.font.*`, `agentura.feed.fontSize`, `agentura.ui.fontSize`): всем поверхностям после `init` и при
   * смене настройки. Пустой шрифт — как в VS Code.
   */
  | {
      type: 'appearance';
      fontInterface: string;
      fontPanels: string;
      fontCode: string;
      feedFontSize: number;
      uiFontSize: number;
      /**
       * Шрифты, скачанные из Google Fonts: имена по назначению и ссылка на их fonts.css (webview-uri с `?v=`).
       * Нет скачанных — без `css`.
       */
      userFonts: { ui: string[]; code: string[]; css?: string };
    }
  /** Вкладка настроек (этап 3 roadmap 0.2): значения `agentura.*` и ключи, перекрытые настройками рабочей папки. */
  | { type: 'settings.state'; values: SettingsValues; overridden: SettingKey[] }
  /** Отказ записи настройки (проверка не прошла или запись не удалась) — текст у поля. */
  | { type: 'settings.error'; key: SettingKey; message: string }
  /** Ответ на «проверить» у пути к claude. */
  | { type: 'settings.engine'; result: EngineCheck }
  | { type: 'agent.event'; sessionId: string; event: AgentEvent }
  | {
      type: 'chat.info';
      /** Имя папки воркспейса и путь к ней. */
      project: string;
      cwd: string;
      allowBypass: boolean;
      /** Пороги шкалы контекста (`agentura.contextThresholds`), токены. Добавлено на этапе 4. */
      contextThresholds?: number[];
      /** Вид ленты (`agentura.feed.style`); нет — `journal`. */
      feedStyle?: FeedStyle;
      /** Вид вкладки «агенты» (`agentura.agents.view`); нет — `list`. */
      agentsView?: AgentsView;
    }
  | { type: 'capabilities'; sessionId: string; models: ModelOption[]; commands: CommandOption[] }
  | ({ type: 'editor.context' } & EditorContext)
  | { type: 'files.result'; requestId: number; items: FileHit[] }
  | { type: 'attach.picked'; items: FileHit[] }
  /**
   * Этап 4 roadmap 0.2: картинки, выбранные через «+» (`showOpenDialog`). Данные — исходный файл
   * (base64); уменьшает webview тем же путём, что и вставку. `problem` — файл не прочитан или велик.
   */
  | { type: 'image.picked'; items: PickedImage[] }
  /**
   * Этап 8 roadmap 0.2: текстовые файлы и pdf из «+» или перетаскивания (`attach.uris`) — содержимое
   * или причина отказа. Картинки из тех же источников приходят `image.picked`.
   */
  | { type: 'file.picked'; items: PickedFile[] }
  /** Начата новая сессия (команда, `/clear`, `new`): очистить ленту. */
  | { type: 'session.reset' }
  /**
   * Этап 6 roadmap 0.2: вложения в истории сессии с последней компакции (страницы pdf, символы
   * base64/текста). Лимиты API — на запрос со всей историей, поэтому webview проверяет по ним новые вложения.
   */
  | { type: 'session.attach'; pdfPages: number; chars: number }
  /**
   * Этап 3 roadmap 0.2: режим и effort, с которыми хост создал новую сессию (`agentura.defaultPermissionMode`,
   * `agentura.defaultEffort`). `session.init` приходит только после первого хода — без этого меню режима до
   * первого сообщения показывало бы «спрашивать», а движок уже шёл бы в `acceptEdits`/`bypassPermissions`.
   */
  | { type: 'session.defaults'; mode: PermissionMode; effort?: EffortLevel }
  /** Этап 5: превью правки к `permission.request` с `diff` — приходит вдогонку, по `toolUseId`. */
  | { type: 'diff.preview'; sessionId: string; toolUseId: string; preview: EditPreview }
  /**
   * Список сессий проекта (этап 6). Боковая панель получает все, вкладка чата — короткий хвост для
   * попапа и экрана empty; `current` — сессия активной вкладки (строка `cur` в списке), `project` — имя папки.
   */
  | { type: 'sessions.update'; sessions: SessionSummary[]; current?: string; project?: string }
  /**
   * Этап 6: история возобновлённой (или пересеянной после пересоздания webview) сессии. Webview
   * сбрасывает ленту и приборы, снимает фильтр брошенной сессии и прогоняет `events` тем же
   * редьюсером, что и живые события. `skippedTurns` — сколько ранних ходов не показано.
   */
  | {
      type: 'session.history';
      sessionId: string;
      events: AgentEvent[];
      skippedTurns: number;
      title?: string;
      model?: string;
      mode?: PermissionMode;
    }
  /**
   * Вид боковой панели (`agentura.sessionList.*`, `agentura.sidebar.top`): строк на сессию, колонки контекста и
   * времени, вид верха. На `ready` и при правке настройки.
   */
  | {
      type: 'sidebar.view';
      view: SessionListMode;
      context: boolean;
      time: boolean;
      /** Вид верха панели (`agentura.sidebar.top`). */
      top: SidebarTopMode;
    }
  /** Этап 6: аккаунт для боковой панели. */
  | ({ type: 'account.info' } & AccountSummary)
  /** Этап 6: команда из боковой панели (`/status`) — выполнить в этой вкладке. */
  | { type: 'chat.command'; name: 'status' }
  | {
      type: 'limits.update';
      windows: LimitWindowSummary[];
      /** Когда данные получены от источника (мс); при кулдауне — время прошлого запроса. */
      updatedAt: number;
      error?: string;
    };

/**
 * Webview → extension. Этап 3 добавил `files.find`, `attach.pick`, `sessions.show`, `diff.open` и
 * поле `attachments` у `send` (roadmap, «Решения по итогам сессии 3»). Этап 5: `diff.open`
 * открывает нативный дифф, `plan.decide` несёт выбор кнопки и текст доработки.
 */
export type FromWebview =
  | { type: 'ready' }
  /**
   * `images` — картинки сообщения (этап 4 roadmap 0.2), уже уменьшенные webview; `files` — текстовые
   * файлы и pdf (этап 8), хост проверяет их ещё раз (`hostFile`).
   */
  | {
      type: 'send';
      sessionId: string;
      text: string;
      attachments?: Attachment[];
      images?: PromptImage[];
      files?: PromptFile[];
    }
  | { type: 'files.find'; requestId: number; query: string }
  | { type: 'attach.pick' }
  /**
   * Этап 4 roadmap 0.2: «Изображение или файл…» в меню «+» — диалог выбора на хосте. С этапа 8 без
   * фильтра: картинки приходят `image.picked`, текст и pdf — `file.picked`.
   */
  | { type: 'image.pick' }
  /** Клик по миниатюре: хост пишет временный файл в storage расширения и открывает его во вкладке. */
  | { type: 'image.open'; mediaType: string; data: string }
  /**
   * Этап 8: перетаскивание из проводника и вкладок VS Code — uri из `application/vnd.code.uri-list`
   * или `text/uri-list`. Хост читает файлы сам (`workspace.fs`) и отвечает `image.picked`/`file.picked`.
   */
  | { type: 'attach.uris'; uris: string[] }
  /**
   * Клик по чипу файла в ленте: путь относительно рабочей папки — сам файл; иначе — временная копия
   * из `data` (`globalStorageUri/attachments`), без данных — исходный файл, если он есть.
   */
  | { type: 'file.open'; kind: string; path: string; data?: string }
  | { type: 'sessions.show' }
  | { type: 'diff.open'; sessionId: string; toolUseId: string }
  /** Вкладка «изменения»: дифф файла (правки одного файла) или всех файлов охвата — по `toolUseId` правок. */
  | { type: 'diff.changes'; sessionId: string; toolUseIds: string[] }
  | { type: 'preview.open'; path: string }
  | { type: 'link.open'; url: string }
  | { type: 'interrupt'; sessionId: string }
  | {
      type: 'permission.respond';
      sessionId: string;
      toolUseId: string;
      decision: PermissionDecision;
    }
  | {
      type: 'question.answer';
      sessionId: string;
      toolUseId: string;
      answers: Record<string, string>;
    }
  /** Этап 5: вместо `approve: boolean` — выбор кнопки и текст доработки. */
  | {
      type: 'plan.decide';
      sessionId: string;
      toolUseId: string;
      decision: PlanChoice;
      feedback?: string;
    }
  | { type: 'mode.set'; sessionId: string; mode: PermissionMode }
  | { type: 'model.set'; sessionId: string; model: string }
  | { type: 'effort.set'; sessionId: string; effort: string }
  | { type: 'compact'; sessionId: string }
  | { type: 'agent.stop'; sessionId: string; taskId: string }
  /**
   * Этап 2 roadmap 0.2: транскрипт субагента документом только для чтения. `taskId` — id задачи
   * движка (имя файла `subagents/agent-<taskId>.jsonl`), `agentId` — id вызова `Agent` (заголовок).
   */
  | { type: 'agent.transcript'; sessionId: string; agentId: string; taskId: string }
  | { type: 'session.new' }
  | { type: 'limits.refresh' }
  | { type: 'session.resume'; sessionId: string }
  /** Этап 6: переименование по двойному клику в списке (B9). */
  | { type: 'session.rename'; sessionId: string; title: string }
  /**
   * Этап 7: «Повторить ход» на карточке ошибки — хост возобновляет сессию (`resume`) и заново
   * отправляет последний неотвеченный промпт, если карточка говорит, что ход был оборван (`turn`);
   * `turn: false` («Возобновить сессию») — только возобновление.
   */
  | { type: 'turn.retry'; sessionId: string; turn: boolean }
  /** Этап 7: «Открыть журнал расширения» — канал Output → Agentura. */
  | { type: 'log.show' }
  /** Этап 3 roadmap 0.2: ⚙ в боковой панели открывает вкладку настроек. */
  | { type: 'settings.open' }
  /** Вкладка настроек: записать настройку (в пользовательские настройки VS Code). */
  | { type: 'settings.set'; key: SettingKey; value: unknown }
  /** «проверить»: найти claude по этому пути (пусто — системный) и показать версию и источник. */
  | { type: 'settings.checkEngine'; path: string }
  /** «в настройках VS Code» / «settings.json». */
  | { type: 'settings.reveal'; target: 'ui' | 'json' }
  /** «Добавить из Google Fonts…» под карточками: выбор семейства для интерфейса, кода или панелей (все семейства). */
  | { type: 'fonts.add'; kind: 'ui' | 'code' | 'panels' }
  /** ✕ у скачанного шрифта. */
  | { type: 'fonts.remove'; family: string };

/** Картинка из диалога «+»: исходный файл или причина, почему не прочитан. */
export interface PickedImage {
  name: string;
  mediaType?: string;
  data?: string;
  problem?: ImageProblem;
}

/** Файл из «+» или перетаскивания: содержимое для `send.files` или причина, почему не взят. */
export interface PickedFile {
  /** Имя для чипа (последний сегмент пути). */
  name: string;
  /** Путь для модели: относительно рабочей папки или абсолютный. */
  path?: string;
  kind?: PromptFile['kind'];
  data?: string;
  size?: number;
  pages?: number;
  problem?: FileProblem;
}

/** Аккаунт для секции «Аккаунт и лимиты» (этап 6); поля, которых нет, — «—». */
export interface AccountSummary {
  email?: string;
  /** `Max 5×`, `Pro` — из `subscriptionType` и `rateLimitTier`. */
  plan?: string;
  /** `через CLI · ок` / `ключ API` / причина ошибки. */
  login?: string;
  /** Ошибка получения (`accountInfo` не ответил). */
  error?: string;
  /** `claude 2.1.285` — из `session.init.claude_code_version`; нет, пока ни одна сессия не стартовала. */
  engine?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  turns: number;
  /** Нет — стоимость неизвестна (модель без цены), показывать «—», не $0. */
  costUsd?: number;
  /** Оценка без части запросов (модели без цены) — показывать с пометкой. */
  costPartial?: boolean;
  state: 'idle' | 'live' | 'waiting' | 'error' | 'limit';
  updatedAt: number;
  /** Контекст последнего запроса, токены — «131k» в строке списка. */
  contextTokens?: number;
}

/** Окно лимита: `kind`, проценты 0…100, сброс в мс. */
export type LimitWindowSummary = LimitWindow;

/** Все типы входящих от webview: `Record` по union — забытый тип не скомпилируется. */
const FROM_WEBVIEW_TYPES: Record<FromWebview['type'], true> = {
  'ready': true,
  'send': true,
  'files.find': true,
  'attach.pick': true,
  'image.pick': true,
  'image.open': true,
  'attach.uris': true,
  'file.open': true,
  'sessions.show': true,
  'diff.open': true,
  'diff.changes': true,
  'preview.open': true,
  'link.open': true,
  'interrupt': true,
  'permission.respond': true,
  'question.answer': true,
  'plan.decide': true,
  'mode.set': true,
  'model.set': true,
  'effort.set': true,
  'compact': true,
  'agent.stop': true,
  'agent.transcript': true,
  'session.new': true,
  'limits.refresh': true,
  'session.resume': true,
  'session.rename': true,
  'turn.retry': true,
  'log.show': true,
  'settings.open': true,
  'settings.set': true,
  'settings.checkEngine': true,
  'settings.reveal': true,
  'fonts.add': true,
  'fonts.remove': true,
};

/** `error.code` карточки «claude не найден»: webview рисует инструкцию и «Открыть настройки». */
export const ENGINE_MISSING_CODE = 'engine_missing';

/** Проверка входящего от webview сообщения: снаружи приходит `unknown`. */
export function isFromWebview(value: unknown): value is FromWebview {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && Object.hasOwn(FROM_WEBVIEW_TYPES, type);
}

/** Минимум от `vscode.Webview`, нужный для отправки; позволяет тестировать без vscode. */
export interface WebviewLike {
  postMessage(message: unknown): Thenable<boolean> | Promise<boolean>;
}

export function postToWebview(webview: WebviewLike, message: ToWebview): void {
  void webview.postMessage(message);
}

/** Минимум от `acquireVsCodeApi()`. */
export interface VsCodeApiLike {
  postMessage(message: unknown): void;
  /** Состояние webview, переживающее перезагрузку окна (сериализатор панели, этап 6). */
  setState?(state: unknown): void;
  getState?(): unknown;
}

export function postToHost(api: VsCodeApiLike, message: FromWebview): void {
  api.postMessage(message);
}
