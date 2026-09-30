# Проба Claude Agent SDK на живом движке · 2026-09-30

Этап 0 из `docs/roadmap/02-implementation.md`: что SDK отдаёт на самом деле, а не по доке.
Дока — `sdk-doc-review.md`; здесь только то, что пришло в живом прогоне.

- **Чем мерили.** `spikes/sdk-probe/run.mjs` — `@anthropic-ai/claude-agent-sdk` 0.3.285, CLI 2.1.285,
  Node 22.23.2, macOS. Streaming input mode, вход CLI (подписка Claude Max, без `ANTHROPIC_API_KEY`),
  `cwd` — этот репозиторий, системный промпт `claude_code`, `settingSources: ['project','local']`,
  `strictMcpConfig`, `includePartialMessages`. Модели `claude-sonnet-5-5` и `claude-opus-5-5`.
- **Логи.** `spikes/sdk-probe/logs/<сценарий>.jsonl`, ссылки ниже — `файл:строка` без расширения.
  Сообщения SDK записаны как пришли; строки `{"type":"probe"}` — записи самой пробы (что отправили,
  что пришло в `canUseTool`, что вернул управляющий метод) — при разборе фикстур их пропускать.
  Почта аккаунта заменена на `<redacted>` при записи. Токенов в логах нет (`grep sk-ant-` пуст),
  но есть проценты лимитов и расход extra usage владельца — пересмотреть, если репозиторий станет публичным.
- **Расход.** Полный прогон — $0.75 по оценке SDK (`logs/_ledger.json`; плюс повтор сценария 2 — $0.10),
  отладочные прогоны до него — ещё около $0.8. Всё ушло в лимит подписки: 5-часовое окно за время
  работы выросло с 71 % до 81 %.

## Главное, что разошлось с докой и планом

1. **Окно контекста — 1 000 000, не 200k**, на обеих моделях (`modelUsage[model].contextWindow`,
   `getContextUsage().maxTokens`); порог автосжатия — 967 000. Пороги 120k/150k/200k в прототипе —
   пользовательские отметки на шкале, к окну модели отношения не имеют.
2. **`rate_limit_event` несёт оба окна сразу** — недокументированное поле `unifiedWindows`
   (`five_hour`, `seven_day`: доля 0…1 и сброс в unix-секундах). Лимиты для шапки есть прямо в потоке SDK.
3. **`assistant.context_usage` не приходит** ни разу за 12 логов. Контекст — `getContextUsage()` или
   сумма usage последнего ответа.
4. **Субагент без `run_in_background` стартует фоновым**: `tool_result` «async launched» приходит сразу,
   итог — через `task_notification` и отдельный ход-пробуждение. Передний план — только при явном
   `run_in_background: false`.
5. **`ExitPlanMode` приходит в `canUseTool`** с текстом плана в `input.plan`; deny с сообщением работает
   как «доработать».
6. **Прерванный ход не попадает в стоимость**: после `interrupt()` `total_cost_usd` не изменился.
7. **`fetch` из Node к `/api/oauth/usage` отвечает 200** — блокировка Cloudflare, описанная в Agentmeter
   (август), на Node 22.23.2 не воспроизвелась.
8. **`system/init` приходит на каждый ход**, а не один раз на сессию.

## Вопросы этапа 0

### 1. Скрипт-проба

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Отрабатывает ли проба целиком | Да: 10 сценариев, 12 логов, выход 0 | `node spikes/sdk-probe/run.mjs`; выборочно — `run.mjs 2 7` | `_ledger.json` |
| Что в логах помимо сообщений SDK | Строки `type:"probe"`: `send`, `control`, `canUseTool`, `canUseTool_result`, `summary` (счётчики типов сообщений) | — | `01-basic-control:69` |

### 2. Управление в streaming input mode

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| `interrupt()` | Работает, ответ за 2 мс | `{still_queued: []}` | `01-basic-control:35` |
| Что приходит после прерывания | Оборванный `assistant` с `aborted: true`, затем `user` «[Request interrupted by user]», затем `result` | `result.subtype: "error_during_execution"`, `terminal_reason: "aborted_streaming"`, `is_error: true`, `usage` нулевой | `01-basic-control:36–38` |
| Стоимость прерванного хода | Не учтена: `total_cost_usd` тот же, что до хода | `result.total_cost_usd` | `01-basic-control:19` и `:38` |
| `setPermissionMode()` | Работает; подтверждение — `system/status` с новым режимом | `status.permissionMode`, `status.status: null` | `01-basic-control:39–42` |
| `setModel()` | Работает (≈300 мс); в поток падает `user` с `isReplay: true` и текстом `<local-command-stdout>Set model to …`; следующий `init` и `assistant.message.model` — новая модель | `init.model` | `01-basic-control:43–47` |
| `applyFlagSettings({effortLevel})` | Принят без ошибки; подтверждения в потоке нет — в `init` поля `effort` нет | — | `01-basic-control:45` |
| Что модель переключилась на деле | `result.modelUsage` содержит обе модели с отдельной стоимостью | `modelUsage["claude-opus-5-5"]` | `01-basic-control:66` |

### 3. `system/init`, `accountInfo()`, `apiKeySource`

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| `apiKeySource` при входе CLI | `"none"` | `init.apiKeySource` | `01-basic-control:6` |
| Форма `init` | `cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, terminal_slash_commands, apiKeySource, claude_code_version, output_style, agents, skills, plugins, capabilities, memory_paths, fast_mode_state, fast_mode_disabled_reason, per_turn_effort_active, view_mode`; `Agent` в `tools` назван `Task` | `SDKSystemMessage` | `01-basic-control:6` |
| Как часто приходит `init` | Перед каждым ходом, включая ходы-пробуждения | — | `01-basic-control:6, :21, :47` |
| `accountInfo()` | `{email, organization, subscriptionType: "Claude Max", apiProvider: "firstParty"}`; `tokenSource` и `apiKeySource` не пришли | `AccountInfo` | `01-basic-control:3` |
| `initializationResult()` | То же `account` плюс `models`, `commands`, `agents`, `current_permission_mode`, `fast_mode_state`, `session_state`; доступен до первого сообщения | `SDKControlInitializeResponse` | `01-basic-control:2` |
| Список моделей | 12 записей: `default, opus, claude-fable-5-1, sonnet, haiku, …`; у каждой `value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode, supportsAutoMode` | `ModelInfo[]` | `01-basic-control:4` |
| Название сессии | Опция `title` → `system/session_title_changed`; оно же `customTitle` и `summary` в `listSessions` | `title` | `01-basic-control:1` |

### 4. Контекст: `getContextUsage()`, `context_usage`, `modelUsage`

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Форма `getContextUsage()` | `totalTokens, maxTokens, rawMaxTokens, percentage` (целое), `autoCompactThreshold, isAutoCompactEnabled, autocompactSource, model, categories[], gridRows, memoryFiles[], mcpTools, agents, slashCommands, skills, messageBreakdown, apiUsage` | `SDKControlGetContextUsageResponse` | `09-context-sonnet:16` |
| Окно и порог | `maxTokens: 1000000`, `autoCompactThreshold: 967000` на Sonnet 5.5 и Opus 5.5 | те же поля | `09-context-sonnet:3`, `09-context-opus:3` |
| До первого хода | Работает: 16 603 токена (система, инструменты, память, скиллы), `apiUsage: null` | `totalTokens` | `09-context-sonnet:3` |
| Категории | `System prompt`, `System tools`, `System tools (deferred)` (`kind: "deferred"`, в окно не входит), `Memory files`, `Skills`, `Messages`, `Autocompact buffer` (`kind: "buffer"`), `Free space`; различать по `kind`, не по имени | `categories[].{name,tokens,kind}` | `09-context-opus:16` |
| `detail: 'full'` | Те же ключи, что и без опции | — | `09-context-sonnet:17` |
| Связь с usage | На ходе без thinking `totalTokens` = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` последнего ответа (20 798 = 2 + 13 472 + 7 324; 20 876 = 2 + 20 796 + 78); с thinking расходится на десятки токенов | `apiUsage` внутри ответа | `09-context-sonnet:16, :31`, `01-basic-control:67` |
| Сколько стоит вызов | Первый — 0.3–0.9 с, повторный без нового хода — 3–12 мс | `probe.ms` | `09-context-sonnet:3, :16, :17` |
| `assistant.context_usage` | Не приходит | — | нет ни в одном логе |
| `result.modelUsage` | По модели: `inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, webSearchRequests, costUSD, contextWindow: 1000000, maxOutputTokens: 128000, canonicalModel, provider, costBasis: "list"` | `ModelUsage` | `09-context-opus:15` |
| `result` целиком | `total_cost_usd, usage` (с `iterations[]`, `output_tokens_details.thinking_tokens`), `modelUsage, duration_ms, duration_api_ms, ttft_ms, num_turns, stop_reason, terminal_reason, permission_denials, subagent_stats, result_index, queued_turn_count`; у хода-пробуждения ещё `origin` | `SDKResultMessage` | `01-basic-control:19` |
| Итог хода | `result.usage` — токены только этого хода; `total_cost_usd` и `modelUsage` — нарастающие за сессию; стоимость хода — разность соседних `result` | — | `02-permissions-edit:84, :159` |

### 5. Дедуп usage и `output_tokens`

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Несколько `assistant` с одним `message.id` | Да: по одному на блок контента (thinking, text, каждый tool_use), usage в них одинаковый — считать один раз по `message.id` | `assistant.message.id`, `.usage` | `02-permissions-edit:44, :56` |
| `output_tokens` в `assistant` | Плейсхолдер из `message_start`: 16 при настоящих 214; 6 при 17 | `assistant.message.usage.output_tokens` | `02-permissions-edit:44` → `:60`; `01-basic-control:14` → `:16` |
| Где настоящий | `stream_event` `message_delta.usage.output_tokens` (+ `output_tokens_details.thinking_tokens`) на каждый API-ответ; сумма за ход — `result.usage.output_tokens` | `event.usage` | `02-permissions-edit:60`, `:84` |
| Входные токены и кэш в `assistant` | Настоящие уже в первом сообщении: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m/1h_input_tokens` | `assistant.message.usage` | `02-permissions-edit:44` |
| TTL кэша | Главный разговор пишет в `ephemeral_1h`, субагенты — в `ephemeral_5m` | `usage.cache_creation` | `05-subagents:35` и `:62` |
| Смена модели и кэш | После `setModel` из кэша читается только общий префикс (13 472), разговор пишется заново (7 962) — доля попаданий падает | `cache_read/creation` | `01-basic-control:53` |
| Служебные поля | `assistant.timestamp`, `request_id`; `stream_event.ttft_ms`, `thinking_display` | — | `01-basic-control:8, :14` |

### 6. Лимиты: `rate_limit_event` и `/api/oauth/usage`

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Форма `rate_limit_event` | `status: "allowed"`, `rateLimitType: "five_hour"`, `resetsAt`, `overageStatus`, `overageResetsAt`, `isUsingOverage`, `unifiedWindows` | `rate_limit_info` | `01-basic-control:18` |
| Единицы | `resetsAt` — unix-секунды (1790787000 = 16:50 UTC); `utilization` — доля 0…1 (0.79) | — | `01-basic-control:18` |
| Оба окна | `unifiedWindows.five_hour` и `.seven_day`, в каждом `{utilization, resetsAt}`. Поля нет в `sdk.d.ts`; верхнего `utilization` в событии не было | `rate_limit_info.unifiedWindows` | `05-subagents:42, :60` |
| Когда приходит | После первого API-ответа в `query()` и при изменении процента (0.79 → 0.80 внутри одной сессии); не на каждый ход | — | `05-subagents:42, :60` |
| Токен для OAuth | Файла `~/.claude/.credentials.json` на macOS нет; токен в Keychain, `security find-generic-password -s "Claude Code-credentials" -w` → `claudeAiOauth.accessToken` | — | `10-oauth-usage:1` |
| `GET /api/oauth/usage` | 200 и через `fetch` Node 22.23.2, и через `curl`; заголовки `authorization: Bearer`, `anthropic-beta: oauth-2025-04-20` | — | `10-oauth-usage:2, :3` |
| Форма ответа | `limits[]`: `{kind: "session" \| "weekly_all" \| "weekly_scoped", group, percent` (целое)`, severity, resets_at` (ISO с микросекундами)`, scope, is_active}`; у `weekly_scoped` — `scope.model.display_name` | `limits[]` | `10-oauth-usage:3` |
| Остальное в ответе | `five_hour` / `seven_day`: `{utilization` (проценты, 81)`, resets_at, …}`; `extra_usage {is_enabled, monthly_limit, used_credits, utilization, currency}`; `spend`; два десятка кодовых имён экспериментов — игнорировать | — | `10-oauth-usage:3` |
| Сходятся ли источники | Да: SDK `five_hour.utilization 0.81` = OAuth `session.percent 81`; `seven_day 0.36–0.37` = `weekly_all 37` | — | `09-context-opus:14`, `10-oauth-usage:3` |
| Чего нет в SDK | Недельного окна по модели (`weekly_scoped`, у владельца — Fable 22 %), `severity`, extra usage | — | `10-oauth-usage:3` |

### 7. `canUseTool` для Bash, Edit, Write

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Что приходит в опциях | Ключи: `signal, suggestions, blockedPath, decisionReason, title, displayName, description, defaultToNo, suppressAlwaysAllowRule, toolUseID, agentID, requestId` (+ `requiresUserInteraction` у вопросов и плана); часть — `undefined` | `CanUseTool` options | `02-permissions-edit:48` |
| Edit | `input {file_path, old_string, new_string, replace_all}`; `suggestions: [{type:"setMode", mode:"acceptEdits", destination:"session"}]` — правила для файла нет | — | `02-permissions-edit:48` |
| «Всегда» для Edit | Своё правило `addRules [{toolName:"Edit"}] → localSettings` записало `"Edit"` в `permissions.allow`; следующий Edit в `canUseTool` не пришёл | `updatedPermissions` | `02-permissions-edit:49, :85, :104–109` |
| Bash | `input {command, description}`; `suggestions: [{type:"addRules", rules:[{toolName:"Bash", ruleContent}], behavior:"allow", destination:"localSettings"}]`, `decisionReason: "This command requires approval"` | — | `02-permissions-edit:171` |
| «Всегда» для Bash | Вернули `suggestions` как пришли → правило в `.claude/settings.local.json`; та же команда во второй раз в `canUseTool` не пришла | — | `02-permissions-edit:172, :196–200, :210` |
| Bash с записью в файл | `blockedPath` + `addDirectories → session` в подсказках; правило `Bash(echo probe *)` записалось, но такая же команда с другим файлом спросила снова | `blockedPath` | `02-permissions-edit:57, :116` |
| Файл настроек | `{"permissions":{"allow":["Edit","Bash(echo probe *)"]}}`; каталог `.claude/` создаётся движком | `.claude/settings.local.json` | `02-permissions-edit:85` |
| Write | `input {file_path, content}`, подсказка та же `setMode acceptEdits` | — | `02-permissions-edit:133` |
| Отказ | `{behavior:"deny", message}` → `tool_result` с `is_error: true` и нашим текстом, `tool_use_result: "Error: …"`; в `result.permission_denials[] {tool_name, tool_use_id, tool_input}`. Отдельного `permission_denied` в потоке нет | — | `02-permissions-edit:224, :226, :245` |
| Чтение | `Read` в режиме `default` в `canUseTool` не приходит | — | `02-permissions-edit:22–24` |
| Субагент | Тот же `canUseTool`, в опциях `agentID` = `task_id` задачи | `options.agentID` | `05-subagents:139` |

### 8. `AskUserQuestion`

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Приходит ли в `canUseTool` | Да, `requiresUserInteraction: true`, подсказок нет | `input.questions[{question, header, options[{label, description}], multiSelect}]` | `03-ask-user-question:30` |
| Как ответить | `{behavior:"allow", updatedInput:{...input, answers:{"<текст вопроса>":"<label>"}}}` | `updatedInput.answers` | `03-ask-user-question:31` |
| Что после | `tool_use_result {questions, answers}`, в `tool_result` — «Your questions have been answered: …»; агент продолжил ход | — | `03-ask-user-question:33, :43` |

### 9. Plan mode

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Приходит ли `ExitPlanMode` в `canUseTool` | Да, `requiresUserInteraction: true` | — | `04-plan-mode:89` |
| Где текст плана | `input.plan` (markdown целиком) и `input.planFilePath` (`~/.claude/plans/<имя>.md`); файл агент пишет сам через `Write` без запроса | `input.{plan, planFilePath}` | `04-plan-mode:83, :89` |
| «Доработать» | `{behavior:"deny", message}` → `tool_result is_error` с нашим текстом; агент правит файл плана и зовёт `ExitPlanMode` снова. Отказ попадает в `permission_denials` | — | `04-plan-mode:90, :92, :148, :211` |
| Одобрить и выйти в `acceptEdits` | `allow` + `updatedPermissions: [{type:"setMode", mode:"acceptEdits", destination:"session"}]` → `system/status {permissionMode:"acceptEdits"}` | — | `04-plan-mode:149, :151` |
| `tool_use_result` одобренного плана | `{plan, isAgent: false, filePath}`; в `tool_result` — «User has approved your plan…» | — | `04-plan-mode:152` |
| Режим после выхода | Запись в файл из Bash прошла без запроса, команда без записи (`tail \| xxd`) — спросила | — | `04-plan-mode:167, :186` |
| Вход в режим | `permissionMode: 'plan'` в опциях → `init.permissionMode: "plan"`; отдельного события нет | — | `04-plan-mode:3` |

### 10. Субагенты

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Запуск | `tool_use` с именем `Agent`, `input {description, subagent_type, prompt, model?, run_in_background?}` | — | `05-subagents:35` |
| События запуска | `background_tasks_changed {tasks[{task_id, task_type, description}]}`, затем `task_started {task_id, tool_use_id, description, subagent_type, is_backgrounded, spawn_depth, task_type:"local_agent", prompt}` | `SDKTaskStartedMessage` | `05-subagents:37, :38` |
| Без `run_in_background` | Стартует фоновым (`is_backgrounded: true`); `tool_use_result {isAsync:true, status:"async_launched", agentId, resolvedModel, outputFile}`; ход главного агента закрывается, не дожидаясь | `subagent_stats.requested.unset`, `.started_in_background` | `05-subagents:38, :39, :61` |
| Итог фоновой задачи | `task_updated {patch:{status:"completed", end_time}}` → `task_notification {status, summary` (текст ответа)`, output_file, usage{total_tokens, tool_uses, duration_ms}}` → новый `init` и ход главного агента с `result.origin {kind:"task-notification"}` | `SDKTaskNotificationMessage` | `05-subagents:66–69, :88` |
| Сообщения субагента | `assistant` / `user` с `parent_tool_use_id` = id вызова `Agent`, плюс `subagent_type`, `task_description`; `stream_event` от субагента нет | `parent_tool_use_id` | `05-subagents:62, :64` |
| `forwardSubagentText` | Текст субагента приходит `assistant`-сообщением; его промпт — `user`-сообщением с тем же `parent_tool_use_id` | — | `05-subagents:65, :205` |
| Прогресс | `task_progress {task_id, tool_use_id, description:"Running …", usage, last_tool_name}`; поля `summary` при `agentProgressSummaries` на коротких задачах не было | `SDKTaskProgressMessage` | `05-subagents:63` |
| `stopTask(taskId)` | Работает (5 мс): `task_updated {status:"killed"}`, `task_notification {status:"stopped"}`, вложенная bash-задача тоже `stopped`; затем ход-пробуждение | — | `05-subagents:143–147, :168` |
| Задачи внутри субагента | Bash субагента — отдельный `task_started {task_type:"local_bash", owned_by_subagent:true}` | — | `05-subagents:141` |
| Явный передний план | `run_in_background: false` → `is_backgrounded: false`, ход ждёт; `tool_use_result {status:"completed", agentType, content, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats}` | `AgentOutput` | `05-subagents:203, :214` |
| Стоимость | Расход субагентов входит в `result.modelUsage` и `total_cost_usd` главной сессии; в `result.usage` — нет | — | `05-subagents:61, :88` |

### 11. Компакция

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| `/compact` промптом | Работает | — | `06-compact:51–58` |
| Порядок сообщений | `status {status:"compacting"}` → `status {status:null, compact_result:"success"}` → `init` → `compact_boundary` → `user` со сводкой (`isSynthetic: true`) → `user` `<local-command-stdout>Compacted` (`isReplay: true`) → `result` | — | `06-compact:52–58` |
| `compact_boundary` | `compact_metadata {trigger:"manual", pre_tokens: 21122, post_tokens: 1393, cumulative_dropped_tokens, duration_ms, preserved_segment, preserved_messages}` — «было → стало» для строки в ленте | `SDKCompactBoundaryMessage` | `06-compact:55` |
| `result` компакции | `num_turns: 0`, `usage` нулевой, `terminal_reason` нет, есть `local_command`; стоимость сводки — в `total_cost_usd` ($0.039 → $0.062) | — | `06-compact:49, :58` |
| Контекст после | `getContextUsage().totalTokens` 20 995 → 18 825 (сообщения 4 354 → 2 232; остальное — система и инструменты), `apiUsage: null` до следующего хода | — | `06-compact:50, :59` |

### 12. Thinking

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| `display: 'summarized'` | Текст есть: `thinking_delta.thinking` кусками, итоговый блок `thinking` 130 и 160 символов | `event.delta.thinking` | `07-thinking:8, :29, :107` |
| Без `display` | `thinking_delta` приходит с пустым текстом и `estimated_tokens`; блок `thinking` пустой, только `signature` | `stream_event.thinking_display: "updates"` | `06-compact:22, :26`, `01-basic-control:51, :53` |
| Какие `stream_event` | `message_start`, `content_block_start` (`thinking` / `text` / `tool_use`), `content_block_delta` (`thinking_delta`, `signature_delta`, `text_delta`, `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop` | `SDKPartialAssistantMessage` | `07-thinking` (счётчики — последняя строка) |
| `system/thinking_tokens` | `{estimated_tokens, estimated_tokens_delta}` — идёт вперемешку с `thinking_delta` | — | `07-thinking:7` |
| Итоговое число | `message_delta.usage.output_tokens_details.thinking_tokens` (37 и 59), в `modelUsage.thinkingTokens` | — | `07-thinking:66, :144` |
| Обе модели | Поведение одинаковое на Sonnet 5.5 и Opus 5.5 | — | `07-thinking:8, :78` |

### 13. Сессии

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| `listSessions({dir})` | `{sessionId, summary, lastModified, fileSize, customTitle, firstPrompt, gitBranch, cwd, tag, createdAt}` — времена в мс; токенов, стоимости и числа ходов нет | `SDKSessionInfo` | `08-sessions-list:1` |
| `getSessionInfo(id)` | Та же запись по одной сессии | — | `08-sessions-list:2` |
| `getSessionMessages(id)` | `{type, uuid, session_id, message, parent_tool_use_id, parent_agent_id, timestamp}`; только `user` и `assistant` | `SessionMessage` | `08-sessions-list:3, :4` |
| Есть ли `message.usage` | Да, и в транскрипте он уже итоговый: `output_tokens: 17` и `88` с `stop_reason: "end_turn"`. У прерванного сообщения — плейсхолдер и `stop_reason: null` | `message.usage` | `08-sessions-list:5, :7, :12` |
| Дубли в транскрипте | Одно API-сообщение записано по блокам (thinking, text) с одним `message.id` — дедуп тот же | — | `08-sessions-list:12, :13` |
| Служебные записи | Команда `/model` лежит `user`-сообщениями с `isCompletedLocalCommand: true`; `includeSystemMessages` для этой сессии ничего не добавил | — | `08-sessions-list:9, :10, :14` |
| `resume` | Работает из нового процесса; `getContextUsage()` до первого хода отдаёт контекст прежней сессии (21 464) | `options.resume` | `08-sessions-resume:2` |
| Копится ли стоимость | Да: было $0.0725, после одного хода — $0.1086; `modelUsage` хранит и старую Opus-часть | `result.total_cost_usd`, `modelUsage` | `08-sessions-list:15`, `08-sessions-resume:14` |
| Модель при `resume` | Берётся из опций нового `query()`, не из сессии: сессия кончилась на Opus, продолжилась на Sonnet | `init.model` | `08-sessions-resume:4` |

### 14. `tool_use_result` для Edit и Write

| Вопрос | Ответ | Поле / тип | Лог |
|---|---|---|---|
| Edit | `{filePath, oldString, newString, originalFile` (файл целиком до правки)`, structuredPatch[{oldStart, oldLines, newStart, newLines, lines[]}], userModified, replaceAll}`; `gitDiff` не пришёл | `user.tool_use_result` | `02-permissions-edit:50` |
| Write, новый файл | `{type:"create", filePath, content, structuredPatch: [], originalFile: null, userModified}` | — | `02-permissions-edit:135` |
| Write, существующий | `{type:"update", …, structuredPatch[…], originalFile}` | — | `04-plan-mode:146` |
| Прочие | Read — `{type:"text", file{filePath, content, numLines, startLine, totalLines}}`; Bash — `{stdout, stderr, interrupted, isImage, noOutputExpected}` | — | `02-permissions-edit:24, :28` |
| Время инструмента | Отдельного поля нет; у `assistant` и `user` есть `timestamp` — длительность = разность между `tool_use` и его `tool_result` | `timestamp` | `02-permissions-edit:44, :50` |

## Что остаётся допущением и как проверим в реализации

| Допущение | Почему не закрыто | Как проверим |
|---|---|---|
| `unifiedWindows` в `rate_limit_event` — устойчивое поле | Его нет в типах SDK и в доке | Адаптер читает его через проверку формы; нет поля — шапка берёт проценты из OAuth-запроса. Тест на фикстуре без поля (этап 2) |
| Окно 1M — у всех | Проверено на одной подписке (Claude Max) и двух моделях | Окно не хардкодим: `getContextUsage().maxTokens` / `modelUsage.contextWindow`; до первого ответа — `getContextUsage()` перед ходом |
| Формула «контекст = input + cache_read + cache_creation» | С thinking расходится с `getContextUsage()` на десятки токенов | В шапке — сумма usage на лету, после `result` сверка через `getContextUsage()` (этап 4) |
| `applyFlagSettings({effortLevel})` меняет effort | Вызов успешен, но в потоке подтверждения нет | Сравнить `thinking_tokens` на одном вопросе при `low` и `max` на этапе 3; в UI показывать то, что отправили |
| Прерванный ход бесплатен | Так считает клиентская оценка SDK; токены по факту потрачены | Строка итога прерванного хода — без стоимости, с пометкой «прервано»; токены берём из оборванного `assistant` |
| Истечение кэша | События нет; TTL выводим из `ephemeral_1h` (главный) и `5m` (субагенты) | Таймер от `timestamp` последнего ответа; после паузы дольше TTL проверить, что `cache_read` упал (ручной тест этапа 4) |
| Субагент по умолчанию фоновый | Может зависеть от версии CLI и модели | Карта агентов строится по `task_started.is_backgrounded` и `task_notification`, а не по ожиданию `tool_result` |
| Остановка субагента переднего плана | `stopTask` пробовали только на фоновой задаче | На этапе 5 вызвать `stopTask` на `is_backgrounded: false`; запасной вариант — `interrupt()` |
| Автокомпакция | Проверен только ручной `/compact`; до порога 967k в пробе не дойти | Ждём `compact_boundary.compact_metadata.trigger: "auto"` — разбор тот же; фикстура из ручной |
| `gitDiff` в результате Edit | Не пришёл (файл под git, но поле пустое) | Дифф после правки строим из `structuredPatch` и `originalFile` |
| Повторный запрос на Bash с записью в файл | Правило и каталог на сессию не сняли вопрос для другого файла | Кнопка «всегда» для таких команд предлагает `acceptEdits` (подсказка `setMode`) — проверить на этапе 5 |
| Пользовательские настройки | Проба шла без `user`-источника: без хуков, MCP и правил владельца | Расширение грузит все источники; `init` станет длиннее, часть запросов закроют правила пользователя — интеграционный тест этапа 2 на дефолтных `settingSources` |
| `~/.claude/CLAUDE.md` грузится даже без `user`-источника | Попал как память типа `Project` — найден при обходе каталогов вверх от `cwd` | Учесть в разбивке контекста (A9), отдельно не лечить |
| `/api/oauth/usage` из extension host | 200 получен из Node 22 в терминале, не из Node VS Code | Первый запрос на этапе 4 — из extension host; запасной вариант — `curl` дочерним процессом. Опрос не чаще раза в 15 минут |
| Keychain без диалога | `security` отдал токен молча — доступ уже был выдан | В расширении чтение токена — по явному включению настройки, ошибка чтения = серая строка, не падение |
| Юридическое: вход подписки в стороннем расширении | Не предмет пробы | Решение владельца перед публичной раздачей (раздел «Риски» roadmap) |

## Побочные следы пробы

- В списке сессий каталога — 19 сессий с названием `sdk-probe …` (полный прогон и отладочные).
- `README.md`, `.claude/settings.local.json` и временные файлы после каждого сценария возвращены как были;
  файл плана из `~/.claude/plans/` удалён (`04-plan-mode:213`).
