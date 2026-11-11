# 33 — ZCode как пятый движок

> Статус: вариант C (провайдер `agentura-zai-key` с ключом Coding Plan) применён и проверен до шага «квота ключа» — ждём ключ со вкладки Personal Coding Plan в `~/.agentura-glm-key`; транспорт app-server подтверждён; аккаунт-вход standalone закрыт окончательно. Исполнитель отмечает чекбоксы по ходу, только после проверки из «Готово, когда». Статусы живут здесь.

## Checkpoint

**2026-11-07 · этап 1 исполнен, не принят — `stop` по DoD (вход аккаунтом не подтверждён).**

- Как запустился: бандл десктопа без сборки (`node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`), системный node 22.23.2 подошёл; CLI 0.17.1; контракт сверен с исходниками main `a9fe401e`.
- Главный вопрос — вход: **нет**. Провайдер/модель резолвятся из общего стора (`account:zai-individual-coding-plan/GLM-5.3`), но ход падает до модели: CLI обменивает ключ `oauth:zai:access_token` через `POST /api/auth/z/login` каждый ход, а десктоп кладёт туда уже конвертированный business-токен — сервер отклоняет (`Z.ai user information is invalid`). Раскол зафиксирован их же кодом (`zaiProviderAdapter.ts`) и аудитом `docs/analysis/credentials-json-code-audit.md`. Десктоп аутентифицирует детей через локальный сокет `ZCODE_OFFICIAL_ENDPOINT` + per-launch токен — standalone недоступен. Оставшийся безключевой путь: `zcode login zai` (браузер; пишет общий ключ, риск для сессии десктопа; живьём не проверен).
- Транспорт: app-server пригоден — `zcode app-server --stdio`, NDJSON-конверт, живой диалог `runtime/capabilities` → `session/create` (server-запросы `session/requestRuntimePreferences`, `interaction/requestOfficialMcpAuthHeaders` — отказ `{ok:false,reason:official_auth_unavailable}` принят) → `session/subscribe` → `session/send` → `session/event`/`state.updated` → `session/stop`; `session/list|messages|events|resume`, `setModel`, `setMode`, `usage/stats`, `interaction/requestPermission` (`allow|deny|escalate|modify`). Fallback `-p`+`--resume` хуже (нет долгой сессии и интерактивных разрешений).
- Снято структурно (живьём не видели — гейт авторизации раньше): текст-дельты, `tool.updated`-кадры, `interaction/requestPermission` бой, `turn.completed` usage, `--attach`, режимная семантика в бою. Модели: `--model` нет; `session/create {model}` / `setModel` / `send {modelSelection}`; список `model.available[]` (без входа пуст). Сессии: SQLite `~/.zcode/cli/db/db.sqlite`, `session/list|messages|events`.
- Артефакты: `docs/spikes/zcode-cli/report.md` (последняя строка `stop`), `test/fixtures/zcode/pong.ndjson`, `test/fixtures/zcode/session-sample.json`. Чекбоксы этапа 1 отмечены исполнителем.
- Ветка/коммиты: `stage-1-zcode-spike`, коммитов нет; WIP 31 и src/ не тронуты (диф src — это WIP 31). Временные: `/tmp/zcode-spike-Gczl48`, драйвер `/tmp/zcode-spike-driver.mjs`, клон `/tmp/zcode-repo` (`a9fe401e`).
- Проверки приёмки (основной чат, 2026-11-07): `tail -1` отчёта = `stop`; фикстуры на месте; `rg` по секретам — только имена полей, без значений; `git status` — из нового только спайк-каталоги.
- Модели/усилия: исполнитель — subagent `general-purpose` (`agent_ee15e5f9-49e7-4434-bd7e-d9c4ae843246`), runtime-модель unknown; основной чат — GLM-5.3 (zai-individual-coding-plan). cwd `/Users/fost/Projects/Agentura` подтверждён.
- Блокер/решение владельца: (A) прогнать `zcode login zai` (браузерный вход) и переспайкнуть вход тем же агентом — если заработает, маршрут жив без ключей; риск — общий ключ стора, худший случай десктоп попросит перелогин; (B) возврат к roadmap 32 — ключ Coding Plan со страницы z.ai/manage-apikey/apikey-list. Опция (C) внутри 33, если вход сломает десктоп: ZCode CLI + `provider_config.json` с anthropic-messages и ключом Coding Plan — нативный движок с ключом (пользователь настраивает руками).

**2026-11-07, дополнение — вариант A опробован живьём и закрыт.**

- Владелец прогнал `zcode login zai` (браузерный вход прошёл). Сразу после: десктоп-сессия выкинута (ожидаемый общий ключ), а проба хода основного чата (`-p pong --mode build`, реальные credentials, `/tmp/zcode-auth-probe/pong.ndjson`) — всё равно `project_token_login_failed`: работающий десктоп перезаписал ключ обратно своим business-токеном. Вывод: CLI-логин и работающий десктоп взаимно исключают друг друга через `credentials.json` — не продуктовый путь.
- Принято (без ответа владельца на развилку, по факту закрытия A): вариант C — этап 1 дополняется прогоном через `provider_config.json` с ключом Coding Plan (владелец создаёт ключ на z.ai/manage-apikey/apikey-list, кладёт в `~/.agentura-glm-key`), тем же агенту спайка (`agent_ee15e5f9-49e7-4434-bd7e-d9c4ae843246`): настроить провайдер, живой ход через app-server, снять недостающие кадры (текст-дельты, `tool.updated`, `interaction/requestPermission`, `turn.completed` usage, `--attach`, resume), обновить отчёт до `go`/`stop`. Десктоп после этого владелец перелогинивает свободно — ключ провайдера от логина не зависит.
- Промт проверки в другом клиенте: прочитать `docs/spikes/zcode-cli/report.md` (последняя строка — `stop`, разделы про вход и app-server); `rg -n "Bearer|api_key|apiKey|token" test/fixtures/zcode docs/spikes/zcode-cli` — значения секретов отсутствуют; `git status --short` — новые каталоги только `docs/spikes/zcode-cli/`, `test/fixtures/zcode/`.

**2026-11-07 поздно вечером — вариант C проверен до «квоты ключа», заблокирован на ключе подписки.**

- Исполнение перенесено в основной чат (ZCode CLI TUI): фоновые сабагенты и ходы по уведомлениям остаются без approval-handler — записи/запуски им отказаны до выполнения; владельцу достаточно `/mode yolo` в TUI. Первый сабагент выполнил только исследование исходников (схема `provider_config.json` подтверждена по `/tmp/zcode-repo`, `a9fe401e`).
- Конфиг применён и проверен живьём: провайдер `agentura-zai-key` (`zhipu-coding-plan-api-key`, `anthropic-messages`, `https://api.z.ai/api/anthropic`, `glm-5.3`; в `defaultModelSelection` обязателен `options.reasoningLevel:"high"`, иначе registry-fallback на аккаунт). Ход дошёл до Z.ai, ключ аутентифицирован. `defaultModelSelection` возвращён на `account:zai-individual-coding-plan/GLM-5.3`, провайдер оставлен в конфиге, бэкап `/tmp/provider_config.json.bak`.
- Блокер: ключ из `~/.agentura-glm-key` — стандартный (вкладка Standard на z.ai/manage-apikey/apikey-list), отвечает `[1113] Insufficient balance` (429): с 2026-10-16 стандартные ключи биллят баланс, а не квоту плана (zai-org/feedback#789, docs.z.ai/devpack/faq). Владелец создаёт ключ на вкладке **Personal Coding Plan** той же страницы (показывается один раз) и кладёт в `~/.agentura-glm-key`.
- Аккаунт-вход standalone перепроверен и закрыт окончательно: `oauth:zai:access_token` в `~/.zcode/v2/credentials.json` — CLI-oauth JWT с TTL ~1 ч (на момент проверки истёк), каждый standalone-процесс (`-p` и app-server) обменивает его при старте; TUI работает от кэша в памяти (`zai-business-token-cache.ts`); десктоп к тому же перезаписывает токен своим business-токеном. Продуктового пути без API-ключа нет.
- Осталось после появления ключа: заменить apiKey у `agentura-zai-key` и выставить дефолт на него → смоук `-p pong` → app-server цикл (дельты, `tool.updated`, `interaction/requestPermission` allow/deny, `turn.completed` usage, resume, setModel/setMode, `--attach`; драйвер `/tmp/zcode-spike-driver.mjs`) → санитизированные фикстуры → раздел «Вариант C» в `docs/spikes/zcode-cli/report.md` с вердиктом → вернуть `defaultModelSelection` → `rg` по секретам, `git status` → checkpoint.

**2026-11-08 (утро) — вариант C закрыт по биллингу (решение владельца), итог этапа 1 — `stop`; ищем третий путь.**

- Ключ владелец принёс (mtime 04:10), но вставка содержала **две** строки-ключа по 49 символов (`{32hex}.{16}`): line1 — побайтово старый Standard-ключ из конфига, line2 — ещё один. Обе аутентифицируются (не 401), обе дают `429 [1113] Insufficient balance` — и через ZCode, и прямым curl с `x-api-key` на `/v1/messages`; `GET /v1/models` с ключом работает (model id на конце — строчный `glm-5.3`). Файл нормализован до одной строки.
- Конфиг подтверждён каноничным против встроенного `zcode-builtin.json` бандла (шаблон `zhipu-coding-plan-api-key`: те же baseUrl/api.type; родной путь TUI `/login zai-coding-plan-api-key` кладёт ключ в credential store). Механика работает ровно до биллинга.
- **Решение владельца**: API-ключ Z.ai (включая вкладку «Personal Coding Plan») оплачивается отдельно от подписки — план-квота на ключи не распространяется; API отдельно не оплачиваем. Вариант C закрыт. Зафиксировано в памяти проекта (`zai-coding-plan-key-separate-billing`).
- Драйвер app-server-цикла написан и отвёркан живьём до биллинга: `/tmp/zcode-c-driver.mjs` (create/subscribe/send/turn.failed; permission allow/deny, stop mid-turn, setMode/setModel, messages/list/close/resume — код готов, живьём не прошёл из-за 1113). Сняты два нюанса протокола: событие лежит прямо в `params` у `session/event`; `session/create {model:{options}}` теряет reasoningLevel → нужен top-level `thoughtLevel:"high"` (иначе `invalid_model_request: Reasoning level is required`).
- Артефакты: `docs/spikes/zcode-cli/report.md` — раздел «Вариант C» с таблицей снято/не снято, вердикт файла `stop`; новая фикстура `test/fixtures/zcode/variant-c-key-billing.ndjson` (5 кадров, санитизирована).
- Состояние машины: `defaultModelSelection` на аккаунте, провайдер `agentura-zai-key` с нерабочим Standard-ключом оставлен в `~/.zcode/v2/provider_config.json` (бэкап `/tmp/provider_config.json.bak`); `~/.agentura-glm-key` — одна строка (Standard-ключ).
- Следующий шаг (не начат): оценка варианта D — изолированный `ZCODE_DATA_BASE_DIR` (свой credentials.json, десктоп не задет) + разовый `zcode login zai` владельцем + app-server в этом сторе, биллинг — квота подписки. До выноса владельцу проверить по исходникам живучесть сырого oauth-токена CLI (JWT ~1 ч — есть ли refresh). Этап 2 не стартует: `stop` по DoD этапа 1 + грязное дерево (WIP 31).

## Цель

Новая вкладка Agentura работает на ZCode CLI — нативном агенте GLM от Z.ai: текст хода стримится в ленту, инструменты и разрешения приходят карточками, режимы Agentura отражаются в режимы ZCode, сессии видны в сайдбаре и возобновляются. Вход — существующий аккаунт ZCode (credential store, квота подписки), без API-ключей и без записей в `~/.zcode` со стороны Agentura. Claude, Codex, Antigravity и Cursor не меняют поведения.

## Контекст и ограничения

Факты сняты с репозитория zai-org/ZCode (main) и его доков 2026-11-07, **живым прогоном не проверены**. На машине: десктоп ZCode установлен и работает (`/Applications/ZCode.app`, внутри `Resources/glm/zcode.cjs` + `packages` + `node-runtime` + `provider`); команды `zcode` в PATH нет.

- CLI (`apps/zcode-cli`): `zcode` без аргументов — TUI. Неинтерактив: `zcode -p "<промт>" --cwd <абс> --mode plan|build|edit|yolo|guarded --output-format stream-json` — NDJSON-стрим, успешный прогон кончается кадром `type: "result"`. Есть `--resume <id>` / `--continue`, `--target`, `--attach` (файлы, повторяемый), `--disallowed-tools`. Флагов `--print`, `--model`, `--settings`, `--max-turns`, `--allowed-tools`, `--permission-mode` нет (доки запрещают выдумывать). Дефолтный режим у `-p` — `yolo`.
- `app-server` — «протокольный вход» для интеграций (не для batch-вопросов): аналог codex app-server, долгоживущий сервер. Документирован только в исходниках (`packages/rpc`, `packages/client`, `packages/server`, `apps/zcode-cli`).
- Вход: учётные данные аккаунта — credential store, отдельный от провайдерских конфигов; кастомные провайдеры — `~/.zcode/v2/provider_config.json` (api types: `openai-chat-completions`, `openai-responses`, `anthropic-messages`). Env для изоляции: `ZCODE_DATA_BASE_DIR`, `ZCODE_STORAGE_DIR`, `ZCODE_SESSION_DB_PATH`, `ZCODE_LOG_DIR`.
- Сборка: Node 24.14.0 + pnpm 10.33.2 (`mise.toml`), `pnpm bootstrap` → `pnpm build:zcode` → `dist/zcode` + `install.sh` → `~/.zcode/runtime` + `~/.local/bin/zcode`. Готового дистрибутива не найдено. Кандидат на запуск без сборки — бандл десктоп-приложения (`zcode.cjs` через node).
- Сессии (дока `06-sessions.md`): «новые, восстановление, цели, usage и персистентность» — живой формат не снят.

Точки входа Agentura те же, что в roadmap 29/32: `AgentProvider` `src/agent/types.ts:29`; `PROVIDERS`/`MACHINE_KEYS` `src/settings.ts:167`/`:291`; фабрика и `adapterOf`/`engineOf` `src/extension/chatPanel.ts:210`/`:1251`/`:1264`; extra-провайдеры `src/extension/sessionsService.ts:25`/`:181`/`:280`/`:482`; флаги `src/agent/features.ts`; метки `src/webview/engineLimitsView.ts:36`; локатор `src/extension/engineLocator.ts`. Эталоны адаптера долгого процесса — `src/agent/codex/` (app-server JSON-RPC) и `src/agent/cursor/` (ACP). Новые `AgentEvent` не заводить.

### Принятые решения

- Провайдер `zcode`, UI «ZCode», метка `ENGINE_MARK` `Z`. Код — `src/agent/zcode/`. Настройка `agentura.zcodeExecutable` (machine-scope), `agentura.defaultProvider` получает значение `zcode`.
- Транспорт вкладки — `app-server` по образцу Codex; одноразовые `-p`-прогоны не транспорт вкладки, только базовая линия спайка. Если спайк забракует app-server — fallback `-p` на ход + `--resume`, с явной записью в отчёт (карточки разрешений тогда ограничены режимами).
- Вход — ключ Coding Plan в `~/.zcode/v2/provider_config.json` (провайдер `anthropic-messages`, эндпоинт Z.ai): настраивает владелец один раз, Agentura этот файл не пишет и не правит (подсказка в настройках — да). CLI-логин `zcode login zai` несовместим с работающим десктоп-приложением: общий ключ `credentials.json`, взаимная перезапись токенов (проверено живьём 2026-11-07 — логин CLI выкидывает десктоп, десктоп перезаписывает ключ обратно, ход CLI снова падает) — этот путь не используем и пользователю не предлагаем, пока Z.ai не починит раскол (зафиксирован их аудитом `credentials-json-code-audit.md`). Agentura не хранит ключи и не пишет `~/.zcode`. Изоляция тестов и smoke — `ZCODE_*` env во временные каталоги.
- Режимы (семантику уточняет спайк): `plan` → `plan`, `default` → `build`, `acceptEdits` → `edit` (или `build` — по факту), `bypassPermissions` → `yolo` только при `allowBypassPermissions`, иначе остаётся `default` → `build`.
- Модели: флага `--model` нет; способ выбора снимает спайк (метод app-server / конфиг сессии). Нет способа — статический список из отчёта.
- Usage: сессия отдаёт usage — показываем; лимиты подписки не выдумываем, `cost` по умолчанию false, пока спайк не принёс честные числа.
- Флаги v1 по умолчанию (поднимает спайк): `modes` true; `plan`, `questions`, `images`, `files` — только по живым кадрам; `remote`, `skills`, `subagents`, `nativeSettings` — false.
- `~/.zcode` со стороны Agentura не читаем и не пишем — всё делает сам CLI. В README прямо: движок использует ваш вход ZCode, отдельные сессии CLI появятся в истории приложения.
- Ветки `stage-N-zcode-*`, этапы строго по порядку. Этапы 2+ — на чистом дереве (WIP roadmap 31 закрыт), общие файлы трогают этапы 2 и 5.
- Clone репозитория ZCode — вне репо Agentura (`/tmp`, `--depth 1`), фиксируем коммит в отчёте: контракт app-server сверяем с исходниками конкретного коммита.

## Этапы

### 1. Спайк ZCode CLI и app-server

Зачем: главный вопрос маршрута — переиспользуется ли вход десктоп-приложения standalone-процессом без API-ключа. Плюс контракт стрима и app-server, без которых маппер не писать.

- [x] Запуск без сборки: `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --version` (и `doctor --json`, `-p pong`) с изолированным `ZCODE_DATA_BASE_DIR` во временную папку. Не работает — клон `zai-org/ZCode` в `/tmp` (`--depth 1`), сборка по README (Node 24.14.0, pnpm 10.33.2), запуск `zcode.mjs`. Записать, какой путь заработал, и версию/коммит.
- [x] Вход: тот же `-p pong` против реального `~/.zcode` (аккуратно, read-only подход, ничего не удалять, работающее десктоп-приложение не трогать). Главный вопрос: уходит ли ход через аккаунт подписки без ключа. Чего CLI просит при отсутствии входа — дословно.
- [x] stream-json: pong; ход с правкой файла в `--mode guarded`, `build` и `yolo` (как выглядят tool-кадры, разрешения/отказы, usage); `--resume` той же сессии; способ списка сессий (дока 06); способ выбора модели; `--attach` файла и картинки.
- [x] app-server: из исходников — точка запуска, кадры инициализации/хода/разрешения/usage; один живой прогон pong. Вердикт: app-server или fallback `-p`+`--resume`.
- [x] Фикстуры `test/fixtures/zcode/pong.ndjson` (кадры стрима) и образец сессии/трека; отчёт `docs/spikes/zcode-cli/report.md`: версия/коммит, таблица решений (вход; транспорт; семантика режимов; модели; usage; сессии/хранилище; формат tool/permission), строки `go`/`stop`.

**Готово, когда:** `docs/spikes/zcode-cli/report.md` заканчивается `go` или `stop`. При `go` есть фикстуры, выбранный транспорт и подтверждённый вход аккаунтом. `stop`-кандидаты: вход не переиспользуется и требует ключ (тогда возврат к roadmap 32), либо CLI/app-server не поднимаются вовсе. Проверка: `rg -n "Bearer|api_key|apiKey|token" test/fixtures/zcode docs/spikes/zcode-cli` — пусто по секретам (значения из `~/.zcode` в репо не попадают).

### 2. Процесс, ход, текст, Stop

Зачем: адаптер говорит с выбранным транспортом и проводит текстовый ход до `AgentEvent`. В меню движков его ещё нет.

**Исполнение:** отдельная сессия. Только после `go` и на чистом дереве.

- [ ] `AgentProvider` += `'zcode'`; `PROVIDERS`, `package.json` + nls en/ru, `agentura.zcodeExecutable`, значение `zcode` у `defaultProvider`.
- [ ] `src/agent/zcode/executable.ts` по образцу codex: `--version`/`doctor` опознаёт ZCode; путь к бандлу приложения — легитимный кандидат по умолчанию. Чужой бинарник с тем же именем — «не найден». Windows — без `.cmd`/`.bat`.
- [ ] `protocol.ts` — подмножество кадров из отчёта, версия/коммит в шапке; `client.ts` — транспорт этапа 1; `adapter.ts` + `mapper.ts`: процесс/подключение на сессию, `createSession`/`resumeSession`, `send` текстом, очередь, `interrupt`, `dispose` (grace → kill). События `session.init`, `turn.start`, `text.delta`, `turn.result`, `error`, `session.closed`.
- [ ] `capabilities()`: модели способом из отчёта, нет — статический список, `setModel` по контракту или `warn`.
- [ ] Фейк транспорта в тестах: pong, падение, cancel, resume. `TZ=UTC npm run check` зелёный. UI не показывает.

**Готово, когда:** `TZ=UTC npm run check` зелёный, тесты `src/agent/zcode/` есть, вкладка без провайдера `zcode` по-прежнему Claude. Opt-in smoke `scripts/zcode-smoke.mjs` (временный `ZCODE_DATA_BASE_DIR`, один pong) — не часть check.

### 3. Инструменты, разрешения, режимы

- [ ] Tool-кадры → `tool.start`/`tool.result`; имя инструмента как у сервера; неизвестный вид — карточка с сырым именем, не падение.
- [ ] Разрешения по контракту спайка (app-server-запрос или эквивалент): `permission.request` → `respondPermission`; `bypassPermissions` при `allowBypassPermissions` отвечает сам; без флага — режим `default`. Если транспорт без интерактивных разрешений — только режимы, честная запись в отчёт и README.
- [ ] `setMode` по таблице спайка (`plan`→`plan`, `default`/`acceptEdits`→`build`/`edit`, `bypassPermissions`→`yolo` под флагом); отказ сервера — нефатальный `error`.
- [ ] Вопросы агента, если спайк их видел → `question.request`; не видел — флаг не поднимать.
- [ ] Тесты фейка: tool, allow/deny, interrupt при висящем разрешении, смена режима. `TZ=UTC npm run check` зелёный.

**Готово, когда:** фейк проходит сценарии, маппер — фикстуру этапа 1; новых `AgentEvent` нет.

### 4. История

- [ ] `listSessions(dir)` фильтром по cwd; источник — способ из отчёта (метод app-server / хранилище сессий CLI). Нет — пустой список и один `warn`, без чтения `~/.zcode` напрямую.
- [ ] `loadHistory` → `AgentEvent`; `live: true` не закрывает последний ход; нет данных — пустая история, не ошибка.
- [ ] `renameSession` — метод из отчёта или тихий no-op; `accountInfo` — поля, которые реально отдаёт CLI (план/usage), без выдумок; нет — `{}`.
- [ ] Фикстура без путей и текстов владельца; тесты на временной папке и фикстуре. `TZ=UTC npm run check` зелёный.

**Готово, когда:** тест ленты `turn.start` + текст + `turn.result` из фикстуры; падение списка не роняет `SessionsService`.

### 5. Подключение к чату

- [ ] Фабрика `zcodeAdapter`/`zcodeEngine` в `chatPanel.ts`; `adapterOf`/`engineOf`; `warm()` нет.
- [ ] `sessionsService`: пятый extra-провайдер, тихая проба локатора, ошибка не стирает чужие списки.
- [ ] Меню движка, пустой экран, сайдбар, `/new zcode`, `task.newChat`, строки en/ru, метка `Z`, `providerNames`, limitsHidden. Страница «Движок»: путь к бинарнику/бандлу, пункт `defaultProvider`, подпись «ваш вход ZCode».
- [ ] Карточки разрешений/вопросов идут в сессию адаптера; режим `bypassPermissions` без `allowBypassPermissions` контроллер понижает.
- [ ] README.md / README.ru.md: раздел ZCode — вход приложением, что CLI-сессии появятся в истории, чего в v1 нет. CHANGELOG — одна запись.
- [ ] `TZ=UTC npm run check` зелёный; `npm run test:integration`, если задет протокол webview.

**Готово, когда:** check зелёный; `rg` по `src` не находит мест, где `zcode` молча получает адаптер/флаги Claude, кроме явного дефолта. Ручной сценарий владельца: пустая вкладка → ZCode → pong → правка файла с разрешением → Stop → повтор из сайдбара.

## Промты исполнителей

Общее: репозиторий `/Users/fost/Projects/Agentura`, ветка этапа уже создана. Галочки в `docs/roadmap/33-zcode-support.md` — после команды из «Готово, когда». Чужие незакоммиченные файлы не трогать; дерево грязное (WIP 31) — стоп и отчёт для этапов 2+. Не коммитить, не пушить. Не писать и не удалять ничего в `~/.zcode` и `~/.claude`; изоляция прогонов — `ZCODE_*` env во временные каталоги. Работающее десктоп-приложение ZCode не трогать (не убивать процесс). README.md — английский, README.ru.md — русский.

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-1-zcode-spike. Задача: живой прогон ZCode CLI и app-server, главный вопрос — вход аккаунтом без API-ключа; go/no-go. Кода адаптера нет.

Читай: docs/roadmap/33-zcode-support.md (разделы «Контекст» и этап 1); репозиторий https://github.com/zai-org/ZCode — README.en.md и apps/zcode-cli/docs/usage/ (02-cli-reference, 05-permissions, 06-sessions, 13-automation; доки на китайском — источник истины исходники). docs/spikes/cursor-acp/report.md — эталон формы отчёта.
Правила репо: AGENTS.md.

Точки входа: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs (+ packages, node-runtime рядом); node в системе (проверь версию); репо ZCode для сборки — клонируй в /tmp с --depth 1, коммит зафиксируй.
Внимание: десктоп ZCode сейчас работает — его процесс не трогать, состояние ~/.zcode не удалять и не перезаписывать; форматные эксперименты — с ZCODE_DATA_BASE_DIR/ZCODE_SESSION_DB_PATH во временной папке; тест входа против реального ~/.zcode — короткий -p прогон, только чтение чужого, ничего не чистить.

Уже решено, не переспрашивать: сначала запуск бандла приложения без сборки, сборка — только если бандл не живой; -p не транспорт вкладки (это решает app-server-часть спайка); ключи/токены в репо не писать; чего не увидели — «не видели».

Порядок:
1. Бандл: node zcode.cjs --version / doctor --json / -p pong (изолированный ZCODE_DATA_BASE_DIR).
2. Вход: тот же прогон против реального ~/.zcode — уходит ли через аккаунт подписки; что просит без входа.
3. stream-json-сценарии этапа 1 (режимы guarded/build/yolo, правка файла, resume, сессии, модели, attach).
4. app-server: исходники (запуск, кадры) + живой pong; вердикт транспорта.
5. Фикстуры test/fixtures/zcode/, отчёт docs/spikes/zcode-cli/report.md с таблицей решений, go/stop. Галочки этапа 1.
DoD: отчёт кончается go или stop; при go — фикстуры, транспорт выбран, вход подтверждён или честно опровергнут. Проверка: rg -n "Bearer|api_key|apiKey|token" test/fixtures/zcode docs/spikes/zcode-cli пусто по секретам.

Не делать: src/, UI, настройки, удаление/правку ~/.zcode, выдуманные флаги CLI (запрещённые перечислены в доке 02).

Не коммитить, не пушить.
Последним сообщением — отчёт: go или stop / как запустился / вход / транспорт / файлы / чего не увидели. Отчёт — единственное, что увидит приёмка.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-2-zcode-provider. Задача: адаптер zcode на транспорте из отчёта: текстовый ход и Stop, без UI.

Читай: docs/roadmap/33-zcode-support.md этап 2 и «Принятые решения»; docs/spikes/zcode-cli/report.md (таблица — контракт); src/agent/codex/ (клиент долгого процесса, очередь, interrupt, dispose); src/agent/cursor/ (executable-резолвер с опознанием бинарника).
Правила репо: AGENTS.md.
Точки входа: src/agent/types.ts AgentProvider; src/settings.ts PROVIDERS; src/extension/engineLocator.ts; package.json agentura.codexExecutable рядом.

Уже решено, не переспрашивать: отчёт не go — стоп. Транспорт — из отчёта (app-server или -p+resume), не смешивать. Новых AgentEvent нет. Окружение сессии — env процесса, ZCODE_* для изоляции тестов. UI не подключать. Картинки/файлы в send — по контракту из отчёта, нет контракта — warn и дроп.

Порядок: провайдер/настройка → executable → protocol/client → adapter+mapper → фейк и тесты → smoke opt-in → TZ=UTC npm run check.
DoD: TZ=UTC npm run check зелёный; тесты src/agent/zcode/ есть; вкладка без zcode — Claude. Длинный лог в файл, в отчёт хвост и ошибки.

Не делать: sessionsService, меню, README, разбор tool/permission (этап 3), ~/.zcode.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-3-zcode-tools. Задача: tool, разрешения, режимы и вопросы до уже существующих AgentEvent.

Читай: docs/roadmap/33-zcode-support.md этап 3; docs/spikes/zcode-cli/report.md (таблица); src/agent/types.ts (tool.*, permission.request, question.request, setMode); src/agent/codex/adapter.ts — эталон ответа на server request.
Правила репо: AGENTS.md.
Точки входа: src/agent/zcode/adapter.ts, src/agent/zcode/mapper.ts.

Уже решено, не переспрашивать: формы ответов — из отчёта, не из памяти модели. bypass без allowBypassPermissions не автоотвечает. Маппинг режимов — из таблицы; отказ смены режима — нефатальный error. Нет интерактивных разрешений в транспорте — честные режимы, без карточек, флаг questions не поднимать без живого кадра. Новых AgentEvent нет.

Порядок: маппер tool → разрешения → вопросы (если есть) → setMode → тесты фейка → TZ=UTC npm run check.
DoD: check зелёный; фейк покрывает tool, allow/deny (или честное отсутствие), interrupt при висящем запросе, смену режима.

Не делать: webview, ~/.zcode, MCP-тумблеры, субагентов.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано / отклонения / не проверено / открытые вопросы.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-4-zcode-history. Задача: listSessions, loadHistory, renameSession, accountInfo — только источник из отчёта спайка.

Читай: docs/roadmap/33-zcode-support.md этап 4; docs/spikes/zcode-cli/report.md; src/agent/types.ts SessionInfo, SessionHistory, AccountInfo; src/agent/antigravity/storage.ts — эталон мягкого отказа.
Правила репо: AGENTS.md.
Точки входа: src/agent/zcode/adapter.ts.

Уже решено, не переспрашивать: источник — строго из отчёта; нет — пустой список и один warn. ~/.zcode напрямую не читать. rename без метода — no-op. accountInfo — только реальные поля. live: true не закрывает последний ход.

Порядок: список по cwd → loadHistory → rename/accountInfo → фикстуры и тесты → TZ=UTC npm run check.
DoD: check зелёный; тест ленты turn.start+текст+turn.result из фикстуры; падение списка переживает extra-провайдер.

Не делать: sessionsService (этап 5), парсеры недокументированных баз наугад.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано / отклонения / не проверено / открытые вопросы.
```

### Этап 5

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-5-zcode-ui. Задача: пустая вкладка запускает ZCode тем же контроллером; флаги прячут то, чего нет.

Читай: docs/roadmap/33-zcode-support.md этап 5 и «Принятые решения»; src/agent/features.ts; src/extension/chatPanel.ts (createChatServices, adapterOf); src/extension/sessionsService.ts (ExtraProvider); как cursor подключён в chatSurface/taskCommands; src/webview/strings.ts / strings.en.ts.
Правила репо: AGENTS.md.

Уже решено, не переспрашивать: warm() нет. Пятый extra-провайдер не роняет список. Новых страниц настроек нет. README: вход — приложение ZCode, CLI-сессии в истории приложения; чего в v1 нет — прямо. CHANGELOG одна запись, версия не выдумана.

Порядок: фабрика/adapterOf → providerFeatures → sessionsService → строки/меню/настройки → README/CHANGELOG → TZ=UTC npm run check (+test:integration при правке протокола).
DoD: check зелёный; rg по src — zcode нигде молча не получает адаптер/флаги Claude кроме явного дефолта adapterOf; список найденных мест в отчёте.

Не делать: лимиты подписки наугад, Remote Control, живой прогон в check.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано / отклонения / не проверено / открытые вопросы.
```

## Риски и открытые вопросы

- **Главный риск:** вход десктопа может не переиспользоваться standalone-CLI (oauth привязан к приложению). Спайк отвечает первым; при провале — возврат к roadmap 32 (эндпоинт + ключ Coding Plan), артефакты 32 уже есть.
- Нет готового дистрибутива CLI: сборка требует точных версий Node 24.14/pnpm 10.33; бандл приложения может не заработать standalone. Доки предупреждают: одного `zcode.cjs` мало.
- app-server документирован только исходниками — контракт меняется с версиями ZCode; в отчёте фиксируется коммит, резолвер проверяет совместимую версию.
- Конфликт процессов с работающим десктоп-приложением (общий `~/.zcode`, БД сессий): тесты и smoke — изолированные `ZCODE_*` каталоги.
- Модели без `--model`: меню моделей может быть статичным до появления конфигурационного способа.
- stream-json ZCode — свой формат (не Claude/Codex): маппер пишется по фикстуре, полей Claude не приписывать.
- WIP roadmap 31: этапы 2+ стартуют на чистом дереве; общие файлы — этапы 2 и 5.
- Windows: как у остальных движков, живьём не проверяем.
- Ручная проверка владельцем после этапа 5: pong, разрешение на правку, Stop, повтор из сайдбара, отсутствие бинарника/входа.

## Порядок работы

1 → 2 → 3 → 4 → 5, один репозиторий, этап в своей ветке `stage-N-zcode-*`. Этап 2 не начинается без `go`. Этапы 2 и 5 — после закрытия WIP 31. Приёмка — сверка diff с этапом и DoD; дефекты — исполнителю этапа. Коммит и push — только по явному разрешению владельца.
