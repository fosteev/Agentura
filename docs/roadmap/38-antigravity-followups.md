# 38. Antigravity (`agy acp`): ретраи, команды, квота `/usage`, инструменты, наследование прав и граф субагентов `1.5.6`

> Статус: выполнено · 2026-11-13. Все 6 этапов (`1 → 2 → 3 → 4 → 5 → 6`) реализованы и приняты независимой проверкой.

## Checkpoint

**2026-11-13 · принят Этап 6 / 6 (`roadmap-run-agy` завершён).**

- Принятые этапы: `6 / 6` (`Этап 1` с 1-й попытки; `Этап 2` со 2-й попытки; `Этап 3` с 1-й попытки; `Этап 4` с 1-й попытки; `Этап 5` с 1-й попытки; `Этап 6` с 1-й попытки).
- Изменённые файлы по этапам:
  - Этап 1: `src/shared/l10n.ts`, `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/acpMapper.test.ts`, `src/webview/chatState.ts`, `src/webview/chatState.test.ts`.
  - Этап 2: `src/agent/antigravity/{acpProtocol,adapter,executable,fakeServer,models,quota}.ts`, `src/extension/{agyQuota,engineLimits,extension,chatPanel,sidebarView,chatController}.ts`, `src/protocol.ts`, `src/webview/{store,hudView}.ts`, `src/webview/components/{Composer,EngineLimits}.tsx` + `*.test.ts`.
  - Этап 3: `src/agent/antigravity/{tools,acpMapper,history,adapter}.ts`, `src/webview/{toolView,markdown}.ts`, `src/extension/chatController.ts` + `*.test.ts`.
  - Этап 4: `src/agent/antigravity/{acpProtocol,sessionIndex,adapter,fakeServer,adapter.test}.ts`.
  - Этап 5: `src/agent/antigravity/{subagents,subagents.test,adapter,adapter.test,history,history.test}.ts`, `src/agent/{features,features.test}.ts`, `src/webview/{hudState,hudState.test}.ts`.
  - Этап 6: `docs/antigravity-protocol.md`, `README.md`, `README.ru.md`, `scripts/agy-smoke.mjs`, `src/shared/l10n.ts` (`typeof detail !== 'string'` в `compactApiRetryDetail` для фазз-теста `l10n.test.ts`).
- Ветка / worktree / `cwd`: ветка `main` (`origin/main` на `98a5616`), основной worktree, подтверждённый `cwd`: `/Users/fost/Projects/Agentura`.
- Выполненные финальные проверки приёмки (основной чат):
  - `TZ=UTC npm run check` — код `0` (`tsc --noEmit`, `eslint .`, `vitest run` — 163 файла / 2401 тест, `esbuild.mjs`);
  - `npm run test:integration` — код `0` (`extension.test.js` в VS Code Extension Host);
  - `node scripts/agy-smoke.mjs` — код `0` (`agy 1.5.7`, `session.init slashCommands (89)`, `context.usage` `1M ↔ 200k ↔ 1M`, без расхода генерационной квоты и без оставшихся процессов);
  - `git diff --check` — код `0`.
- Конфигурация запуска: основной чат AGY CLI — `Gemini 4 Carbon (Medium)` (`fa861d57-7ced-4ee4-a717-33c7361cca46`); субагенты-исполнители (`invoke_subagent`, `TypeName: "self"`, `Model: "inherit"`, `Workspace: "inherit"`): Этап 1 — `3768df2c-912e-490e-95e7-f7fb34688583`, Этап 2 — `7c0d2ead-f343-41b8-8f99-90fde38cf8d3`, Этап 3 — `c376a54f-80a7-42e0-92d6-223ba479e1a9`, Этап 4 — `1de9d6b8-e193-4551-8e24-4128fc41764f`, Этап 5 — `d855962d-f7a5-43e1-b857-203c7537d41f`, Этап 6 — `394ebe23-478a-489a-a3ce-ad574d0a6e27`.
- Dirty / unpushed: `M docs/roadmap/38-antigravity-followups.md`, файлы Этапов 1–6 (`M` + новые `src/agent/antigravity/subagents.ts` и `src/agent/antigravity/subagents.test.ts`), чужие untracked файлы `?? .codex/config.toml` и `?? docs/roadmap/39-kimi-code-support.md` сохранены без изменений. Коммит, сборка `.vsix` и push не выполнялись.
- Блокер: нет.
- Следующий шаг: ручная проверка по 6-пунктовому чеклисту в Extension Development Host (`F5`), затем коммит / сборка `.vsix` по явному запросу пользователя.
- Промт кросс-клиентской финальной приёмки: `В /Users/fost/Projects/Agentura проверь полный git diff по docs/roadmap/38-antigravity-followups.md и прогони TZ=UTC npm run check && npm run test:integration && node scripts/agy-smoke.mjs && git diff --check.`

## Цель и границы

Довести поддержку Antigravity (`agy acp`) в Agentura до полного рабочего состояния на реальных сценариях `agy 1.5.6`:
1. Убрать склейку транзиентных сетевых ретраев `⚠ API error (attempt N): ...` с текстом ответа ассистента — переводить их в штатную сворачиваемую строку `api_retry`.
2. Подхватить внеходовые уведомления (`available_commands_update` для меню `/` и поздний `session_info_update` для авто-заголовка чата), защитить парсеры моделей/квоты (`gemini-4-carbon`, `\r`-спиннер, именные пулы Gemini) и починить диагностику/обновление лимитов `/usage` (`AgyQuotaService`, `summarizeAgy`, HUD), чтобы ошибки `agy -p "/usage"` (`Eligibility check failed` на `aicode.googleapis.com`) не глотались молча на 10 минут и не вешали вечный `loading`.
3. Отображать `oneharness`-инструменты `agy` (eager/lazy MCP с точным разрезом имени сервера по `<dataDir>/mcp`, оркестрацию `invoke_subagent`/`manage_subagents`/`send_message`/`manage_task`/`schedule`/`swarm`) штатными карточками ленты и открывать ссылки `conversation://<uuid>` во вкладке чата Agentura.
4. Реализовать наследование прав родителя дочерними субагентами (`agy acp --dangerously-skip-permissions` при `bypassPermissions` с прозрачным перезапуском через `session/resume` на `setMode`), аккуратную обработку серверного режима `auto` (`agy >= 1.5.4`) без круговой перезаписи в `'accept-edits'` и доставку реактивного пробуждения родителя (`wakeup`) после завершения фоновых субагентов/задач.
5. Включить полноценный живой граф субагентов, вкладку «агенты», инлайн-группу `AgentGroup`, историю и просмотр транскриптов (`ANTIGRAVITY_FEATURES.subagents = true`, `agentTranscript = true`) на базе связки `invoke_subagent` (ACP) + инкрементального read-only чтения дочерних `brain/<childUuid>/.system_generated/logs/transcript.jsonl` (включая вложенных субагентов, индикацию `waiting_for_input` и повторное обращение к субагенту через `send_message`).
6. Синхронизировать `docs/antigravity-protocol.md`, `README.md`, `README.ru.md` и `scripts/agy-smoke.mjs`.

**Вне скоупа:** оценка стоимости в USD (`agy acp` не передаёт цены), нативные карточки утверждения плана (`create_plan` в `agy` отсутствует), PDF-вложения (`promptCapabilities` не поддерживает `document`), инлайн-карточки `session/request_permission` от фоновых субагентов в режиме `default` (сервер `agy acp` не пересылает их в родительский stdio-поток), кнопка `■ Stop` на отдельном узле субагента (`agentStop: false` — в ACP нет клиентского RPC остановки отдельного дочернего `conversationId`), визуализация `swarm`-доски в графе (до отдельного спайка живых фикстур `swarm`).

## Контекст и подтверждённые факты

- **Базовый коммит:** Roadmap 37 (`context.ts`, `agyContextWindow`, `/compact`, пересчёт контекста на `setModel`) уже влит и запушен в `main` (`754b4b8`). Рабочее дерево чистое (локальный `.codex/config.toml` не коммитить).
- **Склейка `⚠ API error (attempt N)` с ответом (Этап 1):**
  - Бинарник `agy` (`1.5.3`–`1.5.6`) при транзиентном обрыве запроса к Cloud Code (`connection reset by peer`, `timeout`, `HTTP 429/5xx`) шлёт строку `"\n⚠ API error (attempt %d): %v\n"` обычным кадром `session/update` с `sessionUpdate: "agent_message_chunk"` (в `stderr` и `transcript.jsonl` строка не попадает; на диске фиксируется пустой `ERROR_MESSAGE`).
  - `AgyAcpMapper.applyUpdate` (`src/agent/antigravity/acpMapper.ts:69-77`) безусловно клеит любой `agent_message_chunk` в `text.delta` и `this.text`, вклеивая сетевую ошибку прямо в абзац ответа.
  - В `src/webview/chatState.ts:706,765-772` уже есть штатный механизм схлопывания `{ type: 'error', fatal: false, code: 'api_retry', message }` в строку `tag: 'retry'`, но сама `retryRow` сейчас не закрывает открытую стримящуюся строку текста (`streaming: false`), в отличие от `tool.start` (`src/webview/chatState.ts:579-581`).
- **Потеря внеходовых уведомлений `available_commands_update`, `session_info_update` и реактивного `wakeup` (Этапы 2 и 4):**
  - В `AgySession.onNotification` (`src/agent/antigravity/adapter.ts:970-980`) стоит жёсткая отсечка `if (this.closed || this.loading || method !== 'session/update') return;` и `if (!turn || turn.done.settled) return;`.
  - Из-за этого:
    1. теряется `available_commands_update` (приходит сразу на `session/new` и `session/resume`, пока `this.loading === true` и `!this.turn`), а `buildSessionInit().slashCommands` всегда `[]` (`adapter.ts:788`) → меню `/` в `Composer.tsx:402` пустое;
    2. теряется `session_info_update` (`handleSummariesUpdate → sendSessionInfoUpdate` в `agy`), когда сгенерированный заголовок беседы прилетает через 100–500 мс после завершения `session/prompt` (`!this.turn`);
    3. при фоновом завершении `invoke_subagent` или `run_command`-задачи (`task-N`), если родительский `session/prompt` уже закрылся с `end_turn`, а сервер `agy acp` досылает реактивное пробуждение родителя через `sendStateStepUpdates` без нового клиентского `session/prompt`, `onNotification` молча отбрасывает весь ответный ход родителя.
- **Почему перестают обновляться лимиты `/usage` и рвутся пулы Gemini (Этап 2):**
  - Вызов `/usage` через `session/prompt` в `agy acp` не перехватывается локально (уходит промптом в LLM и тратит квоту); единственный штатный канал — `agy -p "/usage"` (`src/agent/antigravity/quota.ts:83-101`).
  - В `agy 1.5.6` `printmode` (`agy -p`) перед `/usage` проверяет `printmode.waitForEligibility` на хосте **`aicode.googleapis.com`**, тогда как сам чат `agy acp` работает через **`daily-cloudcode-pa.googleapis.com`**. При расхождении маршрутов в split-tunnel VPN `agy -p "/usage"` падает с кодом `1` и `stderr`: `error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.`
  - `AgyQuotaService.fetchOnce` (`src/extension/agyQuota.ts:48-65`) глотает сбой пустым `catch {}` без уведомления подписчиков, блокирует повтор на 10 минут (`AGY_QUOTA_INTERVAL_MS`), а `summarizeAgy` (`src/extension/engineLimits.ts:29-46`) при `updatedAt === 0` держит вечный `state: 'loading'`. В `parseModels` и `parseAgyUsage` `.replace(/\r$/, '')` не счищает промежуточный спиннер `\r⠋ Fetching...\r`, а `parseFamily` (`quota.ts:18-23`) и `hudView.ts:301-305` сливают `Gemini 4 Carbon` с общим `Gemini Models` в один ключ `'Gemini'`.
- **Инструменты `oneharness`, разделитель MCP и ссылки `conversation://` (Этап 3):**
  - В `agy` eager MCP-инструменты именуются с **одинарным** `_`: `mcp_<serverName>_<toolName>`, причём сам `<serverName>` содержит `_` и `-` (реальные примеры из `~/.gemini/antigravity-cli/mcp/`: `hansard_history` → `mcp_hansard_history_search_past_sessions`, `gemini-api_gemini-api-docs` → `mcp_gemini-api_gemini-api-docs_gemini_search_docs`, `flutter_dart-mcp-server`). Все настроенные имена серверов лежат именами подпапок в `<dataDir>/mcp/<serverName>`, что даёт точный разрез по самому длинному префиксу без угадывания.
  - Ссылки `[Role](conversation://<uuid>)` режутся `DOMPurify` в `src/webview/markdown.ts:35-40` и отклоняются в `src/extension/chatController.ts:825-830`, хотя `deps.openSession(uuid, 'antigravity')` (`chatPanel.ts:958`) уже умеет открывать любую сессию во вкладке.
- **Наследование прав субагентами и ловушка режима `'auto'` (Этап 4):**
  - В `agy acp` канал `session/request_permission` закрывается при завершении родительского `session/prompt` и не пробрасывает запросы от фоновых дочерних `conversationId` — в режиме `default` субагент на первом `run_command` встаёт в `waiting_for_input`.
  - В `bypassPermissions` адаптер сейчас спавнит `['acp']` без флагов (`adapter.ts:420`) и ставит `'accept-edits'` (`acpProtocol.ts:201`), авто-отвечая на команды только у родителя (`adapter.ts:1005`), из-за чего дочерние субагенты виснут на первой команде. Флаг `agy acp --dangerously-skip-permissions` включает авто-одобрение на стороне бэкенда `agy` и **наследуется всеми дочерними субагентами и git worktree** (системный denylist опасных команд и явные `Deny`-правила продолжают действовать).
  - В `agy >= 1.5.4` сервер объявил 4-й режим `auto`. Так как `PermissionMode` в `src/agent/types.ts:38` содержит только `'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`, при `session/resume` без явно запрошенного `options.permissionMode` нельзя слепо гнать `permissionModeOf('auto') → 'acceptEdits' → syncInitialMode() → 'accept-edits'`, иначе адаптер собьёт серверный `'auto'`.
- **Данные для живого графа субагентов на диске и точный контракт UI (Этап 5):**
  - Подтверждено на реальных сессиях `~/.gemini/antigravity-cli/brain/`:
    1. В родительском ACP-потоке приходит `tool_call` `invoke_subagent` с аргументами `{ Role, TypeName, Prompt, Model }`, а через ~1 с `tool_call_update` (`completed`) возвращает JSON `Created the following subagent:\n{\n  "conversationId": "<child-uuid>",\n  "logAbsoluteUri": "file:///.../brain/<child-uuid>/.system_generated/logs/transcript.jsonl"\n}`.
    2. Дочерний субагент пишет компактный построчный `brain/<child-uuid>/.system_generated/logs/transcript.jsonl`: шаг `0` — `SYSTEM_MESSAGE` (`sender=<parent-uuid>`), далее `PLANNER_RESPONSE` (`thinking`, `tool_calls`, `input_tokens`, `cache_read_tokens`, `output_tokens`) и ответные `GENERIC` (`output` / `Created At` / `Command exited with code N` / `Tool is running as a background task with task id: <uuid>/task-N`).
    3. В UI Agentura (`src/webview/agentsView.ts:145-147`, `src/webview/hudState.ts:227-288,433-442`, `src/extension/chatController.ts:784-799`):
       - инлайн-группа `AgentGroup` связывает строку инструмента `Agent` с узлом `HudState.agents` строго по **`agentId === toolRow.toolUseId`** (`toolCallId` вызова `invoke_subagent`);
       - клик по «транскрипт» передаёт в `adapter.agentTranscript(sessionId, cwd, taskId, title)` поле **`taskId`** → значит, **`taskId` обязан быть равен `<child-uuid>`**;
       - при **`background: true`** завершение родительского хода (`turn.result` в `hudState.ts:433`) **не** останавливает бегущих субагентов — они продолжают обновляться в графе и шапке между ходами;
       - при повторном сообщении тому же субагенту (`send_message(Recipient: childUuid)`) `updateAgent` в `hudState.ts:237-249` сейчас не сбрасывает `status: 'running'` и `endedAt: undefined` у завершённого узла — нужна точечная правка в `hudState.ts`.

## Принятые решения

- **Событие ретрая:** без новых типов `AgentEvent` — эмитить `{ type: 'error', fatal: false, code: 'api_retry', message }` и закрывать `streaming: true` текстовые блоки в `retryRow` (`chatState.ts`).
- **Модель состояний `AgyQuotaService`:** по образцу `CodexLimitsService` (`state: 'loading' | 'ok' | 'signedOut' | 'missing' | 'error'`, `error?: string`, сохранение кэша `rows`/`updatedAt` при транзиентной ошибке, короткий кулдаун `AGY_QUOTA_ERROR_COOLDOWN_MS = 60_000` вместо 10 минут, `refresh(force?: boolean)` для кнопки ручного обновления).
- **Разрез имён MCP (`mcp_<server>_<tool>`):** один раз за жизнь адаптера/сессии читать список подкаталогов `<dataDir>/mcp` (без ошибок при отсутствии папки), сортировать по убыванию длины и матчить `mcp_<server>_<tool>` по самому длинному известному `<server>`; при отсутствии списка использовать фолбэк по первому `_`.
- **Режим `'auto'` и `--dangerously-skip-permissions`:**
  - `PermissionMode` в `types.ts` не ломаем (не тащим специфику `agy` во все провайдеры). В `AgySession` храним флаг `explicitMode`: если при `resumeSession` режим не задан явно и сервер вернул `currentModeId === 'auto'`, UI показывает `acceptEdits`, но `syncInitialMode()` не перезаписывает серверный `'auto'`.
  - При `permissionMode === 'bypassPermissions' && allowBypass` процесс запускается как `['acp', '--dangerously-skip-permissions']`; переключение `setMode` между ним и остальными режимами прозрачно перезапускает воркер через `session/resume` вне активного хода (или сразу по завершении текущего хода).
- **Архитектура графа субагентов Antigravity (`src/agent/antigravity/subagents.ts`):**
  - Изолированное read-only инкрементальное чтение компактных файлов `<dataDir>/brain/<childUuid>/.system_generated/logs/transcript.jsonl` с курсором байтового смещения `byteOffset` (строгая проверка UUID, никаких SQLite и `transcript_full.jsonl`, никаких записей в `~/.gemini`).
  - Контракт идентификаторов: для субагентов верхнего уровня `agentId = toolCallId` (вызова `invoke_subagent`), `taskId = childUuid`, `taskType = 'subagent'`, `background = true`; для вложенных субагентов внутри дочернего транскрипта — `agentId = "agy-sub:<childUuid>:<stepIndex>"`, `taskId = nestedChildUuid`, `parentAgentId = parentAgentId`; для фоновых shell-задач внутри субагента (`task id: <uuid>/task-N`) — `taskType = 'local_bash'`, `parentAgentId`.
  - `ANTIGRAVITY_FEATURES`: `subagents = true`, `agentTranscript = true`, `agentStop = false`.

---

## Этапы

### 1. Перехват транзиентных ретраев `agy acp` (`⚠ API error (attempt N)`) в `api_retry`

**Файлы:** `src/shared/l10n.ts`, `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/acpMapper.test.ts`, `src/webview/chatState.ts`, `src/webview/chatState.test.ts`.

- [x] Добавить в `src/shared/l10n.ts` (RU/EN) форматтер `agyApiRetry(attempt: number, detail?: string)` с компактным извлечением сути сетевого сбоя (`connection reset by peer`, `i/o timeout`, `HTTP 429/5xx`, без полных URL `https://daily-cloudcode-pa...`).
- [x] В `AgyAcpMapper.applyUpdate` (`src/agent/antigravity/acpMapper.ts:69-77`) перед эмитом `text.delta` разбирать в `agent_message_chunk` вхождения `\n?⚠ API error \(attempt (\d+)\): ([^\n]+)\n?`:
  - одиночный чанк ретрая закрывает открытый `thinking`, сбрасывает `this.messageId = ''`, **не** пишется в `this.text` и эмитит `{ type: 'error', fatal: false, code: 'api_retry', message }`;
  - консолидированный чанк с обычным текстом вокруг предупреждения отдаёт текст до и после отдельными `text.delta` (с новым `messageId` после `api_retry`), а строку предупреждения уводит только в `api_retry` и вырезает из `this.text` (`turn.result.text`);
  - обычный текст модели (включая `⚠` без шаблона `⚠ API error (attempt N): `) передаётся без изменений.
- [x] В `retryRow` (`src/webview/chatState.ts:765-772`) при создании новой строки `tag: 'retry'` закрывать открытые стримящиеся текстовые блоки (`r.kind === 'text' && r.streaming ? { ...r, streaming: false } : r`), сохраняя схлопывание подряд идущих `api_retry` в одну плашку.
- [x] Покрыть unit-тестами в `acpMapper.test.ts` и `chatState.test.ts`: ретрай до ответа, серия `attempt 1` + `attempt 2`, ретрай между двумя кусками стрима, обычный ответ с `⚠`.

**Готово, когда:** `npx vitest run src/agent/antigravity/acpMapper.test.ts src/webview/chatState.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** сетевой ретрай в ходе Antigravity рисуется компактной нейтральной строкой повтора, а в тексте ответа нет склеенного `⚠ API error (attempt 1): Post ...`.

**Зависимости:** нет (первый этап).

---

### 2. Внеходовые уведомления (`available_commands_update`, `session_info_update`), парсеры `1.5.6` и диагностика сбоев `/usage`

**Файлы:** `src/agent/antigravity/acpProtocol.ts`, `src/agent/antigravity/adapter.ts`, `src/agent/antigravity/adapter.test.ts`, `src/agent/antigravity/fakeServer.ts`, `src/agent/antigravity/models.ts`, `src/agent/antigravity/models.test.ts`, `src/agent/antigravity/quota.ts`, `src/agent/antigravity/quota.test.ts`, `src/extension/agyQuota.ts`, `src/extension/agyQuota.test.ts`, `src/extension/engineLimits.ts`, `src/extension/engineLimits.test.ts`, `src/extension/chatController.ts`, `src/protocol.ts`, `src/webview/hudView.ts`, `src/webview/hudView.test.ts`.

- [x] В `src/agent/antigravity/acpProtocol.ts` добавить `availableCommandsOf(update: unknown): string[] | undefined` для `sessionUpdate === 'available_commands_update'` (непустые `name` без ведущего `/`, дедупликация с сохранением порядка).
- [x] В `AgySession.onNotification` (`src/agent/antigravity/adapter.ts:970-980`) обрабатывать до проверки `this.turn`:
  - `available_commands_update` (включая фазу `this.loading` во время `handshake` и простой между ходами): сохранять команды в `this.slashCommands`, отдавать в `buildSessionInit().slashCommands` и перевыпускать `session.init`, если список изменился уже после `handshake`;
  - `session_info_update` (при `!this.loading`, даже если `!this.turn`): эмитить `{ type: 'session.title', title }`, чтобы асинхронный авто-заголовок чата от `agy` не терялся после завершения `session/prompt`.
- [x] В `parseModels` (`src/agent/antigravity/models.ts:11-20`) и `parseAgyUsage` (`src/agent/antigravity/quota.ts:47-53`) очищать прогресс TTY-спиннера по `\r` (`line.split('\r').pop() ?? ''`).
- [x] В `parseFamily` (`src/agent/antigravity/quota.ts:18-23`) и группировке квоты в `src/webview/hudView.ts:301-305` маппить в общий `'Gemini'` только общий пул (`/^gemini(?:\s+models)?$/i`), а выделенные пулы конкретных моделей (`Gemini 4 Argon`, `Gemini 4 Carbon` и др.) оставлять отдельными семействами без перезаписи кольца общего пула `Gemini`.
- [x] В `runAgyUsage` (`src/agent/antigravity/quota.ts:83-101`) захватывать `stderr` при ошибке `execFile`, очищать управляющие символы/префикс `error: ` и выбрасывать читаемый `Error` (например, `Eligibility check failed: ...`), а также добавить `isAgyAuthError(errOrOutput)` для отделения реального разлогина от региональных/сетевых ошибок `aicode.googleapis.com`.
- [x] Перевести `AgyQuotaService` (`src/extension/agyQuota.ts`) на модель состояний по образцу `CodexLimitsService`:
  - добавить в `AgyQuotaSnapshot` поля `state: 'loading' | 'ok' | 'signedOut' | 'missing' | 'error'` и `error?: string`;
  - при ошибке сохранять прежние `rows` и `updatedAt`, выставлять `state: 'error'` и `error`, уведомлять `listeners`, логировать `warn` и ставить короткий кулдаун повтора `AGY_QUOTA_ERROR_COOLDOWN_MS = 60_000` (вместо 10 минут), а также поддержать `refresh(force?: boolean)` для ручного обновления из UI (`case 'limits.refresh'` в `chatController.ts:891`);
  - не затирать непустые `this.last.rows` в `signedOut`, если процесс вернул пустой вывод без явного признака разлогина.
- [x] Обновить `summarizeAgy` (`src/extension/engineLimits.ts:29-46`), `quota.update` (`src/protocol.ts`, `src/extension/chatController.ts:1566-1571`) и `quotaView` (`src/webview/hudView.ts`), чтобы боковая панель `EngineLimits` показывала `state: 'error'` с текстом причины (вместо вечного `loading`), а HUD чата — диагностический тултип/индикатор сбоя обновления квоты.
- [x] Покрыть unit-тестами в `adapter.test.ts`, `models.test.ts`, `quota.test.ts`, `agyQuota.test.ts`, `engineLimits.test.ts` и `hudView.test.ts`.

**Готово, когда:** `npx vitest run src/agent/antigravity/ src/extension/agyQuota.test.ts src/extension/engineLimits.test.ts src/webview/hudView.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** ввод `/` показывает команды `agy`; заголовок новой сессии обновляется автоматически после первого ответа; при сбое `aicode.googleapis.com` панель лимитов сразу пишет `Eligibility check failed...` вместо бесконечной загрузки и обновляется кнопкой `↻`.

**Зависимости:** после этапа 1.

---

### 3. Инструменты `oneharness` (`MCP`, оркестрация) и открытие ссылок `conversation://<uuid>`

**Файлы:** `src/agent/antigravity/tools.ts`, `src/agent/antigravity/tools.test.ts`, `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/adapter.ts`, `src/webview/toolView.ts`, `src/webview/toolView.test.ts`, `src/webview/markdown.ts`, `src/webview/markdown.test.ts`, `src/extension/chatController.ts`, `src/extension/chatController.test.ts`.

- [x] Добавить в `src/agent/antigravity/tools.ts` read-only чтение списка известных имён MCP-серверов `readAgyMcpServers(dataDir?: string): string[]` из имён подкаталогов `<dataDir>/mcp` (отсортированных по убыванию длины; при отсутствии каталога — `[]` без ошибок) и прокинуть этот список в `AgyAcpMapper` / `mapAgyTool(agyName, params, mcpServers?)`:
  - **Lazy MCP (`call_mcp_tool`, `list_resources`, `read_resource`):** при наличии `ServerName` маппить в `mcp__<ServerName>__<ToolName>` / `list_resources` / `read_resource` с распаковкой `Arguments` (или `Uri`), чтобы `toolView` штатно рендерил чип сервера (`op: 'mcp', server`) и инкрементировал `counts.mcp`;
  - **Eager MCP (`mcp_<server>_<tool>`):** сначала искать совпадение `mcp_${server}_` по отсортированному списку `mcpServers` (чтобы `hansard_history` и `gemini-api_gemini-api-docs` не резались по внутреннему `_`), а если совпадения нет — фолбэк по первому `_` после `mcp_`;
  - **Инструменты оркестрации (`invoke_subagent`, `manage_subagents`, `send_message`, `define_subagent`, `manage_task`, `schedule`, `swarm`):** маппить `invoke_subagent` в карточку `Agent` (`{ name: 'Agent', input: compact({ description: Role ?? TypeName, prompt: Prompt, subagent_type: TypeName, model: Model }) }`), а для `manage_subagents`, `send_message`, `define_subagent`, `manage_task`, `schedule`, `swarm` формировать понятные подписи в `toolView.ts` (оставляя `read_file` на `SKILL.md` карточкой `Read`).
- [x] Поддержать открытие ссылок `conversation://<uuid>` во вкладке чата Agentura:
  - в `src/webview/markdown.ts:35-40` разрешить в `DOMPurify` схему `conversation://` наряду со стандартными безопасными URI (сохраняя жёсткий запрет на `javascript:`, `data:`, `vbscript:`, `command:`, `vscode:`);
  - в `src/extension/chatController.ts:807-839` (`case 'link.open'`) перед разбором локальных путей перехватывать строго валидированный `^conversation:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$` и вызывать `await deps.openSession?.(uuid, 'antigravity')` (отклоняя любые не-UUID хвосты и path traversal).
- [x] Покрыть тестами в `tools.test.ts`, `toolView.test.ts`, `markdown.test.ts` и `chatController.test.ts` (включая серверы с `_` и `-`: `hansard_history`, `gemini-api_gemini-api-docs`, `flutter_dart-mcp-server`, `invoke_subagent` → `Agent`, клик по валидному `conversation://<uuid>` и блокировку `conversation://../etc/passwd` / `javascript:`).

**Готово, когда:** `npx vitest run src/agent/antigravity/tools.test.ts src/webview/toolView.test.ts src/webview/markdown.test.ts src/extension/chatController.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** вызов `mcp_hansard_history_search_past_sessions` рисуется с целым чипом `hansard_history`, а клик по `[Subagent](conversation://<uuid>)` в ответе агента открывает вкладку с сессией этого субагента.

**Зависимости:** после этапа 2 (пересекается с `adapter.ts` и `chatController.ts`).

---

### 4. Наследование прав субагентами (`--dangerously-skip-permissions`), режим `auto` и реактивный wakeup родителя

**Файлы:** `src/agent/antigravity/acpProtocol.ts`, `src/agent/antigravity/adapter.ts`, `src/agent/antigravity/adapter.test.ts`, `src/agent/antigravity/fakeServer.ts`.

- [x] Расширить протокольный маппинг режимов в `src/agent/antigravity/acpProtocol.ts:192-210` без круговой перезаписи `'auto'`:
  - расширить `AgyModeId = 'default' | 'accept-edits' | 'auto' | 'plan'` и добавить `availableModesOf(result: unknown): AgyModeId[]` из `modes.availableModes`;
  - в `permissionModeOf(modeId)` маппить `'auto'` в `'acceptEdits'` для отображения в UI, но в `AgySession` хранить признак `explicitMode` (`options.permissionMode !== undefined` при создании/возобновлении без перезаписи из старого индекса, либо явный вызов `setMode`): если при `resumeSession` `this.serverMode === 'auto'` и пользователь явно не менял режим, `syncInitialMode()` **не шлёт** `session/set_mode` и не сбивает серверный `'auto'` в `'accept-edits'`.
- [x] Реализовать серверное наследование `bypassPermissions` в `AgySession` (`src/agent/antigravity/adapter.ts:365-438,500-605,729-777`):
  - вынести `agySpawnArgs(permissionMode, allowBypass)`: возвращать `['acp', '--dangerously-skip-permissions']` строго при `permissionMode === 'bypassPermissions' && allowBypass`, и `['acp']` во всех остальных случаях;
  - сделать транспорт в `AgySession` перезапускаемым (`private proc`, `private client`, `private ready`) и при вызове `setMode(next)` со сменой признака `needsBypassFlag` вне активного хода (`!this.turn && !this.loading && this.sessionId`) штатно закрывать старый процесс `agy acp` и прозрачно поднимать новый через `session/resume` на том же `this.sessionId` с сохранением `model`, `effort` и `cwd` (без сброса вкладки в UI); если `setMode` вызван во время активного хода — выставлять `pendingRespawn = true` и выполнять прозрачный `session/resume` сразу в `finally` текущего хода.
- [x] Проверить и поддержать реактивное пробуждение родителя (`wakeup`) после возврата из фонового `invoke_subagent`:
  - выполнить короткий живой зонд в `/tmp` на `agy acp --dangerously-skip-permissions` (`gemini-3.8-flash`, `thought_level: "low"`, удалить `/tmp`-папку после прогона): держит ли `agy acp` родительский `session/prompt` открытым (`HoldOwnedTurn`) до ответа субагента или закрывает ход `end_turn` и шлёт шаги пробуждения позже через `session/update` при `this.turn === undefined`;
  - если `agy acp` присылает содержательные `session/update` (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`) при `!this.turn && !this.loading` — автоматически открывать в `AgySession` синтетический ход пробуждения (`turn.start` с пустым/системным признаком либо продолжение ленты, обработка через `mapper.applyUpdate`, обновление `context.usage` по `transcript.jsonl` и закрытие `turn.result` по завершении шага/тишине потока), чтобы ответ родителя после работы субагента не терялся; если же `agy acp` удерживает исходный `session/prompt` открытым через `HoldOwnedTurn` — зафиксировать это в тесте `fakeServer.ts` и комментарии `adapter.ts`.
- [x] Покрыть тестами в `fakeServer.ts` и `src/agent/antigravity/adapter.test.ts`: спавн с `--dangerously-skip-permissions` и без него (`allowBypass: false`), переключение `setMode('bypassPermissions') ↔ setMode('default')` в простое и посреди активного хода, сохранность серверного `'auto'` при `resume`, доставка ответа родителя после завершения субагента.

**Готово, когда:** `npx vitest run src/agent/antigravity/adapter.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** в режиме `Без подтверждений` (`bypassPermissions`) попросить Antigravity запустить субагента `self` с командой `git status --short` — субагент отрабатывает без зависания в `waiting_for_input`, а родитель получает его отчёт и выводит финальный ответ в чат.

**Зависимости:** после этапа 3.

---

### 5. Живой граф, таймлайны и транскрипты субагентов Antigravity (`subagents: true`, `agentTranscript: true`)

**Файлы:** `src/agent/antigravity/subagents.ts` (новый), `src/agent/antigravity/subagents.test.ts` (новый), `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/adapter.ts`, `src/agent/antigravity/adapter.test.ts`, `src/agent/antigravity/history.ts`, `src/agent/antigravity/history.test.ts`, `src/agent/features.ts`, `src/agent/features.test.ts`, `src/webview/hudState.ts`, `src/webview/hudState.test.ts`.

- [x] В `src/webview/hudState.ts:227-250` (`case 'agent.start'`) при обновлении уже существующего узла `AgentNode` (повторный запуск / `send_message` тому же субагенту) сбрасывать `status: 'running'` и очищать `endedAt` (`const { endedAt: _ended, ...rest } = a`), сохраняя накопленные `segs`, `tokens` и `calls`. Покрыть кейсом в `src/webview/hudState.test.ts`.
- [x] Создать `src/agent/antigravity/subagents.ts` для разбора и tail-наблюдения за дочерними `brain/<childUuid>/.system_generated/logs/transcript.jsonl`:
  - строгая проверка UUID `childUuid` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`), парсер результата `invoke_subagent` (`parseCreatedSubagent(output)` → `{ conversationId }`) и результата `manage_subagents` (`parseManagedSubagents(action, input, output)` → статусы `waiting_for_input` и убитые `conversationId`);
  - инкрементальный ридер `AgySubagentReader` с байтовым курсором `byteOffset` (читает только дописанный хвост файла без повторного перечитывания начала; неполную последнюю строку до `\n` оставляет на следующий тик):
    - `PLANNER_RESPONSE` (`status === 'DONE'`) → сегменты `thinking.start` + `thinking.stop`, вызовы `tool.start` (через `mapAgyTool(..., mcpServers)`), подсчёт токенов и `toolUses` → `agent.progress`;
    - `GENERIC` (`status === 'DONE'`) → закрытие очередного открытого `tool.start` событием `tool.result` (`Command exited with code N` при `N !== 0` или ошибка тула → `isError: true`), распознавание фоновых команд (`Tool is running as a background task with task id: <uuid>/task-N` → дочерний узел `taskType: 'local_bash'`, `parentAgentId`) и вложенных `invoke_subagent` (`Created the following subagent` → дочерний узел `taskType: 'subagent'`, `parentAgentId` с рекурсивным наблюдением до глубины `2`);
    - детектор блокировки `waiting_for_input`: если последний шаг транскрипта — `PLANNER_RESPONSE` с `tool_calls` без парного `GENERIC` дольше `2500` мс (либо `manage_subagents(list)` вернул `"state": "waiting_for_input"`), эмитить `agent.progress` со `status: 'waiting_for_input'` и `description` блокирующего вызова;
    - детектор завершения раунда: финальный `PLANNER_RESPONSE` (`DONE`) без `tool_calls` (или с `send_message` родителю) эмитит `agent.end` (`status: 'completed'`, `summary` из текста ответа/сообщения, `totalTokens`, `toolUses`, `durationMs`).
  - генератор read-only Markdown `agySubagentMarkdown(childUuid, dataDir, meta)` для `AntigravityAdapter.agentTranscript` (шапка с ролью, типом, ссылкой `[Открыть сессию](conversation://<childUuid>)`, промптом из `SYSTEM_MESSAGE`, мыслями, вызовами и подрезанными результатами по образцу `src/agent/claude/subagents.ts:178-232`);
  - функция реконструкции истории `withAgySubagentTimelines(events, dataDir, mcpServers, options)` для `loadHistory` (находит пары `tool.start`/`tool.result` от `invoke_subagent`, вставляет `agent.start` с `agentId = toolUseId`, `taskId = childUuid`, `taskType = 'subagent'`, `background = true`, дочерние сегменты с лимитами `MAX_SUBAGENT_TIMELINES = 30` и `MAX_EVENTS = 400`, обработку `send_message` / `manage_subagents(kill)` и финальный `agent.end`, если `options.tasksAlive` не удерживает открытый агент живым).
- [x] Подключить `subagents.ts` в `AgySession` и `AntigravityAdapter` (`src/agent/antigravity/adapter.ts`):
  - на завершении `tool_call_update` для `invoke_subagent` эмитить `agent.start` (`agentId = toolCallId`, `taskId = childUuid`, `description = Role || TypeName`, `subagentType = TypeName`, `prompt = Prompt`, `model`, `background: true`) и запускать лёгкий watcher/поллер дочернего `transcript.jsonl` (интервал ~400 мс пока агент `running`, авто-останов при `agent.end` и полный `dispose()` при закрытии `AgySession`);
  - на `send_message(Recipient: childUuid)` переоткрывать соответствующий узел `agent.start` и возобновлять поллер; на `manage_subagents(kill | kill_all)` эмитить `agent.end` со `status: 'stopped'` и останавливать поллер;
  - реализовать `AntigravityAdapter.agentTranscript(sessionId, cwd, taskId, title)` и вызвать `withAgySubagentTimelines` в `AntigravityAdapter.loadHistory`;
  - включить в `src/agent/features.ts` (`ANTIGRAVITY_FEATURES`): `subagents: true`, `agentTranscript: true` (`agentStop` остаётся `false`).
- [x] Покрыть unit-тестами в `subagents.test.ts`, `adapter.test.ts`, `history.test.ts` и `features.test.ts`: живой прогон субагента от `invoke_subagent` до `agent.end`, вложенный субагент (`parentAgentId`), зависание `waiting_for_input`, возврат в работу по `send_message`, `manage_subagents(kill)` → `stopped`, реконструкция в `loadHistory`, `agentTranscript` и защита от не-UUID `taskId` (`../`).

**Готово, когда:** `npx vitest run src/agent/antigravity/ src/agent/features.test.ts src/webview/hudState.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** запустить в Antigravity задачу с 1–2 субагентами — в ленте под вызовом появляется живая карточка `AgentGroup`, в шапке и боковой панели открывается вкладка «агенты» и карта `AgentsGraph` с живыми полосками инструментов и токенами, кнопка «транскрипт» открывает Markdown-протокол субагента, а после переоткрытия сессии из истории весь граф сохраняется.

**Зависимости:** после этапа 4 (требует рабочих прав и wakeup у субагентов).

---

### 6. Документация, `agy-smoke.mjs` и финальная приёмка

**Файлы:** `docs/antigravity-protocol.md`, `README.md`, `README.ru.md`, `scripts/agy-smoke.mjs`.

- [x] Обновить `docs/antigravity-protocol.md`:
  - зафиксировать контракт `agy 1.5.6`: перехват `⚠ API error (attempt N)` → `api_retry`, приём внеходовых `available_commands_update` и `session_info_update`, разрез `mcp_<server>_<tool>` по `<dataDir>/mcp` и открытие `conversation://<uuid>`;
  - описать разницу эндпоинтов `agy acp` (`daily-cloudcode-pa.googleapis.com`) и `agy -p "/usage"` (`aicode.googleapis.com`, `Eligibility check failed`) и почему `/usage` нельзя слать в `session/prompt`;
  - описать архитектуру прав и графа субагентов: почему в режиме `default` фоновый субагент встаёт в `waiting_for_input` без `session/request_permission`, как работает наследование через `agy acp --dangerously-skip-permissions` (с перезапуском через `session/resume` и сохранением `'auto'`), реактивный wakeup родителя и сборка живого графа/истории по `brain/<childUuid>/.system_generated/logs/transcript.jsonl` (`agentStop: false`).
- [x] Обновить раздел Antigravity в `README.md` (строго EN) и `README.ru.md` (строго RU): автодополнение `/`, диагностика лимитов `/usage`, чипы MCP, живой граф и транскрипты субагентов + кликабельные ссылки `conversation://`, наследование прав в `bypassPermissions` (убрать устаревшее ограничение «Нет дерева субагентов»).
- [x] В `scripts/agy-smoke.mjs` добавить проверку непустого `session.init.slashCommands` на холодном старте `agy acp` (без отправки `session/prompt` и без расхода квоты).
- [x] Выполнить финальный прогон репозитория: `TZ=UTC npm run check`, `npm run test:integration`, `node scripts/agy-smoke.mjs` (при залогиненном `agy`) и `git diff --check`.

**Готово, когда:** `TZ=UTC npm run check`, `npm run test:integration`, `node scripts/agy-smoke.mjs` и `git diff --check` завершаются с кодом `0`.

**Ручная проверка:** контрольный чеклист из 6 пунктов по этапам 1–5 в Extension Development Host (`F5`).

**Зависимости:** строго после приёмки этапов 1–5.

---

## Промты исполнителей

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 1 — перехват транзиентных ретраев `agy acp` (`⚠ API error (attempt N): ...`) в сворачиваемую плашку `api_retry` вместо склейки в текст ответа.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md (раздел «Этап 1»);
- src/agent/antigravity/acpMapper.ts:40-103, src/agent/antigravity/acpMapper.test.ts;
- src/agent/claude/mapper.ts:363-374, src/shared/l10n.ts:192-196,455-459;
- src/webview/chatState.ts:571-583,704-712,764-773, src/webview/chatState.test.ts:609-635.
Уже решено:
- Новых типов AgentEvent не вводить: эмитить `{ type: 'error', fatal: false, code: 'api_retry', message }`.
- Вырезать `\n?⚠ API error \(attempt (\d+)\): ([^\n]+)\n?` как из одиночного `agent_message_chunk`, так и из консолидированного чанка с текстом вокруг, закрывая `thinking` и сбрасывая `messageId`, не загрязняя `this.text` (`turn.result.text`).
- В `retryRow` (`chatState.ts`) закрывать открытые `streaming: true` текстовые строки перед новой плашкой `tag: 'retry'`, сохраняя схлопывание серии подряд идущих `api_retry` в одну строку.
Не делать: изменения вне файлов этапа 1, коммит и push, трогать `.codex/config.toml`.
DoD и проверка:
- `npx vitest run src/agent/antigravity/acpMapper.test.ts src/webview/chatState.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 2 — внеходовые уведомления (`available_commands_update`, `session_info_update`), устойчивость парсеров моделей/квоты `agy 1.5.6` (`gemini-4-carbon`, `\r`-спиннер) и диагностика сбоев `/usage` (`AgyQuotaService` + `summarizeAgy` + HUD).
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md (раздел «Этап 2»);
- src/agent/antigravity/acpProtocol.ts:37-76, src/agent/antigravity/adapter.ts:729-796,970-980, src/agent/antigravity/fakeServer.ts, src/agent/antigravity/adapter.test.ts;
- src/agent/antigravity/models.ts:10-61, src/agent/antigravity/models.test.ts;
- src/agent/antigravity/quota.ts, src/agent/antigravity/quota.test.ts;
- src/extension/agyQuota.ts, src/extension/agyQuota.test.ts, src/extension/codexLimits.ts:20-98, src/extension/engineLimits.ts, src/extension/engineLimits.test.ts;
- src/extension/chatController.ts:891-893,1560-1573, src/protocol.ts:340-360,558-576, src/webview/hudView.ts:295-335, src/webview/hudView.test.ts.
Уже решено:
- `available_commands_update` принимать в том числе во время `handshake` и между ходами; отдавать дедуплицированные имена без `/` в `session.init.slashCommands` (и перевыпускать `session.init` при изменении после старта).
- `session_info_update` принимать при `!this.loading` даже вне `this.turn`, чтобы авто-заголовок не терялся после `session/prompt`.
- В `parseModels` и `parseAgyUsage` брать последний сегмент после `\r`.
- В `quota.ts` и `hudView.ts` маппить в общий `'Gemini'` только общий пул (`Gemini Models` / `Gemini`), а именные пулы (`Gemini 4 Argon`, `Gemini 4 Carbon`) оставлять отдельными семействами без коллизии ключей.
- В `runAgyUsage` захватывать `stderr` и возвращать чистое сообщение ошибки; добавить `isAgyAuthError`.
- В `AgyQuotaService` ввести `state` и `error?: string` по образцу `CodexLimitsService`: при ошибке сохранять прежние `rows`/`updatedAt`, логировать `warn`, уведомлять подписчиков, ставить кулдаун `60_000` мс вместо 10 минут и поддержать `refresh(force?: boolean)`. Пробросить `state`/`error` в `summarizeAgy` и HUD.
Не делать: отправку `/usage` через `session/prompt`, включение `ANTIGRAVITY_FEATURES.skills`, коммит и push.
DoD и проверка:
- `npx vitest run src/agent/antigravity/ src/extension/agyQuota.test.ts src/extension/engineLimits.test.ts src/webview/hudView.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 3 — маппинг `oneharness`-инструментов `agy` (`MCP` с точным разрезом имени сервера по `<dataDir>/mcp`, инструменты оркестрации) и открытие ссылок `conversation://<uuid>` во вкладке Agentura.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md (раздел «Этап 3»);
- src/agent/antigravity/tools.ts, src/agent/antigravity/tools.test.ts, src/agent/antigravity/acpMapper.ts, src/agent/antigravity/adapter.ts;
- src/webview/toolView.ts:45-185, src/webview/toolView.test.ts;
- src/webview/markdown.ts, src/webview/markdown.test.ts;
- src/extension/chatController.ts:807-839, src/extension/chatController.test.ts, src/extension/chatPanel.ts:955-962.
Уже решено:
- Имена серверов для eager `mcp_<server>_<tool>` матчить по отсортированному от длинных к коротким списку подпапок `<dataDir>/mcp` (`readAgyMcpServers`), чтобы `hansard_history` и `gemini-api_gemini-api-docs` не рвались по внутреннему `_`; фолбэк — первый `_` после `mcp_`.
- `call_mcp_tool`, `list_resources`, `read_resource` нормализовать к `mcp__<ServerName>__<ToolName>`.
- `invoke_subagent` маппить в `Agent` (`description: Role ?? TypeName`, `prompt: Prompt`, `subagent_type: TypeName`, `model: Model`), а для `manage_subagents`, `send_message`, `define_subagent`, `manage_task`, `schedule`, `swarm` сделать понятные подписи в `toolView.ts`. Обычный `read_file` на `SKILL.md` оставлять `Read`.
- В `markdown.ts` разрешить схему `conversation://` в DOMPurify (без ослабления запрета опасных схем), а в `chatController.ts` (`case 'link.open'`) открывать строго валидный `^conversation:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$` через `deps.openSession?.(uuid, 'antigravity')`.
Не делать: включение `ANTIGRAVITY_FEATURES.subagents` (это этап 5), разрешение произвольных схем, коммит и push.
DoD и проверка:
- `npx vitest run src/agent/antigravity/tools.test.ts src/webview/toolView.test.ts src/webview/markdown.test.ts src/extension/chatController.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 4 — наследование прав родителя дочерними субагентами (`agy acp --dangerously-skip-permissions` с перезапуском через `session/resume`), сохранение режима `auto` без круговой перезаписи и реактивный wakeup родителя.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md (раздел «Этап 4»);
- src/agent/antigravity/acpProtocol.ts:185-215, src/agent/antigravity/adapter.ts:365-605,725-990;
- src/agent/antigravity/fakeServer.ts, src/agent/antigravity/adapter.test.ts.
Уже решено:
- Расширить `AgyModeId` значением `'auto'` и парсером `availableModesOf`. При `resumeSession` без явно запрошенного `options.permissionMode`, если сервер вернул `currentModeId === 'auto'`, `permissionModeOf('auto')` отдаёт `'acceptEdits'` для UI, но `syncInitialMode()` НЕ шлёт `session/set_mode` и не сбивает серверный `'auto'` в `'accept-edits'`.
- При `permissionMode === 'bypassPermissions' && allowBypass` спавнить `agy` как `['acp', '--dangerously-skip-permissions']` (иначе строго `['acp']`).
- При смене признака `bypassPermissions` в `setMode(next)` вне активного хода закрывать текущий процесс `agy acp` и прозрачно поднимать новый через `session/resume` на том же `sessionId` (сохраняя `model`, `effort`, `cwd`); во время активного хода выставлять `pendingRespawn` и перезапускать в `finally` текущего хода.
- Проверить одноразовым прогоном в `/tmp` на `gemini-3.8-flash` (`thought_level: "low"`, `--dangerously-skip-permissions`), держит ли `agy acp` родительский `session/prompt` открытым до ответа субагента или досылает реактивное пробуждение через `session/update` при `!this.turn`; удалить `/tmp`-папку и поддержать доставку ответного хода родителя в `AgySession` + покрыть тестом на `fakeServer.ts`.
Не делать: передачу `--dangerously-skip-permissions` при `allowBypass === false`, изменения `PermissionMode` в `src/agent/types.ts`, коммит и push.
DoD и проверка:
- `npx vitest run src/agent/antigravity/adapter.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано (включая точный вердикт зонда wakeup), отклонения, вывод проверок, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

### Этап 5

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 5 — живой граф субагентов, вкладка «агенты», история и `agentTranscript` для Antigravity (`subagents: true`, `agentTranscript: true`).
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md (раздел «Этап 5»);
- src/agent/claude/subagents.ts, src/agent/antigravity/context.ts, src/agent/antigravity/tools.ts;
- src/agent/antigravity/acpMapper.ts:174-279, src/agent/antigravity/adapter.ts, src/agent/antigravity/history.ts;
- src/webview/agentsView.ts:134-165, src/webview/hudState.ts:213-290,430-445,495-560;
- src/extension/chatController.ts:784-799, src/agent/features.ts:105-131.
Уже решено:
- Контракт UI: для субагентов верхнего уровня `agentId = toolCallId` вызова `invoke_subagent` (так `agentGroupView` в `agentsView.ts:146` связывает `FeedRow` и `AgentNode`), а `taskId = childUuid` (так `chatController.ts:792` вызывает `adapter.agentTranscript(..., m.taskId, '')`), `taskType = 'subagent'`, `background = true`.
- В `hudState.ts` (`case 'agent.start'`) при повторном `agent.start` для существующего `agentId` (возврат субагента в работу по `send_message`) сбрасывать `status: 'running'` и убирать `endedAt`, сохраняя накопленный таймлайн.
- В `src/agent/antigravity/subagents.ts` реализовать строгую валидацию UUID, инкрементальный read-only ридер `<dataDir>/brain/<childUuid>/.system_generated/logs/transcript.jsonl` по `byteOffset` (сегменты `thinking`, `tool.start`/`tool.result` через `mapAgyTool`, токены, вложенные субагенты и фоновые `task-N` с `parentAgentId`, детектор `waiting_for_input`, завершение раунда `agent.end`, `stopped` на `manage_subagents(kill)`), `agySubagentMarkdown` (со ссылкой `conversation://<childUuid>`) и `withAgySubagentTimelines` для `loadHistory`.
- Включить в `ANTIGRAVITY_FEATURES`: `subagents: true`, `agentTranscript: true` (`agentStop: false` не менять). Ничего не писать в `~/.gemini`, не трогать `transcript_full.jsonl` и SQLite.
DoD и проверка:
- `npx vitest run src/agent/antigravity/ src/agent/features.test.ts src/webview/hudState.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

### Этап 6

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 6 — обновление документации (`docs/antigravity-protocol.md`, `README.md`, `README.ru.md`), `scripts/agy-smoke.mjs` и финальная приёмка.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md (раздел «Этап 6» и чекпоинты этапов 1–5);
- docs/antigravity-protocol.md, README.md, README.ru.md, scripts/agy-smoke.mjs;
- актуальный код `src/agent/antigravity/`, `src/agent/features.ts`, `src/extension/agyQuota.ts`.
Уже решено:
- В `docs/antigravity-protocol.md` отразить все факты `agy 1.5.6`: `api_retry`, внеходовые `available_commands_update` и `session_info_update`, разницу эндпоинтов `agy acp` vs `agy -p "/usage"` (`aicode.googleapis.com`), разрез `mcp_<server>_<tool>` по `<dataDir>/mcp`, открытие `conversation://<uuid>`, наследование прав через `--dangerously-skip-permissions`, сохранение `'auto'`, реактивный wakeup и устройство графа/транскриптов субагентов (`agentStop: false`).
- `README.md` строго на английском, `README.ru.md` строго на русском; править только подраздел Antigravity.
- В `scripts/agy-smoke.mjs` проверить `slashCommands.length > 0` в стартовом `session.init` без расхода генерационной квоты.
Не делать: сборку/установку `.vsix`, коммиты, теги и push без отдельного указания.
DoD и проверка:
- `TZ=UTC npm run check` — код 0;
- `npm run test:integration` — код 0;
- `node scripts/agy-smoke.mjs` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, результаты всех 4 команд, короткий чеклист ручной проверки в VS Code, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

## Риски и открытые вопросы

- **Подтверждения в фоновых субагентах при режиме `default` / `acceptEdits`:** протокол `agy acp` (`1.5.6`) закрывает клиентский канал разрешений сразу по окончании родительского `session/prompt` и не имеет RPC для подтверждения `waiting_for_input` в дочернем `conversationId`. Для сценариев, где субагенты вызывают `run_command` (`roadmap-run-agy`), штатный режим — `bypassPermissions` (`--dangerously-skip-permissions`) либо серверный `auto` для безопасных команд; в `default`-режиме граф подсветит `waiting_for_input`, а клик по `conversation://<uuid>` позволит открыть дочернюю сессию и увидеть стопор.
- **Перезапуск `agy acp` при переключении `bypassPermissions` на лету:** закрытие старого процесса `agy acp` ради смены флага `--dangerously-skip-permissions` останавливает незавершённых фоновых воркеров старого процесса (транскрипты на диске сохраняются). Перезапуск выполняется строго вне активного хода (`!this.turn`).
- **Маршрутизация `aicode.googleapis.com` для `/usage`:** даже после починки диагностики в Agentura сам `agy -p "/usage"` требует доступный с поддерживаемой геолокацией `aicode.googleapis.com` (при split-tunnel VPN он должен идти в тот же рабочий туннель, что и `daily-cloudcode-pa.googleapis.com`).
- **Нагрузка от поллинга дочерних `transcript.jsonl`:** чтобы не плодить лишние файловые чтения, поллер в `subagents.ts` активен только для узлов со `status === 'running'`, читает только новые байты с последнего `byteOffset` (через `fs.stat` + чтение хвоста при росте `size`) и гарантированно очищает таймеры при `agent.end` и `session.dispose()`.

## Порядок работы

Этапы выполняются строго последовательно: `1 → 2 → 3 → 4 → 5 → 6`.
- В Antigravity (`roadmap-run-agy`): запускать в режиме без подтверждений терминала (либо до завершения Этапа 4 гонять shell-проверки в основном чате); основной чат проверяет diff и DoD, ставит `[x]` и обновляет `## Checkpoint`.
- В Codex (`.codex/WORKFLOW.md`): последовательно по промтам этапов с приёмкой и чекпоинтом после каждого этапа.
- Коммит, сборка `.vsix` и push — только по явному запросу пользователя.
