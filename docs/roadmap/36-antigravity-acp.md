# 36 — Antigravity на ACP (`agy acp`), актуальная квота и дефолты новой сессии

> Статус: все этапы 1–5 приняты 2026-11-07 · roadmap закрыт. Исполнитель отмечает чекбоксы только по факту проверки.

## Исправления после ревью

- Настройки сессии сохраняются отдельно в `globalState`: `session/load` отдаёт дефолты нового процесса,
  а не прежние модель/effort/режим. Resume использует сохранённые подтверждённые значения с проверкой bypass.
- Вопросы `elicitation/create` берут текст из `title`, с fallback на `description` и ключ.
- Регрессии покрыты кадрами `acp-pong.ndjson` и возобновлением через новый адаптер/процесс.

## Checkpoint

**2026-11-07 · этап 5 принят · roadmap 36 закрыт.**

- Изменено / реализовано:
  - Документация протокола: `docs/antigravity-protocol.md` полностью переписан под контракт `agy acp` (`agy >= 1.5.0`, факт `1.5.3`), описаны транспорт JSON-RPC 2.0 по stdio, жизненный цикл сессии, маппинг инструментов oneharness/cortex, разрешения `session/request_permission`, вопросы `elicitation/create`, каталог моделей/effort, квота 5 окон `/usage` и история `session/list` / `session/load`.
  - README проекта: обновлены разделы Antigravity в `README.md` (EN) и `README.ru.md` (RU) — зафиксированы требования `agy >= 1.5.0`, запуск `agy acp`, живые разрешения и diff, поддержка картинок, режимы `default` / `accept-edits` / `plan`, дефолты модели/effort в настройках новой сессии, вход `agy acp --login`. Чужой WIP (Codex launch records) сохранён.
  - Уборка хвостов: удалён устаревший файл `docs/roadmap/16-antigravity-support.pending.md` (исторический `docs/roadmap/16-antigravity-support.md` сохранён).
- Приёмка основным чатом:
  - `TZ=UTC npm run check`: зелёный (typecheck 0 ошибок, lint 0 ошибок, 161 test files / 2311 tests pass, esbuild build OK).
  - `npm run test:integration`: 8 тестов интеграции VS Code pass, код возврата 0.
  - `node scripts/agy-smoke.mjs`: код 0, 4.2s (session.init, 5 моделей, тариф "Google AI Pro", штатное закрытие).
  - `git diff --check`: пусто (код возврата 0, пробельных ошибок и маркеров конфликта нет).
- Ветка/worktree: `main` в `/Users/fost/Projects/Agentura`, коммитов и push нет.
- Исполнитель: субагент `self` (`811baa18-4c7b-4ebc-97d4-aaa456479f19`), модель Gemini 3.8 Flash (High), чистый контекст. Основной чат: Antigravity (AGY), модель Gemini 3.8 Flash (High). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Roadmap полностью выполнен.

**2026-11-07 · этап 4 принят.**

- Изменено / реализовано:
  - Квота `/usage` (`1.5.3`): `src/agent/antigravity/quota.ts` (парсинг 5 строк: Gemini 5ч/7д, Claude/GPT 5ч/7д, Argon 7д с обратной совместимостью со старым выводом, выделение `window: 'fiveHour' | 'weekly'`). `EngineLimits.tsx` устраняет дубли `key`, `Table` чисто рендерит 5 окон рядами по 3 колонки (`.nm.cont`). `hudView.ts` группирует кольца по 3 семействам (Gemini, Claude/GPT, Argon) с выбором лимитирующего окна и точным тултипом окна (`5ч` vs `неделя`).
  - Вход: в `sidebarView.ts` команда терминала переключена на `agy acp --login`.
  - Настройки новой сессии: добавлены `agentura.antigravity.defaultModel` и `defaultEffort` в `src/settings.ts`, `package.json` + `package.nls*.json`, `src/protocol.ts`. `models.ts` парсит живой каталог `loadAntigravityCatalog` (5 базовых моделей, effortLevels). `settingsController.ts`, `settingsStore.ts` и `Settings.tsx` (`⚙ → Новая сессия`) заменяют заглушку `agyNote` на живой пикер модели с fallback-вводом и селектор effort (`По умолчанию CLI`, `low`, `medium`, `high`).
  - Прокидка дефолтов: `chatPanel.ts` / `chatController.ts` передают дефолты только в `createSession` новой беседы; `resumeSession` модель не затирает. `toolView.ts` (`shortModel`) сокращает ID моделей Antigravity (`argon-4`, `flash-3.8`, `sonnet-5.5`, `opus-5.5`, `gpt-oss-120b`).
  - Чужой WIP (TaskPicker) в `protocol.ts`, `chatPanel.ts`, `sidebarView.ts`, `strings*.ts` сохранён без изменений.
- Приёмка основным чатом:
  - `TZ=UTC npm run check`: зелёный (typecheck 0 ошибок, lint 0 ошибок, 161 test files / 2311 tests pass, esbuild build OK).
  - Целевые тесты: `quota.test.ts` (7), `agyQuota.test.ts` (5), `engineLimits.test.ts` (5), `engineLimitsView.test.ts` (13), `hudView.test.ts` (22), `models.test.ts` (3), `settingsController.test.ts` (22), `toolView.test.ts` (24), `settings.test.ts` (36), `protocol.test.ts` (12), `settingsDom.test.ts` (43) — все pass.
  - `node scripts/agy-smoke.mjs`: код 0, 4.9s (init, 5 моделей, тариф "Google AI Pro", закрытие).
- Ветка/worktree: `main` в `/Users/fost/Projects/Agentura`, коммитов и push нет.
- Исполнитель: субагент `self` (`2ce3a158-b5b7-4c95-a5a0-c298165c3a63`), модель Gemini 3.8 Flash (High), чистый контекст. Основной чат: Antigravity (AGY), модель Gemini 3.8 Flash (High). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 5 (документация, README.md / README.ru.md, удаление `16-antigravity-support.pending.md`, интеграционные тесты и ручной чеклист).

**2026-11-07 · этап 3 принят.**

- Изменено / реализовано:
  - Инструменты и диффы: `src/agent/antigravity/tools.ts` и `acpMapper.ts` поддерживают oneharness-имена `1.5.3` (`read_file`, `write_file`, `edit_file`, `run_command`, `search_web`, `ask_question`) + старые cortex-имена. Диффы правок для вкладки `changes` строятся прямо из ACP `content[type="diff"]` без чтения `~/.gemini` и `transcript_full.jsonl`. Код ошибки учитывает `rawOutput.exit_code !== 0`.
  - Разрешения и вопросы: `session/request_permission` маппится в `permission.request` (с превью `diff` для правок), ответы `allow`/`allow-edits`/`deny`, автоответ при `bypassPermissions` (`allowBypassPermissions: true`), сброс висящих запросов при `interrupt()`/`dispose()`. Вопросы `ask_question` маппятся в `question.request` и `answerQuestion` через `elicitation/create`. `ANTIGRAVITY_FEATURES`: `modes: true, images: true, questions: true, plan: false, files: false, context: false, cost: false, subagents: false`.
  - История и сессии: `listSessions` (`session/list` с `realpath`-фильтрацией `matchesCwd` + пользовательские имена из `sessionIndex.nameOf`), `loadHistory` (`session/load` реплеит инструменты парой `tool.start` + `tool.result`), `renameSession` (`sessionIndex.rename`). `sessionIndex.ts` ужат до хранения только `agentura.antigravity.names`.
  - Полный снос legacy: удалены `process.ts`, `storage.ts`, `edits.ts`, `patch.ts`, `fakeAgy.ts`, старый `protocol.ts`, `mapper.ts` и их тесты (`process.test.ts`, `history.test.ts`, `patch.test.ts`, `protocol.test.ts`, `storage.test.ts`, `sessions.test.ts`, `edits.test.ts`, `mapper.test.ts`). Вычищен контур `agy.retry`/`agy.retryRejected` и карточка `refusal` из `protocol.ts`, `chatController.ts`, `chatState.ts`, `store.ts`, `turnView.ts`, `Cards.tsx`, `Log.tsx`, `strings*.ts`.
  - Сохранность чужого WIP: TaskPicker в `src/protocol.ts`, `chatPanel.ts`, `sidebarView.ts`, `strings*.ts` сохранён полностью.
- Приёмка основным чатом:
  - `rg -n "node:sqlite|conversation_summaries|transcript_full|agy\.retry|addRefusal|kind: 'refusal'" src/`: пусто (код возврата 1).
  - `TZ=UTC npm run check`: зелёный (typecheck 0 ошибок, lint 0 ошибок, 161 test files / 2304 tests pass, esbuild build OK).
  - `npx vitest run src/agent/acp src/agent/cursor src/agent/antigravity`: 14 test files / 125 tests pass (0 failed).
  - `node scripts/agy-smoke.mjs`: код 0, 4.4s (session.init, 5 моделей, тариф "Google AI Pro", штатное закрытие, без висящих процессов).
- Ветка/worktree: `main` в `/Users/fost/Projects/Agentura`, коммитов и push нет.
- Исполнитель: субагент `self` (`e44aa610-36e6-446a-b40a-6d24cfd9ace2`), модель Gemini 3.8 Flash (High), чистый контекст. Основной чат: Antigravity (AGY), модель Gemini 3.8 Flash (High). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 4 (квота `/usage` 1.5.3, вход `agy acp --login` и настройки новой сессии в `⚙ → Новая сессия`).

**2026-11-07 · этап 2 принят.**

- Изменено:
  - Созданы новые ACP-модули: `src/agent/acp/client.ts`, `src/agent/acp/client.test.ts`, `src/agent/antigravity/acpProtocol.ts`, `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/acpMapper.test.ts`, `src/agent/antigravity/fakeServer.ts`.
  - Модифицированы: `src/agent/cursor/client.ts` (обёртка над `src/agent/acp/client.ts`), `src/agent/antigravity/executable.ts` и `executable.test.ts` (проверка `agy >= 1.5.0`), `src/agent/antigravity/adapter.ts` (ядро сессии на ACP), `src/agent/antigravity/adapter.test.ts` (ACP-тесты), `scripts/agy-smoke.mjs`.
  - Удалены устаревшие stream-json тесты: `src/agent/antigravity/edits.test.ts`, `src/agent/antigravity/sessions.test.ts`.
  - Чужой WIP (`src/protocol.ts`, `src/extension/chatPanel.ts`, `src/extension/sidebarView.ts`, `src/webview/strings*.ts`, `prototype/*`, `src/agent/codex/*`) не затронут.
- Приёмка основным чатом:
  - `TZ=UTC npm run check`: зелёный (typecheck 0 ошибок, lint 0 ошибок, 165 test files / 2359 tests pass, esbuild build OK).
  - `npx vitest run src/agent/acp src/agent/cursor src/agent/antigravity`: 19 test files / 172 tests pass (0 failed).
  - `node scripts/agy-smoke.mjs`: код 0, 4.2s (session.init, 5 моделей, тариф "Google AI Pro", штатное закрытие, без висящих процессов).
- Ветка/worktree: `main` в `/Users/fost/Projects/Agentura`, коммитов и push нет.
- Исполнитель: субагент `self` (`7233eb37-896d-4757-9289-59339564b66a`), модель Gemini 3.8 Flash (High), чистый контекст. Основной чат: Antigravity (AGY), модель Gemini 3.8 Flash (High). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 3 (инструменты, диффы правок, живые разрешения, история `session/list` + `session/load`, снос legacy stream-json/refusal).

**2026-11-07 · этап 1 принят.**

- Изменено (только новые файлы): `docs/spikes/antigravity-acp/report.md` (последняя строка `go`), `test/fixtures/antigravity/acp-pong.ndjson` (267 строк). `src/`, `package.json`, `README*` не тронуты.
- Приёмка основным чатом: `tail -n 1` отчёта = `go`; `JSON.parse` по всем 267 строкам фикстуры без ошибок; `rg -n "Bearer|api_key|apiKey|ya29\.|AIza|@gmail|/Users/|fost"` по фикстуре и спайку пусто; `/tmp/agy-acp-spike*` отсутствует; `git status` — из нового только спайк-артефакты и этот roadmap. Отчёт сверен с кадрами фикстуры (id разрешений, `usage`, `elicitation/create`, реплей `session/load`).
- Ветка/worktree: `main` в `/Users/fost/Projects/Agentura` (`HEAD` `8e69e15`), отдельный worktree не заводился. Дерево грязное из-за чужого WIP (roadmaps 31–35, `src/agent/codex`, `taskPicker`, `README*`, `strings*`), коммитов и push нет.
- Исполнитель: субагент `self` (`901b5234-a682-47bc-8d69-eb2cbdace359`), runtime-модель unknown. Основной чат: Antigravity (AGY), модель/effort unknown. `cwd` подтверждён командой `pwd` = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 2 новым субагентом. Он правит `src/agent/cursor/client.ts`, `src/agent/antigravity/*` и тесты, так что файлы чужого WIP (`src/protocol.ts`, `chatPanel.ts`, `strings*`) остаются нетронутыми.

### Решения по итогам спайка (обязательны для этапов 2–5)

Контракт — `docs/spikes/antigravity-acp/report.md`, где он расходится с черновиком выше, прав отчёт:

- Входящие серверные запросы (`session/request_permission`, `elicitation/create`) приходят со **строковым** `id` (`"1"`, `"2"`). `AcpRpcClient` обязан хранить `RpcId = string | number`, а проверять наличие `id`, не truthiness.
- Опции разрешения: `allow` (`kind: allow_once`) и `deny` (`kind: reject_once`); `allow_always` нет. Автоотказ ищет опцию по `kind === "reject_once"`, фолбэк `"deny"`. Ответ: `{ outcome: { outcome: "selected", optionId } }`.
- `initialize` объявляет `clientCapabilities.elicitation: { form: {} }`: без этого `ask_question` повисает до следующего `session/prompt` и перехватывает его как текстовый ответ. До этапа 3 на `elicitation/create` автоответ `{ action: "decline" }`; на этапе 3 — `question.request`, флаг `questions: true`.
- `plan` нативного нет (`create_plan` и `sessionUpdate: plan` не приходят) → `plan: false`. `images: true`, `files: false`, `modes: true`.
- `session/prompt` возвращает реальные токены: `usage { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens }`. `inputTokens` уже без кэша (повторно кэш не вычитать), `thoughtTokens` входит в `outputTokens`. `turn.result.usage` заполняем, `usageKnown: true`; `context: false`, `cost: false`.
- `model` + `thought_level`: при `gpt-oss-120b-medium` селект `thought_level` исчезает, а `set_config_option thought_level` даёт `-32602`. Адаптер хранит желаемый `effort` и шлёт его, только если уровень есть в актуальных `configOptions`; после возврата на модель с уровнями досылает снова. Режим меняется через `session/set_mode`.
- Инструменты `1.5.3`: `read_file`, `write_file`, `edit_file`, `run_command`, `search_web`, `ask_question` (плюс старые `cortex`-имена для совместимости). Ненулевой `exit_code` приходит со `status: "completed"` и `rawOutput.exit_code`, поэтому `isError` = `status === "failed"` или `exit_code !== 0`. Дифф правок лежит в `content[type="diff"]`, у нового файла `oldText` нет.
- `session/load` реплеит `tool_call` сразу в финальном статусе, без `tool_call_update`: маппер истории эмитит `tool.start` и `tool.result` парой. Живой `user_message_chunk`-эхо игнорируется. `session/resume` без реплея; `load` и `resume` не восстанавливают `model` / `thought_level` / `mode`, `resumeSession` применяет их явно.
- `session/cancel` — уведомление, висящий permission сервер снимает сам, `stopReason: "cancelled"`, процесс жив. Закрытие `stdin` завершает процесс с кодом `0` за 0.3–0.5 с и сохраняет беседу.
- Не проверено живьём: текстовые `agent_thought_chunk` (тип поддержан схемой, на `gemini-3.8-flash` не стримились), Windows, протухший OAuth посреди хода.

## Цель

Перевести провайдер `antigravity` со старого headless-стрима (`agy -p= --input-format stream-json --output-format stream-json`) и прямого чтения `~/.gemini/antigravity-cli` (`conversation_summaries.db`, `transcript_full.jsonl`) на штатный протокол `agy acp` (`agy >= 1.5.0`, эталон `1.5.3`). Вкладка Antigravity получает живые карточки разрешений без перезапуска процесса и без суррогатных карточек `refusal`, отправку картинок, раздельный выбор модели и `effort` (`thought_level`), нативные режимы `default` / `accept-edits` / `plan`, настройки новой сессии в `⚙ → Новая сессия`, терминальный вход `agy acp --login` и корректный разбор 5-оконной квоты `agy -p "/usage"`. Claude, Codex и Cursor не меняют поведения; в `~/.gemini` ничего не пишется и не читается в обход CLI.

## Контекст и ограничения

### Подтверждённые факты (`agy 1.5.3`, проверено по коду и нулевым handshake 2026-11-07)

- На машине установлен `/Users/fost/.local/bin/agy` версии `1.5.3`. `agy acp` поднимает JSON-RPC 2.0 (`"jsonrpc": "2.0"`) поверх stdio (один JSON на строку).
- `initialize` (`protocolVersion: 1`) возвращает:
  - `agentInfo: { name: "Antigravity ACP Server", version: "1.5.3" }`;
  - `agentCapabilities`: `loadSession: true`, `promptCapabilities: { image: true, audio: false, embeddedContext: true }`, `sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }`, `auth: { logout: {} }`, `_meta.antigravity: { tier: true, systemPrompt: { append: true } }`;
  - `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`. Флаг `agy acp --login` выполняет интерактивный вход в терминале и штатно завершается.
- `session/new` `{ cwd, mcpServers: [] }` возвращает:
  - `sessionId` (UUID);
  - `models`: `currentModelId: "gemini-4-argon-medium"` и 13 комбинированных `availableModels` (`gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`);
  - `modes`: `currentModeId: "default"`, `availableModes`: `default`, `accept-edits`, `plan` (в отличие от Cursor ACP, `accept-edits` поддержан сервером отдельно от `default`);
  - `configOptions` — три независимых селекта: `model` (`gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`), `thought_level` (`low`, `medium`, `high`), `mode` (`default`, `accept-edits`, `plan`);
  - `_meta.antigravity.tier` (`{ name: "Google AI Pro", id: "g1-pro-tier", upgradeUri }`) — готовый источник `AccountInfo.plan`.
- `session/list` `{ cwd }` возвращает `{ sessions: [{ sessionId, cwd, title, updatedAt }] }` с человекочитаемым `title`, но отдаёт беседы всех каталогов — фильтрацию по `cwd` (с учётом `realpath`) обязан делать адаптер.
- По `agy changelog` (`1.5.0`–`1.5.3`): `session/resume` открывает существующую беседу без реплея истории (в отличие от `session/load`), `1.5.1` отдаёт все модели аккаунта ACP-клиентам и чинит `session/cancel` с висящими разрешениями, `1.5.3` гарантирует сохранение беседы при штатном закрытии `stdin`.
- `agy -p "/usage"` в `1.5.3` печатает 5 TSV-строк: `Gemini Models` (`Weekly Limit Remaining` и `Five Hour Limit Remaining`), `Claude and GPT models` (`Weekly` и `Five Hour`), `Gemini 4 Argon` (`Gemini 4 Argon Weekly Limit`). Текущий `shortLabel` в `src/agent/antigravity/quota.ts:14` схлопывает `/gemini/i` → `'Gemini'` и игнорирует тип окна (`5h` vs `7d`), из-за чего дублируются Preact-ключи `key={w.label}` в `src/webview/components/EngineLimits.tsx:116`, режется пятая строка в `Table` (`[0, 1, 2]` в `EngineLimits.tsx:209`), а тултип в `src/webview/hudView.ts:278` подписывает 5-часовые окна как недельные.
- Контур `agy.retry` / `agy.retryRejected` и webview-карточка `refusal` созданы только под `stream-json`-отказы Antigravity и другими движками не используются.

### Допущения и вопросы спайка (закрывает этап 1 до правок `src/`)

- Живые кадры `session/update`: точная форма `agent_message_chunk`, `agent_thought_chunk` (есть ли текст рассуждений для `thinking.*`), `tool_call` / `tool_call_update` (имена инструментов, входные параметры, диффы правок файлов, ошибки), `session_info_update` и финальный `stopReason`; приходят ли в ACP токены/usage или счётчик хода отсутствует (как у Cursor ACP).
- Живая форма `session/request_permission`: тип `id` (включая `0`), список `options` (`allow-once`, `allow-always`, `reject-once` или иные `optionId`), поведение при `session/cancel`; приходят ли через ACP вопросы агента (`ask_question`) или согласование плана (`plan`).
- Связка `session/set_config_option` (`model` + `thought_level`) и `session/set_mode`: как сервер реагирует на выбор `thought_level` при активной `gpt-oss-120b-medium` (у которой нет `low`/`high`) и что возвращается в ответ.
- Формат блока картинки (`{ type: "image", data, mimeType }` или иной) и текстового контекста в `session/prompt`.
- Практическая разница `session/resume` и `session/load` на сохранённой беседе: какие кадры реплеит `session/load` и сохраняется ли выбранная модель беседы.

### Принятые решения

- Минимальная версия CLI — `agy >= 1.5.0`: проверяется в `src/agent/antigravity/executable.ts`. При версии `< 1.5.0` возвращается понятная `problem` с требованием обновить `agy`; запасной ветки `stream-json` не оставляем.
- Транспорт `CursorRpcClient` из `src/agent/cursor/client.ts` выносится в общий `src/agent/acp/client.ts` (`AcpRpcClient` с настраиваемой меткой движка для ошибок). `src/agent/cursor/client.ts` становится тонкой обёрткой/реэкспортом без изменения поведения `CursorAdapter`.
- Один живой процесс `agy acp` на открытую вкладку сессии (очередь ходов на стороне сессии, `interrupt` через уведомление `session/cancel` без убийства дерева процессов, `dispose`: `stdin.end()` → ожидание grace для сохранения беседы в `1.5.3` → `SIGTERM` → `SIGKILL`). Вспомогательные вызовы вне вкладки (`listSessions`, `loadHistory`, холодный `capabilities`/`accountInfo`) открывают краткоживущий `agy acp` и штатно закрывают его после ответа.
- Прямое чтение `~/.gemini/antigravity-cli` (`storage.ts`, `edits.ts`, `patch.ts`, `node:sqlite`) и запасной индекс `agentura.antigravity.sessions` удаляются. В `src/agent/antigravity/sessionIndex.ts` остаётся только карта пользовательских переименований `agentura.antigravity.names` поверх `title` из `session/list`.
- Режимы Agentura → `agy acp`: `default` → `default`, `acceptEdits` → `accept-edits`, `plan` → `plan`; `bypassPermissions` при `allowBypassPermissions: true` переводит сервер в `accept-edits` (или `default`) и автоотвечает одноразовым разрешением без карточки, а без `allowBypassPermissions` остаётся `default`. Флаг `--yolo` в `agy acp` не передаём никогда.
- Весь legacy-контур `stream-json` и `refusal` (`agy.retry`, `agy.retryRejected`, `kind: 'refusal'`) удаляется на этапе 3. Новые варианты `AgentEvent` не добавляем.

### Точки входа в коде

- Общий ACP и эталон Cursor: `src/agent/cursor/client.ts:56`, `src/agent/cursor/protocol.ts:136`, `src/agent/cursor/mapper.ts:18`, `src/agent/cursor/history.ts:31`, `src/agent/cursor/adapter.ts:82`.
- Текущий Antigravity: `src/agent/antigravity/executable.ts:60`, `src/agent/antigravity/adapter.ts:122`, `src/agent/antigravity/models.ts:8`, `src/agent/antigravity/tools.ts:30`, `src/agent/antigravity/sessionIndex.ts:46`.
- Удаляемый legacy-слой: `src/agent/antigravity/{process,protocol,mapper,storage,edits,patch,history,fakeAgy}.ts`, `src/protocol.ts:280,498,670,739`, `src/extension/chatController.ts:31,1013-1027`, `src/webview/chatState.ts:101,290-315`, `src/webview/store.ts:57,413,675-684,1166`, `src/webview/turnView.ts:79`, `src/webview/components/Log.tsx:661`, `src/webview/components/Cards.tsx:250-285`, `src/webview/strings.ts:500`, `src/webview/strings.en.ts:494`.
- Флаги возможностей: `src/agent/features.ts:110` (`ANTIGRAVITY_FEATURES`).
- Квота `/usage` и вход: `src/agent/antigravity/quota.ts:14,27`, `src/extension/agyQuota.ts:16`, `src/extension/engineLimits.ts:29`, `src/webview/hudView.ts:278`, `src/webview/engineLimitsView.ts:71`, `src/webview/components/EngineLimits.tsx:111,209`, `src/webview/components/Composer.tsx:1874`, `src/extension/sidebarView.ts:242`.
- Настройки новой сессии и короткие имена моделей: `src/settings.ts:174`, `package.json:368`, `package.nls.json`, `package.nls.ru.json`, `src/extension/settingsController.ts:45`, `src/webview/settingsStore.ts`, `src/webview/components/Settings.tsx:1013`, `src/extension/chatPanel.ts:802`, `src/extension/chatController.ts:1608-1650`, `src/webview/toolView.ts:264`.
- Документация и smoke: `docs/antigravity-protocol.md`, `README.md:208`, `README.ru.md`, `scripts/agy-smoke.mjs`, `docs/roadmap/16-antigravity-support.pending.md`.

## Этапы

### 1. Живой спайк `agy acp` (`1.5.3`) и фикстуры контракта

- [x] Прогнать живой `agy acp` во временном каталоге на минимальной модели (`gemini-3.8-flash` + `thought_level: "low"`), записав сырой NDJSON `stdin`/`stdout` (и отдельно `stderr`) для сценариев: `initialize` → `session/new` → текстовый `pong` → чтение и правка файла (проверить структуру диффа в `tool_call`/`tool_call_update`) → вызов с `session/request_permission` и ответ → `session/cancel` посреди хода → переключение `model`, `thought_level` (включая проверку `gpt-oss-120b-medium`) и `mode` (`default` / `accept-edits` / `plan`) → отправка крошечной PNG-картинки в `session/prompt` → проверка, приходят ли серверные запросы для `ask_question` и `plan` → закрытие процесса и повторное открытие той же беседы через `session/resume` и `session/load` + проверка `session/list`.
- [x] Очистить снятые кадры от путей пользователя, email, токенов и идентификаторов машины; положить санитизированную фикстуру в `test/fixtures/antigravity/acp-pong.ndjson` (по образцу `test/fixtures/cursor/acp-pong.ndjson`). Удалить временную папку спайка; в `~/.gemini` ничего не править руками.
- [x] Записать отчёт `docs/spikes/antigravity-acp/report.md` с таблицей решений для этапов 2–3: точные кадры `session/update` (текст, рассуждения, инструменты, диффы, заголовок сессии), наличие/отсутствие usage, точная схема `session/request_permission` и `optionId`, судьба флагов `questions` и `plan`, точный контракт `model` + `thought_level` + `mode`, формат блока картинки, отличие `session/resume` от `session/load`. Последняя строка отчёта — `go` или `stop`.

**Готово, когда:** `tail -n 1 docs/spikes/antigravity-acp/report.md` даёт `go` (или обоснованный `stop`), фикстура `test/fixtures/antigravity/acp-pong.ndjson` валидна как NDJSON, а проверка секретов `rg -n "Bearer|api_key|apiKey|ya29\.|AIza|@gmail" test/fixtures/antigravity/acp-pong.ndjson docs/spikes/antigravity-acp` пуста; код в `src/` не изменён.

**Исполнение:** отдельная сессия / субагент; последовательно, первый этап (контракт для этапов 2–3).

### 2. Общий транспорт `src/agent/acp/` и ядро сессии `agy acp`

- [x] Вынести универсальный JSON-RPC 2.0 NDJSON-клиент из `src/agent/cursor/client.ts` в `src/agent/acp/client.ts` (`AcpRpcClient` с параметризуемым именем провайдера и своими unit-тестами); оставить в `src/agent/cursor/client.ts` совместимую обёртку так, чтобы все тесты `src/agent/cursor/` проходили без изменений контракта.
- [x] Обновить `src/agent/antigravity/executable.ts`: требовать `agy >= 1.5.0` (разбор semver `parseAgyVersion`); для старых версий возвращать понятную `problem` с указанием найденной версии и минимальной `1.5.0`.
- [x] Реализовать `src/agent/antigravity/acpProtocol.ts` (или обновлённый `protocol.ts`), `mapper.ts`, `fakeServer.ts` и ядро `adapter.ts` поверх `agy acp`: `createSession` (`session/new`) и `resumeSession` (`session/resume` по контракту этапа 1), очередь промптов, текст и `thinking.*` (если подтверждены спайком), отправка картинок (`PromptImage` → ACP `image`, если подтверждено этапом 1), `interrupt` через `session/cancel`, штатный `dispose` (`stdin.end()` → grace → `SIGTERM` → `SIGKILL`), раздельные `setModel` и `setEffort` (`thought_level`, с безопасной обработкой моделей без `low`/`high`), `setMode` (`default` / `accept-edits` / `plan`), `capabilities()` (базовые модели и `effort` из `configOptions` без выдачи 13 склеенных суффиксов за отдельные модели), `accountInfo()` с `plan` из `_meta.antigravity.tier.name`. До удаления `agy.retry` на этапе 3 оставить в `adapter.ts` безопасную заглушку `isAgySession` (`false`), чтобы не трогать `chatController.ts` раньше очереди.
- [x] Обновить opt-in скрипт `scripts/agy-smoke.mjs` под новый ACP-адаптер (временная папка, один короткий ход, вне `npm run check`) и покрыть ядро тестами на `fakeServer.ts` и `test/fixtures/antigravity/acp-pong.ndjson`.

**Готово, когда:** `TZ=UTC npm run check` зелёный; тесты `src/agent/acp/`, `src/agent/cursor/` и новые ACP-тесты `src/agent/antigravity/` проходят.

**Исполнение:** отдельная сессия / субагент; последовательно после `go` на этапе 1 (трогает `src/agent/antigravity/adapter.ts` и общий транспорт).

### 3. Инструменты, диффы, живые разрешения, история и снос legacy `stream-json`

- [x] Довести маппинг `tool_call` / `tool_call_update` в `src/agent/antigravity/mapper.ts` и `tools.ts` по фикстуре этапа 1: карточки `Bash`, `Read`, `Edit`, `MultiEdit`, `Write`, `Grep`, `Glob`, `WebFetch`, `WebSearch` (неизвестные — карточка с сырым именем без падения хода) и структурный патч/дифф правок в `tool.result` для вкладки `changes` без чтения `transcript_full.jsonl`.
- [x] Подключить живые разрешения `session/request_permission` → `permission.request` и `respondPermission` (`allow`, `allow-always` при наличии опции, `allow-edits` — перевод режима в `accept-edits` + разрешение текущего вызова, `deny`), автоответ одноразовым разрешением при `bypassPermissions` + `allowBypassPermissions`, гарантированный сброс висящих запросов при `interrupt`/`dispose`; если этап 1 подтвердил вопросы или план — подключить `question.request` / `plan.request`. Выставить финальные флаги `ANTIGRAVITY_FEATURES` в `src/agent/features.ts` (`images`, `modes`, `plan`, `questions` — строго по факту этапа 1; `cost` / `context` — только если спайк подтвердил реальные токены).
- [x] Перевести `listSessions`, `loadHistory` и `renameSession` на ACP: `session/list` с фильтрацией по `cwd` (`realpath`, как в прежнем `workspaceMatcher`), наложение пользовательских имён из `agentura.antigravity.names` (`sessionIndex.ts` ужать до хранения только переименований), реконструкция истории `AgentEvent[]` из реплея `session/load` (по образцу `src/agent/cursor/history.ts`, с сохранением `live: true` и восстановлением модели/режима при `resumeSession`).
- [x] Полностью удалить старый `stream-json`/SQLite-слой (`process.ts`, `storage.ts`, `edits.ts`, `patch.ts`, старый `fakeAgy.ts` и старые фикстуры `stream-json`, если они больше не используются), протокольные сообщения `agy.retry` / `agy.retryRejected` и карточку `refusal` в `src/protocol.ts`, `src/extension/chatController.ts`, `src/webview/{chatState,store,turnView,strings,strings.en}.ts` и `src/webview/components/{Log,Cards}.tsx`.

**Готово, когда:** `TZ=UTC npm run check` зелёный; `rg -n "node:sqlite|conversation_summaries|transcript_full|agy\.retry|addRefusal|kind: 'refusal'" src/` пуст; фейк-сервер проверяет инструменты с диффом, `allow`/`allow-edits`/`deny`, `interrupt` при висящем разрешении, `listSessions` по `cwd` + `renameSession` и реплей `loadHistory`.

**Исполнение:** отдельная сессия / субагент; последовательно после этапа 2 (меняет те же файлы `src/agent/antigravity/` и протокол webview).

### 4. Квота `/usage` (`1.5.3`), вход `agy acp --login` и настройки новой сессии

- [x] Обновить `src/agent/antigravity/quota.ts`, `src/extension/engineLimits.ts`, `src/webview/hudView.ts`, `src/webview/engineLimitsView.ts`, `src/webview/components/EngineLimits.tsx` и `src/webview/components/Composer.tsx` под 5-оконный вывод `agy -p "/usage"` (`1.5.3`) с обратной совместимостью к старому 2–3-оконному формату: сохранять тип окна (`5h` vs `7d`) и отдельное семейство `Gemini 4 Argon`, исключить дубли ключей `key` в `EngineLimits.tsx`, аккуратно разложить окна в `Table` и в компактные кольца HUD `Composer.tsx` без россыпи из 5 одинаковых кружков и с точным окном (`5ч` / `неделя`) в тултипе.
- [x] Переключить терминальную команду входа Antigravity в `src/extension/sidebarView.ts:242` на `agy acp --login` (с экранированием пути из `resolveAgyExecutable`, если он задан в настройке).
- [x] Добавить настройки `agentura.antigravity.defaultModel` и `agentura.antigravity.defaultEffort` (`'' | 'low' | 'medium' | 'high'`) в `package.json`, `package.nls.json`, `package.nls.ru.json`, `src/settings.ts`, `src/protocol.ts`, `src/extension/settingsController.ts` (живой каталог базовых моделей через `agy models` из `src/agent/antigravity/models.ts` по образцу `loadCodexCatalog`), `src/webview/settingsStore.ts` и `src/webview/components/Settings.tsx` (`⚙ → Новая сессия`, вместо заглушки `agyNote`).
- [x] Прокинуть `antigravity.defaultModel` и `antigravity.defaultEffort` в `src/extension/chatPanel.ts` и `src/extension/chatController.ts` при открытии новой вкладки Antigravity (без затирания модели существующей беседы при `resume`), а также научить `shortModel` в `src/webview/toolView.ts:264` аккуратно сокращать ID моделей Antigravity (`gemini-4-argon`, `gemini-3.8-flash`, `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-oss-120b-medium`).

**Готово, когда:** `TZ=UTC npm run check` зелёный; unit-тесты покрывают 5-строчный TSV `agy 1.5.3` и старый 2-строчный TSV, отсутствие дублей в `EngineLimits`, чтение/запись `agentura.antigravity.defaultModel` / `defaultEffort` и передачу дефолтов только в новую сессию.

**Исполнение:** отдельная сессия / субагент; последовательно после этапа 3 (разделяет `src/protocol.ts`, `src/extension/chatController.ts` и `src/webview/strings*.ts` с этапом 3).

### 5. Документация, интеграционная проверка и уборка хвостов

- [x] Переписать `docs/antigravity-protocol.md` под фактический контракт `agy acp` (`1.5.3`), заменив описание `stream-json` и `node:sqlite` на снятый протокол ACP, модель/effort/режимы, `session/list` / `session/load` / `session/resume` и формат `/usage`.
- [x] Обновить разделы Antigravity и настроек новой сессии в `README.md` (английский) и `README.ru.md` (русский): минимальная версия `agy >= 1.5.0`, работа через `agy acp`, живые разрешения, картинки, режимы `default` / `accept-edits` / `plan`, настройки дефолтной модели и `effort`, вход `agy acp --login`. Удалить устаревший хвост `docs/roadmap/16-antigravity-support.pending.md`.
- [x] Прогнать полную проверку `TZ=UTC npm run check`, интеграционные тесты `npm run test:integration`, opt-in `node scripts/agy-smoke.mjs` (если `agy` залогинен) и `git diff --check`; подготовить короткий чеклист ручной приёмки в окне VS Code (5 пунктов).

**Готово, когда:** `TZ=UTC npm run check`, `npm run test:integration` и `git diff --check` зелёные; документация соответствует коду, а устаревших упоминаний `stream-json` и `conversation_summaries.db` как текущего механизма Antigravity в `docs/antigravity-protocol.md` и `README*.md` не осталось.

**Исполнение:** отдельная сессия / субагент; последовательно, финальный этап.

## Промты исполнителей

Общие правила для всех этапов: работаем в репозитории `/Users/fost/Projects/Agentura` (или в выделенном под задачу git worktree — см. «Порядок работы»). До правок прочитай `/Users/fost/Projects/CLAUDE.md`, `AGENTS.md` и `.codex/WORKFLOW.md`. Чекбоксы в `docs/roadmap/36-antigravity-acp.md` отмечай только после фактического прохождения команд из «Готово, когда». Чужие незакоммиченные файлы не трогать. В `~/.gemini`, `~/.claude`, `~/.codex`, `~/.cursor` ничего не писать и не удалять. Длинный вывод тестов и сборок перенаправляй во временный лог в `/tmp`, в отчёт выводи только итог и ошибки. Не коммитить и не пушить без прямого указания пользователя.

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: живой спайк `agy acp` (`1.5.3`) во временной папке, запись очищенной фикстуры и отчёта с таблицей решений. Код в `src/` не менять.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/36-antigravity-acp.md (разделы «Контекст и ограничения» и «Этап 1»);
- docs/spikes/cursor-acp/report.md и test/fixtures/cursor/acp-pong.ndjson — эталон структуры отчёта и обёртки фикстуры;
- docs/antigravity-protocol.md — старый протокол для понимания прежних ограничений.

Уже решено:
- Гонять во временной папке `/tmp/agy-acp-spike-*` на самой дешёвой модели (`gemini-3.8-flash`, `thought_level: "low"`), короткие одношаговые промпты.
- `~/.gemini` руками не трогать и не чистить; временную папку `/tmp/agy-acp-spike-*` удалить по завершении.
- В фикстуру и отчёт не должны попасть домашние пути, email, токены и секреты.

Порядок:
1. Написать одноразовый драйвер в `/tmp`, снять сырой NDJSON `stdin`/`stdout` и `stderr` для: `initialize`, `session/new`, `pong`, чтения и правки файла в `/tmp`, вызова с `session/request_permission` и ответа на него, `session/cancel` посреди хода, переключения `model` + `thought_level` (включая проверку `gpt-oss-120b-medium`) + `mode` (`default`, `accept-edits`, `plan`), отправки маленькой PNG-картинки в `session/prompt`, попытки вызвать вопрос пользователю / план (фиксируем только реальные кадры), закрытия `stdin` и повторного открытия беседы через `session/resume` и `session/load`, а также `session/list`.
2. Собрать санитизированную фикстуру `test/fixtures/antigravity/acp-pong.ndjson`.
3. Оформить `docs/spikes/antigravity-acp/report.md` с таблицей решений по всем вопросам этапа 1 и финальной строкой `go` или `stop`. Отметить чекбоксы этапа 1 в roadmap.

Не делать: правки в `src/`, `package.json`, `README*`, коммиты и push.

DoD и проверка:
- `tail -n 1 docs/spikes/antigravity-acp/report.md` выводит `go` или `stop`;
- `node -e 'for (const l of require("node:fs").readFileSync("test/fixtures/antigravity/acp-pong.ndjson","utf8").trim().split("\n")) JSON.parse(l)'` проходит без ошибок;
- `rg -n "Bearer|api_key|apiKey|ya29\.|AIza|@gmail|/Users/" test/fixtures/antigravity/acp-pong.ndjson docs/spikes/antigravity-acp` пусто;
- `git status --short` не содержит новых правок в `src/`.

В отчёте: вердикт (`go`/`stop`), ключевые находки таблицы решений, созданные файлы, что не удалось воспроизвести живьём, открытые вопросы.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: вынести общий `AcpRpcClient` в `src/agent/acp/` и переписать ядро `AntigravityAdapter` на `agy acp` (процесс сессии, текст/рассуждения, картинки, Stop, модель + effort + режим, capabilities, accountInfo, фейк-сервер и smoke).

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/36-antigravity-acp.md (этап 2 и «Принятые решения»);
- docs/spikes/antigravity-acp/report.md и test/fixtures/antigravity/acp-pong.ndjson — единственный источник контракта ACP;
- src/agent/cursor/client.ts:56, src/agent/cursor/adapter.ts:82, src/agent/cursor/mapper.ts:18, src/agent/cursor/fakeServer.ts;
- src/agent/antigravity/executable.ts:60, src/agent/antigravity/adapter.ts:122, src/agent/antigravity/models.ts:8, scripts/agy-smoke.mjs.

Уже решено:
- Если `docs/spikes/antigravity-acp/report.md` не заканчивается на `go` — стоп, код не писать.
- Минимальная версия `agy` в `executable.ts` — `1.5.0`.
- `src/agent/cursor/client.ts` переиспользует `src/agent/acp/client.ts` без поломки существующих тестов Cursor.
- Модели и `effort` (`thought_level`) в `AntigravityAdapter` раздельные: `capabilities()` отдаёт базовые модели из `configOptions` (`model`) и поддерживаемые уровни `effort`, не размножая 13 комбинированных суффиксов в пикере моделей.
- До этапа 3 оставь экспорт-заглушку `isAgySession` (`return false`), чтобы `src/extension/chatController.ts` компилировался без правок вне области этапа 2.
- До этапа 3 на `session/request_permission` возвращать штатный отказ по форме из отчёта спайка (не оставлять запрос висеть).

Порядок:
1. Вынести `src/agent/acp/client.ts` + `client.test.ts`, переключить `src/agent/cursor/client.ts`.
2. Обновить `src/agent/antigravity/executable.ts` + `executable.test.ts` на проверку `>= 1.5.0`.
3. Реализовать ACP-протокол, маппер базового хода (текст, рассуждения, картинки по спайку), `fakeServer.ts` и `AntigravityAdapter` (`createSession`, `resumeSession`, очередь, `interrupt`, `dispose`, `setModel`, `setEffort`, `setMode`, `capabilities`, `accountInfo`).
4. Обновить `scripts/agy-smoke.mjs` и unit-тесты на `fakeServer.ts` + `acp-pong.ndjson`.
5. Прогнать `TZ=UTC npm run check` и отметить чекбоксы этапа 2.

Не делать: правки webview/настроек/квоты, снос `agy.retry` в `chatController.ts` и `protocol.ts` (это этап 3), чтение/запись `~/.gemini`, коммиты и push.

DoD и проверка:
- `TZ=UTC npm run check` зелёный;
- `npx vitest run src/agent/acp src/agent/cursor src/agent/antigravity` зелёный.

В отчёте: сделано (файлы), отклонения от плана, непроверенное, открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: подключить в `AntigravityAdapter` карточки инструментов и диффы правок, живые разрешения, `listSessions` / `loadHistory` / `renameSession` поверх ACP, обновить `ANTIGRAVITY_FEATURES` и полностью вычистить старый слой `stream-json`, `node:sqlite` и `refusal` (`agy.retry`).

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/36-antigravity-acp.md (этап 3);
- docs/spikes/antigravity-acp/report.md и test/fixtures/antigravity/acp-pong.ndjson;
- src/agent/antigravity/{adapter,mapper,tools,sessionIndex}.ts;
- src/agent/cursor/{mapper,history,adapter}.ts — образец реплея `session/load` и карточек разрешений;
- src/agent/features.ts:110;
- точки удаления `refusal` / `agy.retry`: src/protocol.ts:280,498,670,739, src/extension/chatController.ts:31,1013-1027, src/webview/chatState.ts:101,290-315, src/webview/store.ts:57,413,675-684,1166, src/webview/turnView.ts:79, src/webview/components/Log.tsx:661, src/webview/components/Cards.tsx:250-285, src/webview/strings.ts:500, src/webview/strings.en.ts:494.

Уже решено:
- Новые варианты `AgentEvent` не добавлять.
- `bypassPermissions` автоотвечает разрешением только при `allowBypassPermissions: true`; `allow-edits` переводит сессию в `accept-edits` и разрешает текущий запрос.
- `sessionIndex.ts` хранит только `agentura.antigravity.names` (пользовательские имена поверх `title` из `session/list`); `agentura.antigravity.sessions` и чтение `~/.gemini` удаляются.
- Чужие изменения в `strings*.ts` и соседних файлах не затирать — удалять только точечные ключи `refusal`/`agy.retry`, если в рабочем дереве есть соседние правки.

Порядок:
1. Довести маппинг инструментов и диффов (`tool.start` / `tool.result`) по контракту этапа 1.
2. Подключить `permission.request` / `respondPermission` (и `question.request` / `plan.request`, если подтверждены спайком) + обновление `ANTIGRAVITY_FEATURES`.
3. Реализовать `listSessions` (фильтр `cwd` + `realpath` + `sessionIndex.nameOf`), `loadHistory` (`session/load`) и `renameSession`.
4. Удалить старые файлы `process.ts`, `storage.ts`, `edits.ts`, `patch.ts`, `fakeAgy.ts` (и их устаревшие тесты/фикстуры), а также весь контур `agy.retry` / `agy.retryRejected` / `refusal` в расширении и webview.
5. Написать тесты на инструменты, диффы, разрешения, `interrupt`, `listSessions` и `loadHistory`; прогнать `TZ=UTC npm run check`.

Не делать: правки квоты `/usage` и `Settings.tsx` (этап 4), коммиты и push.

DoD и проверка:
- `TZ=UTC npm run check` зелёный;
- `rg -n "node:sqlite|conversation_summaries|transcript_full|agy\.retry|addRefusal|kind: 'refusal'" src/` пусто.

В отчёте: сделано (файлы, включая удалённые), отклонения, непроверенное, открытые вопросы.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: починить разбор и отображение 5-оконной квоты `agy -p "/usage"` (`1.5.3`), переключить логин на `agy acp --login` и добавить настройки новой сессии Antigravity (`defaultModel`, `defaultEffort`) в `⚙ → Новая сессия`.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/36-antigravity-acp.md (этап 4);
- квота и HUD: src/agent/antigravity/quota.ts:14, src/extension/agyQuota.ts:16, src/extension/engineLimits.ts:29, src/webview/hudView.ts:278, src/webview/engineLimitsView.ts:71, src/webview/components/EngineLimits.tsx:111,209, src/webview/components/Composer.tsx:1874;
- вход: src/extension/sidebarView.ts:242;
- настройки новой сессии и модели: src/settings.ts:174, package.json:368, package.nls.json, package.nls.ru.json, src/extension/settingsController.ts:45, src/webview/settingsStore.ts, src/webview/components/Settings.tsx:1013, src/extension/chatPanel.ts:802, src/extension/chatController.ts:1608-1650, src/webview/toolView.ts:264.

Уже решено:
- Квота должна различать 5-часовые и недельные окна для `Gemini` и `Claude/GPT`, а также недельное окно `Gemini 4 Argon`, не создавая одинаковых `label`/`key` и не ломая старый 2–3-строчный вывод `agy`. В компактном HUD `Composer.tsx` не рисовать 5 неразличимых колец подряд — показывать аккуратную выборку (например, самые узкие окна по семействам или текущему семейству модели) с точным периодом (`5ч` / `неделя`) в тултипе, а полную раскладку отдавать во всплывашке/панели `EngineLimits`.
- В `Settings.tsx` (`⚙ → Новая сессия`) для Antigravity вместо статичной заглушки `agyNote` сделать выбор `defaultModel` (живой список из `agy models` через `parseAgyModels` + ручной ввод при пустом каталоге, по аналогии с Codex) и `defaultEffort` (`по умолчанию CLI` / `low` / `medium` / `high`).
- Дефолты применяются только к новой сессии (`createSession`), не перезаписывая модель возобновляемой беседы (`resumeSession`).

Порядок:
1. Обновить `quota.ts` + представления `engineLimits`/`hudView`/`EngineLimits.tsx`/`Composer.tsx` и их тесты.
2. Обновить команду входа в `sidebarView.ts` на `agy acp --login`.
3. Добавить `agentura.antigravity.defaultModel` и `defaultEffort` в схему настроек, `settingsController`, `settingsStore`, `Settings.tsx`, `chatPanel.ts` и `chatController.ts`; обновить `shortModel` в `toolView.ts`.
4. Покрыть unit-тестами и прогнать `TZ=UTC npm run check`.

Не делать: переписывание `README*` и `docs/antigravity-protocol.md` (этап 5), коммиты и push.

DoD и проверка:
- `TZ=UTC npm run check` зелёный;
- целевые тесты `quota.test.ts`, `agyQuota.test.ts`, `engineLimits*.test.ts`, `hudView.test.ts`, `settings*.test.ts`, `toolView.test.ts` зелёные.

В отчёте: сделано (файлы), как уложены 5 окон квоты в HUD и `EngineLimits`, отклонения, непроверенное, открытые вопросы.
```

### Этап 5

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: актуализировать документацию протокола и README, убрать устаревший pending-файл и провести финальную сквозную проверку.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/36-antigravity-acp.md (этап 5);
- docs/spikes/antigravity-acp/report.md;
- docs/antigravity-protocol.md, docs/roadmap/16-antigravity-support.pending.md, README.md:208, README.ru.md;
- фактический код `src/agent/antigravity/`, `src/agent/features.ts`, `src/settings.ts`.

Уже решено:
- `README.md` строго на английском, `README.ru.md` строго на русском; описывать только реально работающие флаги и поведение после этапов 2–4.
- `docs/roadmap/16-antigravity-support.pending.md` удалить (его пункты закрыты ACP-миграцией или явно зафиксированы в `docs/antigravity-protocol.md`), не трогая архивный `docs/roadmap/16-antigravity-support.md`.

Порядок:
1. Переписать `docs/antigravity-protocol.md` под `agy acp` (`1.5.3`) и актуальный `/usage`.
2. Обновить `README.md` и `README.ru.md`, удалить `docs/roadmap/16-antigravity-support.pending.md`.
3. Прогнать `TZ=UTC npm run check`, `npm run test:integration`, при доступном логине `agy` — `node scripts/agy-smoke.mjs`, затем `git diff --check`. Отметить чекбоксы этапа 5.

Не делать: изменения функциональности без найденного на проверке дефекта, установку `.vsix` в основную среду, коммиты и push.

DoD и проверка:
- `TZ=UTC npm run check` зелёный;
- `npm run test:integration` зелёный;
- `git diff --check` пустой.

В отчёте: сделано, результаты прогонов `check` / `test:integration` / `agy-smoke`, короткий чеклист ручной проверки в VS Code (5 пунктов), открытые вопросы.
```

## Риски и открытые вопросы

- **Несовпадение `thought_level` у отдельных моделей (`gpt-oss-120b-medium`):** в `configOptions` селект `thought_level` предлагает `low | medium | high`, но в `models.availableModels` у `gpt-oss-120b-medium` нет вариантов `low` и `high`. Этап 1 проверяет живую реакцию сервера; если сервер отвергает `low`/`high` для этой модели, адаптер перехватывает ошибку нефатально и синхронизирует фактический `thought_level` из ответа/конфига.
- **Отсутствие usage/токенов в ACP-кадрах:** у Cursor ACP счётчики токенов в `session/update` не приходят (`usageKnown: false`). Если этап 1 покажет то же для `agy acp`, не выдумываем токены и выключаем `context`/`cost` в `ANTIGRAVITY_FEATURES`, оставляя пользователю честную квоту аккаунта из `agy -p "/usage"`.
- **Накладные расходы `session/list` через `agy acp`:** список бесед вызывается из `SessionsService` на фоне. Краткоживущий процесс `agy acp` должен иметь жёсткий таймаут (как у Cursor ACP) и кэшироваться/не ронять чужие списки при отсутствии бинарника или логина.
- **Грязное рабочее дерево `main`:** на момент составления плана в `/Users/fost/Projects/Agentura` лежат незакоммиченные изменения соседних задач (roadmaps 31–35, `chatController.ts`, `strings*.ts`, `Settings.tsx`). Запуск этапов поверх грязного дерева смешает диффы.

## Порядок работы

Этапы выполняются строго последовательно: `1 → 2 → 3 → 4 → 5`. Этап 2 начинается только после вердикта `go` в `docs/spikes/antigravity-acp/report.md`. Из-за незакоммиченного WIP в основном рабочем дереве выполнять roadmap либо после закрытия текущего WIP в `main`, либо в отдельном git worktree от чистого коммита. В Antigravity исполнение идёт по маршруту `roadmap-run-agy` (основной чат принимает этапы по DoD и ведёт `## Checkpoint` здесь же, реализацию каждого этапа выполняет чистый субагент через `invoke_subagent` с `TypeName: "self"`, `Model: "inherit"`); в Codex — отдельными сессиями по `.codex/WORKFLOW.md`. Коммит, слияние worktree и push — только по явному разрешению владельца.
