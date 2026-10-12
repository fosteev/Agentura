import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type {
  McpServerConfig,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  query as sdkQuery,
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
  renameSession as sdkRenameSession,
  createSdkMcpServer as sdkCreateSdkMcpServer,
  tool as sdkTool,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountInfo,
  AgentAdapter,
  AgentEvent,
  AgentEventOf,
  AgentSession,
  CommandOption,
  CompletionRequest,
  EffortLevel,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PlanDecision,
  PromptFile,
  PromptImage,
  ResumeOptions,
  RetryPoint,
  SessionCapabilities,
  SessionHistory,
  SessionInfo,
  SessionOptions,
  TaskTools,
} from '../types';
import { AsyncQueue, EventHub } from '../stream';
import type { Lang } from '../../shared/l10n';
import { ClaudeEventMapper } from './mapper';
import { PermissionBroker } from './permissions';
import { RemoteBridge, type RemoteConfig } from './remote';
import {
  buildJiraServer,
  JIRA_COMMENT_TOOL,
  JIRA_SERVER,
  specSignature,
  type McpKit,
} from './jiraMcp';
import { autoCommentOk, jiraToolOf } from '../../shared/jiraTools';
import { buildHistory, DEFAULT_MAX_TURNS, findRetryPoint, type HistoryMessage } from './history';
import { defaultClaudeHome, transcriptPath } from '../../data/sessions';
import { readTranscriptExtras } from '../../data/transcriptExtras';
import { streamLines } from '../../data/jsonlStream';
import {
  readSubagentMeta,
  readSubagentRecords,
  subagentFile,
  subagentMarkdown,
  subagentsDir,
  withSubagentTimelines,
} from './subagents';

/**
 * Адаптер Claude Agent SDK. Одна живая `query()` на сессию в streaming input mode: prompt —
 * асинхронная очередь, поэтому работают `interrupt`, `setPermissionMode`, `setModel`,
 * `applyFlagSettings`. Разбор сообщений — `ClaudeEventMapper`, разрешения — `PermissionBroker`.
 *
 * SDK — ESM-пакет с нативным бинарником CLI, который он ищет через `import.meta.url`: в бандл
 * расширения его не включаем (external в esbuild), грузим динамическим `import()`.
 */

interface SdkModule {
  query: typeof sdkQuery;
  listSessions: typeof sdkListSessions;
  getSessionMessages: typeof sdkGetSessionMessages;
  renameSession: typeof sdkRenameSession;
  /** Инструменты задачи Jira (этап 8 roadmap 19); в подменах SDK из тестов может не быть. */
  createSdkMcpServer?: typeof sdkCreateSdkMcpServer;
  tool?: typeof sdkTool;
}

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface ClaudeAdapterConfig {
  /**
   * Путь к `claude` (настройка `agentura.claudeExecutable` или найденный системный); пусто — бинарник
   * из пакета SDK. Функция вычисляется при каждом запуске движка (настройку можно сменить на лету).
   */
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  /** Имя клиента для движка (`CLAUDE_AGENT_SDK_CLIENT_APP`). */
  clientApp?: string;
  log?: LogFn;
  /** Язык текстов для пользователя (плашки, транскрипт субагента); по умолчанию русский. */
  lang?: () => Lang;
  /** Подмена SDK в тестах. */
  loadSdk?: () => Promise<SdkModule>;
  /** zod для схем MCP-инструментов (тот же пакет, что у SDK); по умолчанию динамический `import('zod')`. */
  loadZod?: () => Promise<Pick<McpKit, 'z'>>;
  /** База окружения; по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Источники настроек движка; по умолчанию все три, как у CLI. Без `user` — только для проверок:
   * правила владельца (`permissions.allow: ["Bash", …]`) закрывают запросы разрешений.
   */
  settingSources?: ('user' | 'project' | 'local')[];
  /** Диагностика: каждое сырое сообщение SDK до маппинга (smoke, отладка). */
  trace?: (message: unknown) => void;
  /** Remote Control (roadmap 17): модуль моста, токен, префикс имени, bypass — инъекцией для тестов. */
  remote?: RemoteConfig;
}

/**
 * Переменные, которыми родительская сессия Claude Code метит свой процесс и детей. Если расширение
 * или скрипт запущены из неё (терминал Claude Code, Agent SDK), движок принял бы их на свой счёт:
 * `CLAUDE_CODE_ENTRYPOINT` SDK ставит в `sdk-ts` только если переменной нет, сокет и токен
 * мессенджинга, id сессии, признак дочерней сессии — чужие. Список снят с живого окружения сессии
 * Claude Code 2.1.285. Остальные `CLAUDE_CODE_*` (Bedrock/Vertex, `CLAUDE_CODE_OAUTH_TOKEN`,
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_GIT_BASH_PATH`…) — настройки пользователя, их не трогаем.
 */
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENABLE_TASKS',
];

/**
 * Окружение движка: всё окружение процесса (в TS `Options.env` заменяет его целиком), но без
 * `ANTHROPIC_API_KEY` и `ANTHROPIC_AUTH_TOKEN` — иначе движок уйдёт с входа подписки на ключ —
 * и без маркеров родительской сессии Claude Code (`PARENT_SESSION_VARS`).
 */
export function engineEnv(
  base: NodeJS.ProcessEnv,
  clientApp?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...PARENT_SESSION_VARS]) {
    delete env[key];
  }
  // Инструмент Artifact (и ArtifactComments/ArtifactData) включается флагом — он недокументирован,
  // проверен на CC 2.1.285. Автооткрытие ссылки самим CLI выключаем: ссылку открывает наша карточка.
  // `??=` — пользователь может переопределить значения в своём окружении.
  env['CLAUDE_CODE_ARTIFACT'] ??= '1';
  env['CLAUDE_CODE_ARTIFACT_AUTO_OPEN'] ??= '0';
  if (clientApp) env['CLAUDE_AGENT_SDK_CLIENT_APP'] = clientApp;
  return env;
}

/**
 * Содержимое сообщения пользователя: без вложений — строка (как в 0.1), с вложениями — image-блоки
 * в порядке отправки (этап 4 roadmap 0.2), затем `document`-блоки файлов (этап 8: текст —
 * `source.type: 'text'`, pdf — base64; `title` — путь) и текст последним. Пустой текст не шлём:
 * API отвергает пустой text-блок.
 */
export function userContent(
  text: string,
  images?: readonly PromptImage[],
  files?: readonly PromptFile[],
): SDKUserMessage['message']['content'] {
  if (!images?.length && !files?.length) return text;
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = (images ?? []).map((i) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: i.mediaType, data: i.data },
  }));
  for (const f of files ?? []) {
    blocks.push(
      f.kind === 'pdf'
        ? {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: f.data },
            title: f.path,
          }
        : {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: f.data },
            title: f.path,
          },
    );
  }
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
}

/** Сколько ждать `accountInfo()` от временного процесса CLI. */
export const ACCOUNT_INFO_TIMEOUT_MS = 15_000;
/** Сколько ждать ответа одноразового запроса (`complete`). */
export const COMPLETE_TIMEOUT_MS = 60_000;
/** `comment` инструментов Jira без вопроса — не больше стольких за окно (приёмка этапа 8); сверх — карточкой разрешения. */
export const AUTO_COMMENTS = 3;
export const AUTO_WINDOW_MS = 10 * 60_000;

/** `parentUuid` записи `uuid` в транскрипте (потоком: файл бывает в десятки МБ); нет — `undefined`. */
export async function promptParent(path: string, uuid: string): Promise<string | undefined> {
  const needle = `"uuid":"${uuid}"`;
  let parent: string | undefined;
  await streamLines(path, (line) => {
    if (parent !== undefined || !line.includes(needle)) return;
    try {
      const v = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown };
      if (v.uuid === uuid && typeof v.parentUuid === 'string') parent = v.parentUuid;
    } catch {
      // оборванная строка — пропускаем
    }
  });
  return parent;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  private sdk: Promise<SdkModule> | undefined;

  constructor(private readonly config: ClaudeAdapterConfig = {}) {}

  private loadSdk(): Promise<SdkModule> {
    this.sdk ??= (this.config.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk')))();
    return this.sdk;
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    const sdk = await this.loadSdk();
    const kit = await this.mcpKit(sdk, options.taskTools);
    return new ClaudeSession(
      sdk,
      this.config,
      await this.baseOptions(options.cwd),
      options,
      undefined,
      kit,
    );
  }

  async resumeSession(sessionId: string, options: ResumeOptions): Promise<AgentSession> {
    const sdk = await this.loadSdk();
    const kit = await this.mcpKit(sdk, options.taskTools);
    return new ClaudeSession(
      sdk,
      this.config,
      await this.baseOptions(options.cwd),
      options,
      sessionId,
      kit,
    );
  }

  /**
   * SDK-функции MCP и zod — только сессии с инструментами задачи. zod грузится тем же `import()`, что и SDK: экземпляр zod
   * у схем и у SDK один (в бандле расширения zod внешний). Не загрузился — сессия без инструментов, но работает.
   */
  private async mcpKit(sdk: SdkModule, tools: TaskTools | undefined): Promise<McpKit | undefined> {
    if (!tools || !sdk.createSdkMcpServer || !sdk.tool) return undefined;
    try {
      const { z } = await (this.config.loadZod ?? (() => import('zod')))();
      return { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z };
    } catch (error) {
      this.config.log?.('warn', `инструменты Jira недоступны: zod не загрузился: ${String(error)}`);
      return undefined;
    }
  }

  async listSessions(dir: string): Promise<SessionInfo[]> {
    const sdk = await this.loadSdk();
    const list = await sdk.listSessions({ dir });
    return list.map((s) => {
      const info: SessionInfo = {
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
        updatedAt: s.lastModified,
      };
      if (s.firstPrompt) info.firstPrompt = s.firstPrompt;
      if (s.cwd) info.cwd = s.cwd;
      if (s.gitBranch) info.gitBranch = s.gitBranch;
      if (s.createdAt !== undefined) info.createdAt = s.createdAt;
      if (s.fileSize !== undefined) info.fileSize = s.fileSize;
      return info;
    });
  }

  /**
   * История для ленты: `getSessionMessages()` + структурные результаты инструментов и режим из
   * транскрипта (`SessionMessage` их не несёт). Нет файла или движок не прочитал — ошибка наверх.
   */
  async loadHistory(
    sessionId: string,
    cwd: string,
    options: {
      live?: boolean;
      tasksAlive?: boolean;
      maxTurns?: number;
      stopBefore?: string;
    } = {},
  ): Promise<SessionHistory> {
    const sdk = await this.loadSdk();
    let messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
    if (options.stopBefore) {
      const at = messages.findIndex((m) => m.uuid === options.stopBefore);
      if (at >= 0) messages = messages.slice(0, at);
    }
    let extras: Awaited<ReturnType<typeof readTranscriptExtras>> = { toolResults: new Map() };
    try {
      extras = await readTranscriptExtras(transcriptPath(cwd, sessionId));
    } catch (error) {
      this.config.log?.('warn', `транскрипт ${sessionId}: ${String(error)}`);
    }
    const history = buildHistory(messages as HistoryMessage[], {
      toolResults: extras.toolResults,
      ...(extras.apiErrors ? { apiErrors: extras.apiErrors } : {}),
      live: options.live ?? false,
      ...(options.tasksAlive !== undefined ? { tasksAlive: options.tasksAlive } : {}),
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    });
    const dir = subagentsDir(transcriptPath(cwd, sessionId), sessionId);
    if (dir) await withSubagentTimelines(history.events, dir, (m) => this.config.log?.('warn', m));
    return {
      ...history,
      ...(extras.mode ? { mode: extras.mode } : {}),
      ...(extras.totalCostUsd !== undefined ? { totalCostUsd: extras.totalCostUsd } : {}),
    };
  }

  async retryPoint(
    sessionId: string,
    cwd: string,
    prompt: string,
  ): Promise<RetryPoint | undefined> {
    const sdk = await this.loadSdk();
    const point = findRetryPoint(
      (await sdk.getSessionMessages(sessionId, { dir: cwd })) as HistoryMessage[],
      prompt,
    );
    if (!point) return undefined;
    // SDK: откатываться на ПОСЛЕДНЮЮ запись сохраняемого хода, какой бы она ни была (вложение
    // `structured_output`, сводка хука — `getSessionMessages` их не отдаёт). Это `parentUuid` промпта
    // в транскрипте; не нашли — последнее сообщение перед промптом (при ошибке SDK откажет, и
    // `ChatController` возобновит сессию целиком)
    const parent = await promptParent(transcriptPath(cwd, sessionId), point.promptUuid).catch(
      () => undefined,
    );
    return parent ? { ...point, keepUuid: parent } : point;
  }

  /**
   * Транскрипт субагента Markdown-текстом (кнопка «транскрипт» в карте агентов). Нет файла —
   * `undefined` (агент ещё не писал, сессия не наша, транскрипт удалён).
   */
  async agentTranscript(
    sessionId: string,
    cwd: string,
    taskId: string,
    title: string,
  ): Promise<string | undefined> {
    const dir = subagentsDir(transcriptPath(cwd, sessionId), sessionId);
    const file = dir ? await subagentFile(dir, taskId) : undefined;
    if (!file) return undefined;
    const meta = await readSubagentMeta(file);
    return subagentMarkdown(await readSubagentRecords(file), {
      title: title || meta.description || taskId,
      ...(this.config.lang ? { lang: this.config.lang() } : {}),
      ...(meta.agentType ? { agentType: meta.agentType } : {}),
    });
  }

  async renameSession(sessionId: string, title: string, cwd: string): Promise<void> {
    const sdk = await this.loadSdk();
    await sdk.renameSession(sessionId, title, { dir: cwd });
  }

  /**
   * Аккаунт без хода: временная `query()` без сообщений — процесс CLI, но не запрос к API.
   * Ответа нет за `timeoutMs` — ошибка; процесс закрывается в любом случае (`close()` и `abort`).
   */
  async accountInfo(cwd: string, timeoutMs = ACCOUNT_INFO_TIMEOUT_MS): Promise<AccountInfo> {
    const sdk = await this.loadSdk();
    const input = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const q = sdk.query({
      prompt: input,
      options: { ...(await this.baseOptions(cwd)), abortController: abort },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // проигравший гонку с таймаутом запрос отклонится на `close()` — без обработчика это unhandled rejection
    const request = q.accountInfo();
    request.catch(() => undefined);
    try {
      const a = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`движок не ответил на accountInfo за ${timeoutMs} мс`)),
            timeoutMs,
          );
        }),
      ]);
      const info: AccountInfo = {};
      if (a.email) info.email = a.email;
      if (a.organization) info.organization = a.organization;
      if (a.subscriptionType) info.subscriptionType = a.subscriptionType;
      if (a.apiProvider) info.apiProvider = a.apiProvider;
      if (a.tokenSource) info.tokenSource = a.tokenSource;
      return info;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      input.end();
      try {
        q.close();
      } catch (error) {
        this.config.log?.('warn', `accountInfo: закрытие query: ${String(error)}`);
      }
      abort.abort();
    }
  }

  /**
   * Одноразовый запрос вне сессии (✦ сообщение коммита): строковый промпт, один ход, без инструментов,
   * MCP и размышлений. В список сессий не попадает: `persistSession: false` — движок не пишет транскрипт
   * в `~/.claude/projects`, а список читается оттуда. Страховка на движок, который флаг не учёл (свой
   * `claude` из `agentura.claudeExecutable`), — файл транскрипта с id этого запроса удаляется.
   * Нет ответа за `timeoutMs` — ошибка; процесс закрывается в любом случае (`close()` и `abort`).
   */
  async complete(cwd: string, request: CompletionRequest): Promise<string> {
    const sdk = await this.loadSdk();
    const abort = new AbortController();
    const timeoutMs = request.timeoutMs ?? COMPLETE_TIMEOUT_MS;
    const q = sdk.query({
      prompt: request.prompt,
      options: {
        ...(await this.baseOptions(cwd)),
        systemPrompt: request.system,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        thinking: { type: 'disabled' },
        effort: 'low',
        // без инструментов спрашивать нечего, но `defaultMode` пользователя (`auto`) не берём
        permissionMode: 'default',
        persistSession: false,
        ...(request.model ? { model: request.model } : {}),
        abortController: abort,
      },
    });
    let sessionId: string | undefined;
    const read = async (): Promise<string> => {
      for await (const m of q) {
        if (typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id;
        if (m.type !== 'result') continue;
        if (m.subtype === 'success' && !m.is_error) return m.result;
        throw new Error(
          m.subtype === 'success' ? m.result || 'error' : m.errors.join('; ') || m.subtype,
        );
      }
      throw new Error('движок завершился без ответа');
    };
    // проигравший гонку с таймаутом поток оборвётся на `close()` — без обработчика это unhandled rejection
    const reading = read();
    reading.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reading,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`движок не ответил за ${Math.round(timeoutMs / 1000)} с`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        q.close();
      } catch (error) {
        this.config.log?.('warn', `complete: закрытие query: ${String(error)}`);
      }
      abort.abort();
      if (sessionId) await this.dropTranscript(cwd, sessionId);
    }
  }

  /** Транскрипт одноразового запроса, если движок его всё же записал, — удалить (иначе он в списке сессий). */
  private async dropTranscript(cwd: string, sessionId: string): Promise<void> {
    const home = (this.config.env ?? process.env)['CLAUDE_CONFIG_DIR'] || defaultClaudeHome();
    const file = transcriptPath(cwd, sessionId, home);
    try {
      await unlink(file);
      this.config.log?.(
        'warn',
        `complete: движок записал транскрипт вопреки persistSession — удалён ${file}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.config.log?.('warn', `complete: транскрипт ${file}: ${String(error)}`);
    }
  }

  async baseOptions(cwd: string): Promise<Options> {
    const options: Options = {
      cwd,
      env: engineEnv(this.config.env ?? process.env, this.config.clientApp),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: this.config.settingSources ?? ['user', 'project', 'local'],
      stderr: (data) => this.config.log?.('debug', `claude stderr: ${data.trimEnd()}`),
    };
    const exe =
      typeof this.config.executablePath === 'function'
        ? await this.config.executablePath()
        : this.config.executablePath;
    if (exe) options.pathToClaudeCodeExecutable = exe;
    return options;
  }
}

class ClaudeSession implements AgentSession {
  readonly events: EventHub<AgentEvent>;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly mapper: ClaudeEventMapper;
  private readonly broker: PermissionBroker;
  private readonly q: Query;
  private readonly log: LogFn;
  private closed = false;
  private readonly trace: ((message: unknown) => void) | undefined;
  private resumedId: string | undefined;
  /** Effort, заданный расширением (при создании или из меню): движок его в `init` не сообщает. */
  private effort: EffortLevel | undefined;
  /** Модель из последнего `session.init` (или из опций) — для сессии на claude.ai. */
  private model: string | undefined;
  /** Мост Remote Control: создаётся при первом включении. */
  private remote: RemoteBridge | undefined;
  private readonly remoteConfig: RemoteConfig | undefined;
  private readonly cwd: string;
  private readonly title: string | undefined;
  /** Режим разрешений сейчас (опции, `setMode`, `mode.changed`): `comment` без вопроса — не в режиме plan. */
  private mode: PermissionMode;
  /** Инструменты задачи Jira (этап 8): сигнатура набора, с которым сейчас подключён сервер `agentura_jira` ('' — не подключён). */
  private jiraSig = '';
  private offTaskTools: (() => void) | undefined;
  /** Когда `comment` прошёл без вопроса (окно `AUTO_WINDOW_MS`). */
  private autoComments: number[] = [];
  private readonly taskTools: TaskTools | undefined;
  /** Статус MCP запрашивается сам после старта и каждого хода (`SessionOptions.mcpWatch`, roadmap 21). */
  private mcpWatch: boolean;
  /** Номер последнего `mcpServerStatus()` и «ответ обязан дать событие» (`refreshMcp`). */
  private mcpSeq = 0;
  private mcpForce = false;

  constructor(
    sdk: SdkModule,
    config: ClaudeAdapterConfig,
    base: Options,
    options: SessionOptions & ResumeOptions,
    resume?: string,
    private readonly kit?: McpKit,
  ) {
    this.log = config.log ?? (() => {});
    this.trace = config.trace;
    this.events = new EventHub<AgentEvent>((e) =>
      this.log('error', `подписчик событий упал: ${String(e)}`),
    );
    this.resumedId = resume;
    this.remoteConfig = config.remote;
    this.cwd = options.cwd;
    this.title = options.title;
    this.model = options.model;
    this.mcpWatch = options.mcpWatch === true;
    this.mapper = new ClaudeEventMapper({
      baselineCostUsd: resume ? options.baselineCostUsd : 0,
      ...(config.lang ? { lang: config.lang } : {}),
    });
    this.broker = new PermissionBroker(
      (e) => this.emit(e),
      (taskId) => this.mapper.agentIdForTask(taskId),
    );

    const sdkOptions: Options = {
      ...base,
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      forwardSubagentText: true,
      // Брокер отдаёт подсказки движка (`PermissionUpdate[]`) как пришли — тип сужаем здесь.
      canUseTool: (toolName, input, opts) =>
        this.autoAllow(toolName, input, opts.mcpServer)
          ? Promise.resolve({ behavior: 'allow', updatedInput: input })
          : (this.broker.canUseTool(toolName, input, this.jiraAsk(toolName, opts)) as Promise<PermissionResult>),
    };
    if (options.model) sdkOptions.model = options.model;
    // Режим задаём всегда: иначе движок возьмёт `permissions.defaultMode` из настроек пользователя
    // (у владельца — `auto`, классификатор вместо вопросов), а расширение режимы `auto`/`dontAsk` не ведёт.
    sdkOptions.permissionMode = this.mode = options.permissionMode ?? 'default';
    if (options.allowBypassPermissions) sdkOptions.allowDangerouslySkipPermissions = true;
    if (options.effort) sdkOptions.effort = this.effort = options.effort;
    if (options.title) sdkOptions.title = options.title;
    if (resume) sdkOptions.resume = resume;
    // «Повторить ход»: оборванный ход отбрасывается при возобновлении, промпт не двоится в транскрипте
    if (resume && options.dropTurn) {
      sdkOptions.resumeSessionAt = options.dropTurn.keepUuid;
      sdkOptions.resumeDropsTurn = options.dropTurn.promptUuid;
    }

    // инструменты задачи Jira: сервер `agentura_jira`, пока у чата есть задача с записью; набор меняется — `setMcpServers`
    const tools = (this.taskTools = kit ? options.taskTools : undefined);
    const spec = tools?.spec();
    if (kit && tools && spec) {
      sdkOptions.mcpServers = { [JIRA_SERVER]: buildJiraServer(kit, spec, tools) };
      this.jiraSig = specSignature(spec);
    }

    this.q = sdk.query({ prompt: this.input, options: sdkOptions });
    if (tools) {
      this.offTaskTools = tools.onDidChange(() => this.syncTaskTools(tools));
      // bypassPermissions (и auto) иначе пропустили бы transition/worklog без карточки — решение 13 обещает вопрос всегда.
      // Только ужесточает; запоминается и до подключения сервера (`setMcpServers` посреди сессии)
      void Promise.resolve()
        .then(() => this.q.setMcpPermissionModeOverride(JIRA_SERVER, 'default'))
        .catch((e: unknown) => this.log('warn', `инструменты Jira: setMcpPermissionModeOverride: ${String(e)}`));
    }
    void this.pump();
  }

  /** Вызов нашего in-process сервера: SDK отдаёт `mcpServer.source = 'sdk'` (старый CLI поля не шлёт — тогда по имени). */
  private static ownServer(server: { name: string; source: string } | undefined): boolean {
    return !server || (server.source === 'sdk' && server.name === JIRA_SERVER);
  }

  /**
   * Карточка инструмента Jira: «Всегда разрешать» — только до конца сессии. Подсказки движка пишут правило в
   * `.claude/settings.local.json` — оно действовало бы во всех сессиях проекта и в самом CLI (приёмка этапа 8).
   */
  private jiraAsk<O extends { suggestions?: unknown[]; mcpServer?: { name: string; source: string } }>(toolName: string, opts: O): O {
    if (!jiraToolOf(toolName) || !ClaudeSession.ownServer(opts.mcpServer) || !opts.suggestions?.length) return opts;
    return {
      ...opts,
      suggestions: opts.suggestions.map((s) =>
        s && typeof s === 'object' && 'destination' in s ? { ...(s as Record<string, unknown>), destination: 'session' } : s,
      ),
    };
  }

  /**
   * `comment` к задаче чата — без вопроса (решение 13), кроме режима plan; к другой задаче — обычной карточкой. Приёмка этапа 8:
   * только наш сервер (`mcpServer.source`), короткий текст без похожего на секрет (`autoCommentOk`) и не чаще
   * `AUTO_COMMENTS` за `AUTO_WINDOW_MS` — остальное тоже карточкой.
   */
  private autoAllow(toolName: string, input: Record<string, unknown>, server?: { name: string; source: string }): boolean {
    if (toolName !== JIRA_COMMENT_TOOL || !this.jiraSig || this.mode === 'plan' || !ClaudeSession.ownServer(server)) return false;
    const issue = input['issue'];
    const own = this.taskTools?.spec()?.issue;
    const ownIssue =
      issue === undefined ||
      (typeof issue === 'string' && !!own && issue.trim().toUpperCase() === own.toUpperCase());
    if (!ownIssue || !autoCommentOk(input['text'])) return false;
    const now = Date.now();
    this.autoComments = this.autoComments.filter((t) => now - t < AUTO_WINDOW_MS);
    if (this.autoComments.length >= AUTO_COMMENTS) return false;
    this.autoComments.push(now);
    return true;
  }

  /** Привязка/отвязка задачи, смена источника или настройки: сервер `agentura_jira` подключается, пересобирается или снимается. */
  private syncTaskTools(tools: TaskTools): void {
    if (this.closed || !this.kit) return;
    const spec = tools.spec();
    const sig = specSignature(spec);
    if (sig === this.jiraSig) return;
    this.jiraSig = sig;
    // `setMcpServers` заменяет только серверы, добавленные через SDK (у нас — один `agentura_jira`); серверы из настроек не трогает
    const servers: Record<string, McpServerConfig> = spec
      ? { [JIRA_SERVER]: buildJiraServer(this.kit, spec, tools) }
      : {};
    this.q
      .setMcpServers(servers)
      .then((r) => {
        if (this.mcpWatch) void this.refreshMcp(false);
        const err = r.errors[JIRA_SERVER];
        if (!err) return;
        this.log('warn', `инструменты Jira: сервер не подключился: ${err}`);
        if (this.jiraSig === sig) this.jiraSig = ''; // следующее изменение набора попробует снова
      })
      .catch((e: unknown) => {
        this.log('warn', `инструменты Jira: setMcpServers: ${String(e)}`);
        if (this.jiraSig === sig) this.jiraSig = '';
      });
  }

  get id(): string {
    return this.mapper.sessionId ?? this.resumedId ?? '';
  }

  /**
   * Своё `uuid` у каждого сообщения: движок возвращает его эхом (`user_message_uuid(s)`) на первом
   * ответе хода, и маппер привязывает промпт к ходу по нему, а не по очереди.
   */
  send(text: string, images?: readonly PromptImage[], files?: readonly PromptFile[]): boolean {
    if (this.closed) return false;
    const uuid = randomUUID();
    this.mapper.notePrompt(
      text,
      uuid,
      images?.length ? images : undefined,
      files?.length ? files : undefined,
    );
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: userContent(text, images, files) },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage['uuid'],
    };
    this.input.push(message);
    this.remote?.notePrompt(message);
    return true;
  }

  respondPermission(toolUseId: string, decision: PermissionDecision, message?: string): boolean {
    return this.broker.respondPermission(toolUseId, decision, message);
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    return this.broker.answerQuestion(toolUseId, answers);
  }

  decidePlan(toolUseId: string, decision: PlanDecision): boolean {
    return this.broker.decidePlan(toolUseId, decision);
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
    this.mode = mode;
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
  }

  /** Подтверждения в потоке нет (docs/spikes/sdk-probe.md, раздел 2) — интерфейс показывает то, что отправили. */
  async setEffort(effort: EffortLevel): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.effort = effort;
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  compact(): boolean {
    return this.send('/compact');
  }

  async stopTask(taskId: string): Promise<void> {
    await this.q.stopTask(taskId);
  }

  async contextUsage(): Promise<AgentEventOf<'context.usage'> | undefined> {
    try {
      return this.mapper.contextFromEngine(await this.q.getContextUsage());
    } catch (error) {
      this.log('warn', `getContextUsage не ответил: ${String(error)}`);
      return undefined;
    }
  }

  async capabilities(): Promise<SessionCapabilities> {
    const result: SessionCapabilities = { models: [], commands: [] };
    try {
      for (const m of await this.q.supportedModels()) {
        const option: ModelOption = { value: m.value, displayName: m.displayName };
        if (m.description) option.description = m.description;
        if (m.supportsEffort !== undefined) option.supportsEffort = m.supportsEffort;
        if (m.supportedEffortLevels) option.effortLevels = m.supportedEffortLevels as EffortLevel[];
        result.models.push(option);
      }
    } catch (error) {
      this.log('warn', `supportedModels не ответил: ${String(error)}`);
    }
    try {
      for (const c of await this.q.supportedCommands()) {
        const option: CommandOption = { name: c.name, description: c.description };
        if (c.argumentHint) option.argumentHint = c.argumentHint;
        result.commands.push(option);
      }
    } catch (error) {
      this.log('warn', `supportedCommands не ответил: ${String(error)}`);
    }
    return result;
  }

  /** Статус MCP-серверов (`mcpServerStatus()`) → `mcp.status`; запрос пользователя — событие и без изменений. */
  async mcpStatus(): Promise<void> {
    await this.refreshMcp(true);
  }

  /** «повторить» у сервера: `reconnectMcpServer`, затем свежий статус (и при ошибке — она уже в статусе сервера). */
  async mcpReconnect(name: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.q.reconnectMcpServer(name);
    } catch (error) {
      this.log('warn', `reconnectMcpServer(${name}) не ответил: ${String(error)}`);
    }
    await this.refreshMcp(true);
  }

  setMcpWatch(on: boolean): void {
    const was = this.mcpWatch;
    this.mcpWatch = on;
    // включили настройку посреди сессии: статус сразу, не ждать конца хода
    if (on && !was && this.mapper.sessionId) void this.refreshMcp(false);
  }

  private async refreshMcp(force: boolean): Promise<void> {
    if (this.closed) return;
    // опросы могут перекрыться (конец хода, ↻, смена Jira): ответ старше последнего запроса отбрасываем, а
    // «событие обязательно» запроса пользователя переходит к последнему
    const seq = ++this.mcpSeq;
    if (force) this.mcpForce = true;
    try {
      const raw = await this.q.mcpServerStatus();
      if (seq !== this.mcpSeq || this.closed) return;
      const event = this.mapper.mcpFromEngine(raw, this.mcpForce);
      this.mcpForce = false;
      if (event) this.emit(event);
    } catch (error) {
      // сессию закрыли, пока шёл запрос: отказ control-запроса ожидаем, не шумим
      if (!this.closed) this.log('warn', `mcpServerStatus не ответил: ${String(error)}`);
    }
  }

  /** Remote Control вкладки: включение — мост к claude.ai (лениво), выключение — досылка и закрытие. */
  async setRemote(on: boolean): Promise<void> {
    if (!on) {
      await this.remote?.disable();
      return;
    }
    if (this.closed) return;
    this.remote ??= new RemoteBridge(
      {
        cwd: this.cwd,
        title: this.title,
        model: () => this.model,
        closed: () => this.closed,
        emit: (e) => this.emit(e),
        prompt: (message, text) => {
          this.mapper.notePrompt(text, message.uuid as string);
          this.input.push(message);
        },
        resolvePermission: (toolUseId, result) => this.broker.resolveExternal(toolUseId, result),
        query: this.q,
        log: this.log,
      },
      this.remoteConfig,
    );
    this.broker.observer = this.remote;
    await this.remote.enable();
  }

  dispose(): void {
    if (this.closed) return;
    this.close('disposed');
    try {
      this.q.close();
    } catch (error) {
      this.log('warn', `закрытие query: ${String(error)}`);
    }
  }

  /**
   * Конец сессии: сначала отменить ждущие разрешения (их `permission.resolved {by: 'abort'}` должны
   * дойти), потом `session.closed`, потом закрыть поток событий — `for await` у подписчиков завершается.
   */
  private close(reason: 'exit' | 'error' | 'disposed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.offTaskTools?.();
    this.offTaskTools = undefined;
    this.broker.cancelAll();
    // мост — без ожидания: закрытие сессии не ждёт досылки на claude.ai
    if (this.remote) void this.remote.disable();
    this.input.end();
    this.events.emit({ type: 'session.closed', reason, ...(message ? { message } : {}) });
    this.events.close();
  }

  private emit(event: AgentEvent): void {
    if (event.type === 'mode.changed') this.mode = event.mode;
    else if (event.type === 'session.init') this.mode = event.permissionMode;
    this.events.emit(event);
  }

  private async pump(): Promise<void> {
    let first = true;
    try {
      for await (const message of this.q) {
        if (this.closed) break;
        this.trace?.(message);
        this.remote?.mirror(message);
        for (const event of this.mapper.map(message)) {
          this.emit(
            event.type === 'session.init' && this.effort
              ? { ...event, effort: this.effort }
              : event,
          );
          // Окно до первого ответа неизвестно: `getContextUsage()` работает и до хода (раздел 4 пробы).
          if (event.type === 'session.init') this.model = event.model || this.model;
          if (event.type === 'session.init' && first) {
            first = false;
            void this.emitContext();
            if (this.mcpWatch) void this.refreshMcp(false);
          }
          if (event.type === 'turn.result') {
            void this.emitContext();
            if (this.mcpWatch && !event.agentId) void this.refreshMcp(false);
          }
        }
      }
      this.close('exit');
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `поток движка оборвался: ${message}`);
      this.emit({ type: 'error', fatal: true, message });
      this.close('error', message);
    }
  }

  private async emitContext(): Promise<void> {
    const event = await this.contextUsage();
    if (event) this.emit(event);
  }
}
