# 15 — Codex как второй движок

> **Статус:** этап 2 принят 2026-10-05 — следующий: 3. Автопилот `/roadmap-run`, ветки
> `stage-<N>-<slug>` от main, приёмка Opus. Ручные проверки и решения — `15-codex-support.pending.md`.

Исходное ТЗ написал Codex (2026-10-05) — оно ниже целиком в «Контекст и ограничения». Этапы
ниже — его «Последовательность коммитов», переложенная на автопилот. Где этап расходится с ТЗ —
прав этап (расхождения перечислены в «Поправки к ТЗ»).

## Поправки к ТЗ (оркестратор, 2026-10-05)

- **Протокол сверен с `codex-cli 0.160.0`** (`codex app-server generate-ts`): методы `initialize`,
  `thread/start|resume|read|list|name/set|compact/start`, `turn/start|interrupt|steer`,
  `model/list`; server requests `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `item/tool/requestUserInput`; notifications `thread/started`, `turn/started|completed`,
  `item/started|completed`, `item/agentMessage/delta`, `item/reasoning/*`,
  `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `serverRequest/resolved`,
  `thread/tokenUsage/updated`, `error`. Типы — в репо не тащить целиком (600+ файлов): руками
  описать используемое подмножество в `src/agent/codex/protocol.ts` с пометкой версии и скрипт
  регенерации для сверки.
- **Существующий `AgentAdapter`/`AgentSession` подходит**, новый слой `ProviderSession` не
  нужен: Codex реализует тот же интерфейс, Claude-специфика (`setMode`, `compact`, `stopTask`,
  `decidePlan`, `complete`, `agentTranscript`) — no-op/отсутствует, а UI прячет её по флагам
  возможностей провайдера. Флаги — расширение `SessionCapabilities` или отдельный
  `ProviderFeatures` в `chat.info`, решает этап 3.
- **История (этап 5) — через `thread/list` с фильтром `cwd`**, а не через собственный индекс в
  `workspaceState`: так же, как у Claude показываются все сессии проекта, а не только созданные
  в Agentura; нет второго хранилища, которое разъедется с реальностью; rename — `thread/name/set`,
  история ленты — `thread/read`. Codex возражал: `thread/list` отдаёт и треды, начатые в CLI. Это
  считаем фичей (паритет с Claude). Откат — индекс из ТЗ §5. **Ждёт подтверждения владельца до
  этапа 5** (pending, `[скоуп]`).
- Живой smoke с реальным CLI — в этапе 2 (handshake + `model/list` бесплатны; один короткий
  turn на самой дешёвой модели допустим), чтобы маппер строился по настоящим событиям, а не по
  догадкам. Фикстура — в `test/fixtures/codex/`, без личных путей и токенов.

## Этапы

### 1. Основа провайдера: SessionRef, настройки, locator, протокол

**Сессия:** sonnet. Начато Codex: `AgentProvider`/`SessionRef` (`src/agent/types.ts`),
миграция `SessionMemory`, `src/agent/codex/{executable,client}.ts` + тесты.

- [x] `SessionRef` протянут до конца: панель знает провайдера своей сессии, `setOpenSessions`
      пишет настоящий provider (сейчас захардкожен `'claude'` в `chatPanel.ts`), восстановление
      открытых вкладок не теряет provider; `session.resume`/`agentura.openSession` принимают
      необязательный `provider` (нет поля → `claude`).
- [x] Настройки: `agentura.codexExecutable` (machine-scope) и `agentura.defaultProvider`
      (`claude` | `codex`, по умолчанию `claude`) — `package.json`, `package.nls.json`,
      `package.nls.ru.json`, `src/settings.ts` (включая `MACHINE_KEYS`).
- [x] Locator: `EngineLocator` обобщён (резолвер и настройка — зависимости) или рядом
      `CodexEngineLocator`; ошибки «claude не найден» и «codex не найден» не смешиваются.
- [x] `src/agent/codex/protocol.ts` — используемое подмножество типов app-server 0.160.0 (см.
      «Поправки к ТЗ»), версия в шапке; `scripts/codex-protocol.mjs` (или npm-скрипт)
      регенерирует схему во временную папку для сверки.
- [x] Ревизия `CodexRpcClient`: ответ на server-initiated request (метод `respond(id, result)`
      / `respondError`), маршрутизация server requests отдельно от notifications, тесты на это.
- [x] `npm run check` зелёный (TZ=UTC, 1085 тестов после приёмки); Claude-поведение не изменилось.

**Готово, когда:** check зелёный, новые тесты на SessionRef-маршрут, locator и server request
в клиенте; Codex ещё не запускается из UI.

**Решения (2026-10-05, по итогам сессии 1):**

- **Раскладка.** `src/agent/types.ts` — `AgentProvider`, `SessionRef` (уже были). `SessionMemory` —
  `openSessions(): SessionRef[]`, старый `string[]` читается как Claude. `panelRouting.ts`: `PanelView.provider`,
  `routeResume(panels, SessionRef | string, from)`, `restoredSessionId(...) → SessionRef | undefined`; один id у
  разных провайдеров — разные сессии. `ChatPanel` хранит `provider` вкладки (из `OpenOptions.provider`, по
  умолчанию `claude`), `setOpenSessions` пишет его. `ChatPanel.resume(…, string | SessionRef)`; команда
  `agentura.openSession(id, provider?)` и сообщение `session.resume { provider? }` — поле необязательное.
  Webview-state хранит только `sessionId`: провайдер при восстановлении берётся из памяти воркспейса, нет записи —
  `claude` (state webview не трогал: UI вне этапа; этап 3 может добавить `provider` в state, `restoredSessionId`
  его уже читает).
- **Пока Codex не подключён**, `ChatPanel.resume` с `provider: 'codex'` ничего не открывает (warn в лог), а
  сериализатор не поднимает Codex-ссылку из памяти: чужой id нельзя отдавать Claude-движку. Этап 3 снимает проверку
  (одна строка в `resume` и одна в сериализаторе).
- **Настройки.** `agentura.codexExecutable` (machine) и `agentura.defaultProvider` (`claude`|`codex`) — `package.json`
  (+nls en/ru), `settings.ts` (`SETTING_KEYS`, `MACHINE_KEYS`, `SettingsValues`, `validateSetting`, `readSettings`,
  `PROVIDERS`/`isProvider`). В UI вкладки «Настройки» строк нет — этап 6; `defaultProvider` пока нигде не читается
  (читать при создании сессии — этап 3).
- **Locator.** Выбран вариант «обобщить»: `EngineLocator` получил зависимости `name` (для журнала) и `notFound`
  (текст «не найден»); Claude-поведение не изменилось (дефолты прежние). В `createAdapter` рядом создан
  `codexEngine` (резолвер `resolveCodexExecutable`, имя `codex`), он в `ChatServices.codexEngine`. Без `warm()`:
  `codex --version` не гоняем на активации тем, кто Codex не использует. Тексты codex-ошибок английские (в
  `executable.ts`), локализации через `hostStrings` нет — при подключении карточки этапа 3 решить.
- **Протокол.** `src/agent/codex/protocol.ts` — подмножество 0.160.0: таблицы `CodexRequests` /
  `CodexNotifications` / `CodexServerRequests` (метод → типы), `isCodexNotification`, `isCodexServerRequest`.
  Типы взяты из сгенерированных, но упрощены (то, что этапам 2–5 не нужно, — `unknown`). `npm run codex:protocol`
  (`scripts/codex-protocol.mjs`) генерирует схему во временную папку и сверяет методы, поля и значения union-ов;
  на 0.160.0 проходит. Метод переименования — `thread/name/set` с `ThreadSetNameParams` (`threadId`, `name`).
- **Клиент.** `CodexRpcClient`: сообщение с `id` и `method` — server request (id строка или число), уходит в
  `onServerRequest(id, method, params)`; не задан обработчик — клиент отвечает `-32601`, бросил — `-32603`, чтобы
  turn не завис. `respond(id, result)` / `respondError(id, message, code?)`; после закрытия клиента не пишут. Раньше
  server request с числовым id ошибочно считался ответом на наш запрос.
- **Не проверено:** живой handshake/turn (этап 2); `thread/list` с `cwd` как массивом и строкой; поведение
  `serverRequest/resolved` при interrupt. Тип `ThreadItem` — не полный (редкие виды сведены в одну ветку).
- Промты 2–5 остаются актуальными; промт 2: клиент уже умеет server requests, `onServerRequest` — точка входа для
  этапа 4.

**Решения (2026-10-05, приёмка этапа 1, два прохода):**

- **`agentura.defaultProvider` — `scope: application`** и в `MACHINE_KEYS`: `.vscode/settings.json` чужого репо не
  должен молча переключать новые сессии на другого вендора (ТЗ и так говорило «user-scoped»). Исполнитель оставил
  scope по умолчанию (`window`).
- **Чат-webview:** `session.resume { provider }` из экрана empty/попапа терял провайдер — `deps.openSession(id,
  provider)` теперь получает `m.provider ?? 'claude'` (было: провайдер текущей вкладки).
- **`CodexRpcClient` доведён:** `onClose(error)` — один раз при любой смерти клиента (владелец узнаёт, что
  notifications кончились); `exit` больше не рвёт сразу — ждём `close`/конца stdout (последний ответ не теряется),
  через 1 с без них — закрываемся; слушатель `stdin.on('error')` (EPIPE не роняет хост); бросивший `onNotification`
  не рвёт разбор чанка (ошибка — в `onStderr`); `null`/не-объект и `{id:null,error}` — закрытие с текстом;
  `onServerRequest` может быть async, отклонённый промис → `-32603`; лимит строки проверяется и для хвоста после
  последнего `\n`; stderr собирается в строки до redact; redact ловит `Bearer <token>`, `sk-…`, JSON-поля
  `authorization`/`*_token`/`api_key`.
- **Windows:** как у Claude — `codex.cmd`/`.bat` в настройке не принимаются, найденная только npm-обёртка даёт
  подсказку про `codex.exe` вместо «не найден» (без оболочки `.cmd` не стартует, `shell: true` не включаем).
- **`npm run codex:protocol`** сверяет CLI со своими списками (зеркало `protocol.ts`, ведутся руками), а не с
  самим `protocol.ts` — так и сказано в выводе; в `npm run check` не входит, пишет только во временную папку.

### 2. CodexAdapter: процесс, handshake, turn, поток текста, interrupt

**Сессия:** sonnet.

- [x] `src/agent/codex/adapter.ts` — `CodexAdapter implements AgentAdapter`: процесс
      `codex app-server --listen stdio://` на сессию (cwd сессии, `shell: false`, stderr →
      `Logger.debug`), handshake `initialize` → `initialized` → `thread/start` | `thread/resume`
      → `turn/start`. `listSessions`/`loadHistory`/`renameSession` — пока пусто/no-op (этап 5).
- [x] `src/agent/codex/mapper.ts` — notifications → `AgentEvent`: `session.init`, `turn.start`,
      `text.delta` (`item/agentMessage/delta`, messageId из item id), `thinking.*` из
      `item/reasoning/*` только при наличии текста, `turn.result` (ok только при
      `status === 'completed'`), `error` + `session.closed` при падении процесса/протокола.
- [x] `send()` с текстом и картинками (`image` с data-URL по схеме; на живом картинки не гонял); пока идёт turn — очередь
      в сессии (следующий `turn/start` после `turn/completed`), не склеивать.
- [x] `interrupt()` (только fake-сервер, на живом не гонял) — `turn/interrupt { threadId, turnId }`, ждём `turn/completed` с
      `interrupted`; процесс не убивать. `dispose()` — закрыть stdin, grace, потом kill.
- [x] `setModel` → `model` в следующем `turn/start`; `capabilities()` — модели из `model/list`.
- [x] Fake app-server в тестах проверяет порядок сообщений и сценарии: delta, completed /
      failed / interrupted, падение процесса, resume.
- [x] Живой smoke (`scripts/codex-smoke.mjs`, opt-in): handshake, `model/list`, один короткий
      turn на самой дешёвой модели во временной папке; записанная фикстура событий в
      `test/fixtures/codex/` (без личных путей/токенов) и тест маппера по ней.
- [x] `npm run check` зелёный.

**Готово, когда:** адаптер проходит fake-тесты и тест по живой фикстуре; в UI ещё не подключён.

**Решения (2026-10-05, по итогам сессии 2):**

- **Раскладка.** `src/agent/codex/adapter.ts` — `CodexAdapter` + внутренний `CodexSession`; `mapper.ts` —
  `CodexEventMapper` (notifications → `AgentEvent`, без раздельного состояния от сессии); `fakeServer.ts` —
  поддельный app-server для тестов (`FakeAppServer`, только тесты); тесты `adapter.test.ts`, `mapper.test.ts`;
  `scripts/codex-smoke.mjs` (opt-in живой прогон, `--turn`, `--record <файл>`); фикстура
  `test/fixtures/codex/ok-turn.json` (ответ `thread/start`, `model/list`, 11 notifications хода; пути/имя/хост/почта
  заменены, проверено grep).
- **Контракт `CodexAdapter`.** Конфиг: `executablePath` (строка или функция — `() => services.codexEngine.path()`;
  нет пути — `createSession` бросает «Codex CLI (codex) was not found.»), `log`, `env`, `clientVersion`, `thread`
  (`approvalPolicy`/`sandbox` — только для smoke/тестов), `timeoutMs`, `graceMs`, `spawn`, `trace`. Процесс на сессию,
  `spawn(path, ['app-server','--listen','stdio://'], {cwd, env: process.env, shell:false})`, `maxLineBytes` 64 МБ.
  **Handshake ленивый:** `initialize` → `initialized` сразу при создании сессии (чтобы `capabilities()` работал до
  первого сообщения), `thread/start` — при первом `send()` (пустой тред в истории Codex не нужен), `thread/resume`
  (`excludeTurns: true`) — сразу при `resumeSession`, `session.init` на ответ треда. Поэтому у новой сессии `session.init`
  приходит перед первым `turn.start`, а не при открытии.
- **Approval/sandbox не задаём:** `thread/start` получает только `cwd` и `model` — политику берёт `~/.codex/config.toml`
  (ТЗ §4). Ответ живого сервера на `on-request` + `read-only` проверен только в smoke. Server requests до этапа 4 — warn в лог и
  явный отказ по схеме (ревью): `commandExecution`/`fileChange` → `{decision:'decline'}`, `permissions` → пустой
  grant на `turn`, `mcpServer/elicitation/request` → `decline`; остальные (`item/tool/requestUserInput`, …) —
  `-32601`. Исполнитель отвечал `-32601` на всё; поведение сервера на ошибку вместо решения схема не описывает (риск
  зависшего хода), `decline` — штатный путь «отказано, ход продолжается». Это место (`REFUSALS` в `adapter.ts`)
  заменяет этап 4.
- **Маппинг.** `session.init`: `permissionMode:'default'`, `tools/slashCommands/skills/agents:[]`, `apiKeySource:'none'`,
  `engineVersion = thread.cliVersion`. `turn.start` — на `turn/started`, промпт из FIFO `notePrompt` (адаптер объявляет
  его прямо перед `turn/start`). `text.delta` — по `item/agentMessage/delta` (messageId = id item); нет дельт — текст из
  `item/completed`. `thinking.*` — из `item/reasoning/{summaryTextDelta,textDelta}` только при непустом тексте, части
  сводки разделены пустой строкой, `thinking.stop` на `item/completed` или конце хода. `turn.result`: `ok` только при
  `completed`; `subtype` success/error/interrupted; `usage` хода — разность `total` между `thread/tokenUsage/updated`
  (первое обновление: база = total − last; `input` = inputTokens − cached − cacheWrite, т.к. у Codex ввод включает кэш);
  `totalCostUsd: 0` — «неизвестно» (у Codex стоимости нет, этап 3 прячет HUD цены); `text` — последнее сообщение
  агента. `context.usage` (`source:'usage'`, used = inputTokens последнего ответа, окно из `modelContextWindow`) — после
  каждого `turn/completed`. `error`-notification с `willRetry:false` → `error{fatal:false, code}`, а сама ошибка не
  дублируется в `turn.result.errors`; `willRetry:true` молчит. Процесс/протокол умер → `error{fatal}` + `session.closed`
  (`exit` или `error`), поток событий закрывается. `usage.message` не эмитим (по-вызовная раскладка Codex не даёт
  messageId/цены). Команды, правки, MCP, approval — этап 4 (мапперу они неизвестны и игнорируются).
- **Очередь и Stop.** `send()` кладёт в очередь сессии, `turn/start` следующего — после `turn/completed`; сообщения не
  склеиваются. **`interrupt()` сбрасывает и очередь** (скоуп-деталь: Stop = «стоп всё»; у Claude следующее сообщение в
  очереди продолжило бы работу — обратимо, одна строка `queue.length = 0` в `interrupt`). Stop до старта хода: `turn/start` не
  уходит, лента получает `turn.start` + `turn.result{interrupted}`. `turn/start`/`thread/start` отклонены → `turn.start`,
  `error`, `turn.result{ok:false}` (лента не остаётся в «идёт»), сессия жива. `interrupt()` ждёт `turn/completed` не
  дольше 10 с.
- **`dispose()`**: `session.closed{disposed}`, закрытие stdin (штатный выход app-server), через `graceMs` (2 с) —
  `kill()`. Клиент процесс не убивает сам.
- **Отступления от плана.** (1) `files` (`PromptFile`) не отправляются (у Codex нет document-блоков), в лог — warn;
  этап 3 должен спрятать вложение файлов флагом. Картинки — `{type:'image', url:'data:…;base64,…'}`. (2) `effortLevels` в
  `capabilities()` — только из `EffortLevel` (`ultra`/`minimal` отброшены), `commands: []`. (3) `setMode`, `compact`,
  `stopTask`, `decidePlan`, `answerQuestion`, `respondPermission` — no-op/`false`. (4) `listSessions`/`loadHistory`/
  `renameSession`/`accountInfo` — пустые заглушки (этап 5).
- **Живой smoke (codex-cli 0.160.0) — сюрпризы протокола.**
  1. **Сервер не ставит `"jsonrpc":"2.0"`** в ответах и notifications (`{"id":1,"result":…}`) — клиент этапа 1 закрывался на
     первом же ответе («unsupported version»). Исправлено в `client.ts`: поле необязательно, чужая версия отвергается;
     тест добавлен. Мораль: unit-тесты клиента с «правильным» jsonrpc этого не ловили.
  2. `initialize` с `capabilities: null` работает; в `userAgent` приходит наше имя клиента. Сервер шлёт кучу посторонних
     notifications (`remoteControl/status/changed`, `mcpServer/startupStatus/updated`, `hook/*`, `account/*`) — маппер
     их игнорирует; **MCP-серверы и хуки пользователя из `~/.codex` стартуют на каждую сессию** (хуки видны в
     `hook/started` — это чужой код пользователя, не наш).
  3. Порядок на ходе: ответ `turn/start` (c `turn.id`, `status:inProgress`) → `thread/started` → `turn/started` →
     `item/started userMessage` → `item/completed userMessage` → `item/started agentMessage` (`phase:final_answer`) →
     `item/agentMessage/delta` → `item/completed` → `thread/tokenUsage/updated` → `account/rateLimits/updated` →
     `thread/status/changed idle` → `turn/completed`. Reasoning-items на `gpt-6-luna` (low) не было.
  4. `model/list`: 7 моделей; «самая дешёвая» — `gpt-6-luna` («Fast and affordable»; цены в ответе нет — выбор по
     описанию). `efforts` включают `ultra` (нет в `EffortLevel`).
  5. `thread/start` создаёт тред в `~/.codex/sessions/…` (`originator:"agentura"`, `source:"vscode"` — пригодится для
     фильтра в этапе 5); `turn/completed.turn.items` — «summary»-вид (`itemsView`), полный список не гарантирован.
  6. **`thread/resume` сразу после выхода предыдущего процесса того же треда даёт «thread … already has an active writer»**
     (блокировка снимается при выходе app-server). С паузой 3 с resume работает (`excludeTurns:true` принят).
     Этап 5/3: при resume вкладки сразу после закрытия — повтор с ожиданием.
  7. `rateLimits` приходят отдельным notification `account/rateLimits/updated` (primary/secondary с `usedPercent`,
     `windowDurationMins`, `resetsAt`) — возможный источник `limit.update` для Codex, в MVP не используем.
- **Не проверено на живом:** `interrupt` (только fake-сервер), картинки, approval/server requests, падение процесса
  в реальных условиях, `failed`-ход (ошибка модели/лимита), reasoning-события, очередь двух сообщений. Ход гонял дважды
  (probe + smoke, `gpt-6-luna`), оба раза «OK». Процессов `app-server --listen stdio://` после прогонов нет
  (`pgrep`); системный `app-server --managed-daemon` — не наш. Временные папки удалены; `~/.codex/sessions` получил
  два записанных CLI треда (очищать не стали — это файлы Codex).
- **Проверки:** `TZ=UTC npm run check` зелёный, 1121 тест (было 1085).
- **Ревью (2026-10-05).** Починено: (1) approval — явный `decline` вместо `-32601` (см. выше); (2) `turn/completed`
  чужого хода (id известен и не совпал) не закрывает ленту и не пускает очередь — и в мапере, и в адаптере;
  (3) usage-разности не уходят в минус и терпят отсутствующее поле; (4) клиент ищет перевод строки только в новом
  чанке и считает размер хвоста по ходу — строка на десятки МБ (лимит адаптера 64 МБ) больше не разбирается
  квадратично. Второй проход (Opus): (5) `turn/started`/`turn/completed` чужого треда адаптер не трогает, id хода
  берётся из ответа `turn/start` приоритетно; (6) страховка Stop — `turn/interrupt` отклонён или `turn/completed` не
  пришёл за 10 с → ход закрывается `turn.result{interrupted}` (`mapper.abandonTurn`), очередь не висит, поздний
  `turn/completed` того же хода второго результата не даёт; (7) **таймаут `thread/start`/`turn/start` фатален для
  сессии** (поздний ответ = ход/тред уже есть, повтор поверх сломал бы ленту; `startTimeoutMs`, 60 с); (8) ответ без
  `result`/`error` — мусор (закрывает клиент), а не «успех с undefined»; (9) `drain()` не теряет исключения;
  (10) после SIGTERM ещё grace — SIGKILL; (11) stdout закрылся раньше `exit` — `session.closed{exit}`, а не `error`;
  (12) сбой `model/list` не кэшируется навсегда; (13) `context.usage.usedTokens` = `last.totalTokens` (ввод + ответ),
  а не только ввод. Живая проверка `decline`: ход с `untrusted`/`read-only` и просьбой выполнить `touch` — модель
  отказалась сама, server request не пришёл; `decline` на живом не подтверждён (этап 4).

### 3. Подключение к чату: выбор движка, возможности, скрытие Claude-only UI

**Сессия:** sonnet.

- [ ] Фабрика провайдеров вместо единственного `createAdapter()` (`chatPanel.ts`): адаптеры
      по `AgentProvider`, Codex-адаптер создаётся лениво; `ChatController` создаёт/резюмит
      сессию у адаптера своего провайдера; engine-ready и карточка «не найден» — по провайдеру.
- [ ] `chat.info` получает `provider` и флаги возможностей (`modes`, `compact`, `metrics`
      (контекст/лимиты/цена), `subagents`, `plan`, `questions`, `images`, `files`); старое
      сообщение без полей = Claude.
- [ ] `EngineMenu` в `Composer.tsx` (сейчас заглушка «скоро»): Codex выбирается до старта
      сессии, после `session.init` — только показ; выбор запоминается как дефолт для следующего
      нового чата (`agentura.defaultProvider` или workspaceState — решить и записать).
- [ ] Для Codex скрыты: `ModeMenu` и shift-tab, `/compact` и прочие Claude-команды, HUD
      лимитов/цены/cache TTL/контекста, дерево субагентов, `AgentMenu`/`EffortMenu` если не
      применимы. Никаких фейковых чисел.
- [ ] Строки en/ru одновременно (`strings.ts`, `strings.en.ts`, nls); «Codex — скоро» убрать.
- [ ] Тесты контроллера на маршрутизацию по провайдеру; `npm run check` зелёный.
- [ ] Пользователь: новый чат → Codex → короткий ответ стримится, Stop прерывает ход.

**Готово, когда:** из UI можно открыть Codex-чат и получить ответ; Claude-чат как раньше.

### 4. Подтверждения и инструменты Codex

**Сессия:** sonnet.

- [ ] Server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
      `item/permissions/requestApproval` → `permission.request` (`toolUseId` = id запроса);
      `respondPermission` отвечает JSON-RPC response с решением из схемы; «Разрешить всегда»
      только если в enum решения есть сессионный/постоянный вариант; `serverRequest/resolved`
      → `permission.resolved`.
- [ ] `item/tool/requestUserInput` → `question.request`, если ложится на текущую карточку;
      иначе отказ ответом и запись в «Решения».
- [ ] `item/started|completed` для commandExecution (имя `Bash`, вывод в `content`, exit≠0 →
      `isError`, `item/commandExecution/outputDelta` → `tool.progress`), fileChange (пути +
      summary; нативный дифф — только если событие даёт до/после), mcpToolCall, webSearch.
- [ ] Вкладка «изменения» (`editFiles`/`fileSpans`) получает файлы Codex, если это не требует
      переделки её модели; иначе — запись в «Решения» и отложить.
- [ ] Неизвестные server requests не виснут: ответ ошибкой + лог.
- [ ] Тесты по fake-серверу: allow / deny / неизвестный запрос / прерывание при открытом
      запросе; `npm run check` зелёный.
- [ ] Пользователь: попросить создать файл — карточка подтверждения, allow и deny работают.

**Готово, когда:** команды и правки Codex видны карточками, подтверждения работают.

### 5. История Codex: список, лента, resume, rename

**Сессия:** sonnet. **Перед стартом — ответ владельца по `[скоуп]` «история через
`thread/list`»** (см. «Поправки к ТЗ»); без ответа — по поправке.

- [ ] `CodexAdapter.listSessions(cwd)` — `thread/list` с фильтром `cwd` (один короткоживущий
      app-server на запрос или общий служебный процесс — решить, записать), title из
      `name`/`preview`, время, без субагентских тредов.
- [ ] `SessionsService` объединяет провайдеров: у строки `provider`; сайдбар и пустой экран
      показывают метку `Claude`/`Codex`; resume идёт к нужному адаптеру.
- [ ] `loadHistory` — `thread/read` (с turns) → события ленты через тот же маппер.
- [ ] `renameSession` — `thread/name/set`. Удаления нет. Файлы `~/.codex` не трогать.
- [ ] Перезагрузка окна: открытые Codex-вкладки восстанавливаются (SessionRef из этапа 1).
- [ ] Тесты; `npm run check` зелёный.
- [ ] Пользователь: перезагрузить окно, продолжить Codex-тред; Claude-список и метрики как были.

**Готово, когда:** Codex-сессии видны в списках с меткой, открываются с историей и продолжаются.

### 6. Полировка: настройки, документация, smoke

**Сессия:** sonnet.

- [ ] Карточка настроек: путь к Codex с кнопкой проверки (как у Claude), выбор движка по
      умолчанию.
- [ ] README и CHANGELOG (английский), раздел про Codex: требования (`codex` установлен и
      залогинен), что поддержано и что нет в MVP.
- [ ] `docs/` — заметка о протоколе и регенерации типов при обновлении Codex.
- [ ] Список ручного smoke из ТЗ («Проверки и DoD») перенесён в pending «Проверить руками».
- [ ] `npm run check` зелёный; vsix собирается (`.codex/`, `AGENTS.md` не попадают).

**Готово, когда:** фича документирована, check и сборка vsix зелёные.

## Промты

Общее для всех этапов: репо `/Users/fost/Projects/Agentura`; проверки — `npm run check`
(длинный вывод в файл); статьи по протоколу — генерированные типы:
`codex app-server generate-ts --out <tmp>` (CLI `codex-cli 0.160.0` установлен и залогинен).
Запрещено: трогать `~/.codex`, `~/.claude` (кроме чтения), `.codex/` и `AGENTS.md` в корне
репо (локальные файлы Codex, не коммитятся), рефакторить Claude-маппер, менять визуал вне
задачи. Публичные тексты (README, CHANGELOG, коммиты) — на английском.

### Промт 1

Этап 1 «Основа провайдера». Часть уже сделана Codex и лежит в дереве незакоммиченной —
оцени `git status`/`git diff`, доделай поверх, не переписывай без причины. Карта кода: адаптер
`src/agent/types.ts` (`AgentAdapter`, `AgentSession`, `SessionCapabilities`), создание —
`createAdapter` в `src/extension/chatPanel.ts`, запоминание вкладок — `chatPanel.ts` около
`openSessions`/`setOpenSessions`, resume — `session.resume` в `src/protocol.ts`,
`src/extension/sidebarView.ts` (`agentura.openSession`), `ChatPanel.resume`; locator —
`src/extension/engineLocator.ts`; настройки — `package.json`, `package.nls*.json`,
`src/settings.ts`. Протокол Codex — сгенерируй типы во временную папку и опиши в
`protocol.ts` только то, что понадобится этапам 2–5 (см. «Поправки к ТЗ»). UI не трогать.

### Промт 2

Этап 2 «CodexAdapter». Ориентир по устройству — `src/agent/claude/adapter.ts` и его тесты
(`fakeSdk`). События — существующий `AgentEvent` из `src/agent/types.ts`; новых вариантов не
добавлять без нужды (если нужно — записать в «Решения»). Живой smoke: временная папка,
самая дешёвая модель из `model/list`, промт уровня «ответь одним словом OK», `approvalPolicy`
никогда не ослаблять; фикстуру почистить от путей/имён пользователя/токенов. В UI адаптер не
подключать.

По реальному коду (после приёмки этапа 1):
- Клиент — `src/agent/codex/client.ts` (`CodexRpcClient(process, { onNotification, onServerRequest,
  onStderr, onClose, timeoutMs, maxLineBytes })`), процесс передаётся снаружи (`RpcProcess`) — spawn
  делает адаптер. `onClose(error)` — единственный сигнал смерти клиента: из него `error` +
  `session.closed`. Клиент процесс не убивает (`dispose()` только закрывает клиент) — stdin/grace/kill
  на адаптере. `onNotification` не должен бросать (бросит — ошибка уйдёт в `onStderr`, событие потеряно).
- Без `onServerRequest` клиент сам отвечает `-32601`: этап 2 approval не показывает, но и не виснет;
  `approvalPolicy` при этом не ослаблять (отказ = отказ).
- Лимит строки `maxLineBytes` по умолчанию 1 МБ: `thread/read` длинного треда и большой вывод команды
  могут его превысить — для адаптера поднять (например, 64 МБ), иначе клиент закроется.
- Поиск бинарника: `services.codexEngine` (`EngineLocator`, `ready()`/`path()`), ошибки английские; env
  при spawn — `process.env` целиком, `OPENAI_API_KEY` и Codex auth не вырезать (ТЗ §1).
- Типы — `src/agent/codex/protocol.ts` (0.160.0); добавил тип/поле — допиши и в списки
  `scripts/codex-protocol.mjs`.

### Промт 3

Этап 3 «Подключение к чату». Карта: `ChatController` (`src/extension/chatController.ts`,
создание сессии около `ready()`), `chat.info` в `src/protocol.ts`, `Composer.tsx` (`EngineMenu`
заглушка, `ModeMenu`, `/compact`), `Hud.tsx`, `Sidebar.tsx` (лимиты/аккаунт), `AgentGroup.tsx`,
`Cards.tsx` (`EngineMissingCard`), строки `src/webview/strings*.ts`. Скрывать по флагам из
`chat.info`, а не по `provider === 'codex'` в компонентах.

По реальному коду (после приёмки этапа 1):
- Снять заглушки этапа 1: `ChatPanel.resume` (warn и `return` для не-Claude) и сериализатор
  (`ref?.provider === 'claude' ? …`) в `src/extension/chatPanel.ts`; `ChatPanel.provider` вкладки
  уже есть, `OpenOptions.provider` тоже.
- Писать `provider` в состояние webview вкладки рядом с `sessionId` (`restoredSessionId` в
  `panelRouting.ts` его уже читает): сейчас провайдер при восстановлении угадывается по памяти
  воркспейса, и если один id записан и как Claude, и как Codex, берётся первый.
- `agentura.defaultProvider` — `scope: application`, в `MACHINE_KEYS`; пока нигде не читается —
  читать при создании новой сессии. Строк в вкладке «Настройки» нет — этап 6.
- Ошибки Codex-локатора (`executable.ts`, `notFound` в `createAdapter`) английские — при подключении
  карточки «движок не найден» решить локализацию через `hostStrings`.

По реальному коду (после этапа 2): `new CodexAdapter({ executablePath: () => codexEngine.path(), log,
clientVersion })` (`adapter.ts`); `createSession` без пути бросает «Codex CLI (codex) was not found.».
`session.init` у НОВОЙ сессии приходит только при первом `send()` (тред стартует лениво), у resume — сразу;
`capabilities()` работает до первого сообщения (модели из `model/list`, `commands: []`, effort без `ultra`).
Для флагов возможностей: `files` (PromptFile) адаптер молча отбрасывает (warn в лог) — вложение файлов для
Codex прятать; `images` уходят data-URL'ом (на живом не проверено); `compact/mode/plan/questions/
stopTask` — no-op; у `turn.result` `totalCostUsd: 0` означает «неизвестно» — HUD цены/кэша прятать. `Stop`
(`interrupt`) сбрасывает очередь сообщений сессии. Таймаут `thread/start`/`turn/start` (60 с) закрывает сессию (`error` +
`session.closed`) — UI должен предложить новый чат/повтор, как при падении процесса.

### Промт 4

Этап 4 «Подтверждения и инструменты». Ориентир — как Claude-маппер выдаёт
`permission.request`/`tool.*` и как их рисует лента; формы запросов и решений — строго по
генерированным типам. Особое внимание: не оставить висящий pending-запрос при interrupt/
dispose/падении процесса.

По реальному коду (после этапа 2): `src/agent/codex/adapter.ts` — `CodexSession` создаёт
`CodexRpcClient` с заглушкой `onServerRequest` (warn + явный отказ из таблицы `REFUSALS`: `decline` / пустой grant,
прочее `-32601`): её заменить брокером.
Маппер `CodexEventMapper` (`mapper.ts`) игнорирует `item/*` кроме `agentMessage`/`reasoning`; команды и
правки добавлять в `map()`/`itemCompleted()`. `respondPermission`/`answerQuestion` в сессии пока `false`.
`thread/start` не передаёт approval/sandbox (политика из `~/.codex/config.toml`): тесты этапа — через
`CodexAdapterConfig.thread` и `FakeAppServer` (`fakeServer.ts`: `request(id, method, params)` шлёт server
request). До этапа 4 отказы `decline` маппер не показывает — агент молча «не может»; брокер должен выдавать
`permission.request`/`permission.resolved`, а отказ по таймауту/без UI — видимым событием. Ход, у которого
`turn/completed` не пришёл после Stop, адаптер закрывает сам (`abandon`) — открытые approval-запросы этого хода
брокер должен закрыть ответом там же, иначе pending повиснет. Живой сервер НЕ ставит `jsonrpc` в сообщениях; сервер шлёт и чужие notifications (`hook/*`,
`mcpServer/*`, `account/*`) — это нормально.

### Промт 5

Этап 5 «История Codex». Перед началом прочитай `15-codex-support.pending.md` — решение
владельца по истории. По реальному коду (после этапа 2): `CodexAdapter.listSessions/loadHistory/
renameSession` — пустые заглушки в `adapter.ts`; `thread/resume` сразу после выхода предыдущего
процесса того же треда падает «already has an active writer» (нужен повтор с паузой ~3 с, см. «Решения»
сессии 2); треды Agentura в `thread/list` различимы по `originator:"agentura"`/`source:"vscode"`. `SessionsService` (`src/extension/sessionsService.ts`) сейчас целиком
про `~/.claude/projects` — объединение провайдеров сделать так, чтобы Claude-путь не изменился.

### Промт 6

Этап 6 «Полировка». Настройки — `src/webview/components/Settings.tsx` и
`src/extension/settingsController.ts` (как сделана строка пути к Claude). README/CHANGELOG — по
стилю существующих. Собрать vsix штатным скриптом и проверить состав (`vsce ls` или аналог).

## Контекст и ограничения

Исходное ТЗ Codex (заголовки сдвинуты на уровень вниз).


### Цель

Добавить в расширение второго локального движка — Codex CLI. Пользователь выбирает Claude или
Codex при создании чата, получает живой поток, запросы подтверждений, остановку хода,
возобновление и список **Codex-сессий**. Claude не должен регрессировать.

Это не интеграция OpenAI Responses API и не облачный Agents API. Agentura — локальная VS Code
надстройка, поэтому правильный транспорт — запущенный дочерним процессом
`codex app-server --listen stdio://`, а не попытка разобрать вывод `codex exec`.

Почему:

- app-server даёт JSON-RPC по stdin/stdout, стабильную модель `thread`/`turn`, поток событий и
  request/response для подтверждений;
- установленный и залогиненный `codex` уже владеет авторизацией пользователя;
- CLI сам работает в каталоге воркспейса и применяет собственные `AGENTS.md`, config и sandbox.

Не делать для MVP:

- собственный OAuth / `ACCESS_TOKEN`, проксирование API-ключа или вызовы `/v1/responses`;
- парсинг `~/.codex/sessions` или другого внутреннего JSONL как источника истины;
- подмену Codex под типы и семантику Claude (`PermissionMode`, `/compact`, Claude transcript);
- перенос существующих Claude-сессий в Codex или наоборот.

Ссылка на протокол: [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Перед началом зафиксировать версию CLI (`codex --version`) и сгенерировать актуальные типы/схему
из **этого** бинарника:

```sh
codex app-server generate-ts --out /tmp/agentura-codex-protocol
codex app-server generate-json-schema --out /tmp/agentura-codex-protocol
```

Имена RPC-методов и полей ниже — контракт реализации на основании актуального app-server; типы
из команды выше имеют приоритет при несовпадении.

### Границы первого релиза

#### Обязательно

- Engine picker: `Claude` / `Codex` в новом чате; запомнить выбор для следующего нового чата.
- Автопоиск `codex`, настройка явного пути, проверка `codex --version`, понятная карточка ошибки.
- Один процесс `codex app-server` на живую вкладку чата.
- Создание и resume thread, отправка текста и изображений, поток ответа, инструменты, file changes,
  interrupt и подтверждения.
- Переключатель модели из `model/list`, если сервер его возвращает.
- Список и resume только тех Codex-thread, которые Agentura ранее сохранила в `workspaceState`.
- Unit-тесты транспорта, маппера и переключения провайдеров; smoke с реальным CLI — opt-in.

#### Явно отключить, а не имитировать

| Возможность UI | Codex MVP |
| --- | --- |
| Claude permission modes (`plan`, `acceptEdits`, `bypassPermissions`) | Скрыть. Codex sandbox/approval задаются конфигом при старте процесса, а не этими режимами. |
| Карточка `ExitPlanMode`, `AskUserQuestion` | Не показывать, пока app-server не отдаёт эквивалентный server request. |
| `/compact`, контекст в токенах, cache TTL, Claude subscription limits, стоимость | Показать `—` / скрыть виджеты. Не рисовать фальшивые числа. |
| Claude subagent tree и транскрипт субагента | Скрыть до отдельного маппинга Codex collaboration events. |
| Вложения PDF/текст как Claude `document` blocks | Не заявлять поддержку. В первом релизе — текст и изображения только если это подтверждено схемой app-server. |
| Rename/list всех локальных сессий | Не читать внутреннее хранилище Codex. Только собственный индекс Agentura. |
| ✦ генерация commit message | Оставить Claude-only; Codex добавить отдельной задачей после реализации `complete`-эквивалента. |

### Архитектура

Текущий `AgentAdapter` слишком Claude-специфичен: его контракт требует Claude transcript,
режимы прав и `complete`. Не расширять его флагами `if (adapter.id === ...)` по хосту и webview —
так получится музей исключений.

Сделать тонкий provider-neutral слой:

```
ChatPanel
  -> ChatController
    -> ProviderSession (ClaudeSession | CodexSession)
      -> Claude Agent SDK | Codex app-server JSON-RPC
```

Минимальные изменения API:

1. Ввести `AgentProvider = 'claude' | 'codex'` и `SessionRef = { provider, id }`.
   Во всех долгоживущих ключах хранить `SessionRef`, не голую строку id.
2. Оставить общий поток `AgentEvent`, но добавить необязательные capability flags к сессии:
   `canInterrupt`, `canSelectModel`, `canApprove`, `supportsImages`, `supportsHistory`,
   `supportsMetrics`. UI строится по ним.
3. Команды, которые не поддерживает движок, не отправлять вовсе. Методы `setMode`, `compact`,
   `stopTask`, `complete` сделать optional либо вынести в `SessionCapabilities`; контроллер не
   должен ловить исключение как штатный feature flag.
4. В `ToWebview`/`FromWebview` добавить `provider` в `chat.info`, `session.reset`, состояния
   вкладки и маршрутизацию resume. Старые сообщения без поля считать Claude для обратной
   совместимости состояния уже открытых вкладок.

Не надо сейчас переписывать весь UI. Достаточно capability-driven скрытия в `Composer`, `Hud`,
`SidePanes` и settings, с Claude как текущим полным набором функций.

### Файлы и точные изменения

#### 1. Выбор и запуск движка

- Новый каталог: `src/agent/codex/`.
- `src/agent/codex/executable.ts`: копия идеи из `src/agent/claude/executable.ts`, но ищет
  `codex`; минимум версии не зашивать до smoke-прогона с app-server. Проверка: `codex --version`.
- `src/extension/engineLocator.ts`: обобщить locator или завести независимый `CodexEngineLocator`.
  Не смешивать сообщения «claude не найден» и «codex не найден».
- `src/extension/chatPanel.ts`: фабрика провайдеров вместо текущего единственного
  `createAdapter()`. Создать Codex session только после выбора Codex.
- `package.json`, `package.nls*.json`, settings UI: добавить machine-scoped
  `agentura.codexExecutable` и user-scoped `agentura.defaultProvider` (`claude` по умолчанию).
  Не использовать `agentura.claudeExecutable` как путь к Codex.

Запуск процесса:

```ts
spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
  cwd,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: sanitizedEnvironment,
});
```

`cwd` — папка конкретной сессии/worktree. stderr писать в `Logger.debug`; stdout принадлежит
исключительно JSON-RPC, туда нельзя писать свои логи. На `dispose`, закрытии вкладки, ошибке
потока и extension deactivate закрыть stdin, послать cancel/interrupt активного turn при наличии
метода, затем дать процессу короткий grace period и только после него завершить.

Не вырезать из env `OPENAI_API_KEY` и Codex auth-переменные по аналогии с Claude: это сломает
нормальные способы входа Codex. Исключить только маркеры родительского процесса Codex, если
реальный smoke подтвердит рекурсивный запуск при запуске расширения из Codex.

#### 2. JSON-RPC клиент

Файл `src/agent/codex/client.ts`:

- newline-delimited JSON-RPC 2.0 поверх stdout/stdin;
- монотонный `id`, таблица pending promises, timeout на initialize и запросы;
- разбор stdout построчно с хвостом неполной строки; лимит размера одной строки;
- notifications маршрутизируются в `onNotification`;
- stderr, malformed JSON, ранний exit и закрытие stdout завершают все pending promise одной
  диагностируемой ошибкой;
- redact секреты из stderr в логах;
- тесты на response, notification, out-of-order response, broken line, timeout, process exit.

Handshake строго такой:

1. `initialize` с `params.clientInfo = { name: 'agentura', title: 'Agentura', version }`.
2. Дождаться успешного response.
3. Отправить notification `initialized`.
4. Для новой сессии — `thread/start`; для сохранённой — `thread/resume`.
5. Только после удачного thread response разрешить `turn/start`.

Не угадать форму параметров. В коде типизировать её из schema, полученной текущим CLI; тестовая
fake-реализация должна проверять именно этот порядок сообщений.

#### 3. CodexAdapter и event mapper

`src/agent/codex/adapter.ts` создаёт процесс+client на `createSession`/`resumeSession`.
`src/agent/codex/mapper.ts` переводит app-server notifications в уже существующий `AgentEvent`.
Не протаскивать raw JSON в webview.

Целевой маппинг:

| App-server событие | Agentura событие | Примечание |
| --- | --- | --- |
| `thread/started` / ответ `thread/start` | `session.init` | `sessionId = thread.id`, model, cwd, engineVersion. |
| `turn/started` | `turn.start` | Промпт хранить до старта turn, как Claude mapper. |
| `item/agentMessage/delta` | `text.delta` | Стабильный `messageId` из item id. |
| `item/reasoning/*` | `thinking.*` | Только если протокол даёт текст и пользователь может его видеть. Иначе не подделывать. |
| command execution started/output/completed | `tool.start` / `tool.result` | Имя `Bash` или `command`; stdout/stderr — в `content`; exit != 0 => `isError`. |
| file change item | `tool.start` / `tool.result` | Сначала минимум: пути и summary. Native diff подключать только когда событие даёт до/после. |
| approval request server request | `permission.request` | `toolUseId` = request id; callback response из `respondPermission`. |
| `turn/completed` | `turn.result` | Успех только при `status === 'completed'`; `failed` и `interrupted` не считать ok. |
| RPC/protocol/process error | `error` + `session.closed` | Не оставлять UI в running. |

`turn/start` получает текстом пользовательское сообщение. В MVP не смешивать несколько
неподтверждённых сообщений в один turn: отключить поле на время активного turn либо держать
очередь в `CodexSession` и стартовать следующий только после `turn/completed`.

Для отмены использовать protocol-метод отмены текущего turn (в актуальной schema), затем ждать
`turn/completed` с `interrupted`. Не убивать процесс как штатный interrupt.

#### 4. Approval и sandbox

Codex approval — это не Claude permission mode. Он может прислать server-initiated request для
команды, файлового изменения или сетевого доступа. Хранить pending request в `CodexSession` и
отвечать JSON-RPC response с тем request id.

В UI первого релиза:

- `Allow once` и `Deny` обязательны;
- `Allow always` показывать только если схема запроса буквально поддерживает persistable rule;
- передавать описание команды/пути без изменения семантики;
- `bypassPermissions` не маппить на какую-либо магическую опцию Codex.

Стартовые sandbox/approval policy должны быть отдельными настройками Codex, но не добавлять их
пока не зафиксированы точные config keys выбранной версии CLI. Без явной настройки использовать
пользовательский `~/.codex/config.toml`.

#### 5. Persistence, список и resume

Сейчас `SessionsService` читает `~/.claude/projects/*` и рассчитывает метрики из Claude
transcript. Этот сервис **нельзя** использовать для Codex.

Сделать `CodexSessionIndex` в `workspaceState`, ключ например `agentura.codexSessions.v1`:

```ts
interface StoredCodexSession {
  provider: 'codex';
  id: string;                 // thread id
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  turns: number;
}
```

- После `thread/start` немедленно сохранить запись.
- После каждого завершённого turn обновить title (первый prompt как fallback), `updatedAt`, model,
  turns.
- Сайдбар и empty screen объединяют Claude rows и этот индекс, но у каждой строки есть provider.
- Resume Codex: новый app-server → initialize → `thread/resume({ threadId })` → новый turn.
- Rename в MVP — локально меняет `title` в индексе; не обещать, что это переименует Codex CLI.
- Удалять только запись индекса, когда пользователь явно попросит. Никогда не удалять файлы
  `~/.codex`.
- Миграция `SessionMemory`: заменить `string[]` на `SessionRef[]`, но читать старый `string[]`
  как `{ provider: 'claude', id }`.

#### 6. Webview и UX

- В `Composer` добавить компактный provider picker до создания сессии; после `session.init` он
  readonly и показывает текущий provider/model.
- В `chat.info` отдать capability flags. Меню модели заполнять из `model/list`, а не списком в
  исходниках.
- HUD для Codex не должен показывать Claude лимиты, ценник, cache TTL и фиктивный context.
  Оставить статус хода/инструменты/изменения; остальные блоки скрыть.
- В sidebar рядом с сессией показать маленькую метку `Claude`/`Codex`, иначе resume ошибочно
  поднимет не тот процесс.
- Тексты локализации — одновременно en/ru; не оставлять русский только в коде.

### Последовательность коммитов

1. `provider/session-ref`: типы, миграция workspaceState, provider picker, без запуска Codex.
2. `codex-process`: locator и JSON-RPC client с unit-тестами.
3. `codex-session`: initialize/thread/turn/text/interrupt, adapter+mapper, fake server tests.
4. `codex-approvals-and-files`: approval cards и command/file items.
5. `codex-history`: локальный индекс, sidebar/empty/resume/rename.
6. `codex-polish`: capabilities, скрытие неподдержанного HUD, l10n, документация, opt-in smoke.

Каждый коммит должен собираться. Не смешивать с рефакторингом Claude mapper, Agentmeter или
визуальными изменениями UI.

### Проверки и DoD

#### Автоматические

- `npm run check` зелёный.
- Новый `CodexRpcClient` покрыт unit-тестами без установленного Codex.
- Fake app-server тестирует: initialize → initialized → thread/start → turn/start; delta;
  completed/failed/interrupted; approval allow/deny; kill процесса; resume; сохранение индекса;
  старое `SessionMemory`.
- Тесты Claude остаются зелёными и не знают о Codex кроме `SessionRef` миграции.

#### Ручной smoke (только локально, тратит лимит пользователя)

1. `codex --version`, `codex app-server --help`, вход в Codex уже выполнен.
2. Открыть новый чат → Codex; отправить «прочитай README и назови назначение проекта».
3. Убедиться, что текст приходит дельтами, turn завершается, вкладка не зависает.
4. Попросить создать временный файл; проверить approval allow и deny, native changes/карточку.
5. Запустить долгую команду, нажать Stop; получить interrupted, а не убитый интерфейс.
6. Перезагрузить окно VS Code, resume Codex thread, задать продолжение.
7. Открыть Claude чат, повторить базовый ход: Claude sessions/list/metrics работают как до этого.

### Риски, которые нельзя замолчать

- app-server помечен CLI как experimental: schema нужно сверять при каждом обновлении Codex,
  а не держаться за вручную написанные типы.
- Пользовательский доступ к конкретной модели проверяется первым успешным turn, не результатом
  `model/list`.
- Codex и Claude имеют разную модель approval, хранения сессий и метрик. Общий красивый UI не
  даёт права выдумывать эквивалентность.
- Запуск отдельного процесса на вкладку — текущая модель Agentura для Claude; позже можно
  оптимизировать daemon/proxy, но не в первой реализации.

### Официальные источники

- [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) —
  stdio transport, initialize/initialized, thread/start, turn/start, delta и completed.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) —
  app-server сохраняет локальные threads при `store: false`; local tools и child agents отличаются
  от hosted Responses tools.
