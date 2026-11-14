# Kimi Code (`kimi acp`): поддерживаемый протокол

Документ описывает реализацию Agentura для **Kimi Code CLI 2.6.0**, а не весь ACP и не возможности других
клиентов Kimi. Минимальная принимаемая версия — `kimi >= 2.6.0`; она проверяется в
`src/agent/kimi/executable.ts`. Живые кадры и границы зафиксированы в
`docs/spikes/kimi-code-acp/report.md` и `test/fixtures/kimi/`. Внутренние `state.json` и `wire.jsonl`
не являются стабильным ACP и описаны отдельно.

## 1. Запуск, handshake и жизненный цикл

Agentura запускает один долгоживущий процесс `kimi acp` на вкладку. Транспорт — JSON-RPC 2.0 over stdio,
один JSON-кадр на строку. Бинарник ищется в `PATH`, `~/.kimi-code/bin`, `~/.local/bin` и Homebrew;
machine-настройка `agentura.kimiExecutable` имеет приоритет. Старый CLI и чужой бинарник не запускаются.
Вход выполняется штатной командой `kimi acp --login`; Agentura не читает credentials и не показывает
неподтверждённые email, план или квоту.

`initialize` отправляет:

```json
{
  "protocolVersion": 1,
  "clientInfo": { "name": "agentura", "version": "<extension version>" },
  "clientCapabilities": {
    "fs": { "readTextFile": false, "writeTextFile": false },
    "terminal": false,
    "elicitation": { "form": {} }
  }
}
```

Reverse fs/terminal не включены: файлы и команды выполняет Kimi. Новая вкладка использует `session/new`
с `{ cwd, mcpServers: [] }`, продолжение — `session/resume` с тем же `sessionId`. Промпты исполняются
последовательно через очередь адаптера. Stop отправляет `session/cancel`; процесс остаётся доступным для
следующего хода. Pending permission/question/plan requests при Stop и dispose завершаются cancellation.

`dispose()` вызывает `session/close`, затем закрывает stdin; `SIGTERM` и `SIGKILL` остаются только
таймаут-эскалацией. Краткие процессы для list/history закрываются тем же путём. Agentura **не вызывает
`session/delete`** для пользовательских сессий.

Реализация: `src/agent/kimi/{executable,protocol,adapter}.ts`, общий транспорт — `src/agent/acp/client.ts`.

## 2. Поддерживаемое подмножество ACP

| Кадр / метод | Использование в Agentura |
| --- | --- |
| `session/new`, `session/resume` | Создание и живое продолжение сессии. Resume не перезаписывает серверные model/thinking/mode дефолтами новой вкладки. |
| `session/prompt` | Текст, image blocks и текстовый context. Ответ содержит `stopReason`, но не structured per-turn usage. |
| `session/cancel` | Stop текущего основного хода или локальной команды; не Stop отдельного субагента. |
| `session/close` | Штатное закрытие без удаления сессии. |
| `session/list`, `session/load` | Список проекта и replay главной истории. |
| `session/set_model` | Смена модели с подтверждением фактического config. |
| `session/set_config_option` | Смена `thinking`; независимая от model и mode ось. |
| `session/set_mode` | Нативные `default`, `plan`, `auto`, `yolo`. |
| `session/request_permission` | Разрешения, plan review и ограниченный fallback вопроса. |
| `elicitation/create` | Полные form-вопросы q0…qN, включая multi-select. |
| `agent_message_chunk` | `text.delta` и текст результата основного ответа. |
| `agent_thought_chunk` | Существующие `thinking.start/delta/stop`. |
| `tool_call`, `tool_call_update` | Карточки инструментов, raw input/output, lifecycle и ACP diff. |
| `available_commands_update` | Актуальный список `/`-команд в `session.init`. |
| `config_option_update`, `current_mode_update` | Подтверждённые model/thinking/mode и перевыпуск состояния UI. |
| `session_info_update` | Автозаголовок; пользовательское имя из индекса Agentura важнее. |
| `usage_update` | Только `used/size` контекстного окна. |

`user_message_chunk` используется при replay для границ ходов. Неизвестные update/record types мягко
игнорируются. Ошибка выбора model/thinking/mode показывается как ошибка, после чего UI получает последнее
подтверждённое состояние, а не optimistic placeholder.

### Инструменты и diff

Lazy `tool_call(status=pending)` не создаёт преждевременную карточку без аргументов. Canonical update с
`rawInput`, `title`, `kind`, `status` дополняет вызов; terminal `completed/failed` создаёт результат.
`Read`, `Grep`, `Bash`, `Edit`, `Write`, `Agent`, `Skill` и другие названия приводятся к существующим
карточкам Agentura; неизвестный инструмент не роняет ход. Ненулевой `exit_code` считается ошибкой даже
при ACP `completed`.

ACP `content[type=diff]` преобразуется в `structuredPatch`, `originalFile/content` и ленту `changes`.
У Edit это подтверждено живыми кадрами. **Write, включая overwrite, не вернул ACP diff в спайке**:
Agentura показывает фактические raw input/output и не синтезирует diff.

## 3. Разрешения

`session/request_permission` превращается в `permission.request`. Возвращается исходный `optionId`:

| Действие | Проверенный native option | Область |
| --- | --- | --- |
| Allow once | `approve_once` / `allow_once` (`kind=allow_once`) | Только текущий запрос. |
| Allow for session | `approve_always` / `allow_always` (`kind=allow_always`) | Только текущая Kimi-сессия; UI получает `destination: 'session'`. |
| Deny | `reject` / `reject_once` (`kind=reject_once`) | Отклонённый tool завершается failed; основной ход может продолжиться. |

Session allow не является глобальным постоянным правилом и не разрешает любой другой Bash автоматически.
`allow-edits` дополнительно переключает Agentura `acceptEdits` в нативный Kimi `auto` (предупреждение о
расширенной семантике — ниже). При разрешённом `bypassPermissions` автоматически одобряются только обычные
permission requests; plan review автоодобрением не подменяется. Если нужного deny option нет, Agentura не
подставляет allow.

## 4. Plan review, варианты и feedback

Kimi использует permission request для `ExitPlanMode`, а не Claude callback. Полный Markdown плана читается
из `toolCall.content`; префикс `Plan saved to:` отделяется в `planFilePath`. Поддержаны:

- `plan_approve` — принять;
- `plan_revise` — оставить plan mode и запросить доработку;
- `plan_reject_and_exit` — отклонить и прервать;
- `plan_opt_0`, `plan_opt_1`, … — выбрать предложенный моделью вариант с исходными id и label.

Feedback после revise отправляется **следующим `session/prompt`**. Отдельного RPC feedback нет; повторный
`ExitPlanMode` создаёт следующую карточку. Это живой сценарий спайка и regression test
`src/agent/kimi/interactive.test.ts`.

## 5. Вопросы q0 и граница Other

При `elicitation.form` Kimi отправляет `elicitation/create` с `mode: "form"` и JSON Schema. Поля начинаются
с **q0**, порядок берётся из `requestedSchema.properties`:

- `type: "string"` + `oneOf` — одиночный выбор;
- `type: "array"` + `items.anyOf`, обычно `minItems: 1` — multi-select;
- `const` — точное значение ответа, `title` — показываемый label, а не числовой индекс.

Agentura отвечает, например, `{ action: "accept", content: { q0: "ONE", q1: ["RED", "BLUE"] } }`.
Dismissal и неподдерживаемая схема получают decline/cancel. Без form capability реализован только
подтверждённый fallback: один single-select через `q0_opt_N` / `q0_skip` в permission request.

**Other не поддержан.** В живой схеме нет `qN_other`; отправленное `q0_other` Kimi проигнорировал. Произвольный
ответ вне объявленных labels приводит к честному decline, а не к выдуманному полю или значению.

## 6. Model, thinking и режимы

`configOptions` содержит независимые селекты `model`, `thinking` (`thought_level`) и `mode`. Для настроек
новой сессии каталог читается коротким `kimi provider list --json`; используется только блок `models`.
Блок `providers`, содержащий `apiKey`, не возвращается в UI, не логируется и не попадает в fixtures.

| Agentura | Kimi | Примечание |
| --- | --- | --- |
| `default` | `default` | Обычные permission cards. |
| `plan` | `plan` | Планирование и native plan review. |
| `acceptEdits` | `auto` | **Шире названия Agentura:** нативный auto разрешает безопасные правки файлов **и команды** без отдельного вопроса. Это предупреждение показано в меню и настройках. |
| `bypassPermissions` | `yolo` | Только при `agentura.allowBypassPermissions`; иначе безопасный `default`. |

`agentura.kimi.defaultModel` и `agentura.kimi.defaultEffort` применяются только к новой вкладке; пустые
значения наследуют CLI. Resume использует серверное состояние и не догоняет defaults или сохранённый index.
`config_option_update` / `current_mode_update` подтверждают изменения.

У thinking встречаются как effort (`low`, `medium`, `high`, `xhigh`, `max`), так и boolean-like `on/off`.
**`on/off` не отображаются как EffortLevel и не получают отдельного эмулированного переключателя.** Пикер
показывает только фактические effort values выбранной модели; серверное boolean значение сохраняется без
ложного `session.init.effort`.

## 7. Изображения, текст и отказ PDF

- Изображения отправляются ACP `{ type: "image", data, mimeType }`; качество vision зависит от выбранной модели.
- Обычный путь вложений Agentura при `files=false` включает текстовые файлы в context блок сообщения.
  Низкоуровневый `promptBlocks` также умеет подтверждённый embedded resource `text/plain` с file URI.
- PDF/document/blob не поддержан. В спайке Kimi не вернул RPC error, а написал `dropping blob embedded
  resource` и модель не увидела содержимое. Поэтому `KIMI_FEATURES.files=false`: обычный host path не
  отправляет PDF, а прямой вызов адаптера с PDF эмитит нефатальное предупреждение, что файл не отправлен.
  Отсутствие RPC error нельзя считать успешной доставкой.

## 8. Context, per-turn usage и `/compact`

После model turns Kimi отправляет `usage_update { used, size }`. Это заполнение контекстного окна, а не
счёт и не usage хода. Адаптер хранит последний подтверждённый кадр и эмитит `context.usage` с
`source: 'engine'`; `contextUsage()` возвращает его же.

`session/prompt.result` в проверенных кадрах содержит только `stopReason`. Поэтому каждый `turn.result`
имеет `usageKnown: false`, нулевой placeholder не выдаётся за измеренные токены, USD cost, cache TTL и
subscription quota не вычисляются.

`/compact` — локальная ACP-команда. Agentura эмитит `compaction.start`, подавляет служебный acknowledgement
как текст модели, затем закрывает локальное ожидание **`compaction.end(ok=false)` с объяснением, что
подтверждён только запуск фоновой компакции**. ACP completion event не обнаружен; успешное completion,
новые `preTokens` или уменьшение контекста не выдумываются. `/usage`, `/mcp` и `/tasks` также остаются
служебными текстовыми командами: их вывод не превращается в quota, MCP status или события графа.
Unknown ACP command даёт ошибку, а не успешное действие Agentura.

## 9. История, resume и индекс имён

- `session/list` возвращает `{ sessionId, cwd, title, updatedAt }`; адаптер фильтрует записи по cwd с
  `realpath`, сортирует по updatedAt и изолирует ошибку Kimi от списков других движков.
- `session/load` реплеит только главную историю: user/text/thinking/tools. `buildKimiHistory` поддерживает
  `live`, `maxTurns` (по умолчанию до 200) и не полагается на synthetic prefix tool id.
- `session/resume` восстанавливает серверный контекст без replay. Открытие истории и живое продолжение —
  разные операции.
- ACP rename не объявлен. Пользовательские имена хранятся в `globalState` `agentura.kimi.names`, обрезаются
  до 200 символов и имеют приоритет над поздним `session_info_update`.
- Подтверждённые session settings используют ключ `agentura.kimi.sessionSettings`; они не являются
  основанием перезаписывать серверный resume. `accountInfo()` возвращает `{}`, потому что проверенных
  account fields нет.

### Ограничение Agent после ACP resume

В исходной new session спайк подтвердил foreground/background/nested Agent и `Agent(resume=...)`. Но в
проверенных новых процессах после `session/resume` главный tool set не содержал Agent; попытки новых Agent
и Agent resume были unavailable. Read-only восстановление графа при этом работает. **Продолжение дочерних
агентов после ACP resume в v1 не обещается** — это ограничение Kimi/ACP session, а не отдельная кнопка Stop.

## 10. Живой и восстановленный граф: read-only persistence

ACP передаёт основной вызов `Agent`, но не отправляет `subagent.*` notifications и не реплеит дочерние wire.
Для панели, `AgentsGraph` и Markdown-транскриптов `src/agent/kimi/subagents.ts` дополнительно читает только:

```text
$KIMI_CODE_HOME/sessions/<workspaceId>/<sessionId>/
  state.json
  agents/main/wire.jsonl
  agents/<agent-N>/wire.jsonl
  agents/<owner>/tasks/<taskId>/output.log
```

`KIMI_CODE_HOME` по умолчанию `~/.kimi-code`. Credentials, глобальный `kimi-code.log` и произвольные пути
не открываются; session/agent/task/tool/workspace ids валидируются, realpath обязан оставаться внутри
session root, symlink escape отклоняется. Agentura ничего не записывает в это хранилище и не мигрирует его.

**Это внутренний нестабильный persistence Kimi, не ACP.** Reader принимает `state.version=2` и wire
`protocol_version=1.5` с совместимым `min_protocol_version`; неподдержанную версию и неизвестные records
мягко пропускает. Последующее обновление CLI может потребовать отдельной адаптации.

### Корреляция идентификаторов

- Live ACP id имеет вид `${syntheticTurnPrefix}:${rawToolCallId}`. Prefix меняется при replay; стабилен
  только raw suffix `tool_…`. `rawKimiToolCallId` связывает ACP tool call с durable
  `subagent.spawned.parentToolCallId`.
- Верхний узел получает `agentId = ACP toolCallId`, чтобы связаться с `AgentGroup`, а после durable spawn —
  `taskId = subagentId` (`agent-N`), `taskType = 'subagent'`.
- Nested узел создаётся только при доказанной связи durable `parentAgentId + parentToolCallId` в wire
  родителя. Его `parentAgentId` — Agentura id родителя. Верхнеуровневое `state.agents[child].parentAgentId`
  не используется как источник истины при расхождении с durable records/labels.
- Повторный `Agent(resume=agent-N)` — новый ACP anchor с тем же subagent id; watcher переоткрывает running
  узел без потери накопленного таймлайна.
- `subagent.completed/failed/cancelled`, `task.started/terminated`, `usage.record` и
  `context.append_loop_event` дают статус, summary, вызовы, тексты/thinking и токены субагента. Фоновые Bash
  задачи связываются по `parentToolCallId`; terminal summary можно взять из bounded `output.log`.
- Завершение основного `turn.result` не гасит background nodes. При восстановлении без живого движка
  незавершённые durable nodes не выдаются за running, кроме явного `tasksAlive`.

Live watcher использует byte offset и ждёт newline неполной последней строки, а не перечитывает весь wire
на каждый тик. По умолчанию: poll 250 мс, до 100 узлов, глубина до 8, до 400 timeline events на узел.
Восстановление включает последние 30 агентов и до 400 событий на узел с сохранением `agent.start`.
Транскрипт read-only Markdown ограничен 4 МиБ чтения, 2000 records и 200 000 символов; `state.json` — 1 МиБ,
output.log — 4000 символов. Orphan/cycle/unknown records не создают выдуманных связей.

### AgentSwarm off

Реальный AgentSwarm call в спайке завершился `failed`: `Swarm mode is off ... no subagents were started`;
`/swarm` через ACP вернул Unknown command. Failed call может отображаться терминальным failed узлом, но
**работающий AgentSwarm, swarm mode и swarm UI не поддержаны**. Параллельный граф доказан двумя обычными Agent.

## 11. Явные ограничения v1

`KIMI_FEATURES` в `src/agent/features.ts` включает modes, plan, questions, images, compact start, context,
skills, subagents и agentTranscript. Остальное скрыто или не имитируется:

- нет structured per-turn input/output/cache usage, USD cost, cache TTL и subscription quota;
- нет структурного MCP status/toggle/reconnect/reload и Remote Control; MCP calls могут быть видны как tools;
- нет отдельного Stop субагента (`agentStop=false`), browser integration и auto-compact thresholds;
- нет PDF/document delivery, Other в вопросах и гарантированного Write diff;
- нет работающего AgentSwarm и обещания Agent/Agent resume после ACP session resume;
- нет in-process Jira host tools или готового MCP bridge к `AgentJiraTools`: Kimi использует свои skills/MCP,
  настроенные отдельно, а Agentura не превращает Claude/Codex host tools в ACP автоматически;
- внутренний graph/transcript persistence нестабилен; `/compact` не сообщает completion.

Ручная визуальная приёмка Extension Development Host не заменяется этим документом или fixture-тестами.
