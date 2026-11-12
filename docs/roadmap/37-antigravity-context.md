# 37. Antigravity: индикация контекста чата и переключение модели

> Статус: выполнено · 2026-11-11. Все этапы проверены и приняты.

## Checkpoint

**2026-11-11 · этап 4 принят (roadmap завершён).**

- Изменено: `docs/antigravity-protocol.md` (таблица окон `agyContextWindow`, расчёт `context.usage` по хвосту `transcript.jsonl` с одношаговым ACP-фолбэком, поведение `setModel` и нативное сжатие `/compact`), подразделы Antigravity в `README.md` и `README.ru.md` (без затрагивания соседних незакоммиченных правок), `scripts/agy-smoke.mjs` (проверка стартового `context.usage` и мгновенного пересчёта `1M → 200k → 1M` на `setModel`, а также `usedTokens` при `--turn`), подчистка завершающих пустых строк в `src/agent/antigravity/{models.ts,models.test.ts,adapter.test.ts}`.
- Приёмка основным чатом:
  - `TZ=UTC npm run check` — код `0`;
  - `npm run test:integration` — код `0`;
  - `node scripts/agy-smoke.mjs` (`agy 1.5.5`, без расхода генерационной квоты) — код `0` (`maxTokens`: `1_000_000 → 200_000 → 1_000_000`);
  - `git diff --check` — код `0`.
- Ветка/worktree: `main` (`edfe257`) в `/Users/fost/Projects/Agentura` (`isolation: "shared"`, коммитов, сборки `.vsix` и push нет).
- Исполнитель: T3 `delegate_task` (`[Roadmap 37 · Stage 4: Docs, agy-smoke & final verification](t3-thread://v2/9c72bd32-bbe1-4c20-96ab-3a1c470a700b/thread:delegated-task:command%3Amcp%3Aecde6c36-803b-4a30-a7bb-15e07e5f9fb8%3Adelegate-task%3Aroadmap-37-stage-4)`), `antigravity` / `gemini-3.8-flash` (`low`). Основной чат: `antigravity` / `gemini-4-carbon` (`medium`). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Чеклист ручной проверки в VS Code:
  1. Открыть пустую вкладку чата с движком Antigravity (`gemini-3.8-flash`) — у поля ввода видна шкала контекста с окном `1M`.
  2. Отправить промпт с вызовами инструментов (`Read`/`Bash`) — убедиться, что `usedTokens` обновляется по ходу и отражает реальный размер последнего шага `transcript.jsonl`, а не кратную сумму шагов.
  3. Переключить модель в активном чате на `claude-sonnet-5-5` (и обратно на Gemini) — потолок мгновенно меняется на `200k` (`1M`), доля и остаток пересчитываются, серверный контекст беседы сохраняется.
  4. Выполнить `/compact` в заполненном чате — отображается индикация сжатия (`compaction.start` → `compaction.end`) без текстового эха `"/compact"` в ленте.
  5. Навести курсор на шкалу контекста в HUD — тултип показывает загруженные токены, свободный остаток и размер окна модели.

**2026-11-11 · этап 3 принят.**

- Изменено: `src/extension/chatController.ts` (сохранение `lastContext` для `!e.agentId`, бюджет вложений только при `maxTokens > 0`, защита `lastInit` и опрос `contextUsage()` в `model.set`), `src/webview/hudState.ts` (сброс `max` и `contextWindow` при `maxTokens: 0`), `src/webview/hudView.ts` (`kilo` для `1M`, `hasMax`, тултип с загруженным и остатком), `src/webview/store.ts` (`contextShown`, `attachBudget`), `src/webview/components/Composer.tsx` (рендер известных и неизвестных окон без ложных `/ 200 000`), `src/webview/strings.ts`, `src/webview/strings.en.ts`, а также тесты `src/webview/hudState.test.ts`, `src/webview/hudView.test.ts`, `src/webview/engineDom.test.ts`, `src/extension/chatController.test.ts`. Оркестратором удалён 1 неиспользуемый импорт `sessionTitleOf` в `src/agent/antigravity/adapter.ts`. Чужие dirty-блоки сохранены без изменений.
- Приёмка основным чатом:
  - `TZ=UTC npm run check` — код `0` (typecheck, eslint, 162 test files passed, сборка esbuild OK).
- Ветка/worktree: `main` (`edfe257`) в `/Users/fost/Projects/Agentura` (`isolation: "shared"`, коммитов и push нет).
- Исполнитель: T3 `delegate_task` (`[Roadmap 37 · Stage 3: ChatController & HUD webview](t3-thread://v2/9c72bd32-bbe1-4c20-96ab-3a1c470a700b/thread:delegated-task:command%3Amcp%3Aecde6c36-803b-4a30-a7bb-15e07e5f9fb8%3Adelegate-task%3Aroadmap-37-stage-3)`), `antigravity` / `claude-sonnet-5-5` (`medium`). Основной чат: `antigravity` / `gemini-4-carbon` (`medium`). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 4 (документация, `scripts/agy-smoke.mjs` и финальные проверки).

**2026-11-11 · этап 2 принят.**

- Изменено: `src/agent/features.ts` (`ANTIGRAVITY_FEATURES`: `context: true`, `compact: true`), `src/agent/features.test.ts`, `src/agent/antigravity/adapter.ts` (`dataDir`, `contextUsage`, `handshake` / `tool_call` / `drain` / `loadHistory`, усиление `setModel`/`applyModel`, нативный `compact()`), `src/agent/antigravity/adapter.test.ts`. Оркестратором точечно уточнено условие одношагового фолбэка в `drain()` (`toolCallsCount === 0` при отсутствии нового шага транскрипта). Чужие dirty-файлы не затронуты.
- Зонд `/compact`: проверен живьём в `/tmp` на `agy acp` (`gemini-3.8-flash`, `thought_level: "low"`) — `session/prompt` с `"/compact"` выполняет нативную серверную компакцию (`type: "CHECKPOINT", status: "DONE"` в `transcript.jsonl`, без эха `agent_message_chunk` в чат, с сохранением фактов беседы); временный каталог удалён, `ANTIGRAVITY_FEATURES.compact = true` включён.
- Приёмка основным чатом:
  - `npx vitest run src/agent/antigravity/ src/agent/features.test.ts` — код `0` (9 files, 81 tests passed);
  - `npm run typecheck` — код `0`.
- Ветка/worktree: `main` (`edfe257`) в `/Users/fost/Projects/Agentura` (`isolation: "shared"`, коммитов и push нет).
- Исполнитель: T3 `delegate_task` (`[Roadmap 37 · Stage 2: AntigravityAdapter context, setModel & compact](t3-thread://v2/9c72bd32-bbe1-4c20-96ab-3a1c470a700b/thread:delegated-task:command%3Amcp%3Aecde6c36-803b-4a30-a7bb-15e07e5f9fb8%3Adelegate-task%3Aroadmap-37-stage-2)`), `antigravity` / `gemini-3.8-flash` (`high`). Основной чат: `antigravity` / `gemini-4-carbon` (`medium`). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 3 (`ChatController` и HUD webview).

**2026-11-11 · этап 1 принят.**

- Изменено: созданы `src/agent/antigravity/context.ts`, `src/agent/antigravity/context.test.ts`; обновлены `src/agent/antigravity/models.ts` (`agyContextWindow`), `src/agent/antigravity/models.test.ts`, `src/webview/toolView.test.ts`. Файлы вне скоупа этапа 1 и чужие dirty-файлы не затронуты.
- Приёмка основным чатом:
  - `npx vitest run src/agent/antigravity/context.test.ts src/agent/antigravity/models.test.ts src/webview/toolView.test.ts` — код `0` (3 files, 36 tests passed);
  - `npm run typecheck` — код `0`.
- Ветка/worktree: `main` (`edfe257`) в `/Users/fost/Projects/Agentura` (`isolation: "shared"`, коммитов и push нет; чужой WIP в дереве сохранён без изменений).
- Исполнитель: T3 `delegate_task` (`[Roadmap 37 · Stage 1: context.ts & agyContextWindow](t3-thread://v2/9c72bd32-bbe1-4c20-96ab-3a1c470a700b/thread:delegated-task:command%3Amcp%3Aecde6c36-803b-4a30-a7bb-15e07e5f9fb8%3Adelegate-task%3Aroadmap-37-stage-1)`), `antigravity` / `gemini-3.8-flash` (`medium`). Основной чат: `antigravity` / `gemini-4-carbon` (`medium`). `cwd` подтверждён = `/Users/fost/Projects/Agentura`.
- Блокеров нет. Следующий шаг: этап 2 (проверка `/compact`, подключение `context.ts` и усиление `setModel` в `AntigravityAdapter`).

## Цель

Показывать во вкладке чата Antigravity (`agy acp`) точный объём загруженного контекста и остаток окна текущей модели (в живом ходе, после завершения хода и при открытии сохранённой сессии), а при переключении модели в текущем чате сохранять контекст беседы, мгновенно пересчитывать остаток под окно новой модели и честно обрабатывать отказы сервера.

## Контекст и ограничения

### Подтверждённые факты

- **Причина отсутствия шкалы сейчас:** в `src/agent/features.ts:109-130` (`ANTIGRAVITY_FEATURES`) выставлено `context: false`, а `AgySession.contextUsage()` в `src/agent/antigravity/adapter.ts:573-575` возвращает `undefined`.
- **Ограничения `agy acp` (`1.5.3`–`1.5.5`):**
  1. Ни `session/new`, ни `models.availableModels`, ни `session/prompt` не передают размер окна контекста модели (`maxTokens` / `contextWindow`).
  2. Поле `session/prompt.result.usage` (`src/agent/antigravity/acpMapper.ts:12-23`) суммирует токены по всем внутренним LLM-шагам хода (`totalTokens = inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens`): на одношаговом ходе оно равно размеру контекста, но на ходе с `K` вызовами инструментов завышено примерно в `K + 1` раз (`test/fixtures/antigravity/acp-pong.ndjson:56,79,85`).
- **Точный источник токенов последнего вызова модели:** `agy` (включая `agy acp` `1.5.5`) пишет компактный построчный лог `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`. Каждая завершённая строка `type === "PLANNER_RESPONSE"` (`status === "DONE"`) содержит точные токены одного LLM-запроса: `input_tokens`, `cache_read_tokens`, опционально `cache_write_tokens` и `output_tokens`, где `input_tokens + cache_read_tokens` следующего шага совпадает с контекстом предыдущего.
- **Переключение модели:** `AgySession.setModel` (`src/agent/antigravity/adapter.ts:503-518`) меняет модель в том же процессе `agy acp` и том же `sessionId` через `session/set_config_option` (`configId: "model"`) и синхронизирует `thought_level` (`syncEffort`, `adapter.ts:686-701`), поэтому серверный контекст беседы **не теряется**. Однако обнаружены три пробела:
  1. Остаток окна на HUD не пересчитывается сразу при смене модели (например, переход `gemini-4-argon` `1M` → `claude-sonnet-5-5` `200k` или `gpt-oss-120b-medium` `128k` при уже занятых `150k`).
  2. `applyModel` (`src/agent/antigravity/adapter.ts:671-684`) при ошибке JSON-RPC пишет только `warn` в лог и не пробрасывает отказ, из-за чего `store.ts:1045-1048` и `ChatController.handle` (`src/extension/chatController.ts:1020-1023`) оставляют в UI и `lastInit.model` отвергнутую сервером модель.
  3. После `setModel` не перевыпускается подтверждённое состояние сессии (`model` + актуальный `effort`), если прислали склеенный ID (`gemini-4-argon-high`) или вернулись с `gpt-oss-120b-medium` на модель с `thought_level`.
- **Команда `/compact`:** в `available_commands_update` (`test/fixtures/antigravity/acp-pong.ndjson:5`) сервер `agy acp` объявляет встроенную команду `compact`, но поведение `session/prompt` с текстом `"/compact"` в ACP живьём не проверялось (`ANTIGRAVITY_FEATURES.compact` сейчас `false`).

### Допущения и принятые решения

- **Узкое исключение из запрета Roadmap 36 на `~/.gemini`:** возвращаем строго изолированное read-only чтение последних `64 КБ` компактного файла `brain/<sessionId>/.system_generated/logs/transcript.jsonl` в отдельном модуле `src/agent/antigravity/context.ts` (строгая проверка UUID `sessionId`, параметризуемый каталог данных для тестов, мягкая деградация без ошибок при отсутствии файла). Ни `node:sqlite`, ни `conversation_summaries.db`, ни `transcript_full.jsonl` не используются; запись в `~/.gemini` запрещена.
- **Фолбэк без диска:** если `transcript.jsonl` недоступен, на ходе без вызовов инструментов (`0` карточек `tool_call` за ход) `usedTokens` берётся из `session/prompt.result.usage` (`input + cacheRead + cacheWrite + output`); на многошаговом ходе без транскрипта завышенная сумма не эмитится (сохраняется последнее достоверное `usedTokens`).
- **Таблица окон моделей Antigravity (`agyContextWindow` в `src/agent/antigravity/models.ts`):**
  - `gemini-*` (`gemini-4-argon`, `gemini-4-carbon`, `gemini-3.8-flash` и др.) → `1_000_000`;
  - `claude-*` (`claude-opus-5-5`, `claude-sonnet-5-5` и др.) → `200_000`;
  - `gpt-oss-120b*` → `128_000`;
  - неизвестная модель → `undefined` (выдуманный потолок `200k` не подставляется).
- **Шкала без выдуманных порогов:** `ANTIGRAVITY_FEATURES` получает `context: true` при `autoCompact: false` (аналогично Codex: `thresholds = []`, без засечек автосжатия Claude). При неизвестном `maxTokens` (`maxTokens: 0` при сбросе после смены модели) UI показывает фактический `usedTokens` без ложного `/ 200 000` и без кольца `%`, а при `usedTokens === 0` и неизвестном окне индикатор скрыт.
- **Тултип остатка:** для закрытия требования «сколько загружено и сколько осталось» тултип открытой шкалы без порогов (`ui.compose.ctxTitleOpen`) показывает загруженные токены, свободный остаток (`Math.max(0, max - used)`) и полный размер окна.
- **Проверка `/compact`:** на этапе 2 выполняется точечная проверка `session/prompt` с `"/compact"` во временном каталоге на `gemini-3.8-flash` (`thought_level: "low"`). Если сервер выполняет сжатие штатно (а не отвечает обычным текстом модели), включаем `ANTIGRAVITY_FEATURES.compact = true` и `AgySession.compact()`; иначе оставляем `compact: false` и фиксируем факт в `docs/antigravity-protocol.md`.
- **Новые типы `AgentEvent` не вводим:** используем существующие `context.usage`, `session.init` и `error`. Боковой список сессий (`SessionInfo`) в скоуп не входит — задача касается текущего чата.

### Точки входа в коде

- Адаптер и модели Antigravity: `src/agent/antigravity/adapter.ts:181,503,573,594,671,736`, `src/agent/antigravity/acpMapper.ts:12,40`, `src/agent/antigravity/models.ts:8,26`, `src/agent/antigravity/history.ts:30`, `src/agent/features.ts:109`.
- Контроллер хоста: `src/extension/chatController.ts:322,599,1020-1023,1442,1771-1783`.
- HUD и webview: `src/webview/hudState.ts:16,130,293`, `src/webview/hudView.ts:111,135,160`, `src/webview/store.ts:317,442,1045`, `src/webview/components/Composer.tsx:1083,1793,1823,1845`, `src/webview/toolView.ts:264`, `src/webview/strings.ts`, `src/webview/strings.en.ts`.
- Тесты и документация: `src/agent/antigravity/{adapter,models,history}.test.ts`, `src/webview/{hudState,hudView,engineDom,toolView}.test.ts`, `src/extension/chatController.test.ts`, `scripts/agy-smoke.mjs`, `docs/antigravity-protocol.md`, `README.md`, `README.ru.md`.

### Чужие незакоммиченные изменения в рабочем дереве

В рабочем дереве `/Users/fost/Projects/Agentura` уже есть незакоммиченные правки соседних задач (в том числе в `src/extension/chatController.ts`, `src/webview/hudState.ts`, `src/webview/store.ts`, `src/webview/engineDom.test.ts`, `src/webview/strings*.ts`, `README.md`, `README.ru.md`). Откатывать, форматировать целиком или затирать их запрещено — вносить только точечные правки своей задачи (при параллельной работе использовать отдельный worktree по правилам репозитория).

## Этапы

### 1. Модуль съёма контекста `context.ts` и таблица окон моделей Antigravity

- [x] Добавить в `src/agent/antigravity/models.ts` чистую функцию `agyContextWindow(model: string): number | undefined` (с нормализацией суффиксов `-low|-medium|-high`: `gemini-*` → `1_000_000`, `claude-*` → `200_000`, `gpt-oss-120b*` → `128_000`, прочие → `undefined`) и покрыть её unit-тестами в `src/agent/antigravity/models.test.ts` (включая `gemini-4-carbon`, `gemini-4-argon-high`, `claude-opus-5-5`, `gpt-oss-120b-medium` и неизвестный ID). Добавить тест сокращения `shortModel('gemini-4-carbon-medium') === 'carbon-4'` в `src/webview/toolView.test.ts`.
- [x] Создать `src/agent/antigravity/context.ts` с read-only чтением хвоста (до `64 КБ`) файла `<dataDir>/brain/<sessionId>/.system_generated/logs/transcript.jsonl`: строгая проверка UUID `sessionId` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`), дефолтный `dataDir` (`~/.gemini/antigravity-cli` с переопределением в конфиге адаптера для тестов), отбрасывание оборванной первой строки чанка и битого JSON, поиск последнего `type === 'PLANNER_RESPONSE'` со `status === 'DONE'` и возврат `{ stepIndex, usedTokens }` (`input_tokens + cache_read_tokens + (cache_write_tokens ?? 0) + output_tokens`), либо `undefined` при отсутствии файла/шагов без выброса исключений.
- [x] Добавить в `src/agent/antigravity/context.ts` сборщик события `buildAgyContextUsage(usedTokens: number, model: string | undefined): AgentEventOf<'context.usage'>` (`source: 'usage'`; при известном окне — `maxTokens` и `percentage`; при неизвестном окне — `maxTokens: 0`, чтобы HUD сбрасывал прежний потолок без подстановки ложных `200k`) и фолбэк-расчёт одношагового хода из `TokenUsage`. Покрыть `src/agent/antigravity/context.test.ts` кейсами: многошаговый транскрипт, файл больше `64 КБ`, оборванная строка в процессе дозаписи, невалидный `sessionId` (`../`), отсутствие файла, известная и неизвестная модель.

**Готово, когда:** `npx vitest run src/agent/antigravity/context.test.ts src/agent/antigravity/models.test.ts src/webview/toolView.test.ts` и `npm run typecheck` проходят с кодом `0`; файлы вне `src/agent/antigravity/` и `src/webview/toolView.test.ts` не затронуты.

**Исполнение:** T3 `delegate_task` (`providerInstanceId: "antigravity"`, `model: "gemini-3.8-flash"`, `options: { thinking_level: "medium" }`, `isolation: "shared"`); последовательно, первый этап (чистые функции и изолированные unit-тесты — дешёвый пул Gemini без расхода старших моделей).

### 2. Интеграция контекста, смены модели и проверки `/compact` в `AntigravityAdapter`

- [x] Проверить в изолированном `/tmp` поведение живого `agy acp` при отправке `session/prompt` с текстом `"/compact"` после короткого хода на `gemini-3.8-flash` (`thought_level: "low"`), после чего удалить временный каталог. Если сервер реально выполняет компакцию беседы (а не прокидывает `"/compact"` как обычный вопрос в LLM) — реализовать `AgySession.compact()` и включить `ANTIGRAVITY_FEATURES.compact = true`; если нет — оставить `compact: false` и зафиксировать наблюдение для документации этапа 4.
- [x] Включить `ANTIGRAVITY_FEATURES.context = true` в `src/agent/features.ts` и подключить `context.ts` в `src/agent/antigravity/adapter.ts` (`AntigravityAdapterConfig.dataDir` для тестов):
  - на завершении `handshake` читать хвост транскрипта (для `resumeSession` подхватывается накопленный `usedTokens`, для новой сессии — `0`), сохранять текущее состояние и эмитить `context.usage` (если `usedTokens > 0` или окно модели известно); реализовать `contextUsage()`;
  - в ходе `session/prompt` обновлять `usedTokens` по `transcript.jsonl` на уведомлениях `tool_call` (без блокировки потока при отсутствии новых шагов) и по завершении хода (до `2` коротких ретраев, если `stepIndex` в файле ещё не обновился; при отсутствии транскрипта и `0` вызовов инструментов за ход брать сумму из `result.usage`, а при `>0` инструментах без транскрипта не затирать `usedTokens` завышенной суммой);
  - в `loadHistory` (`src/agent/antigravity/adapter.ts:181`) дочитывать хвост `transcript.jsonl` по `sessionId` и при наличии `usedTokens` (или известного окна сохранённой модели) добавлять финальный `context.usage` в `history.events`.
- [x] Усилить `AgySession.setModel` и `applyModel` (`src/agent/antigravity/adapter.ts:503-518,671-684`):
  - при ошибке `session/set_config_option` (`configId: "model"`) не глотать сбой молча — эмитить нефатальный `{ type: 'error', fatal: false, message }`, перевыпускать `session.init` с фактически подтверждёнными сервером `model` и `effort` (возвращая селект UI к реальной модели) и пробрасывать ошибку вызывающему;
  - при успешной смене модели (и после `syncEffort`) перевыпускать `session.init` с нормализованным `config.model.current` и актуальным `effort`, а также **немедленно эмитить `context.usage`** с текущим `usedTokens` и `maxTokens` новой модели (чтобы переход `1M → 200k / 128k` или на неизвестную модель сразу пересчитывал остаток в чате без потери истории).
- [x] Расширить `src/agent/antigravity/adapter.test.ts` (на `fakeServer.ts` и временном `dataDir` с фикстурным `transcript.jsonl`): стартовый `context.usage`, многошаговый ход с инструментами (берётся последний шаг транскрипта, а не кратная сумма `result.usage`), одношаговый фолбэк без транскрипта, восстановление контекста в `loadHistory` и `resumeSession`, мгновенный пересчёт `maxTokens` при `setModel` (`gemini-4-argon` → `claude-sonnet-5-5` → `gpt-oss-120b-medium` → неизвестная модель) и откат UI/ошибка при отказе `setModel`.

**Готово, когда:** `npx vitest run src/agent/antigravity/` и `npm run typecheck` проходят с кодом `0`.

**Исполнение:** T3 `delegate_task` (`providerInstanceId: "antigravity"`, `model: "gemini-3.8-flash"`, `options: { thinking_level: "high" }`, `isolation: "shared"`); последовательно после этапа 1 (зависит от `context.ts` и `agyContextWindow`; связка проверена на `adapter.ts` в Roadmap 36 без траты Carbon/Argon/Opus).

### 3. Контроллер и HUD webview: отображение загруженного/оставшегося контекста и модели

- [x] В `src/extension/chatController.ts`:
  - сохранять `this.lastContext` для основного агента (`!e.agentId`), чтобы пересев webview восстанавливал шкалу у движков с `source: 'usage'` (Codex, Antigravity), но применять ограничение бюджета вложений `attachTokenBudget` (`chatController.ts:1442`) только при `this.lastContext?.maxTokens && this.lastContext.maxTokens > 0`;
  - в `case 'model.set'` (`chatController.ts:1020-1023`) не затирать `this.lastInit.model`, если сессия сама эмитит актуальный `session.init` или выбросила ошибку, и вызывать обновление `contextUsage()` для сессий, где `setModel` не эмитит `context.usage` сам (Claude).
- [x] В `src/webview/hudState.ts`, `src/webview/hudView.ts`, `src/webview/store.ts`, `src/webview/components/Composer.tsx` и `src/webview/strings*.ts`:
  - в `applyHud` (`hudState.ts:293-305`): при `e.maxTokens === 0` очищать `max` (и `contextWindow`) вместо удержания `prev?.max`, сохраняя прежнее поведение `e.maxTokens === undefined → prev?.max` для промежуточных событий Claude;
  - в `store.ts:317-323` (`contextShown`) и `hudView.ts:111-164` (`contextView`): исключить подстановку выдуманных `200 000` при `thresholds.length === 0` и неизвестном потолке (`s.context?.max === undefined && s.contextWindow === undefined`) — при `used === 0` скрывать индикатор, а при `used > 0` и неизвестном окне рендерить в `Composer.tsx` только загруженные токены (`81 379` / `81k`) без `/ 200k`, кольца `%` и полосы заполнения;
  - обновить `ui.compose.ctxTitleOpen` в `src/webview/strings.ts` и `src/webview/strings.en.ts` (и вызов в `hudView.ts:161`), чтобы тултип шкалы без порогов явно показывал загруженное, остаток и потолок окна (например: `Контекст: загружено 81k · осталось 919k из 1M` / `Context: 81k loaded · 919k left of 1M`).
- [x] Добавить и обновить тесты в `src/webview/hudState.test.ts`, `src/webview/hudView.test.ts`, `src/webview/engineDom.test.ts` (раскладки Composer для Antigravity с известным окном, переключением `1M → 200k → неизвестная модель` и тултипом остатка) и `src/extension/chatController.test.ts`.

**Готово, когда:** `TZ=UTC npm run check` зелёный (typecheck, lint, все unit/DOM-тесты и сборка esbuild).

**Исполнение:** T3 `delegate_task` (`providerInstanceId: "antigravity"`, `model: "claude-sonnet-5-5"`, `options: { thinking_level: "medium" }`, `isolation: "shared"`; резерв в пуле Gemini — `gemini-4-carbon` с `thinking_level: "medium"`); последовательно после этапа 2 (самый чувствительный этап из-за чужого WIP в 5 файлах и DOM-тестов; использует отдельный нетронутый пул лимитов Claude/GPT без `high` и без `opus`).

### 4. Документация, дымовая/интеграционная проверка и финализация

- [x] Обновить `docs/antigravity-protocol.md`, `README.md` и `README.ru.md` (не затрагивая чужие незакоммиченные блоки других задач): описать расчёт заполнения контекста по хвосту `transcript.jsonl` с одношаговым ACP-фолбэком, таблицу окон моделей (`1M` / `200k` / `128k`), сохранение контекста и мгновенный пересчёт остатка при переключении модели, а также фактический статус `/compact` по итогам этапа 2. Убрать устаревшую строку ограничения «Нет кольца заполнения контекста».
- [x] Дополнить opt-in скрипт `scripts/agy-smoke.mjs` проверкой прихода `context.usage` после тестового хода и пересчёта `maxTokens` после `session.setModel('claude-sonnet-5-5')`.
- [x] Прогнать `TZ=UTC npm run check`, `npm run test:integration`, opt-in `node scripts/agy-smoke.mjs` (при активной авторизации `agy`) и `git diff --check`; записать чеклист ручной проверки в VS Code (5 коротких пунктов).

**Готово, когда:** `TZ=UTC npm run check`, `npm run test:integration` и `git diff --check` завершаются с кодом `0`; документация синхронизирована с реализацией.

**Исполнение:** T3 `delegate_task` (`providerInstanceId: "antigravity"`, `model: "gemini-3.8-flash"`, `options: { thinking_level: "low" }`, `isolation: "shared"`); последовательно после этапа 3 (документация, точечный ассерт в smoke-скрипте и финальный прогон команд с минимальным расходом квоты).

## Промты исполнителей

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: реализовать чистый модуль съёма контекста Antigravity `src/agent/antigravity/context.ts` и таблицу размеров контекстного окна `agyContextWindow` в `src/agent/antigravity/models.ts` с полным покрытием unit-тестами.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/37-antigravity-context.md (разделы «Контекст и ограничения» и «Этап 1»);
- src/agent/antigravity/models.ts:1-80, src/agent/antigravity/models.test.ts;
- src/agent/antigravity/acpMapper.ts:12-23, src/agent/types.ts (тип AgentEventOf<'context.usage'> и TokenUsage);
- src/webview/toolView.ts:263-276 и src/webview/toolView.test.ts.

Уже решено:
- `agyContextWindow(model)`: снимает суффикс `-low|-medium|-high`; для `gemini-*` возвращает `1_000_000`, для `claude-*` — `200_000`, для `gpt-oss-120b*` — `128_000`, иначе `undefined`.
- `readLastTranscriptUsage(sessionId, dataDir?)`: проверяет строгий UUID `sessionId`, читает с конца файла не более `64 * 1024` байт `<dataDir>/brain/<sessionId>/.system_generated/logs/transcript.jsonl` (если чтение началось не с 0-го байта — первую неполную строку до `\n` отбрасывает), находит последнюю валидную JSON-строку `type === 'PLANNER_RESPONSE'` и `status === 'DONE'` с числовыми токенами и возвращает `{ stepIndex, usedTokens }`, где `usedTokens = input_tokens + cache_read_tokens + (cache_write_tokens ?? 0) + output_tokens`. Любая ошибка ФС/парсинга возвращает `undefined` без исключений.
- `buildAgyContextUsage(usedTokens, model)`: при известном `max = agyContextWindow(model)` возвращает `{ type: 'context.usage', usedTokens, maxTokens: max, percentage: Math.min(100, (usedTokens / max) * 100), source: 'usage' }`; при `max === undefined` возвращает `{ type: 'context.usage', usedTokens, maxTokens: 0, source: 'usage' }`.

Не делать: не трогать `adapter.ts`, `features.ts`, `chatController.ts`, `store.ts`, `hudState.ts`, `README*`; ничего не писать в реальный `~/.gemini`.

Порядок:
1. Добавить `agyContextWindow` в `src/agent/antigravity/models.ts` и тесты в `models.test.ts` + кейс `gemini-4-carbon-medium` в `src/webview/toolView.test.ts`.
2. Реализовать `src/agent/antigravity/context.ts` и `src/agent/antigravity/context.test.ts` (на временных папках в `os.tmpdir()`).
3. Прогнать проверки и отметить чекбоксы этапа 1 в `docs/roadmap/37-antigravity-context.md`.

DoD и проверка:
- `npx vitest run src/agent/antigravity/context.test.ts src/agent/antigravity/models.test.ts src/webview/toolView.test.ts` (код 0);
- `npm run typecheck` (код 0).

Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: подключить расчёт контекста, пересчёт окна и защиту от ошибок при `setModel` (плюс проверку `/compact`) в `AntigravityAdapter` и `ANTIGRAVITY_FEATURES`.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/37-antigravity-context.md (раздел «Этап 2»);
- src/agent/antigravity/context.ts, src/agent/antigravity/models.ts;
- src/agent/antigravity/adapter.ts:64-95,180-206,502-576,594-765;
- src/agent/antigravity/adapter.test.ts, src/agent/antigravity/fakeServer.ts, src/agent/features.ts:105-131.

Уже решено:
- Проверить во временном `/tmp` на `gemini-3.8-flash` (`thought_level: "low"`), сжимает ли `agy acp` беседу по `session/prompt` с текстом `"/compact"`; временную папку удалить. Включать `ANTIGRAVITY_FEATURES.compact = true` и `AgySession.compact()` только при подтверждённом нативном сжатии.
- Включить `ANTIGRAVITY_FEATURES.context = true`. Добавить опциональный `dataDir?: string` в `AntigravityAdapterConfig` для изоляции тестов от `~/.gemini`.
- Эмитить `context.usage`: 1) в конце `handshake` (прочитав хвост `transcript.jsonl` для `sessionId`; при отсутствии записи `usedTokens = 0`, эмитить если `usedTokens > 0` или окно модели известно); 2) на `tool_call` по ходу выполнения (если в `transcript.jsonl` появился новый `stepIndex`) и после ответа `session/prompt` (до 2 ретраев по 80 мс, если `stepIndex` ещё не вырос; если транскрипта нет — брать сумму `result.usage` только при 0 `tool_call` за ход); 3) в `loadHistory` (в конец `history.events`, если есть `usedTokens` в транскрипте).
- В `setModel`: при отказе RPC эмитить `{ type: 'error', fatal: false, message }`, перевыпускать `session.init` с фактическими `config.model.current` и `effort` и пробрасывать ошибку; при успехе — перевыпускать `session.init` с нормализованной моделью и актуальным `effort` и сразу эмитить `context.usage` с прежним `usedTokens` и `maxTokens` новой модели.

Не делать: не менять `chatController.ts`, `hudState.ts`, `hudView.ts`, `store.ts` (это этап 3) и не трогать чужие незакоммиченные файлы.

Порядок:
1. Выполнить одноразовую проверку `/compact` в `/tmp` и зафиксировать решение по `compact`.
2. Обновить `src/agent/features.ts` и `src/agent/antigravity/adapter.ts`.
3. Покрыть все сценарии в `src/agent/antigravity/adapter.test.ts` и отметить чекбоксы этапа 2 в `docs/roadmap/37-antigravity-context.md`.

DoD и проверка:
- `npx vitest run src/agent/antigravity/` (код 0);
- `npm run typecheck` (код 0).

Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано (включая вердикт по `/compact`), отклонения, непроверенное, открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: довести `ChatController` и HUD webview для корректного показа загруженного и оставшегося контекста Antigravity, мгновенного обновления при смене модели и честного отображения моделей с неизвестным окном.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/37-antigravity-context.md (раздел «Этап 3»);
- src/extension/chatController.ts:322,597-603,1020-1032,1440-1445,1771-1784;
- src/agent/claude/adapter.ts:753-782;
- src/webview/hudState.ts:16-22,84-90,130-133,293-305;
- src/webview/hudView.ts:111-164;
- src/webview/store.ts:317-324,441-447,1045-1048;
- src/webview/components/Composer.tsx:1083-1115,1793-1855;
- src/webview/strings.ts и src/webview/strings.en.ts (`compose.ctxTitleOpen`).

Уже решено:
- В рабочем дереве есть незакоммиченные правки в `chatController.ts`, `hudState.ts`, `store.ts`, `engineDom.test.ts`, `strings*.ts` — править минимально, чужие блоки не трогать.
- `ChatController`: сохранять `this.lastContext` для всех `!e.agentId` (не только `source === 'engine'`), а бюджет вложений `attachTokenBudget` считать только при `maxTokens > 0`; в `model.set` вызывать обновление `contextUsage()` для Claude и не перезаписывать `lastInit.model` поверх `session.init` / при ошибке `setModel`.
- `applyHud`: `e.maxTokens === 0` сбрасывает `max` и `contextWindow`; `e.maxTokens === undefined` по-прежнему сохраняет `prev?.max` (не ломать `hudState.test.ts:191`).
- При `thresholds.length === 0` и неизвестном окне (`max === undefined`): при `used === 0` `contextShown` равен `false`; при `used > 0` показывать загруженные токены без `/ 200 000`, без `%`-кольца и без полосы.
- `ui.compose.ctxTitleOpen` принимает загруженное, остаток и размер окна (RU/EN), чтобы в тултипе было видно и сколько загружено, и сколько осталось.

Порядок:
1. Внести точечные правки в `chatController.ts` и `claude/adapter.ts` (если требуется для обновления окна при `setModel`).
2. Обновить `hudState.ts`, `hudView.ts`, `store.ts`, `Composer.tsx`, `strings.ts`, `strings.en.ts`.
3. Дополнить `hudState.test.ts`, `hudView.test.ts`, `engineDom.test.ts`, `chatController.test.ts`, прогнать полную проверку и отметить чекбоксы этапа 3 в roadmap.

DoD и проверка:
- `TZ=UTC npm run check` (код 0).

Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura (или выданном git worktree). Задача: обновить документацию протокола и README, расширить `scripts/agy-smoke.mjs` и провести финальную приёмку.

Читай:
- /Users/fost/Projects/CLAUDE.md, AGENTS.md, .codex/WORKFLOW.md;
- docs/roadmap/37-antigravity-context.md (раздел «Этап 4» и итоги этапов 1–3);
- docs/antigravity-protocol.md:1-155, README.md, README.ru.md:211-253, scripts/agy-smoke.mjs.

Уже решено:
- В `README.md` и `README.ru.md` уже есть незакоммиченные правки соседних задач — редактировать строго подраздел Antigravity.
- Честно описать в `docs/antigravity-protocol.md` узкое read-only чтение хвоста `brain/<sessionId>/.system_generated/logs/transcript.jsonl` для `usedTokens` (и одношаговый фолбэк из ACP `usage`), маппинг окон моделей (`1M`, `200k`, `128k`), мгновенный пересчёт остатка при смене модели без потери серверного контекста и фактический статус `/compact`.

Порядок:
1. Обновить `docs/antigravity-protocol.md`, `README.md`, `README.ru.md` и `scripts/agy-smoke.mjs`.
2. Выполнить `TZ=UTC npm run check`, `npm run test:integration`, `git diff --check` (и `node scripts/agy-smoke.mjs`, если `agy` залогинен).
3. Отметить чекбоксы этапа 4 в `docs/roadmap/37-antigravity-context.md` и вывести короткий чеклист ручной проверки в VS Code (5 пунктов).

DoD и проверка:
- `TZ=UTC npm run check` (код 0);
- `npm run test:integration` (код 0);
- `git diff --check` (код 0).

Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, результаты всех проверок, чеклист ручной приёмки.
```

## Риски и открытые вопросы

- **Смена внутреннего пути или схемы `transcript.jsonl` в будущих версиях `agy`:** закрывается чтением в единственном модуле `src/agent/antigravity/context.ts` с мягкой деградацией на одношаговый `session/prompt.result.usage` (чат не падает, ошибки пользователю не сыпятся).
- **Задержка сброса буфера `transcript.jsonl` на диск относительно ответа `session/prompt`:** закрывается проверкой роста `stepIndex` с коротким ограниченным ретраем (`2 × 80 мс`) и неблокирующим обновлением.
- **Изменение размеров контекстного окна у новых моделей в каталоге `agy`:** для известных семейств используется `agyContextWindow`, а для незнакомых будущих ID возвращается `maxTokens: 0` (показывается только фактический `usedTokens` без ложного потолка `200k`).
- **Пересечение с грязным рабочим деревом (`chatController.ts`, `hudState.ts`, `store.ts`, `engineDom.test.ts`, `strings*.ts`, `README*.md`):** этапы 3–4 вносят минимальные локальные правки без автоформатирования целых файлов; при запуске параллельно с другими агентами работа ведётся в отдельном worktree с последующей аккуратной интеграцией.

## Порядок работы

Все этапы `1 → 2 → 3 → 4` выполняются строго **последовательно**: этап 2 импортирует контракты этапа 1, этап 3 связывает события этапа 2 с контроллером и HUD webview, этап 4 документирует и проверяет собранное решение целиком.

Для экономии лимитов вместо слепого наследования модели основного чата (`Model: "inherit"`) каждый этап запускается в T3 Code через `delegate_task` (`providerInstanceId: "antigravity"`, `isolation: "shared"`) с явно заданными моделью и `options.thinking_level`, распределяя нагрузку между двумя независимыми пулами квот `agy` и исключая тяжёлые модели (`gemini-4-argon`, `claude-opus-5-5`):

| Этап | Задача | Модель (`antigravity`) | `thinking_level` | Пул квоты и обоснование |
| :--- | :--- | :--- | :--- | :--- |
| **1** | Чистые функции `context.ts` + `agyContextWindow` + unit-тесты | `gemini-3.8-flash` | `medium` | **Gemini** — изолированный детерминированный код без архитектурных развилок |
| **2** | `AntigravityAdapter`, проверка `/compact`, `setModel`, `adapter.test.ts` | `gemini-3.8-flash` | `high` | **Gemini** — проверенная в Roadmap 36 связка для ACP-адаптера и async-тестов без траты Carbon/Argon |
| **3** | `ChatController` + HUD webview (5 файлов с чужим WIP + DOM-тесты) | `claude-sonnet-5-5` *(резерв: `gemini-4-carbon`)* | `medium` | **Claude/GPT** — разгружает пул Gemini (берёт из 100% пула Claude/GPT) и снижает риск повторного прогона на грязных файлах |
| **4** | Документация, `agy-smoke.mjs` и финальные проверки | `gemini-3.8-flash` | `low` | **Gemini** — правка текстов по готовым фактам и запуск команд DoD с минимальным расходом токенов |

Оркестрация и независимая приёмка по DoD (сверка `git diff` и запуск проверок с записью секции `Checkpoint` в этот файл) ведутся в основном чате; при мелком замечании приёмки основной чат правит его сам без повторного запуска делегата. Коммит, сборка `.vsix` и push не выполняются без отдельного указания пользователя.
