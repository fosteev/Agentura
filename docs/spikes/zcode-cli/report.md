# Спайк ZCode CLI и app-server · 2026-11-07

Главный вопрос — переиспользуется ли вход десктоп-приложения standalone-процессом без API-ключа. Ответ: **нет**. Детали и весь остальной контракт ниже. Фикстуры `test/fixtures/zcode/pong.ndjson` (кадры stream-json живого прогона) и `test/fixtures/zcode/session-sample.json` (живой диалог app-server). Ключи и токены в репо не клались; имена полей и коды ошибок — не секреты.

## Запуск

Бандл десктоп-приложения, без сборки: `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs …`. Системный node v22.23.2 (`~/.local/bin/node`) подошёл; pinned Node 24.14/pnpm 10.33 не потребовались, репо не собирался. Версия CLI из бандла — **0.17.1** (`--version` и `doctor --json` совпали; `doctor` отдаёт `cli/processName/runtime/packaging`, execPath node, платформа darwin-arm64). Контракт app-server и схем сверен с исходниками zai-org/ZCode **main `a9fe401eede6e6e5e01be9048679c206fe6f02d9`** (2026-11-03, клон в /tmp, --depth 1).

Дрейф версий: в main формат `--output-format` переименован `stream-json` → `ln` (`apps/zcode-cli/packages/cli/src/run.ts`, `GlobalOutputFormat = text|json|ln`); бандл 0.17.1 принимает `stream-json`. Докам (02-cli-reference) верить по частям, источник истины — исходники конкретного коммита.

## Вход (главный вопрос)

Прогоны `-p "Reply with exactly: pong" --cwd <tmp> --output-format stream-json`:

- Изолированный `ZCODE_DATA_BASE_DIR` (пустой стор): exit 1, stderr `Error: Select a model before sending a message (traceId …)`. Гейт модели срабатывает раньше гейта входа; CLI ничего про логин не просит.
- Против реального `~/.zcode` (наследованный env и чистый `env -i` — одинаково): сессия создаётся, провайдер резолвится `account:zai-individual-coding-plan`, модель `GLM-5.3` (из `~/.zcode/v2/setting.json`, `providerFamilyConnectionSelections.zai.kind=individual-coding-plan`), ход падает до запроса к модели. stderr: `[project-access-token] { family: 'zai', stage: 'resolve', code: 'project_token_login_failed' }` + `Error: Turn execution failed`. Кадр `turn.failed` с `payload.error.code="model_request_failed"`, `message="project_token_login_failed"` (фикстура pong.ndjson).

Цепочка аутентификации CLI (подтверждена кодом `apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts` в main и тем же кодом в бандле): читает `oauth:zai:access_token` из общего `~/.zcode/v2/credentials.json` → POST `https://api.z.ai/api/auth/z/login {token}` (business-токен) → обмен на project token → им ходит в `https://api.z.ai/api/anthropic`.

Почему падает с входом десктопа:

1. Credential store расшифровывается standalone: ключ — sha256 от `ZCODE_CREDENTIAL_SECRET` либо fallback `zcode-credential-fallback:{platform}:{homedir}:{username}` (aes-256-gcm, формат `enc:v1:<iv>.<tag>.<ct>` base64url через точку; `packages/…/auth/credential-cipher.ts`). Переменная не задана ни у приложения, ни standalone — fallback общий, шифрование не барьер.
2. Сам токен отклоняется: прямой обмен сохранённым значением → `{"code":500,"msg":"Z.ai user information is invalid","success":false}`.
3. Причина в расколе семантики общего ключа (их же код и аудит): `packages/services/src/oauth/providers/zaiProviderAdapter.ts` (main, строки ~299–369) — десктоп при логине **конвертирует** токен через `/api/auth/z/login` и сохраняет в `oauth:zai:access_token` **business-токен**; CLI (`saveZaiLoginCredentials` в `shared-credentials.ts`) кладёт туда **сырой** OAuth-токен и при каждом запросе сам шлёт его на `/api/auth/z/login`. Business-токен, отправленный на повторный обмен, отклоняется сервером. `docs/analysis/credentials-json-code-audit.md` (строка ~389) фиксирует это как «семантический раскол» текущей главной цепочки.
4. `zcodejwttoken` (свежий, обновляется приложением — iat сегодня) — это ZCode JWT сессии приложения, не модельный токен: прямой запрос к `api.z.ai/api/anthropic/v1/models` с ним → 401 «token expired or incorrect».
5. Как ходит сам десктоп: приложение поднимает локальный unix-сокет (`ZCODE_OFFICIAL_ENDPOINT`, путь вида `/var/folders/…/zcode-official-*/endpoint.sock`) и передаёт детям `ZCODE_OFFICIAL_ENDPOINT_TOKEN` (per-launch). Standalone-процессу эти значения недоступны; `--surface desktop` этот путь не включает (проверено — та же ошибка).

Рабочий путь входа без API-ключа — свой логин CLI: `zcode login zai` (браузер; `--no-browser` печатает дословно `Open this URL to sign in:` и URL). Пишет сырой токен в **общий** store — из-за раскола п.3 это может ломать/сбрасывать вход десктоп-приложения (в их аудите раскол числится открытой проблемой). Живьём не проверен: завершить браузерный OAuth может только владелец, а эксперимент перезаписывает реальное состояние `~/.zcode` — за рамками спайка.

## Таблица решений

| Вопрос | Что пришло |
| --- | --- |
| Вход десктопа standalone | **Не переиспользуется.** Провайдер/модель читаются из общего стора, но обмен токена отклонён сервером; причина — раскол business/raw в `oauth:zai:access_token` (десктоп пишет business, CLI ждёт сырой). Отдельный `zcode login zai` (браузер, без ключа) живьём не проверен и рискует сессией десктопа. |
| Транспорт вкладки | **app-server** структурно пригоден: `zcode app-server --stdio`, NDJSON, долгоживущий; инициализация, session/create/send/stop/subscribe/list/messages, server→client запросы (runtimePreferences, officialMcpAuthHeaders, requestPermission/requestUserInput). Но без входа ход не выполняется — транспорт не спасает от стопа по входу. Fallback `-p`+`--resume` хуже: нет долгой сессии и интерактивных разрешений. |
| Конверт протокола | Не JSON-RPC: request `{id, method, params?, trace?}`, notification `{method, params?}`, response `{id, result}`, error `{id, error:{code, message, data?}}`; id — string|int; server-запросы приходят с id вида `server-N`. Протокол `{name:"ZCode Protocol", version:1}`. Ошибки: `-32602` + ZodError в data (неправильные params), `-32004` + `data.code:"runtimeNotReady"`. |
| Методы (main `a9fe401`) | `session/create|resume|list|read|messages|events|subscribe|send|stop|setModel|setThoughtLevel|setMode|close|fork|compact|goal|subagents|cancelBackgroundTask`, `session/lifecycle/{changed,getState,ensureReady,stop,restart}`, `runtime/capabilities`, `interaction/requestPermission|requestUserInput|requestOfficialMcpAuthHeaders`, `workspace/readState|readPresentation|…`, `provider/updateAccountConfig|refreshRegistry|testModelConnectivity`, `usage/stats`, `mcp/*`, `plugins/*`, `workflows/*`, `process/childProcesses`. |
| События хода | Обёртка `{eventId, payload, seq, sessionId, timestamp, traceId?, turnId?, type}`; в app-server то же приходит как notification `session/event` c `deliveryKind` (`desktop-continuous`|`web-remote-replayable`). Типы (маппер `session-mapper.ts`): `session.created|updated|titleUpdated|resumed|closed`, `turn.started|completed|failed|steerQueued|steerDrained`, `message.upserted`, `model.streaming`, `message.part.delta`, `tool.updated`, `permission.requested|resolved`, `checkpoint.created`, `rewind.triggered`, `streamRecovery.updated`. Живьём видели: `session.titleUpdated`, `turn.started`, `session.updated`, `turn.failed`, `session.resumed`; остальные — по схемам исходников, живьём не видели. |
| Текст хода | `model.streaming` payload `{kind, delta?, done?, partId?, assistantMessageId?, toolCallId?, toolName?}`; пословно `message.part.delta` `{messageId, partId, field:"text"|"reasoning"|"input"|"output", delta}`. Живьём не видели. |
| Tool | `tool.updated`, payload kind-дискриминирован (scheduled/started/progress/result/error/batch), база `{toolCallId, toolName?, parentToolCallId?, source?, description?}`. Имена инструментов — как у сервера (в логе хода видели `Bash` и др., `toolCount:40`). Живые карточки не видели. |
| Разрешения | Запрос server→client `interaction/requestPermission`, payload `permission.requested`: `{input, origin?, options[], reason, requestId, requestedAt, riskLevel, toolCallId, toolName}`. Ответ клиента: `{decision:"allow"|"deny"|"escalate"|"modify", reason?, modifiedInput?, permissionUpdates?}`. Опции (allow-once/allow-always) обрезаются policy. Живьём не видели. |
| Режимы | Значения `plan|build|edit|yolo|guarded` (+`auto` внутренний). `-p` дефолт `yolo`. Семантика (дока 05): `plan` — без обычных записей/команд (анализ), `build` — записи требуют подтверждения, `edit` — правки файлов без подтверждения, остальное как build, `yolo` — без интерактивных подтверждений, `guarded` — мягкий, опасные команды подтверждаются по-одиночке. `session/create {mode}` принят: в ответе projection показал дефолт `build`, применённый режим подтверждён патчем `state.updated` → `permission.mode:"guarded"`; смена — `session/setMode`. |
| Модели | Флага `--model` нет. app-server: `session/create {model:{providerId, modelId, options:{reasoningLevel}}}`, `session/setModel`, `session/send {modelSelection}`; список — патч `state.updated` → `model.available[]` (без входа пуст). `-p` берёт выбор из пользовательского конфига (общий с десктопом `setting.json`); на этой машине выбор `account:zai-individual-coding-plan/GLM-5.3` c `reasoningLevel:"max"`. TUI — `/model`. |
| Usage/квота | `turn.completed` payload `{response, tokenCount, usage?, toolCallCount, historyRoundCount?, duration, cacheStats?, inputId?, resultType:"success"|"cancelled"|"error_*"}`; метод `usage/stats {range:"all"|"7d"|"30d"}` (живой вызов: без range — Zod ошибка с перечислением). БД: таблицы `turn_usage`, `model_usage`. Чисел живьём не видели; cost не видел никто. |
| Сессии/хранилище | SQLite `~/.zcode/cli/db/db.sqlite` (redirect `ZCODE_SESSION_DB_PATH`/`ZCODE_DATA_BASE_DIR`), схема — implementation detail (дока 06); таблицы `session/message/part/permission/turn_usage/model_usage/todo/…`. Список: app-server `session/list {workspace?, sessionIds?, limit?}` → `{sessions:[{sessionId, createdAt, mode, status, sessionKind, title, traceId…}]}` (живьём). `session/messages` — история (живьём). `-p --resume sess_…` — кадр `session.resumed` (живьём), `-c|--continue` — последняя в cwd. `session.created` при новом `-p` прогоне пишется в стор самим CLI. |
| Attach | `--attach <path>` повторяемый (дока 02). Живьём не проверен: на изолированном сторе прогон упёрся в гейт модели раньше attach-логики. |
| Изоляция | `ZCODE_DATA_BASE_DIR`/`ZCODE_SESSION_DB_PATH` работают: изолированный стор = пустые сессии, своя БД. Важно: запуск из-под десктопа наследует его env (`ZCODE_OFFICIAL_ENDPOINT(_TOKEN)`, `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`…) — для честного standalone использовать `env -i`. |

## app-server: живой след

Порядок кадров успешного диалога (полный след — `test/fixtures/zcode/session-sample.json`):

```text
zcode app-server --stdio
← startup/storageState (notification, фазы checking→committing→ready, databaseId)
→ runtime/capabilities                ← {sessionLifecycleWorkspace:true, …}
→ session/create {workspace:{workspacePath, workspaceKey}, mode}
← session/lifecycle/changed {state:"starting"}
← session/requestRuntimePreferences   (server-запрос, scope:"runtime-materialization")
← interaction/requestOfficialMcpAuthHeaders (server-запрос; ответ {ok:false,reason:"official_auth_unavailable"} принят)
← session/lifecycle/changed {state:"ready"}
← {id, result:{messages:[], projection:{…, mode, contextWindow:200000}, session:{sessionId, mode, status}}}
→ session/subscribe {sessionId, deliveryKind:"desktop-continuous"}  ← {eventSeq, events:[]}
→ session/send {sessionId, content}    ← {accepted:true, stateRevision}
← session/requestRuntimePreferences (scope:"user-execution")
← state.updated {patch:{status:"running"}, reason:"prompt_started", revision}
← session/event × N (titleUpdated, turn.started, … turn.failed)
← state.updated {patch:{mode:{current}, model:{available}, permission:{mode}, thoughtLevel}, reason:"prompt_failed"}
→ session/stop {sessionId}             ← {}
→ session/messages {sessionId}         ← история сообщений с parts
→ session/list {}                      ← {sessions:[…]}
```

EOF stdin → сервер останавливается (drain), stderr `Error: Protocol input closed`. Console-вывод идёт в stderr, stdout — только протокольные NDJSON-строки.

## Что ужато в фикстурах

`pong.ndjson` — 6 живых кадров прогона против реального `~/.zcode` (ход упал на входе). `eventId/sessionId/turnId/traceId/uuid` заменены на `event-NN/sess-NN/turn-NN/trace-NN/uuid-NN`, пути машины — `<tmp>`/`<home>`/`<bundle>`, `payload.error.stack` (594 символа трейсминифицированного кода) — на `{"_truncated":true,_chars:594}`. `session-sample.json` — живые ответы app-server с той же очисткой; внутри `_provenance` с условиями съёмки. `variant-c-key-billing.ndjson` — 5 кадров варианта C (429/1113 с ключом без баланса + `invalid_model_request` без `thoughtLevel`), та же очистка.

## Не проверено

Живые текстовые дельты, tool-карточки, запрос/ответ разрешения, usage/cost, `turn.completed`, `--attach` (текст/картинка), выбор модели живьём, `zcode login` до конца, влияние CLI-логина на сессию десктопа, TUI. Windows. Сборка из исходников (не потребовалась). Сессии спайка остались: в изолированных `ZCODE_*` каталогах `/tmp` и записи сессий в реальном `~/.zcode/cli/db/db.sqlite` (обычное использование CLI, ничего не удалялось).

## Вариант C — provider_config.json + ключ Coding Plan (2026-11-08, закрыт по биллингу)

Схема (значение ключа опущено; канонично — сверено со встроенным `zcode-builtin.json` бандла: шаблон `zhipu-coding-plan-api-key` использует те же `baseUrl`/`api.type`):

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": { "providerRules": [{
      "providerId": "agentura-zai-key",
      "providerName": "Z.ai Coding Plan key",
      "enabled": true,
      "config": {
        "access": { "type": "zhipu-coding-plan-api-key", "apiKey": "<ключ>", "apiKeyManagementUrl": "https://z.ai/manage-apikey/apikey-list" },
        "api": { "type": "anthropic-messages", "baseUrl": "https://api.z.ai/api/anthropic" },
        "personalModelIds": ["glm-5.3"], "modelOrder": ["glm-5.3"], "visibility": "visible"
      }
    }]},
    "defaultModelSelection": { "providerId": "agentura-zai-key", "modelId": "glm-5.3", "options": { "reasoningLevel": "high" } }
  }
}
```

Признаки состояния входа (живьём, `-p` и app-server одинаково): ключ аутентифицирован → ход уходит на `https://api.z.ai/api/anthropic`, модель резолвится `agentura-zai-key/glm-5.3`; при отсутствии квоты у ключа — `turn.failed {code:"1113"}` / HTTP 429 `rate_limit_error` «Insufficient balance or no resource package». Модель на конце — строчная `glm-5.3` (подтверждено живым `GET /v1/models` с ключом; `builtinModelIds` шаблона — `GLM-5.3`/`GLM-5.3-Flash`). Два нюанса app-server, снятых при подготовке прогона: событие лежит прямо в `params` нотификации `session/event` (без обёртки `event`); `session/create {model:{…,options:{reasoningLevel}}}` теряет reasoning level → нужен top-level `thoughtLevel:"high"`, иначе `turn.failed {code:"invalid_model_request", message:"Reasoning level is required for agentura-zai-key/glm-5.3"}`.

| Что проверялось | Результат |
| --- | --- |
| Аутентификация ключом (2 разных Standard-ключа, `-p` + прямой curl `x-api-key` мимо ZCode) | **Снято**: оба валидны (не 401), оба `429 [1113] Insufficient balance` — привязки к плану нет ни у одного |
| Каноничность схемы (vs `zcode-builtin.json`, родной `/login zai-coding-plan-api-key`) | **Снято**: `baseUrl`/`api.type`/access-тип совпадают; родной путь кладёт ключ в credential store, не в provider_config |
| Живой ход модели (дельты, `tool.updated`, `interaction/requestPermission` allow/deny, `turn.completed` usage, stop, resume, setModel/setMode, `--attach`) | **Не снято, причина**: ход не проходит дальше биллинга ключа (1113) |
| Влияние на десктоп | **Снято**: `defaultModelSelection` общий с десктопом — на время смоука ставится на ключ-провайдер, после возвращается на `account:zai-individual-coding-plan/GLM-5.3`; провайдер в конфиге виден в списке моделей (visibility visible), записи не делает, т.к. не выбирается |

Вердикт по варианту C: технически схема работает ровно до биллинга — но API-ключи Z.ai (включая вкладку «Personal Coding Plan») списывают с отдельного API-баланса, а не с квоты подписки Coding Plan (подтверждено живьём 1113 на двух ключах; zai-org/feedback#789 и docs.z.ai/devpack/faq описывают биллинг Standard-ключей, план-квота на ключи не распространяется). Решение владельца 2026-11-08: API отдельно не оплачивать — вариант закрыт, нужен безключевой путь (кандидат: изолированный `ZCODE_DATA_BASE_DIR` + разовый `zcode login zai`).

## Вердикт

Вход десктоп-приложения не переиспользуется: CLI каждый ход сам обменивает `oauth:zai:access_token` на `/api/auth/z/login`, а десктоп хранит в этом ключе уже конвертированный business-токен — сервер обмен отклоняет («Z.ai user information is invalid»), ход падает `project_token_login_failed` (бандл 0.17.1 и main `a9fe401` ведут себя одинаково). Токен приложения (`ZCODE_OFFICIAL_ENDPOINT_TOKEN`) живёт только в env его детей. Безключевой `zcode login zai` в общем сторе взаимоисключаем с работающим десктопом. Вариант C (API-ключ) закрыт по биллингу: ключи, включая вкладку Personal Coding Plan, списывают с отдельного API-баланса, не с квоты подписки — владелец API отдельно не оплачивает (2026-11-08). DoD go (подтверждённый вход) не выполнен ни по одному пути; транспорт и форматы кадров сняты и лежат в фикстурах и таблицах выше. Оставшийся кандидат — изолированный `ZCODE_DATA_BASE_DIR` + разовый `zcode login zai` (свой credentials.json, десктоп не задет) — требует проверки живучести сырого oauth-токена CLI до вынесения на владельца.

stop
