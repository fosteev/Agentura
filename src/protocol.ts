/**
 * Протокол extension ↔ webview. События агента — `AgentEvent` из `src/agent/types.ts` (этап 2):
 * webview получает их как есть в сообщении `agent.event`.
 */
import type {
  AgentEvent,
  AgentProvider,
  CommandOption,
  EffortLevel,
  LimitWindow,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PromptFile,
  PromptImage,
} from './agent/types';
import type { ProviderFeatures } from './agent/features';
import type { Attachment, FileHit } from './shared/prompt';
import type { ImageProblem } from './shared/images';
import type { FileProblem } from './shared/files';
import { isAgentGraphView, type AgentGraphView } from './shared/agentsGraph';
import type { GitNotice, GitRequest } from './shared/git';
import type { IntegrationsState } from './shared/integrations';
import {
  isIsoDate,
  isOpenableLink,
  TASK_LIMITS,
  type TaskActionMessage,
  type TaskChatsMessage,
  type TaskRequest,
  type TaskStateMessage,
  type TaskTransitionsMessage,
} from './shared/task';
import type { TabChatsMessage, TabRequest } from './shared/taskTab';
import type {
  EngineCheck,
  AgentsView,
  GitLayout,
  FeedStyle,
  ComposerLayout,
  SessionListMode,
  SettingKey,
  SidebarLimitsMode,
  TaskCardMode,
  TaskSidebarMode,
  SidebarTopMode,
  SettingsValues,
  McpView,
} from './settings';
import { isSkillName } from './shared/skills';

export type {
  AgentEvent,
  Attachment,
  CommandOption,
  FileHit,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  AgentGraphView,
};

/** Поверхности webview: вкладка чата, боковая панель, настройки, граф агентов (roadmap 11, этап 2). */
export type Surface = 'chat' | 'sidebar' | 'settings' | 'agents';

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
  'remote.state', // roadmap 17: мост Remote Control (connecting/on/off/error, ссылка claude.ai)
  'remote.prompt', // roadmap 17: промпт с claude.ai или телефона
  'mcp.status', // roadmap 21: MCP-серверы сессии, всегда полный список
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
  | { type: 'init'; surface: Surface; version: string }
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
  /** Страница «Интеграции» (roadmap 19, этап 6): Jiraffe и свои подключения Jira. */
  | { type: 'integrations.state'; state: IntegrationsState }
  /** Отказ записи настройки (проверка не прошла или запись не удалась) — текст у поля. */
  | { type: 'settings.error'; key: SettingKey; message: string }
  /** Ответ на «проверить» у пути к claude. */
  | { type: 'settings.engine'; result: EngineCheck; /** Чей путь проверен; нет — claude. */ engine?: AgentProvider }
  | { type: 'agent.event'; sessionId: string; event: AgentEvent }
  /**
   * Граф агентов (roadmap 11, этап 2). Чату: открыта ли (и видна ли) его вкладка графа — пока да, чат шлёт
   * `agents.snapshot`; `open: true` повторно — просьба прислать свежий снимок сразу.
   */
  | { type: 'agents.graph'; open: boolean }
  /** Вкладке графа: снимок от её чата (хост пересылает как есть). `sessionId` пуст — у чата ещё нет сессии. */
  | { type: 'agents.snapshot'; sessionId: string; graph: AgentGraphView }
  /** Вкладке графа: выбрать агента (клик по агенту в ленте чата). */
  | { type: 'agents.focus'; agentId: string }
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
      /** Раскладка поля ввода (`agentura.composer.layout`); нет — `classic`. */
      composerLayout?: ComposerLayout;
      /** Вид вкладки «агенты» (`agentura.agents.view`); нет — `list`. */
      agentsView?: AgentsView;
      /** Раскладка вкладки «git» при нескольких репо (`agentura.git.layout`); нет — `stack`. */
      gitLayout?: GitLayout;
      /** Движок вкладки (roadmap 15, этап 3); нет — `claude` (старое сообщение). */
      provider?: AgentProvider;
      /** Что движок умеет: UI прячет остальное. Нет — Claude, все `true`. */
      features?: ProviderFeatures;
      /** Где карточка задачи в чате по задаче (`agentura.tasks.card`, roadmap 19); нет — `panel`. */
      taskCard?: TaskCardMode;
      /** Настройки `agentura.mcp.*` (roadmap 21); нет — по умолчанию (`DEFAULT_MCP_VIEW`). */
      mcp?: McpView;
    }
  /**
   * Roadmap 21, решение 6: скиллы из `session.init`, у которых хост нашёл SKILL.md (`.claude/skills` проекта или
   * домашней папки), — только у них ссылка «открыть SKILL.md». Приходит после каждого `session.init` и при пересеве.
   */
  | { type: 'skill.files'; names: string[] }
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
  /** Текст в пустое поле ввода (`agentura.openWithContext`): набранное не затирается. */
  | { type: 'composer.prefill'; text: string }
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
  /** Хост не принял `agy.retry` (режим уже такой, «всё разрешено» недоступно этой сессии): карточка отказа снова с кнопками. */
  | { type: 'agy.retryRejected' }
  /** Этап 5: превью правки к `permission.request` с `diff` — приходит вдогонку, по `toolUseId`. */
  | { type: 'diff.preview'; sessionId: string; toolUseId: string; preview: EditPreview }
  /**
   * Список сессий проекта (этап 6). Боковая панель получает все, вкладка чата — короткий хвост для
   * попапа и экрана empty; `current` — сессия активной вкладки (строка `cur` в списке), `project` — имя папки.
   */
  | {
      type: 'sessions.update';
      sessions: SessionSummary[];
      current?: string;
      project?: string;
      /** Движок активной вкладки чата (`current` лимитов движков); нет вкладок — не задан. */
      currentProvider?: AgentProvider;
      /** Группы задач (только боковая панель); нет — групп нет. */
      tasks?: TaskGroupSummary[];
    }
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
      /** Вид лимитов всех движков при ≥ 2 установленных (`agentura.sidebar.limits`). */
      limits: SidebarLimitsMode;
      /** Где задачи Jira: группы в списке или секция (`agentura.tasks.sidebar`, roadmap 19). */
      tasks?: TaskSidebarMode;
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
    }
  /**
   * Лимиты Codex и Antigravity для боковой панели (roadmap 18). Claude едет прежними `limits.update` и
   * `account.info`. Движок без исполняемого файла приходит с `state: 'missing'` (не показывается).
   */
  | { type: 'engines.limits'; engines: EngineLimitsSummary[] }
  /** Квота Antigravity (`agy -p "/usage"`): строки по семействам моделей; пусто — не показываем. */
  | { type: 'quota.update'; rows: QuotaRow[]; updatedAt: number }
  /**
   * Вкладка «git» (roadmap 12): `git.state` — снимок на каждое изменение и на `ready`, `git.error` — отказ
   * действия, `git.commit.result` — итог коммита по каждому репозиторию, `git.message.result` — ✦ сообщение.
   */
  | GitNotice
  /**
   * Карточка и лента изменений задачи Jira вкладки (roadmap 19, этап 2): на `ready`, после каждой загрузки и при смене
   * привязки. Нет `taskKey` — вкладка вне задачи.
   */
  | TaskStateMessage
  /** Ответы вкладке «задача» (roadmap 20): переходы статуса и итог записи от имени пользователя. */
  | TaskTransitionsMessage
  | TaskActionMessage
  /** Чаты группы задачи вкладки для блока «Чаты по задаче» (этап 5). */
  | TaskChatsMessage
  /** Вкладка на задачу (`tasks.tab = task`, этап 7): внутренние вкладки чатов и состояние для сериализатора. */
  | TabChatsMessage;

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
  /** Roadmap 17: Remote Control вкладки — кнопка «rc», `/rc`, `/remote-control`. Только Claude. */
  | { type: 'remote.set'; sessionId?: string; on: boolean }
  /**
   * Roadmap 21: MCP вкладки. `mcp.refresh` — ↻ (статус придёт `mcp.status`); `mcp.reconnect` — «повторить» у сервера
   * (Claude, `features.mcpReconnect`); `mcp.reloadAll` — «перезапустить все» (Codex, `features.mcpReloadAll`). Без
   * сессии движка — ничего (движок ради этого не поднимается).
   */
  | { type: 'mcp.refresh' }
  | { type: 'mcp.reconnect'; name: string }
  | { type: 'mcp.reloadAll' }
  /** Roadmap 21, решение 6: открыть SKILL.md скилла в редакторе; путь собирает хост, имя — `SKILL_NAME_RE`. */
  | { type: 'skill.open'; name: string }
  | { type: 'compact'; sessionId: string }
  | { type: 'agent.stop'; sessionId: string; taskId: string }
  /**
   * Этап 2 roadmap 0.2: транскрипт субагента документом только для чтения. `taskId` — id задачи
   * движка (имя файла `subagents/agent-<taskId>.jsonl`), `agentId` — id вызова `Agent` (заголовок).
   */
  | { type: 'agent.transcript'; sessionId: string; agentId: string; taskId: string }
  /** Чат: открыть (или показать) его вкладку графа, `agentId` — выбрать в ней агента. */
  | { type: 'agents.openGraph'; agentId?: string }
  /** Чат: снимок карты агентов для его вкладки графа — только пока граф открыт (`agents.graph`). */
  | { type: 'agents.snapshot'; sessionId: string; graph: AgentGraphView }
  | { type: 'session.new' }
  /** «＋» у группы задачи в боковой панели: новый чат по задаче (`agentura.chatForTask`); `taskKey` — `jira:<инстанс>:<KEY>`. */
  | { type: 'task.newChat'; taskKey: string }
  /** Выбор движка в пустой вкладке (до первого сообщения); хост запоминает его как дефолт новых чатов. */
  | { type: 'engine.set'; provider: AgentProvider }
  | { type: 'limits.refresh' }
  /** «войти» у движка без входа (боковая панель, лимиты движков): хост открывает терминал с командой входа. */
  | { type: 'engine.login'; engine: 'codex' | 'antigravity' }
  | { type: 'session.resume'; sessionId: string; provider?: AgentProvider }
  /** Этап 6: переименование по двойному клику в списке (B9). */
  | { type: 'session.rename'; sessionId: string; title: string }
  /**
   * Этап 7: «Повторить ход» на карточке ошибки — хост возобновляет сессию (`resume`) и заново
   * отправляет последний неотвеченный промпт, если карточка говорит, что ход был оборван (`turn`);
   * `turn: false` («Возобновить сессию») — только возобновление.
   */
  | { type: 'turn.retry'; sessionId: string; turn: boolean }
  /** Карточка отказа Antigravity: повторить в более свободном режиме (`AntigravityAdapter.retryWithMode`). */
  | { type: 'agy.retry'; sessionId: string; mode: 'acceptEdits' | 'bypassPermissions' }
  /** Этап 7: «Открыть журнал расширения» — канал Output → Agentura. */
  | { type: 'log.show' }
  /** Этап 3 roadmap 0.2: ⚙ в боковой панели открывает вкладку настроек. */
  | { type: 'settings.open' }
  /** Вкладка настроек: записать настройку (в пользовательские настройки VS Code). */
  | { type: 'settings.set'; key: SettingKey; value: unknown }
  /** «проверить»: найти claude по этому пути (пусто — системный) и показать версию и источник. */
  | { type: 'settings.checkEngine'; path: string; /** Чей путь проверять; нет — claude. */ engine?: AgentProvider }
  /** Страница «Интеграции»: команды этапа 2 (`agentura.jira.connect|test|disconnect`) и «поставить» Jiraffe. */
  | { type: 'integrations.connect' }
  | { type: 'integrations.test'; instanceId: string }
  | { type: 'integrations.disconnect'; instanceId: string }
  | { type: 'integrations.installJiraffe' }
  /** «в настройках VS Code» / «settings.json». */
  | { type: 'settings.reveal'; target: 'ui' | 'json' }
  /** «Добавить из Google Fonts…» под карточками: выбор семейства для интерфейса, кода или панелей (все семейства). */
  | { type: 'fonts.add'; kind: 'ui' | 'code' | 'panels' }
  /** ✕ у скачанного шрифта. */
  | { type: 'fonts.remove'; family: string }
  /** Вкладка «git» (roadmap 12): `git.watch|stage|unstage|discard|commit|sync|branch|open|openFile|message`. */
  | GitRequest
  /** Вкладка задачи (roadmap 19, этап 2): ↻, комментарий в поле ввода, открыть задачу/вложение. */
  | TaskRequest
  /** Внутренние вкладки вкладки задачи (этап 7): показать, закрыть, «＋». */
  | TabRequest;

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

export type EngineLimitsState = 'ok' | 'signedOut' | 'missing' | 'error' | 'loading';
export interface EngineWindowSummary {
  kind: 'fiveHour' | 'weekly' | 'model';
  /** У `model` — имя от источника (`Gemini`, `Claude/GPT`, имя доп. лимита Codex); у остальных — нет. */
  name?: string;
  /** Израсходовано, 0…100 (у agy — 100 − остаток). */
  percent: number;
  resetsAt?: number; // мс
}
export interface EngineLimitsSummary {
  engine: 'codex' | 'antigravity';
  state: EngineLimitsState;
  email?: string;
  plan?: string; // `Plus`, `Pro` — planType с заглавной
  version?: string; // `codex 0.160.0` / `agy 1.4` — если уже известна локатору, иначе нет
  windows: EngineWindowSummary[];
  updatedAt: number;
  error?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  /** Движок треда; нет — Claude. У Codex ходов/стоимости/контекста нет (`turns` — 0, не показываются). */
  provider?: AgentProvider;
  turns: number;
  /** Нет — стоимость неизвестна (модель без цены), показывать «—», не $0. */
  costUsd?: number;
  /** Оценка без части запросов (модели без цены) — показывать с пометкой. */
  costPartial?: boolean;
  state: 'idle' | 'live' | 'waiting' | 'error' | 'limit';
  updatedAt: number;
  /** Контекст последнего запроса, токены — «131k» в строке списка. */
  contextTokens?: number;
  /** Чат входит в группу задачи (`TaskGroups`): метка для списка сессий. */
  task?: { key: string; title: string; status?: string; statusCategory?: 'new' | 'indeterminate' | 'done' };
}

/** Группа чатов по задаче в `sessions.update.tasks`: метаданные задачи и id её сессий (новые сверху, только из списка). */
export interface TaskGroupSummary {
  /** `jira:<instanceId>:<KEY>`. */
  taskKey: string;
  meta: {
    key: string;
    instanceId: string;
    title: string;
    status?: string;
    statusCategory?: 'new' | 'indeterminate' | 'done';
    url: string;
  };
  sessionIds: string[];
}

/** Строка квоты Antigravity: осталось % (0…100) и сброс в мс; `label` — `Gemini`, `Claude/GPT`. */
export interface QuotaRow {
  label: string;
  remaining: number;
  resetsAt?: number;
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
  'remote.set': true,
  'mcp.refresh': true,
  'mcp.reconnect': true,
  'mcp.reloadAll': true,
  'skill.open': true,
  'compact': true,
  'agent.stop': true,
  'agent.transcript': true,
  'agents.openGraph': true,
  'agents.snapshot': true,
  'session.new': true,
  'task.newChat': true,
  'engine.set': true,
  'limits.refresh': true,
  'engine.login': true,
  'session.resume': true,
  'session.rename': true,
  'turn.retry': true,
  'agy.retry': true,
  'log.show': true,
  'settings.open': true,
  'settings.set': true,
  'settings.checkEngine': true,
  'settings.reveal': true,
  'integrations.connect': true,
  'integrations.test': true,
  'integrations.disconnect': true,
  'integrations.installJiraffe': true,
  'fonts.add': true,
  'fonts.remove': true,
  'git.watch': true,
  'git.stage': true,
  'git.unstage': true,
  'git.discard': true,
  'git.commit': true,
  'git.sync': true,
  'git.branch': true,
  'git.open': true,
  'git.openFile': true,
  'git.openRepository': true,
  'git.message': true,
  'task.refresh': true,
  'task.toComposer': true,
  'task.openExternal': true,
  'task.openChat': true,
  'task.connect': true,
  'task.transitions': true,
  'task.transition': true,
  'task.comment': true,
  'task.logWork': true,
  'task.openLink': true,
  'tab.select': true,
  'tab.close': true,
  'tab.new': true,
};

/** `error.code` карточки «claude не найден»: webview рисует инструкцию и «Открыть настройки». */
export const ENGINE_MISSING_CODE = 'engine_missing';

const str = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every(str);
const bool = (v: unknown): boolean => typeof v === 'boolean';
/** Файлы вкладки «git»: корень и непустой список путей. */
const gitFiles = (m: Record<string, unknown>): boolean => str(m.root) && strings(m.paths);

/**
 * Поля сообщений, которые хост не разбирает сам, а пересылает в другой webview (граф агентов): их форма
 * проверяется здесь, как и запросы вкладки «git» (их разбирает сервис, а не контроллер). Остальные сообщения
 * проверяет по полям обработчик.
 */
const FIELD_CHECKS: Partial<Record<FromWebview['type'], (m: Record<string, unknown>) => boolean>> = {
  'engine.set': (m) => m.provider === 'claude' || m.provider === 'codex' || m.provider === 'antigravity',
  'engine.login': (m) => m.engine === 'codex' || m.engine === 'antigravity',
  'agy.retry': (m) => m.mode === 'acceptEdits' || m.mode === 'bypassPermissions',
  'agents.openGraph': (m) => m.agentId === undefined || typeof m.agentId === 'string',
  'agents.snapshot': (m) => typeof m.sessionId === 'string' && isAgentGraphView(m.graph),
  'remote.set': (m) => bool(m.on) && (m.sessionId === undefined || str(m.sessionId)),
  'mcp.reconnect': (m) => str(m.name) && m.name.length > 0 && m.name.length <= 128,
  'skill.open': (m) => isSkillName(m.name),
  'agent.stop': (m) => typeof m.sessionId === 'string' && typeof m.taskId === 'string',
  'agent.transcript': (m) =>
    typeof m.sessionId === 'string' && typeof m.agentId === 'string' && typeof m.taskId === 'string',
  // вкладка «git»: хост ещё проверяет, что `root` — репозиторий панели, а пути — внутри него
  'git.watch': (m) => bool(m.on),
  'git.stage': gitFiles,
  'git.unstage': gitFiles,
  'git.discard': gitFiles,
  'git.commit': (m) =>
    strings(m.roots) && str(m.message) && bool(m.amend) && bool(m.push) && (m.all === undefined || bool(m.all)),
  'git.sync': (m) =>
    (m.root === undefined || str(m.root)) && (m.op === 'fetch' || m.op === 'pull' || m.op === 'push'),
  'git.branch': (m) => str(m.root),
  'git.open': (m) => str(m.root) && str(m.path) && bool(m.staged),
  'git.openFile': (m) => str(m.root) && str(m.path),
  'git.openRepository': () => true,
  'git.message': (m) => strings(m.roots),
  'task.newChat': (m) => str(m.taskKey) && m.taskKey.length > 0 && m.taskKey.length <= 400,
  'integrations.test': (m) => str(m.instanceId) && m.instanceId.length > 0 && m.instanceId.length <= 200,
  'integrations.disconnect': (m) => str(m.instanceId) && m.instanceId.length > 0 && m.instanceId.length <= 200,
  'task.connect': () => true,
  'tab.select': (m) => str(m.id) && m.id.length > 0 && m.id.length <= 100,
  'tab.close': (m) => str(m.id) && m.id.length > 0 && m.id.length <= 100,
  'task.openChat': (m) => str(m.sessionId) && m.sessionId.length > 0 && m.sessionId.length <= 200,
  'task.toComposer': (m) => m.commentId === undefined || (str(m.commentId) && m.commentId.length > 0 && m.commentId.length <= 200),
  // вкладка «задача» (roadmap 20): запись от имени пользователя — длины и форма здесь, `writer` проверяет ещё раз
  'task.transitions': () => true,
  'task.transition': (m) => str(m.transitionId) && m.transitionId.length > 0 && m.transitionId.length <= 50,
  'task.comment': (m) => str(m.body) && m.body.trim().length > 0 && m.body.length <= TASK_LIMITS.comment,
  'task.logWork': (m) =>
    Number.isInteger(m.seconds) &&
    (m.seconds as number) >= 1 &&
    (m.seconds as number) <= TASK_LIMITS.workSeconds &&
    isIsoDate(m.date) &&
    str(m.comment) &&
    m.comment.length <= TASK_LIMITS.workComment,
  'task.openLink': (m) => isOpenableLink(m.url),
  'task.openExternal': (m) => m.attachmentId === undefined || (str(m.attachmentId) && m.attachmentId.length <= 200),
};

/** Проверка входящего от webview сообщения: снаружи приходит `unknown`. */
export function isFromWebview(value: unknown): value is FromWebview {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !Object.hasOwn(FROM_WEBVIEW_TYPES, type)) return false;
  const check = FIELD_CHECKS[type as FromWebview['type']];
  return !check || check(value as Record<string, unknown>);
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
