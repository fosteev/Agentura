# Разведка доки Claude Agent SDK (TypeScript) · 2026-09-30

Что дока говорит о данных и управлении, нужных Agentura. Только дока, без живого прогона —
живая проверка это этап 0 в `docs/roadmap/02-implementation.md`. Снимки страниц —
`sdk-docs-2026-09-30/`. Версии: SDK 0.3.285, CLI 2.1.285.

## 1. query() и Query
- `query({prompt: string | AsyncIterable<SDKUserMessage>, options})` → `Query extends AsyncGenerator<SDKMessage>`.
- Options: `model`, `fallbackModel`, `cwd`, `env` (в TS **заменяет** окружение процесса), `permissionMode`, `allowedTools` (авто-одобрение, не ограничение), `disallowedTools`, `allowDangerouslySkipPermissions`, `resume`, `continue`, `forkSession`, `resumeSessionAt`, `sessionId`, `persistSession`, `includePartialMessages`, `canUseTool`, `hooks`, `agents`, `agentProgressSummaries`, `forwardSubagentText`, `settingSources` (по умолчанию все три), `systemPrompt` (по умолчанию минимальный; preset `claude_code`), `maxTurns`, `maxBudgetUsd`, `abortController`, `pathToClaudeCodeExecutable` (по умолчанию бандленный бинарь), `effort`, `thinking` (default adaptive), `enableFileCheckpointing`, `mcpServers`, `tools`, `plugins`, `skills`, `permissionPrompts`, `planModeInstructions`, `toolConfig`.
- Методы Query: `interrupt`, `rewindFiles`, `setPermissionMode`, `setModel`, `applyFlagSettings`, `updateSettings`, `initializationResult`, `supportedCommands`, `supportedModels`, `supportedAgents`, `mcpServerStatus`, `getContextUsage({detail})`, `readFile`, `accountInfo`, `streamInput`, `stopTask(taskId)`, `close`. `interrupt/setPermissionMode/setModel/applyFlagSettings` — только в streaming input mode.

## 2. Сообщения
- `system/init`: `session_id, apiKeySource, claude_code_version, cwd, tools, mcp_servers, model, permissionMode, slash_commands, output_style, skills, plugins, effort?`.
- `assistant`: `message: BetaMessage, parent_tool_use_id, error?, context_usage?`. Одно API-сообщение = несколько assistant с одним `message.id` — usage считать один раз; `output_tokens` там плейсхолдер (реальный в `message_delta` и `result`).
- `stream_event`: только главная сессия (`parent_tool_use_id` всегда null).
- `result`: `duration_ms, duration_api_ms, num_turns, total_cost_usd, usage, modelUsage{[model]: {inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow, maxOutputTokens}}, permission_denials`. `usage` — только главный цикл; `modelUsage`/`total_cost_usd` включают субагентов и компакцию, при resume накапливают; в streaming input каждый ход даёт свой result как бегущий итог.
- Ещё: `system/status {status:"compacting"|null, permissionMode?}`, `system/compact_boundary {trigger, pre_tokens}`, `system/thinking_tokens {estimated_tokens}`, `rate_limit_event`, `task_started/progress/updated/notification`, `background_tasks_changed`, `tool_progress`, `permission_denied`, `auth_status`, `api_retry`, `conversation_reset`.

## 3. Лимиты, компакция, кэш
- `rate_limit_event.rate_limit_info {status: allowed|allowed_warning|rejected, resetsAt?, utilization?}` — без типа окна и единиц. Проценты 5ч/7д описаны только для statusline CLI (`rate_limits.five_hour/seven_day.used_percentage, resets_at`) — из SDK недоступны.
- Компакция: `status:"compacting"` → `compact_boundary`; хуки `PreCompact/PostCompact`; вручную — промпт `/compact`. `getContextUsage()` → `totalTokens, maxTokens, percentage, autoCompactThreshold, isAutoCompactEnabled`, категории.
- Истечение кэша: события нет. TTL: подписка в лимите — 1 ч для главного разговора, API-ключ — 5 мин, субагенты — 5 мин; `usage.cache_creation.ephemeral_5m/1h_input_tokens`; хуки `PreModelSwitch/PostModelSwitch` несут `prompt_cache_warm, cache_ttl`.

## 4. Разрешения
- `canUseTool(toolName, input, {signal, suggestions?: PermissionUpdate[], toolUseID, agentID?, requestId, decisionReason?, blockedPath?})` → `{behavior:"allow", updatedInput?, updatedPermissions?} | {behavior:"deny", message, interrupt?}`.
- «Всегда»: вернуть `updatedPermissions` из `suggestions` (например `destination === "localSettings"` → `.claude/settings.local.json`). `PermissionUpdate`: `addRules/replaceRules/removeRules {rules, behavior, destination} | setMode | addDirectories`; destinations `userSettings|projectSettings|localSettings|session|cliArg`.
- `PermissionMode`: `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`. Порядок проверки: hooks → deny → ask → режим → allow → canUseTool; авто-одобренное в canUseTool не приходит.
- Plan mode: правки идут в canUseTool даже при allow; инструменты `EnterPlanMode {}` и `ExitPlanMode` (output `{plan, isAgent, filePath?, planWasEdited?}`); отдельного события входа/выхода нет, режим — в `status.permissionMode` и `init.permissionMode`.
- `AskUserQuestion` приходит в canUseTool: `input.questions[{question, header ≤12, options[{label, description}] 2–4, multiSelect}]` (1–4 вопроса); ответ `{behavior:"allow", updatedInput:{questions, answers:{"<вопрос>":"<label>"}}}`; свободный текст — значением. Недоступно субагентам.

## 5. Субагенты
- Инструмент `Agent` (в init.tools как `Task`): `{description, prompt, subagent_type?, model?, run_in_background?, isolation?}`.
- Сообщения субагента: `parent_tool_use_id`; текст/thinking — только при `forwardSubagentText: true`; stream_event не приходят.
- События `task_started {task_id, tool_use_id?, description, task_type, is_backgrounded?}`, `task_progress {task_id, usage:{total_tokens, tool_uses, duration_ms}, last_tool_name?, summary?}`, `task_updated {patch}`, `task_notification {status, summary, usage?}`, `background_tasks_changed {tasks}`. Итог — `tool_use_result` = `AgentOutput {status, totalTokens, totalDurationMs, usage, toolStats}`.
- Остановка: `query.stopTask(taskId)` для фоновых; отдельной остановки foreground-субагента нет, `interrupt()` прерывает ход.

## 6. Сессии
- `resume: session_id`, `continue: true`, `forkSession`, `resumeSessionAt`; можно из другого cwd.
- Транскрипты `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (не-алфанум → `-`); формат «внутренний, меняется между версиями».
- `listSessions({dir, limit})` → `{sessionId, summary, lastModified, customTitle?, firstPrompt?, gitBranch?, cwd?, createdAt?}` без токенов; `getSessionMessages(id)` → сырые user/assistant (usage в assistant по логике BetaMessage — не подтверждено); `renameSession`, `tagSession`.

## 7. Авторизация
- ToS: «Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products» без одобрения.
- Порядок кредов: облако → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → профили → OAuth подписки из `/login`. `init.apiKeySource: "ANTHROPIC_API_KEY"|"apiKeyHelper"|"/login managed key"|"none"`.
- `query.accountInfo()` → `{email?, organization?, subscriptionType?, tokenSource?, apiKeySource?}`.

## 8. Thinking
- `thinking: {type:"adaptive", display?: "summarized"|"omitted"} | {type:"enabled", budgetTokens?} | {type:"disabled"}`; на Opus 4.7+ display по умолчанию `omitted` — для текста нужен `summarized`.
- `effort: low|medium|high|xhigh|max`; на лету `applyFlagSettings({effortLevel})`; `ModelInfo.supportedEffortLevels`. Прогресс — `thinking_tokens`; итог — `usage.output_tokens_details.thinking_tokens`, `ModelUsage.thinkingTokens`.

## 9. Диффы
- Edit input `{file_path, old_string, new_string, replace_all?}`, Write `{file_path, content}` — те же в canUseTool и PreToolUse.
- Edit output `{filePath, oldString, newString, originalFile, structuredPatch[{oldStart, oldLines, newStart, newLines, lines}], gitDiff?}`; Write output `{type: create|update, filePath, content, structuredPatch, originalFile}`.
- До применения готового диффа нет — считать из input; `updatedInput` в allow правит вход; откат — `enableFileCheckpointing` + `rewindFiles`.

## Не подтверждено докой (проверяет этап 0)
- Тип окна и единицы в `rate_limit_event`; проценты 5ч/7д из SDK.
- Событие истечения кэша.
- Формат jsonl и наличие usage в `getSessionMessages`.
- Приходит ли `ExitPlanMode` в canUseTool и где текст плана.
- `thinking_delta` при `includePartialMessages`.
- Остановка одного foreground-субагента.
- Допустимость входа подписки для личного расширения.
