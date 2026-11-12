# Antigravity (`agy acp`): протокол взаимодействия

Снято и выверено на `agy 1.5.6+` (включая поведение `1.5.6` / `1.5.7`; первичные логи и спайк контракта `1.5.3` — `docs/spikes/antigravity-acp/report.md`, эталонные кадры — `test/fixtures/antigravity/acp-pong.ndjson`).
Минимальная поддерживаемая версия CLI — `agy >= 1.5.0` (проверяется в `src/agent/antigravity/executable.ts`).
Взаимодействие строится через официальный протокол ACP (`agy acp`) по JSON-RPC 2.0 поверх stdio (один JSON на строку). `node:sqlite`, `conversation_summaries.db`, `transcript_full.jsonl` и устаревший режим `stream-json` полностью исключены; в `~/.gemini` **ничего не пишется**.

Узкое read-only исключение для каталога данных `<dataDir>` (`~/.gemini/antigravity-cli`):
- компактные логи `brain/<uuid>/.system_generated/logs/transcript.jsonl` (строго с проверкой UUID): чтение последних 64 КБ родительского лога для точного `usedTokens` (`context.ts`), инкрементальное чтение хвоста родительского лога для тихого реактивного пробуждения (`AgyParentTranscriptTailer`) и инкрементальное чтение дочерних логов субагентов (`AgySubagentReader`, `agySubagentMarkdown`, `withAgySubagentTimelines` в `subagents.ts`);
- однократное чтение списка имён подкаталогов `<dataDir>/mcp` (`readAgyMcpServers` в `tools.ts`) для точного разреза имён MCP-серверов.

## 1. Запуск и жизненный цикл процесса

| Что | Команда | Где в коде |
| --- | --- | --- |
| Сессия ACP | Долгоживущий процесс на открытую вкладку: `agy acp` (или `agy acp --dangerously-skip-permissions` при разрешённом `bypassPermissions`) | `src/agent/antigravity/adapter.ts`, `src/agent/acp/client.ts` |
| Версия | `agy --version` (или `agentInfo.version` из `initialize`) | `src/agent/antigravity/executable.ts` |
| Каталог моделей | `agy models` (или `configOptions` / `models` из `session/new`, с очисткой `\r`-спиннера) | `src/agent/antigravity/models.ts` |
| Квота аккаунта | `agy -p "/usage"` (TSV по пулам квот, кэш 10 мин, кулдаун ошибки 60 с, таймаут 30 с + сторож 35 с) | `src/agent/antigravity/quota.ts`, `src/extension/agyQuota.ts` |
| Авторизация | `agy acp --login` (интерактивный вход в терминале VS Code) | `src/extension/sidebarView.ts` |

### Жизненный цикл сессии
- **Открытие вкладки (`createSession` / `resumeSession`)**: порождает отдельный процесс `agy acp` с рабочей директорией `cwd` (в режиме `bypassPermissions` при `agentura.allowBypassPermissions: true` — с флагом `--dangerously-skip-permissions`).
- **Инициализация (`handshake`)**:
  - Клиент отправляет `initialize`:
    `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } }`.
  - Сервер отвечает `agentInfo` (`version: "1.5.6"` / `"1.5.7"`), `agentCapabilities` (`loadSession: true`, `promptCapabilities: { image: true, embeddedContext: true }`, `sessionCapabilities: { resume, close, load, list, additionalDirectories }`, `_meta.antigravity: { tier: true }`).
  - `AccountInfo.plan` считывается из `_meta.antigravity.tier.name` (например, `"Google AI Pro"`).
- **Создание или возобновление**:
  - Новая сессия: `session/new` `{ cwd, mcpServers: [] }` возвращает `sessionId`, `models`, `modes`, `configOptions`.
  - Возобновление сессии: `session/resume` `{ sessionId, cwd, mcpServers: [] }` восстанавливает контекст беседы на стороне сервера без реплея истории.
- **Внеходовые уведомления `session/update`**:
  - `available_commands_update`: прилетает сразу на `session/new` и `session/resume` (в том числе пока идёт `handshake` и `loading === true`, а также между ходами). Адаптер извлекает дедуплицированные имена команд без ведущего `/` (`availableCommandsOf`), кладёт их в `session.init.slashCommands` для меню `/` в поле ввода и перевыпускает `session.init`, если список изменился уже после старта.
  - `session_info_update`: сгенерированный сервером `title` беседы часто приходит через 100–500 мс **после** завершения `session/prompt` (когда активного `turn` уже нет). Адаптер принимает его при `!loading` вне хода и эмитит `{ type: 'session.title', title }`.
- **Очередь сообщений**: отправка промптов выполняется через `session/prompt` последовательно; повторные запросы выстраиваются в очередь.
- **Прерывание (Stop)**: отправляет уведомление `session/cancel` `{ sessionId }`. Сервер завершает активный шаг модели или прерывает выполняющуюся команду/разрешение, возвращая `stopReason: "cancelled"` (при активном внеходовом `wakeupTurn` или тихом ходе `AgyParentTranscriptTailer` они также штатно закрываются как прерванные). Процесс `agy acp` остаётся живым и готовым к следующим сообщениям.
- **Закрытие (`dispose`)**:
  - Останавливает поллеры субагентов, закрывает `stdin.end()` → grace-ожидание завершения (позволяет `agy` штатно сохранить состояние беседы) → `SIGTERM` при превышении таймаута → `SIGKILL`.
- **Вспомогательные операции вне вкладок** (`listSessions`, `loadHistory`, холодный `accountInfo`): поднимают кратковременный процесс `agy acp` (без `--dangerously-skip-permissions`), выполняют RPC и штатно закрывают процесс. При `loadHistory` и `agentTranscript` дополнительно в read-only режиме читаются компактные `brain/<uuid>/.system_generated/logs/transcript.jsonl` и список папок `<dataDir>/mcp`.

## 2. Модели, рассуждения, режимы и наследование прав

Настройки подтверждённой сессии (`model`, `effort`, явно выбранный режим) Agentura сохраняет в `globalState` (`agentura.antigravity.sessionSettings`) и применяет при `resume`. Ответ `session/load` содержит дефолты нового процесса, поэтому его настройки не используются как история. Для старых или внешних сессий, настройки которых Agentura не сохраняла, прежнюю модель/effort восстановить нельзя.

### Управление моделью и уровнем рассуждений (`thought_level`)
В `agy 1.5.6+` `configOptions` отдаёт независимые селекты:
- `model`: базовые модели, включая добавленную `gemini-4-carbon` (`gemini-4-argon`, `gemini-4-carbon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`).
- `thought_level`: уровни рассуждений (`low`, `medium`, `high`).
- `models.availableModels`: комбинированные ID (`<model>-{low,medium,high}` для моделей с поддержкой рассуждений и одиночный `gpt-oss-120b-medium`).
- При чтении `agy models` (`parseModels` в `src/agent/antigravity/models.ts`) каждая строка предварительно очищается от промежуточных кадров TTY-спиннера `\r⠋ Fetching...` через `stripAgySpinnerLine` (берётся финальный сегмент после `\r`).

**Поведение `gpt-oss-120b-medium` и смены модели**:
- При переключении на `gpt-oss-120b-medium` селект `thought_level` **исчезает** из `configOptions`; вызов `session/set_config_option` с `configId: "thought_level"` вернёт ошибку JSON-RPC `-32602`.
- Адаптер хранит желаемый `effort` локально и отправляет `thought_level`, только когда селект присутствует в актуальных `configOptions`. При возврате на модель с поддержкой уровней (Gemini / Claude) сохранённый `effort` досылается автоматически.
- **Таблица окон моделей (`agyContextWindow` в `src/agent/antigravity/models.ts`)**:
  - `gemini-*` (включая `gemini-4-argon`, `gemini-4-carbon`, `gemini-3.8-flash`) → `1 000 000` токенов.
  - `claude-*` → `200 000` токенов.
  - `gpt-oss-120b*` → `128 000` токенов.
  - Неизвестные модели → `maxTokens: 0` (без подстановки ложных дефолтов `200k`, чтобы UI корректно скрывал шкалу заполнения).
- **При смене модели**: серверный контекст беседы сохраняется; адаптер сразу перевыпускает `session.init` и `context.usage` с окном новой модели и текущим `usedTokens`. При ошибке `session/set_config_option` эмитится нефатальный `error`, а селект UI откатывается перевыпуском `session.init`.

### Режимы (`mode`) и сохранность серверного `'auto'`
В `agy >= 1.5.4` сервер поддерживает 4 режима (`AgyModeId`, читаются через `availableModesOf` из `modes.availableModes`):
- `default`: запрос подтверждения для правок и команд через живые разрешения.
- `accept-edits`: автоматическое одобрение правок файлов в воркспейсе без запроса прав.
- `auto`: серверное авто-одобрение правок и безопасных команд.
- `plan`: планирование задачи (ответ выводится обычным текстом, серверных карточек утверждения плана нет).

Маппинг режимов Agentura (`PermissionMode`):
- `default` → `default`
- `acceptEdits` → `accept-edits`
- `plan` → `plan`
- Серверный `'auto'` отображается в UI как `'acceptEdits'` (`permissionModeOf('auto') === 'acceptEdits'`), однако `AgySession` хранит флаг `explicitMode`: если при `resumeSession` режим не был задан явно и сервер вернул `currentModeId === 'auto'`, `syncInitialMode()` **не отправляет** `session/set_mode` и `saveSettings()` не записывает принудительный режим, благодаря чему серверный `'auto'` не сбивается круговой перезаписью в `'accept-edits'`.

### Наследование `bypassPermissions` субагентами (`--dangerously-skip-permissions`)
- **Почему фоновые субагенты виснут в `default`**: в протоколе `agy acp` канал `session/request_permission` закрывается при завершении родительского `session/prompt` и не пересылает запросы разрешений от фоновых дочерних `conversationId` в родительский stdio-поток. Поэтому в режиме `default` фоновый субагент на первом вызове `run_command` встаёт в статус `waiting_for_input`.
- **Серверное наследование прав**: при `permissionMode === 'bypassPermissions'` и включённом `agentura.allowBypassPermissions: true` (`allowBypass === true`) адаптер запускает процесс как `agy acp --dangerously-skip-permissions` (`agySpawnArgs`), переводит режим сессии в `accept-edits` и авто-одобряет входящие запросы родителя. Флаг `--dangerously-skip-permissions` обрабатывается бэкендом `agy` и **наследуется всеми дочерними субагентами и git worktree** (при этом системный denylist разрушительных команд и явные `Deny`-правила `agy` продолжают действовать). При `allowBypass === false` флаг никогда не передаётся, а режим понижается до `default`.
- **Прозрачный перезапуск на `setMode`**: при переключении между `bypassPermissions` и обычными режимами меняется набор аргументов CLI (`needsRespawn`). Если ход не идёт (`!this.turn && !this.compacting && !this.loading`), `AgySession.respawnTransport()` штатно закрывает текущий процесс `agy acp` без эмита `session.closed`, поднимает новый процесс с нужными флагами и прозрачно восстанавливает ту же вкладку через `session/resume` на том же `sessionId` с сохранением `model`, `effort` и `cwd`. Если `setMode` вызван посреди активного хода или `/compact`, выставляется `pendingRespawn = true`, и прозрачный `session/resume` выполняется сразу в `finally` завершившегося хода.

## 3. Ход, ретраи API, картинки, токены и квота `/usage`

### Формат стриминга и перехват транзиентных ошибок `api_retry`
- Входящий промпт: `session/prompt` `{ sessionId, prompt: [ ...PromptBlock ] }`.
- Поддержка картинок: `PromptBlock` вида `{ type: "image", data: "<base64>", mimeType }` отправляется перед текстовым блоком `{ type: "text", text }`.
- На старте хода сервер присылает эхо промпта `user_message_chunk` (игнорируется адаптером).
- Текст ответа: стримится кадрами `session/update` с `sessionUpdate: "agent_message_chunk"`, `{ content: { type: "text", text } }` → транслируется в `text.delta`.
- **Перехват сетевых ретраев (`api_retry`)**: при транзиентном сбое запроса к Cloud Code (`connection reset by peer`, `i/o timeout`, `HTTP 429/5xx`) бинарник `agy` шлёт строку `\n⚠ API error (attempt N): ...\n` прямо внутри `agent_message_chunk`. `AgyAcpMapper.applyUpdate` вырезает такие вхождения регулярным выражением (как из одиночных чанков, так и из склеенных чанков с текстом вокруг), закрывает открытый блок `thinking`, сбрасывает `messageId`, **не** добавляет предупреждение в `turn.result.text` и эмитит нефатальное событие `{ type: 'error', fatal: false, code: 'api_retry', message }` (с очисткой сырых URL). В UI (`chatState.ts`) `retryRow` закрывает открытый стримящийся текстовый блок и схлопывает серию подряд идущих ретраев в компактную плашку повтора.
- Рассуждения: `sessionUpdate: "agent_thought_chunk"` транслируется в `thinking.start` / `thinking.delta` / `thinking.stop` (закрывается перед текстом, ретраем или инструментами).
- Название сессии: `sessionUpdate: "session_info_update"` `{ title }` обновляет `session.title` как внутри хода, так и после его завершения.

### Токены и контекстное окно
- Ответ `session/prompt` возвращает объект `usage`:
  `{ inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens }`.
  - `inputTokens` в ACP уже очищен от кэша: `totalTokens = inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens`.
  - `thoughtTokens` включён в `outputTokens`.
  - Маппится в `turn.result.usage` с `usageKnown: true`. Стоимость (`costUsd`) сервером не отдаётся (`cost: false`).
- Расчёт использования контекста (`context.usage`, `context: true`):
  - Суммарный `session/prompt.result.usage` складывает токены всех промежуточных шагов хода и на многошаговых ходах с вызовами инструментов кратно завышает реальную заполненность окна.
  - `src/agent/antigravity/context.ts` читает актуальный `usedTokens` из последнего завершённого шага `PLANNER_RESPONSE` (`status: "DONE"`) в хвосте `brain/<sessionId>/.system_generated/logs/transcript.jsonl` (`input_tokens + cache_read_tokens + cache_write_tokens + output_tokens`) на старте сессии, в `loadHistory`, асинхронно при каждом `tool_call` и в конце хода (с ретраем `2 × 80 мс` и одношаговым фолбэком по `result.usage`, если `toolCalls === 0`).
- Нативное сжатие контекста (`/compact`, `compact: true`):
  - Отправка `session/prompt` с текстом `"/compact"` инициирует серверное сжатие беседы (в `transcript.jsonl` пишется шаг `CHECKPOINT` без лишнего эха в чат) в обёртке `compaction.start` → `compaction.end` (`durationMs`, `preTokens`).

### Квота аккаунта (`agy -p "/usage"`), эндпоинты и `AgyQuotaService`
- **Почему `/usage` нельзя слать в `session/prompt`**: в режиме `agy acp` слэш-команда `/usage` не перехватывается локально сервером, а отправляется обычным пользовательским сообщением в LLM, расходуя генерационную квоту. Единственный штатный канал чтения лимитов — отдельный вызов `agy -p "/usage"` (`src/agent/antigravity/quota.ts`).
- **Разница эндпоинтов `agy acp` и `agy -p "/usage"`**:
  - Чат `agy acp` работает через хост **`daily-cloudcode-pa.googleapis.com`**.
  - Режим `printmode` (`agy -p "/usage"`) в `agy 1.5.6+` перед выполнением команды вызывает `printmode.waitForEligibility` на хосте **`aicode.googleapis.com`**. Если при split-tunnel VPN маршруты этих двух доменов расходятся, чат работает штатно, а `agy -p "/usage"` завершается с кодом `1` и `stderr`: `error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.`
- **Парсинг и именные пулы (`parseAgyUsage`)**:
  - Перед разбором TSV-строк счищаются ANSI-последовательности и промежуточный `\r`-спиннер (`stripAgySpinnerLine`).
  - В общий ключ `'Gemini'` сворачивается только общий пул (`Gemini` / `Gemini Models` → `Gemini 5ч`, `Gemini 7д`), тогда как выделенные пулы конкретных моделей (`Gemini 4 Argon`, `Gemini 4 Carbon` и др.) сохраняются отдельными семействами наряду с `Claude/GPT` и не перезаписывают кольцо общего пула `Gemini` в HUD и панели лимитов.
- **Модель состояний `AgyQuotaService` (`src/extension/agyQuota.ts`)**:
  - Хранит снимок `{ state: 'loading' | 'ok' | 'signedOut' | 'missing' | 'error', rows, updatedAt, error? }`.
  - Штатный интервал опроса — `10 мин` (`AGY_QUOTA_INTERVAL_MS`), но при состоянии `'error'` включается короткий кулдаун **`60 с`** (`AGY_QUOTA_ERROR_COOLDOWN_MS = 60_000`), а ручная кнопка обновления в UI вызывает `refresh(true)` мимо кулдауна.
  - При транзиентном сетевом сбое, региональной ошибке `Eligibility check failed` или пустом выводе без явного маркера разлогина (`isAgyAuthError`) сервис переходит в `state: 'error'` с чистым текстом причины из `stderr`/`stdout`, **сохраняя прежние кэшированные `rows` и `updatedAt`**, чтобы панель `EngineLimits` и тултип HUD сразу показывали диагностику вместо бесконечного `loading` или ложного разлогина.

## 4. Инструменты `oneharness`, MCP, диффы и ссылки `conversation://`

Сервер присылает `sessionUpdate: "tool_call"` и `"tool_call_update"`.

### Базовые инструменты (`oneharness` и `cortex`)
Маппинг в `src/agent/antigravity/tools.ts` приводит вызовы к карточкам ленты Agentura:
- `run_command` → `Bash` (`command`, `description`, `cwd`).
- `read_file` / `view_file` → `Read` (`file_path`; чтение файлов навыков `SKILL.md` остаётся обычной карточкой `Read`).
- `write_file` / `write_to_file` → `Write` (`file_path`, `content`).
- `edit_file` / `replace_file_content` / `multi_replace_file_content` → `Edit` / `MultiEdit` (`file_path`, `old_string`, `new_string`).
- `search_web` → `WebSearch` (`query`, `domain`); `read_url_content` → `WebFetch` (`url`).
- `grep_search` → `Grep` (`pattern`, `path`); `find_by_name` → `Glob` (`pattern`, `path`); `notebook_edit` → `NotebookEdit`.
- `ask_question` → `AskUserQuestion` (интерактивная форма `elicitation/create`).

### Eager и Lazy MCP-инструменты
- **Точный разрез eager MCP (`mcp_<server>_<tool>`)**: в `agy` eager-инструменты склеиваются одинарным подчёркиванием, при этом сами имена серверов содержат `_` и `-` (например, `hansard_history` → `mcp_hansard_history_search_past_sessions`, `gemini-api_gemini-api-docs` → `mcp_gemini-api_gemini-api-docs_gemini_search_docs`, `flutter_dart-mcp-server`). Адаптер один раз за жизнь читает имена подкаталогов из `<dataDir>/mcp` (`readAgyMcpServers`, без ошибок при отсутствии папки), сортирует их по убыванию длины и ищет самое длинное совпадение префикса `mcp_${server}_`, нормализуя имя в `mcp__<server>__<tool>`. Если папка сервера не найдена — используется фолбэк по первому `_` после `mcp_`.
- **Нормализация lazy MCP**: вызовы `call_mcp_tool`, `list_resources` и `read_resource` с полем `ServerName` приводятся к `mcp__<ServerName>__<ToolName>` / `mcp__<ServerName>__list_resources` / `mcp__<ServerName>__read_resource` с распаковкой `Arguments` (или `Uri`). Благодаря этому `toolView` отображает единый чип MCP-сервера (`op: 'mcp', server`) и учитывает вызовы в счётчике `counts.mcp`.

### Инструменты оркестрации и ссылки `conversation://<uuid>`
- **Оркестрация**:
  - `invoke_subagent` → карточка `Agent` (`description: Role ?? TypeName`, `prompt: Prompt`, `subagent_type: TypeName`, `model: Model`, `workspace: Workspace`), вокруг которой строится инлайн-группа `AgentGroup`.
  - `manage_subagents` (`op: 'agent'`), `send_message` (`op: 'msg'`), `define_subagent` (`op: 'agent'`), `manage_task` (`op: 'task'`), `schedule` (`op: 'cron'` или `'timer'`), `swarm` (`op: 'swarm'`) имеют собственные человекочитаемые подписи в `src/webview/toolView.ts`.
- **Открытие ссылок `conversation://<uuid>`**:
  - В `src/webview/markdown.ts` схема `conversation://` разрешена в `DOMPurify` (при сохранении жёсткого запрета на `javascript:`, `data:`, `vbscript:`, `command:`, `vscode:`).
  - В `src/extension/chatController.ts` (`case 'link.open'`) перехватываются строго валидные ссылки `^conversation:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$` (любые не-UUID суффиксы и попытки path traversal отклоняются) и открываются отдельной вкладкой чата через `openSession(uuid, 'antigravity')`.

### Диффы правок и ошибки инструментов
- Диффы приходят прямо в финальном `tool_call_update`: `content: [{ type: "diff", path: string, newText: string, oldText?: string }]` (для новых файлов `oldText` не задан). `structuredPatch` строится без обращения к `~/.gemini`.
- Ошибка вызова определяется условием `status === "failed" || rawOutput.exit_code !== 0` (так как ненулевой код возврата `run_command` приходит со `status: "completed"`).

## 5. Живые разрешения и интерактивные вопросы

### Живые разрешения (`session/request_permission`)
В режиме `default` операции родительской сессии, требующие подтверждения, вызывают серверный запрос `session/request_permission` со строковым `id` и параметрами `{ sessionId, toolCall, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] }`:
- `allow` → `{ outcome: { outcome: "selected", optionId: "allow" } }`;
- `deny` → `{ outcome: { outcome: "selected", optionId: "deny" } }` (инструмент завершается со `status: "failed"`, модель продолжает ход);
- `allow-edits` → переводит сессию в `accept-edits` через `session/set_mode` и одобряет текущий запрос.

### Интерактивные вопросы (`elicitation/create`)
При объявленном `clientCapabilities.elicitation.form` вызов `ask_question` присылает `elicitation/create` с JSON-схемой вопросов (`q1`, `q2`... и `_other`). Адаптер рисует карточку `question.request` и возвращает `{ action: "accept", content }` (либо `decline` / `cancel`) в рамках того же хода.

## 6. Реактивное пробуждение (`wakeup`) и граф субагентов

В `ANTIGRAVITY_FEATURES` (`src/agent/features.ts`) включены `subagents: true` и `agentTranscript: true`, при этом `agentStop: false` (протокол `agy acp` не предоставляет клиентского RPC для остановки отдельного дочернего `conversationId` — точечно остановить субагента может только сама модель через `manage_subagents(kill | kill_all)`, а кнопка Stop в UI отменяет ход родителя).

### Три сценария доставки реактивного пробуждения родителя (`wakeup`)
Когда фоновый субагент (`invoke_subagent`) или фоновая задача (`task-N` / `schedule`) завершает работу и будит родительскую сессию, `AgySession` покрывает все три варианта поведения сервера `agy acp`:
1. **Удержание открытого `session/prompt` (`HoldOwnedTurn`)**: при активном таймере/ожидании `schedule` сервер удерживает исходный запрос `session/prompt` открытым до выполнения реактивного шага родителя и присылает обновления штатным потоком активного `this.turn`.
2. **Внеходовой ACP-пуш (`wakeupTurn`)**: если исходный `session/prompt` уже закрылся с `end_turn`, а сервер позже присылает содержательные `session/update` (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`) при `!this.turn && !this.loading`, адаптер автоматически открывает синтетический ход пробуждения (`turn.start`), проводит чанки через `AgyAcpMapper` и закрывает ход `turn.result` по наступлении паузы тишины потока (`wakeupIdleMs`, с ожиданием открытых разрешений/вопросов).
3. **Тихий реактивный шаг в транскрипте (`AgyParentTranscriptTailer`)**: в `agy 1.5.7` hub-демон может дописать входящий `SYSTEM_MESSAGE` от субагента и ответный `PLANNER_RESPONSE` родителя напрямую в `brain/<sessionId>/.system_generated/logs/transcript.jsonl` после `end_turn`, не отправляя `session/update` в stdout `agy acp`. Пока есть активные субагенты или окно наблюдения после `agent.end` (`15 с`), `AgyParentTranscriptTailer` инкрементально читает новые строки родительского `transcript.jsonl` после синхронизированного курсора и воспроизводит `turn.start` → `thinking` / `tool.*` / `text.delta` → `context.usage` → `turn.result` в ленту чата.

### Устройство живого графа, истории и транскриптов (`src/agent/antigravity/subagents.ts`)
- **Связка идентификаторов с UI и извлечение ответов из родительского `transcript.jsonl`**:
  - Для инструментов категории `kind: "other"` (`invoke_subagent`, `manage_subagents`, `send_message`, `read_file`) сервер `agy acp` завершает `tool_call` / `tool_call_update` без `rawOutput` и `content` (как в живом `session/prompt`, так и при `session/load`). Если `parseCreatedSubagent` не находит `conversationId` прямо в ACP-ответе, `AgyParentToolOutputReader` (в живой сессии) и `readParentTranscriptSummary` (в `loadHistory`) спаривают вызовы `PLANNER_RESPONSE.tool_calls` со следующими за ними шагами `GENERIC` в компактном `brain/<sessionId>/.system_generated/logs/transcript.jsonl`.
  - В `transcript.jsonl` (`oneharness`) значения `tool_calls[i].args` записаны как JSON-литералы внутри строк (`"Path": "\"/abs/file.ts\""`, `"Model": "\"inherit\""`), а усечённые длинные строки обрываются на `\n<truncated N bytes>`: `normalizeTranscriptArgs` декодирует их перед передачей в `mapAgyTool`, а полный отчёт субагента родителю берётся из неусечённого входящего `<SYSTEM_MESSAGE>` (`sender=<childUuid>`) родительского транскрипта.
  - Наследование модели и усилия (`Model: "inherit"` или пусто) раскрывается через `resolveAgySubagentModelEffort` из активной модели/effort родителя (либо `<USER_SETTINGS_CHANGE>` в `USER_INPUT` для сессий из CLI), передавая `prompt`, `model` и `reasoningEffort` в `agent.start`, панель «агенты», `AgentsGraph` и заголовок Markdown-транскрипта.
  - Адаптер эмитит `agent.start` с **`agentId = toolCallId`** (так инлайн-группа `AgentGroup` связывает карточку `Agent` в ленте с узлом в `HudState.agents`), **`taskId = childUuid`** (передаётся в `adapter.agentTranscript`), `taskType: 'subagent'` и **`background: true`** (чтобы окончание родительского хода не гасило работающих в фоне субагентов).
- **Инкрементальный ридер `ByteLineTailer` / `AgySubagentReader`**:
  - Опрашивает компактный `brain/<childUuid>/.system_generated/logs/transcript.jsonl` раз в `400 мс` только пока есть активные субагенты; читает исключительно дописанные байты с последнего `byteOffset` (неполная строка без `\n` буферизуется до следующего тика) и полностью очищается на `dispose()`.
  - Шаги `PLANNER_RESPONSE` (`status: "DONE"`) дают сегменты `thinking.start`/`thinking.stop`, вызовы `tool.start` (через `mapAgyTool(..., mcpServers)`), счётчик вызовов и токены шага → `agent.progress`.
  - Шаги `GENERIC` закрывают вызовы событиями `tool.result` (ошибка фиксируется при `status !== "DONE"`, непустом `error` или `Command exited with code N` с `N !== 0`).
  - **Вложенность и фоновые задачи**: фоновые команды субагента (`Tool is running as a background task with task id: <uuid>/task-N`) порождают дочерние узлы `taskType: 'local_bash'` с `parentAgentId` (закрываются при входящем `SYSTEM_MESSAGE` от задачи или `manage_task(kill)`), а вложенные `invoke_subagent` рекурсивно наблюдаются с `parentAgentId` до глубины `2`.
  - **Детектор `waiting_for_input`**: если открытый вызов в `PLANNER_RESPONSE` не получает парного `GENERIC` дольше `2500 мс` (например, субагент упёрся в подтверждение `run_command` в режиме `default`) либо родитель вызвал `manage_subagents(list)` со статусом `waiting_for_input`, узел переходит в `status: 'waiting_for_input'` с описанием блокирующей операции.
  - **Завершение, `send_message` и `kill`**: финальный `PLANNER_RESPONSE` без `tool_calls` эмитит `agent.end` (`status: 'completed'`, `summary` из текста отчёта `send_message` родителю или финального ответа). При повторном обращении родителя через `send_message(Recipient: childUuid)` узел переоткрывается повторным `agent.start` (в `hudState.ts` сбрасывается `status: 'running'` и очищается `endedAt` с сохранением накопленного таймлайна), а при `manage_subagents(kill | kill_all)` переводится в `status: 'stopped'`.
- **Реконструкция истории и Markdown-транскрипт**:
  - В `loadHistory` функция `withAgySubagentTimelines` вшивает в историю сессии события субагентов (до `MAX_SUBAGENT_TIMELINES = 30` последних запусков и до `MAX_SUBAGENT_EVENTS = 400` событий на каждого, с учётом `send_message` и `manage_subagents`).
  - Клик по кнопке «транскрипт» вызывает `AntigravityAdapter.agentTranscript` → `agySubagentMarkdown(childUuid, dataDir, meta)`, формирующий read-only Markdown с заголовком роли/типа, кликабельной ссылкой `[Открыть сессию](conversation://<childUuid>)`, распакованным промптом из `<SYSTEM_MESSAGE>`, мыслями, вызовами инструментов и подрезанными результатами.

## 7. История сессий и управление беседами

- **Список сессий (`session/list`)**: возвращает сессии всех проектов аккаунта `{ sessions: [{ sessionId, cwd, title, updatedAt }] }`; адаптер фильтрует их по `realpathSync(cwd)` и накладывает пользовательские переименования из `globalState` (`agentura.antigravity.names`) через `AgySessionIndex`.
- **Загрузка истории (`session/load`)**: краткоживущий `agy acp` реплеит кадры `user_message_chunk`, `tool_call` (сразу в финальном статусе с диффами) и `agent_message_chunk`, после чего `withAgySubagentTimelines` и `readLastTranscriptUsage` достраивают граф субагентов и шкалу контекста.
- **Возобновление (`session/resume`)**: подхватывает контекст на сервере без повторной передачи истории ходов и восстанавливает сохранённые `model`, `effort` и явно выбранный режим (не перетирая серверный `'auto'`).

## 8. Устранённые устаревшие механизмы

С переходом на `agy acp` (`>= 1.5.0`, эталон `1.5.6+`):
- Полностью исключены `node:sqlite`, SQLite-база `conversation_summaries.db` и тяжёлые `transcript_full.jsonl`; в `~/.gemini` ничего не пишется. Единственные read-only обращения к `<dataDir>` (`~/.gemini/antigravity-cli`) — компактные `brain/<uuid>/.system_generated/logs/transcript.jsonl` (для `usedTokens`, тихого wakeup родителя и графа/транскриптов субагентов) и список имён папок `<dataDir>/mcp`.
- Удалены механизм `stream-json` (`agy -p= --input-format stream-json --output-format stream-json`), карточки отказа `refusal` и сообщения протокола `agy.retry` / `agy.retryRejected`.
- Разрешения и вопросы стали интерактивными в реальном времени, без перезапуска CLI-процесса (кроме прозрачной ротации через `session/resume` при включении/выключении серверного флага `--dangerously-skip-permissions`).
