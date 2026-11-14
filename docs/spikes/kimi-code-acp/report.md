# Спайк `kimi acp` · 2026-11-13

Проверен установленный Kimi Code CLI **2.6.0** (`<HOME>/.kimi-code/bin/kimi --version`). Транспорт — только `kimi acp`, JSON-RPC 2.0 over stdio, один NDJSON-кадр на строку. `initialize` во всех основных процессах использовал `protocolVersion: 1`, `fs.readTextFile/writeTextFile=false`, `terminal=false`, `elicitation.form={}`. Реальные конфиги, credentials и чужие сессии не читались и не изменялись; логин использовался штатно CLI.

Все prompt-тексты, файлы, custom agent `nester` и Skill `marker-skill` были синтетическими и находились во временном workspace `<WORK>`. Дополнительный процесс без `elicitation.form` проверил fallback отдельно. Сохранённые кадры сокращены: streaming-дельты аргументов заменены каноническими `rawInput` и terminal updates, чужие session-list записи и system-reminder со списком MCP tools исключены.

## Вопрос → живой факт → флаг/маппинг

| Вопрос | Живой факт Kimi Code 2.6.0 | Флаг/маппинг для этапов 2–4 |
|---|---|---|
| Handshake и возможности | `agentInfo={name:"Kimi Code CLI",version:"2.6.0"}`; `loadSession=true`, `image=true`, `audio=false`, `embeddedContext=true`; session capabilities: `list/resume/close/delete/fork/additionalDirectories`; MCP HTTP/SSE; auth terminal. | `kimi acp`; отдельный процесс на вкладку; reverse fs/terminal не включать. |
| Text/thinking/title | Потоковые `agent_message_chunk` и `agent_thought_chunk` имеют `{content:{type:"text",text}}`. `session_info_update.title` после первого хода содержит автозаголовок из первого prompt (на длинном prompt — укороченный). | text/thinking → существующие delta events; title → `session.title`; live user echo не выдумывать. |
| Основной tool lifecycle | Сначала lazy `tool_call(status=pending)`, затем cumulative argument deltas, canonical `tool_call_update(rawInput,title,kind,status=in_progress)`, затем `completed/failed` с `rawOutput`. ACP id — `${turnId}:${rawToolCallId}`. | Эмитить start один раз; терминальный result по `completed/failed`; неизвестные tools не ронять. |
| Read/Grep/Bash | Read вернул содержимое в `rawOutput`; Grep — путь; Bash — stdout. `rawInput`: `{path}`, `{path,pattern}`, `{command}`. | Маппинг `Read/Grep/Bash`; raw output сохранять для карточки. |
| Edit diff | Canonical Edit update содержит `content:[{type:"diff",path,oldText,newText}, {type:"content",...}]` уже на старте выполнения. | ACP diff → structured patch/`changes`; не перечитывать session storage. |
| Write diff | Новый Write и overwrite существующего файла дали `rawInput`, absolute `locations` и `rawOutput`, но **без ACP diff**. Модель перед overwrite вызвала Read. | Не обещать diff для Write; использовать фактический rawInput/rawOutput и не синтезировать ACP diff. |
| Permission once/session/deny | `session/request_permission` с `approve_once/allow_once`, `approve_always/allow_always` («Approve for this session»), `reject/reject_once`. Ответ: `{outcome:{outcome:"selected",optionId}}`. Deny дал failed tool и `end_turn`. | `canAlwaysAllow=true`, scope только `session`; allow once/deny напрямую. Session rule не означает глобально все Bash: повторный другой command снова запросил approval. |
| Stop во время generation | `session/cancel` вернул `{stopReason:"cancelled"}`; процесс принял следующий prompt. | `interrupt()` без kill; cancelled → interrupted turn. |
| Stop при pending permission | Без ответа на reverse request сервер пометил tool `failed` (`Aborted before command started`) и вернул `cancelled`. | Снимать локальные pending cards; желательно завершать reverse request `outcome=cancelled`, чтобы не оставлять warning при close. |
| Close | `session/close` вернул `{}`; stdin end завершил процессы. | close → stdin end → SIGTERM/SIGKILL только по timeout. |
| Model/thinking/mode | `configOptions`: независимые `model`, `thinking` (`category=thought_level`), `mode`. Проверены `session/set_config_option`, `session/set_model`, `session/set_mode`, подтверждения `config_option_update/current_mode_update`. Режимы: `default/plan/auto/yolo`. | `default→default`, `plan→plan`, `acceptEdits→auto`, `bypassPermissions→yolo` только при разрешении; auto шире accept-edits. |
| Thinking варианты | Обычные модели: `low/high/max`. У `kimi-for-coding-highspeed`: начальный набор `on/high`, после выбора `on` — только `on`. | Не приводить `on/off` к EffortLevel; отображать только фактические effort values и сохранять серверное boolean-like значение. |
| Невалидный выбор | thinking: `-32602 Unknown thinking value`; mode: `-32602 Unknown modeId`; model: `-32603 Internal error` с details о неconfigured model. | Ошибку возвращать в UI, не подтверждать локальный optimistic выбор. |
| `usage_update` | После model turns: `{sessionUpdate:"usage_update",used:<n>,size:1048576}`. `session/prompt.result` содержит только `stopReason`, без per-turn token usage. | `used/size` → context gauge; per-turn `usageKnown:false`; цену и subscription limits не вычислять. |
| `session/list` | Записи `{sessionId,cwd,title,updatedAt}`; тестовая запись найдена по cwd. | Фильтровать cwd/realpath на клиенте; rename только в индексе Agentura. |
| `session/load` | До RPC result реплеит main history: user, consolidated text/thinking, `tool_call` + terminal `tool_call_update`; затем config/modes и commands. Сохранённый `thinking=low` восстановлен. | Реконструировать ленту; tool start/result обрабатывать в replay; применять серверный config без перезаписи defaults. |
| `session/resume` | Без history replay; следующий prompt восстановил исходный маркер контекста. | Живое продолжение вкладки через resume; history отдельно через load. |
| Plan review | `ExitPlanMode` → `session/request_permission`; полный markdown плана в `toolCall.content[0].content.text`, далее action text. Без вариантов: `plan_approve`, `plan_revise`, `plan_reject_and_exit`. С двумя вариантами: `plan_opt_0`, `plan_opt_1` + revise/reject. | Native `plan=true`; permission request → plan card; optionId возвращать без переименования. |
| Revise feedback | `plan_revise` оставил plan mode; новый `session/prompt` с feedback привёл к Edit плана и повторному ExitPlanMode; revised текст содержал marker, `plan_approve` завершил review без висящего prompt. | Feedback отправлять следующим `session/prompt`; не ждать отдельного RPC feedback. |
| AskUserQuestion, form | `elicitation/create`: `mode:"form"`, `message`, `requestedSchema{type:"object",properties,required}`. Поля начинаются с **q0**. Single: string + `oneOf`; multi-select: array + `minItems:1` + `items.anyOf`. `const/title` содержат сам label, не числовой индекс. | `questions=true`; `{action:"accept",content:{q0:"BETA",q1:["RED","BLUE"]}}`; decline/cancel для dismissal. |
| Несколько вопросов | Один form вместил q0 single и q1 multi-select. Живой ответ модели: `ONE | RED, BLUE`. | Сохранять declared order; не использовать q1-based схему Antigravity. |
| Other | Отдельного `qN_other` в схеме нет. Отправленное `q0_other` было проигнорировано; tool завершился dismissed. | Не объявлять поддержку Other; показывать границу/decline, не подставлять выдуманный ответ. |
| Без elicitation capability | Fallback — `session/request_permission` с `q0_opt_0`, `q0_opt_1`, `q0_skip`; single question only. | Для Agentura включать form; fallback можно маппить как ограниченный single-select. |
| Image | ACP image block принят; модель описала цвет и вернула synthetic marker. | `images=true`; vision-точность зависит от модели. |
| Embedded text | `resource{uri,mimeType:"text/plain",text}` принят; модель вернула marker из resource без Read. | Текстовый context fallback поддержан. |
| PDF/blob | `resource{mimeType:"application/pdf",blob}` не дал RPC error, но stderr: `acp: dropping blob embedded resource`; модель вернула `BLOB_NOT_VISIBLE`. | `files=false`; PDF не обещать, warning не выдавать за успешную доставку. |
| `/compact` | Текст: `Context compaction started — it runs in the background...`; отдельного compaction ACP event не было. Через 10 секунд повторный `/usage` вернул неизменные `23894 / 1048576` и session total; это не доказывает ни completion, ни зависание. | `compact=true` только как local command с start ack; ack не смешивать с model generation и не синтезировать `compaction.end` без нового факта. |
| `/usage`, `/mcp`, `/tasks` | Локальные text responses: context/session total; текстовый MCP status; `No background tasks.`. | Не парсить в quota/cost или структурный MCP toggle; `mcp=false`. |
| Skill и commands | Skill загрузился inline (`Skill "marker-skill" loaded inline`) и модель вернула `SKILL_MARKER_551`. `available_commands_update` содержит built-ins `compact/usage/mcp/tasks/help` (плюс локальные команды, исключённые из fixture). | `skills=true`; карточка Skill по tool call; commands обновлять из notification. |
| `kimi provider list --json` | JSON имеет `providers` и `models`. Models: id → `{provider,model,maxContextSize,capabilities,displayName,supportEfforts?,defaultEffort?}`. Providers содержит `apiKey`. | Для каталога использовать только `models`; никогда не выводить providers/apiKey в UI, лог или fixture. |

## Точные интерактивные схемы

Обычное permission:

```json
{
  "method": "session/request_permission",
  "params": {
    "toolCall": { "toolCallId": "9:tool_<id>", "title": "Bash" },
    "options": [
      { "optionId": "approve_once", "name": "Approve once", "kind": "allow_once" },
      { "optionId": "approve_always", "name": "Approve for this session", "kind": "allow_always" },
      { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

Form question (два вопроса):

```json
{
  "mode": "form",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "q0": { "type": "string", "oneOf": [{ "const": "ONE", "title": "ONE" }] },
      "q1": {
        "type": "array",
        "minItems": 1,
        "items": { "anyOf": [{ "const": "RED", "title": "RED" }] }
      }
    },
    "required": ["q0", "q1"]
  }
}
```

Context update:

```json
{ "sessionUpdate": "usage_update", "used": 19219, "size": 1048576 }
```

## Живой граф агентов

| Проверка | Факт и корреляция |
|---|---|
| Foreground Agent | ACP `1:tool_9OL...` → main wire `tool.call(toolCallId=tool_9OL...)` → `subagent.spawned{subagentId:agent-0,parentToolCallId:tool_9OL...,parentAgentId:main}` → completed summary/usage. |
| Background Agent | Сразу после main turn: spawned/started + `task.started(status=running)`. После ожидания **без нового prompt**: `subagent.completed{resultSummary,usage}` + `task.terminated(status=completed)`. `taskId` отличается от `subagentId`; `agentId` в task info равен subagentId. |
| Parallel Agent | Два foreground Agent в одном batch: два разных ACP tool ids и agent-2/agent-3; spawned обоих предшествовал completed, оба terminal summary/usage сохранены. |
| Nested custom agent | main → agent-0 (`nester`) → agent-1 (`explore`). В outer wire nested spawned имеет `parentAgentId=agent-0`, raw `parentToolCallId` совпадает с `tool.call` в **outer** wire. |
| Resume того же Agent | Новый main tool call с `resume=agent-0` породил повторные `subagent.spawned/started/completed` с тем же `subagentId=agent-0`, но новым parentToolCallId; outer wire содержит второй `turn.prompt` и `RESUME_MARKER_1502`. |
| `state.json.agents` | main/sub и homedir есть. Для nested agent-1 верхнеуровневое `parentAgentId` было `main`, а `labels.parentAgentId` — правильное `agent-0`. |
| `tasks/` | В session root каталога `tasks/` нет. Жизненный цикл находится в main `wire.jsonl` (`task.started/terminated`); фактический output лежит в `agents/main/tasks/<taskId>/output.log` (для nested child — в `agents/agent-1/tasks/<taskId>/output.log`). Fixture `tasks/background.ndjson` — durable records, не выдуманный JSON task file. |
| ACP после дочернего completion | ACP содержит только main Agent tool call/result; отдельных `subagent.*` ACP notifications нет. Для графа нужен read-only watcher state/wire. |
| Replay | `session/load` реплеит main Agent tool calls, но не дочерние agents/wire/events. Граф восстанавливать отдельно из persisted state/wire с terminal status, не помечая completed как running. |
| Устойчивый ключ replay | Live `0:tool_G2...` стал replay `1:tool_G2...`; live `1:tool_K2...` стал replay `3:tool_K2...`. **Raw suffix toolCallId** совпадает с durable `parentToolCallId`; synthetic prefix нестабилен. |

Маппинг этапа 4: верхний `agentId` = live ACP toolCallId, `taskId` = subagentId; persisted join по suffix после первого `:`. Nested parent определять по durable `parentAgentId` + `parentToolCallId` в wire родителя; не доверять верхнеуровневому `state.agents[child].parentAgentId` при расхождении с `labels`/durable event. Resume переоткрывает тот же subagentId и добавляет новый вызов/terminal record.

### AgentSwarm — отдельная граница

Реальный `AgentSwarm` tool call был отправлен моделью и виден в ACP с `prompt_template/items`, но завершился `failed`: `Swarm mode is off ... no subagents were started`. Попытка `/swarm` через ACP вернула `Unknown ACP command: /swarm`. Поэтому parallel граф доказан двумя настоящими Agent, но **работающий AgentSwarm не воспроизведён**; нельзя выдавать его за поддержанный в v1.

## Fixtures

- `acp-basic.ndjson` — handshake/new, text/thinking, tools/diff, permissions, Stop, close; `acp-write-overwrite.ndjson` — overwrite без ACP diff.
- `acp-config.ndjson` — model/thinking/mode changes, updates и ошибки; `acp-config-boolean.ndjson` — highspeed `on/high`.
- `acp-history.ndjson` — list/load replay.
- `acp-plan-questions.ndjson` — plan approve/revise/options, form single/multi/multi-select/Other; `acp-question-fallback.ndjson` — no-elicitation fallback.
- `acp-attachments.ndjson` — image/resource/blob, slash commands, Skill; `acp-compact-wait.ndjson` — повторный usage через 10 секунд после compact.
- `acp-agents.ndjson` — foreground/background/parallel/nested/resume; `acp-agentswarm-rejected.ndjson` — реальный rejected AgentSwarm и `Unknown ACP command: /swarm`.
- `graph/base/`, `graph/nested-resume/` — укороченные state/main/child wire, `correlations.json`, tasks output.log и отдельный ACP replay с нестабильным prefix и стабильным raw tool id.
- `acp-background.ndjson` — отдельный background turn.
- `state.json` — sanitized nested session state.
- `wire-main.ndjson`, `wire-outer.ndjson`, `wire-child.ndjson` — main и два уровня nested/resumed graph.
- `wire-background-main.ndjson`, `wire-background-child.ndjson` — background lifecycle, calls и usage.
- `tasks/background.ndjson` — durable `task.started/terminated` из main wire.
- `provider-list.json` — только безопасный `models`, блок providers с apiKey исключён.
- `manifest.json` — версия, placeholders и список файлов.

Во всех ACP NDJSON каждая строка имеет wrapper `{dir:"in"|"out",scenario,msg}`; плоские wire/tasks NDJSON содержат сами очищенные JSON records, а `graph/**/wire.jsonl` использует wrapper `{dir:"state",scenario,msg}` с record в `msg`. `<HOME>`, `<WORK>`, `<TMP>`, `<EMAIL>`, `<REDACTED>` — стабильные placeholders.

## Cleanup

После сохранения fixtures через ACP `session/delete` обработаны только 23 тестовые session id этого этапа: 14 удалены, 9 уже отсутствовали (`-32602 Unknown sessionId` после параллельного cleanup), других ошибок нет. Чужие сессии не перечислялись и не удалялись.

## Не воспроизведено и ограничения

- Работающий AgentSwarm: блокируется session-local swarm mode, который через ACP `/swarm` не включается. Это граница, не блокер parallel Agent graph.
- Other для AskUserQuestion и PDF/blob отсутствуют; Write не дал diff. Это подтверждённые ограничения, не поддержанные возможности.
- В проверенных новых процессах `session/resume` main tool set не содержал Agent; попытки новых Agent/Agent resume там вернули текст об unavailable tool. Nested и Agent resume доказаны в исходной new session. Read-only восстановление графа через load/state/wire при этом работает; продолжение дочерних agents после ACP resume не обещать.
- В первых комбинированных прогонах после серии invalid config/mode и после одного multi-agent участка несколько последующих prompts вернули `end_turn` без model updates. Чистые sessions повторили все обязательные сценарии успешно; точный триггер пустых turns не изолирован и не используется как доказательство схемы.
- `/compact` подтверждён только start acknowledgement; отдельного completion notification не снято, повторный `/usage` через 10 секунд не изменился. Структурные subscription limits, USD cost и per-turn usage ACP не сообщает.
- Не проверялись fork/delete кроме удаления собственных тестовых сессий, reverse fs/terminal, дополнительные directories, MCP bridge Agentura, Windows, auth logout/expiry.
- Внутренние wire/state не являются стабильным ACP. Reader этапа 4 должен проверять `metadata.protocol_version/min_protocol_version`, ограничивать чтение и мягко пропускать неизвестные records.

go
