# 39 — Kimi Code как пятый движок: ACP, история и живой граф агентов

> Статус: этапы 1–6 приняты · 2026-11-14. Ручная визуальная приёмка Extension Development Host оставлена владельцу.

## Цель

Добавить провайдер `kimi` поверх установленного и залогиненного Kimi Code CLI (`kimi acp`): стриминг текста и рассуждений, инструменты и diff, разрешения, вопросы и plan review, Stop, модели/thinking/режимы, картинки, контекст и `/compact`, история и возобновление сессий. Отдельно довести до существующих панели и `AgentsGraph` живых и восстановленных субагентов, включая вложенность, промпт, итог, вызовы, токены и read-only транскрипт.

Claude, Codex, Antigravity и Cursor не меняют поведения. Новых типов `AgentEvent` не вводить; несуществующие стоимость, квоту, действия и статусы не имитировать.

## Контекст и ограничения

### Подтверждённые факты

На машине установлен `kimi` `2.6.0` (`/Users/fost/.kimi-code/bin/kimi`). Официальная документация подтверждает ACP over stdio, `loadSession`, image prompts, embedded text resources, `session/list|load|resume|close|fork`, `session/set_mode`, `session/set_config_option` и `session/set_model`:

- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html

Дополнительно осмотрен открытый источник Kimi Code `2.6.0`, commit `0ea324cafb4b1754ae5b1737147a141a618d4a4e`:

- `packages/acp-server/src/events-map.ts`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call*`, ACP diff, `available_commands_update`, `config_option_update`, `session_info_update`, `usage_update { used, size }`.
- `packages/acp-server/src/approval.ts`: `session/request_permission` с `approve_once`, `approve_always` (на сессию), `reject`; `plan_review` имеет `plan_approve`, `plan_revise`, `plan_reject_and_exit` и варианты `plan_opt_N`.
- `packages/acp-server/src/question.ts` и `interaction-bridge.ts`: полные multi-question/multi-select через `elicitation/create`; без него — деградация в один вопрос через permission bridge.
- `packages/acp-server/src/config-options.ts` и `modes.ts`: независимые `model`, `thinking`, `mode`; режимы `default`, `plan`, `auto`, `yolo`; thinking бывает `off/on` или набором effort.
- `packages/acp-server/src/session.ts`: ACP подписан на события **только главного агента**; после хода отправляет `usage_update`; `/compact`, `/usage`, `/mcp`, `/tasks` — локальные текстовые команды.
- `packages/acp-server/src/replay.ts`: `session/load` реплеит только главную историю, без дочерних агентов.
- `packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts`: durable `subagent.spawned|started|completed|failed|cancelled` содержат `subagentId`, `parentToolCallId`, `parentAgentId`, профиль, background, модель, effort, итог и usage.
- `packages/agent-core-v2/src/session/sessionMetadata/sessionMetadata.ts`: `state.json.agents` содержит тип и `parentAgentId`.
- Официальный VS Code UI Kimi сам читает богатые SDK events (`apps/vscode/src/runtime/event-adapter.ts`), но `@moonshot-ai/kimi-code-sdk` помечен `private` и отсутствует в npm (проверено `npm view`: 404). Делать SDK-зависимость от монорепо не предлагаем.

Источник для последующей сверки: `https://github.com/MoonshotAI/kimi-code/tree/0ea324cafb4b1754ae5b1737147a141a618d4a4e`.

### Что Agentura сможет поддержать

| Функция | Маршрут и граница |
|---|---|
| Чат, streaming text/thinking, Stop | `kimi acp`, общий `AcpRpcClient`, `session/prompt` / `session/cancel`. |
| Инструменты, MCP-чипы, diff и `changes` | `tool_call*`, `rawInput/rawOutput`, ACP `content[type=diff]`; неизвестные инструменты не роняют ход. |
| Разрешения | `session/request_permission`; «всегда» у Kimi означает только текущую сессию (`destination: 'session'`). |
| Вопросы | `elicitation/create` с существующей схемой `Question`; включить `clientCapabilities.elicitation.form`. |
| Plan mode и plan review | `session/set_mode` и plan-review options в permission request; точный показ текста и feedback подтверждает спайк. |
| Модель, effort, режимы | `configOptions`; `auto` и `yolo` не выдавать за Claude-семантику без явного маппинга в UI/README. |
| Изображения | ACP image blocks; реальная приёмка зависит от vision возможностей выбранной модели. |
| Текстовые вложения | В v1 — существующий текстовый context fallback Agentura, как у Codex/Antigravity; PDF как document/blob не поддержан. |
| Контекст | ACP `usage_update.used/size` → `context.usage`; без чтения транскрипта для основного окна. |
| `/compact` | Локальная ACP-команда; текстовые acknowledgements преобразовать в `compaction.*`, не показывать как ответ модели. |
| Сессии | `session/list`, `resume`, `load`, автозаголовок; пользовательские имена — отдельным индексом Agentura, потому что ACP rename не объявлен. |
| Skills и `/` | `available_commands_update` + карточки `Skill`; живой список обновляется на `skills.changed` внутри CLI. |
| **Граф агентов** | Вызов `Agent` виден уже в ACP. Полный граф — read-only корреляция ACP calls с `state.json`, `agents/<id>/wire.jsonl` и `tasks/`; восстановление дополняет `session/load`. |

### Чего в v1 не будет

- **USD, cache TTL и достоверной стоимости субагентов:** ACP не передаёт цены; `usage_update` описывает контекст, не счёт.
- **Лимитов аккаунта в сайдбаре:** ACP `/usage` в исходнике возвращает текст о контексте и session total, а не структурированные окна подписки. Kimi Console/web API — отдельная задача, не парсим случайный текст в кольца.
- **PDF/document blocks:** ACP принимает image/text/resource/resource_link, но blob resources отбрасывает. `ProviderFeatures.files = false`; текст идёт context fallback.
- **Отдельной кнопки Stop у субагента:** клиентского ACP RPC для `TaskStop` нет; `session/cancel` относится к основному ходу. `agentStop = false`.
- **Структурного MCP status/toggle/reconnect:** `/mcp` возвращает текст. Вызовы MCP показываются в ленте, но `mcp = false`, панель и переключатели скрыты.
- **Agentura Remote Control:** Claude bridge неприменим. У Kimi есть свой `kimi web`/Remote Control, но это другой серверный протокол и отдельный скоуп.
- **Jira host tools из коробки:** ACP умеет передать stdio/HTTP/SSE MCP, но существующие in-process Claude MCP и Codex dynamic tools напрямую в него не превращаются. В v1 — пользовательские Kimi skills; stdio bridge к `AgentJiraTools` не строить.
- **Отключения boolean thinking:** значения `off/on` не втискивать в `EffortLevel`. Пикер показывает только реальные `low|medium|high|xhigh|max`; при boolean-only модели effort скрыт, серверное значение сохраняется. Расширение общего контракта отдельной задачей.
- **Tower, goal mode, cron UI, swarm-доски:** не путать с обычным графом субагентов; отдельные интеграции.

### Принятые решения

- Провайдер `kimi`, UI «Kimi Code», команда движка `kimi acp`, минимальная эталонная версия `2.6.0`. Старые версии без подтверждённого контракта не принимать.
- Только ACP: не использовать `kimi -p --output-format stream-json` как транспорт вкладки — это одноходовый auto-mode без интерактивных разрешений. `kimi web` и неопубликованный Node SDK тоже не нужны для v1.
- Один `kimi acp` на вкладку, очередь ходов в адаптере, `interrupt()` через `session/cancel`, `dispose()` через `session/close` → stdin end → SIGTERM → SIGKILL. Agentura никогда не вызывает `session/delete` для пользовательских сессий.
- `initialize`: `protocolVersion: 1`, `clientInfo`, `fs=false`, `terminal=false`, `elicitation.form={}`. Сначала файлы и команды исполняет сам Kimi; ACP reverse fs/terminal в v1 не включать.
- Маппинг режимов: `default → default`, `plan → plan`, `acceptEdits → auto`, `bypassPermissions → yolo` только при `agentura.allowBypassPermissions`; без разрешения — `default`. В UI/README прямо указать, что Agentura `acceptEdits` у Kimi означает более широкий нативный `auto` (безопасные правки и команды), а не только файлы.
- При `resume` не перезаписывать серверные model/thinking/mode дефолтами новой сессии. `config_option_update` и `current_mode_update` — источник подтверждённого состояния, ошибка выбора откатывает UI.
- Пользовательские имена — `globalState` `agentura.kimi.names`; сохранённые model/effort/mode — отдельный session settings index по образцу Antigravity. Не править `state.json` вручную.
- Граф: для верхнего узла `agentId = ACP toolCallId` (связь с `AgentGroup`), `taskId = Kimi subagentId` (`agent-N`), `taskType = 'subagent'`. Для вложенных узлов `parentAgentId` — Agentura id родителя, найденный по `parentToolCallId`/metadata, а не сырой `agent-N`. Не выдумывать связь, если корреляция не доказана фикстурой.
- Чтение `$KIMI_CODE_HOME/sessions/<workspaceId>/<sessionId>/{state.json,agents/*/wire.jsonl,tasks/*}` строго read-only, с валидацией id/путей, инкрементальным offset и мягкой деградацией. Никаких секретов, `credentials/` и глобального `kimi-code.log` в фикстурах.

### Точки входа Agentura

- Общий ACP и эталоны: `src/agent/acp/client.ts:68`, `src/agent/antigravity/acpProtocol.ts:13`, `acpMapper.ts:47`, `adapter.ts`, `history.ts:30`, `sessionIndex.ts:36`, `src/agent/cursor/adapter.ts:268`.
- Контракт: `src/agent/types.ts:38-40,198-439,555-705`; флаги — `src/agent/features.ts:7-49,161`.
- Граф: `src/webview/hudState.ts:213-288`, `agentsView.ts`, `agentViews.ts`, `src/shared/agentsGraph.ts`, `src/webview/agentsGraph/`; тестовая связка — `src/agent/codex/subagents.test.ts:25`.
- Подключение: `src/extension/chatPanel.ts:101-160,210-254,1274-1285`, `chatController.ts:92-98,1606-1673`, `sessionsService.ts:25-40,181-185,251-283,482`, `extension.ts:63-98`.
- Настройки/UI: `src/settings.ts:168-196`, `package.json`, `src/protocol.ts:728-769`, `src/webview/components/{Composer,Settings,NewChatPopover,SidebarTaskPicker}.tsx`, `src/webview/{newChat,engineLimitsView,settingsStore,strings,strings.en}.ts`.
- Логин и иконка: `src/extension/sidebarView.ts:240-246`, `src/extension/chatSurface.ts:73-80`, `media/brands/SOURCES.md`.

## Этапы

### 1. Живой спайк `kimi acp 2.6.0` и санитизированные фикстуры

- [x] Во временном workspace снять NDJSON для `initialize` → `session/new` → текст/thinking → Read/Grep/Bash → Edit/Write с diff → allow once / allow session / deny → Stop с ожиданием разрешения → `session/list|load|resume|close`.
- [x] Снять `configOptions` и живые изменения model/thinking/mode (`default`, `plan`, `auto`, `yolo` только в безопасной временной папке), `config_option_update`, `current_mode_update`, `available_commands_update`, `session_info_update`, `usage_update` и ошибки невалидного выбора.
- [x] Проверить plan review (текст плана, approve/revise/options и путь feedback), AskUserQuestion single/multi/multi-select/Other, картинку, текстовый resource, PDF/blob, `/compact`, `/usage`, `/mcp`, Skill. Не приписывать поддержку по одной документации.
- [x] Получить foreground и background `Agent`, параллельных агентов, повторный `Agent(resume=...)`; для вложенности использовать custom agent только во временном workspace. Записать связь ACP `toolCallId` ↔ `subagentId`, `parentToolCallId`, `state.json`, дочерние `wire.jsonl`, terminal status/usage и фоновые tasks.
- [x] Сохранить `docs/spikes/kimi-code-acp/report.md` с таблицей «вопрос → живой факт → флаг/маппинг», финальной строкой `go` или `stop`; положить очищенные кадры в `test/fixtures/kimi/` (ACP, state и укороченные main/child wire). Удалить только созданные спайком сессии через ACP и временные файлы; реальные конфиги и credentials не читать в отчёт и не менять.

**Готово, когда:** отчёт заканчивается `go`/`stop`; при `go` известны точные схемы permission/plan/question, `usage_update`, history и корреляции графа; NDJSON/JSON валидны; поиск секретов, домашних путей и реальных промптов в фикстурах пуст; `src/` не изменён.

**Исполнение:** отдельная сессия; последовательно, код до вердикта не писать.

### 2. Провайдер, локатор и ядро ACP-сессии

- [x] Добавить `'kimi'` в `AgentProvider`, `PROVIDERS` и необходимые проверки протокола без подключения к меню; создать `src/agent/kimi/{executable,protocol,mapper,adapter,fakeServer}.ts` и тесты.
- [x] Реализовать поиск `kimi` в PATH, `~/.kimi-code/bin`, `~/.local/bin`, Homebrew и настройку `agentura.kimiExecutable`; проверять `kimi --version >= 2.6.0`, отличать отсутствие/старый CLI/чужой бинарник.
- [x] Реализовать `createSession`/`resumeSession`, handshake, очередь, `send`, `interrupt`, `dispose`; маппить text/thinking, tool start/progress/result, raw errors, ACP diff → структурный результат `changes`, title, commands, config updates и `usage_update` → существующие `AgentEvent`.
- [x] Поддержать image blocks и честный `usageKnown: false` для хода, если structured per-turn usage не появился; `contextUsage()` возвращает последний подтверждённый `usage_update`. Добавить `KIMI_FEATURES` по фактам спайка, пока `subagents/agentTranscript = false`.
- [x] Создать opt-in `scripts/kimi-smoke.mjs` с временной папкой, одним коротким ходом, context update и штатным закрытием; не включать в обычный `npm run check`.

**Готово, когда:** `npx vitest run src/agent/kimi src/agent/acp src/agent/features.test.ts` и `npm run typecheck` зелёные; fake server покрывает текст, мысли, инструменты/diff, Stop, resume, config и context; без провайдера `kimi` поведение прежнее.

**Исполнение:** отдельная сессия; после `go`, последовательно.

### 3. Разрешения, вопросы, план, режимы, вложения, компакция и история

- [x] Подключить `session/request_permission` → `permission.request`, `respondPermission`, session-only `allow-always`, deny и автоответ только в разрешённом bypass; все pending снимать при Stop/dispose. Plan review → `plan.request`/`decidePlan`, вопросы → `question.request`/`answerQuestion` по фикстурам этапа 1.
- [x] Реализовать `setModel`, `setEffort`, `setMode`, capabilities и сохранение подтверждённых настроек сессии; boolean `off/on` сохранять без фальшивого EffortLevel, ошибки RPC возвращать в UI и перевыпускать фактическое состояние.
- [x] Реализовать `/compact` с `compaction.start/end` и context update по живым кадрам; текстовые служебные ответы `/compact`, `/usage`, `/mcp`, `/tasks` не смешивать с генерацией. Неподдержанные команды не показывать как успешные действия Agentura.
- [x] Реализовать `listSessions` с фильтром cwd/realpath, `loadHistory` из `session/load` с live/maxTurns, `resumeSession`, `accountInfo` только реальными полями, rename/settings через `src/agent/kimi/sessionIndex.ts`; обновить название из `session_info_update`, не затирая пользовательское.
- [x] Выставить финальные базовые флаги (`plan`, `questions`, `images`, `compact`, `context`, `skills`) строго по спайку; `files`, `cost`, `remote`, `mcp`, `browser` оставить false. Проверить текстовый fallback и явный warning для PDF, если он всё же пришёл.

**Готово, когда:** `npx vitest run src/agent/kimi src/agent/features.test.ts` и `TZ=UTC npm run check` зелёные; тесты доказывают allow/deny/plan/question, режимы и откат ошибок, compact, history/list/resume/rename, attachments и отсутствие висящих запросов.

**Исполнение:** отдельная сессия; последовательно после этапа 2.

### 4. Живой граф, вложенность, транскрипты и восстановление агентов

- [x] Создать `src/agent/kimi/subagents.ts`: строгие валидаторы session/agent/task ids, разбор `state.json`, incremental reader `wire.jsonl` с byte offset и неполной последней строкой, маппинг `subagent.*`, messages/tool calls/usage и `tasks/` в существующие `agent.*` и события с `agentId`.
- [x] На ACP `Agent`/`AgentSwarm` создавать узел с `agentId = toolCallId`, prompt/type/model/background; после появления `subagent.spawned` связать `taskId = subagentId`, запускать watcher и закрывать его на terminal/dispose. Повторный resume переоткрывает узел (`running`, очистка `endedAt`) без потери накопленного таймлайна.
- [x] Поддержать nested agents и фоновые Bash через `parentAgentId`/`parentToolCallId`; циклы, orphan metadata и неизвестные record types пропускать без падения. Ограничить глубину, число агентов и события на узел; не читать файл целиком на каждый тик.
- [x] Реализовать `agentTranscript` как read-only Markdown из дочернего wire и дополнение `loadHistory` графом последних 30 агентов/400 событий на узел. История не должна помечать завершённых агентов работающими; `tasksAlive` учитывать для живых.
- [x] Включить `KIMI_FEATURES.subagents = true` и `agentTranscript = true`, оставить `agentStop = false`; при необходимости точечно исправить общий `hudState` для повторного `agent.start`, не меняя другие движки.

**Готово, когда:** `npx vitest run src/agent/kimi src/agent/features.test.ts src/webview/hudState.test.ts src/webview/agentsGraph` и `npm run typecheck` зелёные; тест по образцу `codex/subagents.test.ts` строит панель и `AgentsGraph` с двумя параллельными и одним nested агентом, живыми calls/tokens, итогами, resumed agent и восстановленной историей.

**Исполнение:** отдельная сессия; последовательно после этапа 3. Это обязательная часть интеграции, не опциональный follow-up.

### 5. Подключение к Agentura, настройки новой сессии и вход

- [x] Подключить ленивые `kimiAdapter`/`kimiEngine` в `chatPanel.ts`, `adapterOf`/`engineOf`, `extension.ts`, `SessionsService` и все provider enums/validation; сбой Kimi не стирает чужие списки и не запускает процесс до выбора движка.
- [x] Добавить Kimi в меню пустой вкладки, `/new kimi`, task picker/new chat, строки RU/EN, метку `K` и brand asset с проверяемым источником в `media/brands/SOURCES.md`; скрыть несуществующие cost/limits/MCP/remote/agentStop по флагам.
- [x] Добавить `agentura.kimi.defaultModel`, `agentura.kimi.defaultEffort` и machine-scope `kimiExecutable` в package/nls/settings/controller/store/UI. Каталог моделей получать без лишней живой сессии (предпочтительно `kimi provider list --json`, формат проверить этапом 1); пустые значения наследуют CLI, resume не затирается.
- [x] Добавить `kimi acp --login` через терминал в `sidebarView.ts`, check engine и понятные состояния missing/signed out/old version. Не показывать email/план/квоту без источника.
- [x] Проверить task handoff: текстовые контексты доходят, PDF не обещаются; model/mode defaults применяются только к новой вкладке; иконки и статусы не путают Kimi с другими движками.

**Готово, когда:** `TZ=UTC npm run check` зелёный; provider/manifest/settings/controller/DOM тесты покрывают все перечисления `kimi`; полный поиск provider-switch не оставляет молчаливый fallback Kimi на Claude.

**Исполнение:** отдельная сессия; после этапа 4, последовательно из-за общих файлов.

### 6. Документация и сквозная приёмка

- [x] Создать `docs/kimi-protocol.md` по фактическим кадрам: поддерживаемый ACP subset, permissions/plan/questions, model/thinking/mode mapping, usage/context/compact, history, ограничения и read-only graph reader.
- [x] Обновить `README.md` (EN) и `README.ru.md` (RU): установка/вход, функции Kimi, граф и транскрипты, честный список ограничений v1; синхронизировать `docs/features.md`, если она описывает движки/Jira tools.
- [x] Прогнать `TZ=UTC npm run check`, `npm run test:integration`, `node scripts/kimi-smoke.mjs` при активном логине и `git diff --check`; удалить временные артефакты прогонов, чужой WIP не трогать.
- [x] Отдать ручной чеклист Extension Development Host: новый чат → pong → diff/permission → question → plan review → Stop → image → compact/context → resume/rename → foreground/background/nested Agent с живым графом и транскриптом → отсутствие ложных cost/quota/MCP/Stop.

**Готово, когда:** все команды завершаются кодом 0, документация совпадает с флагами и кодом, живой smoke проходит; ручные визуальные пункты явно оставлены владельцу, не выданы за проверенные.

**Исполнение:** отдельная сессия; финальный последовательный этап.

## Промты исполнителей

Общее для всех этапов: работаем в `/Users/fost/Projects/Agentura` после закрытия roadmap 38 либо в отдельном worktree от согласованного чистого коммита. Читай `/Users/fost/Projects/CLAUDE.md`, `AGENTS.md`, `.codex/WORKFLOW.md`, этот roadmap и указанные точки входа. Не трогай чужой WIP и `.codex/config.toml`. Не коммить, не пушить, не собирать/устанавливать `.vsix` без отдельного указания. Длинные проверки пиши во временный лог. Чекбоксы отмечай только после DoD.

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura. Задача: только живой спайк Kimi Code ACP 2.6.0 и фикстуры, без src/.
Читай: docs/roadmap/39-kimi-code-support.md (факты, ограничения, этап 1), docs/spikes/antigravity-acp/report.md и test/fixtures/antigravity/acp-pong.ndjson как форму отчёта; официальные ACP docs и источник Kimi commit 0ea324cafb4b1754ae5b1737147a141a618d4a4e.
Уже решено: транспорт kimi acp; отдельный временный workspace; никаких правок credentials/config/state вручную; session/delete разрешён только для созданных этим спайком тестовых сессий. Граф проверять на реальных Agent/AgentSwarm и custom nested agent во временном workspace.
Порядок: handshake/basic turn → tools/diff/permissions/stop → models/thinking/modes/plan/questions → attachments/commands/compact/usage → sessions → agents/wire/state/tasks → sanitize fixtures/report go|stop.
DoD: дословно «Готово, когда» этапа 1; валидный JSON/NDJSON; секреты, реальные пути и пользовательские тексты не попали в репо; src/ не менялся.
В отчёте: go/stop, версия, снятые схемы, файлы, что не воспроизведено, ограничения графа.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura. Задача: провайдер kimi, executable resolver и ядро ACP adapter/mapper без UI.
Читай: roadmap 39, docs/spikes/kimi-code-acp/report.md и test/fixtures/kimi/, src/agent/acp/client.ts, src/agent/antigravity/{acpProtocol,acpMapper,adapter,executable}.ts, src/agent/types.ts, features.ts.
Уже решено: если отчёт не go — стоп. Новых AgentEvent нет, stream-json не использовать, один процесс на вкладку, structured usage не выдумывать, subagents пока false.
Порядок: provider/types → resolver → protocol/mapper → adapter/lifecycle → fake/tests → opt-in smoke → DoD этапа 2.
Не делать: webview/settings/sessions UI, граф, изменения других движков, коммит/push.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura. Задача: все интерактивные контракты и история Kimi поверх ядра этапа 2.
Читай: roadmap 39, отчёт/фикстуры спайка, src/agent/kimi/, src/agent/antigravity/{adapter,history,sessionIndex}.ts, src/agent/cursor/mapper.ts, src/agent/types.ts.
Уже решено: allow-always = session; off/on не являются EffortLevel; resume не затирать; PDF/стоимость/квоту/MCP status не имитировать; служебные slash responses не выдавать за модель.
Порядок: permissions/plan/questions → model/effort/mode → compact/context/attachments → list/load/resume/rename/account → flags/tests/full check.
DoD: дословно «Готово, когда» этапа 3. Не делать граф и общий UI, не коммитить/push.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura. Задача: полный живой и восстановленный граф Kimi, не только карточка Agent.
Читай: roadmap 39 (контракт id), фикстуры wire/state, src/agent/kimi/, src/agent/claude/subagents.ts, src/agent/codex/subagents.test.ts, src/webview/{hudState,agentsView,agentViews}.ts, src/shared/agentsGraph.ts.
Уже решено: ACP сам не шлёт subagent events; читаем только session state/wire/tasks; agentId верхнего узла = ACP toolCallId, taskId = subagentId; nested parent связать по доказанной корреляции; agentStop=false.
Порядок: reader/validation → live correlation/watchers → nested/background/resume → transcript/history limits → graph tests/flags/typecheck.
DoD: дословно «Готово, когда» этапа 4. Не читать credentials/global logs, ничего не писать в KIMI_CODE_HOME, не делать swarm/Tower UI, не коммитить/push.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 5

```text
Работаем в /Users/fost/Projects/Agentura. Задача: подключить готовый Kimi adapter ко всем provider surfaces и настройкам.
Читай: roadmap 39 и точки входа этапа 5; актуальные src/extension/{chatPanel,chatController,extension,sessionsService,sidebarView,settingsController}.ts, src/settings.ts, src/protocol.ts, src/webview provider files, media/brands/SOURCES.md.
Уже решено: ленивый процесс, настройки только новой сессии, login=kimi acp --login, нет квоты/MCP/remote/agentStop, brand asset только с проверяемым источником.
Порядок: host wiring → provider enums/session service → menus/task handoff/i18n/icon → settings/defaults/login → provider audit/full check.
DoD: дословно «Готово, когда» этапа 5. Не менять реализацию адаптера без дефекта приёмки, не коммитить/push.
В отчёте: сделано, список всех provider-switch мест, отклонения, непроверенное.
```

### Этап 6

```text
Работаем в /Users/fost/Projects/Agentura. Задача: документация Kimi и финальная сквозная приёмка.
Читай: roadmap 39 и чекпоинты предыдущих этапов, docs/kimi-protocol.md (если уже создан), README.md, README.ru.md, docs/features.md, scripts/kimi-smoke.mjs, фактические src/agent/kimi/ и features.ts.
Уже решено: README EN/RU раздельно; описывать только проверенное; визуальную приёмку не имитировать тестами; .vsix/коммит/push не выполнять.
Порядок: protocol/README/features → smoke → TZ=UTC npm run check → npm run test:integration → git diff --check → ручной чеклист.
DoD: дословно «Готово, когда» этапа 6.
В отчёте: сделано, результаты команд, непроверенное, ручной чеклист, открытые вопросы.
```

## Риски и открытые вопросы

- **Версия протокола:** исходник и установленный CLI совпали на `2.6.0` при исследовании, но живые кадры ещё не сняты. До спайка все детали кроме задокументированных методов — не контракт.
- **Граф зависит от внутреннего persistence:** `wire.jsonl` имеет версионирование и migration в Kimi, но это не ACP. Изолировать читатель, проверять `protocol_version`, мягко скрывать неподдержанные записи и не переносить миграции Kimi в Agentura без необходимости.
- **Корреляция replay:** synthetic turn ids в `session/load` и ACP prefix `${turnId}:${toolCallId}` должны совпасть с `parentToolCallId` в parent wire. Если нет — этап 1 обязан найти устойчивый ключ; без него nested graph не выдумывать.
- **План и feedback:** Kimi использует permission options, а не Claude `ExitPlanMode`. Нужно живьём проверить текст плана и как после `plan_revise` доставить feedback, не оставляя ход висящим.
- **Режим `acceptEdits → auto` шире названия:** это осознанный нативный маппинг, требующий явной подписи. Если владелец не принимает расширение до команд, оставить `acceptEdits` неактивным для Kimi, а не молча менять безопасность.
- **Boolean thinking:** общий `EffortLevel` не покрывает `off/on`; v1 сохраняет серверное состояние и не обещает отдельный toggle.
- **Фоновые агенты между ходами:** ACP main session может завершить prompt до дочернего результата. Нужны watcher и доставка wakeup/notification по фактическим кадрам; не останавливать background узлы на `turn.result`.
- **Нагрузка графа:** только incremental reads, ограничение истории и остановка всех watchers на dispose; не отправлять полные wire/транскрипты в каждый `agents.snapshot`.
- **Грязное дерево:** roadmap 38 сейчас меняет ACP mapper, controller, protocol, Composer, store и strings. Начало до его приёмки создаст конфликты; не править эти файлы параллельно в основном дереве.

## Порядок работы

Строго `1 → 2 → 3 → 4 → 5 → 6`. Этап 2 начинается только после `go`; граф нельзя выкинуть из релиза ради быстрого базового чата, потому что это центральное требование интеграции. Работа начинается после закрытия roadmap 38 или в отдельном worktree без пересечения с его WIP. Приёмка каждого этапа — diff + команды DoD + checkpoint в этом файле. Коммит, merge, package, установка и push — только по явному запросу владельца.

## Checkpoint

- 2026-11-14: **все этапы 1–6 приняты и влиты в `main`**. Исходный worktree был `/Users/fost/Projects/Agentura-kimi-39`, ветка `roadmap-39-kimi`; после fast-forward merge и проверки отсутствия неперенесённой работы worktree и merged branch удалены. Основной `pwd`: `/Users/fost/Projects/Agentura`. Push не выполнялся.
- Изменения: Kimi ACP core/interactions/history/graph и тесты в `src/agent/kimi/`; provider/host/settings/webview wiring и тесты; `scripts/kimi-smoke.mjs`; brand assets; README EN/RU, `docs/kimi-protocol.md`, `docs/features.md`; 41 sanitized fixture files и `docs/spikes/kimi-code-acp/report.md` с `go`; каноничный roadmap. Полный dirty-список даёт `git status --short`; symlink `node_modules` untracked намеренно. Основное дерево не редактировалось.
- Проверки этапов: fixtures 1044 JSON records валидны, sanitization/manifest чист; этап 2 — 44 targeted + typecheck; этап 3 — 54 targeted + 2406 full tests после fix deny→allow fallback; этап 4 — 102 graph/HUD tests + typecheck; этап 5 — 174 files/2450 tests + provider audit; этап 6 — повторные 174 files/2450 tests, typecheck/lint/build, 9 integration tests, live `node scripts/kimi-smoke.mjs` с pong, context 17937/1048576 и graceful close, `git diff --check`. Созданные `.vscode-test/` и `test/integration/out/` удалены.
- Этап 6: `Agent({description:"stage_6",subagent_type:"coder",run_in_background:false,prompt:<самодостаточный промт документации и сквозной приёмки>})` → `agent-8`, factual model/effort/context `unknown`. Первая live попытка зависла по timeout, вторая выявила race ожидания usage; smoke исправлен ожиданием реального `context.usage`, финальные запуски исполнителя и основного чата зелёные. Production adapter при этом не менялся.
- Runtime основного чата: requested `kimi-code/k3.1-pro`, effort high/max; factual model/effort/context `unknown` (telemetry не раскрыта). Исполнители requested `coder`, `kimi-code/k3.1-pro/high` через secondary model, отдельный Agent context, `run_in_background:false`; factual metadata `unknown`. `agentura_record_agent_launch` недоступен, intents сохранены в checkpoint.
- Исполнители: этап 1 `agent-0`→replacement `agent-1`/`agent-2`, fix `agent-3`; этап 2 `agent-4`; этап 3 `agent-5`; этап 4 `agent-6`; этап 5 `agent-7`; этап 6 `agent-8`. Requested Agent descriptions зафиксированы в истории выше checkpoint; quota/stale-lock сбои не считались успешными проверками.
- Остаток только ручной визуальный checklist владельца в Extension Development Host: новый Kimi чат→pong/thinking; Edit diff и Write raw; allow once/session/deny и Stop при generation/pending; single/multi/multi-select без Other; plan approve/revise/reject/options; image/text и PDF refusal; compact start/context без выдуманного completion; resume/rename; foreground/background/parallel/nested Agent и Agent resume в исходной new session, живой/восстановленный graph/transcript; отсутствие ложных cost/quota/MCP/Remote/agentStop/AgentSwarm/Jira host tools.
- Интеграция и релиз завершены: main `8dfc95a` влит в ветку, затем ветка fast-forward в main; финальный check зелёный (175 files/2525 tests, typecheck/lint/build). Собран и локально установлен `agentura-0.24.0.vsix`; `code --list-extensions --show-versions` подтверждает `fosteev.agentura@0.24.0`. `.codex/config.toml` не изменялся. Остаток — только ручной визуальный checklist выше.
