# Agentura: реализация расширения до версии 0.1

> Статус: в работе · 2026-09-30 · этап 0 закрыт (`docs/spikes/sdk-probe.md`) · следующий — этап 1 (каркас) · продолжение `01-features-prototype.md` (прототип утверждён, тег `prototype-v1`)
> Исполнитель отмечает чекбоксы по ходу работы — по факту проверки, не «вроде сделал».

## Цель

Установленное из `.vsix` расширение VS Code, в котором можно провести рабочий день с Claude
по принципу MVP из `docs/features.md`: чат во вкладке редактора с приборами (контекст,
стоимость, кэш, лимиты, таймлайн, агенты), разрешения и план, диффы, сессии в боковой
панели. Интерфейс — как в `prototype/` (направление HUD), тег `v0.1.0`.

## Контекст и ограничения

- **Что есть.** `docs/features.md` — состав MVP (61 строка + A14/A15). `prototype/` — эталон
  вёрстки: `shared/tokens.css`, `shared/hud.css` переносятся в webview как есть, экраны
  `screens/*.html` — эталон разметки и текстов. Таблица «фича → экран» в `prototype/README.md`.
- **Движок.** Claude Agent SDK для TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.285
  (CLI `claude` 2.1.285 установлен в `~/.local/share/claude/versions/`). Разведка доки
  30.09.2026 — выжимка `docs/spikes/sdk-doc-review.md`, снимки страниц `docs/spikes/sdk-docs-2026-09-30/`
  (факты по доке, не по живому прогону):
  - `interrupt()`, `setPermissionMode()`, `setModel()`, `applyFlagSettings()` работают только
    в streaming input mode — prompt как `AsyncIterable<SDKUserMessage>`. Значит, одна живая
    `query()` на сессию с очередью входящих сообщений.
  - Контекст: `query.getContextUsage()` → `totalTokens`, `maxTokens`, `percentage`,
    `autoCompactThreshold`, категории; в `assistant`-сообщениях есть `context_usage?`.
    Окно и стоимость: `result.modelUsage[model].contextWindow / costUSD`, `result.total_cost_usd`
    (оценка), `duration_ms`, `num_turns`. Одно API-сообщение приходит несколькими `assistant`
    с одним `message.id` — usage дедуплицировать по `message.id`, `output_tokens` там плейсхолдер,
    реальный — в `message_delta` stream_event и в `result`.
  - Лимиты подписки: в SDK только `rate_limit_event {status, resetsAt?, utilization?}` без типа окна.
    Проценты 5-часового и недельного окна доступны через `GET https://api.anthropic.com/api/oauth/usage`
    с токеном Claude Code (`~/.claude/.credentials.json` / Keychain) — реализовано в Agentmeter
    (`packages/core/src/limits/oauth.ts`, `apps/desktop/src/main/oauth.ts`, опрос не чаще раза в 15 мин).
    Там же `subscriptionType`, `rateLimitTier` для секции «Аккаунт».
  - Кэш: события об истечении нет. Таймер считаем сами: время последнего API-ответа + TTL
    (1 ч для подписки в главном разговоре, 5 мин для API-ключа и субагентов; `usage.cache_creation.ephemeral_5m/1h_input_tokens`
    подсказывает фактический TTL). Доля попаданий — `cache_read / (input + cache_read + cache_creation)`.
  - Компакция: `system/status {status:"compacting"}` и `system/compact_boundary {trigger, pre_tokens}`;
    вручную — отправить `/compact` промптом.
  - Разрешения: один `canUseTool(toolName, input, {suggestions, toolUseID, agentID})`; «всегда» =
    `updatedPermissions` из `suggestions` с `destination: "localSettings"`. `AskUserQuestion` приходит
    туда же (ответ через `updatedInput.answers`). План — инструмент `ExitPlanMode` (текст плана в
    output; приходит ли в `canUseTool` — проверить в этапе 0). Режимы: `default | acceptEdits | plan |
    bypassPermissions` (последний требует `allowDangerouslySkipPermissions`), есть ещё `dontAsk`, `auto` — не используем.
  - Субагенты: `parent_tool_use_id` на сообщениях, события `task_started / task_progress / task_updated /
    task_notification / background_tasks_changed`, остановка фоновой — `query.stopTask(taskId)`;
    текст субагента только при `forwardSubagentText: true`.
  - Сессии: `listSessions({dir})` (без токенов и стоимости), `getSessionMessages(id)`, `resume`,
    `renameSession`. Транскрипты `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, формат
    «внутренний, меняется между версиями» — парсер Agentmeter (`packages/core/src/sources/claude/parse.ts`,
    fixtures с эталонами) считает токены по сессии с дедупом по `requestId`.
  - Авторизация: не задавать `ANTHROPIC_API_KEY` в `env` → SDK берёт вход CLI (OAuth подписки);
    `query.accountInfo()` → `email, subscriptionType, tokenSource`. `Options.env` в TS **заменяет**
    окружение процесса — передавать `{...process.env, ...}`.
  - Thinking: `thinking: {type:'adaptive', display:'summarized'}` (иначе текст пустой), `effort` в
    Options и `applyFlagSettings({effortLevel})` на лету; прогресс — `system/thinking_tokens`.
  - Диффы: до применения — `input.old_string/new_string` (Edit) или `content` против файла (Write)
    в `canUseTool`; после — `tool_use_result.structuredPatch` и `gitDiff`.
- **Окружение.** VS Code 1.138 (extension host Node 24.18, `node:sqlite` доступен), Node 22.23 в
  терминале. Agentmeter (`/Users/fost/Projects/Agentmeter`, MIT, автор тот же) — ядро
  `@agentmeter/core` без UI: парсер транскриптов, лимиты, OAuth-usage, live-сессии; денег в нём
  нет, только токены — таблицу цен пишем сами.
- **Решено.** TypeScript strict, esbuild (две сборки: extension CJS для Node, webview ESM для
  браузера), Preact + `@preact/signals` в webview, vitest для юнитов, `@vscode/test-electron`
  для одного интеграционного теста, `@vscode/vsce` для упаковки. Один пакет в корне репозитория,
  без монорепо. Язык интерфейса — русский (как прототип), строки в одном модуле для будущей локализации.
- **Не в этом плане.** Публикация в Marketplace, другие агенты (A13), фичи «Потом» и «Нет».
- **Юридическое (риск).** Дока SDK: «Anthropic does not allow third party developers to offer
  claude.ai login … for their products» без одобрения. Для личного использования расширение
  работает через вход CLI; перед публичной раздачей — решение владельца (см. «Риски»).

## Этапы

### 0. Разведка SDK на живом движке

Одна `query()` против этого репозитория превращает «не подтверждено» в факты до того, как
архитектура на них опёрлась. Скрипт-проба пишет все сообщения SDK в jsonl — эти логи потом
станут фикстурами для тестов адаптера.

- [x] `spikes/sdk-probe/` — Node ESM скрипт на `@anthropic-ai/claude-agent-sdk`, streaming input mode, все сообщения в `spikes/sdk-probe/logs/*.jsonl`
- [x] Проверено: `interrupt()`, `setPermissionMode()`, `setModel()`, `applyFlagSettings({effortLevel})` в streaming input mode
- [x] Записаны формы `system/init`, `accountInfo()`, `apiKeySource` при входе CLI без `ANTHROPIC_API_KEY`
- [x] Записаны формы `getContextUsage()`, `assistant.context_usage`, `result.modelUsage` (есть ли `contextWindow`, `costUSD`) на Opus 5.5 и Sonnet 5.5
- [x] Проверен дедуп usage по `message.id` и что `output_tokens` в `assistant` — плейсхолдер
- [x] Записана форма `rate_limit_event` (единицы `resetsAt`, `utilization`); опрошен `GET /api/oauth/usage` кодом из Agentmeter — записан ответ (окна, проценты, сброс)
- [x] Проверено `canUseTool` для Bash и Edit: `suggestions`, запись «всегда» в `.claude/settings.local.json` через `updatedPermissions`
- [x] Проверен круг `AskUserQuestion` через `canUseTool` (вопрос → `updatedInput.answers`)
- [x] Проверен plan mode: приходит ли `ExitPlanMode` в `canUseTool`, где текст плана, как выйти в `acceptEdits` и как «доработать» (deny с сообщением)
- [x] Проверены субагенты: промпт с `Agent`-инструментом, события `task_*`, `parent_tool_use_id`, `forwardSubagentText`, `stopTask()` для фоновой задачи
- [x] Проверена компакция: `/compact` промптом → `status:"compacting"`, `compact_boundary.pre_tokens`
- [x] Проверен thinking: `display:'summarized'` даёт текст; какие stream_event приходят (`thinking_delta`?); `thinking_tokens`
- [x] Проверены `listSessions()`, `getSessionMessages()` (есть ли `message.usage`), `resume` (накопительные `total_cost_usd`)
- [x] Проверен `tool_use_result` для Edit и Write (`structuredPatch`, `originalFile`)
- [x] Записан `docs/spikes/sdk-probe.md`: таблица «вопрос → ответ → поле → лог», раздел «что остаётся допущением»
- [x] В `docs/features.md` колонка «Источник данных» A1–A6, A10 переписана по фактам; в `prototype/README.md` закрыт открытый пункт про окно контекста

**Итог (30.09):** `docs/spikes/sdk-probe.md`. Против раздела «Контекст» выше: окно 1M, а не 200k;
оба окна лимитов есть в `rate_limit_event.unifiedWindows`; `assistant.context_usage` не приходит;
`ExitPlanMode` приходит в `canUseTool`, план — в `input.plan`; субагент без `run_in_background` стартует
фоновым; `fetch` из Node к `/api/oauth/usage` отвечает 200. Не подтверждено живьём: эффект
`applyFlagSettings({effortLevel})`, `stopTask` для субагента переднего плана, автокомпакция — в таблице допущений.

**Готово, когда:** `node spikes/sdk-probe/run.mjs` отрабатывает без ошибок, в `docs/spikes/sdk-probe.md` на каждый из 14 вопросов есть ответ со ссылкой на строку лога; нет строки «не проверено» без причины.

**Сессия:** opus или fable, effort high; последовательно, первая. Промт 0.

### 1. Каркас расширения и прототип внутри webview

Сборка, манифест, две webview-поверхности и перенос стилей прототипа. Проверка, что токены
`--vscode-*` дают в реальных темах то, что показывал прототип.

- [ ] `package.json` расширения: `engines.vscode ^1.138`, `main`, `contributes`: viewContainer `agentura` в activity bar с webview view `agentura.sidebar`; команды `agentura.open`, `agentura.newSession`, `agentura.openLast`, `agentura.resumeSession`, `agentura.showLogs`; хоткеи для open/newSession; настройки `agentura.contextThresholds` ([120000,150000]), `agentura.allowBypassPermissions` (false), `agentura.defaultModel`, `agentura.claudeExecutable` (пусто = бандленный), `agentura.usagePollMinutes` (15)
- [ ] `esbuild.mjs`: сборка `src/extension/**` → `dist/extension.js` (cjs, platform node, external vscode) и `src/webview/**` → `dist/webview/{chat,sidebar}.js` (esm, browser), режим watch; `npm run build`, `npm run watch`, `npm run check` (tsc + eslint + vitest)
- [ ] `media/tokens.css`, `media/hud.css` скопированы из `prototype/shared/` без правок; `prototype/shared/preview.*` не переносится
- [ ] Webview-панель чата (`WebviewPanel`, `retainContextWhenHidden`, CSP с nonce, `localResourceRoots`), Preact-приложение рендерит экран `prototype/screens/chat.html` из статических данных (та же разметка и классы)
- [ ] Webview view боковой панели рендерит `prototype/screens/sessions.html` (левая часть) из статических данных
- [ ] `src/protocol.ts`: типы сообщений extension ↔ webview (`ToWebview`, `FromWebview`) с заглушками под события этапа 2; `postMessage` обёртки с типами
- [ ] Output channel «Agentura» и логгер с уровнями (B20)
- [ ] `vitest` с одним тестом на протокол; `eslint` + `prettier` конфиги
- [ ] Обе темы проверены на глаз владельцем: F5 → вкладка и боковая панель совпадают с прототипом

**Готово, когда:** `npm run check` зелёный; F5 открывает Extension Development Host, команда «Agentura: открыть чат» показывает статический экран чата, значок в activity bar — боковую панель; в Dark Modern и Light Modern нет непрокрашенных мест.

**Сессия:** sonnet, effort medium; после этапа 0 (зависит от списка событий). Промт 1.

### 2. Адаптер агента и слой данных

Граница по форме ACP: интерфейс адаптера и модель событий, не зависящие от Claude; реализация
на Agent SDK; данные для приборов и списка сессий из Agentmeter. Здесь много суждения по
живому поведению SDK — сильная модель.

- [ ] `src/agent/types.ts`: `AgentAdapter` (`createSession`, `resumeSession`, `listSessions`, `accountInfo`) и `AgentSession` (`send`, `events`, `respondPermission`, `answerQuestion`, `decidePlan`, `setMode`, `setModel`, `setEffort`, `interrupt`, `compact`, `stopTask`, `dispose`)
- [ ] `AgentEvent` union: `session.init`, `turn.start`, `text.delta`, `thinking.start/delta/stop`, `tool.start/progress/result`, `permission.request`, `question.request`, `plan.request`, `usage.message`, `context.usage`, `turn.result`, `compaction.start/end`, `agent.start/progress/end`, `limit.update`, `mode.changed`, `error`
- [ ] `src/agent/claude/adapter.ts`: streaming input через асинхронную очередь, `env: {...process.env}` без `ANTHROPIC_API_KEY`, `cwd` = папка воркспейса, `includePartialMessages`, `thinking: {type:'adaptive', display:'summarized'}`, `settingSources` все три, `forwardSubagentText: true`
- [ ] Маппинг SDK → события по логам этапа 0: дедуп usage по `message.id`, `parent_tool_use_id` → `agentId`, `task_*` → `agent.*`, `compact_boundary` → `compaction.end`
- [ ] `canUseTool` → промисы по `toolUseID`: ветки `AskUserQuestion`, `ExitPlanMode`, Edit/Write (превью диффа в событии), остальные; ответы `respondPermission/answerQuestion/decidePlan` резолвят промис
- [ ] `src/data/agentmeter/` — vendored части `@agentmeter/core`: `sources/claude/parse.ts`, `sources/types.ts`, `sources/jsonl.ts`, `limits/oauth.ts`, `limits/windows.ts`, `format/tokens.ts` + файл `ORIGIN.md` (коммит-источник, MIT)
- [ ] `src/data/pricing.ts`: таблица $/MTok по моделям (ввод, вывод, чтение кэша, запись кэша 5m/1h) с датой; `cost(usage, model)`; для живых ходов приоритет у `modelUsage.costUSD`
- [ ] `src/data/limits.ts`: опрос `/api/oauth/usage` (токен из `.credentials.json`/Keychain, троттлинг по настройке) → `LimitWindow[]`; fallback — `rate_limit_event`
- [ ] `src/data/sessions.ts`: `listSessions()` SDK + итоги по транскрипту парсером Agentmeter (ходы, токены, стоимость по `pricing`), статус живых сессий по собственному реестру запущенных
- [ ] Тесты vitest: маппинг адаптера на фикстурах из `spikes/sdk-probe/logs/` (ожидаемая последовательность событий), `pricing`, парсер на фикстурах Agentmeter (`fixtures/claude`)

**Готово, когда:** `npm test` зелёный; `node scripts/adapter-smoke.mjs "скажи привет"` печатает последовательность событий с `turn.result` (стоимость, токены, окно) на живом движке; `canUseTool` для `Bash` доходит до события `permission.request` и резолвится ответом.

**Сессия:** opus или fable, effort high; после этапа 1. Промт 2.

### 3. Чат

Лента, стриминг, инструменты, поле ввода — по экранам `chat`, `input`, `empty`.

- [ ] Стор webview на сигналах: сессия, ходы, строки ленты, текущее состояние (`idle | working | waiting | error | limited`)
- [ ] Лента: строки `u` (пользователь), `think` (сворачивание, таймер), `e` (инструмент: op, что, результат, время, `diff`-ссылка у Edit/Write), `txt` (markdown через `marked` + `DOMPurify`, блоки кода с копированием), `sum` (итог хода из `turn.result`), `sys` (A15), `live` со `stop`
- [ ] Автопрокрутка с «прилипанием» к низу; остановка хода кнопкой и `Esc` → `interrupt()`
- [ ] Поле ввода: contenteditable plaintext, Enter / Shift+Enter, история ↑↓ (в пустом поле), вставка текста
- [ ] Меню «/»: команды из `init.slash_commands` и скиллы из `init.skills`, плюс собственные `/clear`, `/compact`, `/status`, `/plan`; фильтр по набранному
- [ ] Меню «@»: `workspace.findFiles` с фильтром по `.gitignore`/`files.exclude`, вставка токена, передача путей в промпт
- [ ] Кнопка «+»: файл или папка, выключатели автоконтекста
- [ ] Автоконтекст: открытый файл и выделение из активного редактора, чипы с крестиком, игнорируемые файлы не попадают (B3)
- [ ] Переключатели внизу: режим (`setMode`), модель (`supportedModels()`), effort, thinking — как на экране `input`
- [ ] Заголовок: агент (Claude; Codex, Gemini «скоро»), проект, название сессии (`summary`/`customTitle`), `sessions`, `new`
- [ ] Пустое состояние (экран `empty`): подсказки, недавние сессии
- [ ] Индикатор состояния во вкладке: заголовок панели с маркером состояния (● работа, ? ждёт, ! ошибка) — B1
- [ ] Строки локализации в `src/webview/strings.ts`

**Готово, когда:** в этом репозитории задача «найди, где считается число фич в README, и поправь опечатку» проходит целиком: стриминг виден, строки инструментов корректны, остановка работает, итог хода совпадает с `result` в логе; вёрстка не расходится с `prototype/screens/chat.html` (владелец сравнивает глазами).

**Сессия:** sonnet, effort medium; после этапа 2. Промт 3.

### 4. Приборы

Шапка HUD, панели «ход» и «агенты», системные строки — по экранам `chat`, `limit`.

- [ ] Контекст: число и 20 блоков по `maxTokens/20`, пороги из настройки, цвета `ok/warn/hot/full`, «сжать» → `/compact`; обновление после каждого `turn.result` и `context.usage`
- [ ] Кэш: таймер до истечения (последний API-ответ + TTL по `tokenSource` и `cache_creation.ephemeral_*`), доля попаданий за сессию
- [ ] Лимиты: 5 ч и неделя из `src/data/limits.ts`, проценты и время сброса; красный на 100 %
- [ ] Итог хода под ответом: ввод, вывод, кэш ↓↑, стоимость, длительность
- [ ] Панель «ход»: полоса хода по времени (think / read / edit / run / text) и строки с секундой от начала; предыдущий ход ниже
- [ ] Панель «агенты»: дерево основной → субагенты → фоновые задачи, статус, токены, кнопка ■ → `stopTask`; итог за сессию (стоимость, ходы, время, кэш-попадания)
- [ ] Узкая вкладка: панели как вкладки `чат | ход | агенты` с бейджами; широкая — панель справа (`hud.js` прототипа как эталон поведения)
- [ ] Системные строки: компакция (`pre_tokens → totalTokens`), смена режима, ход не начат
- [ ] Юнит-тесты: цвет по порогам, таймер кэша, агрегация итогов сессии

**Готово, когда:** после хода число контекста совпадает с `/context` в CLI для той же сессии (±1 %), стоимость — с `result.total_cost_usd`, лимиты — с `/usage` в CLI; `npm test` зелёный.

**Сессия:** sonnet, effort medium; после этапа 3. Промт 4.

### 5. Разрешения, вопросы, план, дифф

Карточки `.ask` и переключение режимов — экраны `permission`, `diff`, `plan`. Здесь
нативный дифф через виртуальные документы и семантика решений по плану — суждение неизбежно.

- [ ] Карточка разрешения на команду: «Разрешить» (Enter), «Всегда для …» (из `suggestions`, пишет в `.claude/settings.local.json`), «Отклонить» (Esc, deny с сообщением); подпись о месте записи
- [ ] Карточка вопроса агента: варианты 1–4, multiSelect, свободный ответ через поле ввода; после ответа — системная строка «выбран вариант N»
- [ ] Карточка правки: файл, `+N −M`, превью ханка (дифф `old_string`/`new_string` или `content` против файла), «открыть дифф» — `vscode.diff` над `TextDocumentContentProvider` (`agentura-diff:`), «Принять правку», «Принимать правки до конца сессии» (`setMode('acceptEdits')`), «Отклонить»
- [ ] После применения: ссылка `diff` в строке инструмента открывает дифф из `structuredPatch`/`originalFile`
- [ ] Карточка плана: заголовок, шаги, файлы; «Выполнять» (default), «Выполнять, принимая правки» (acceptEdits), «Доработать план» (deny с текстом из поля), «Отклонить» — семантика уточняется по этапу 0
- [ ] Системная строка режима и итог решения по плану в ленте (B6)
- [ ] Режим bypass в меню доступен только при `agentura.allowBypassPermissions`
- [ ] Состояние `waiting`: вкладка с маркером, поле ввода с подписью «уйдёт после решения»
- [ ] Тесты: маршрутизация `canUseTool` → тип карточки, построение превью диффа

**Готово, когда:** сценарий «в режиме manual попроси переименовать функцию и прогнать тесты» даёт карточку правки с работающим нативным диффом и карточку команды; «Всегда» добавляет правило в `.claude/settings.local.json`; сценарий в plan mode заканчивается карточкой плана, «Выполнять» переводит в default и агент правит файлы.

**Сессия:** opus или fable, effort high; после этапа 4. Промт 5.

### 6. Сессии, боковая панель, восстановление

Экран `sessions`, восстановление после перезагрузки окна.

- [ ] Боковая панель: секция «Аккаунт и лимиты» (`accountInfo()`: email, `subscriptionType`; `rateLimitTier` из credentials; вход через CLI; версия движка из `init.claude_code_version`; полосы лимитов), кнопка `/status`
- [ ] Секция «Сессии»: «Новая сессия» (⌘⇧N), список по дням из `src/data/sessions.ts` (название, ходы, стоимость, токены, статус живой сессии), клик → `resume` во вкладке; поиск отключён с подписью «скоро»
- [ ] Попап `sessions` в шапке чата — тот же список коротко, «все сессии в боковой панели», «новая сессия»
- [ ] Название сессии из `summary`/`customTitle`, переименование через `renameSession` по двойному клику (B9 «Заголовки»)
- [ ] Восстановление: `WebviewPanelSerializer` + `workspaceState` (открытые сессии), при старте — `resume` и рендер истории из `getSessionMessages()`; режим plan восстанавливается из `init.permissionMode`
- [ ] Команда «Открыть последний» открывает вкладку последней сессии проекта
- [ ] Обновление списка по `fs.watch` папки транскриптов (дебаунс)

**Готово, когда:** «Reload Window» возвращает вкладку с историей и продолжает диалог в той же сессии; список в боковой панели совпадает с `claude --resume` по составу; итоги сессии отличаются от `agentmeter tasks` не более чем на 5 %.

**Сессия:** sonnet, effort medium; после этапа 5. Промт 6.

### 7. Состояния, ошибки, лимит, полировка

Экраны `error`, `limit`, светлая тема, доступность, журнал.

- [ ] Ошибки движка: `assistant.error` коды и завершение процесса → карточка «Движок остановился» с текстом, «Повторить ход» (повторная отправка последнего промпта в `resume`), «Открыть журнал расширения»
- [ ] Упавший инструмент: строка с красным результатом, раскрываемый вывод
- [ ] Лимит исчерпан: `rate_limit_event rejected` или ошибка `rate_limit` → баннер со временем сброса, строка «ход не начат», поле ввода `off` с подписью «отправка отложена до HH:MM» (без автоматики — A14 Потом)
- [ ] Компакция: авто и `/compact`, строка в ленте, индикатор «сжимаю» в HUD
- [ ] Отладочная команда `agentura.debug.showState <empty|working|waiting|error|limited>` — прогоняет фикстуры событий, чтобы владелец сверял состояния с прототипом без живого движка
- [ ] Светлая тема: проход по всем состояниям, поправки токенов
- [ ] Доступность: фокус клавиатурой по карточкам и меню, aria-роли вкладок и кнопок, `prefers-reduced-motion`
- [ ] Журнал: все события адаптера уровнем debug, ошибки — error, команда «Показать журнал»
- [ ] `docs/features.md`: строки MVP отмечены «сделано» или перенесены с причиной

**Готово, когда:** `agentura.debug.showState` воспроизводит пять состояний, владелец сверил их с галереей прототипа; при обрыве сети (выключить Wi-Fi во время хода) появляется карточка ошибки и «Повторить» продолжает сессию.

**Сессия:** sonnet, effort medium; после этапа 6. Промт 7.

### 8. Сборка, тесты, релиз 0.1

- [ ] `.vscodeignore`, `vsce package` → `.vsix` меньше 30 МБ (бандленный бинарь SDK — проверить размер; при превышении — `agentura.claudeExecutable` по умолчанию на системный `claude` с проверкой версии)
- [ ] Интеграционный тест `@vscode/test-electron`: активация, команда `agentura.open` создаёт панель, боковая панель регистрируется
- [ ] `README.md` корня: установка из `.vsix`, требования (Claude Code вход, версия), настройки, известные ограничения (ToS, формат транскриптов)
- [ ] `CHANGELOG.md` 0.1.0
- [ ] Установка `.vsix` в основной VS Code, день работы на рабочем проекте, список замечаний в `docs/roadmap/03-after-0.1.md`
- [ ] Тег `v0.1.0`

**Готово, когда:** `code --install-extension agentura-0.1.0.vsix` ставится, расширение проходит сценарии этапов 3, 5, 6 в основном VS Code; `git tag -l v0.1.0` отвечает.

**Сессия:** sonnet, effort medium; после этапа 7. Промт 8.

## Промты сессий

### Промт 0 — разведка SDK

```
Сессия 0 — разведка Claude Agent SDK на живом движке · Модель: opus или fable, effort: high

Работаем в /Users/fost/Projects/Agentura. Задача: снять факты о поведении @anthropic-ai/claude-agent-sdk
0.3.x, нужные для расширения VS Code, и записать их в docs/spikes/sdk-probe.md.

Читай: docs/roadmap/02-implementation.md (этап 0 — твой, раздел «Контекст» — что уже известно из доки);
docs/features.md раздел A (какие данные нужны приборам). Дока SDK: https://code.claude.com/docs/en/agent-sdk/typescript
(сырой markdown доступен как https://code.claude.com/docs/en/agent-sdk/typescript.md; снимки на 30.09 —
docs/spikes/sdk-docs-2026-09-30/, выжимка — docs/spikes/sdk-doc-review.md). Код Agentmeter для
OAuth-usage: /Users/fost/Projects/Agentmeter/packages/core/src/limits/oauth.ts и
apps/desktop/src/main/oauth.ts (только читать).

Уже решено: скрипт — spikes/sdk-probe/run.mjs (Node ESM, зависимости в spikes/sdk-probe/package.json,
в корень репозитория не ставить); streaming input mode (prompt как AsyncIterable); ANTHROPIC_API_KEY
в env не передавать — используем вход CLI; cwd = этот репозиторий; модели opus-5.5 и sonnet-5.5,
maxBudgetUsd 2 на весь прогон; все сообщения SDK писать в spikes/sdk-probe/logs/<сценарий>.jsonl
(это будущие фикстуры тестов, не удалять и не редактировать).

Сценарии (каждый — отдельный лог): 1) привет + interrupt на втором ходу + setPermissionMode +
setModel + applyFlagSettings; 2) чтение файла и правка README в manual — canUseTool для Edit с
suggestions, ответ allow с updatedPermissions в localSettings, проверить .claude/settings.local.json,
после сценария вернуть файлы и настройки как были; 3) AskUserQuestion — попросить агента задать вопрос
с вариантами; 4) plan mode — попросить план правки, дождаться ExitPlanMode, записать, что пришло в
canUseTool и в tool_use_result; 5) субагент — «запусти Explore-агента и найди X», записать task_*,
parent_tool_use_id, попробовать stopTask на фоновой задаче; 6) компакция — /compact промптом;
7) thinking с display summarized — какие stream_event приходят; 8) listSessions/getSessionMessages/
resume — стоимость накапливается?; 9) getContextUsage() до и после хода, rate_limit_event, accountInfo();
10) GET https://api.anthropic.com/api/oauth/usage с токеном из ~/.claude/.credentials.json — записать
форму ответа (токен в лог не писать).

Итог — docs/spikes/sdk-probe.md: таблица «вопрос → ответ → поле/тип → файл лога:строка», раздел
«что остаётся допущением и как проверим в реализации». Затем поправить колонку «Источник данных»
в docs/features.md для A1–A6, A10 и закрыть пункт про окно контекста в prototype/README.md.
Галочки этапа 0 в roadmap — по факту.

DoD: как в «Готово, когда» этапа 0. Не делать: код расширения, правки Agentmeter, публикацию логов
с токенами (грепнуть логи на sk-ant- перед коммитом).

Коммиты — по ходу, русская фраза по сути, без подписей ассистента. Push — в конце.
```

### Промт 1 — каркас

```
Сессия 1 — каркас расширения Agentura и прототип внутри webview · Модель: sonnet, effort: medium

Работаем в /Users/fost/Projects/Agentura. Задача: собрать расширение VS Code с двумя webview
(вкладка чата, боковая панель), которые рендерят экраны прототипа из статических данных, и
проверить стили в реальных темах.

Читай: docs/roadmap/02-implementation.md (этап 1 — твой; раздел «Решено»); prototype/README.md;
prototype/screens/chat.html и prototype/screens/sessions.html (эталон разметки);
prototype/shared/tokens.css, hud.css (переносятся без правок); docs/spikes/sdk-probe.md (список
событий для заглушек протокола).

Уже решено: TypeScript strict; esbuild (extension → dist/extension.js cjs/node, external vscode;
webview → dist/webview/*.js esm/browser); Preact + @preact/signals, JSX через esbuild;
vitest, eslint, prettier; один package.json в корне; VS Code engines ^1.138; CSP с nonce,
никаких inline-скриптов; стили — media/tokens.css и media/hud.css, скопированные из prototype/shared;
Output channel «Agentura».

Шаги — чекбоксы этапа 1 по порядку. Данные для статического рендера взять из разметки chat.html
и sessions.html (та же сессия «мигание счётчика талонов»), вынести в src/webview/fixtures/.
Протокол src/protocol.ts — типы ToWebview/FromWebview, события по списку из этапа 2 roadmap
(пока как типы без реализации).

DoD: как в «Готово, когда» этапа 1. Проверка: npm run check; F5 → команда «Agentura: открыть чат»
и значок в activity bar; сверка обеих тем — владелец, тебе достаточно убедиться, что все цвета
идут через переменные --vscode-* (grep по media/ на #hex вне var(...) fallback).

Не делать: подключение SDK, живые данные, вёрстку сверх прототипа.
Коммиты — по ходу, русская фраза по сути, без подписей ассистента. Push — в конце.
```

### Промт 2 — адаптер и данные

```
Сессия 2 — адаптер агента и слой данных · Модель: opus или fable, effort: high

Работаем в /Users/fost/Projects/Agentura. Задача: интерфейс адаптера по форме ACP, реализация
на Claude Agent SDK, слой данных для приборов и списка сессий, тесты на фикстурах.

Читай: docs/roadmap/02-implementation.md (этап 2 — твой; «Контекст» — факты об SDK);
docs/spikes/sdk-probe.md и логи spikes/sdk-probe/logs/*.jsonl (реальные формы сообщений);
docs/features.md раздел A (что должно получиться из событий); src/protocol.ts (что ждёт webview).
Agentmeter: /Users/fost/Projects/Agentmeter/packages/core/src/sources/claude/parse.ts,
sources/types.ts, sources/jsonl.ts, limits/oauth.ts, limits/windows.ts, format/tokens.ts,
apps/desktop/src/main/oauth.ts (чтение токена) — vendored-копия в src/data/agentmeter/ с ORIGIN.md
(коммит источника, MIT). Правок в Agentmeter не делать.

Уже решено: одна живая query() на сессию, streaming input через асинхронную очередь;
env = {...process.env} без ANTHROPIC_API_KEY; includePartialMessages; thinking adaptive +
display summarized; forwardSubagentText true; settingSources все; canUseTool — единая точка,
промисы по toolUseID; usage дедуп по message.id; стоимость живого хода — modelUsage.costUSD,
таблица цен src/data/pricing.ts только для итогов сессий из транскриптов; лимиты — опрос
/api/oauth/usage не чаще настройки (по умолчанию 15 мин), fallback rate_limit_event.

Шаги — чекбоксы этапа 2. Тесты: маппинг «лог SDK → ожидаемые события» на фикстурах из
spikes/sdk-probe/logs (ожидания — в src/agent/claude/__fixtures__/*.expected.json, генерируются
скриптом и правятся руками при проверке), pricing, парсер Agentmeter на его fixtures/claude
(скопировать нужные файлы в test/fixtures).

DoD: как в «Готово, когда» этапа 2. Проверка: npm test; node scripts/adapter-smoke.mjs "скажи привет"
на живом движке. Не делать: UI, изменения протокола без записи в roadmap (если событие пришлось
добавить — дописать в этап 2 и в src/protocol.ts с пометкой).

Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

### Промт 3 — чат

```
Сессия 3 — чат Agentura · Модель: sonnet, effort: medium

Работаем в /Users/fost/Projects/Agentura. Задача: живая лента и поле ввода по экранам прототипа
chat, input, empty поверх адаптера из этапа 2.

Читай: docs/roadmap/02-implementation.md (этап 3 — твой); prototype/screens/chat.html, input.html,
empty.html (эталон разметки и текстов — классы и структура те же); src/agent/types.ts и
src/protocol.ts (события); src/webview/ (каркас и статический рендер из этапа 1 — заменяешь
фикстуры живыми данными, разметку не меняешь).

Уже решено: markdown — marked + DOMPurify в бандле webview; поле — contenteditable plaintext-only;
меню «/» из init.slash_commands + init.skills + свои /clear /compact /status /plan; «@» — workspace.findFiles
с исключениями files.exclude и .gitignore (через расширение, не из webview); автоконтекст — активный
редактор и выделение, чипы с крестиком; строки интерфейса в src/webview/strings.ts.

Шаги — чекбоксы этапа 3. DoD: как в «Готово, когда» этапа 3; проверка — живой сценарий в этом
репозитории и сравнение с chat.html глазами (владелец); npm run check.

Не делать: приборы (этап 4), карточки разрешений (этап 5) — для них оставить заглушки-события,
которые пишутся в журнал.
Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

### Промт 4 — приборы

```
Сессия 4 — приборы Agentura · Модель: sonnet, effort: medium

Работаем в /Users/fost/Projects/Agentura. Задача: HUD, панели «ход» и «агенты», итог хода,
системные строки — по прототипу.

Читай: docs/roadmap/02-implementation.md (этап 4 — твой; «Контекст» — откуда какие данные);
prototype/screens/chat.html (шапка, панели), limit.html (пороги и красный лимит);
prototype/shared/hud.js (поведение вкладок в узкой вкладке); docs/features.md A1–A6, A15;
src/data/limits.ts, src/agent/types.ts.

Уже решено: 20 блоков = maxTokens/20; пороги из настройки agentura.contextThresholds; кэш-таймер =
время последнего API-ответа + TTL (1h подписка, 5m API-ключ/субагенты; уточнять по
cache_creation.ephemeral_*); доля попаданий = cache_read/(input+cache_read+cache_creation) за сессию;
таймлайн строится из tool.start/result с временем от начала хода; агенты — из agent.* событий.

Шаги — чекбоксы этапа 4. DoD: как в «Готово, когда» этапа 4: сверка контекста с /context, стоимости
с result.total_cost_usd, лимитов с /usage в CLI на той же сессии; npm test.

Не делать: карточки разрешений, сессии.
Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

### Промт 5 — разрешения, план, дифф

```
Сессия 5 — разрешения, вопросы, план, дифф · Модель: opus или fable, effort: high

Работаем в /Users/fost/Projects/Agentura. Задача: карточки .ask и переключение режимов по экранам
permission, diff, plan; нативный дифф VS Code.

Читай: docs/roadmap/02-implementation.md (этап 5 — твой); docs/spikes/sdk-probe.md (сценарии 2, 3, 4:
формы canUseTool для Edit, AskUserQuestion, ExitPlanMode); prototype/screens/permission.html,
diff.html, plan.html; src/agent/claude/adapter.ts (ветки canUseTool).

Уже решено: «Всегда» — updatedPermissions из suggestions с destination localSettings; «Принимать
правки до конца сессии» — setMode('acceptEdits'); превью правки — дифф old_string/new_string
(библиотека diff) или content против файла на диске; «открыть дифф» — vscode.diff над
TextDocumentContentProvider со схемой agentura-diff (левая сторона — файл до, правая — после);
после применения — structuredPatch из tool_use_result; Esc на карточке = отклонить; bypass в меню
только при agentura.allowBypassPermissions. Семантика кнопок плана — по фактам из sdk-probe: если
ExitPlanMode приходит в canUseTool, «Выполнять» = allow + setMode('default'), «Выполнять, принимая
правки» = allow + setMode('acceptEdits'), «Доработать» = deny с текстом из поля, «Отклонить» = deny +
interrupt; если приходит иначе — записать решение в roadmap.

Шаги — чекбоксы этапа 5. DoD: как в «Готово, когда» этапа 5 (два живых сценария), тесты маршрутизации
и превью; npm run check.

Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

### Промт 6 — сессии и боковая панель

```
Сессия 6 — сессии, боковая панель, восстановление · Модель: sonnet, effort: medium

Работаем в /Users/fost/Projects/Agentura. Задача: боковая панель (аккаунт, лимиты, сессии),
попап sessions, возобновление и восстановление после перезагрузки окна.

Читай: docs/roadmap/02-implementation.md (этап 6 — твой); prototype/screens/sessions.html и
prototype/shared/sidebar.js (эталон, включая состояния строк live/wait/err); src/data/sessions.ts,
src/data/limits.ts, src/agent/types.ts (listSessions, resumeSession, accountInfo);
docs/spikes/sdk-probe.md сценарий 8.

Уже решено: список — listSessions() SDK для текущей папки + итоги парсером Agentmeter из
src/data/agentmeter; статус живой сессии — из реестра запущенных в расширении; восстановление —
WebviewPanelSerializer + workspaceState, история — getSessionMessages(); название —
summary/customTitle, переименование — renameSession; обновление списка — fs.watch папки транскриптов с дебаунсом.

Шаги — чекбоксы этапа 6. DoD: как в «Готово, когда» этапа 6 (Reload Window, сверка с claude --resume
и agentmeter tasks); npm run check.

Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

### Промт 7 — состояния и полировка

```
Сессия 7 — состояния, ошибки, лимит, полировка · Модель: sonnet, effort: medium

Работаем в /Users/fost/Projects/Agentura. Задача: экраны error и limit, компакция, отладочная команда
состояний, светлая тема, доступность, журнал.

Читай: docs/roadmap/02-implementation.md (этап 7 — твой); prototype/screens/error.html, limit.html,
empty.html; prototype/README.md («Зафиксировано / открыто»); docs/features.md (B8, B11, B20, A14, A15).

Уже решено: «Повторить ход» = повторная отправка последнего промпта в resume той же сессии;
лимит исчерпан = баннер + строка «ход не начат» + поле off с подписью, без автоотправки (A14 Потом);
agentura.debug.showState прогоняет фикстуры событий из test/fixtures/states/*.jsonl через тот же
стор, что и живые события.

Шаги — чекбоксы этапа 7. DoD: как в «Готово, когда» этапа 7; npm run check.
В конце — отметить в docs/features.md строки MVP как сделанные (колонка «Статус» или пометка в заметке).

Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

### Промт 8 — релиз 0.1

```
Сессия 8 — сборка, тесты, релиз 0.1 · Модель: sonnet, effort: medium

Работаем в /Users/fost/Projects/Agentura. Задача: упаковать расширение, интеграционный тест,
README и CHANGELOG, тег v0.1.0.

Читай: docs/roadmap/02-implementation.md (этап 8 — твой; «Юридическое» — что написать в ограничениях);
package.json; README.md корня.

Уже решено: vsce package; лимит .vsix 30 МБ, при превышении — agentura.claudeExecutable по умолчанию
на системный claude с проверкой версии при активации; интеграционный тест на @vscode/test-electron
(активация + команда open + регистрация view); дегустация день на рабочем проекте — владелец, замечания
он складывает в docs/roadmap/03-after-0.1.md (создать пустой с шапкой).

Шаги — чекбоксы этапа 8. DoD: как в «Готово, когда» этапа 8. Тег ставит владелец после дегустации.

Коммиты — по ходу, без подписей ассистента. Push — в конце.
```

## Риски и открытые вопросы

- **Лимиты 5 ч / 7 д не отдаются SDK.** Опора на `GET /api/oauth/usage` — недокументированный
  эндпоинт, который использует Agentmeter. Если сломается — fallback на `rate_limit_event`
  (без типа окна) и оценка из транскриптов (`limits/claude.ts` Agentmeter, «≈»). Узнаем в этапе 0.
- **Вход подписки в стороннем продукте.** Дока SDK запрещает предлагать claude.ai-логин третьим
  лицам без одобрения. Для личного расширения — работаем через вход CLI; публикация в Marketplace
  потребует либо API-ключа как основного пути, либо разрешения. Решение владельца до этапа 8
  (в README 0.1 — как ограничение).
- **Формат транскриптов внутренний.** Парсер Agentmeter может сломаться на новой версии CLI.
  Смягчение: `listSessions`/`getSessionMessages` SDK как fallback для списка и usage, парсер —
  только для итогов; фикстуры Agentmeter в тестах.
- **`ExitPlanMode` и `canUseTool`.** Не подтверждено, что план приходит на подтверждение через
  `canUseTool` и где его текст. Семантика четырёх кнопок карточки плана фиксируется после этапа 0.
- **Размер `.vsix`.** SDK бандлит нативный бинарь движка; если пакет больше 30 МБ — по умолчанию
  использовать системный `claude` (`pathToClaudeCodeExecutable`) с проверкой версии.
- **SDK 0.3.x меняется.** Зафиксировать версию в `package.json` точно (без `^`), обновлять
  отдельным коммитом с прогоном фикстур этапа 0.
- **Стоимость — оценка.** `total_cost_usd` и своя таблица цен не совпадут со счётом подписки;
  в интерфейсе подписывать как оценку (текст «≈» в итоге сессии).
- **Вопрос владельцу:** нужен ли API-ключ как альтернативный вход уже в 0.1 (влияет на TTL кэша
  и на риск выше) или только вход CLI.

## Порядок работы

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8, строго последовательно: один репозиторий, каждый этап
опирается на код предыдущего. Этапы 0, 2, 5 — сильная модель (поведение живого SDK, архитектура
адаптера, разрешения и дифф), остальные — Sonnet по эталону прототипа с приёмкой `/plan-review`
после каждого. Логи этапа 0 — фикстуры этапов 2 и 7, поэтому этап 0 не пропускать даже при желании
«сразу писать код».
