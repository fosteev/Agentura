# 29 — Cursor как четвёртый движок

> Статус: этап 1 принят 2026-11-05 · следующий — 2
>
> Исполнитель отмечает чекбоксы по ходу, только после проверки из «Готово, когда». Статусы живут здесь.

## Цель

Новая вкладка Agentura может идти на Cursor CLI (`agent acp`): текст хода стримится в ленту, инструменты и разрешения приходят карточками, сессию можно остановить и продолжить. Claude, Codex и Antigravity не меняют поведения.

## Контекст и ограничения

Проверено по коду 2026-11-05. Граница движка уже общая: `AgentProvider` (`src/agent/types.ts`), `AgentAdapter` / `AgentSession` / `AgentEvent`, флаги UI в `ProviderFeatures` (`src/agent/features.ts`). Четвёртый движок встраивается в те же места, куда встроены Codex и Antigravity, а не в параллельный чат.

Точки входа, которые этапы 2–5 трогают только когда до них дошла очередь:

- `AgentProvider` — `src/agent/types.ts` (union `'claude' | 'codex' | 'antigravity'`).
- `PROVIDERS`, `agentura.defaultProvider` — `src/settings.ts`, `package.json` (`agentura.codexExecutable` / `agentura.antigravityExecutable` рядом, machine-scope).
- Фабрика — `createChatServices` и `adapterOf` в `src/extension/chatPanel.ts`.
- Список сессий — `ExtraProvider` в `src/extension/sessionsService.ts`.
- Локатор — `EngineLocator` в `src/extension/engineLocator.ts`; образец резолвера — `src/agent/codex/executable.ts`.
- Образец долгого JSON-RPC-процесса — `src/agent/codex/client.ts`, `src/agent/codex/adapter.ts`. Новые `AgentEvent` не заводить.

### Что уже известно про CLI

Снято с документации Cursor 2026-11-05, **живым процессом не проверено**. Бинарника нет: `agent` и `cursor-agent` отсутствуют в `PATH` и в `~/.local/bin`; в `PATH` есть только редактор `cursor`.

Документы: [ACP](https://cursor.com/docs/cli/acp), [параметры](https://cursor.com/docs/cli/reference/parameters), [output format](https://cursor.com/docs/cli/reference/output-format), [headless](https://cursor.com/docs/cli/headless).

- Запуск интеграции: `agent acp`. Транспорт stdio, JSON-RPC 2.0, один JSON на строку. Клиент пишет в stdin, сервер — в stdout, логи могут идти в stderr.
- Порядок из доков: `initialize` → `authenticate` `{methodId: "cursor_login"}` → `session/new` или `session/load` → `session/prompt` → уведомления `session/update` → ответ на `session/request_permission` → по желанию `session/cancel`.
- Пример клиента шлёт `initialize` с `protocolVersion: 1` и `session/new` с `{cwd, mcpServers: []}`. `session/prompt` принимает `prompt: [{type: "text", text}]` и возвращает `stopReason`. В примере разобран только `session/update` с `sessionUpdate: "agent_message_chunk"`.
- Разрешения: сервер шлёт `session/request_permission` и ждёт решение. В прозе доков — `allow-once` | `allow-always` | `reject-once`. В примере клиента ответ другой формы: `{outcome: {outcome: "selected", optionId: "allow-once"}}`. Без ответа ход блокируется. Какая форма живая — вопрос спайка, не код.
- Режимы, названные в доках: `agent`, `plan`, `ask`. Имени RPC-метода, которым режим задаётся, на странице нет.
- Методы расширения (доки): блокирующие `cursor/ask_question`, `cursor/create_plan`; уведомления `cursor/update_todos`, `cursor/task`, `cursor/generate_image`. Пока клиент не ответил на блокирующий метод, агент ждёт.
- Вход: заранее `agent login`, либо `--api-key` / `CURSOR_API_KEY`, либо `--auth-token` / `CURSOR_AUTH_TOKEN`. Ключи Agentura не хранит.
- MCP: проектный и пользовательский `.cursor/mcp.json` подхватывает сам CLI. Командные MCP из дашборда Cursor в ACP не работают.
- Печать `agent -p --output-format stream-json` — другой режим: один прогон на процесс, thinking скрыт, разрешения через `--force` / `--yolo`. Это не транспорт вкладки.
- Список чатов в ACP-странице не описан. У CLI есть команды `agent ls`, `agent resume`, `agent create-chat`. Где лежат файлы истории — не установлено.

### Принятые решения

- Провайдер `cursor`, в UI «Cursor». Код — `src/agent/cursor/`. Настройка `agentura.cursorExecutable` (machine-scope). `agentura.defaultProvider` получает значение `cursor`.
- Транспорт — долгоживущий `agent acp` на сессию, по образцу Codex app-server. `agent -p` не используем и не держим запасным путём в том же адаптере.
- Один ход за раз: очередь на стороне сессии, следующий `session/prompt` после завершения предыдущего. Stop — `session/cancel`, процесс не убивать; `dispose` закрывает stdin, ждёт grace, затем kill.
- Режим Agentura → Cursor, пока спайк не нашёл более точного API: `default` и `acceptEdits` → режим `agent` без автоответа на разрешения; `plan` → `plan`; `ask` в Agentura не добавляем. `bypassPermissions` автоотвечает разрешением «один раз» только если в опциях сессии `allowBypassPermissions`; иначе молча остаётся `default`. `--force` / `--yolo` не передаём никогда. `acceptEdits` в v1 не сильнее `default`: отдельного «разрешить только правки» доки не описывают, выдумывать его нельзя.
- Флаги v1, если спайк не принесёт чисел и списков: `modes`, `plan`, `questions` — да; `nativeSettings`, `compact`, `autoCompact`, `context`, `cost`, `subagents`, `agentStop`, `agentTranscript`, `images`, `files`, `remote`, `browser`, `mcp*`, `skills` — нет. Субагенты (`cursor/task`) и todo (`cursor/update_todos`) в ленту не рисуем: уведомление о завершении без живого потока — не вкладка «агенты».
- Картинки и файлы в `send` отбрасываются с `warn`, как ранний Codex, пока спайк не записал формат блока.
- Имена сессий своим индексом не дублируем. Нет метода переименования — `renameSession` завершается без записи и без ошибки.
- Чужие файлы настроек не пишем: `~/.cursor`, `.cursor/mcp.json`, `~/.claude`, `~/.codex`, `~/.gemini`.
- Ветка этапа — уже созданная `stage-N`, не `feature/cursor-support`. Этапы строго по порядку: контракт каждого следующего — отчёт и фикстура предыдущего. Worktree не заводить.

## Этапы

### 1. Спайк `agent acp`

Зачем: страницы Cursor описывают каркас, но не живые кадры. Код маппера по докам повторит ошибку Codex, где сервер не слал `"jsonrpc":"2.0"`. Этап только снимает протокол и записывает решение go/no-go.

**Сессия:** opus. Последовательно, первый. Суждение неизбежно: какой кадр считать контрактом, а какой шумом stderr.

- [x] Поставить и залогинить CLI вне репозитория, если его всё ещё нет: `agent about` опознаёт Cursor, `agent status` показывает вход. В репозиторий бинарник и токены не класть.
- [x] Прогон во временной папке, модель по умолчанию аккаунта, короткие промты. Записать сырой NDJSON stdin/stdout (stderr отдельно) для: `initialize`, `authenticate`, `session/new`, ход «ответь одним словом pong», ход с чтением файла, один `session/request_permission` и ответ, `session/cancel` посреди хода, `session/load` той же сессии, смена режима на `plan` тем способом, который сервер реально принял.
- [x] Отдельно спросить у сервера список методов, если он его отдаёт (`initialize` result, `rpc.discover` или аналог — только если ответ пришёл; не перебирать выдуманные имена пачкой). Зафиксировать, есть ли список моделей, список сессий, usage/cost, смена модели.
- [x] Очистить запись от домашних путей, email, токенов, ключей. Фикстура `test/fixtures/cursor/acp-pong.ndjson`. Отчёт `docs/spikes/cursor-acp/report.md`: версия CLI, точная строка запуска, таблица метод → пример кадра, go/no-go. Сырой лог с машины в git не коммитить.
- [x] В отчёте закрыть таблицу решений, без которой этап 2 не начинается: форма JSON-RPC (поле `jsonrpc` есть или нет); id разрешений и форма ответа; как задаётся режим; есть ли `session/list` или только `agent ls`; есть ли токены и цена; как выглядит tool-вызов в `session/update`; что делать с `cursor/ask_question` и `cursor/create_plan` (пришли живьём или только в доках).

**Готово, когда:** `docs/spikes/cursor-acp/report.md` заканчивается строкой `go` или `stop`. `go` — есть фикстура pong без секретов и таблица решений. `stop` — ACP не поднялся; этапы 2–5 не начинать и print-режим не подставлять. Проверка: `rg -n "sk-|Bearer|api_key|CURSOR_" test/fixtures/cursor docs/spikes/cursor-acp` пусто.

**Решения (2026-11-05, по итогам сессии 1):**

- Раскладка: `test/fixtures/cursor/acp-pong.ndjson` (обёртка `dir` / `scenario` / `msg`, внутри `msg` — кадр JSON-RPC) и `docs/spikes/cursor-acp/report.md`. Кода адаптера нет.
- Контракт: `jsonrpc` = `2.0` на обоих направлениях. Текст хода — `session/update` / `agent_message_chunk` / `content:{type:"text",text}`. `stopReason`: `end_turn` или `cancelled`. `session/cancel` — уведомление без id, `{sessionId}`. Режим — `session/set_mode` `{sessionId, modeId}` (`plan` принят, result `{}` плюс `current_mode_update`). `session/load` `{sessionId, cwd, mcpServers:[]}` играет историю через `session/update` (в том числе `user_message_chunk`) и в том же процессе, и в новом. В фикстуре повтор сокращён: `toolCallId` там `replay-*`, живая форма `tool_…` на ходах read/write/cancel/permission. `session/list` `{cwd}` → `{sessions:[{sessionId,cwd,updatedAt}]}`. Модель — `session/set_config_option` `{configId:"model", value:<modelId из availableModels>}`; флаг `--model` у `agent acp` модель не сменил. Разрешение: id запроса в снимке `0` (так же у `cursor/create_plan`); остальные id фикстуры ненулевые — это не закон «id всегда 0», клиент проверяет наличие поля, не truthiness. Ответ `{outcome:{outcome:"selected", optionId}}`, id с дефисом (`allow-once`), `kind` с подчёркиванием (`allow_once`). `cursor/create_plan` живой, отказ `{outcome:{outcome:"rejected", reason}}` ход не вешает. Tool — `tool_call` / `tool_call_update`, виды `read` | `search` | `edit` | `execute` | `other`.
- Отступления: read, edit и `sleep` разрешения не просили; кадр снят ходом `curl`+`head`, сервер сам написал, что команды нет в allowlist. Список моделей ужат до двух образцов и сентинела `_modelsCount` / `_optionsCount`. Имена `availableCommands` на приёмке заменены двумя образцами и `_commandsCount`: в сыром списке были локальные скиллы. Пути — `<WORK>`, `<path>`, `<tmp>`; машинный temp-путь, разрезанный по дельтам плана, снят на приёмке. `sessionUpdate:"plan"` с `entries` приходил один раз, в ленту v1 не идёт. `rpc.discover` не вызывали — `initialize` его не предлагал. Первая сессия упёрлась в стену оплаты и в фикстуру не вошла.
- Не проверено: доллары хода, блок картинки (`promptCapabilities.image` true, кадра не было — дропать), `cursor/ask_question` (флаг `questions` не поднимать), todo и `cursor/task`, переименование, JSON у `agent ls`, Windows. `session/delete` не заявлен, чаты спайка в аккаунте остались. Модель аккаунта возвращена на Auto (`default[]`).

### 2. Процесс, ход, текст, Stop

Зачем: адаптер говорит с `agent acp` и переводит текстовый ход в `AgentEvent`. В меню движков его ещё нет.

**Сессия:** sonnet, high. После этапа 1, только если в отчёте `go`. Контракт — таблица отчёта, не страница доков.

- [ ] `AgentProvider` += `'cursor'`. Сравнения `'claude' | 'codex' | 'antigravity'` в маршруте сессии заменить на `isProvider`, не размазывая новый литерал. Поведение трёх старых движков то же.
- [ ] `agentura.cursorExecutable` (machine) и значение `cursor` у `agentura.defaultProvider`: `package.json`, `package.nls.json`, `package.nls.ru.json`, `src/settings.ts` (`MACHINE_KEYS`, `PROVIDERS`).
- [ ] `src/agent/cursor/executable.ts` по образцу `src/agent/codex/executable.ts`. Имя бинарника `agent` принимать только если `--version` или `about` опознаёт Cursor той строкой, которую записал спайк. Чужой `agent` в `PATH` — это «не найден», не запуск. На Windows не принимать `.cmd`/`.bat`.
- [ ] `src/agent/cursor/protocol.ts` — подмножество кадров из отчёта спайка, версия CLI в шапке. Не копировать всю схему ACP.
- [ ] `src/agent/cursor/client.ts` — NDJSON JSON-RPC, лимит строки 64 МБ, server request отдельно от notification и от ответа. Поле `jsonrpc` — как в живой фикстуре. Неотвеченный server request не оставлять висеть: неизвестный метод — ошибка JSON-RPC, известное разрешение до этапа 3 — отказ по форме из отчёта.
- [ ] `src/agent/cursor/adapter.ts` + `mapper.ts`: процесс на сессию (`shell: false`, cwd сессии, env целиком), `createSession` / `resumeSession` (`session/load`), `send` только текстом, очередь, `interrupt` = `session/cancel`, `dispose` = stdin end → grace → kill. События: `session.init`, `turn.start`, `text.delta`, `turn.result`, `error`, `session.closed`. Картинки и файлы — `warn` и дроп.
- [ ] `capabilities()`: модели тем способом, который назвал спайк; нет способа — пустой список, без падения. `setModel` — только если спайк записал метод, иначе запоминается и в журнал `warn`.
- [ ] Фейковый ACP-сервер в тестах: pong, падение процесса, cancel, resume. Плюс тест маппера на `test/fixtures/cursor/acp-pong.ndjson`.
- [ ] `npm run check` зелёный. UI движок не показывает.

**Готово, когда:** `TZ=UTC npm run check` зелёный; в выводе тестов есть файлы `src/agent/cursor/`; открытая вкладка по-прежнему Claude, пока провайдер не передан. Живой smoke — `scripts/cursor-smoke.mjs` (opt-in, временная папка, один pong), не часть `npm run check`.

### 3. Инструменты, разрешения, план и вопросы

Зачем: ход с правкой файла не выглядит текстом. Разрешения не зависают.

**Сессия:** sonnet, high. После этапа 2. Если таблица спайка не различила tool-кадры и id опций разрешения — этап не начинать, дописать отчёт.

- [ ] Tool-кадры из отчёта → `tool.start` / `tool.result`. Имя инструмента — как у сервера. Неизвестный вид — одна карточка с сырым именем, не падение хода.
- [ ] `session/request_permission` → `permission.request`. Ответ `respondPermission` собирается из option id, которые прислал сервер (таблица спайка): `allow` → один раз, `allow-always` → всегда, если такая опция была (`canAlwaysAllow`), иначе один раз, `deny` → отказ. `allow-edits` для Cursor равен `allow`. Нет карточки — ход не блокировать молчанием: отказ по форме спайка и `warn`.
- [ ] `bypassPermissions` при `allowBypassPermissions` отвечает «один раз» само, без карточки. Без флага — как `default`.
- [ ] `cursor/ask_question`, если спайк его видел, → `question.request`. Id опций помнить в сессии: `answerQuestion` приходит метками `Question`, наружу уходит `selectedOptionIds`. Не видели — метод отвечает `skipped`, флаг `questions` остаётся false.
- [ ] `cursor/create_plan`, если спайк его видел, → `plan.request`. `decidePlan(approve)` → outcome `accepted` / `rejected` по форме доков и кадру спайка. Не видели — `rejected`, флаг `plan` остаётся false.
- [ ] `cursor/task`, `cursor/update_todos`, `cursor/generate_image` — в журнал `debug`, в ленту не эмитить.
- [ ] `setMode`: `plan` выставляет режим способом из отчёта; `default` и `acceptEdits` выставляют `agent`; смена режима, которую сервер отверг, даёт `error` нефатальный и не рвёт сессию.
- [ ] Тесты фейка: tool, разрешение allow/deny, зависший запрос не остаётся после `interrupt`, план accept/reject. `TZ=UTC npm run check` зелёный.

**Готово, когда:** фейковый сервер проходит сценарии выше, а маппер — фикстуру этапа 1, если в ней есть tool или permission. Новых вариантов `AgentEvent` нет.

### 4. История

Зачем: беседу, начатую в Agentura, можно снова открыть. Список не читает недокументированный каталог `~/.cursor`.

**Сессия:** sonnet, high. После этапа 3. Источник списка — только тот, который спайк пометил рабочим.

- [ ] `listSessions(dir)` фильтрует по cwd. Источник: ACP-метод из отчёта либо разовый `agent ls`, если отчёт привёл его формат и код выхода. Нет ни того ни другого — пустой список, `warn` один раз, без чтения файлов Cursor.
- [ ] `loadHistory` собирает `AgentEvent` из `session/load` (или из транскрипта, если спайк отдал формат и только его). `live: true` оставляет последний ход открытым. Нет данных — пустая история, не ошибка вкладки.
- [ ] `renameSession`: метод из отчёта или тихий no-op. Свой ключ в `globalState` не заводить.
- [ ] `accountInfo`: поля, которые реально печатает `agent status` / `about`. Нет — пустой объект.
- [ ] Фикстура списка и истории без путей и текста владельца. Тесты на временной папке и на фикстуре. `TZ=UTC npm run check` зелёный.

**Готово, когда:** тест поднимает pong-сессию из фикстуры в ленту событий `turn.start` + текст + `turn.result`. Падение бинарника на списке не роняет `SessionsService` (ошибка одного extra-провайдера уже гасится для Codex).

### 5. Подключение к чату

Зачем: пустая вкладка умеет выбрать Cursor, сессия живёт тем же контроллером, что Claude и Codex.

**Сессия:** sonnet, high. После этапа 4. Общие файлы трогать здесь, не раньше.

- [ ] `ChatServices.cursorAdapter` / `cursorEngine` рядом с Codex и Antigravity в `src/extension/chatPanel.ts`. `adapterOf` и второе такое же ветвление в этом файле отдают Cursor-адаптер. Прогрев `warm()` на активации не вызывать.
- [ ] `ProviderFeatures` для `cursor` — флаги из «Принятых решений», поднятые этапом 3, если спайк подтвердил план и вопросы. `providerFeatures` не забывает новую ветку (сейчас не-codex и не-antigravity молча получают флаги Claude).
- [ ] `sessionsService.ts`: третий extra-провайдер, тихая проба локатора (`available` / `quiet`), ошибка списка не стирает Claude и Codex.
- [ ] Меню движка, пустой экран, сайдбар, строки en/ru (`engines`, `providerNames`, «не найден», подпись «через agent acp»). Настройки ⚙: путь к бинарнику и пункт провайдера по умолчанию — тем же экраном, что Codex, без новой страницы.
- [ ] Карточки разрешений, вопросов и плана ходят в `respondPermission` / `answerQuestion` / `decidePlan` этой сессии. Режим `bypassPermissions` без `allowBypassPermissions` контроллер по-прежнему понижает.
- [ ] README.md и README.ru.md: короткий раздел «Cursor» — установка CLI, `agent login`, что в v1 нет цены, контекста, MCP-тумблера, субагентов и автопринятия правок. CHANGELOG — одна запись.
- [ ] `TZ=UTC npm run check` зелёный.

**Готово, когда:** тесты фабрики и списка сессий покрывают провайдер `cursor`; `rg` по `src` не находит места, где провайдер сравнивается с двумя движками и молча считает остальное Claude, кроме самого `providerFeatures` и явного дефолта. Ручной сценарий владельца: пустая вкладка → Cursor → «pong» → Stop → повторное открытие сессии из сайдбара.

## Промты сессий

Общее: репозиторий `/Users/fost/Projects/Agentura`, ветка уже созданная `stage-N` (не создавать `feature/cursor-support`). Галочки в `docs/roadmap/29-cursor-support.md` ставить после команды из этапа. Чужие незакоммиченные файлы не трогать. Не коммитить, не пушить. Не писать в `~/.cursor`, `~/.claude`, `~/.codex`, `~/.gemini`. Не ослаблять разрешения по умолчанию и не передавать `--force`. Не рефакторить Claude, Codex и Antigravity. Публичные тексты README и CHANGELOG — на английском в README.md и на русском в README.ru.md.

### Промт 1

```
Сессия 1 — спайк agent acp · Модель: opus · первая

Работаем в /Users/fost/Projects/Agentura. Задача: снять живой протокол `agent acp` и записать go/no-go. Кода адаптера нет.

Читай: docs/roadmap/29-cursor-support.md (разделы «Что уже известно» и этап 1); https://cursor.com/docs/cli/acp — только чтобы сверить имена методов, не чтобы дописать недостающие кадры.
Правила репо: AGENTS.md.
Точки входа: бинарник `agent` (на 2026-11-05 его не было). Эталон записи: docs/roadmap/16-antigravity-support.md, раздел про то, что хранилище недокументировано и читается только после прогона.
Точки входа проверены при планировании — открывать только то, что правишь.

Уже решено, не переспрашивать: транспорт только `agent acp`; print-режим не подставлять; ключи и токены в репозиторий не класть; сырой лог машины не коммитить; короткие промты во временной папке.

Порядок:
1. Проверить `agent about` / `agent status`. Нет бинарника или входа — отчёт со строкой `stop` и что именно отсутствует. Не ставить CLI молча и не выдумывать кадры.
2. Прогнать сценарии этапа 1, сохранить очищенную фикстуру и docs/spikes/cursor-acp/report.md с таблицей решений.
3. Отметить чекбоксы этапа 1.
Галочки в roadmap — по факту проверки, не «вроде сделал».

DoD: отчёт заканчивается строкой `go` или `stop`; при `go` есть test/fixtures/cursor/acp-pong.ndjson. Проверка: rg -n "sk-|Bearer|api_key|CURSOR_" test/fixtures/cursor docs/spikes/cursor-acp пусто.
Примеры: бинарник не найден → stop, этапы 2–5 не писать кодом; сервер не шлёт поле jsonrpc → это строка таблицы, не повод бросать прогон; разрешение зависло без ответа → записать кадр запроса и ответить отказом, не оставлять процесс.

Не делать: src/agent/cursor/, правки UI, чтение каталога ~/.cursor «на всякий случай», перебор выдуманных RPC-методов. Вопрос, на который нет ответа в прогоне, — в таблицу как «не видели», не додумывать.

Не коммитить, не пушить.
Последним сообщением — отчёт: go или stop / версия CLI / файлы / чего не увидели. Отчёт — единственное, что увидит приёмка.
```

### Промт 2

```
Сессия 2 — CursorAdapter, текст и Stop · Модель: sonnet, effort: high · после сессии 1

Работаем в /Users/fost/Projects/Agentura. Задача: адаптер `agent acp` проводит текстовый ход и Stop, без меню в UI. Доработка общего контракта движков точечная.

Читай: docs/roadmap/29-cursor-support.md этап 2; docs/spikes/cursor-acp/report.md; src/agent/codex/executable.ts; src/agent/codex/client.ts; src/agent/codex/adapter.ts (очередь, interrupt, dispose).
Правила репо: AGENTS.md.
Точки входа: src/agent/types.ts AgentProvider; src/settings.ts PROVIDERS; src/extension/engineLocator.ts EngineLocator; package.json agentura.codexExecutable.
Эталон: src/agent/codex/. Открывать только фрагмент, который копируешь.

Уже решено, не переспрашивать: если отчёт спайка не `go` — остановиться и ничего не писать. Подмножество протокола брать из отчёта. Процесс на сессию, shell false, очередь сессии, Stop = session/cancel без kill, dispose = stdin end, grace, kill. Картинки и файлы дропать (capability image true, блока не было). UI не подключать. Новые AgentEvent не добавлять. Поле jsonrpc в фикстуре есть и равно "2.0". В фикстуре id 0 есть у session/request_permission и cursor/create_plan; остальные id ненулевые. Проверять наличие поля, не truthiness, константу 0 не подставлять. Модель сессии — session/set_config_option configId "model" и modelId из availableModels; флаг --model у agent acp модель не сменил. session/cancel — уведомление без id, stopReason хода cancelled.

По реальному коду (приёмка 2026-11-05): в text.delta класть только agent_message_chunk. agent_thought_chunk туда не писать, новый AgentEvent не заводить. Сентинелы _modelsCount, _optionsCount, _commandsCount — обрезка фикстуры, не поля протокола. session/load до result шлёт session/update, включая user_message_chunk. toolCallId в сценариях load — replay-*; живые id с префиксом tool_ на read/write/cancel/permission. Каталог команд в фикстуре обрезан, capabilities на него не вешать.

Порядок:
1. Провайдер, настройка, резолвер, который отказывается от чужого `agent`.
2. protocol.ts и client.ts по фикстуре.
3. adapter.ts и mapper.ts: init, текст, result, ошибка, закрытие.
4. Фейк, тест фикстуры, opt-in scripts/cursor-smoke.mjs.
5. TZ=UTC npm run check. Галочки этапа 2.
Галочки в roadmap — по факту проверки.

DoD: TZ=UTC npm run check зелёный, тесты src/agent/cursor/ есть, вкладка без провайдера cursor по-прежнему Claude. Проверка — эта команда; длинный лог в файл, в отчёт — хвост и ошибки.
Примеры: нет пути к бинарнику → createSession бросает «не найден», не падает хост; stdout оборвался посреди хода → turn.result ok=false, error fatal, session.closed; второй send во время хода ждёт в очереди и не склеивается с первым; interrupt до старта хода даёт turn.start и turn.result interrupted, процесс жив.

Не делать: sessionsService, меню, README, разбор tool и permission (этап 3), запись в домашние каталоги движков. Вопрос без ответа в отчёте спайка — в отчёт сессии, не выбирать наугад.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

### Промт 3

```
Сессия 3 — инструменты, разрешения, план, вопросы · Модель: sonnet, effort: high · после сессии 2

Работаем в /Users/fost/Projects/Agentura. Задача: tool, permission, plan и question доходят до уже существующих AgentEvent. Карточки UI подключит этап 5.

Читай: docs/roadmap/29-cursor-support.md этап 3 и «Принятые решения»; docs/spikes/cursor-acp/report.md (таблица); src/agent/types.ts события tool.*, permission.request, question.request, plan.request и методы AgentSession respondPermission, answerQuestion, decidePlan, setMode.
Правила репо: AGENTS.md.
Точки входа: src/agent/cursor/adapter.ts, src/agent/cursor/mapper.ts. Эталон ответа на server request: src/agent/codex/adapter.ts (отказ до этапа разрешений, чтобы ход не завис).

Уже решено, не переспрашивать: option id брать из кадра сервера и таблицы спайка, не из памяти модели. Живой ответ, который сервер принял: {outcome:{outcome:"selected", optionId}} с optionId allow-once, allow-always или reject-once; kind на кадре allow_once, allow_always, reject_once. Отдельного allow-edits в кадре не было, для Cursor он по-прежнему равен allow. bypassPermissions без allowBypassPermissions не автоотвечает. cursor/task, cursor/update_todos, cursor/generate_image в ленту не эмитить. acceptEdits не включает автопринятие правок. Новых AgentEvent нет. cursor/ask_question не приходил — ответить пропуском, флаг questions false. cursor/create_plan приходил; отказ {outcome:{outcome:"rejected", reason}} ход не завис, флаг plan можно поднять.

По реальному коду (приёмка 2026-11-05): sessionUpdate plan с entries приходил один раз. В ленту не эмитить, нового AgentEvent нет. Карточка плана — только cursor/create_plan. Живые toolCallId с префиксом tool_; replay-* в load — заглушка фикстуры, форму id оттуда не брать.

Порядок:
1. Маппер tool-кадров.
2. permission.request и ответ по option id, включая bypass.
3. Вопрос и план, если они есть в отчёте.
4. setMode по способу из отчёта.
5. Тесты фейка и TZ=UTC npm run check. Галочки этапа 3.

DoD: TZ=UTC npm run check зелёный; фейк покрывает tool, allow, deny, interrupt при висящем разрешении, план если он в контракте. Проверка — эта команда.
Примеры: сервер прислал разрешение и клиент молчит → так нельзя, уходит отказ формой спайка; allow-always пришёл, а опции «всегда» в кадре не было → отправить «один раз»; setMode(plan) сервер отверг → нефатальный error, сессия жива; неизвестный tool → карточка с именем сервера, ход продолжается.

Не делать: правку webview, чтение ~/.cursor, MCP-тумблер, субагентов во вкладке «агенты». Не додумывать вид tool, которого нет в отчёте.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

### Промт 4

```
Сессия 4 — история Cursor · Модель: sonnet, effort: high · после сессии 3

Работаем в /Users/fost/Projects/Agentura. Задача: listSessions, loadHistory, renameSession и accountInfo читают только источник из отчёта спайка.

Читай: docs/roadmap/29-cursor-support.md этап 4; docs/spikes/cursor-acp/report.md; src/agent/types.ts SessionInfo, SessionHistory, AccountInfo.
Правила репо: AGENTS.md.
Точки входа: src/agent/cursor/adapter.ts. Эталон мягкого отказа: src/agent/antigravity/storage.ts (нет файла → пусто, не ошибка) — копировать подход, не читать каталог Antigravity.

Уже решено, не переспрашивать: нет метода списка — пустой список и один warn. Файлы ~/.cursor не открывать, даже если они лежат на диске. Свой индекс имён в globalState не писать. Нет rename — no-op без ошибки.

По реальному коду (приёмка 2026-11-05): список есть — session/list {cwd} → {sessions:[{sessionId,cwd,updatedAt}]}, без title. agent ls JSON не отдаёт. session/load до result шлёт session/update. История load в фикстуре сокращена, toolCallId там replay-*; форму id и сырой tool-кадр брать из read/write/cancel/permission. Метода переименования нет.

Порядок:
1. Выбрать источник строго по отчёту. Источника нет — заглушки и тест «пустой список не бросает».
2. loadHistory в AgentEvent, live оставляет последний ход открытым.
3. Фикстура без путей и писем. Тесты.
4. TZ=UTC npm run check. Галочки этапа 4.

DoD: TZ=UTC npm run check зелёный; тест истории даёт turn.start, текст и turn.result из фикстуры, либо явная заглушка, если спайк записал «списка нет». Проверка — эта команда.
Примеры: бинарник упал на list → адаптер возвращает пусто или отвергает промис так, чтобы вызывающий extra-провайдер это пережил; чужой cwd в списке не попадает в выдачу; повторный rename без метода не создаёт файл.

Не делать: sessionsService (это этап 5), парсер sqlite, угадывание пути transcripts.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

### Промт 5

```
Сессия 5 — Cursor в чате · Модель: sonnet, effort: high · после сессии 4

Работаем в /Users/fost/Projects/Agentura. Задача: пустая вкладка запускает Cursor тем же контроллером, флаги прячут то, чего у движка нет.

Читай: docs/roadmap/29-cursor-support.md этап 5 и флаги в «Принятых решениях»; src/agent/features.ts; src/extension/chatPanel.ts createChatServices и adapterOf; src/extension/sessionsService.ts ExtraProvider.
Правила репо: AGENTS.md.
Точки входа: src/extension/chatPanel.ts, src/extension/sessionsService.ts, src/settings.ts, src/webview/strings.ts, src/webview/strings.en.ts, package.json. Эталон подключения: как в этих файлах уже сидят codex и antigravity. Открывать только ветки, куда добавляется cursor.

Уже решено, не переспрашивать: warm() на активации нет. Флаги v1 не расширять сверх отчёта спайка и этапа 3: чисел usage не было — context и cost false; cursor/ask_question не было — questions false; cursor/create_plan был — plan можно true. acceptEdits не авторазрешает правки, в README это написано прямо. Третий extra-провайдер не роняет список, если Cursor не установлен. Новую страницу настроек не делать.

Порядок:
1. Фабрика, adapterOf и второе ветвление адаптера в chatPanel.ts.
2. providerFeatures, чтобы cursor не получил флаги Claude по умолчанию.
3. sessionsService, строки, настройка пути, меню движка.
4. README.md, README.ru.md, CHANGELOG.
5. TZ=UTC npm run check. Галочки этапа 5.

DoD: TZ=UTC npm run check зелёный. Проверка дополнительно: rg по src на сравнения провайдера, где отсутствующий cursor стал бы Claude, — в отчёте список найденных мест и что с каждым сделано.
Примеры: defaultProvider cursor, бинарника нет → вкладка говорит «не найден», Claude-сессии сайдбара на месте; провайдер cursor в chat.info → нет кольца контекста и цены; resume сессии cursor не открывает её адаптером Claude.

Не делать: MCP-тумблер .cursor/mcp.json, лимиты подписки, субагентов, визуальную новую раскладку, живой прогон в check.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

## Риски и открытые вопросы

- Этап 1 блокируется, пока на машине нет залогиненного `agent`. Это внешнее условие, не развилка плана.
- Доки расходятся сами с собой в форме ответа на разрешение (проза против `optionId` в примере). Код до спайка эту форму не выбирает.
- Имя бинарника `agent` легко спутать с чужой утилитой. Резолвер без опознания Cursor запускать процесс не должен.
- `cursor/task` похож на субагентов, но в доках это одно уведомление, не поток. Вкладку «агенты» на нём не строить.
- Usage и цена в ACP-странице не описаны. Пока их нет в фикстуре, HUD цены и контекста для Cursor выключен. Появление чисел в спайке поднимает флаги отдельной записью в отчёте, не догадкой этапа 5.
- Windows не проверяем живьём. Ограничение то же, что у Codex: без `shell: true`, без `.cmd`.
- Кнопку `acceptEdits` не прячем: для Cursor она равна `default`. Прятать пункт — отдельная правка меню режимов, в этот план не входит.
- История `session/load` в фикстуре сокращена (`toolCallId` `replay-*`). Форму id брать с живых ходов, не с load.
- Ручная проверка владельцем после этапа 5: установка CLI, вход, pong, разрешение на запись файла, Stop, повторное открытие из сайдбара, отсутствующий бинарник.

## Порядок работы

1 → 2 → 3 → 4 → 5, один репозиторий, общие файлы UI только на этапе 5. Этап 2 не начинается без `go` в отчёте спайка. Параллелить нечего: этап идёт в уже созданной ветке `stage-N`, не в `feature/cursor-support`.
