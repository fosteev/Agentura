# Agentura: реализация расширения до версии 0.1

> Статус: этапы 0–8 приняты по коду 2026-10-01 · этап 8 (сборка, тесты, релиз 0.1) принят после ревью: универсальный `agentura-0.1.0.vsix` 5,5 МБ без бинарника движка (системный `claude`), 404 юнит-теста, интеграционный тест 5/5 на VS Code 1.140.0, `scripts/vsix-verify.mjs` зелёный · **осталось за владельцем:** F5/глазами по этапам 1–7 (список — `03-after-0.1.md`), установка `.vsix` в основной VS Code и день работы на рабочем проекте, тег `v0.1.0` после дегустации, решение по API-ключу как входу / ToS перед любой публичной раздачей · долг и замечания — `docs/roadmap/03-after-0.1.md` · история этапов 0–7 — в разделах этапов ниже; прототип утверждён (`01-features-prototype.md`, тег `prototype-v1`)
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
  без монорепо. Язык интерфейса — русский (как прототип), строки в одном модуле для будущей локализации (`src/webview/strings.ts`).
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

- [x] `package.json` расширения: `engines.vscode ^1.138`, `main`, `contributes`: viewContainer `agentura` в activity bar с webview view `agentura.sidebar`; команды `agentura.open`, `agentura.newSession`, `agentura.openLast`, `agentura.resumeSession`, `agentura.showLogs`; хоткеи для open/newSession; настройки `agentura.contextThresholds` ([120000,150000]), `agentura.allowBypassPermissions` (false), `agentura.defaultModel`, `agentura.claudeExecutable` (пусто = бандленный), `agentura.usagePollMinutes` (15)
- [x] `esbuild.mjs`: сборка `src/extension/**` → `dist/extension.js` (cjs, platform node, external vscode) и `src/webview/**` → `dist/webview/{chat,sidebar}.js` (esm, browser), режим watch; `npm run build`, `npm run watch`, `npm run check` (tsc + eslint + vitest)
- [x] `media/tokens.css`, `media/hud.css` скопированы из `prototype/shared/` без правок; `prototype/shared/preview.*` не переносится
- [x] Webview-панель чата (`WebviewPanel`, `retainContextWhenHidden`, CSP с nonce, `localResourceRoots`), Preact-приложение рендерит экран `prototype/screens/chat.html` из статических данных (та же разметка и классы)
- [x] Webview view боковой панели рендерит `prototype/screens/sessions.html` (левая часть) из статических данных
- [x] `src/protocol.ts`: типы сообщений extension ↔ webview (`ToWebview`, `FromWebview`) с заглушками под события этапа 2; `postMessage` обёртки с типами
- [x] Output channel «Agentura» и логгер с уровнями (B20)
- [x] `vitest` с одним тестом на протокол; `eslint` + `prettier` конфиги
- [x] Обе темы проверены на глаз владельцем: F5 → вкладка и боковая панель совпадают с прототипом

**Готово, когда:** `npm run check` зелёный; F5 открывает Extension Development Host, команда «Agentura: открыть чат» показывает статический экран чата, значок в activity bar — боковую панель; в Dark Modern и Light Modern нет непрокрашенных мест.

**Сессия:** sonnet, effort medium; после этапа 0 (зависит от списка событий). Промт 1.

**Решения (2026-09-30, по итогам сессии 1):**
- Раскладка: `src/extension/` (хост: `extension.ts`, `chatPanel.ts`, `sidebarView.ts`, `webviewHost.ts`, `html.ts`, `logger.ts`), `src/webview/{chat,sidebar}/index.tsx` (точки входа), `src/webview/components/`, `src/webview/fixtures/`, `src/protocol.ts` (общий для обеих сторон). `npm run check` = typecheck + eslint + vitest + build.
- Строки интерфейса webview — `src/webview/strings.ts` (`ui.*`); в фикстурах только данные сессии. Новые компоненты берут подписи оттуда, не из JSX.
- `hud.js` прототипа не переносится: вкладки чат/ход/агенты — сигнал в `Chat.tsx`. Широкую вёрстку (`html[data-width="900"]`, на неё завязан `hud.css`) включает сам webview при ширине ≥ 700px; ниже — вкладки. Порог подобран между 380 (сплит) и 900 (вкладка) прототипа, уточняется владельцем на глаз.
- `media/webview.css` — поправки под реальный webview, которых нет в `hud.css`: высота 100vh, пятый ряд грида `.sidebar` (в `sessions.html` пять блоков при четырёх рядах в `hud.css`), стиль `.sidebar .head` из inline-`<style>` экрана. `tokens.css` и `hud.css` — побайтовые копии.
- Хэндшейк: webview шлёт `ready`, хост отвечает `init {surface, version}`. События агента идут в webview как `agent.event {sessionId, event}`; `AgentEventStub` в `src/protocol.ts` на этапе 2 заменяется настоящим `AgentEvent` из `src/agent/types.ts`.
- Хоткеи: `cmd+alt+a` — открыть чат; `cmd+shift+n` — новая сессия, только при фокусе в панели чата или боковой панели (иначе перехватывает «Новое окно»). Команды `newSession`/`openLast` пока открывают чат, `resumeSession` — заглушка (этап 6).
- Вкладка чата открывается в `ViewColumn.Beside`, одна на окно. Версии: preact 11, @preact/signals 2.11, typescript 6, esbuild 0.28, vitest 5, eslint 10; `@types/node` 24 — под extension host.
- Сверка разметки с прототипом сделана механически (теги, классы, тексты, inline-стили компонентов против `chat.html` и левой части `sessions.html`) — совпадает; визуальная сверка тем остаётся за владельцем.
- Обновление лимитов вручную (просьба владельца, 2026-09-30, сверх прототипа): кнопка ↻ в заголовке «Аккаунт и лимиты» боковой панели и команда «Agentura: Обновить лимиты» → `limits.refresh` → `UsageService.refresh()` → `limits.update {windows, updatedAt, error?}`. Кулдаун 60 с (эндпоинт `/api/oauth/usage` ограничен по частоте): раньше отдаётся кэш с прежним `updatedAt`; параллельные нажатия склеиваются; ошибка не затирает прошлые данные. Время данных — в подсказке кнопки. HUD чата (5ч/нед) подпишется на `limits.update` на этапе 4.
- Прототип после `prototype-v1` (2026-09-30, галерея v7): кнопка ↻ в `sidebar.js`/`sessions.html` и цвет лимитов по порогам — `prototype/shared/limits.js` ставит `lim-hot` (до 70 %), `lim-warn` (> 70 %), `lim-full` (> 85 %) на счётчики 5ч/нед в HUD и строки лимитов боковой панели, стили в `hud.css`. В коде расширения классы `lim-*` пока не ставятся — сделать в этапе 4 (HUD) и этапе 6 (боковая панель) по тем же порогам.
- В `hud.css` два цвета мимо токенов: `#fff` у `.tabs button .b.live` (строка 46) и у `.menu .it .sw.on::after` (строка 234). Править в `prototype/shared/hud.css` и перекопировать — в этапе 7, если в светлой теме будет заметно.
- Шапка по варианту Б (выбор владельца 2026-09-30, галерея v9, коммит `d6a9c09`): шапка — одна строка `nav.tabs` + `.sess` (только в широкой) + `.acts`; приборы у поля ввода — `div.blocks` полосой по верху `footer.compose`, `span.cn` (число контекста, «сжать») в строке чипов, `button.agent` и `span.meters` (кэш, 5ч; неделя только в боковой панели) в строке настроек. `media/hud.css` перекопирован, `Hud.tsx`/`Chat.tsx` приведены к новой разметке; подписи — `ui.compose.*`. Этапы 3–4 строят заголовок и приборы по этой разметке: пункт «Заголовок» этапа 3 — вкладки + название сессии (в широкой) + `sessions`/`new`, агент — в строке настроек.

### 2. Адаптер агента и слой данных

Граница по форме ACP: интерфейс адаптера и модель событий, не зависящие от Claude; реализация
на Agent SDK; данные для приборов и списка сессий из Agentmeter. Здесь много суждения по
живому поведению SDK — сильная модель.

- [x] `src/agent/types.ts`: `AgentAdapter` (`createSession`, `resumeSession`, `listSessions`, `accountInfo`) и `AgentSession` (`send`, `events`, `respondPermission`, `answerQuestion`, `decidePlan`, `setMode`, `setModel`, `setEffort`, `interrupt`, `compact`, `stopTask`, `dispose`)
- [x] `AgentEvent` union: `session.init`, `turn.start`, `text.delta`, `thinking.start/delta/stop`, `tool.start/progress/result`, `permission.request`, `question.request`, `plan.request`, `usage.message`, `context.usage`, `turn.result`, `compaction.start/end`, `agent.start/progress/end`, `limit.update`, `mode.changed`, `error` + добавлены `session.title`, `permission.resolved` (см. «Решения»)
- [x] `src/agent/claude/adapter.ts`: streaming input через асинхронную очередь, `env: {...process.env}` без `ANTHROPIC_API_KEY`, `cwd` = папка воркспейса, `includePartialMessages`, `thinking: {type:'adaptive', display:'summarized'}`, `settingSources` все три, `forwardSubagentText: true`
- [x] Маппинг SDK → события по логам этапа 0: дедуп usage по `message.id`, `parent_tool_use_id` → `agentId`, `task_*` → `agent.*`, `compact_boundary` → `compaction.end`
- [x] `canUseTool` → промисы по `toolUseID`: ветки `AskUserQuestion`, `ExitPlanMode`, Edit/Write (превью диффа в событии), остальные; ответы `respondPermission/answerQuestion/decidePlan` резолвят промис
- [x] `src/data/agentmeter/` — vendored части `@agentmeter/core`: `sources/claude/parse.ts`, `sources/types.ts`, `sources/jsonl.ts`, `limits/oauth.ts`, `limits/windows.ts`, `format/tokens.ts` + файл `ORIGIN.md` (коммит-источник, MIT)
- [x] `src/data/pricing.ts`: таблица $/MTok по моделям (ввод, вывод, чтение кэша, запись кэша 5m/1h) с датой; `cost(usage, model)`; для живых ходов приоритет у `modelUsage.costUSD`
- [x] `src/data/limits.ts`: опрос `/api/oauth/usage` (токен из `.credentials.json`/Keychain, троттлинг по настройке) → `LimitWindow[]`; fallback — `rate_limit_event`; подставляется как `UsageFetcher` в `UsageService` (`src/extension/usage.ts`) вместо `stubUsageFetcher` — ручное обновление ↻ и команда `agentura.refreshUsage` уже идут через него
- [x] `src/data/sessions.ts`: `listSessions()` SDK + итоги по транскрипту парсером Agentmeter (ходы, токены, стоимость по `pricing`), статус живых сессий по собственному реестру запущенных
- [x] Тесты vitest: маппинг адаптера на фикстурах из `spikes/sdk-probe/logs/` (ожидаемая последовательность событий), `pricing`, парсер на фикстурах Agentmeter (`fixtures/claude`)

**Готово, когда:** `npm test` зелёный; `node scripts/adapter-smoke.mjs "скажи привет"` печатает последовательность событий с `turn.result` (стоимость, токены, окно) на живом движке; `canUseTool` для `Bash` доходит до события `permission.request` и резолвится ответом.

**Сессия:** opus или fable, effort high; после этапа 1. Промт 2.

**Решения (2026-09-30, по итогам сессии 2):**
- Раскладка: `src/agent/types.ts` (граница по форме ACP: `AgentAdapter`, `AgentSession`, `AgentEvent`, `EventStream`), `src/agent/stream.ts` (`AsyncQueue` для streaming input, `EventHub` для событий), `src/agent/claude/` — `adapter.ts` (живая `query()`), `mapper.ts` (сообщения SDK → события; чистое состояние без ввода-вывода), `permissions.ts` (`PermissionBroker` — единая точка `canUseTool`), `replay.ts` (прогон логов пробы через маппер и брокер), `json.ts`; `src/data/` — `pricing.ts`, `limits.ts`, `sessions.ts`, vendored `agentmeter/` с `ORIGIN.md`. Тесты рядом с кодом (`*.test.ts`), эталоны парсера — `test/fixtures/claude/`.
- **Протокол: два события сверх списка этапа 1** (в `AGENT_EVENT_TYPES` помечены комментарием): `session.title` — из `system/session_title_changed`, название для заголовка и списка сессий; `permission.resolved {toolUseId, decision, by: 'user' | 'abort'}` — запрос закрыт ответом или отменён движком (прерывание, закрытие сессии): без него карточка разрешения в webview не узнает, что ответ больше не нужен. `AgentEventStub` заменён на `AgentEvent`; `LimitWindowSummary` = `LimitWindow`; `PermissionMode` и `PermissionDecision` протокол реэкспортирует из `agent/types.ts`. Список имён и union сверяются при компиляции.
- `agentId` события = id вызова `Agent` (`parent_tool_use_id`), а не `task_id`: сообщения субагента помечены именно им. `agent.*` несут оба поля (`taskId` — для `stopTask`); `agentID` из `canUseTool` (это `task_id`) маппер переводит в `agentId`. Задача, запущенная субагентом (его Bash), — `agent.start.parentAgentId`.
- Границы хода: `turn.start` порождает первое «ходовое» сообщение основного агента (`system/init`, `status: requesting | compacting`, `stream_event`, `assistant` без `parent_tool_use_id`), если ход не открыт; `turn.result` закрывает. `prompt` — из очереди отправленных текстов; без `prompt` — ход начал движок (пробуждение после фоновой задачи, `turn.result.origin: "task-notification"`). Сообщения субагента, пришедшие после `result`, ход не открывают. `/compact` — обычный ход с `compaction.start/end` внутри.
- `session.init` шлётся только при смене `session_id | model | permissionMode` (движок присылает `init` перед каждым ходом).
- usage: у основного агента `usage.message` — по `message_delta` (настоящий вывод, `final: true`; разбивка записи кэша 5m/1h — из `message_start`), один раз на `message.id`; у субагентов потока нет — по первому `assistant`, `final: false` (вывод — плейсхолдер). Оборванный ответ (прерывание) отдаётся на `result` с `final: false`. После каждого usage основного агента — `context.usage {source: 'usage'}` (`input + cacheRead + cacheWrite`); после первого `session.init` и каждого `turn.result` адаптер зовёт `getContextUsage()` → `context.usage {source: 'engine'}` с окном, порогом автосжатия и категориями.
- `turn.result.costUsd` — разность `total_cost_usd` соседних ходов; у новой сессии база 0, у `resumeSession` — `baselineCostUsd` из опций (последний известный `total_cost_usd`; хранить его — дело расширения, этап 6). Без базы стоимость первого хода после resume не выдумываем — поля нет. Прерванный ход: `interrupted: true`, `costUsd: 0`, токены — сумма usage оборванных ответов (в `result.usage` нули). Фоновый субагент, закончивший между ходами, попадает в стоимость следующего хода — так считает движок.
- Текст и thinking основного агента — из `stream_event` (`text_delta`, `thinking_delta`); из `assistant` — только для сообщений без потока (субагенты с `forwardSubagentText`). `system/thinking_tokens` отдельным событием не шлём: оценка едет полем `estimatedTokens` в `thinking.delta` и `thinking.stop`. `system/notification`, `informational`, `permission_denied`, `hook_*` пока не маппятся (строки A15 — этап 4).
- Разрешения: «всегда» = `updatedPermissions` из подсказок движка как есть (у Bash — правило в `localSettings`; у Edit/Write подсказка — `setMode acceptEdits` на сессию; проба для Edit писала своё правило `Edit`, брокер так не делает). `respondPermission(…, 'deny')` закрывает и вопрос, и план; `decidePlan({approve: true, mode})` добавляет `setMode` (без `mode` — голый allow); отказ без текста — `"The user declined this tool use."` (текст видит модель). Отмена сигналом `canUseTool` → deny + `permission.resolved {by: 'abort'}`. Превью правки — `permission.request.diff`: у Edit фрагменты, у Write новый текст (старый файл читает интерфейс).
- Опции `query()`: `permissionMode` задаётся всегда (`default`, если не передан) — иначе движок берёт `permissions.defaultMode` из настроек пользователя (у владельца `auto`), а режимы `auto` и `dontAsk` расширение не ведёт. `systemPrompt: {type: 'preset', preset: 'claude_code'}`, `settingSources` все три (конфиг адаптера позволяет сузить — только для проверок). `env` — `{...process.env}` без `ANTHROPIC_API_KEY` и без маркеров родительской сессии (список — в «Правках по приёмке» ниже), плюс `CLAUDE_AGENT_SDK_CLIENT_APP`.
- **Факт живого прогона:** в `~/.claude/settings.json` владельца `permissions.allow: ["Bash", "Read", "Write", "Edit", …]` — с пользовательскими настройками (дефолт расширения) запросы разрешений на эти инструменты не приходят вовсе. Поэтому `scripts/adapter-smoke.mjs --bash` грузит только `project` + `local`. Для этапа 5: карточки разрешений владелец увидит только для того, что не покрыто его правилами.
- SDK не бандлится: ESM-пакет ищет нативный бинарник CLI через `import.meta.url`, в CJS-бандле это ломается. `@anthropic-ai/claude-agent-sdk` 0.3.285 (точная версия) — `external` в `esbuild.mjs`, адаптер грузит его `import()` (esbuild оставляет динамический импорт в CJS). Для упаковки (этап 8): `.vsix` должен включить `node_modules/@anthropic-ai/claude-agent-sdk` и платформенный `claude-agent-sdk-<os>-<arch>` — пакет становится платформенным (или путь к CLI через `agentura.claudeExecutable`).
- TS-модули из `src/` в node-скриптах: `scripts/lib/load-ts.mjs` собирает модуль esbuild'ом в `dist/scripts/*.mjs` и импортирует — так работают `adapter-smoke.mjs` и `gen-adapter-fixtures.mjs`.
- Ожидания маппинга: `src/agent/claude/__fixtures__/<лог>.expected.json` = `{counts, events, permissionResults}` по 10 логам пробы (два лога без сообщений SDK пропущены). Проекция событий: подряд идущие `text.delta` / `thinking.delta` склеены (`chunks`, `length`), строки длиннее 160 символов обрезаны с пометкой длины, списки длиннее 8 — до 5. Сгенерированы `node scripts/gen-adapter-fixtures.mjs` и просмотрены построчно (ходы, стоимость против `result`, дедуп usage, субагенты, план, вопрос, компакция, resume); по итогам просмотра добавлены `parentAgentId` и база стоимости resume (`PROBE_BASELINES` в `replay.ts`). Инварианты, не зависящие от сгенерированных файлов (usage один раз на `message.id`, сумма стоимостей ходов = итоговый `total_cost_usd`, вывод из `message_delta`, ответы брокера = ответам пробы), — отдельными тестами в `mapper.test.ts`.
- Цены (`src/data/pricing.ts`, снимок 2026-09-25): Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10 (чтение кэша у обоих $0.20), Fable 5.1 $10 / $50 (чтение $0.25), остальные — по стандартным множителям (чтение 0.1×, запись 5 мин 1.25×, 1 ч 2×). Сверено с `modelUsage.costUSD` лога 01 до 7 знаков. Запись кэша без разбивки по TTL считается по 5-минутной цене; неизвестная модель → `undefined`, не 0.
- Лимиты (`src/data/limits.ts`): `LimitsSource.fetch` — `UsageFetcher` для `UsageService` (заглушка в `extension.ts` отключена, `stubUsageFetcher` оставлен для отладки webview). Токен: `.credentials.json`, затем Keychain через асинхронный `execFile('security')` — синхронный `execFileSync` Agentmeter блокировал бы extension host до 10 с. 429 → молчим до `Retry-After` (`throttleFrom` Agentmeter), 401/403 → «войдите заново». При ошибке OAuth отдаются окна последнего `rate_limit_event` (`observeEngine` — подключит чат на этапе 3/4). Опрос: `startLimitsPolling` — сразу при активации, дальше раз в `agentura.usagePollMinutes` (не чаще 5 мин), результат уходит в боковую панель; панель, открытая позже, получает снимок на `ready` (в кулдауне — из кэша). Недельные окна по модели (`weekly_scoped`) разбираются, но в `LimitWindow` пока не попадают.
- Сессии (`src/data/sessions.ts`): каталог транскриптов — `~/.claude/projects/<cwd, где всё кроме [A-Za-z0-9] заменено на ->` (или `CLAUDE_CONFIG_DIR`); итоги — парсер Agentmeter по основному файлу и сабагентам + `pricing`; ходы — промпты пользователя без служебных записей (счётчика ходов у Agentmeter нет); кэш по размеру и mtime. Стоимость живой сессии из реестра `LiveSessions` (последний `total_cost_usd` движка) перекрывает оценку по транскрипту. К боковой панели не подключено — этап 6.
- `EventHub` копит события до первого подписчика: ошибка запуска CLI может прийти раньше, чем интерфейс подписался.
- Живой расход сессии 2: три прогона smoke на Sonnet 5.5 — около $0.19 по оценке SDK.

- **Правки по приёмке (2026-09-30):**
  - Окружение движка: убираются только `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` и маркеры родительской сессии Claude Code (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENTRYPOINT`, `…_SSE_PORT`, `…_SESSION_ID`, `…_CHILD_SESSION`, `…_SESSION_ATTENDED`, `…_MESSAGING_SOCKET`, `…_MESSAGING_TOKEN`, `…_EXECPATH`, `…_EMIT_STARTUP_TIMING`, `…_ENABLE_SDK_FILE_CHECKPOINTING`, `…_ENABLE_TASKS`; список снят с живого окружения сессии Claude Code 2.1.285). Остальные `CLAUDE_CODE_*` (Bedrock/Vertex, `CLAUDE_CODE_OAUTH_TOKEN`, `MAX_OUTPUT_TOKENS`, `GIT_BASH_PATH`) проходят. `CLAUDE_CODE_ENTRYPOINT` SDK ставит в `sdk-ts` только при отсутствии — поэтому чужой убираем.
  - Промпт ↔ ход: адаптер шлёт каждое сообщение со своим `uuid`; движок возвращает эхо `user_message_uuid(s)` на первом ответе хода (и на ответе после влитого в ход сообщения) — маппер привязывает промпт по нему, склеенные движком сообщения дают один ход с обоими текстами. `turn.start` поэтому выходит не на `init`/`requesting`, а на первом сообщении хода с содержимым. Без эха (логи пробы, старый CLI) — очередь, но ход после `task_notification` между ходами считается пробуждением и промпта не получает; если пробуждение всё же забрало промпт по очереди (`result.origin: task-notification`), промпт возвращается следующему ходу — **остаток риска:** в этом случае `turn.start` пробуждения уже ушёл с чужим текстом. На живом CLI 2.1.285 эхо есть (проверено smoke).
  - Синтетические `assistant` (`model: "<synthetic>"` или поле `error`): без `usage.message`/`context.usage`, модель и окно не меняются; с ошибкой — `error {code}`, для лимита (`error: rate_limit` или текст про limit) — `code: 'limit'`; без ошибки — текст.
  - Прерывание посреди рассуждения: `thinking.stop` перед `turn.result`.
  - **Третье новое событие протокола — `session.closed {reason: 'exit' | 'error' | 'disposed', message?}`**: последнее событие потока; после него `EventHub` закрыт (`for await` завершается), `send()`/`compact()` возвращают `false`. Порядок закрытия: отмена ждущих разрешений (`permission.resolved {by:'abort'}`) → `session.closed` → закрытие потока. `AgentSession.send/compact` теперь возвращают `boolean`.
  - `accountInfo(cwd, timeoutMs = 15 с)`: таймаут, `close()` и `abortController.abort()` временного процесса CLI в любом случае.
  - Лимиты: `UsageFetcher` может вернуть `{windows, updatedAt}`; окна движка при ошибке OAuth — только если новее последних удачных данных OAuth и со временем события; `UsageService` не заменяет снимок более старым. Пустой разбор ответа — ошибка (прежние окна остаются). Окно с `resets_at: null` — `0 %` без `resetsAt` (`LimitWindow.resetsAt` стал необязательным). 403 — «сервер отклонил запрос» (Cloudflare по отпечатку TLS, см. Agentmeter), «войдите заново» — только на 401. Недельные окна по модели — `LimitWindow {kind: 'weekly-model', model: 'Fable'}` (webview пока их игнорирует — строка в боковой панели на этапе 6).
  - Keychain (решение владельца): настройка `agentura.limits.readKeychain` (по умолчанию `true`), читается на каждом запросе; `.credentials.json` — всегда; выключено и файла нет — ошибка «включите чтение токена».
  - Цены: весь каталог моделей CLI 2.1.285 (`claude-3-5-haiku` … `claude-sonnet-5-5`; старые — Opus 4.0/4.1 $15/$75, Sonnet 3.5–4.5 $3/$15, Haiku 3.5 $0.80/$4); имена с датой, `-latest`, Bedrock `-v1:0` нормализуются (`claude-sonnet-4-20250514` → `claude-sonnet-4-0`). `inference_geo: "us"` — ×1.1 к токенам, веб-поиск — $10 за 1000 (поля берутся из `usage` записей транскрипта по `requestId`, парсер Agentmeter их не отдаёт). Модель без цены: сумма по известным запросам + `costPartial: true`; если цены нет ни у одного — `costUsd` нет (не $0). В протоколе `SessionSummary.costUsd` стал необязательным, добавлен `costPartial`.
  - Сессии: транскрипт ищется по `cwd` самой сессии (`listSessions` отдаёт и сессии worktree), имя каталога — как у CLI, включая обрезку до 200 символов с хэшем пути (`Nc`/`Y_` в `sdk.mjs`) и запасной поиск по префиксу.
  - Разрешения (решение владельца): `settingSources` по умолчанию все три, как в CLI.

### 3. Чат

Лента, стриминг, инструменты, поле ввода — по экранам `chat`, `input`, `empty`.

- [x] Стор webview на сигналах: сессия, ходы, строки ленты, текущее состояние (`idle | working | waiting | error | limited`)
- [x] Лента: строки `u` (пользователь), `think` (сворачивание, таймер), `e` (инструмент: op, что, результат, время, `diff`-ссылка у Edit/Write), `txt` (markdown через `marked` + `DOMPurify`, блоки кода с копированием), `sum` (итог хода из `turn.result`), `sys` (A15), `live` со `stop`
- [x] Автопрокрутка с «прилипанием» к низу; остановка хода кнопкой и `Esc` → `interrupt()` — код и тесты `interrupt` есть, прокрутку без F5 проверить нельзя (владелец)
- [x] Поле ввода: contenteditable plaintext, Enter / Shift+Enter, история ↑↓ (в пустом поле), вставка текста
- [x] Меню «/»: команды из `init.slash_commands` и скиллы из `init.skills`, плюс собственные `/clear`, `/compact`, `/status`, `/plan`; фильтр по набранному
- [x] Меню «@»: `workspace.findFiles` с фильтром по `.gitignore`/`files.exclude`, вставка токена, передача путей в промпт
- [x] Кнопка «+»: файл или папка, выключатели автоконтекста
- [x] Автоконтекст: открытый файл и выделение из активного редактора, чипы с крестиком, игнорируемые файлы не попадают (B3)
- [x] Переключатели внизу: режим (`setMode`), модель (`supportedModels()`), effort, thinking — как на экране `input`
- [x] Заголовок: агент (Claude; Codex, Gemini «скоро»), проект, название сессии (`summary`/`customTitle`), `sessions`, `new`
- [x] Пустое состояние (экран `empty`): подсказки, недавние сессии
- [x] Индикатор состояния во вкладке: заголовок панели с маркером состояния (● работа, ? ждёт, ! ошибка) — B1
- [x] Строки локализации в `src/webview/strings.ts`
- [x] Живой сценарий DoD на F5 и сверка с `prototype/screens/chat.html` глазами (темы, ширины, автопрокрутка, вставка в поле) — владелец

**Готово, когда:** в этом репозитории задача «найди, где считается число фич в README, и поправь опечатку» проходит целиком: стриминг виден, строки инструментов корректны, остановка работает, итог хода совпадает с `result` в логе; вёрстка не расходится с `prototype/screens/chat.html` (владелец сравнивает глазами).

**Сессия:** sonnet, effort medium; после этапа 2. Промт 3.

**Решения (2026-09-30, по итогам сессии 3):**
- Раскладка. Хост: `src/extension/chatController.ts` (владелец сессии вкладки: события агента → webview, команды webview → сессия; без `vscode`, проверяется тестом с поддельным адаптером), `chatPanel.ts` (сборка зависимостей из VS Code), `workspaceFiles.ts` + `fileSearch.ts` (поиск для «@»/«+»: `findFiles` + `files.exclude` + `search.exclude` + `git check-ignore`, список файлов кэшируется на 20 с, ранжирование чистой функцией), `editorContext.ts` (автоконтекст). Webview: `chatState.ts` (чистый редьюсер `AgentEvent` → строки ленты), `store.ts` (сигналы), `toolView.ts` (строки инструментов), `composer.ts` (триггеры «/» и «@», история), `markdown.ts` (`marked` + `DOMPurify`), компоненты `Composer.tsx`, `Empty.tsx`, `Log.tsx`, `Hud.tsx`, `Chat.tsx`. Общее: `src/shared/prompt.ts` (вложения, блок контекста), `src/agent/status.ts` (состояние `idle|working|waiting|error|limited` и маркер вкладки — одна функция на хост и webview).
- **Протокол, добавлено сверх этапа 2** (в `src/protocol.ts` помечено): хост → webview `chat.info {project, cwd, allowBypass}`, `capabilities {models, commands}`, `editor.context {file?, selection?}`, `files.result`, `attach.picked`, `session.reset`; webview → хост `files.find`, `attach.pick`, `sessions.show`, `diff.open` и поле `attachments` у `send`. В `AgentSession` добавлен `capabilities()` → `{models, commands}` из `supportedModels()` и `supportedCommands()` движка (работает до первого сообщения, проверено на живом CLI: 12 моделей, 93 команды; без расхода лимита).
- Одна вкладка = одна сессия. `sessionId` в сообщениях webview информативен: хост направляет их в текущую сессию вкладки (до первого `session.init` id пуст). Сессия поднимается при открытии вкладки (процесс CLI стартует, запросов к API нет) — иначе нельзя показать список моделей и команд до первого сообщения. «new», `/clear` и команда «Новая сессия» закрывают сессию и создают новую; из палитры хост шлёт `session.reset`, из самого webview — нет (он очищает ленту сам).
- Контекст сообщения (автоконтекст, чипы, «+»): хост дописывает к тексту блок `[Agentura: контекст]` со списком путей и текстом выделения (до 20 000 знаков); `turn.start.prompt` несёт полный текст, `splitPrompt` отделяет блок — в ленте только текст пользователя. Сообщение «в очереди» сопоставляется с `turn.start` по тексту; ход без `prompt` строку пользователя не создаёт. Для сообщений, начинающихся с `/`, вложения не добавляются (чтобы не ломать разбор команды/скилла). Токены `@путь` остаются в тексте как есть — так передаются пути.
- Автоконтекст: открытый файл и выделение активного редактора, файл в воркспейсе и не исключён `files.exclude`/`search.exclude`/`.gitignore` (B3). Когда фокус во вкладке чата (webview), `activeTextEditor` пуст — пока рядом виден текстовый редактор, прежний контекст сохраняется. Выключатели «Открытый файл» / «Выделение» — в меню «+».
- Разметка не менялась; отличия от прототипа, вынужденные живым вводом: поле ввода — `div.typed[contenteditable=plaintext-only]` вместо `span.text` (плейсхолдер — CSS `:empty::before`); оболочка `div.pop` вокруг поля для меню «/» и «@»; кнопка «+» первой в строке настроек (в прототипе кнопки нет, меню «добавить контекст» есть); `@`-токен в тексте не подсвечивается (`.tok` нужен contenteditable с разметкой — plaintext-only его не даёт). Стили чата, которых нет в `hud.css`, — в `media/webview.css` (`hud.css` не тронут).
- Строки ленты: `think` — заголовок с текстом рассуждения в одну строку, клик раскрывает целиком, таймер идёт пока думает; выключатель «extended thinking» в меню effort скрывает think-строки (только показ, на движок не влияет). `sum` — как в прототипе; стоимость — `costUsd` хода. Строка `edit`/`write`: `+N −M` по `structuredPatch` результата, иначе по входу; ссылка `diff` шлёт `diff.open` (пока в журнал, этап 5). У grep/glob число совпадений из `numFiles`; счётчик пройденных тестов (`12 ✓` у bash в прототипе) не делается — нужен разбор вывода тест-раннера, вне этапа. События субагентов (`agentId`) в ленту основного агента не попадают — панель «агенты» этапа 4.
- Заглушки этапов 4–5: значения приборов у поля (число контекста, блоки, кэш, 5ч) — из `fixtures/chat.ts`, как велел промт; панели «ход» и «агенты» показывают пустое состояние (`пока пусто` / строка «основной»), вкладки отключены, пока лента пуста (как в `empty.html`), бейджей нет. Запросы `permission`/`question`/`plan`: хост пишет в журнал и сразу отклоняет (`respondPermission(…, 'deny', текст)`), лента показывает красную системную строку — иначе ход зависал бы до остановки. У владельца правила allow покрывают Read/Edit/Write/Bash, карточек в живом сценарии обычно нет.
- Модель и effort: список моделей — `capabilities().models` (запасной список opus/sonnet/haiku, пока движок не ответил); effort — `effortLevels` выбранной модели, иначе все пять; до первого выбора effort подписан `auto` (движок уровень не сообщает — `init` без `effort`). Значение модели в кнопке — `shortModel(init.model)`.
- Собственные команды «/»: `/clear` — новая сессия, `/compact` — `compact`, `/plan` — `mode.set plan` + системная строка, `/status` — системная строка с моделью, режимом и папкой (аккаунт и вход — боковая панель). Остальные `/команды` и скиллы уходят движку текстом. Скиллы в группе «скиллы проекта» определяются по `init.skills`, поэтому до первого хода все команды движка показываются одной группой.
- Состояние и вкладка: маркер в заголовке вкладки — `● работа`, `? ждёт`, `!` ошибка или лимит (`tabTitle` в `src/agent/status.ts`), название сессии добавляется после `Agentura ·`. `limited` держится до следующего `turn.start`.
- Зависимости: `marked` 18, `dompurify` 3; dev — `jsdom` (тесты DOM: `happy-dom` ломает DOMPurify, не использовать). Бандл чата 227 КБ.
- Проверки: юнит-тесты редьюсера на всех логах пробы (лента из событий маппера), контроллера с поддельным адаптером, DOM-тесты в jsdom (каркас поля ввода, меню «/», «@», история, автоконтекст, режимы) и механическая сверка разметки ленты, пустого экрана и шапки с `chat.html`/`empty.html` по тегам и классам. Живой прогон: контроллер + настоящий адаптер + редьюсер — «прочитай первую строку README.md» на Sonnet 5.5 (ходов 1, около $0.11): лента `user → Read → text → sum`, маркер вкладки `● → пусто`, контекст отделён от текста, `capabilities` пришли. Остановка кнопкой/`Esc` на живом движке не гонялась (тесты: `interrupt` доходит до сессии, прерванный ход закрывает бегущие инструменты).
- Не проверено без F5: автопрокрутка с «прилипанием» (логика в `Chat.tsx`, порог 32 px), вставка текста в `plaintext-only`, вид меню над полем, тема/ширины.

**Решения (2026-10-01, приёмка этапа 3):**
- Этап принят по коду: раскладка, протокол и заглушки — как в решениях сессии 3 выше, отступления осознанные и записаны. Живой сценарий DoD на F5 и сверка с `chat.html` — чеклист владельцу (два открытых чекбокса выше).
- **Склеенные и влитые сообщения.** Маппер этапа 2 умеет два случая, которые лента не видела: движок склеил несколько отправленных сообщений в один ход (`turn.start.prompt` — тексты через пустую строку, у каждого свой блок контекста) и влил сообщение в идущий ход (эхо uuid посреди хода, своего `turn.start` нет). Раньше первое давало «второе сообщение спрятано в контексте первого + строка „в очереди“ навсегда», второе — вечное «в очереди» (а это обычный случай: пишешь, пока агент работает). Исправлено в модели событий: `turn.start.prompts?: string[]` (отдельные тексты, только при склейке) и новое событие `turn.input {prompt, at}` (в `AGENT_EVENT_TYPES`); редьюсер закрывает строку «в очереди» по каждому тексту (`deliverUser` в `chatState.ts`). Отвергнуто: эвристика в webview «снимать очередь на `turn.result`» — не отличает влитое от следующего хода.
- Состояние: `error` с `code: 'api_retry'` (повтор запроса движком) состояние не меняет — иначе «!» во вкладке висел до следующего хода, хотя ход продолжился. Строка в ленте остаётся.
- Мелкое: текст выделения, который не прочитался (файл закрыт/удалён), больше не роняет отправку — сообщение уходит без текста выделения, в журнал warn; выделение с ```` ``` ```` внутри ограждается длиннее (`fenced` в `prompt.ts`); устаревший ответ `files.result` (пришёл не по порядку) не затирает свежий; markdown строки `txt` разбирается только при смене текста (`useMemo`; лента перерисовывается тиком раз в секунду); в пустой сессии вкладка принудительно «чат» (после «new» из «хода»/«агентов» не оставались на отключённой вкладке).

### 4. Приборы

Шапка HUD, панели «ход» и «агенты», системные строки — по экранам `chat`, `limit`.

- [x] Контекст: число и 20 блоков (шкала — окно, но не длиннее «последний порог / 0,75», см. решения приёмки), пороги из настройки, цвета `ok/warn/hot/full`, «сжать» → `/compact`; обновление после каждого `turn.result` и `context.usage` — юнит + DOM-тесты; шкала при 131 250 из 200 000 совпадает с `chat.html` по классам; на живом движке число = `getContextUsage()`; сверка с `/context` в CLI и вид — владелец
- [x] Кэш: таймер до истечения (последний API-ответ + TTL по `tokenSource` и `cache_creation.ephemeral_*`), доля попаданий за сессию — TTL по `ephemeral_*` (на живом подписочном входе пришло `ephemeral_1h` → 1 ч), иначе по `apiKeySource`
- [x] Лимиты: 5 ч и неделя из `src/data/limits.ts`, проценты и время сброса; красный на 100 % — хост шлёт `limits.update` в чат; сверка с `/usage` в CLI — владелец
- [x] Итог хода под ответом: ввод, вывод, кэш ↓↑, стоимость, длительность — сделано в этапе 3 (строка `sum` из `turn.result`, разметка как в `chat.html`); в этапе 4 только сверить стоимость с `result.total_cost_usd`
- [x] Панель «ход»: полоса хода по времени (think / read / edit / run / text) и строки с секундой от начала; предыдущий ход ниже — логика и данные в тестах, вид — владелец
- [x] Панель «агенты»: дерево основной → субагенты → фоновые задачи, статус, токены, кнопка ■ → `stopTask`; итог за сессию (стоимость, ходы, время, кэш-попадания) — дерево и итоги в тестах на логе 05; кнопка ■ на живых субагентах — владелец
- [x] Узкая вкладка: панели как вкладки `чат | ход | агенты` с бейджами; широкая — панель справа (`hud.js` прототипа как эталон поведения) — код готов (бейджи вернул, переключение из этапа 3), проверка ширин — владелец
- [x] Системные строки: компакция (`pre_tokens → totalTokens`), смена режима, ход не начат
- [x] Юнит-тесты: цвет по порогам, таймер кэша, агрегация итогов сессии

**Готово, когда:** после хода число контекста совпадает с `/context` в CLI для той же сессии (±1 %), стоимость — с `result.total_cost_usd`, лимиты — с `/usage` в CLI; `npm test` зелёный.

**Сессия:** sonnet, effort medium; после этапа 3. Промт 4.

**Решения (2026-10-01, по итогам сессии 4):**
- Раскладка. Чистые модули без Preact/DOM, по образцу `chatState.ts`: `src/webview/hudState.ts` (редьюсер `AgentEvent` → `HudState`: контекст, кэш, итоги сессии, таймлайн последних трёх ходов, список агентов; видит события субагентов, которые лента отбрасывает) и `src/webview/hudView.ts` (значения для отрисовки: зона и 20 блоков, таймер кэша, цвет лимита, строки таймлайна, дерево агентов, итоги). Стор: сигналы `hudState`, `limits`, `meters` (computed по событиям и секундному тику); `dispatchEvent` кормит и ленту, и приборы; `session.reset`/`new` сбрасывают оба. `Composer` без пропа `hud` (читает `meters`), `Chat.tsx`/`SidePanes.tsx`/`Hud.tsx` — живые данные и бейджи. Фикстура `fixtures/chat.ts` осталась только как источник типа `Seg` и данных для проверок разметки; в рабочий код приборов не попадает.
- Протокол: `chat.info` получил `contextThresholds?: number[]` (настройка `agentura.contextThresholds` читается при открытии вкладки — смена настройки действует после переоткрытия). Других новых сообщений нет: в чат теперь приходят существующие `limits.update`, а `limits.refresh` и `compact`/`agent.stop` контроллер обрабатывает.
- Хост. `ChatDeps` получил `usage` (обновление лимитов) и `observeLimits`; контроллер шлёт `limits.update` при `ready`, по `limits.refresh`, после каждого `turn.result` и при `limit.update` движка со статусом не `allowed` (кулдаун 60 с — в `UsageService`). `UsageService.onUpdate` — подписка: автоопрос раз в `usagePollMinutes` доходит и до открытого чата. Заодно подключён пропущенный ранее запасной источник: окна из `limit.update` движка теперь идут в `LimitsSource.observeEngine` (в этапе 2 метод был, но не вызывался).
- Контекст. Число — последнее `context.usage` (по ответам `usage`, после хода перекрывается точным `engine`), окно — из события, иначе `turn.result.contextWindow`, иначе 200k. **На подписочном входе окно Sonnet 5.5 — 1 000 000** (живой прогон), поэтому 20 блоков = 50k, а абсолютные пороги 120k/150k попадают на 3-й и 3-й блоки: шкала «зелёная» почти всегда. Это следствие решения «20 блоков = maxTokens/20, пороги абсолютные»; если владельцу не понравится вид на окне 1M — решать на F5 (вариант: блоки по порогам или по автосжатию). Цвет «full» — от `autoCompactThreshold` движка (967k при окне 1M), иначе от конца окна; цвет блока — зона его начала (как в прототипе), метка порога `t` — на блоке, в конце которого лежит порог; частично залитый блок — `--c`/`--w` (ширину заливки добавил в `media/webview.css`, `hud.css` не тронут). После компакции шкала прыгает на `postTokens`. Подпись «порог 150k пройден» рядом с «сжать» — при зоне hot/full.
- Кэш. Таймер — `at` последнего ответа основного агента, в котором были `cache_read`/`cache_creation`, плюс TTL: `ephemeral_1h` → 1 ч, `ephemeral_5m` → 5 мин, если разбивки нет — 1 ч при `apiKeySource: none` (подписка), иначе 5 мин. Ответы субагентов не считаются (у них свой кэш). Доля попаданий — `cache_read / (input + cache_read + cache_creation)`, сумма по `turn.result.usage` основного агента за сессию этого запуска (после resume — только с момента возобновления). Часы — конус `--info` по доле оставшегося TTL, `истёк` — пустой круг как в `limit.html`. Секундный тик теперь идёт, пока есть ход, бегущий агент или живой кэш.
- Лимиты. Цвет — `limits.js` прототипа (`lim-hot` до 70 %, `lim-warn` >70, `lim-full` >85), ячейки — `round(percent/10)`, при 100 % ячейки `on f` и число `full`. Недельное окно: в подсказке 5-часового счётчика всегда (проценты и сброс), отдельным счётчиком `нед` у поля — только при >70 % (отступление от прототипа: там недели у поля нет; всегда показывать — лишняя ширина в узкой вкладке). Недельные окна по модели в HUD не выводятся. Ошибка опроса без окон не стирает показанные проценты.
- Итог хода. `sum` не менялся; стоимость сверена на живом прогоне: `costUsd` хода = разность `result.total_cost_usd` (0.1106 + 0.0078 = 0.1184), итог сессии в панели «агенты» берёт накопленное `total_cost_usd` (с базой при resume).
- Панель «ход»: сегменты think / инструмент / текст с секундой от начала хода; полоса — вес = длительность/100 мс (минимум 1), классы `th/ed/rn/tx` (edit+write, bash, think, текст; read/grep/glob без класса, как в прототипе); `+N −M` у правок и число совпадений у grep — перед временем; текстовые блоки, разорванные инструментами, — отдельные строки «текст ответа». Показан текущий (или последний) и предыдущий ход; хранятся три. Бейдж вкладки «ход» — число строк последнего хода (`live`, пока ход идёт); «агенты» — 1 + число агентов; в пустой сессии бейджей нет.
- Панель «агенты»: плоский список с отступом по глубине (основной → субагент → его фоновая задача через `parentAgentId`); отметки `●`/`○`/`◐`/`✕`/`■`; токены — `totalTokens` из `agent.progress/end`, иначе «—»; ■ у бегущих задач шлёт `agent.stop {taskId}` (контроллер → `stopTask`). Модель субагента не известна (`agent.start` её не несёт) — в подписи вид (`subagentType` или «фоновая задача») вместо модели, как в прототипе (там `sonnet-5.5`) — отступление.
- Системные строки. Компакция — из этапа 3 (`pre → post` токенов). Смена режима: `mode.changed` даёт строку «режим: …» только если режим отличается от уже стоящего в интерфейсе (выбранный самим пользователем не дублируется; смена движком — после одобрения плана — видна). «Ход не начат: <текст лимита> · сброс в HH:MM» — из `error` с кодом `limit` плюс `resetsAt` предыдущего `limit.update` со статусом `rejected` (забывается на `turn.start`); «сообщение сохранено, уйдёт по кнопке» из `limit.html` не делаем — это отложенная отправка этапа 7.
- Проверки. `npm run check` зелёный: 23 файла, 221 тест (до этапа 4 было 179 в 21 файле — новые: `hudState`/`hudView` на логах 01, 05, 06, 09 и синтетике, строки этапа 4 в `chatState`, контроллер с лимитами, `UsageService.onUpdate`, DOM-проверка приборов у поля). Живой прогон (Sonnet 5.5, два хода, ~$0.12): контекст приборов = `getContextUsage()` (36 863 из 1 000 000, автосжатие 967 000), TTL кэша 1 ч из `ephemeral_1h`, попадания 76 %, `limit.update` принёс 5ч 24 % и неделю 41 % с временем сброса, стоимость сошлась. Не делал: подписку `agent.stop` на живой фоновой задаче, бейджи и ширины.
- Не проверено без F5 (владелец): вид шкалы и цветов на окне 1M, часы кэша, счётчики лимитов в светлой/тёмной темах и на 380/700/900 px; переключение вкладок и бейджи в узкой вкладке; панель справа в широкой; сверка числа контекста с `/context` и процентов с `/usage` в CLI на той же сессии; кнопка ■ на живой фоновой задаче; строка «режим: …» после одобрения плана (этап 5).
- Не сделано из прототипа: системная строка «контекст 168k: порог 150k пройден…» в ленте (`chat.html`, с кнопкой «сжать») — порог показан рядом с числом у поля ввода; вынести в ленту можно вместе с состояниями этапа 7.

**Решения приёмки этапа 4 (2026-10-01, ревью Opus):**
- Шкала на окне 1M. Решено не ждать F5: длина шкалы = `min(окно, max(200k, последний порог / 0,75))` (`contextScale` в `hudView.ts`). На окне 200k ничего не меняется (150k — 15-й блок из 20, как в `chat.html`); на окне 1M шкала та же 0–200k, пороги 120k/150k снова на 12-м и 15-м блоках, после 200k все блоки залиты (зона hot), `full` — по-прежнему от `autoCompactThreshold`. Число «N / 1 000 000» — от полного окна, в подсказке «шкала до 200k». Решение «пороги абсолютные» не тронуто: пороги по-прежнему в токенах, шкала подстраивается под них, а не под окно; свои пороги выше (300k/400k) растягивают шкалу (≈534k). Отвергнуто: шкала по `autoCompactThreshold` (967k — та же проблема), блоки неравной длины (ломает разметку `hud.css`). Если на F5 не понравится — одна функция.
- `hudState`: на `session.closed` бегущие задачи становятся `stopped` — иначе секундный тик шёл бы вечно, а ■ слал бы `stopTask` в мёртвый процесс.
- `UsageService.onUpdate`: ошибка подписчика не ломает ответ остальным (try/catch вокруг вызова).
- Отступления исполнителя приняты: недельный счётчик у поля только при >70 %; подпись субагента — вид, а не модель (`agent.start` модель не несёт); строка «порог пройден» в ленту — вместе с состояниями этапа 7; «сообщение сохранено, уйдёт по кнопке» — этап 7. Двойной `limits.update` (ответ на `refresh` контроллера + рассылка `onUpdate`) безвреден, не трогал.

**Второй проход ревью этапа 3 (найдено после 14c444f, исправлено на приёмке этапа 4):**
1. `chatController.ts` `ensureSession`: падение старой сессии после `/clear` затирало `this.session` новой и слало fatal/`session.closed` в ленту → `.catch` проверяет поколение. Тест.
2. `Composer.tsx` «@»: хиты прошлого запроса были видны и вставлялись по Enter/Tab до `files.result` → хиты показываются, только если ответ на то, что набрано сейчас (карта `requestId → query`). DOM-тест.
3. `chatController.ts` `send`: сообщение с выделением (ждёт `readSelection`) обгонялось следующим → очередь `sendQueue`. Тест.
4. `store.ts`: запоздавшие события брошенной сессии (после `session.new`/`session.reset`) попадали в новую ленту → фильтр `abandonedSessionId`, снимается на `session.init` другой сессии. **Этап 6: возобновление той же сессии должно снять фильтр явно.** Тест.
5. `Composer.tsx` `submit`: свои команды (`/status`, `/clear`, …) из истории не сбрасывали позицию истории → сброс в начале `submit`. DOM-тест.
6. `chatController.ts`: `postCapabilities` без `catch` → unhandled rejection → `.catch` с предупреждением в журнал. Тест.
7. `workspaceFiles.ts`: кэш списка и решений «исключён» не сбрасывались → `WorkspaceFiles.watch()` (создание/удаление/переименование файлов, `.gitignore`, `files.exclude`/`search.exclude`), подключён в `chatPanel.ts`. Без теста (нужен vscode); файлы, созданные агентом, по-прежнему видны через TTL 20 с.
8. `chatController.ts` `session.closed`: закрытая сессия возвращалась в live-список строкой ниже → `registeredId` обнуляется, `live.set` пропускается. Тест.
Ложных находок нет.

### 5. Разрешения, вопросы, план, дифф

Карточки `.ask` и переключение режимов — экраны `permission`, `diff`, `plan`. Здесь
нативный дифф через виртуальные документы и семантика решений по плану — суждение неизбежно.

- [x] Карточка разрешения на команду: «Разрешить» (Enter), «Всегда для …» (из `suggestions`, пишет в `.claude/settings.local.json`), «Отклонить» (Esc, deny с сообщением); подпись о месте записи — логика в тестах (`cardsDom.test.ts`, `chatController.test.ts`), «всегда» → правило `Bash(node test.js)` в `.claude/settings.local.json` на живом движке (`permissions-smoke.mjs edit`)
- [x] Карточка вопроса: варианты 1–4, multiSelect, свободный ответ через поле ввода; после ответа — системная строка «выбран вариант N» — тесты `chatState`/`cardsDom`, ответ вариантом на живом движке (`permissions-smoke.mjs ask`)
- [x] Карточка правки: файл, `+N −M`, превью ханка (дифф `old_string`/`new_string` или `content` против файла), «открыть дифф» — `vscode.diff` над `TextDocumentContentProvider` (`agentura-diff:`), «Принять правку», «Принимать правки до конца сессии» (`setMode('acceptEdits')`), «Отклонить» — превью с номерами строк и стороны диффа проверены тестами и живым прогоном (`edit`: «принимать правки» → `mode.changed acceptEdits`, следующие Edit без запроса)
- [x] (владелец, F5) «открыть дифф» и `diff` в ленте открывают нативный дифф в редакторе: подсветка по расширению, левая сторона — до, правая — после, колонка редактора, а не поверх чата
- [x] После применения: ссылка `diff` в строке инструмента открывает дифф из `structuredPatch`/`originalFile` — стороны `appliedSides` на логах пробы и на трёх живых правках
- [x] Карточка плана: заголовок, шаги, файлы; «Выполнять» (default), «Выполнять, принимая правки» (acceptEdits), «Доработать план» (deny с текстом из поля), «Отклонить» — семантика по этапу 0: `refine` → второй `ExitPlanMode` с учётом текста, «Выполнять» → `mode.changed default` и правка карточкой, «Отклонить» → ход `interrupted`, режим plan остался (живой прогон `plan`, `reject`)
- [x] Системная строка режима и итог решения по плану в ленте (B6) — тест на логе 04 и DOM
- [x] Режим bypass в меню доступен только при `agentura.allowBypassPermissions` — меню (`composerDom.test.ts`) и хост игнорирует `mode.set bypassPermissions` без настройки
- [x] Состояние `waiting`: вкладка с маркером, поле ввода с подписью «уйдёт после решения» — «? Agentura» на живом прогоне, подпись — DOM-тест; `waiting` держится, пока открыт хоть один запрос (в т. ч. субагента)
- [x] Тесты: маршрутизация `canUseTool` → тип карточки, построение превью диффа — `chatState.test.ts` (логи 02/03/04), `editDiff.test.ts`, `cardView.test.ts`, `cardsDom.test.ts`
- [x] (владелец, F5) вид карточек `permission`/`diff`/`plan`/вопроса в тёмной и светлой темах и на 380/700/900 px против экранов прототипа; клавиши Enter/Esc/цифры в живом webview

- [x] Проверка карточек разрешений — в проекте без правил `permissions.allow` или smoke с `settingSources: project + local`: у владельца в `~/.claude/settings.json` разрешены `Bash`, `Read`, `Write`, `Edit`…, и с настройками пользователя (дефолт, как в CLI) запросы на них не приходят (этап 2, «Решения») — `node scripts/permissions-smoke.mjs edit|ask|plan|reject` во временной git-папке с `project + local`

**Готово, когда:** сценарий «в режиме manual попроси переименовать функцию и прогнать тесты» даёт карточку правки с работающим нативным диффом и карточку команды; «Всегда» добавляет правило в `.claude/settings.local.json`; сценарий в plan mode заканчивается карточкой плана, «Выполнять» переводит в default и агент правит файлы.

**Сессия:** opus или fable, effort high; после этапа 4. Промт 5.

**Решения (2026-10-01, по итогам сессии 5):**

- Раскладка. Агент: `types.ts` — `PermissionDecision` + `allow-edits`, `PermissionAlways` и поле
  `always` у `permission.request`, `PlanDecision {approve: false, feedback, interrupt?}`;
  `claude/permissions.ts` — `alwaysFrom(suggestions)` (правила в форме настроек `Bash(npm test:*)`,
  место записи, режим, папки), `allow-edits`, отказ плана с `interrupt`; `status.ts` —
  `updatePending` и `nextStatus(prev, e, pending)`. Хост: `editDiff.ts` (чистый: стороны «до/после»,
  превью ханков; библиотека `diff` 9), `diffDocuments.ts` (`agentura-diff:` + `vscode.diff`),
  `chatController.ts` (ответы карточек, `planDecision`, превью, память правок, запрет bypass),
  подключение в `chatPanel.ts`/`extension.ts`. Webview: `chatState.ts` (строки `perm | question |
  plan`, `pending`, чистые действия `markPermission`/`pickOption`/`markPlan`…), `cardView.ts` (подпись
  «всегда», разбор плана), `components/Cards.tsx`, `store.ts` (действия карточек, `replyTarget`),
  `Chat.tsx` (клавиши, строка «ждёт ответа»), `Composer.tsx` (ответ карточке, подпись поля),
  `strings.ts` (`ui.cards`, `ui.reply`, строки итогов; `ui.stubs` удалён), `media/webview.css`
  (markdown плана в карточке, погашенные варианты). Скрипт `scripts/permissions-smoke.mjs` — живой круг
  через `ChatController` во временной git-папке.
- Протокол: хост → webview `diff.preview {sessionId, toolUseId, preview: EditPreview}` (ханки с
  номерами строк, `+N −M`, `hidden`, `isNew`, `note: fragment | too-large`) — приходит вдогонку
  `permission.request`, а не вместо него: чтение файла не задерживает событие, и отмена движком не может
  обогнать карточку. `plan.decide {decision: run | run-edits | refine | reject, feedback?}` вместо
  `approve`. `permission.respond.decision` += `allow-edits`. `permission.request` += `always`.
- Кнопки разрешения: «Разрешить» = allow; «Всегда для `X`» = подсказки движка как есть (у Bash —
  правило → `.claude/settings.local.json`, подпись — из `always.destination`; нет правил, есть папки —
  «Всегда для папки», на сессию); «Отклонить» = deny с `The user declined this tool use.`. Карточка
  правки (Edit/Write с `diff`): «Принять правку» = allow; «Принимать правки до конца сессии» = allow +
  `updatedPermissions [setMode acceptEdits, session]` — атомарно с ответом, той же формой, что проба
  проверила для плана, вместо отдельного `setMode()` (живой прогон: `mode.changed acceptEdits`,
  следующие правки без запроса); отдельной кнопки «всегда» у правки нет — подсказка движка та же.
- Вопрос: один вопрос с одиночным выбором — ответ уходит по клику или цифре; multiSelect и несколько
  вопросов — выбор, затем «Ответить»; последний пункт «Свой вариант» переводит поле ввода в ответ этому
  вопросу (подпись поля меняется, Esc — отмена), multi — метки через «, »; «Отклонить»/Esc — deny.
- План: «Выполнять» = allow + `setMode default`; «Выполнять, принимая правки» = allow + `acceptEdits`;
  «Доработать план» — поле ввода становится ответом плану, Enter шлёт deny с текстом `The user wants
  the plan revised before execution: <текст>`; «Отклонить» = deny с `interrupt: true` (флаг
  `PermissionResult` SDK вместо отдельного `interrupt()`: ход закончился `interrupted`, режим plan
  остался). Заголовок карточки — первый `# …` плана, шаги — нумерованный список секции шагов, файлы —
  пункты секции «Файлы»/«Files»; тело — markdown плана целиком (без заголовка).
- Лента: карточка — строка ленты на месте запроса (после строки инструмента). Разрешение после ответа
  снимается; на его месте строка итога только для «отклонено: `команда`» и «всегда: `Bash(…)` →
  .claude/settings.local.json» — простое «разрешить» видно по строке инструмента. Вопрос и план
  остаются в ленте с тегом итога (кнопки убраны) и строкой под ними: «выбран вариант N» / «выбраны
  варианты 1, 3» / «свой ответ: …» / «план принят · выполняю» / «план на доработку: …» / «план отклонён».
  Смена режима движком — прежняя строка «режим: …» из `mode.changed`. Отмена движком (`abort`) строк не
  даёт. После нажатия кнопки карточка гаснет («ответ отправлен…») до `permission.resolved`.
- Субагенты: их запросы тоже карточки (тег «субагент») — иначе субагент висел бы до конца хода.
  `waiting` считается по всем открытым запросам (`pending`) и в хосте (маркер вкладки), и в webview.
- Клавиши: Esc — отклонить первую ждущую карточку разрешения или вопроса, иначе, как раньше, остановить
  ход; Enter («Разрешить») и цифры 1–9 (вариант вопроса) — только когда фокус не в поле ввода и не на
  кнопке: автофокуса на карточку нет, печатающего человека она не перехватывает. У плана клавиш нет (в
  прототипе нет подсказок, а «Отклонить» останавливает ход). Кнопка stop, пока ждём ответа, — без «· esc».
- Превью: хост читает файл с диска; Edit — `old_string` → `new_string` в тексте файла (первое вхождение
  или все при `replace_all`, без `$`-шаблонов), дифф с контекстом 3, в карточке до 40 строк, остаток —
  «… ещё N строк»; фрагмент не найден или файла нет — дифф самих фрагментов с пометкой; правка длиннее
  20 000 — только счётчики. Нативный дифф: `agentura-diff:/<toolUseId>-proposed|applied/before|after/<имя>`
  (имя в конце — подсветка), заголовок «имя: предложенная правка | правка агента», колонка редактора
  (One, если чат не в One), 40 пар документов в памяти. После применения: `originalFile` +
  `applyPatch(structuredPatch)` (фолбэк — замена `oldString`), Write — `originalFile`/`content`.
  Контроллер помнит 50 последних правок сессии; `/clear` очищает.
- Bypass: меню как было (пункт выключен без настройки) плюс хост игнорирует `mode.set
  bypassPermissions` без `agentura.allowBypassPermissions` (предупреждение в журнал).
- Отступления от промта: `plan.decide` несёт выбор кнопки вместо `approve` + `feedback`; «Принимать
  правки» — через `updatedPermissions`, а не `setMode()`; «Отклонить» план — флаг `interrupt` в ответе, а
  не вызов `interrupt()`; строки инструментов `AskUserQuestion`/`ExitPlanMode` остались в ленте над
  карточкой (`ask <вопрос>`, `plan план готов`) — след для панели «ход». Фикстуры маппера перегенерированы
  (добавилось только поле `always`).
- Живой прогон (sonnet 5.5, `settingSources: project + local`, временные git-папки; итого ≈ $0.25):
  `edit` — превью `@@ -1,4 +1,4 @@`, дифф до/после, «принимать правки» → `acceptEdits`, Bash «всегда» →
  `{"permissions":{"allow":["Bash(node test.js)"]}}`; `ask` — ответ «Синий» дошёл, `tool_use_result.answers`;
  `plan` — доработка дала второй план с `git diff`, «Выполнять» → `default`, Edit пришёл карточкой,
  README дописан; `reject` — ход `interrupted`, режим plan, файл не тронут. Файлы планов в
  `~/.claude/plans/` и транскрипты временных папок удалены.
- Не проверено: вид карточек, темы, ширины и нативное окно диффа в VS Code (`DiffDocuments` без теста —
  F5 владельца); клавиши в живом webview (только jsdom); карточки субагентов на живом движке; «всегда»
  для Bash с записью в файл (`blockedPath` + `addDirectories`, допущение sdk-probe); `stopTask` на
  субагенте переднего плана (допущение sdk-probe — вне чекбоксов этапа); строка «ждёт разрешения» в
  таймлайне панели «ход» (в прототипе есть, в этап не входила); карточки после `resume` (этап 6).

**Приёмка этапа 5 (2026-10-01, ревью в два прохода):** отступления исполнителя приняты (`plan.decide`
с выбором кнопки, `allow-edits` через `updatedPermissions`, `interrupt` в ответе, `diff.preview`
вдогонку, клавиши только вне поля ввода). Исправлено на приёмке:

- `waiting` после ответа на запрос фонового субагента, когда ход основного уже закончился, уходил в
  `working` навсегда (● во вкладке, спиннер, Esc → `interrupt` в пустоту). Теперь `updateInTurn`
  (`agent/status.ts`) помнит, идёт ли ход основного агента, и `nextStatus` возвращает `idle` или
  `working` по нему — в хосте (`ChatController.inTurn`) и в webview (`ChatState.inTurn`).
- «Всегда» не пропускает подсказку `setMode bypassPermissions` (bypass — только меню и
  `agentura.allowBypassPermissions`; движок без `allowDangerouslySkipPermissions` его и так не даст —
  двойная защита). Остальные подсказки уходят как есть, но подпись кнопки теперь называет и папки на
  сессию (`· и папка … до конца сессии`), а не только первое правило.
- Клавиши карточек с Cmd/Ctrl/Alt/Shift не трогают карточку (Cmd+1…9 — группы редактора VS Code,
  раньше выбирали вариант вопроса); Esc вне поля ввода при активном ответе карточке («Свой вариант»,
  «Доработать план») отменяет ответ, а не отклоняет первую карточку. `/команда` в режиме ответа
  карточке — команда, а не текст ответа.
- Превью CRLF-файла: `old_string`/`new_string` с `\n` ищутся и вставляются как `\r\n` (раньше —
  «фрагмент» или смешанные окончания), `\r` из строк карточки убран; заголовок пустой стороны ханка —
  как у `diff -u` (`@@ -0,0 +1,N @@` у нового файла, `-3,0` у вставки); пустой файл + пустой
  `old_string` — запись, а не фрагмент; Write `type: 'update'` с `originalFile: null` (слишком большой
  файл) — не «новый файл», а фрагмент.
- Тест-харнес `cardsDom.test.ts` размонтирует `Chat` между тестами (слушатели `keydown` на window
  копились). Тесты: CRLF/пустой файл/без `\n` в конце, bypass-фильтр и `allow-edits` в брокере,
  модификаторы и Esc при ответе, `updateInTurn`.

Перенесено (не блокирует этап 6): перезагрузка только webview («Reload Webviews», перенос панели в
отдельное окно) теряет ленту и ждущие карточки, а брокер ждёт ответа — выход `/clear` или закрытие
вкладки (этап 6: при `ready` пересылать ждущие `*.request`, см. промт 6); «Принимать правки до конца
сессии» на файле вне рабочих папок не добавляет папку (`addDirectories` из подсказки теряется, следующая
правка там снова спросит) — этап 7; относительный `file_path` читается от cwd процесса, а не сессии
(движок даёт абсолютные пути — не встречалось); у нескольких `addRules` с разными `destination`
подпись называет место первого (движок так не присылал); таймаута у запроса нет намеренно — как в CLI,
ждёт человека до ответа, отмены движком или закрытия сессии (`cancelAll`).

### 6. Сессии, боковая панель, восстановление

Экран `sessions`, восстановление после перезагрузки окна.

- [x] Боковая панель: секция «Аккаунт и лимиты» (`accountInfo()`: email, `subscriptionType`; `rateLimitTier` из credentials; вход через CLI; версия движка из `init.claude_code_version`; полосы лимитов), кнопка `/status` — `AccountService` и вид покрыты тестами, `accountInfo()` + план из учётных данных — живым `scripts/account-smoke.mjs`; вид в VS Code — владелец
- [x] Секция «Сессии»: «Новая сессия» (⌘⇧N), список по дням из `src/data/sessions.ts` (название, ходы, стоимость, токены, статус живой сессии), клик → `resume` во вкладке; поиск отключён с подписью «скоро» — DOM-тест против разметки `sessions.html`, клик → вкладка по `panelRouting`; открытие вкладки в VS Code — владелец
- [x] Попап `sessions` в шапке чата — тот же список коротко, «все сессии в боковой панели», «новая сессия» — DOM-тест
- [x] Название сессии из `summary`/`customTitle`, переименование через `renameSession` по двойному клику (B9 «Заголовки») — `renameSession` и `customTitle` в списке проверены живым `scripts/sessions-smoke.mjs`, двойной клик — DOM-тест
- [x] Восстановление, логика: `resume` с моделью, режимом и базой стоимости из транскрипта, история из `getSessionMessages()` + транскрипта в ленту тем же редьюсером, продолжение в той же сессии — живой `scripts/resume-smoke.mjs` (через настоящий `ChatController`) и `scripts/sessions-smoke.mjs`
- [x] Восстановление в VS Code: `WebviewPanelSerializer` + состояние webview + `workspaceState` (открытые сессии), «Reload Window» возвращает вкладку с историей — код и юнит-тесты есть, самого «Reload Window» не было (владелец)
- [x] Команда «Открыть последний» открывает вкладку последней сессии проекта — код (`extension.ts`: первая строка списка → `ChatPanel.resume`), палитру проверить на F5 (владелец)
- [x] Обновление списка по `fs.watch` папки транскриптов (дебаунс) — тест на настоящем `fs.watch` и на фейковых таймерах

- [x] «Аккаунт и лимиты»: недельные окна по модели (`LimitWindow.kind === 'weekly-model'`, поле `model`) — дополнительной строкой «Неделя · Fable N %» под недельным окном; неактивное окно без `resetsAt` — «0 %» без времени сброса
- [x] Стоимость в списке сессий: `costUsd` нет — «—», `costPartial` — с пометкой «≈ не все модели»
- [x] Сверка глазами на F5 (владелец): вид боковой панели и попапа в светлой и тёмной темах, ширины, строки `live`/`wait`/`err`/`cur`, двойной клик по названию, «Reload Window» с несколькими вкладками, `claude --resume` (состав списка) и `agentmeter tasks` (итоги) руками

**Готово, когда:** «Reload Window» возвращает вкладку с историей и продолжает диалог в той же сессии; список в боковой панели совпадает с `claude --resume` по составу; итоги сессии отличаются от `agentmeter tasks` не более чем на 5 %.

**Сессия:** sonnet, effort medium; после этапа 5. Промт 6.

**Решения (2026-10-01, по итогам сессии 6):**
- Раскладка. Агент: `src/agent/claude/history.ts` (чистая `buildHistory`: сообщения `getSessionMessages()` → `AgentEvent`), `adapter.ts` (+`loadHistory`, `renameSession`), `src/agent/types.ts` (+`SessionHistory`, методы в `AgentAdapter`). Данные: `src/data/transcriptExtras.ts` (то, чего нет в `SessionMessage`, — из `.jsonl`), `sessions.ts` (+`LiveSessions.onChange`, `realpath` в `transcriptPath`), `limits.ts` (+`readPlan`/`parsePlan`). Расширение: `sessionsService.ts` (список + `fs.watch` с дебаунсом), `account.ts`, `sessionMemory.ts` (`workspaceState`), `panelRouting.ts` (какую вкладку занять), `chatPanel.ts` (несколько вкладок, сериализатор), `chatController.ts` (resume, история, пересев), `sidebarView.ts`, `extension.ts`. Webview: `sessionsView.ts` (дни, время, подписи, лимиты), `Sidebar.tsx` (настоящие данные вместо `fixtures/sessions.ts`), попап в `Hud.tsx`, `seedHistory` в `chatState.ts`. Скрипты на живом движке: `scripts/sessions-smoke.mjs`, `scripts/resume-smoke.mjs`, `scripts/account-smoke.mjs`; сверка без движка — `scripts/sessions-verify.mjs`. Фикстуры — `test/fixtures/sessions/` (реальный ответ `getSessionMessages` и урезанный транскрипт сессии Haiku).
- **Протокол.** Хост → webview: `session.history {sessionId, events, skippedTurns, title?, model?, mode?}` (webview сбрасывает ленту и приборы, **снимает `abandonedSessionId`** и прогоняет события тем же редьюсером; незакрытые строки закрываются как прерванные, состояние — `idle`, если ход не открыт), `account.info {email?, plan?, login?, error?, engine?}`, `chat.command {name: 'status'}`; `sessions.update` получил `current` (сессия активной вкладки — строка `cur`) и `project`. Webview → хост: `session.rename`, `status.show`; `session.resume` есть с этапа 3, теперь работает. `SessionSummary.contextTokens` — «131k» в строке. `VsCodeApiLike` получил `setState/getState`. Служебная команда `agentura.openSession <id>` (клик в боковой панели, в палитре её нет) и `agentura.showStatus`; `agentura.resumeSession` — QuickPick по списку; `package.json`: `activationEvents: ["onWebviewPanel:agentura.chat"]` — без него сериализатор не успевает до восстановления панели.
- **Отступление от «одной вкладки на окно»: вкладок несколько, по сессии на вкладку** (`panelRouting.ts`, покрыто тестом). Сессия, уже открытая во вкладке, — показать её, а не поднимать второй движок на один транскрипт; клик из пустой нетронутой вкладки (экран empty, попап) или «Новая сессия» при уже имеющейся пустой — занять/показать её; иначе — новая вкладка рядом с остальными. «Новая сессия» из боковой панели/⌘⇧N больше не сносит идущий диалог открытой вкладки (кнопка `new` в шапке чата по-прежнему сбрасывает свою вкладку). Причина: список с несколькими `live`/`wait` строками (прототип) и «открытые сессии» (plural) в плане иначе бессмысленны.
- **Факт живого прогона: на `resume` `system/init` не приходит до первого сообщения** (ждали 30 с; у новой сессии он идёт сразу, потому что сообщение уже отправлено). Поэтому до первой отправки у webview нет `session.init`: модель, режим и название едут в `session.history`, возможности (`supportedModels/Commands`) работают и без `init` (как у новой сессии), контекст — из `usage`-событий истории, `getContextUsage()` дополнит на первом ходу. Режим `plan` восстанавливается из транскрипта (`permissionMode` на записях `user`; `auto`/`dontAsk` → `default`) и передаётся в опции `resume`; после первого сообщения `init.permissionMode` его подтверждает — проверено живьём (создали в `plan`, возобновили, `init: plan`). Модель — последнего ответа (движок при `resume` берёт её из опций, не из сессии); `bypassPermissions` без настройки → `default`.
- **`SessionMessage` не несёт `tool_use_result`** (проверено), а он нужен «diff» и счётчикам `+N −M`. `transcriptExtras.ts` читает `.jsonl` построчно: результаты инструментов со `structuredPatch`/`originalFile`/`numFiles`/`filenames` (остальное — Bash, Read — не копим), режим, `cost-state`. Хост прогоняет полные события истории через тот же `trackEdit`, что и живые (`tool.start` → `tool.result`), поэтому `diff` в восстановленной истории открывается (живой прогон: правка Edit, `diff.open` после `resume` → `alpha\nbeta` → `alpha\nBETA`); webview получает события без `originalFile`/`content` (`slimHistory`) — файлы целиком остаются у хоста. Нет транскрипта — вкладка остаётся с новой сессией и `session.reset`, причина в журнале.
- **История → события** (`buildHistory`): `turn.start` на каждый промпт, `text.delta`/`tool.start`/`tool.result` (время инструмента — по `timestamp`), `usage.message` и `context.usage` по итоговому usage API-ответа (дедуп по `message.id`, берётся последняя запись — в ней настоящий вывод), **синтезированный `turn.result`** (usage хода, стоимость по `pricing`, время — от промпта до последнего ответа/результата; нет цены модели → без стоимости, не $0), так что строки `sum`, итоги HUD и таймер кэша восстановлены. Пропускаются: субагенты (`parent_tool_use_id`), эхо команд, пустой `thinking` (при `summarized` в транскрипте он пуст), сводка компакции → `compaction.end`, «[Request interrupted…]» → `interrupted`. Синтетический ответ (`<synthetic>`) → `error`. Показываются последние 200 ходов (`skippedTurns` → строка в ленте); итоги HUD при этом только по показанным.
- **База стоимости после `resume`** = `cost-state.totalCostUSD` последней записи транскрипта, нет записи — 0 (исправлено на приёмке: исполнитель брал большее из неё и памяти `workspaceState`). Движок сам продолжает `total_cost_usd` с записи `cost-state`, а маппер считает стоимость хода как «итог − база» — любая другая база занижала бы первый ход после `resume` до нуля. Живая проверка (приёмка): итог до `resume` $0.0311, после хода $0.0354 = $0.0311 + $0.0044 хода. Память стоимости в `workspaceState` убрана. Стоимость в **списке** — по-прежнему оценка парсером Agentmeter + `pricing`, а не `cost-state`: движок считает ещё и побочные вызовы (генерация названия и т. п., ≈2 % сверх транскрипта на коротких сессиях Haiku), которых в транскрипте нет, — для сверки с `agentmeter` нужна та же основа. У сессии, открытой в этом окне, действует `total_cost_usd` движка (как и раньше).
- **Восстановление после «Reload Window».** Сериализатор панели берёт id из состояния webview (`vscode.setState({sessionId})` на `session.init` и `session.history`), запасной путь — первый незанятый id из `workspaceState.openSessions`. Фоновые вкладки (`panel.visible === false`) читают историю сразу, а процесс движка поднимают, когда их впервые покажут (`wake()`), — иначе N вкладок = N процессов CLI при каждом запуске. История шлётся на `ready` webview (или сразу, если `ready` пришёл раньше, чем прочитался транскрипт — гонка поймана живым прогоном и покрыта тестом). Ждущие запросы разрешений после перезагрузки окна не восстанавливаются: процесс движка умер, в истории остаются строки инструментов.
- **Пересоздание одного webview при живом хосте** (панель перенесена в окно, «Reload Webviews»): второй и дальше `ready` — пересев. Хост шлёт `session.history` (из транскрипта, последний ход открыт, если идёт), затем последний `session.init`, `context.usage` движка, название, `turn.start` идущего хода, **ждущие `permission.request`/`question.request`/`plan.request` (хранятся по `toolUseId`, снимаются на `permission.resolved`) и их `diff.preview`** — после истории, чтобы сброс ленты не съел карточки. Ограничение: неполное сообщение, которое движок ещё стримит, в транскрипте нет — оно появится со следующими дельтами обрезанным с начала.
- Список (`SessionsService`): `listSessions()` + итоги + `LiveSessions`, сортировка по времени; `fs.watch` каталога транскриптов с дебаунсом 800 мс и потолком ожидания 4 с (идущий ход пишет файл на каждое сообщение, а итоги — разбор всего файла); каталога ещё нет (первая сессия проекта) — раз в 30 с проверяем, не появился ли; смена статуса живой сессии в реестре тоже пересобирает список. Боковая панель получает все сессии, вкладка чата — первые 8 (попап и экран empty). Название — `customTitle || summary || firstPrompt`; переименование — `renameSession` и немедленное обновление заголовка открытой вкладки (`session.title`). Двойной клик: одиночный клик выполняется через 250 мс (отменяется двойным), иначе каждое переименование сначала открывало бы вкладку. `transcriptPath` теперь пробует `realpath` рабочей папки (CLI называет каталог по реальному пути; `/var` → `/private/var`) — без этого история временной папки не находилась.
- Аккаунт (`AccountService`): `accountInfo()` — временный процесс CLI, кэш 10 минут, ошибка не кэшируется; план — `subscriptionType` (движок отдаёт «Claude Max») + множитель из `rateLimitTier` учётных данных → «Max 5×» (токен не читается и не отдаётся, `readPlan` идёт тем же путём и по той же настройке Keychain, что и опрос лимитов); «Вход» — `через CLI · ок`/`ключ API`; версия движка — из `session.init` ближайшей сессии, запоминается в `workspaceState` (после перезагрузки видна сразу), до первой сессии строка «Агент» без версии. Живой прогон: `Max 5×`, `через CLI · ок`, 0.8 с.
- **Сверка скриптом.** Состав: `scripts/sessions-verify.mjs` — 26 файлов транскриптов в каталоге проекта, 26 строк в списке, не попавших нет. Итоги: токены списка против `agentmeter tasks --json` (его парсер и индекс, `/Users/fost/Projects/Agentmeter`) по 26 сессиям за 30 дней — расхождение 0.00 % у каждой (ожидаемо: основа одна и та же, парсер вендорен; это проверка проводки — дедуп, субагенты, поиск каталога, — а не независимая сверка). `agentmeter tasks` печатает через канал только 64 КБ при `process.exit` — скрипт читает его вывод из файла.
- Живой расход сессии 6: Haiku 4.5, 3 прогона `sessions-smoke` + 2 `resume-smoke` + `account-smoke`, ≈ $0.2 по оценке движка. Каталоги прогонов в `~/.claude/projects` (`…-T-agentura-sessions-*`, `…agentura-resume-*`) скрипты не удаляют — после живых прогонов чистить руками (к приёмке их уже не было, каталог прогона приёмки удалён).
- **Не проверено** (владелец, F5): сам «Reload Window» с вкладками и сериализатором; вид боковой панели, попапа, строк `live/wait/err/cur`, двойной клик, светлая/тёмная тема и ширины; ⌘⇧N из фокуса боковой панели; «Открыть последний» и «Возобновить сессию» из палитры; перенос панели в отдельное окно (пересев); сверка состава списка с настоящим `claude --resume` руками (скриптом проверен только состав каталога транскриптов — основа, на которой, по всей видимости, строится и `claude --resume`; в самом CLI не сверялось); `agentmeter tasks` в самом приложении.
- Промты 7 и 8 поправлены: 7 — как «Повторить ход» опирается на `ChatController.resume`, 8 — `activationEvents`, новые скрипты и фикстуры.
- Проверки: `npm run check` — typecheck, eslint, 338 тестов в 35 файлах (было 271 в 26), сборка зелёная.

**Приёмка (2026-10-01, ревью Opus в два прохода):** этап принят. `npm run check` — 344 теста в 35 файлах, сборка зелёная; живой `scripts/resume-smoke.mjs` на Haiku после правок (≈ $0.04, каталог прогона удалён).
- **Решение «несколько вкладок, по сессии на вкладку» принято.** Причины исполнителя верны: утверждённый прототип (`sessions.html`) показывает одновременно строку `cur live` и строку `wait`, а «открытые сессии» в плане — во множественном числе; одна вкладка на окно сделала бы возобновление из списка разрушительным (сносило бы идущий диалог). Цена: каждая вкладка — свой процесс CLI (память); смягчено тем, что фоновые вкладки после перезагрузки поднимают движок только при показе, открытая сессия не поднимается второй раз, процессы закрываются на выгрузке расширения. `docs/features.md`: «Несколько разговоров параллельно» и «Переименование сессии» переведены в MVP с пометкой «сделано на этапе 6»; несколько **окон** — по-прежнему Потом. Промты 7 и 8 дополнены (`debug.showState` — отдельной вкладкой, «Повторить» и id упавшей сессии, лимит общий на аккаунт, префикс id сессии в журнале, README — процесс на вкладку).
- Исправлено на приёмке:
  - процесс движка после закрытия вкладки: у `ChatController` не было флага `disposed`, хвосты `doResume`/`reseed` после `await loadHistory` поднимали `resumeSession` уже закрытой вкладки — флаг, `dispose()` сдвигает `resumeToken`, `ensureSession` после `dispose` ничего не создаёт (тест);
  - процессы всех вкладок явно закрываются на выгрузке расширения (`ChatPanel.stopEngines()` в `context.subscriptions`; сами вкладки не закрываются — их вернёт сериализатор);
  - окно без папки: `listSessions({dir: ''})` SDK отдаёт сессии **всех** проектов и разбор всех транскриптов на потоке хоста — `SessionsService` при пустом `cwd` отдаёт `[]` (тест);
  - сериализатор мог поднять одну сессию в двух вкладках (запас из `openSessions` у пустой вкладки, `fromState` не сверялся с занятыми) — `restoredSessionId()` в `panelRouting.ts`: своя из состояния, занятая — никакая, запас из памяти — только вкладке, чей webview не запускался ни разу; webview пишет `{}` при старте без сессии и на «новая»/`/clear`/`session.reset` (`forgetSession`), иначе после перезагрузки воскресала брошенная сессия (тесты);
  - база стоимости — см. пункт выше (тест);
  - `SessionsService.refresh()` во время идущего прохода отдавал его (устаревший) результат — терялась последняя запись хода и переименование; теперь — ещё один проход после текущего (тест);
  - слежение: каталог транскриптов ищется и по `realpath` папки (как `transcriptPath`), ошибка `fs.watch` (каталог удалили) закрывает watcher и возвращает поллинг подключения (тест);
  - `numTurns` синтезированного `turn.result` — по API-вызовам хода, а не по записям ассистента (CLI пишет запись на блок);
  - `accountInfo()`: проигравший гонку с таймаутом запрос больше не даёт unhandled rejection;
  - приватность: в фикстурах `test/fixtures/sessions/` домашний путь и id временной папки заменены на синтетику (`/Users/dev/…`); `scripts/sessions-verify.mjs` берёт Agentmeter из `AGENTMETER_DIR` (по умолчанию `~/Projects/Agentmeter`). Реальных данных владельца (email, личные проекты, содержимое сессий) в фикстурах и скриптах нет.
- Известный долг (после 0.1, в «Риски»): каждый пересчёт списка во время хода синхронно перечитывает активный `.jsonl` целиком (итоги + `requestExtras`) на потоке хоста — на сессиях в десятки МБ возможны подвисания раз в ≤4 с (лечится разбором по смещению или пропуском итогов живой сессии, у которой есть `total_cost_usd` движка); `transcriptExtras` держит строки файла в памяти целиком на `resume`/пересеве; пересев при идущем ходе может потерять дельты, пришедшие за время чтения транскрипта (они уходят раньше `session.history` и стираются сбросом ленты) — редкий случай «Reload Webviews» посреди ответа; ход с моделью без цены выпадает из `totalCostUsd` истории без пометки; сессии из worktree попадают в список (`listSessions`), но `resume`/история идут с `cwd` основной папки и не найдут транскрипт (worktree — Потом, B9); синтезированный `turn.result` всегда `ok: true` (ошибка API в истории — отдельной строкой `error`); переименование сессии, у которой идёт ход, может быть перезаписано названием из памяти CLI — не проверялось.

### 7. Состояния, ошибки, лимит, полировка

Экраны `error`, `limit`, светлая тема, доступность, журнал.

- [x] Ошибки движка: `assistant.error` коды и завершение процесса → карточка «Движок остановился» с текстом, «Повторить ход» (повторная отправка последнего промпта в `resume`), «Открыть журнал расширения» — редьюсер и DOM-тест карточки (разметка по `error.html`), `ChatController.retry` и обрыв потока на уровне адаптера (ECONNRESET после первых сообщений) — юнит-тесты; живой обрыв сети — владелец
- [x] Упавший инструмент: строка с красным результатом, раскрываемый вывод — DOM-тест (клик и Enter)
- [x] Лимит исчерпан: `rate_limit_event rejected` или ошибка `rate_limit` → баннер со временем сброса, строка «ход не начат», поле ввода `off` с подписью «отправка отложена до HH:MM» (без автоматики — A14 Потом) — `limitView.test.ts` и DOM-тесты на фикстуре `limited`, в т. ч. блокировка вкладки без своего упора по `limits.update` и самосброс по времени
- [x] Компакция: авто и `/compact`, строка в ленте, индикатор «сжимаю» в HUD — DOM-тест (шкала контекста и строка хода), строка ленты — тесты этапа 4
- [x] Отладочная команда `agentura.debug.showState <empty|working|waiting|error|limited>` — прогоняет фикстуры событий, чтобы владелец сверял состояния с прототипом без живого движка — фикстуры `test/fixtures/states/*.jsonl` проигрываются через `handleHostMessage` в DOM-тестах (`statesDom.test.ts`); сама команда и вкладка — на F5 (владелец)
- [x] Светлая тема: проход по всем состояниям, поправки токенов — токены берут `--vscode-*`, жёстких цветов почти нет (разобрано кодом, см. «Решения»), глазами на F5 (владелец)
- [x] Доступность: фокус клавиатурой по карточкам и меню, aria-роли вкладок и кнопок, `prefers-reduced-motion` — роли/`aria-*`/стрелки в меню и вкладках и CSS проверены DOM-тестами; Tab-обход вживую — владелец
- [x] Журнал: все события адаптера уровнем debug, ошибки — error, команда «Показать журнал» — тест контроллера (уровни, префикс id сессии); команда `agentura.showLogs` переименована в «Показать журнал»
- [x] `docs/features.md`: строки MVP отмечены «сделано» или перенесены с причиной
- [x] Строка «ждёт разрешения» в таймлайне панели «ход» (из приёмки этапа 4) — DOM-тест на фикстуре `waiting`
- [x] «Принимать правки до конца сессии» на файле вне рабочих папок: к `setMode acceptEdits` добавляются `addDirectories` из подсказок движка — юнит-тест и живой `node scripts/permissions-smoke.mjs outside` (вторая правка вне папки без запроса)
- [x] Сверка глазами на F5 (владелец): пять состояний через `Agentura: Показать состояние (отладка)` против галереи прототипа (`error`, `limit`, `empty`, `permission`/`diff`/`plan`), светлая и тёмная темы, ширины 380/900, обрыв Wi-Fi во время хода → карточка и «Повторить»

**Готово, когда:** `agentura.debug.showState` воспроизводит пять состояний, владелец сверил их с галереей прототипа; при обрыве сети (выключить Wi-Fi во время хода) появляется карточка ошибки и «Повторить» продолжает сессию.

**Сессия:** sonnet, effort medium; после этапа 6. Промт 7.

**Решения (2026-10-01, по итогам сессии 7):**
- Раскладка. Протокол: `src/protocol.ts` (+`turn.retry {sessionId}`, `log.show` от webview; хост → webview новых сообщений нет). Хост: `chatController.ts` (повтор хода, журнал, `describeEvent`), `debugStates.ts` (чистое: `STATE_NAMES`, `parseFixture`, `resolveTimes`), `debugStatesData.ts` (импорт `.jsonl` как текста, только для сборки расширения), `debugPanel.ts` (вкладка), `extension.ts` (команда), `chatPanel.ts` (`showLogs`). Агент: `permissions.ts` (`allow-edits` + `addDirectories`). Webview: `chatState.ts` (карточка `fail`, строки `tag: 'limit' | 'retry'`, `markRetrying`), `limitView.ts` (чистая логика блокировки и текстов баннера), `hudState.ts`/`hudView.ts` (`compacting`, `waiting` у инструмента таймлайна), `a11y.ts`, `store.ts` (`limitBlocked`, `retryTurn`, `releaseLimit`, `showLog`), компоненты `Cards.tsx` (`FailCardView`, `ToolOutput`), `Log.tsx`, `Chat.tsx` (баннер), `Composer.tsx`, `Hud.tsx`, `SidePanes.tsx`; CSS — хвост `media/webview.css`. Фикстуры — `test/fixtures/states/{empty,working,waiting,error,limited}.jsonl`, тесты — `statesDom.test.ts`, `limitView.test.ts` и дописки в `chatState.test.ts`, `chatController.test.ts`, `adapter.test.ts`, `mapper.test.ts`.
- **«Повторить ход».** Хост помнит `lastSessionId` (из `session.init` и `resume`) отдельно от `sessionId` — у новой сессии, упавшей до `resume`, `registeredId` после `session.closed` пуст — и последний отправленный, ещё не завершённый успешно промпт (`inflight`: сбрасывается на `turn.result` с `ok` или `interrupted`). `turn.retry` → `resume(lastSessionId)` (движок поднимается заново, лента пересобирается из транскрипта) → `sendNow` того же промпта. Нет промпта (ошибка между ходами) — только возобновление, кнопка тогда подписана «Возобновить сессию» (флаг `turn` на карточке: после последнего `sum` есть сообщение пользователя). Сессия, не дожившая до `init` (CLI не стартовал), — заново `newSession` с тем же промптом. Если транскрипт уже содержит оборванный промпт, в ленте он будет дважды (старый из истории и повторный) — принято: движок сам получит его второй раз, а подтверждать «был ли промпт записан» нечем.
- **Карточка ошибки.** Рисуется на `error` (любой код, кроме `limit` и `api_retry`) и на `session.closed` с `reason: 'error'` (а `exit` — только если ход был открыт; закрытие в покое — тихая строка). `error fatal` и `session.closed` приходят парой — карточка одна. Заголовок: фатальная — «Движок остановился», нефатальная (ошибка ответа при живой сессии) — «Ход не удался». Подсказка про обрыв сети — по regexp на `ECONN*/ENOTFOUND/fetch failed/…` в тексте. Из восстановленной истории карточки не создаются: давняя ошибка из транскрипта становится обычной красной строкой (повторять нечего). `api_retry` — не ошибка: нейтральная строка, подряд идущие попытки схлопываются в одну.
- **Список сессий.** Упавшая сессия остаётся в `LiveSessions` строкой `error`/`limit` после `session.closed` (раньше удалялась) — до «Повторить», возобновления или закрытия вкладки (`stickyLive`).
- **Лимит.** Блокировка (`limitBlock`) = либо своя сессия упёрлась (`status === 'limited'` и сброс не прошёл), либо в `limits.update` есть окно на 100 % с `resetsAt` в будущем — оно приходит во все вкладки, значит блокируются все (лимит общий на аккаунт), отдельной рассылки нет. Блокировка снимается сама по времени сброса (секундный тик крутится, пока она есть); если время сброса неизвестно — баннер даёт «Попробовать снова» (`releaseLimit`: статус → idle + `limits.refresh`). Баннер: заголовок по окну (5 ч / неделя / неделя модели / «подписки»), «Сброс в HH:MM, через N ч MM мин», «Недельное окно свободно на N %»; кнопка «Лимиты» открывает боковую панель. Поле ввода остаётся редактируемым (текст не теряется), отправка и слэш-команды к движку выключены, локальные `/clear`, `/status`, `/plan` работают; подпись «отправка отложена до HH:MM». Строка «ход не начат» одна на упор (`limit.update rejected` и ошибка `limit` склеиваются, причина из ошибки не затирается). **Отступление от прототипа:** карточки «Что можно сделать сейчас» с кнопкой «Отправить в 17:00 автоматически» нет — это A14 «Потом».
- **Компакция.** Строки ленты были с этапа 4; добавлен флаг `compacting` в `HudState` (`compaction.start` → `compaction.end`/`turn.result`/`session.closed`): «сжимаю контекст» у шкалы контекста (спиннер) и в живой строке хода.
- **Таймлайн хода.** У строки инструмента — `waiting` (`permission`/`question`/`plan`) от `*.request` до `permission.resolved`: «ждёт разрешения» / «ждёт ответа» / «ждёт решения», цвет warn/agent, как в `diff.html`/`plan.html`. План и вопрос — тоже `tool_use` в потоке, поэтому находятся по `toolUseId`.
- **Упавший инструмент.** Красная строка (`.e.fail`) с `role=button`, `aria-expanded`, Enter/пробел/клик раскрывают вывод (`ToolOutput`, до 4000 символов, остальное — «обрезано») в карточке `.ask.danger` под строкой, как в `error.html`.
- **`agentura.debug.showState`.** **Отступление от формулировки промта:** вкладка без `ChatController` и без фейкового `AgentAdapter` — отдельная панель `agentura.debugState` (не сериализуется, живые вкладки не трогает) с тем же webview; на `ready` хост шлёт сообщения фикстуры как есть (`chat.info`, `limits.update`, `sessions.update`, `agent.event`, `diff.preview`). Причина: контроллеру с фейковым адаптером нечего делать — события уже готовы, а лишний слой только прятал бы, что именно приходит в webview. Цена: кнопки карточек в этой вкладке ничего не делают (кроме «Открыть журнал»). Время в фикстурах — `{"$now": смещение_мс}` (иначе сброс лимита давно в прошлом и баннер не покажется). Без аргумента — QuickPick. `.jsonl` esbuild подключает загрузчиком `text` (`esbuild.mjs`, `src/vscode-modules.d.ts`) — в `.vsix` отдельные файлы не нужны.
- **Журнал.** Канал один на окно — строки контроллера с префиксом `[первые 8 символов id]` (`[новая]`, пока `session.init` не пришёл); каждое событие адаптера — `debug` одной строкой (`describeEvent`: тип и ключевые поля, без текстов и результатов), `error fatal` и `session.closed {error}` — `error`, повтор запроса — `info`, остальные ошибки — `warn`. Команда `agentura.showLogs` теперь «Показать журнал».
- **Доступность.** Вкладки: `aria-controls`/`id`, roving `tabindex`, стрелки/Home/End (`tabStep`), панели `role=tabpanel`; меню: `role=menu/menuitem`, `aria-haspopup/expanded`, стрелки и Home/End (`menuKeys`), Esc возвращает фокус в поле; «кнопки-спаны» ✕ — `tabindex=0`, `aria-label`, Enter/пробел; лента `role=log`, живая строка `role=status`, карточка ошибки и баннер `role=alert`; `:focus-visible` — 2 px у кнопок карточек, вкладок, меню, чипов; контрастные темы и `forced-colors` — границы. `prefers-reduced-motion` уже глушил все анимации (`tokens.css`). Как и велит приёмка этапа 5, автофокус на карточку не добавлялся.
- **Светлая тема.** Разобрано кодом, не глазами: все цвета токенов берутся из `--vscode-*` (светлая тема VS Code подставляет сама), `data-theme="light"` — только запасные значения для браузера; жёстких цветов в `hud.css`/`webview.css` два `#fff` (точка тумблера и бейдж `live` на синем) — читаются в обеих темах; плашки строятся `color-mix` от `--bg`. Поправок токенов не потребовалось. Реальный вид светлой темы и контраст `--fg-faint` (время, подписи) — владелец.
- **Живой прогон.** Один сценарий — `node scripts/permissions-smoke.mjs outside` (новый): Sonnet 5.5, две правки файлов вне рабочей папки, на первой «принимать правки до конца сессии» → вторая без запроса; ≈ $0.13 за два прогона (первый выявил, что проверка считала и запросы на Read — исправлена на «запросов Edit ровно один»). Каталоги прогонов в `~/.claude/projects` (`…agentura-smoke-outside-*`) удалены, временные — скриптом.
- **Не проверено** (владелец, F5): всё визуальное — пять состояний против галереи прототипа через команду, светлая тема, ширины 380/900, focus-ring и Tab-обход карточек; обрыв Wi-Fi живьём (в тестах — обрыв потока на уровне адаптера и контроллера, но не настоящий ECONNRESET от CLI: какой именно `error`/`result` отдаёт CLI при потере сети, мы не видели — карточка вешается на любой неудачный `error` и на падение процесса); сами команды `debug.showState`/«Показать журнал» из палитры и кнопка «Открыть журнал» в живой вкладке; реальный `rate_limit_event rejected` не воспроизводился (на нём фикстура и юнит-тесты, не живой лимит).
- **`docs/features.md`.** Аудит 63 MVP-строк по коду (субагент, по именам и точкам входа, не вживую) → вместо 63 построчных пометок — раздел «Статус MVP» в начале файла и пометки «сделано на этапе 7» там, где этап что-то добавил. Найдено и закрыто: не было «Автосохранения» — `readText` в `chatPanel.ts` теперь сохраняет несохранённый документ перед превью правки (без теста: `vscode.workspace`; на F5 не проверялось). Перенесено в «Потом»: строка «коммит» из A15 (нужен разбор вывода `git commit`).
- Промт 8 поправлен: команда `debug.showState`, фикстуры в бандле, `permissions-smoke outside`, формулировка про лимит для README.
- Проверки: `npm run check` — typecheck, eslint, 390 тестов в 37 файлах (было 344 в 35), сборка зелёная.

**Приёмка (2026-10-01, ревью Opus, два прохода — свой и независимый на корректность):** принято с правками.
- **«Повторить» на устаревшей карточке рвал идущий ход** (второй проход, major). Нефатальная карточка («Ход не удался») жила `open` вечно; человек отправлял новое сообщение, а потом жал «Повторить» на старой — `resume` убивал процесс посреди хода и слал промпт заново. Починено с двух сторон: в webview карточки ошибки гаснут в красную строку на новом сообщении и на `turn.start` (`retireFails` в `chatState.ts`, тот же путь, что для истории); хост пропускает `turn.retry`, пока идёт ход (`inTurn`). Тесты: `chatState.test.ts`, `chatController.test.ts`.
- **Хост и карточка по-разному решали, слать ли промпт** (второй проход, major). `inflight` сбрасывался только на `ok`/`interrupted`, поэтому после законченного неудачного хода (`ok:false`) и падения в покое «Возобновить сессию» всё равно слала старый промпт. Теперь протокол `turn.retry {sessionId, turn}` — флаг берётся с карточки (`turn` = ход был оборван), промпт уходит только при `turn: true`. `doResume` сбрасывает `inflight` (кроме самого повтора) — промпт прежней сессии не уходит в другую.
- **Лимит по данным подписки мог запереть вкладку на дни.** Блокировка из `limits.update` (не отказ своей сессии) стала «мягкой» (`LimitBlock.soft`): баннер всегда даёт «Попробовать снова», которое снимает её для этого сброса окна (`limitDismissed` в `store.ts`) — данные бывают устаревшими, а с докупленным расходом (extra usage) движок примет и при 100 %; не примет — вернётся «жёсткая» блокировка по его отказу. Недельное окно отдельной модели (`weekly-model`) больше не блокирует все вкладки — другие модели работают. Строка «ход не начат» пишет сброс с днём недели (`resetLabel`, перенесён в `chatState.ts`, `hudView.ts` реэкспортирует).
- **`addDirectories` на «принимать правки до конца сессии»** — подсказка движка берётся как есть (папка файла; живьём — та же папка в двух написаниях `/var/…` и `/private/var/…`), но `destination` принудительно `session`: кнопка обещает «до конца сессии», в `localSettings` ничего не пишется. Живой `permissions-smoke.mjs outside` после правки прошёл ($0.07).
- **Автосохранение перед превью правки — оставлено.** Сохраняется только сам целевой файл правки и только если он грязный (`isDirty`, точное совпадение `fsPath`), чужие документы не трогаются; без этого CLI правит диск, а грязный буфер потом затирает правку при сохранении (так же делает официальное расширение). Известные ограничения: сохранение — при показе карточки, до решения (при «Отклонить» правки человека уже на диске, `formatOnSave` отработал); в `acceptEdits`/`bypass` карточки нет — и сохранения нет; сравнение путей без нормализации регистра (Windows) — Потом.
- Мелочи: клик и Enter по «diff» в красной (раскрываемой) строке инструмента больше не раскрывают её (`Log.tsx`); кнопка «Отправить» при лимите не гаснет, если поле — ответ карточке (Enter и так пропускал).
- **Не чинили, записано:** при оборванном ходе промпт после повтора есть в транскрипте дважды — движок действительно получает его второй раз, лента показывает честно; убрать можно только обрезкой транскрипта (`resumeSessionAt`, форк) — Потом. `inflight` помнит один промпт: сообщение, отправленное во время хода и упавшее отдельным ходом, «Повторить» не повторит (только возобновит). Карточка может остаться в «повторяю…», если хост молча пропустил повтор (двойной клик уже в работе, идёт ход) — после истории или нового события она уходит. Команда `agentura.debug.showState` видна в палитре всем — для 0.1 не мешает; фикстуры в бандле ≈ 20 КБ.
- Проверки после приёмки: `npm run check` — 397 тестов в 37 файлах, `npm run build` зелёный.

### 8. Сборка, тесты, релиз 0.1

- [x] `.vscodeignore`, `vsce package` → `.vsix` меньше 30 МБ (бандленный бинарь SDK — проверить размер; при превышении — `agentura.claudeExecutable` по умолчанию на системный `claude` с проверкой версии). Конкретика с этапа 2: SDK вынесен из бандла (`external`), а текущий `.vscodeignore` начинается с `**` и пропускает только `dist/**`, `media/**` — `node_modules/@anthropic-ai/claude-agent-sdk*` в пакет не попадёт, адаптер не загрузится. Бинарник платформы `@anthropic-ai/claude-agent-sdk-darwin-arm64` — 213–224 МБ: либо `vsce package --target <платформа>` с исключением `!node_modules/@anthropic-ai/claude-agent-sdk/**` и нужного платформенного пакета (и его зависимостей `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`), либо пакет без бинарника и `agentura.claudeExecutable` на системный `claude` — сделано: универсальный `.vsix` без бинарника (5,8 МБ у исполнителя, 5,5 МБ после приёмки — без `dist/scripts`), системный `claude` с проверкой версии, см. «Решения» ниже
- [x] Интеграционный тест `@vscode/test-electron`: активация, команда `agentura.open` создаёт панель, боковая панель регистрируется — `npm run test:integration`, 5 проверок, прошёл на VS Code 1.140.0 (скачивается в `.vscode-test/`)
- [x] `README.md` корня: установка из `.vsix`, требования (Claude Code вход, версия), настройки, известные ограничения (ToS, формат транскриптов)
- [x] `CHANGELOG.md` 0.1.0
- [x] (сделано на 0.2: `.vsix` 0.2.0 установлен, замечания вошли в `04-release-0.2.md`) (владелец) Установка `.vsix` в основной VS Code, день работы на рабочем проекте, список замечаний в `docs/roadmap/03-after-0.1.md` — файл `docs/roadmap/03-after-0.1.md` создан с шаблоном и перенесённым долгом этапов 3–7
- [x] (не ставился — заменён тегом `v0.2.0`) (владелец) Тег `v0.1.0` — после дегустации; Marketplace и GitHub-релиз не делаем

**Готово, когда:** `code --install-extension agentura-0.1.0.vsix` ставится, расширение проходит сценарии этапов 3, 5, 6 в основном VS Code; `git tag -l v0.1.0` отвечает.

**Решения (2026-10-01, по итогам сессии 8):**
- **Бинарник движка: пакет без него, системный `claude`.** Платформенный бинарник 213 МБ (darwin-arm64) не лезет в 30 МБ ни в каком виде (`--target` делает per-platform пакеты по 200+ МБ, а Marketplace/установка из `.vsix` с таким весом — боль). Итог — один универсальный `.vsix` 5,8 МБ (5,5 МБ после приёмки) (`agentura-0.1.0.vsix` в корне, в git не входит: `*.vsix` в `.gitignore`). `.vscodeignore` переписан с белого списка (`**` + `!dist/**`) на чёрный: исключены исходники, тесты, доки, прототип, spikes, `.vscode-test`, карты, `*.d.ts`, `node_modules/@anthropic-ai/claude-agent-sdk-*/**`. Белый список не годился: SDK вынесен из бандла, и ему нужен `node_modules`.
- **Зависимости SDK — явные.** `@anthropic-ai/sdk` 0.130.0, `@modelcontextprotocol/sdk` 1.31.0, `zod` 4.6.5 (peer-зависимости SDK) добавлены в `dependencies`, иначе `vsce` их не упакует. Всё, что esbuild бандлит (`preact`, `@preact/signals`, `diff`, `dompurify`, `marked`), перенесено в `devDependencies` — в пакет не попадает (−10 МБ).
- **Поиск движка** (`src/agent/claude/executable.ts`, юнит-тесты): настройка `agentura.claudeExecutable` → системный `claude` (PATH, `~/.local/bin`, `~/.claude/local`, Homebrew) → ничего (SDK пробует свой бинарник, в `.vsix` его нет — ошибка движка видна в ленте). Найденный путь проверяется `claude --version`; версия ниже `MIN_ENGINE_VERSION` (2.1.285, как у SDK) — предупреждение и строка в журнале, но работаем. Проверка — лениво, при первом запуске движка (не на активации), результат кэшируется по значению настройки; `ClaudeAdapterConfig.executablePath` теперь принимает функцию. Не нашли — предупреждение «Не найден Claude Code…» с подсказкой про `/login` и настройку.
- **Проверка пакета** — `node scripts/vsix-verify.mjs [файл.vsix] [--live]`: распаковывает `.vsix` во временную папку, грузит `dist/extension.js` с заглушкой `vscode`, резолвит SDK и его зависимости из пакета, проверяет отсутствие платформенных бинарников и наличие webview-бандлов; с `--live` — один ход Haiku через SDK из пакета и системный `claude` (прогнан: «ок», $0.031; временные каталоги и записи в `~/.claude/projects` удалены). Сам `activate()` с заглушкой не гоняется — это делает интеграционный тест.
- **Интеграционный тест** (`test/integration/`, `npm run test:integration`): `runTest.ts` качает VS Code в `.vscode-test/`, открывает `test/integration/fixture/` как рабочую папку (без папки `agentura.open` только предупреждает) и запускает расширение с `--disable-extensions` и отдельным `--user-data-dir` — профиль владельца не трогается. Минимальный раннер без mocha (`suite/index.ts`). Проверки: активация, все команды из `package.json` зарегистрированы, вид `agentura.sidebar` зарегистрирован (`agentura.sidebar.focus` существует), `agentura.open` создаёт вкладку `agentura.chat`, повторный `open` не плодит вкладки. Ловушка: из терминала/хоста VS Code в окружении стоит `ELECTRON_RUN_AS_NODE=1`, и Electron отвергает флаги (`bad option`) — `runTest.ts` снимает переменную. Тест вне `npm run check` (качает ≈ 300 МБ); `tsc` для него — отдельный `test/integration/tsconfig.json` (node16), `out/` в `.gitignore` и линтере.
- **Версия** в `package.json` — 0.1.0. Скрипты `package` (`build` + `vsce package --allow-missing-repository --skip-license`; репозитория и лицензии для `UNLICENSED`-пакета нет) и `test:integration`. `@vscode/vsce` 4 и `@vscode/test-electron` 3 — в `devDependencies`. README не использует относительные ссылки (иначе `vsce` требует `repository`).
- **README/CHANGELOG** написаны по промту: установка из `.vsix`, требования (Claude Code 2.1.285+ и вход), настройки, ограничения (ToS, `/api/oauth/usage`, формат транскриптов, оценка стоимости, процесс на вкладку, пересчёт списка), лимит «отправка отложена до сброса, автоотправки нет (A14)»; `debug.showState` — только в «Для разработчиков».
- **`docs/roadmap/03-after-0.1.md`** создан: шаблон строки замечания, непроверенные глазами пункты этапов 1–7 (владелец), долг этапов 3–7 и рисков, упаковка (per-platform со встроенным движком, Windows/Linux, CI).
- **Не делалось (владелец):** установка `.vsix` в основной VS Code и дегустация, тег `v0.1.0`, Marketplace, GitHub-релиз. Открытый вопрос про API-ключ как вход в 0.1 остаётся за владельцем (в 0.1 — только вход CLI).
- Проверки: `npm run check` — 403 теста в 38 файлах, сборка зелёная; `npm run test:integration` — 5/5; `scripts/vsix-verify.mjs --live` — всё ok.

**Приёмка (2026-10-01, ревью Opus, один проход + второй по `executable.ts`/`chatPanel.ts`):** план выполнен, отклонение «пакет без бинарника» — по букве плана (запасной вариант при превышении 30 МБ), принято. Исправлено:
- **`dist/scripts/*.mjs` попадали в `.vsix`** (≈ 1,4 МБ сборок для смоук-скриптов из `scripts/lib/load-ts.mjs`) — добавлено `dist/scripts/**` в `.vscodeignore`; пакет 5,48 МБ, 3159 файлов. Остальной состав проверен `unzip -l`: `dist/extension.js`, `dist/webview/*.js`, `media/`, `package.json`, `readme.md`, `changelog.md` и `node_modules` продакшн-зависимостей (SDK, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` с транзитивными `hono`/`express`/`ajv`…, `zod`); исходников, тестов, фикстур, прототипа, spikes, карт, логов и платформенного бинарника нет.
- **Настройки `agentura.claudeExecutable` и `agentura.allowBypassPermissions` получили `"scope": "machine"`**: иначе `.vscode/settings.json` чужого (доверенного) репозитория мог подставить запускаемый файл — `--version` выполнялся бы при первом ходе — или включить работу без подтверждений. Отвергнуто: проверять путь «на вхождение в воркспейс» — обходится симлинками и не закрывает bypass. В README — сноска.
- **Поиск `claude` пропускает относительные элементы `PATH`** (`.`, `bin`): они резолвятся от cwd хоста. Тест добавлен (404 теста). Запуск `--version` — `execFileSync` без shell, таймаут 5 с: инъекций нет.
- **«Не нашли» больше не кэшируется** (`chatPanel.ts`): поставил `claude` — следующая вкладка подхватит без перезагрузки окна; предупреждение по-прежнему одно на значение настройки.
- **`vsix-verify.mjs`**: кроме `resolve` теперь импортирует SDK, `@anthropic-ai/sdk` и `zod` из распакованного пакета (ловит пропавшую транзитивную зависимость без `--live`); временная папка удаляется, если всё ok.
- Долг (в `03-after-0.1.md`): синхронный поиск на потоке хоста, `claude.cmd` на Windows, поведение без `claude` (ошибка движка после предупреждения), недостающие пункты проверки глазами этапов 6–7 и сценарий установки `.vsix`.
- Проверки на приёмке: `npm run check` — 404 теста в 38 файлах; `npm run package` — 5,48 МБ; `node scripts/vsix-verify.mjs` — всё ok (без `--live`: адаптер на приёмке не менялся); `npm run test:integration` — 5/5 на VS Code 1.140.0.


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

По реальному коду (после приёмки этапа 2, 2026-09-30):
- Адаптер: src/agent/types.ts (AgentAdapter/AgentSession), реализация src/agent/claude/adapter.ts;
  SDK грузится import() и в бандл не входит (external). Хост расширения владеет сессией, в webview
  идут только события протокола `agent.event {sessionId, event}` — webview SDK не импортирует.
- События сверх исходного списка: session.title (название для заголовка), permission.resolved,
  session.closed {reason} — после него поток закрыт, send() возвращает false (показать в ленте
  системной строкой, поле ввода — «сессия завершена, начать новую»).
- turn.start несёт prompt, привязанный по uuid-эху движка; строку пользователя в ленте рисовать
  по turn.start (не оптимистично по отправке) — иначе склеенные движком сообщения задвоятся;
  до turn.start — отправленное сообщение в поле/ленте как «в очереди».
- Шапка — вариант Б (решение под этапом 1): Hud.tsx — вкладки + название сессии (только в широкой)
  + sessions/new; агент — button.agent в строке настроек под полем ввода; число контекста, кэш и 5ч
  у поля ввода — это этап 4, в этапе 3 оставить значения фикстуры.
- Разрешения у владельца покрыты правилами allow в ~/.claude/settings.json (как в CLI) — карточек
  в живом сценарии может не быть, это не баг этапа 3.

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

По реальному коду (после приёмки этапа 3, 2026-10-01):
- Значения приборов у поля ввода сейчас из заглушки: `hud` из src/webview/fixtures/chat.ts
  передаётся в `<Composer hud={hud} />` (Chat.tsx) — блоки, «контекст N / M», кэш, 5ч. Заменить
  живыми сигналами в src/webview/store.ts и убрать импорт фикстуры из Chat.tsx/Composer.tsx
  (`agent` в кнопке — строка 'claude', её оставить константой).
- Состояние чата — чистый редьюсер src/webview/chatState.ts (AgentEvent → строки ленты) + сигнал
  `chat` в store.ts. Агрегаты приборов (контекст, кэш, итоги сессии, таймлайн хода, дерево агентов)
  — отдельные чистые модули рядом по тому же образцу, с юнит-тестами; события приходят в
  `dispatchEvent` (store.ts). Сейчас редьюсер ленты выбрасывает события с `agentId` (кроме
  `agent.*`) — для панели «агенты» их брать до этого фильтра.
- Итог хода (`sum`) уже в ленте с этапа 3. Панели: `TurnPane turns={[]}` и `AgentsPane` с одной
  строкой «основной» (Chat.tsx) и отключённые вкладки при пустой ленте — заменить живыми данными,
  бейджи вкладок вернуть (в Hud.tsx их убрали вместе с фикстурой).
- Хост: src/extension/chatController.ts (без vscode, тесты с поддельным адаптером). Лимиты сейчас
  идут только в боковую панель (`sidebarView.ts` → `limits.update` через UsageService,
  src/extension/usage.ts); в чат их надо слать так же (сообщение `limits.update` уже есть в
  src/protocol.ts), `limits.refresh` из webview контроллер пока игнорирует. Точный контекст —
  `AgentSession.contextUsage()` и событие `context.usage`.
- Протокол этапа 3: `chat.info`, `capabilities`, `editor.context`, `files.*`, `attach.*`,
  `session.reset`, `turn.input` — см. «Решения по итогам сессии 3» и «приёмка этапа 3».

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

По реальному коду (после приёмки этапа 4, 2026-10-01):
- Сейчас запросы — заглушка этапа 3: `chatController.ts` в `onEvent` на `permission.request` /
  `question.request` / `plan.request` пишет в журнал и сразу `respondPermission(…, 'deny', STUB_DENY)`;
  `chatState.ts` рисует на них строку `sys` из `ui.stubs` (`strings.ts`). Обе заглушки убрать;
  `ui.stubs` удалить.
- Протокол (`src/protocol.ts`) уже несёт `permission.respond {toolUseId, decision}`,
  `question.answer {toolUseId, answers}`, `plan.decide {toolUseId, approve}` (без текста доработки —
  контроллер шлёт `feedback: ''`; поле добавить), `diff.open {toolUseId}` (контроллер только пишет в
  журнал), событие `permission.resolved` (снять карточку). Статус `waiting` и маркер «?» во вкладке
  уже идут из `agent/status.ts`.
- Смена режима движком (после одобрения плана) уже даёт строку «режим: …» в ленте (`chatState.ts`,
  `mode.changed` при отличии от текущего) — не дублировать.
- Состояние webview: `store.ts` — сигналы `chat` (лента, `chatState.ts`), `hudState`/`meters` (приборы,
  `hudState.ts`/`hudView.ts`), `limits`; `dispatchEvent` кормит оба редьюсера. Карточки — новые строки
  ленты или отдельный сигнал по тому же образцу (чистый модуль + юнит-тесты); ссылка `diff` у Edit/Write
  в ленте уже шлёт `diff.open`.
- Контроллер: `send` идёт через очередь `sendQueue`; поколение сессии проверяется и в `.catch` —
  ответы на карточки старой сессии после `/clear` отбрасывать тем же `session !== this.current`.

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

По коду этапов 3–4: `store.ts` отбрасывает события брошенной сессии (`abandonedSessionId`, ставится на
`session.new`/`session.reset`, снимается на `session.init` другой сессии) — при возобновлении той же
сессии фильтр снимать явно, иначе её события не дойдут до ленты.

По коду этапа 5: ссылка `diff` в ленте работает, только если контроллер видел `tool.start` (Edit/Write)
и `tool.result` с `originalFile`/`structuredPatch` — история из `getSessionMessages()` должна пройти
через тот же маппинг и `ChatController.onEvent`, иначе `diff` в восстановленной истории ответит
«правка не найдена». Карточки ждущих запросов после Reload не восстанавливаются: процесс движка
умирает вместе с окном, запрос отменён — в истории остаются строки инструментов. Другое дело —
пересоздание одного webview при живом хосте (панель перенесена в отдельное окно, «Reload Webviews»,
восстановление сериализатором без перезапуска): брокер всё ещё ждёт ответа, а лента пуста. Хост должен
хранить последние `permission.request`/`question.request`/`plan.request` по `pending` (и `diff.preview`)
и пересылать их на `ready` вместе с историей — иначе вкладка висит на «?» без карточки (приёмка этапа 5). Состояние `waiting`
строки сессии в списке — из `live` (`ChatController.liveState`), оно уже учитывает запросы субагентов.

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

Уже решено: «Повторить ход» = повторная отправка последнего промпта в resume той же сессии
(механика есть с этапа 6: `ChatController.resume(id)` сносит сессию движка и поднимает `resumeSession` с моделью,
режимом и базой стоимости из транскрипта; но она же шлёт `session.history` и пересобирает ленту из транскрипта —
оборванный ошибкой промпт в нём уже есть; после `resume` вызвать `send` с последним промптом);
лимит исчерпан = баннер + строка «ход не начат» + поле off с подписью, без автоотправки (A14 Потом);
agentura.debug.showState прогоняет фикстуры событий из test/fixtures/states/*.jsonl через тот же
стор, что и живые события (`handleHostMessage`; восстановленная лента — сообщение `session.history`, строка
`err`/`limit` в списке сессий — состояния `error`/`limit` из `LiveSessions`).

По коду этапа 5: состояние `waiting` — это карточки в ленте (`permission.request` / `question.request` /
`plan.request` с полями как в `src/agent/types.ts`, у правки — `diff` и отдельное сообщение хоста
`diff.preview`), фикстура `waiting` должна их содержать. Клавиатура карточек уже есть (`Chat.tsx`:
Esc — отклонить, Enter — разрешить, цифры — вариант, только когда фокус не в поле ввода) — «фокус
клавиатурой по карточкам» = Tab по кнопкам и видимый focus-ring, автофокус на карточку не добавлять
(перехватит печатающего). Строка «ждёт разрешения» в таймлайне панели «ход» (есть на экранах
permission/diff/plan) не сделана — взять сюда. «Принимать правки до конца сессии» на файле вне
рабочих папок шлёт только `setMode acceptEdits` — добавить к ответу `addDirectories` из подсказок движка
(`PermissionBroker.respondPermission`, `allow-edits`), иначе следующая правка там снова спросит.

По коду этапа 6 (приёмка): вкладок чата несколько, по сессии на вкладку (`ChatPanel.panels`, маршрут —
`panelRouting.ts`), каждая — свой `ChatController` и свой процесс CLI. Поэтому: `agentura.debug.showState`
открывает **отдельную** вкладку и не трогает вкладки с живыми сессиями (контроллер без движка — фейковый
`AgentAdapter`, события фикстуры идут в webview как `agent.event`/`session.history`); карточка ошибки и
«Повторить ход» — во вкладке своей сессии; у новой сессии, упавшей до `resume`, `controller.sessionId` после
`session.closed` пуст (`registeredId` снимается) — для «Повторить» запоминать id последней `session.init` отдельно.
Лимит — общий на аккаунт: `limits.update` уже рассылается во все вкладки (`usage.onUpdate` в `chatPanel.ts`),
баннер и поле `off` строить от него и от `limit.update` своей сессии, не плодить отдельную рассылку. Журнал — один
канал на окно: строки контроллера (`session.init`, `ход завершён`, `permission.request`…) сейчас без id сессии —
добавить префикс с первыми 8 символами id, иначе при двух вкладках журнал не читается. Список сессий
перечитывается `SessionsService.refresh()` (повторный проход, если что-то изменилось во время текущего);
строки `err`/`limit` — из `LiveSessions`, которые ставит `ChatController.liveState()`.

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
Сценарии этапа 5 без правок владельца в ~/.claude/settings.json быстро гоняются скриптом
`node scripts/permissions-smoke.mjs edit|ask|plan|reject` (живой движок, ≈ $0.05–0.10 на сценарий);
в `package.json` появился `activationEvents: ["onWebviewPanel:agentura.chat"]` (сериализатор панели, этап 6) — интеграционный
тест может проверить, что после активации панель `agentura.chat` восстанавливается; сценарии этапа 6 на живом движке без VS Code —
`node scripts/resume-smoke.mjs` (Edit + разрешение + `resume` + «diff» в истории), `node scripts/sessions-smoke.mjs`
(список, история, `resume`, `renameSession`), `node scripts/account-smoke.mjs`, сверка состава и итогов —
`node scripts/sessions-verify.mjs` (нужен `/Users/fost/Projects/Agentmeter`); фикстуры `test/fixtures/sessions/` в `.vsix` не входят;
вкладок чата несколько (по сессии на вкладку, этап 6) — каждая держит процесс CLI, в README это ограничение
(память, фоновые вкладки после перезагрузки поднимают движок при первом показе), процессы закрываются на выгрузке
расширения (`ChatPanel.stopEngines`); `sessions-verify.mjs` берёт Agentmeter из `AGENTMETER_DIR`;
новая зависимость `diff` бандлится esbuild в `dist/extension.js` (не external) — в `.vscodeignore` её пропускать не нужно.
Этап 7: появилась команда `agentura.debug.showState` (отладочная вкладка без движка; фикстуры `test/fixtures/states/*.jsonl` esbuild кладёт в `dist/extension.js` загрузчиком `text`, отдельно в `.vsix` их тащить не нужно, а сама команда в README — в разделе для разработчиков, не в «Возможностях»); интеграционный тест может проверить, что команда зарегистрирована; `agentura.showLogs` теперь называется «Показать журнал»; живой сценарий `node scripts/permissions-smoke.mjs outside` (правка вне рабочей папки, ≈ $0.07) дополняет сценарии этапа 5; блокировка отправки при лимите общая на аккаунт и снимается сама по времени сброса (по данным подписки — «мягкая», с кнопкой «Попробовать снова») — в README это пишется как «отправка отложена до сброса, автоматической отправки нет (A14 — после 0.1)»; протокол `turn.retry` несёт `turn: boolean` (приёмка этапа 7).

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
- ~~**`ExitPlanMode` и `canUseTool`.**~~ Закрыто: план приходит в `canUseTool` с `input.plan`
  (этап 0), семантика четырёх кнопок проверена на живом движке (этап 5, «Решения»).
- **Размер `.vsix`.** SDK бандлит нативный бинарь движка; если пакет больше 30 МБ — по умолчанию
  использовать системный `claude` (`pathToClaudeCodeExecutable`) с проверкой версии. Замер этапа 2:
  платформенный бинарник 213–224 МБ (darwin-arm64), сам SDK 5 МБ; `.vscodeignore` с `**` его не
  пропускает — нужен `vsce package --target` на каждую платформу с явным включением
  `node_modules/@anthropic-ai/claude-agent-sdk*` или пакет без бинарника + `agentura.claudeExecutable`.
- **SDK 0.3.x меняется.** Зафиксировать версию в `package.json` точно (без `^`), обновлять
  отдельным коммитом с прогоном фикстур этапа 0.
- **Пересчёт списка сессий на больших транскриптах** (этап 6): во время хода список перечитывает активный `.jsonl` целиком на потоке хоста не реже раза в 4 с — на длинных сессиях возможны подвисания; если владелец заметит на дегустации — разбор по смещению (см. приёмку этапа 6).
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
