# Antigravity (`agy acp`): протокол взаимодействия

Снято с `agy` 1.5.3 (сырые логи и спайк контракта — `docs/spikes/antigravity-acp/report.md`, эталонные кадры — `test/fixtures/antigravity/acp-pong.ndjson`).
Минимальная поддерживаемая версия CLI — `agy >= 1.5.0` (проверяется в `src/agent/antigravity/executable.ts`).
Взаимодействие строится через официальный протокол ACP (`agy acp`) по JSON-RPC 2.0 поверх stdio (один JSON на строку). Прямой доступ к диску `~/.gemini` (`node:sqlite`, `conversation_summaries.db`, `transcript_full.jsonl`) и устаревший режим `stream-json` полностью исключены.

## 1. Запуск и жизненный цикл процесса

| Что | Команда | Где в коде |
| --- | --- | --- |
| Сессия ACP | Долгоживущий процесс на открытую вкладку: `agy acp` (JSON-RPC 2.0 по stdio) | `src/agent/antigravity/adapter.ts`, `src/agent/acp/client.ts` |
| Версия | `agy --version` (или `agentInfo.version` из `initialize`) | `src/agent/antigravity/executable.ts` |
| Каталог моделей | `agy models` (или `configOptions` / `models` из `session/new`) | `src/agent/antigravity/models.ts` |
| Квота аккаунта | `agy -p "/usage"` (5-оконный TSV, кэш 10 мин, таймаут 30 с + сторож 35 с) | `src/agent/antigravity/quota.ts`, `src/extension/agyQuota.ts` |
| Авторизация | `agy acp --login` (интерактивный вход в терминале VS Code) | `src/extension/sidebarView.ts` |

### Жизненный цикл сессии
- **Открытие вкладки (`createSession` / `resumeSession`)**: порождает отдельный процесс `agy acp` с рабочей директорией `cwd`.
- **Инициализация**:
  - Клиент отправляет `initialize`:
    `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } }`.
  - Сервер отвечает `agentInfo` (`version: "1.5.3"`), `agentCapabilities` (`loadSession: true`, `promptCapabilities: { image: true, embeddedContext: true }`, `sessionCapabilities: { resume, close, load, list, additionalDirectories }`, `_meta.antigravity: { tier: true }`).
  - `AccountInfo.plan` считывается из `_meta.antigravity.tier.name` (например, `"Google AI Pro"`).
- **Создание или возобновление**:
  - Новая сессия: `session/new` `{ cwd, mcpServers: [] }` возвращает `sessionId`, `models`, `modes`, `configOptions`.
  - Возобновление сессии: `session/resume` `{ sessionId, cwd, mcpServers: [] }` восстанавливает контекст беседы на стороне сервера без реплея истории.
- **Очередь сообщений**: отправка промптов выполняется через `session/prompt` последовательно; повторные запросы выстраиваются в очередь.
- **Прерывание (Stop)**: отправляет уведомление `session/cancel` `{ sessionId }`. Сервер сам мгновенно завершает активный шаг модели или прерывает выполняющуюся команду/разрешение, возвращая `stopReason: "cancelled"`. Процесс `agy acp` остаётся живым и готовым к следующим сообщениям.
- **Закрытие (`dispose`)**:
  - `stdin.end()` → grace-ожидание завершения (позволяет `agy 1.5.3` штатно сохранить состояние беседы) → `SIGTERM` при превышении таймаута → `SIGKILL`.
- **Вспомогательные операции вне вкладок** (`listSessions`, `loadHistory`, холодный `accountInfo`): поднимают кратковременный процесс `agy acp`, выполняют RPC и штатно закрывают процесс.

## 2. Модели, рассуждения и режимы

Настройки подтверждённой сессии (`model`, `effort`, режим) Agentura сохраняет в `globalState`
(`agentura.antigravity.sessionSettings`) и применяет при resume. Ответ `session/load` содержит дефолты
нового процесса, поэтому его настройки не используются как история. Для старых или внешних сессий,
настройки которых Agentura не сохраняла, прежнюю модель/effort/режим восстановить нельзя.

### Управление моделью и уровнем рассуждений (`thought_level`)
В ACP `configOptions` отдаёт независимые селекты:
- `model`: 5 базовых моделей (`gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`).
- `thought_level`: уровни рассуждений (`low`, `medium`, `high`).
- `models.availableModels`: 13 комбинированных ID (`gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`).

**Поведение `gpt-oss-120b-medium`**:
- При переключении на `gpt-oss-120b-medium` селект `thought_level` **исчезает** из `configOptions`.
- Вызов `session/set_config_option` с `configId: "thought_level"` возвращает ошибку JSON-RPC `-32602` (`"Thinking level ... is not offered for model ..."`).
- Адаптер сохраняет желаемый уровень `effort` локально и отправляет `thought_level` только когда селект присутствует в актуальных `configOptions`. При возврате на модель с поддержкой уровней (Gemini / Claude) адаптер повторно применяет сохранённый `effort`.
- Переключение модели выполняется через `session/set_config_option` (`configId: "model"`), режим проверяет доступные опции.

### Режимы (`mode`)
Переключение выполняется методом `session/set_mode` `{ sessionId, modeId }`:
- `default`: запрос подтверждения для правок и команд через живые разрешения.
- `accept-edits`: автоматическое одобрение правок файлов в воркспейсе без запроса прав.
- `plan`: планирование задачи (ответ выводится обычным текстом, серверных карточек утверждения плана нет).

Маппинг режимов Agentura:
- `default` → `default`
- `acceptEdits` → `accept-edits`
- `plan` → `plan`
- `bypassPermissions` при `agentura.allowBypassPermissions: true` переводит сервер в `accept-edits` и автоматически отвечает одобрением (`allow`) на запросы разрешений. Без флага режим понижается до `default`.

## 3. Ход, текст, картинки и токены

### Формат стриминга
- Входящий промпт: `session/prompt` `{ sessionId, prompt: [ ...PromptBlock ] }`.
- Поддержка картинок: `PromptBlock` вида `{ type: "image", data: "<base64>", mimeType }` отправляется перед текстовым блоком `{ type: "text", text }`.
- На старте хода сервер присылает эхо промпта `user_message_chunk` (игнорируется адаптером).
- Текст ответа: стримится кадрами `session/update` с `sessionUpdate: "agent_message_chunk"`, `{ content: { type: "text", text } }` → транслируется в `text.delta`.
- Рассуждения: `sessionUpdate: "agent_thought_chunk"` транслируется в `thinking.start` / `thinking.delta` / `thinking.stop` (закрывается перед текстом или инструментами).
- Название сессии: `sessionUpdate: "session_info_update"` `{ title }` обновляет `session.title`.

### Токены и квота
- Ответ `session/prompt` возвращает объект `usage`:
  `{ inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens }`.
  - `inputTokens` в ACP уже очищен от кэша: `totalTokens = inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens`.
  - `thoughtTokens` включён в `outputTokens`.
  - Маппится в `turn.result.usage` с `usageKnown: true`. Стоимость (`costUsd`) и размер окна контекста сервером не отдаются (`context: false`, `cost: false`).
- Квота аккаунта (`agy -p "/usage"`):
  - В `1.5.3` вывод состоит из 5 TSV-строк:
    1. `Gemini Models` — Five Hour Limit Remaining
    2. `Gemini Models` — Weekly Limit Remaining
    3. `Claude and GPT models` — Five Hour Limit Remaining
    4. `Claude and GPT models` — Weekly Limit Remaining
    5. `Gemini 4 Argon` — Weekly Limit Remaining
  - Парсер выделяет семейство (`Gemini`, `Claude/GPT`, `Gemini 4 Argon`) и тип окна (`fiveHour` — `5ч`, `weekly` — `7д`).
  - Данные кэшируются (опрос не чаще раза в 10 минут) и отображаются у поля ввода чата и в панели лимитов (`EngineLimits`).

## 4. Инструменты и диффы правок

Сервер присылает `sessionUpdate: "tool_call"` и `"tool_call_update"`.

### Инструменты (`oneharness` и `cortex`)
Поддерживаются современные имена `oneharness` (`agy 1.5.3`) и старые `cortex`:
- `run_command` → карточка `Bash` (вход: `command`, `description`, `cwd`).
- `read_file` / `view_file` → карточка `Read` (вход: `file_path`).
- `write_file` / `write_to_file` → карточка `Write` (вход: `file_path`, `content`).
- `edit_file` / `replace_file_content` / `multi_replace_file_content` → карточки `Edit` / `MultiEdit` (вход: `file_path`, `old_string`, `new_string`).
- `search_web` → карточка `WebSearch` (вход: `query`, `domain`).
- `ask_question` → интерактивные вопросы агента (`AskUserQuestion`).
- Вспомогательные: `grep_search` (`Grep`), `find_by_name` (`Glob`), `read_url_content` (`WebFetch`).

### Диффы правок без чтения диска
Диффы файлов приходят непосредственно в финальном `tool_call_update`:
`content: [{ type: "diff", path: string, newText: string, oldText?: string }]`.
- Для новых файлов `oldText` отсутствует.
- Адаптер строит `structuredPatch` напрямую из `content[type="diff"]`, передавая результат во вкладку изменений (`changes`) без обращения к файловой системе `~/.gemini` или парсинга транскриптов.

### Обработка ошибок инструментов
- `status: "failed"` указывает на ошибку вызова.
- При вызове `run_command` ошибка выполнения (ненулевой код возврата) приходит со `status: "completed"`, но содержит поле `rawOutput.exit_code`. Ошибка распознаётся по условию: `status === "failed" || rawOutput.exit_code !== 0`.

## 5. Живые разрешения и интерактивные вопросы

### Живые разрешения (`session/request_permission`)
В режиме `default` операции, требующие подтверждения пользователя, инициируют серверный запрос:
- Метод: `session/request_permission` со строковым `id` (`"1"`, `"2"`...).
- Параметры: `{ sessionId, toolCall, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }`.
- Отображение в UI: всплывает карточка разрешения с предпросмотром команды или диффа правки.
- Варианты ответа:
  - `allow`: `{ outcome: { outcome: "selected", optionId: "allow" } }`.
  - `deny`: `{ outcome: { outcome: "selected", optionId: "deny" } }`. Инструмент переходит в `status: "failed"`, модель корректно продолжает ход.
  - `allow-edits`: переводит сессию в режим `accept-edits` через `session/set_mode` и одобряет текущую операцию (`optionId: "allow"`).

### Интерактивные вопросы (`elicitation/create`)
- При инициализации клиент заявляет `clientCapabilities: { elicitation: { form: {} } }`.
- При вызове `ask_question` сервер шлёт запрос `elicitation/create` с формой выбора (`requestedSchema` содержит поля вопросов `q1`, `q2`... и `_other` для произвольного ответа).
- Адаптер отображает форму вопросов `question.request` (одиночный или множественный выбор).
- Ответ `{ action: "accept", content: { q1: "2", ... } }` возвращает выбранные варианты модели в рамках того же хода. Отказ или отмена возвращает `{ action: "decline" }` или `{ action: "cancel" }`.

## 6. История сессий и управление беседами

### Список сессий (`session/list`)
- Серверный вызов `session/list` `{ cwd }` возвращает сессии всех проектов аккаунта:
  `{ sessions: [{ sessionId, cwd, title, updatedAt }] }`.
- Фильтрация по рабочей директории выполняется адаптером через `realpathSync(cwd)`.
- Пользовательские переименования сохраняются в `globalState` расширения (`agentura.antigravity.names`) и накладываются поверх серверного `title` через `AgySessionIndex`.

### Загрузка истории (`session/load`)
- При клике на сохранённую беседу открывается краткоживущий `agy acp`, вызывающий `session/load` `{ sessionId, cwd }`.
- Сервер реплеит историю ходов кадрами `user_message_chunk`, `tool_call` (сразу в финальном статусе `completed`/`failed` с диффами) и `agent_message_chunk`.
- Адаптер восстанавливает полную ленту событий `AgentEvent[]` и закрывает временный процесс.

### Возобновление (`session/resume`)
- Открытие интерактивной вкладки с существующей беседой использует `session/resume` `{ sessionId, cwd }`.
- Контекст подхватывается на сервере без повторной передачи истории ходов.
- Адаптер повторно выставляет сохранённые параметры модели, effort и режима.

## 7. Устранённые устаревшие механизмы

С переходом на `agy acp` (`>= 1.5.0`):
- Полностью удалены прямое чтение `~/.gemini/antigravity-cli`, `node:sqlite`, парсинг SQLite-базы `conversation_summaries.db` и JSONL-файлов `transcript_full.jsonl`.
- Удалены механизм `stream-json` (`agy -p= --input-format stream-json --output-format stream-json`), карточки отказа `refusal` и сообщения протокола `agy.retry` / `agy.retryRejected`.
- Разрешения и вопросы стали интерактивными в реальном времени, без перезапуска CLI-процесса.
