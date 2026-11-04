# 28 — Codex: паритет возможностей с Claude

> Статус: roadmap закрыт, этапы 1–8 приняты; релиз 0.20.0 проверен и готов к публикации · 2026-11-04.
> Продолжение реализации не требуется. Разрешённые пользователем commit/push, CI и GitHub Release выполняются после итоговой приёмки.

### Приёмка релизного пакета 0.20.0

- Release metadata: version package/lock 0.20.0, зависимости не менялись, CHANGELOG и примеры установки обновлены. Исполнитель `/root/release_020_metadata`, requested model gpt-6.1-sol/high, fork_turns none; runtime model/effort независимо unknown. Cwd подтверждён командой исполнителя.
- Первая приёмка упаковки выявила локальные .playwright-mcp артефакты внутри VSIX. Исполнитель добавил исключение .vscodeignore. Повторная сборка и проверка состава PASS: 3226 файлов, 6.95 MB, версия 0.20.0, нет локальных tool artifacts/logs.
- `npm run package` и `node scripts/vsix-verify.mjs agentura-0.20.0.vsix`: PASS; загрузка extension.js и зависимостей из распакованного пакета проверена. Логи `/tmp/agentura-release-{package,vsix-verify}.log`.
- `VSCODE_TEST_VERSION=1.140.0 npm run test:integration`: PASS (реальный VS Code с изолированным профилем), лог `/tmp/agentura-release-integration.log`. `git diff --check`: PASS.
- Релиз принят основным чатом. Commit/push/tag/GitHub Release авторизованы пользователем, публикация после зелёного CI релизного коммита.

### Итоговая приёмка этапа 5 и roadmap

- Пользователь согласовал независимые native planning, approval и sandbox; режим plan/default не имитирует Claude approval. Этапы 1–8 приняты основным чатом после чтения кода и проверки DoD.
- Приёмка этапа 5: первая проверка выявила неточность текста про временные каталоги; тот же исполнитель исправил её. Повторная приёмка: код осей настроек, host validation, notification-before-ack, очередь, Stop/close/timeout, resume/reload и plan text проверены; замечаний нет.
- Основной чат выполнил `npm run check`: 2196 tests/151 files, types/lint/build PASS (`/tmp/agentura-stage5-parent-check.log`); `npm run codex:protocol` PASS (`/tmp/agentura-stage5-parent-protocol.log`); `git diff --check` PASS. Исполнитель: 262 targeted tests/9 files PASS.
- Native smoke без turn/start: ephemeral thread с readOnly/on-request, plan/default сохраняют права; approval и sandbox updates независимы. PASS `/tmp/agentura-native-settings-smoke.log`. В проверочном скрипте исправлено ожидание асинхронного settings notification после RPC response; код продукта не требовал исправлений. Модельных ходов/Jira writes не было.
- Requested executor configuration: `/root/stage_5_native_planning`, model `gpt-6.1-sol`, reasoning_effort `high`, fork_turns `none`. Runtime model/effort исполнителя независимо не раскрыты (`unknown`). Основной чат runtime gpt-6-astra; high подтверждён пользователем. Cwd `/Users/fost/Projects/Agentura` подтверждён командой.
- Пользователь разрешил commit/push/release. Изменения ещё не закоммичены. Следующий шаг: release metadata 0.20.0, VSIX verification и CI; live model сценарии остаются ручным checklist, не препятствуют выпуску проверенного скоупа.

### Предыдущие checkpoints (история, заменены итоговой приёмкой)

### Финальный checkpoint текущего запуска

- Новый запуск: пользователь подтвердил основной чат `astra/high` и разрешил закрыть roadmap, выполнить проверки, commit/push и релиз. Это снимает предыдущие блокеры по UX и подтверждению конфигурации.
- Основной чат: runtime-инструкция сообщает `gpt-6-astra`; effort runtime не раскрыт (`unknown`), источник подтверждения high — явное сообщение пользователя текущего чата. Cwd подтверждён `pwd`: `/Users/fost/Projects/Agentura`.
- Этап 5: requested tool configuration `spawn_agent(task_name="stage_5_native_planning", model="gpt-6.1-sol", reasoning_effort="high", fork_turns="none")`; возвращён id `/root/stage_5_native_planning`. Это параметры запроса, независимые runtime model/effort исполнителя пока `unknown`. Приёмка нового решения ещё не проводилась; основной чат сам проверяет diff и DoD, реализацию не пишет.

- Продолжение: пользователь разрешил отдельный native planning без Claude approval и независимое переключение разрешений. Продуктовый блокер этапа 5 снят. До реализации требуется подтверждение настройки основного чата `gpt-6-astra/high` по обновлённому `~/.codex/skills/roadmap-run/SKILL.md`: модель указана в runtime-инструкции, effort runtime не раскрыт, пользовательского подтверждения пока нет. Новые попытки приёмки не запускались; следующий шаг после подтверждения — новый исполнитель `gpt-6.1-sol/high`, `fork_turns: none`, затем самостоятельная итоговая приёмка основным чатом.

- Приняты 1–4, 6–8; этап 5 частичен, единственный остаток — продуктовый UX native planning/permissions. Отсутствие native plan approval нельзя исправить поддельным callback или Claude ExitPlanMode.
- Реализованные policy read-only/host guards проверены; switching/planning не включены. Следующий шаг: выбрать отдельный режим planning без approval-карточки либо согласовать собственный review flow; отдельно определить независимые переключатели approval/sandbox.
- Приёмка: этап 6 — 139 tests/6 файлов, typecheck/lint/protocol; этап 7 + часть 5 — 299/11; итоговый check — 2179/151 и build. Финальные проверки зелёные; этап 5 остановлен по скоупу, не по тестам. До финального прогона исправлена типизация sessionId в новом guard-тесте.
- Cwd `/Users/fost/Projects/Agentura`, branch main. Модель gpt-6-astra, effort не переключался. Исполнители последовательно владели кодом, параллельных записей не было. Изменения всех этапов остаются незакоммиченными, push/релиз/внешние Jira-записи не выполнялись.
- Runtime доказан только handshake/model-list. Compact, skill invocation и Jira write покрыты автоматическими тестами, живые модельные ходы не запускались. Ручной checklist в docs/codex-protocol.md и этапе 8.

### Checkpoint передачи после этапа 4

- Этап 4 принят. `skills/list {cwds:[cwd],forceReload:true}` получает enabled metadata при запросе capabilities; сбой возвращает пустой список и warning, без подмены session.init. В slash menu сохраняются одноимённые скиллы с разными путями; путь виден в описании. MCP UI показывает список и открывает точный SKILL.md.
- `CommandOption.skillPath`, опциональный `send.skill` и четвёртый аргумент `AgentSession.send` несут явный выбор. Composer учитывает provider/session и имя выбранного токена; явный скилл /plan не попадает в локальную команду. Ручной текст /имя сам по себе не создаёт native skill input.
- Host перед отправкой/открытием повторно читает capabilities, проверяет совпадение имени и пути, текущую сессию и реальный файл. Существующая проверка realpath допускает symlink только на SKILL.md. Codex не ищет `.claude/skills`. Claude путь сохранён.
- Invocation events не синтезируются. Доступный/выбранный скилл не означает вызванный; counters остаются основаны на событиях. Автообновления меню по `skills/changed` нет: capabilities перечитываются при штатном обновлении/reload чата, отправка и открытие всегда перепроверяют список.
- Приёмка: первый targeted прогон 154/155, старое ожидание `skills:false` обновлено. В ходе разработки исправлены ошибки типов optional ref и локального имени path. Повторная приёмка: typecheck exit 0; 183 tests/8 files (`/tmp/agentura-stage4-final.log`); дополнительно 41 DOM tests (`/tmp/agentura-stage4-dom.log`) и 31 provider-controller tests (`/tmp/agentura-stage4-host.log`). Targeted ESLint включая тесты, protocol и diff-check exit 0.
- Новые тесты: duplicate skill names; exact native payload; collision /plan; forged identity rejected; exact metadata path opened/sent; removed SKILL.md rejected. Существующие symlink/Claude/plugin и MCP tests прошли. Live model/skill smoke не запускался.
- Cwd `/Users/fost/Projects/Agentura`, branch main; исполнитель `/root/finish_roadmap`, унаследованная gpt-6-astra без переключения модели. Все изменения этапов 1–4 незакоммичены; внешних записей/push нет.
- Handoff: этапы 5–8 не начаты. Этап 5 требует прочитать `ThreadSettingsUpdateParams`, `TurnStartParams.collaborationMode` и `CollaborationMode` в `/tmp/agentura-codex166-experimental`. Native planning существует, native approval карточки нет; не выдумывать ExitPlanMode. Этап 6: dynamicTools регистрируются при thread/start; resume не содержит их — разобрать регистрацию/доступность при resume до включения capability. Этап 7: per-server MCP update отсутствует, сохранить reload-all; browser toggle у живого чата объяснять через новый чат. Полный `npm run check` остаётся этапу 8.

### Checkpoint передачи после этапа 3

- Этап 3 принят после исправлений: compact доступен только при существующем idle thread; запрос блокирует очередь до turn/completed, duplicate/active-turn отклоняется. Ошибка RPC снимает индикатор, timeout закрывает неопределённую сессию. Stop адресуется compact turnId; если ID ещё не пришёл, сессия закрывается вместо ложной отмены.
- Введён `autoCompact` отдельно от `compact`: Codex получает ручное действие без порогов Claude. Usage продолжает проходить через существующий mapper; окно не придумывается.
- Общий Stop доступен при compaction даже вне пользовательского хода. StreamTail сохраняет pending compaction для reload webview, completion/close снимают его.
- Приёмка: первый targeted прогон выявил устаревшие DOM ожидания и гонку Escape→Enter в тесте. Исправлено. Дополнительная проверка выявила guard-регрессию Claude transcript без current session; guard скорректирован до окончательной приёмки.
- Итоговые проверки: typecheck exit 0; 235 тестов/9 файлов (`/tmp/agentura-stage3-tests.log`), затем расширенная проверка controller/reseed — 272 теста/6 файлов (`/tmp/agentura-stage3-final.log`); после UI Stop — 40 engine DOM тестов (`/tmp/agentura-stage3-stop-ui.log`). Targeted ESLint, `git diff --check` и `npm run codex:protocol` exit 0.
- Живой compact с ходом модели не запускался: проверены fake app-server lifecycle и DOM, не реальная модель. Ручной сценарий: existing Codex thread → compact → Stop/повтор → следующее сообщение; reload во время compact.
- Cwd `/Users/fost/Projects/Agentura`, branch main, исполнитель `/root/execute_roadmap` (унаследованная gpt-6-astra, без переключения модели). Все изменения остаются незакоммиченными, публикации/внешних записей нет.
- Передача внутри текущего запуска: этапы 4–8 не начаты; следующий исполнитель проверяет git status и продолжает этап 4. Схема CLI 0.166.0 с experimental полями в `/tmp/agentura-codex166-experimental`.
- Для этапа 4: `skills/list` → metadata path/enabled; `turn/start.input` type skill; не связывать идентичность с именем и не выдумывать invocation. Для этапа 5 native planning mode есть, approval карточки нет — нужна отдельная продуктовая граница. Для этапа 6 dynamicTools регистрируются при thread/start; resume не имеет этого поля. Для этапа 7 нет локального MCP toggle/update в проверенной схеме.

### Приёмка этапа 2

- Раздельные agentStop/agentTranscript flags: Claude true, Codex/Antigravity false. Общие модели скрывают действия во всех видах; отдельный граф получает flags в snapshot. Host отвергает unsupported/stale stop/transcript. Stop основного хода остаётся доступен.
- Попытка 1: новые controller tests содержали ошибку имени harness (`t.c`); исправлена на `t.controller`.
- Попытка 2: typecheck, 190 тестов в 8 файлах, targeted eslint прошли. Логи `/tmp/agentura-stage2-{typecheck,tests,lint}.log`.
- Проверены capabilities, provider controller, Codex adapter, agentViews/agentsView, graph DOM, engine DOM, graph link. Ручные визуальные проверки не выполнялись; list/tree/lanes/cards и граф покрыты общими моделями и DOM тестом графа.
- Код и roadmap не закоммичены. Единственный исполнитель `/root/execute_roadmap`, модель унаследована gpt-6-astra; cwd `/Users/fost/Projects/Agentura`. Следующий шаг — этап 3.

### Продолжение запуска 2026-11-04

- Исправлен smoke: через существующий injectable `spawn` сохраняются ChildProcess только этого запуска; после dispose проверяются их `exitCode`/`signalCode`. Глобальный `pgrep` удалён. Существующая проверка handshake сохранена.
- Повторный smoke без `--turn`: exit 0, получены 8 моделей, собственный процесс завершён. Лог `/tmp/agentura-roadmap28-smoke-retry.log`.
- `npm run codex:protocol -- --keep`: exit 0, CLI 0.166.0. Схема `/var/folders/pm/np84rpk11bgglwd6205zlyq80000gn/T/codex-proto-ngHQU5`; лог `/tmp/agentura-roadmap28-schema.log`.
- `node --check scripts/codex-smoke.mjs` и `git diff --check`: exit 0.
- Матрица контрактов и приёмка этапа 1 ещё не завершены. Следующий шаг: прочитать generated типы request/response/notifications для всех возможностей этапов 2–7, записать ограничения и отдельно schema-only/live доказательства.
- Работа выполнена текущей моделью gpt-6-astra в `/Users/fost/Projects/Agentura`, без делегирования. Ветка main; изменён smoke и неотслеживаемый roadmap, без коммита/push. Точка продолжения сохранена для следующего запуска; этапы 2–8 не начаты.

### Точка остановки запуска 2026-11-04

- Ветка `main`; при входе уже изменён `scripts/codex-smoke.mjs`, этот roadmap ещё не отслеживается git. Имеющиеся изменения скрипта сохранены без правок.
- Локальные инструкции и README прочитаны; `CLAUDE.md` отсутствует.
- `codex --version`: `codex-cli 0.166.0`.
- `npm run codex:protocol`: exit 0. Лог: `/tmp/agentura-roadmap28-protocol.log`. Это сверка текущего списка контрактов, не подтверждение новых API этапов 2–7.
- `node scripts/codex-smoke.mjs` без `--turn`: exit 1. Handshake/model-list успешны (8 моделей); финальная проверка нашла три процесса app-server. Лог: `/tmp/agentura-roadmap28-smoke.log`.
- Smoke ищет все процессы `app-server --listen stdio://` через `pgrep`, без привязки к собственному PID и без исходного снимка. Утечка именно этого запуска не доказана; чужие процессы не завершались.
- Стоп по правилу красных обязательных проверок. Матрица новых контрактов не выполнена, этап 1 не принят, этапы 2–8 не запускались. Ходов модели и внешних записей не было.
- Следующий запуск: проверить lifecycle собственного процесса smoke, исключить чужие процессы из критерия утечки, повторить smoke; затем продолжить этап 1. Не объявлять этап принятым только по успешному model/list.

## Цель и границы

Закрыть пробелы интеграции Codex в Agentura: рабочие действия вместо заглушек, ручная компакция,
скиллы, управление сессией и инструменты Jira. Сохранить общий UI и поведение Claude/Antigravity.
Паритет означает одинаково полезные возможности, а не копирование терминов и механизмов Claude.

Выполнение разрешено явным вызовом roadmap-run; этапы проходятся последовательно до завершения или реального стоп-условия.
Рабочая папка: `/Users/fost/Projects/Agentura`. Правила: `AGENTS.md`, `.codex/WORKFLOW.md`, README;
`CLAUDE.md` на момент разведки отсутствует. Старые roadmap 15, 17, 19, 21, 22 — контекст, не текущий контракт.

Не входят: переписывание адаптеров, новый дизайн чата, собственный движок оркестрации, глобальная правка
`~/.codex/config.toml`, миграция пользовательских сессий, релиз/установка/коммит/push.
Remote Control, извлечение PDF и расчёт цены по внешним тарифам не реализовать без отдельного решения о скоупе.
Внешние Jira-записи не выполнять при проверках без явной авторизации; использовать подмену `TaskTools`.

## Подтверждённое состояние

Проверено чтением текущего кода 2026-11-04:

| Область | Факт и точка входа |
| --- | --- |
| Основа Codex | Streaming, Stop текущего хода, очередь, история/rename, модель/effort, approvals, вопросы, картинки уже есть: `src/agent/codex/adapter.ts`, `approvals.ts`, `history.ts`. |
| Компакция | `compact()` возвращает `false`, но `thread/compact/start` уже типизирован в `src/agent/codex/protocol.ts` и проверяется `scripts/codex-protocol.mjs`. |
| Управление | `setMode`, `decidePlan`, `stopTask` — заглушки. `capabilities()` возвращает `commands: []`. |
| Субагенты | Живой mapper выдаёт `agent.start/progress/end`; отдельного `agentTranscript` у CodexAdapter нет. Общий UI строит Stop по `taskId`, обработчик вызывает пустой `stopTask`. |
| Скиллы | `CODEX_FEATURES.skills = false`; `UserInput` уже содержит `skill`. `src/extension/skillFiles.ts` ищет только `.claude/skills`; контроллер открывает скилл по имени. |
| MCP/браузер | Уже подключены, включая статус MCP и reload всех серверов. Reconnect одного сервера и toggle скрыты. `setBrowser` для живой сессии у Codex не реализован. |
| Jira | `chatController.ts` передаёт `taskTools` только Claude; MCP-обёртка находится в `src/agent/claude/jiraMcp.ts`. |
| Файлы | Текстовые файлы контроллер вставляет в промпт через `buildPrompt`; PDF не отправляются. Флаг `files: false` означает отсутствие document-блоков, а не отсутствие текстовых вложений. |
| Метрики | Живой mapper читает input/output/cache usage; цена скрыта. История подставляет неизвестное usage нулями. Лимиты подписки уже есть отдельно от `cost`. |
| Diff | `src/agent/codex/patch.ts` восстанавливает стороны фрагментов из hunk; это не полные версии файла. |
| Документация | README и комментарии местами устарели: нельзя брать их список ограничений за факт протокола. |

Базовая проверка предыдущей разведки: 122 теста, 5 файлов прошли:
`features.test.ts`, Codex `adapter.test.ts`, `history.test.ts`, `mapper.test.ts`, `chatControllerProvider.test.ts`.
Это unit-проверка интеграции, не живое подтверждение возможностей CLI.

## Решения

- Сначала проверить установленный CLI и его схему. Версия `0.160.0` в коде — зафиксированная база, а не гарантия актуальности.
- Наличие метода в схеме не равно работающему сценарию; capability включать после сквозной реализации и проверки.
- Не связывать permission policy, sandbox и planning одним переключателем Claude. Не повышать права при выходе из плана.
- Все изменения по этапам выполнять последовательно: пересекаются `types.ts`, `features.ts`, адаптер, mapper и контроллер.
- Неподдерживаемое действие скрывать или явно объяснять. Успешный no-op недопустим.
- Не сканировать `.codex` ради выдуманного списка возможностей. Использовать API установленного движка; безопасный путь к SKILL.md брать из подтверждённых метаданных.
- Не делать обязательные живые ходы скрыто: они расходуют лимит и могут выполнять инструменты. Приёмка фиксирует отдельно unit, протокол и opt-in smoke.
- Неподтверждённые API ниже — предмет этапа 1, а не готовые контракты реализации.

## Матрица контрактов этапа 1 — CLI 0.166.0

Сверены обычная схема и `codex app-server generate-ts --experimental --out /tmp/agentura-codex166-experimental`.
Обычная генерация скрывает experimental поля; отсутствие в ней dynamicTools или collaborationMode не является отсутствием API.
Все строки ниже **schema-only**, кроме явно отмеченного handshake. Ошибки методов: JSON-RPC error (code/message/data), timeout/закрытие транспорта; точные runtime сообщения и сценарии отказа без вызова не установлены.

| Возможность | Request, параметры и результат | Notifications и область действия / выбранный маршрут |
| --- | --- | --- |
| Handshake | initialize + model/list через текущий adapter: live, 8 моделей; smoke exit 0 | Без turn/start; собственный процесс завершился. Лог `/tmp/agentura-roadmap28-current-smoke.log`. |
| Compact | thread/compact/start `{threadId}` → `{}` | item/started и item/completed с ThreadItem.type=contextCompaction, turn lifecycle и error. Пустой RPC result означает принятие запроса, не завершение сжатия. Отдельный текущий thread; очередь сериализовать. Live compact не запускался. |
| Skills | skills/list `{cwds?: string[], forceReload?: boolean}` → `{data: [{cwd, skills, errors}]}`. SkillMetadata: name, description, path, scope, enabled, pluginId | skills/changed; ошибки чтения также в entry.errors. Выбор через turn/start.input `{type:'skill', name, path}`. Уникальность по path, не имени. Наличие списка/выбора не доказывает invocation. |
| Planning | experimental collaborationMode/list; turn/start.collaborationMode или thread/settings/update.collaborationMode = `{mode, settings:{model, reasoning_effort, developer_instructions}}` | item/plan/delta, ThreadItem.plan, turn/plan/updated — данные плана, не approval. Отдельного native запроса принять/отклонить план в ServerRequest нет. Полный lifecycle карточки требует продуктового решения; prompt-only замену не делать. |
| Разрешения | thread/start `{approvalPolicy, sandbox}`; turn/start `{approvalPolicy, sandboxPolicy}`; experimental thread/settings/update `{threadId, approvalPolicy?, sandboxPolicy?}` → `{}` | thread/settings/updated. Фактические значения возвращаются thread/start/resume. Политика и sandbox независимы от planning; не менять глобальный config. Методы существуют, UI переключения отдельно принимать по этапу 5. |
| Дочерние треды | thread/read `{threadId, includeTurns?}` → thread; turn/interrupt `{threadId, turnId}` → `{}` | collabAgentToolCall.receiverThreadIds и subAgentActivity.agentThreadId дают ID треда. Схема не доказывает доступ к активному child через текущий клиент и не даёт его текущий turnId в collab state. Без live доказательства hide stop/transcript в этапе 2; не выдавать summary за transcript. Это ограничение интеграции, не утверждение отсутствия API. |
| Jira host tools | experimental thread/start.dynamicTools: `[{type:'function', name, description, inputSchema, deferLoading?}]`; server request item/tool/call `{threadId, turnId, callId, namespace, tool, arguments}` → `{contentItems, success}` | Выбран host-handled dynamic tools. Регистрация при создании треда, resume не имеет dynamicTools в проверенной схеме. Ошибки бизнес-операции возвращать success:false, не повторять запись. Секреты остаются в TaskTools хоста. Живой tool callback не проверен. |
| MCP | config/mcpServer/reload без параметров; mcpServerStatus/list с пагинацией | Пересоздание всех MCP текущего app-server; отдельного reconnect/toggle в ClientRequest нет. config/value/write существует, но глобальная запись не допустима ради локального toggle. Сохранить reload-all. |
| Browser | thread/settings/update не содержит MCP-конфига; thread/start.config есть, текущий adapter запускает MCP через аргументы процесса | Без подтверждённого локального runtime update изменение browser.enabled требует нового чата. Активный ход не перезапускать. |

Приёмка этапа 1: текущая попытка 1 успешна; предыдущий smoke-блокер исправлен в предыдущем запуске.
`npm run codex:protocol` exit 0 (`/tmp/agentura-roadmap28-current-protocol.log`), smoke exit 0, `git diff --check` exit 0.
Сопоставлены обязательные точки входа и generated request/response types; схема только во временных каталогах.
Этапы 2–7 реализуют только доказанный маршрут; schema-only строки не объявлены live проверкой.

## Этапы

### 1. Проверить протокол и зафиксировать маршруты реализации

- [x] Проверить git status/ветку и локальные инструкции; сохранить чужие изменения.
- [x] Получить версию установленного `codex`, выполнить `npm run codex:protocol`; схему оставить только во временном каталоге.
- [x] Сверить методы/поля для compact, списка/запуска скиллов, planning, session approval/sandbox, управления дочерним тредом, dynamic tools, MCP reconnect/toggle и изменения браузера.
- [x] Для каждого записать прямо в этом файле: версия, точный request/notification, параметры, результат, ошибка, ограничение области действия, schema-only или проверено живьём.
- [x] Выполнить безопасный handshake и чтение capabilities без хода модели; расширять `scripts/codex-smoke.mjs` только при необходимости.
- [x] Зафиксировать выбранный транспорт Jira: предпочтительно host-handled dynamic tools, если протокол подтверждает регистрацию и обратные вызовы. Не подменять его внешним сервером с токенами.

**Файлы:** этот roadmap, `docs/codex-protocol.md`, при необходимости `scripts/codex-smoke.mjs`.
`protocol.ts` и `scripts/codex-protocol.mjs` расширять только подтверждёнными контрактами в соответствующем этапе.

**Готово, когда:** у этапов 2–7 есть проверенный маршрут или точное ограничение. Нет утверждений «Codex не умеет» только на основании отсутствия метода в адаптере.
**Проверки:** `codex --version`, `npm run codex:protocol`, `node scripts/codex-smoke.mjs` без `--turn`.
**Риски/ручная проверка:** несовместимая версия или login; schema-only возможности явно пометить, не обещать их пользователю.
**Исполнение:** одна сессия, последовательно; зависимостей нет.

### 2. Убрать неработающие действия субагентов

- [x] Разделить отображение субагентов и возможности stop/transcript минимальными флагами; обновить все provider literals и проверки.
- [x] Протянуть возможности в обычные представления агентов и отдельную карту: `agentsView.ts`, `components/AgentViews.tsx`, `AgentGroup.tsx`, `SidePanes.tsx`, `AgentsGraph.tsx`, `webview/agentsGraph/` и `extension/agentsGraph*`.
- [x] Если этап 1 подтвердил управление дочерним тредом, реализовать остановку нужного агента без остановки родителя/соседей. Иначе скрыть Stop у Codex.
- [x] Не показывать открытие транскрипта, пока его чтение не реализовано; если чтение доступно, использовать отдельный подтверждённый путь, не выдавать summary за транскрипт.
- [x] Защитить host-обработчики от старых сообщений webview: неподдерживаемое действие не завершается мнимым успехом.

**Контракты:** `ProviderFeatures`, `AgentSession.stopTask`, опциональный `AgentAdapter.agentTranscript`, `agent.stop`/`agent.transcript`; общий Stop хода не меняется.
**Готово, когда:** у Codex нет кнопок, которые молча ничего не делают; Claude сохраняет stop/transcript. Поддержанный stop действует только на выбранного агента.
**Проверки:** targeted тесты capabilities, контроллера, адаптера, `agentsView` и `agentsGraphDom`; тесты ошибочного/stale taskId и всех провайдеров.
**Риски/ручная проверка:** посмотреть list/tree/lanes/cards и отдельную карту на активном агенте; не запускать браузер ради этого автоматически.
**Исполнение:** после этапа 1, одна сессия, последовательно.

### 3. Ручная компакция Codex

- [x] Реализовать `thread/compact/start` и подтверждённый lifecycle → `compaction.start/end`; ошибка, Stop и закрытие сессии снимают индикатор.
- [x] Определить поведение при активном ходе: не запускать конкурирующую компакцию; повторное нажатие не дублирует запрос.
- [x] Отделить ручной `compact` от порогов/автосжатия Claude в `store.ts` и HUD. Включение кнопки не должно назначать Codex пороги 120k/150k или окно 200k.
- [x] Подключить `/compact` и существующие кнопки. До создания треда действие недоступно или даёт понятный результат; неизвестное окно остаётся неизвестным.
- [x] Проверить обновление usage после сжатия, продолжение очереди и восстановление UI после reload.

**Файлы:** `agent/codex/{adapter,mapper,protocol}.ts`, `agent/{types,features}.ts`, `extension/chatController.ts`, `webview/{store,hudState}.ts`, `components/Composer.tsx`; соответствующие тесты.
**Готово, когда:** ручное сжатие работает сквозным запросом; индикатор не зависает; обычная очередь и Claude auto-compact не регрессируют.
**Проверки:** adapter/mapper, provider controller, HUD/store/composer тесты; `npm run codex:protocol`. Opt-in smoke: сжать существующий тестовый тред и продолжить сообщение.
**Риски/ручная проверка:** timeout не считать успешной компакцией; старый клиент не должен получить чужие пороги.
**Исполнение:** после этапа 2, последовательно.

### 4. Скиллы Codex в общем UI

- [x] Получать список скиллов подтверждённым API; поддержать одинаковые имена из разных источников без выбора случайного файла.
- [x] Протянуть список и безопасные метаданные в существующие slash-menu/MCP skills UI. При необходимости добавить обновление списка, а не подделывать повторный `session.init`.
- [x] Передавать явный выбор скилла структурированным `UserInput.skill`, если это подтверждено этапом 1; текст `/имя` не считать эквивалентом без проверки.
- [x] Сделать поиск/открытие SKILL.md зависимым от провайдера и метаданных; не искать Codex-скилл в `.claude/skills`.
- [x] Различать «доступен», «выбран» и «вызван»: не синтезировать факт вызова без события движка.
- [x] Обработать отсутствующий файл, симлинк, смену провайдера, повторное имя и недоступный API.

**Файлы:** Codex adapter/protocol/mapper, `agent/types.ts`, `shared/{protocol,skills}.ts`, `extension/{chatController,skillFiles}.ts` и wiring `findSkill` (найти поиском), `webview/components/{Composer,McpRows}.tsx`, `mcpFeed.ts`.
**Готово, когда:** список, явный выбор и открытие правильного SKILL.md работают у Codex; Claude plugin names и ссылки не меняются; флаг включён только для реализованного поведения.
**Проверки:** protocol, adapter, skillFiles, provider controller, MCP store/feed и composer tests. Opt-in smoke выбранного безопасного скилла.
**Риски/ручная проверка:** отсутствующее событие вызова отражается как ограничение наблюдаемости, а не выдуманная skill-полоска.
**Исполнение:** после этапа 3, последовательно.

### 5. Planning и настройки разрешений сессии

- [x] По результату этапа 1 выбрать native planning contract; отделить planning от sandbox/approval policy.
- [x] Показать фактическую политику и независимые переключатели approval/sandbox текущей сессии; глобальный конфиг не редактировать.
- [x] По согласованному UX реализовать native plan/default отдельно от разрешений; план показывать текстом, без поддельных действий Claude approval.
- [x] Не выдавать обычный текст `plan` за запрос принятия; не отправлять Claude `ExitPlanMode` в Codex.
- [x] Native режим подтверждён и подключён; prompt-only имитация и Claude ExitPlanMode не используются.
- [x] Проверить сохранение прав при смене planning, pending approvals, resume и следующий ход; права не расширяются автоматически.

**Файлы:** Codex adapter/protocol/mapper/approvals, `agent/{features,types}.ts`, `shared/protocol.ts`, controller, composer и существующие plan cards (найти по `plan.request`).
**Готово, когда:** доступные настройки/планирование работают по доказанному контракту либо отсутствующая возможность явно зафиксирована без заглушек. Все переходы сохраняют sandbox и approval policy.
**Проверки:** adapter/approvals/controller и DOM тесты режимов/карточек; deny/refine/Stop/close; protocol. Opt-in smoke только на тестовой папке с ограниченными правами.
**Риски/ручная проверка:** отсутствие нативного запроса принятия не исправлять собственным протоколом без пересмотра скоупа.
**Исполнение:** после этапа 4, последовательно.

**Факт этапа 5:** отдельные native controls, API thread/settings/update и turn/start.collaborationMode, план как текст. Полные effective policy сохраняются, чужие/stale сообщения отвергаются, timeout закрывает неопределённую сессию. Scope blocker снят явным решением пользователя. Проверки и runtime smoke — в итоговой приёмке выше.

### 6. Jira-инструменты Codex через существующий хост

- [x] Прочитать `agent/claude/jiraMcp.ts`, `shared/jiraTools.ts`, `TaskTools` и реальный permission path из `extension/jira/`; переиспользовать бизнес-логику и правила разрешений.
- [x] Реализовать подтверждённую регистрацию host tools и ответы на tool requests; при отсутствии транспорта остановить именно эту возможность и записать отдельное решение, не строить обход с секретами.
- [x] Передавать Codex `TaskTools` и только разрешённые `comment/transition/worklog`; без задачи или при отключении инструменты недоступны.
- [x] Сохранить текущие правила: короткий безопасный comment текущей задачи допускается существующей политикой; transition/worklog, другие задачи и чувствительные комментарии требуют карточки, в том числе при permissive режиме.
- [x] Защитить bind/unbind, смену issue/instance и настроек при pending request; сверять цель перед записью, не переносить согласие на другую задачу.
- [x] Обрабатывать ошибку/отмену/повтор request без двойной записи; метрики worklog не заполнять выдуманным usage восстановленной истории.

**Файлы:** `agent/codex/{adapter,protocol,approvals,tools}.ts`, новый локальный модуль host tools только при необходимости, `extension/chatController.ts`, `agent/types.ts`, существующие Jira host-модули.
**Готово, когда:** три инструмента сквозным образом доходят до подменённого `TaskTools`; ограничения и карточки равны текущей политике Claude; токены Jira остаются в хосте.
**Проверки:** новые Codex host-tool tests + controller/provider + `shared/jiraTools.test.ts` + существующие Claude Jira tests; rebind, denial, retry, close и ошибки записи обязательны.
**Риски/ручная проверка:** unit-проверки без реальной записи в Jira; живой write smoke только отдельным разрешённым действием.
**Исполнение:** после этапа 5, последовательно.

**Приёмка этапа 6 (2026-11-04):** реализованный путь новых тредов принят; live Jira/модель не запускались.

- `thread/start.dynamicTools` получает только текущие разрешённые инструменты; `initialize.experimentalApi=true`. `item/tool/call` маршрутизируется в host-owned broker → `TaskTools.run`, ответы `{contentItems:[{type:'inputText',text}],success}`.
- Короткие безопасные комментарии текущей задачи допускаются до 3 за 10 минут (политика Claude); остальные записи всегда одноразовой карточкой. `allow-always` не расширяет права. Подмена issue, thread/turn, повтор callId, Stop/close и allow→Stop до microtask проверены.
- Регистрация привязана к snapshot spec с устойчивым instanceId, а не только отображаемым именем. Любое уведомление изменения набора инвалидирует регистрацию и отменяет pending, в том числе перепривязка туда-обратно. Повторная проверка непосредственно перед `TaskTools.run`.
- Ограничение: у `thread/resume` нет подтверждённой регистрации dynamicTools. Resumed callbacks отклоняются; после resume или смены задачи/настроек для Jira нужен новый чат. Никаких перезапусков или подделки метода обновления. Это ограничение интеграции, не отсутствие API Codex вообще.
- Worklog не принимает model-provided aiTokens; новый чат использует только tally фактических live событий хоста. Resumed Jira запрещена, неизвестная восстановленная статистика не пишется.
- Проверки: `npm run typecheck`, `npm run codex:protocol`, targeted ESLint, `git diff --check` — exit 0; 139 tests/6 files (Codex broker+adapter, controller provider, host AgentJiraTools, shared Jira rules, Claude Jira MCP). Логи `/tmp/agentura-stage6-{types,protocol,lint,tests}.log`. В ходе разработки исправлены обязательное поле handshake и совместимость тестового findLast; финальная приёмка зелёная.
- Pending: live tool callback и фактическая доступность сохранённых tools после resume не проверены; расширять resume только после доказанного контракта. Изменения не коммитились.

### 7. MCP, браузер и честные метрики

- [x] Реализовать reconnect/toggle одного MCP только при подтверждённой безопасной области действия. Иначе оставить reload-all и задокументировать различие.
- [x] Проверить смену `agentura.browser.enabled` у уже открытой Codex-сессии; использовать native update либо явно показывать необходимость нового чата. Не перезапускать активный ход молча.
- [x] Отделить UI token/cache usage от цены там, где один `cost` скрывает доступные данные. Показывать только реальные счётчики, без cache TTL и USD из воздуха.
- [x] Для восстановленной истории сохранить «неизвестно» вместо выдачи нулей за измерение; расширение общих типов — только в реально используемых местах.
- [x] Не менять уже работающие account/rateLimits и не прятать лимиты из-за отсутствия цены.

**Файлы:** `agent/features.ts`, Codex adapter/mapper/history, MCP rows/store, `webview/{store,hudState,chatState}.ts`, browser settings wiring (найти по `setBrowser`).
**Готово, когда:** все видимые действия выполнимы и имеют понятную область действия; токены, кэш, стоимость и лимиты не подменяют друг друга; неизвестные данные так и обозначены.
**Проверки:** MCP adapter/store/view tests, browser adapter/controller tests, mapper/history/HUD tests; повторить Claude/Antigravity capability tests.
**Риски/ручная проверка:** не писать глобальные MCP-настройки и не отключать серверы других чатов ради локального переключателя.
**Исполнение:** после этапа 6, последовательно; MCP и метрики принимать раздельными проверками внутри этапа.

**Приёмка этапа 7:** первая итоговая попытка зелёная. MCP reload-all и скрытые per-server действия подтверждены текущими capabilities/tests; browser setting уже явно сообщает «Codex from a new chat» (RU/EN), runtime процесс не перезапускается. Live in/out/cacheRead показаны в итогах независимо от cost; лимиты sidebar сохранены. История теперь явно несёт `usageKnown:false`, reducer не отображает placeholder как измерение. Cache TTL и USD не добавлены.
**Проверки этапов 5 (реализованная часть) и 7:** 299 tests/11 files (`/tmp/agentura-stage57-tests.log`), typecheck; mapper/history assertions и DOM read-only policy. Живые turns не запускались.

### 8. Документация, ограничения и итоговая приёмка

- [x] Обновить README.md, README.ru.md и `docs/codex-protocol.md` по факту реализации; устранить ложные утверждения об отсутствии API compact и текстовых вложений.
- [x] Зафиксировать остатки отдельной таблицей: PDF/document input, полные снимки diff, восстановленные метрики, транскрипты, Remote Control. Для каждого: причина, проверенная версия, обход и нужен ли новый продуктовый скоуп.
- [x] Полный diff не восстанавливать чтением текущего файла задним числом: он мог измениться пользователем. При отсутствии достоверного snapshot оставить честный fragment diff.
- [x] Сверить все новые capabilities со всеми provider literals, меню, отдельной картой, restored webview и host guards; найти оставшиеся Codex no-op и устаревшие комментарии.
- [x] Выполнить `npm run check` и `npm run codex:protocol`; длинный вывод сохранить в `/tmp`. Обязательные ошибки исправить или зафиксировать реальный blocker, не объявлять приёмку успешной.
- [x] Записать версии, команды/результаты, непроверенные live-сценарии и ручной чеклист. Не отмечать live-проверку по unit-фикстуре.

**Готово, когда:** поддержанное поведение доказано проверками, недоступные действия не торчат пустыми кнопками, ограничения описаны точно. Совместимость Claude/Antigravity проверена.
**Ручной чеклист:** новая/resume Codex-сессия; очередь и Stop; compact → продолжение; выбор/открытие скилла; plan при наличии; агенты и карта; MCP/browser; текст/картинка и явный отказ PDF; лимиты/usage; Claude контрольная сессия.
**Исполнение:** после этапов 1–7, последовательно. Отложенный пункт не означает реализованную фичу; ограничения принимаются отдельно от результата реализации.

**Итоговая приёмка этапа 8:** README RU/EN и protocol docs обновлены, таблица ограничений и ручной чеклист записаны. Полный `npm run check` exit 0 (2179 tests/151 files, typecheck/lint/build), лог `/tmp/agentura-roadmap28-final-check.log`; `npm run codex:protocol` exit 0, `/tmp/agentura-roadmap28-final-protocol.log`; `git diff --check` exit 0. После первого полного check добавлены host guards mode/plan; ошибку типов теста исправили, финальный полный прогон зелёный. Этап 8 принимает фактическую реализацию и документацию, не закрывает pending этапа 5.

## Промпты исполнителя

Общий контракт для каждого промпта: работать в `/Users/fost/Projects/Agentura`; прочитать `AGENTS.md`,
`.codex/WORKFLOW.md`, README и `docs/roadmap/28-codex-parity.md`. Взять только указанный этап, сначала доказать
путь кодом. Выполнить его чекбоксы, DoD и проверки буквально; обновить roadmap только по факту.
Не трогать чужие изменения, не коммитить/push/публиковать. Отчёт: сделано, проверки, отклонения, непроверенное.

### Этап 1

```text
Выполни этап 1 roadmap 28 в /Users/fost/Projects/Agentura по общему контракту выше.
Точки входа: src/agent/codex/{protocol,adapter}.ts, scripts/codex-{protocol,smoke}.mjs.
Нужна матрица точных контрактов установленного CLI для этапов 2–7. Не писать реализацию фич.
Не запускать --turn и внешние записи. Схема не является доказательством live-поведения.
```

### Этап 2

```text
Выполни этап 2 roadmap 28 по общему контракту. Прочитай результат этапа 1.
Точки входа: CodexSession.stopTask, ChatController agent.stop/agent.transcript,
src/webview/agentsView.ts, компоненты агентов и отдельный agentsGraph.
Убери no-op действия; реальный stop/transcript добавляй только по подтверждённому контракту.
DoD и проверки — дословно из этапа 2. Claude и общий Stop хода сохранить.
```

### Этап 3

```text
Выполни этап 3 roadmap 28 по общему контракту. Точки входа: thread/compact/start,
CodexSession.compact, CodexEventMapper, store.ts, hudState.ts, Composer.tsx.
Доведи native compact до рабочего UI; раздели ручное сжатие и пороги автосжатия Claude.
Не назначай Codex окно/пороги Claude. Проверь очередь, повторное нажатие, error/Stop/close.
DoD и проверки — дословно из этапа 3.
```

### Этап 4

```text
Выполни этап 4 roadmap 28 по общему контракту. Точки входа: capabilities(), UserInput.skill,
skillFiles.ts и wiring findSkill, postSkillFiles/openSkill, Composer.tsx и McpRows.tsx.
Переиспользуй UI, реализуй список, структурированный выбор и открытие правильного SKILL.md.
Не выдумывай invocation events. DoD и проверки — дословно из этапа 4.
```

### Этап 5

```text
Выполни этап 5 roadmap 28 по общему контракту и матрице этапа 1.
Точки входа: setMode/decidePlan, approvals.ts, plan.request, ModeMenu/Composer.
Разделяй planning, approval и sandbox; не повышай права и не правь глобальный конфиг.
Без native контракта не имитируй план промптом. DoD и проверки — дословно из этапа 5.
```

### Этап 6

```text
Выполни этап 6 roadmap 28 по общему контракту. Сначала прочитай TaskTools, shared/jiraTools.ts,
claude/jiraMcp.ts и host permission path в extension/jira; затем контракт Codex из этапа 1.
Реализуй host tools через подтверждённый транспорт; сохраняй политику разрешений и rebind guards.
Тестируй с подменой TaskTools, не пиши в настоящую Jira. DoD и проверки — дословно из этапа 6.
```

### Этап 7

```text
Выполни этап 7 roadmap 28 по общему контракту. Точки входа: Codex MCP методы и browserConfigArgs,
ProviderFeatures, mapper/history usage, store/HUD и MCP UI.
Поддерживай только подтверждённые действия с явной областью; не пиши глобальный конфиг.
Неизвестные стоимость/TTL/исторический usage не заменяй выдуманными числами.
DoD и проверки — дословно из этапа 7.
```

### Этап 8

```text
Выполни этап 8 roadmap 28 по общему контракту. Сверь реализацию этапов 1–7 с их DoD.
Обнови оба README, протокол и таблицу оставшихся различий. Выполни npm run check и
npm run codex:protocol, вывод в /tmp. Не выдавай schema/unit за live smoke.
Дай короткий ручной чеклист и точный остаток. Не расширяй скоуп на PDF, Remote Control или цены.
```

## Риски и порядок продолжения

- Порядок: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Автоматических параллельных агентов этот план не требует.
- Нет API — это ограничение конкретной возможности, не причина бросить остальные независимые возможности.
  Записать остаток, продолжить доступное. Реальную смену скоупа вынести владельцу.
- Новый UI использует существующие элементы; если потребуется новая продуктовая схема интерфейса, сначала согласовать её, не придумывать в ходе реализации.
- Протокол experimental: обновление версии не должно молча включать capability, ломать resume или менять права.
- При обязательных красных проверках, второй неудачной приёмке, конфликте с чужими изменениями или необходимости внешней публикации — остановиться и сообщить конкретный blocker.
- PDF, Remote Control, полные snapshots и цены после этого roadmap остаются отдельными задачами, пока не доказан безопасный native путь в его границах.
