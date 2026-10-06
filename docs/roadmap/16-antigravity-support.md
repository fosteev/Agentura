# 16 — Antigravity (Gemini) как третий движок

> **Статус:** этап 5 принят 2026-10-06 с хвостами: беседы agy в сайдбаре — после этапа 5 Codex в main; мерж `feature/gemini-support` → main и релизный vsix — владелец. Автопилот `/roadmap-run` в worktree
> `/Users/fost/Projects/Agentura-gemini`, ветки `stage-<N>-agy-<slug>` от `feature/gemini-support`,
> мерж в `feature/gemini-support`; в main — после этапа 4. Ручные проверки и решения —
> `16-antigravity-support.pending.md`.

## Почему Antigravity, а не Gemini CLI / свой агентский цикл

Первое ТЗ (Gemini, «вариант 3», ветка `archive/gemini-variant3`) предлагало свой агентский цикл
поверх `@google/genai` с самописными bash/read/write/grep. Отклонено: посылка «у Google нет
CLI-агента с машинным протоколом» неверна, и своя реализация дороже и слабее готовой.

Проверено 2026-10-06:
- **Gemini CLI 0.62** (`gemini --acp`, протокол ACP) — полноценный протокол, но вход через
  Google-аккаунт (`oauth-personal`) сервер отклоняет: «This client is no longer supported for
  Gemini Code Assist for individuals… migrate to Antigravity». Работает только с API-ключом
  AI Studio (платно). Отложено; заметки — `spikes/antigravity-probe/acp/report.md`.
- **Antigravity CLI `agy` 1.2.17** — работает с логином владельца и его квотой (Gemini 3.x,
  а также Claude/GPT внутри agy). Headless-режим как у Claude Code: stream-json на stdin/stdout.
  **Выбран владельцем.**

Протокол снят живыми прогонами: `spikes/antigravity-probe/report.md` (главный справочник,
читать первым) и сырые логи рядом (`*.log`, `tr_perm3.jsonl`, `trfull_perm3.jsonl`). Папка
`spikes/antigravity-probe/` не коммитится (`.git/info/exclude`) — в ней пути машины.

## Ключевые факты протокола agy (кратко; детали — report.md)

- Запуск: `agy -p= --input-format stream-json --output-format stream-json --model <id>
  [--conversation <id>] [--mode accept-edits|plan | --dangerously-skip-permissions]`.
  `-p=` с пустым значением обязательно (голый `-p` съедает следующий флаг). Без `--model` может
  висеть — всегда передавать. Уровень — часть id модели (`gemini-3.8-flash-low`); `--effort`
  с такими id конфликтует.
- Вход: строка `{"event":"user","message":{"role":"user","content":"…" | [{type:"text",…}]}}`.
  Ошибка декодирования фатальна (ERROR result + exit 1). Строки во время хода ставятся в очередь.
  Процесс живёт между ходами; закрытие stdin — доиграть ход и выйти 0.
- Выход: `init` (≈2.2 с после старта, до ввода; `conversation_id`, `model`, `cwd`, `tools`),
  `step_update` (`step_index`, `state` ACTIVE|DONE|ERROR, `step_type`
  user_input|agent_response|tool|system_message, `text_delta`, `usage` на DONE, `tool_name`,
  `tool_info{name,parameters,output?,error?}`), `result` (на ход; `usage`/`duration_seconds`/
  `num_turns` **накопительные** за процесс, `denied_actions`, `status` SUCCESS|ERROR, `error`).
- Thinking-текста нет (только `thinking_tokens`). Текст стримится только у финального шага
  ответа; промежуточные шаги приходят одним DONE без текста.
- **Подтверждений по каждому действию нет.** Без флагов всё, что требует разрешения,
  авто-отклоняется (шаг tool → ERROR, `denied_actions` в result), ход продолжается.
  `--mode accept-edits` разрешает правки файлов, но не `run_command`;
  `--dangerously-skip-permissions` — всё.
- **Прерывание — только SIGINT**: result ERROR `interrupted`, процесс выходит (код 1). Дочерний
  `run_command` переживает убийство (переподвешен к pid 1, своя группа) — потомков собирать
  и убивать явно. Продолжение — новый процесс с `--conversation <id>` (история сохранена).
- Диффов в стриме нет. Полные аргументы и unified diff (`[diff_block_start]…[diff_block_end]`)
  — в `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
- История: `brain/<id>/.system_generated/logs/transcript.jsonl` (читаемо, по шагу на строку);
  список по воркспейсу — `conversation_summaries.db` (SQLite, копировать с `-wal`), у headless
  `title` пустой, `preview` = первый запрос. `conversations/<id>.db` — protobuf, не трогать.
- Квоты в стриме нет; `agy -p "/usage"` печатает остаток недельной квоты по семействам.
- **Хранилище agy недокументировано** — всё, что читаем с диска, изолировать в одном модуле
  (`storage.ts`) с версией agy в шапке и мягкой деградацией (нет файла/формат сменился →
  пустая история, лог, не ошибка).

## Решения оркестратора (2026-10-06)

- **Провайдер `antigravity`**, в UI «Antigravity» (модели внутри — Gemini и не только).
  Код — `src/agent/antigravity/`. Настройка `agentura.antigravityExecutable` (machine-scope),
  `agentura.defaultProvider` получает значение `antigravity`.
- **Процесс на сессию**, долгоживущий, ходы — строками в stdin. Смена модели или режима, Stop —
  пересоздание процесса с `--conversation` (лениво, к следующему `send`).
- **Режимы Agentura → agy:** `default` → без флагов (авто-отказ), `acceptEdits` →
  `--mode accept-edits`, `plan` → `--mode plan`, `bypassPermissions` → `--dangerously-skip-permissions`
  (только явным выбором пользователя, никогда по умолчанию). Отказ agy показывается в ленте
  карточкой «agy отклонил: <действие>» с кнопками «Разрешить правки и повторить» / «Разрешить всё
  и повторить» — пересоздание процесса в нужном режиме + сообщение-повтор. `[скоуп]` в pending,
  до этапа 4 не блокирует.
- **Usage за ход** — сумма `usage` шагов DONE этого хода (а не `result.usage`, он накопительный).
  Стоимость не считаем (подписка, цены неизвестны); HUD показывает токены и, позже, квоту `/usage`.
- **Общие файлы с Codex-автопилотом** (он параллельно идёт в `/Users/fost/Projects/Agentura`,
  этапы 3–6 roadmap 15): этапы 1–3 трогают только `src/agent/antigravity/`, `src/agent/types.ts`
  (union), настройки/locator и тесты. Подключение к чату (этап 4) — **только после того, как этап 3
  Codex (фабрика провайдеров, EngineMenu, флаги возможностей в `chat.info`) влит в main**: перед
  этапом 4 влить main в `feature/gemini-support` и встроиться в готовую фабрику, не делать свою.
- **Квота владельца по Gemini мала** (26% недельной на 2026-10-06): живые прогоны — минимум,
  только самая дешёвая модель (`gemini-3.8-flash-low`), короткие промты, фикстуры записывать
  один раз и переиспользовать. Справку можно спросить у самого agy (`agy -p "<вопрос>" --model
  gemini-3.8-flash-low`), но сверять с живым прогоном.

## Этапы

### 1. Основа и AgyAdapter: процесс, ход, поток текста, Stop

**Сессия:** sonnet.

- [x] `AgentProvider` += `'antigravity'`; `SessionRef`-маршрут (этап 1 Codex) принимает его.
      Настройки `agentura.antigravityExecutable` + значение в `agentura.defaultProvider`
      (`package.json`, `package.nls*.json`, `src/settings.ts`, `MACHINE_KEYS`). Locator — тот же
      обобщённый `EngineLocator` (`src/extension/engineLocator.ts`), бинарник `agy`, ошибки
      «agy не найден» отдельные. (Экземпляр локатора в `chatPanel.ts` — этап 4, см. «Решения».)
- [x] `src/agent/antigravity/protocol.ts` — типы событий agy 1.2.17 (вход/`init`/`step_update`/
      `result`) по report.md и логам; версия в шапке.
- [x] `src/agent/antigravity/process.ts` — spawn (`shell: false`, cwd сессии, env целиком),
      построчный NDJSON-парсер stdout с лимитом строки (64 МБ), stderr → `Logger.debug`
      (`AGY_ERROR:` — разбирать в `error`), сбор потомков (`ps -A -o pid=,ppid=` до kill) и kill
      дерева: SIGINT agy → grace → SIGKILL agy и всех собранных потомков.
- [x] `src/agent/antigravity/mapper.ts` — события → `AgentEvent`: `session.init` (из `init`),
      `turn.start`, `text.delta` (messageId по `step_index`), `tool.start`/`tool.result` по шагам
      tool (имя как есть, результат — `output`/`error.message`), `turn.result` (ok при SUCCESS,
      usage — сумма шагов хода), `error` + `session.closed` при смерти процесса. Пустые
      `text_delta` и хвостовой `"\n"` не плодят пустых сообщений.
- [x] `src/agent/antigravity/adapter.ts` — `AntigravityAdapter implements AgentAdapter`:
      `createSession`/`resumeSession` (`--conversation`), `send` (текст; картинки — пока нет,
      запись в «Решения»), очередь на стороне сессии (как Codex), `interrupt()` = SIGINT + kill
      дерева + `turn.result` interrupted, следующий `send` поднимает процесс с `--conversation`;
      `setModel`/`setMode` — пересоздание к следующему ходу; `capabilities()` — модели из
      `agy models` (кэш на процесс расширения). `listSessions`/`loadHistory`/`renameSession` —
      пусто/no-op (этап 3).
- [x] Фейковый agy для тестов (скрипт-бинарник или фейковый `RpcProcess`-подобный процесс по
      образцу `src/agent/codex/fakeServer.ts`): обычный ход, ход с tool, отказ, многоходовость
      в одном процессе, SIGINT, падение процесса, resume.
- [x] Живой smoke `scripts/agy-smoke.mjs` (opt-in, временная папка, `gemini-3.8-flash-low`,
      «ответь одним словом pong»); фикстура `test/fixtures/antigravity/` без путей и id машины;
      тест маппера по ней.
- [x] `npm run check` зелёный; Claude и Codex не изменились.

**Готово, когда:** адаптер проходит fake-тесты и тест по живой фикстуре; в UI не подключён. — выполнено 2026-10-06.

**Решения (2026-10-06, по итогам сессии 1):**

- **Раскладка** `src/agent/antigravity/`: `protocol.ts` (типы agy 1.2.17, `parseAgyLine`, `userInputLine`,
  `parseAgyError`), `process.ts` (`AgyProcess`: NDJSON-парсер с лимитом 64 МБ, stderr, `interrupt()`/`stop()`/
  `kill()`, сбор потомков через `ps -A -o pid=,ppid=` до сигнала), `mapper.ts` (`AgyEventMapper`),
  `adapter.ts` (`AntigravityAdapter` + сессия), `models.ts` (`agy models`, `DEFAULT_AGY_MODEL`),
  `executable.ts` (`resolveAgyExecutable`, `AGY_NOT_FOUND`), `fakeAgy.ts` (фейковый процесс, только тесты).
  Фикстуры `test/fixtures/antigravity/`: `ok-turn.json` — живая запись smoke (ход + resume в новом процессе),
  остальные (`multi-turn`, `denied`, `interrupted`, `resume`, `bad-model`) — очищенные логи спайка, `models.txt`.
  Smoke — `scripts/agy-smoke.mjs` (`--turn`, `--record <файл>`; модель зашита `gemini-3.8-flash-low`).
- **SessionRef-маршрут:** `AgentProvider` += `antigravity`; в `sessionMemory.ts`, `panelRouting.ts`,
  `extension.ts` (`openSession`) сравнения с `'claude'|'codex'` заменены на `isProvider` из `settings.ts`
  (минимальная правка трёх строк, поведение Claude/Codex то же). Настройки: `agentura.antigravityExecutable`
  (machine), `defaultProvider` += `antigravity`, `MACHINE_KEYS`, nls en/ru. UI настроек и выбор движка — этап 4/5.
- **Локатор:** переиспользован `EngineLocator` (резолвер `resolveAgyExecutable`, `name: 'agy'`,
  `notFound: AGY_NOT_FOUND`), протестирован. **Экземпляр в `chatPanel.ts`/`extension.ts` (прогрев) не создан** —
  это общие файлы с Codex-автопилотом; делается на этапе 4 вместе с фабрикой (`antigravityEngine` рядом с `codexEngine`).
- **Процесс:** поднимается сразу в конструкторе сессии (`init` приходит сам за ~2 с → id и модель до первого
  сообщения). Ходы — по одному: следующая строка уходит в stdin после `result` предыдущей (очередь у сессии,
  как у Codex; своя очередь agy не используется). `turn.start` открывается эхом `user_input` (промпт берётся из
  объявленного сессией), а если эха нет (неизвестная модель: сразу `result` ERROR) — по `result`.
- **Stop:** сбор потомков → SIGINT → ждём `close` до `graceMs` (2 с) → SIGKILL agy и всех собранных потомков
  (убиваем и после нормального выхода agy: `run_command` переживает его). Очередь сброшена, `turn.result
  interrupted`, незакрытые tool-карточки закрываются `tool.result` ошибкой `interrupted`. Сессия жива; процесс
  поднимается со следующим `send` с `--conversation <id>`. Повторный `init` второго процесса `session.init` не
  повторяет. Windows: SIGINT там не работает, дерево убивается `taskkill /T /F` — не проверено.
- **setModel/setMode** — процесс помечается устаревшим; к следующему ходу останавливается (stdin end → grace →
  kill) и поднимается заново с `--conversation`. `setMode` шлёт `mode.changed` сразу. `bypassPermissions` без
  `allowBypassPermissions` в опциях сессии молча понижается до `default` (с `warn` в журнал). `setEffort`
  только запоминается: у agy уровень — часть id модели, `--effort` с ним конфликтует.
- **Выход процесса:** во время хода без `result` (смерть) — `turn.result` ok=false с хвостом stderr + `error`
  fatal + `session.closed(exit)`. Простаивающий выход (например, код 1 после `result` ERROR) — не авария: ошибка
  уже в `turn.result.errors`, процесс поднимается к следующему ходу. Ошибка запуска (`ENOENT`) — fatal.
  `AGY_ERROR: {json}` из stderr → нефатальный `error` (поля `message|error|msg`, `code|type|status` — **формат
  не снят живьём**, разбор осторожный).
- **Маппер:** `messageId = agy-<step_index>`, `toolUseId = agy-<step_index>`; usage хода — сумма `usage` шагов
  DONE (не накопительный `result.usage`), `input = input_tokens − cache_read` (допущение по семантике Gemini; в
  прогонах кэш всегда 0), `thinking` — часть `output`; стоимость 0. Хвостовой/ведущий пробельный текст шага не
  даёт сообщения (держится, пока за ним не придёт текст). Дополнительно к плану эмитится `usage.message` (final)
  на каждый DONE шага ответа — для контекста в HUD; существующий вариант события, новых `AgentEvent` нет.
  `permissionDenials`: `denied_actions[i]` сопоставляется с i-м шагом tool с `permission check failed` (имена
  действия `write_file` и шага `write_to_file` не совпадают), иначе `toolUseId: ''` — этап 2.
- **Картинки и файлы** в `send` не отправляются (image-блоки не проверены, document-блоков нет): в журнал
  `warn`, в ленте их нет.
- **`capabilities()`**: `agy models` (execFile `models`, 20 с) один раз на адаптер; сбой/пусто не кэшируется.
  Модели без effort. `commands: []`, `contextUsage()` — `undefined` (окна контекста у agy нет).
- **Модель по умолчанию** (если не передана): `gemini-3.8-flash-medium` (`DEFAULT_AGY_MODEL`) — `[скоуп]`, см.
  pending; константа в одном месте. `--model` agy нужен всегда.
- **Не проверено:** Windows (`agy.exe`, taskkill); `AGY_ERROR` формат; семантика кэша в usage; image-блоки;
  живой Stop (SIGINT посреди инструмента проверен в спайке, в smoke — только на фейке и на реальном
  node-процессе с отдельной группой в `process.test.ts`); живая смена модели/режима (на фейке). Живой smoke
  потратил 2 коротких хода `gemini-3.8-flash-low` + `agy models`; диалоги остались в хранилище agy (мы его не
  трогаем).
- **Проверки:** `TZ=UTC npm run check` зелёный (1181 тест, из них 51 в `src/agent/antigravity/`). Два
  webview-теста (`composerLayouts`, `gitDom`) один раз упали по таймауту при параллельной нагрузке (идёт Codex-
  автопилот) и проходят отдельно и в повторном полном прогоне.

**Приёмка этапа 1 (2026-10-06, ревью Opus):** починено — (1) `send` сразу после `interrupted`-`result`, пока agy
ещё не вышел, писал в stdin умирающего процесса, и ход висел навсегда (выход «своего» остановленного процесса
игнорируется): теперь Stop держит `halting`, `ensureProc` ждёт его и не берёт процесс из `stopping`; (2) снимок
потомков не делается после выхода agy (pid мог достаться чужому процессу — убили бы чужое дерево), в т.ч. если agy
вышел, пока шёл `ps`; `stop()` снимает потомков до закрытия stdin; перед SIGKILL — второй снимок от уже снятых
потомков (внуки, порождённые за grace); (3) после `result` не-SUCCESS процесс помечается устаревшим — agy после
ERROR выходит, и сообщение из очереди уходило в умирающий процесс, а его выход закрывал сессию как аварию;
(4) `dispose` во время остановки под смену модели больше не запускает процесс-сироту; (5) `error` живого процесса
(не удался kill) больше не считается выходом; (6) id беседы берётся и из `step_update`/`result`, если `init` не
дошёл (Stop в первые ~2 с не теряет беседу). Тесты на все. Понижение `bypassPermissions` в адаптере совпадает с
гейтом контроллера (`chatController` `mode.set` и resume) — защита в глубину. **Известно, не чинили:** прерванный
ход недосчитывает usage (шаг без DONE не даёт токенов; `result.usage` накопительный) — HUD чуть занижен;
смерть agy посреди хода не добивает `run_command` (снимать потомков уже некогда); ошибка модели на старте до
ввода, если agy так делает, даст ход без промпта (косметика, не наблюдали).

### 2. Инструменты, правки и отказы

**Сессия:** sonnet.

- [x] Имена инструментов agy → привычные карточки ленты: `run_command` → Bash (команда из
      `CommandLine`, вывод), `write_to_file`/`replace_file_content` → Write/Edit, чтение/поиск —
      как Read/Grep/Glob, остальное — общая карточка. Таблица соответствия — в `mapper.ts`, по
      `tools` из `init` (60 имён) и логам.
- [x] Диффы правок: после DONE шага правки читать `transcript_full.jsonl` этой беседы
      (`storage.ts`, единственное место, знающее пути `~/.gemini/antigravity-cli`), брать
      аргументы и unified diff → `tool.result` с данными для DiffPreview/вкладки «изменения»
      (`editFiles`/`fileSpans`), если это ложится на существующие поля. Нет файла / не разобрали —
      карточка без диффа, без ошибки.
- [x] Отказы: шаг tool ERROR с `user denied permission` + `result.denied_actions` → событие для
      карточки отказа (если нужен новый вариант `AgentEvent` — минимальный, записать в
      «Решения»). Метод сессии «повторить с режимом X»: пересоздать процесс в режиме и отправить
      служебный повтор. UI карточки — этап 4.
- [x] Режимы (см. «Решения оркестратора») на spawn; `mode.changed` при смене. (Флаги `modeArgs`, пересоздание
      процесса и `mode.changed` уже сделаны на этапе 1; здесь — только повтор после отказа и тесты.)
- [x] Тесты по фейку: правка с диффом, правка без транскрипта, отказ → повтор в accept-edits,
      bypass не включается сам. `npm run check` зелёный.

**Решения (2026-10-06, по итогам сессии 2):**

- **Раскладка.** `tools.ts` (таблица agy → карточка, чистая), `patch.ts` (unified diff → ханки `structuredPatch`),
  `storage.ts` (единственное чтение `~/.gemini/antigravity-cli`: путь корня — параметр, версия agy 1.2.17 в шапке,
  `transcript_full.jsonl`, мягкая деградация, лимит 32 МБ, id беседы валидируется до подстановки в путь),
  `edits.ts` (транскрипт → `tool.result.result`), правки `mapper.ts`/`adapter.ts`. Фикстуры:
  `test/fixtures/antigravity/transcript_full.jsonl` (запись правки/создания/команды, спайк perm3) и
  `transcript_full_multiline.jsonl` (многострочная правка, снята в этой сессии), пути и id очищены.
- **Таблица инструментов.** `run_command`→`Bash` {command, description←toolSummary, cwd}; `write_to_file`→`Write`;
  `replace_file_content`→`Edit`; `multi_replace_file_content`→`MultiEdit`; `view_file`→`Read` {file_path←AbsolutePath};
  `grep_search`→`Grep`; `find_by_name`→`Glob`; `read_url_content`→`WebFetch`; `search_web`→`WebSearch`;
  `notebook_edit`→`NotebookEdit`; остальное (`list_dir`, `sed_file`, `send_command_input`, browser_*…) — имя agy и
  сырые параметры (общая карточка). Форма входа — как у Claude, её понимают `toolView`/`editDiff`. **Живьём
  сверены** параметры `run_command`, `write_to_file`, `replace_file_content`, `view_file`; ключи
  `grep_search`/`find_by_name`/`read_url_content`/`search_web`/`notebook_edit` — по именам agy, модель в живом
  прогоне эти инструменты не выбрала (шла в `run_command`), поэтому — несколько кандидатов ключа, нет совпадения →
  общая карточка, не падение. Параметры в стриме короткие (у правок только `TargetFile`): `tool.start` не содержит
  old/new текста, они приходят в `tool.result`.
- **Диффы.** Шаг tool из стрима с индексом N = GENERIC-результат N в `transcript_full.jsonl`; вызов (полные
  аргументы) — в ближайшем выше PLANNER_RESPONSE с тем же именем и `TargetFile`. После DONE (не ERROR) шага
  `Write`/`Edit`/`MultiEdit` адаптер читает транскрипт и кладёт в `tool.result.result` форму `tool_use_result`
  Claude: `{filePath, oldString, newString, replaceAll?, structuredPatch}`, у `Write` — `{filePath, content,
  type: create|update}` (`update` — если в результате есть diff-блок). `originalFile` нет (agy отдаёт только ханки),
  поэтому `editStats` (`+N −M`) работает, а нативный дифф `appliedSides` — только для правок с одним
  фрагментом (old/new из аргументов); для `multi_replace` с несколькими кусками — только ханки/счётчики. Формат
  `ReplacementChunks` у multi_replace **не снят** (в живом прогоне модель вместо него вызвала
  `replace_file_content`): разбор — по догадке, при несовпадении остаются одни ханки.
  Транскрипт пишется не мгновенно — 3 повтора по 120 мс (`transcriptRetries`/
  `transcriptDelayMs`); не нашли — карточка без диффа, `tool.result` без `result`, без ошибки и без warn.
- **Порядок событий.** Подгрузка диффа асинхронна, поэтому у сессии появился «гейт» (`gated`/`inflight`/`tail`):
  пока читается транскрипт, следующие события agy и выход процесса ждут в хвосте. Без правок всё синхронно, как
  было. `interrupt` ждёт хвост до обнуления `proc` (иначе `result`, ждущий диффа, терялся бы).
- **Отказы: нового `AgentEvent` нет.** Карточке (этап 4) достаточно существующего: `tool.result` isError с текстом
  `permission check failed…` и `turn.result.permissionDenials` `{toolName, toolUseId}`. Изменение: `toolName` теперь
  имя карточки шага (`Bash`/`Write`/`Edit`), если отказы сопоставились с шагами по порядку, иначе `display_name`
  agy. Для кнопок: `Write`/`Edit`/`MultiEdit` → «разрешить правки» (acceptEdits) и «всё»; `Bash` и прочее → только
  «всё» (accept-edits `run_command` не разрешает; живьём: действие отказа `command`, display_name `RunCommand`).
- **Повтор.** `AgySession.retryWithMode('acceptEdits' | 'bypassPermissions')`: `setMode` (процесс пересоздаётся с
  `--conversation`, `mode.changed`) + служебное сообщение `AGY_RETRY_PROMPT` (англ.). Метод не в общем
  `AgentSession` (types.ts не трогал): тип `AgyRetrySession` и охранник `isAgySession(session)` экспортируются из
  `adapter.ts`, этап 4 зовёт его из кнопок. `bypassPermissions` без `allowBypassPermissions` → `false` (и warn), режим
  не меняется; отказ сам режим никогда не повышает (тесты).
- **`[скоуп]` Повтор без пузыря пользователя.** Служебное сообщение шлётся с `silent`: `turn.start` без `prompt`
  (как «ход начал движок»), в ленте нет реплики «Retry the denied actions». Обратимо: убрать `silent` в
  `retryWithMode`. Режим после «Разрешить правки и повторить» остаётся повышенным до смены пользователем (иначе
  следующая правка снова получила бы отказ) — поведение для пользователя, записано в pending.
- **Не проверено.** Живой прогон адаптера целиком (правка через `AntigravityAdapter` без фейка) не делался:
  транскрипт читается из реальной записи, но момент его дозаписи относительно DONE шага снят не был (отсюда
  повторы); `view_file` в стриме даёт `output` вида «4 lines, 24 bytes» (содержимого нет — карточка Read без
  текста); Write поверх существующего файла (есть ли diff-блок) не снимали; Windows. Живые прогоны сессии: 2 коротких
  хода `gemini-3.8-flash-low` во временной папке (разведка параметров и снятие многострочной правки), процессы за
  собой убраны.
- **Проверки:** `TZ=UTC npm run check` зелёный, 1210 тестов у исполнителя, 1217 после приёмки (+29 к этапу 1: patch, tools, storage/edits, адаптер).
- **Доводка на приёмке (2026-10-06, два прохода ревью):** подгрузка диффа ограничена общим таймаутом
  (`editTimeoutMs`, 2 с) — зависшее чтение (сетевой home, FIFO) не держит гейт и Stop; закрытие сессии обрывает
  повторы (`AbortSignal`); транскрипт — только обычный файл. Правка читает **хвост** транскрипта (окно 1 МБ, ×4 до
  32 МБ, если шага с вызовом в окне нет) — не весь файл на каждую правку. `findEditDetail` ищет вызов только в
  ближайшем PLANNER_RESPONSE (номер вызова = число GENERIC между ними), дальше назад не идёт; результат шага N без
  имени целевого файла — не наш (рассинхрон) → без диффа. `Write`: `type: create` только при «Created file…»,
  иначе `update` (перезапись не выдаётся за новый файл). `syntheticTurn` уважает `silent`. `retryWithMode` проверяет
  режим в рантайме и отказывает (false), если он не повышает текущий. `onAgyError`/переполнение строки идут через
  гейт. Тесты 1217.
- **Промты следующих этапов:** этап 3 — `loadHistory` пропускает tool_calls транскрипта через `mapAgyTool`
  (`tools.ts`), чтобы лента истории совпала с живой; результаты правок в истории — из GENERIC-шагов через
  `parseDiffBlocks`. Этап 4 — кнопки карточки отказа зовут `isAgySession(session) && session.retryWithMode(...)`;
  какие кнопки показывать — по `toolName` отказа (см. выше).

### 3. История: список, лента, resume, rename

**Сессия:** sonnet.

- [x] `listSessions(cwd)` — беседы этого воркспейса. Источник выбрать по факту (записать в
      «Решения»): `conversation_summaries.db` через `node:sqlite`, если он доступен в extension
      host VS Code (проверить, не только в тестовом Node); иначе — перебор
      `brain/*/.system_generated/logs/transcript.jsonl` с воркспейсом из метаданных; иначе —
      собственный индекс бесед, начатых в Agentura (`globalState`). Заголовок: `title` или
      `preview` (без обёртки `<USER_REQUEST>`).
- [x] `loadHistory` — `transcript.jsonl` → события ленты через тот же маппер (USER_INPUT →
      сообщение пользователя без `<USER_REQUEST>`/`<ADDITIONAL_METADATA>`, PLANNER_RESPONSE →
      текст и tool-вызовы, GENERIC → результаты).
- [x] `renameSession` — у agy нет API: своё имя в хранилище Agentura поверх `title`/`preview`.
      Файлы `~/.gemini` только читать, никогда не писать.
- [x] Тесты на фикстурах транскрипта и summaries (очищенных). `npm run check` зелёный.
- [ ] Пользователь: в живом VS Code открыть окно с папкой, где есть беседы agy, и убедиться, что (после этапа 4)
      список не пуст, лента открытой беседы читаема, `resume` продолжает диалог, имя после rename переживает перезапуск.

**Решения (2026-10-06, по итогам сессии 3):**

- **Источник списка: `conversation_summaries.db` через динамический `import('node:sqlite')` + запасной индекс.**
  Проверка: в VS Code 1.140 на этой машине Electron собран с Node 24.21 (строки в Electron Framework), `node:sqlite`
  там есть; но `engines.vscode` расширения — `^1.100.0` (Electron 34, Node 20.x, `node:sqlite` нет), плюс форки (Cursor и др.).
  Поэтому SQLite — предпочтительный путь, а не единственный: нет модуля/файла/схема другая → `undefined` и `debug`-строка,
  список берётся из **индекса Agentura** (`sessionIndex.ts`, `globalState`: id, папка, время, первое сообщение — только бесед,
  начатых или продолженных из Agentura). Перебор `brain/*/transcript.jsonl` отвергнут: воркспейс в транскрипте не записан
  (он только в `init` стрима и в базе). **Не проверено внутри живого extension host** (там `node:sqlite` печатает
  ExperimentalWarning в stderr и может быть выключен политикой сборки) — отсюда запасной путь, покрытый тестами.
  esbuild оставляет `await import("node:sqlite")` как есть (проверено на пробной сборке адаптера).
- **Чтение базы — по копии.** `conversation_summaries.db` (+`-wal`, `-shm`) копируется в `mkdtemp`, открывается там
  (оригинал agy держит с WAL и не трогаем), копия удаляется. Файл > 64 МБ не копируем. Все запросы — `SELECT`; логика
  путей — в `storage.ts` (единственный, кто знает схему; версия agy 1.2.17 в шапке). Выбираются только беседы
  с `parent_conversation_id = ''` и `step_count > 0` (подбеседы и пустые не нужны). Сверено на копии базы владельца
  (24 строки → 16 после фильтра, 11 воркспейсов, список по папке строится; содержимое в фикстуры/отчёт не попало).
- **Привязка к папке** — точное совпадение пути воркспейса беседы (`workspace_uris`, JSON-массив `file://`, у беседы их
  может быть несколько) с `cwd` чата: без слеша на конце, на Windows без регистра, плюс `realpath(cwd)` (macOS `/tmp`).
  Беседы из подпапок/родителей не показываем.
- **Заголовок**: свой (rename) → `title` agy → `preview` (без `<USER_REQUEST>`, одна строка, ≤200 символов) → id.
  У headless `title` пуст, поэтому обычно это `preview`. `SessionInfo.cwd` = папка запроса, `updatedAt` = `last_modified_time`
  (микросекунды отрезаны), `createdAt` — только если беседа есть в индексе.
- **`renameSession`** — только запись в хранилище Agentura (`AgySessionIndex.rename`, пустое имя снимает своё).
  Хранилище — подмножество `vscode.Memento` (`AgyStateStore`), конфиг адаптера `state`; **этап 4 передаёт
  `context.globalState`**, пока не передан — в памяти процесса (имена не переживают перезапуск). `~/.gemini` не пишется
  нигде (проверка: единственные операции — `copyFile` из него и `readFile`/`open 'r'`).
- **Индекс Agentura**: сессия адаптера пишет `{id, cwd, createdAt, updatedAt, firstPrompt}` при первом `send` новой беседы
  (или на `init`, если `send` был раньше) и на `init` продолженной (`firstPrompt` ≤300 символов, пишется один раз, у resume
  не пишется); открытая пустая вкладка в индекс не попадает. Лимит 500 записей (вытесняются старые); имена — отдельным
  ключом `agentura.antigravity.names` (≤200 символов), записи из `globalState` проверяются по типам. `[скоуп]` Текст первого сообщения хранится в `globalState` расширения — локально, как и сам agy у себя;
  обратимо: убрать `firstPrompt` из `note` (тогда заголовок запасного списка — id).
- **`loadHistory`** (`history.ts`, чистая `buildAgyHistory(steps)`, чтение — `readTranscriptHistory`: целиком до 32 МБ,
  больше — последние 32 МБ с первого целого хода, ранние ходы считаются по маркеру `"type":"USER_INPUT"` потоком и идут в
  `skippedTurns` → «N ранних ходов скрыто»): используется
  `transcript_full.jsonl` (типизированные аргументы), а не `transcript.jsonl`. Соответствие: USER_INPUT → `turn.start`
  (текст из `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`/`<USER_SETTINGS_CHANGE>` отброшены); PLANNER_RESPONSE →
  `usage.message` (по токенам шага, `tokenUsageOf`), `text.delta` (`agy-<индекс>`), `tool.start` на каждый вызов через
  `mapAgyTool`; GENERIC (n-й после planner = n-й вызов) → `tool.result` с id `agy-<индекс GENERIC>` — **тот же id, что у
  живого шага tool**; текст результата без шапки `Created At/Completed At`; ERROR → `isError` с `error`, отказ
  (`permission check failed`) → `permissionDenials` `{toolName: карточка, toolUseId}`; результаты правок — тот же разбор,
  что в живой ленте (`editResultFrom`, вынесен из `editResultOf`: ханки diff-блока, old/new, `type: create|update`).
  RUNNING (фоновая команда) — результат «запущено», не ошибка. SYSTEM_MESSAGE пропускается. Ход завершён, если
  последний шаг — PLANNER_RESPONSE без вызовов (если он `ERROR` — `ok:false, subtype:'error'`, текст в `errors`); иначе `turn.result` `ok:false, interrupted:true`, незакрытые инструменты —
  `interrupted` (как у живой ленты при Stop); при `live: true` последний незавершённый ход остаётся открытым, а вызов без
  результата получает id `agy-<planner+1+n>` — номер будущего шага tool, чтобы живое продолжение склеилось с карточкой.
  Длительность хода — по `created_at`; `apiDurationMs` 0, стоимость 0. Служебное сообщение повтора после отказа
  (`AGY_RETRY_PROMPT`) показывается ходом без пузыря (как в живой ленте, `silent`). `maxTurns` по умолчанию 200.
- **Что в истории не восстанавливается.** `thinking` (есть в `transcript_full`, но живой стрим его не отдаёт — лента
  должна совпадать с живой); режим разрешений и модель — в транскрипте их нет (только человекочитаемое «Gemini 3.8 Flash
  (Low)» в служебной вставке), `SessionHistory.mode/model` не заданы: при resume эти значения берутся из опций
  (`session.init` agy при `--conversation` модель всё равно передаём мы). `retryPoint`/`agentTranscript` для agy нет.
- **Resume** на уровне адаптера уже работает с этапа 1 (`resumeSession` → `--conversation <id>`, нумерация шагов
  сквозная); `loadHistory` + `resumeSession` дают то, что нужно этапу 4. Живого resume с реальной историей в этой сессии
  не гоняли (квота), только на фейке и на реальных транскриптах владельца (разбор 17 бесед без падений: 87 вызовов
  в самой длинной = 87 результатов, незавершённые ходы помечены interrupted).
- **Проверки:** `TZ=UTC npm run check` зелёный, 1234 теста у исполнителя, 1242 после приёмки.
- **Доводка на приёмке (2026-10-06, два прохода):** список из базы кэшируется по корню (размер+mtime базы и `-wal`; не
  менялась — без копирования, сайдбар обновляется часто), сбой чтения копии (checkpoint agy посреди копирования) отдаёт
  прошлый список, а не скачок к индексу; большой транскрипт — хвост с подсчётом скрытых ходов вместо пустой истории
  (`readTranscriptFull` заменён на `readTranscriptHistory`); пустая вкладка не засоряет индекс; имена отдельным ключом
  (запись индекса из другого окна их не затирает); битые значения `globalState` не роняют список; planner `ERROR` —
  ошибка хода; ход-призрак из одних служебных шагов не строится. Проверено: бандл esbuild с адаптером под Node 20 —
  `import('node:sqlite')` отклоняется, `listSessions` уходит в индекс без исключения.
- **Промты следующих этапов:** этап 4 — передать в конфиг `AntigravityAdapter` `state: context.globalState` и
  `agyRoot` не трогать; объединение бесед провайдеров в сайдбаре берёт `adapter.listSessions(cwd)` (возвращает
  `SessionInfo` без `gitBranch`/`fileSize`); `loadHistory(id, cwd, {live, maxTurns})` — `cwd` игнорируется (id глобален в
  `~/.gemini`).

### 4. Подключение к чату

**Сессия:** sonnet. **Блокер:** этап 3 Codex влит в main. Перед стартом:
`git merge main` в `feature/gemini-support`, конфликты — в пользу main.

- [x] Экземпляр `EngineLocator` для agy (`antigravityEngine` рядом с `codexEngine`, `resolveAgyExecutable`,
      `AGY_NOT_FOUND`) + ~~прогрев при активации~~ (убран на приёмке: версию даёт `ready()` перед стартом); `engineVersion` из него в конфиг адаптера.
- [x] Регистрация `AntigravityAdapter` в фабрике провайдеров Codex-этапа 3; `chat.info` —
      флаги возможностей agy: нет `/compact`, субагентов, подписочных лимитов Claude, thinking;
      режимы — 4 (с пометкой, что `default` = авто-отказ).
- [x] EngineMenu в Composer: пункт «Antigravity», выбор модели из `capabilities()`.
- [x] Карточка отказа (этап 2) с кнопками повтора; строки en/ru (`strings.ts`, `strings.en.ts`,
      nls) одновременно.
- [ ] Сайдбар и пустой экран показывают беседы agy — **перенесено в этап 5** (в main сайдбар только Claude, объединение
      провайдеров в `SessionsService` делает этап 5 Codex). Сделано здесь: открытие/восстановление agy-вкладок по `SessionRef`
      (`agentura.openSession`, сериализатор, память воркспейса — провайдер доходит до адаптера agy).
- [x] `agentura.defaultProvider` уже принимает `antigravity` (этап 1, `isProvider`/`PROVIDERS`): после
      `git merge main` проверить, что фабрика Codex-этапа 3 обрабатывает его (а не падает/не молчит), и
      что `agentura.openSession`/восстановление вкладок с `provider: 'antigravity'` доходят до адаптера
      (сейчас `ChatPanel.resume` для не-Claude пишет warn и не открывает). **Сразу при мерже main**: в main
      `adapterFor: p === 'codex' ? codex : claude`, `resume` без гейта провайдера, `features.ts` всё не-Codex
      считает Claude — ссылка `antigravity` (openSession, память воркспейса, состояние webview) уйдёт в Claude-
      адаптер с id agy. Ветку `antigravity` в фабрике/`resume`/`features` добавить в том же коммите, что мерж.
- [x] Тесты контроллера на маршрутизацию; `npm run check` зелёный.
- [ ] Пользователь: новый чат → Antigravity → ответ стримится; Stop; попросить создать файл в
      default → карточка отказа → «Разрешить правки и повторить» → файл создан.

**Решения (2026-10-06, по итогам сессии 4):**

- Мерж `main` (e00d09c) прошёл без конфликтов; `isProvider`/union/настройки этапа 1 легли поверх. Сразу добавлена ветка
  `antigravity` в `adapterFor`/`engineFor` (`chatPanel.ts`), `providerFeatures` (`ANTIGRAVITY_FEATURES`), `defaultProvider()` и
  `engine.set`; `resume` в main без гейта провайдера — отдельной правки не потребовалось.
- Флаги agy: `modes: true` (4 режима, у `default` пометка «agy сам отклоняет…» в меню), `compact/metrics/subagents/plan/
  questions/images/files: false`. `metrics: false` — нет окна контекста, кэша, стоимости и лимитов подписки Claude;
  токены хода остаются в итоговой строке ленты.
- Контроллер: у agy те же режимы и «всё разрешено», что у Claude (`hasModes`), режим новой сессии — из
  `agentura.defaultPermissionMode`; `defaultModel` и effort — про Claude, agy не передаются (модель — `DEFAULT_AGY_MODEL`
  адаптера, выбор — из `agy models` через `capabilities()`). Возобновлённая agy-сессия — в `default` (транскрипт режим не хранит).
- Локатор `antigravityEngine` (`agentura.antigravityExecutable`, `AGY_NOT_FOUND` → строка на языке интерфейса), прогрев при
  активации (убран на приёмке, см. ниже); версия для `session.init` — через ленивую функцию `engineVersion` в конфиге адаптера (адаптер создаётся раньше,
  чем поиск закончится). В адаптер передан `state: context.globalState`.
- Карточка отказа — новая строка ленты `refusal` (`chatState.ts`), добавляется в `store.dispatchEvent` на живой
  `turn.result` с `permissionDenials` только при провайдере agy и режиме не `bypassPermissions`; из `seedHistory` её нет
  (кнопки в старых ходах были бы ложью — после перезагрузки вкладки карточка исчезает, строки инструментов с ошибкой остаются).
  Кнопки только у последней карточки без новых сообщений после неё: «Разрешить правки и повторить» — если нет `Bash` и режим не
  `acceptEdits`; «Разрешить всё и повторить» — выключена без `agentura.allowBypassPermissions` (с подсказкой). Новое
  сообщение webview→хост `agy.retry {mode}` → `isAgySession(session) && session.retryWithMode(mode)`; хост повторно проверяет
  `allowBypass`. Общий `AgentSession` не расширен.
- Меню «агент»: пункт «Gemini · скоро» заменён на «Antigravity» (строки `acpAdapter`/`agentSoon` удалены); сообщение про
  файлы вложений (`attach.engine`) стало нейтральным. Нет `agy`: карточка `engine_missing` с текстом про agy.
- Не сделано здесь: сайдбар/пустой экран с agy (см. этап 5), `refresh` сайдбара на `turn.result` agy — хука под него в
  main пока нет (`SessionsService` знает только Claude).

**Решения (2026-10-06, приёмка этапа 4):**

- Заголовок возобновлённой agy-вкладки: `ChatDeps.titleOf(id, provider)` — для `antigravity` берётся из
  `antigravityAdapter().listSessions(cwd)` (кэш этапа 3, дёшево), строка без заголовка (title = id) → без заголовка. Claude
  и Codex — как было (список сайдбара).
- Прогрев `agy` при активации убран (план требовал): `engineFor('antigravity').ready()` и так ищет `agy` перед стартом
  сессии и задаёт версию для `session.init`, а прогрев гонял `agy --version` и писал warn «agy не найден» в журнал каждому
  пользователю без agy. Как у Codex — без прогрева.
- Карточка отказа: закрывается на следующем `turn.start` (повтор или новое сообщение) — раньше кнопки оставались живыми,
  если сообщение из очереди доставлялось со старым id; «живость» — по позиции в ленте, не по id; в bypass кнопок нет.
  «Правки» — только когда все отклонённые инструменты из `Write/Edit/MultiEdit/NotebookEdit`; прочее (`Bash`, неопознанные
  имена agy, если отказ не сопоставился с шагом) — команда, только «всё». На `turn.result` с `interrupted` (Stop) карточки нет.
- Хост не принял `agy.retry` (bypass без настройки; адаптер вернул `false` — режим уже такой или `allowBypassPermissions`
  сессии снят при её создании) → новое сообщение хост→webview `agy.retryRejected`: «повторяю…» снимается, в ленте строка
  с причиной. Раньше «повторяю…» висело навсегда.
- `ChatController.lastInit.permissionMode` обновляется на `mode.changed` (всех провайдеров): пересев webview пересылает
  `lastInit` после истории и возвращал меню к режиму начала сессии — после повтора agy в «всё разрешено» меню показывало бы
  «по запросу». Поведение Claude/Codex меняется только в этом (раньше то же расхождение было и у них).
- Известное, не чинилось: `allowBypassPermissions` адаптер agy фиксирует при создании сессии (как Claude). Выключили
  настройку посреди сессии, уже включённый bypass остаётся до конца сессии (у agy переживает пересоздание процесса);
  включили посреди — bypass в этой сессии недоступен (карточка скажет «откройте новый чат»).

### 5. Полировка: квота, настройки, документация

**Сессия:** sonnet. **Блокер для первого пункта:** этап 5 Codex (история: `SessionsService` объединяет провайдеров) влит в main.

- [ ] Сайдбар и пустой экран показывают беседы agy (перенесено из этапа 4): встроить `listSessions(cwd)` agy в
      объединённый `SessionsService` Codex-этапа 5; `schedule`/`refresh` дергать на `turn.result` agy-сессий и после
      `renameSession` (`~/.gemini` не вотчить). Заголовок возобновляемой agy-вкладки уже берётся из списка адаптера
      (`titleOf(id, provider)` в `chatPanel.ts`, приёмка этапа 4) — при объединении можно перевести на общий список.
      **Блокер: этап 5 Codex** — в main его нет (main = e00d09c, `SessionsService` по-прежнему только Claude); не делалось.
- [x] Квота: `agy -p "/usage"` (короткоживущий процесс, не чаще раза в N минут) → HUD/сайдбар
      вместо лимитов Claude; не распарсили — не показываем. Сделано в HUD (у поля ввода агентской вкладки); в сайдбар
      не выводится (там нет провайдера вкладки; общий список — вместе с первым пунктом). N = 10 минут.
- [x] Карточка настроек: путь к agy с кнопкой проверки, движок по умолчанию.
- [x] README/README.ru/CHANGELOG (английский для публичного): требования (`agy` установлен и
      залогинен), ограничения (нет подтверждений по действию, Stop перезапускает процесс).
- [x] `docs/` — заметка о протоколе и хрупком хранилище agy (что читаем и где): `docs/antigravity-protocol.md`.
- [x] Ручной smoke-список — в pending «Проверить руками». `npm run check` зелёный; vsix
      собирается, `spikes/antigravity-probe/` в него не попадает.
- [ ] Мерж `feature/gemini-support` → main (после приёмки владельцем). **Владелец** — не делалось.

**Решения (2026-10-06, по итогам сессии 5):**

- **Квота — отдельный канал, не `limits.update`.** Лимиты Claude (`UsageService`/`LimitsSource`, окна `five-hour`/`weekly`)
  общие на аккаунт и приходят во все вкладки; смешать с ними окна agy значило бы затирать друг друга в сторе. Поэтому:
  `src/agent/antigravity/quota.ts` (`parseAgyUsage` — мягкий парсер строк «имя TAB … NN% TAB ISO-дата»; `runAgyUsage` —
  `execFile(agy, ['-p', '/usage'])`, таймаут 30 с, stdin закрыт, **без `--model`**: команде модель не нужна, живой прогон
  ~5–7 с), `src/extension/agyQuota.ts` (`AgyQuotaService`: кэш, интервал 10 минут между запусками — и неудачными,
  склейка параллельных, упавший процесс оставляет прежние цифры, неразобранный вывод даёт пустой список),
  сообщение `quota.update { rows: {label, remaining, resetsAt?}[], updatedAt }`. `ChatController.refreshLimits` на движке
  agy зовёт квоту вместо лимитов Claude (триггеры те же: `ready`, конец хода, + выбор движка в пустой вкладке), так что
  процесс не поднимается на каждом ходу — только если прошло ≥10 минут. Свежий снимок рассылается во все открытые чаты.
- **Показ:** в `Meters` (`Composer.tsx`) при `features.metrics === false` и `provider === 'antigravity'` рисуются
  `LimitText` по строкам квоты: подпись `Gemini` / `Claude/GPT`, процент — **израсходованный** (как у лимитов Claude,
  чтобы цвет уровня работал одинаково), подсказка — «осталось N% · сброс …». Остальные приборы agy по-прежнему скрыты.
  Метка `metrics` в `ANTIGRAVITY_FEATURES` не менялась (кольцо контекста/кэш/стоимость у agy неизвестны).
- **Настройки:** вкладка ⚙ «Движок» получила строку «Путь к agy» с кнопкой «проверить» (`settings.checkEngine` +
  необязательное `engine: 'antigravity'`, ответ `settings.engine` с `engine`; `settingsPanel.ts` зовёт
  `resolveAgyExecutable`, «не найден» — локализованный текст) и выбор «Движок новых чатов» (`agentura.defaultProvider`).
  Строки добавлены и в `prototype/screens/settings.html` (на нём сверяется DOM-тест). Строки Codex (`codexExecutable`)
  в карточку **не** добавлялись — вне задания этапа.
- **Не сделано:** беседы agy в сайдбаре (блокер Codex-этапа 5, см. выше) и мерж в main. README говорит, что в сайдбаре
  бесед Antigravity пока нет — после первого пункта фразу убрать.
- **vsix:** `npx vsce package` в этом worktree падает на `npm list` (`node_modules` — симлинк на основной репо с чужим
  деревом зависимостей), поэтому проверялось `npx vsce package --no-dependencies --out <scratch>`: 77 файлов, 1,31 МБ;
  `spikes/`, `.codex/`, `AGENTS.md`, `docs/`, `prototype/` внутри нет (`.vscodeignore` не менялся). **Это проверка
  исключений, а не релизный пакет:** `@anthropic-ai/claude-agent-sdk` в esbuild — `external`, релизный vsix несёт
  `node_modules` (0.4.0 — 3224 файла), и в `--no-dependencies`-сборке движок Claude не запустится. Релиз — только
  `npm run package` из чекаута с настоящим `npm ci` (основной репо после мержа). Артефакт удалён.
- **Приёмка (2026-10-06):** второй проход (Opus) и своя проверка дали правки: `runAgyUsage` — свой сторож 35 с с
  `SIGKILL` поверх таймаута `execFile` (тот шлёт SIGTERM только самому процессу и ждёт закрытия stdio — обёртка или
  внук-сервер держали бы `inflight` вечно); парсер — поля через TAB или 2+ пробела, дробь с запятой, колонка «used»
  переворачивается в остаток, строка без подписи про лимит и без даты сброса не считается квотой (прогресс/лог в stdout);
  `quotaView` прячет строку, чей `resetsAt` уже прошёл (старый процент после сброса врёт); `key` строк HUD — индекс
  (две строки с одной короткой подписью); смена движка в пустой вкладке и `resume` чужого провайдера сразу обновляют
  приборы (раньше — только при выборе agy, и Claude-вкладка после agy ждала конца хода); `settings.checkEngine` ловит
  исключение проверки (иначе общий `pending` блокировал обе кнопки «проверить»). Не чинилось: неудачный запуск
  (agy не найден) тоже засчитывается в 10-минутный интервал — после исправления пути квота появится не сразу;
  сервис квоты не убивает идущий `/usage` при деактивации расширения (процесс сам завершится по сторожу).
- **Живой прогон `/usage`:** один (+1 через собранный `runAgyUsage`), без `--model`; формат совпал с `usage.txt`
  (остаток Gemini 20%, Claude/GPT 100%).

## Промты

Общее для всех этапов: worktree `/Users/fost/Projects/Agentura-gemini` (ветка этапа от
`feature/gemini-support`; основной репо `/Users/fost/Projects/Agentura` не трогать — там идёт
Codex-автопилот). Проверки — `npm run check` (длинный вывод в файл, в контекст — хвост и
ошибки). Справочник протокола — `spikes/antigravity-probe/report.md` и логи рядом; образец
устройства — `src/agent/codex/` (adapter, mapper, fakeServer, тесты) и
`src/agent/claude/adapter.ts`. Живые прогоны agy — минимум (квота мала), только
`gemini-3.8-flash-low`. Запрещено: писать в `~/.gemini`, `~/.claude`, `~/.codex`; ослаблять режим
разрешений по умолчанию; рефакторить Claude/Codex; менять визуал вне задачи; коммитить
`spikes/antigravity-probe/`, `.codex/`, `AGENTS.md`. Публичные тексты (README, CHANGELOG,
коммиты) — на английском.

### Промт 1

Этап 1 «Основа и AgyAdapter» из `docs/roadmap/16-antigravity-support.md` — прочитай разделы
«Ключевые факты», «Решения оркестратора» и этап 1, затем `spikes/antigravity-probe/report.md`.
Карта: типы — `src/agent/types.ts` (`AgentProvider`, `AgentAdapter`, `AgentSession`,
`AgentEvent`); настройки и locator Codex — образец (`agentura.codexExecutable`,
`src/extension/engineLocator.ts`, `src/settings.ts`); адаптер Codex — образец очереди,
interrupt и dispose. В UI адаптер не подключать. Новые варианты `AgentEvent` — только если без
них никак, с записью в «Решения» этапа.

### Промт 2

Этап 2 «Инструменты, правки и отказы». Сначала сверь таблицу инструментов с `tools` из `init`
в логах и с `trfull_perm3.jsonl`/`tr_perm3.jsonl` (там реальные аргументы и unified diff).
Всё чтение `~/.gemini/antigravity-cli` — только через `src/agent/antigravity/storage.ts`, путь
корня — параметр (тесты на временной папке). UI карточки отказа — не в этом этапе.

**По реальному коду (после приёмки этапа 1):** точки входа — `AgyEventMapper.toolStep`/`result`
(`mapper.ts`: `toolUseId = agy-<step_index>`, `tool.start` с `tool_info.parameters` как есть, отказ
распознаётся по `permission check failed` в `tool_info.error.message`, `permissionDenials` сопоставляются с
шагами по порядку) и `AgySession` (`adapter.ts`: `modeArgs`, `stale` → пересоздание в `ensureProc`, Stop
через `halting` — новый ход ждёт остановки старого процесса). «Повторить с режимом X» = `setMode` +
`send` служебного текста: `setMode` уже пересоздаёт процесс с `--conversation`; `bypassPermissions` без
`allowBypassPermissions` в опциях молча понижается до `default` — не обходить. Фейк — `fakeAgy.ts`
(`step`/`answer`/`result`), фикстура отказа — `test/fixtures/antigravity/denied.json`.

### Промт 3

Этап 3 «История». Источник списка выбери по проверке в extension host (см. этап), решение и
причину — в «Решения». Фикстуры транскрипта/summaries — очищенные от путей и текста владельца.
После этапа 2: чтение хранилища — в `storage.ts` (там уже `readTranscriptTail`, `defaultAgyRoot`, мягкая
деградация), имена инструментов — `mapAgyTool` (`tools.ts`), ханки диффа — `parseDiffBlocks` (`patch.ts`);
в `loadHistory` использовать их, а не заводить вторую таблицу. Связь результата правки с вызовом — `findEditDetail` (ближайший planner-шаг, номер вызова = число GENERIC между ними); для истории читать файл целиком (лимит 32 МБ).

### Промт 4

Этап 4 «Подключение к чату». Блокер: этап 3 Codex в main. Начни с `git merge main`, изучи,
как Codex подключён (фабрика, `chat.info`, EngineMenu, скрытие Claude-only UI), и встройся
так же; свою параллельную инфраструктуру не заводить. Карточка отказа: данные уже есть
(`turn.result.permissionDenials` с `toolName` = `Bash`/`Write`/`Edit`, `tool.result` isError), повтор —
`isAgySession(session) && session.retryWithMode('acceptEdits' | 'bypassPermissions')` из `adapter.ts`
(для `Bash` — только «всё»); общий `AgentSession` не расширять. Этап 3 дал адаптеру `listSessions`/`loadHistory`/
`renameSession` (см. «Решения … сессии 3»): в конфиг `AntigravityAdapter` передать `state: context.globalState` (имена
бесед и запасной индекс; без этого они живут только в памяти), в сайдбаре объединять `listSessions(cwd)` провайдеров (сайдбар — перенесён в этап 5, см. решения сессии 4).

**По реальному коду (после приёмки этапа 3):** `listSessions(cwd)` дешёв при повторе (кэш по размеру/mtime базы agy), но
сам сайдбар (`sessionsService.ts`) обновляется по `fs.watch` каталога Claude и статусам живых сессий — изменений в
`~/.gemini` он не видит: дергать `refresh`/`schedule` на `turn.result` agy-сессий (и после `renameSession`), каталог
`~/.gemini` не вотчить. `loadHistory(id, cwd, {live: true})` при пересеве открытой вкладки оставляет последний ход открытым
с id будущих шагов tool — живые события склеиваются через обычный `mergeReplay`. `renameSession` пишет в `globalState`
(ключи `agentura.antigravity.sessions`/`.names`). `node:sqlite` в extension host печатает ExperimentalWarning в лог хоста
(не ошибка); нет модуля — молча запасной индекс.

### Промт 5

Этап 5 «Полировка». Первым делом проверь, влит ли в main этап 5 Codex (объединение провайдеров в `SessionsService`): если да — `git merge main` и встрой беседы agy в сайдбар/пустой экран (пункт перенесён из этапа 4; дергай `schedule` на `turn.result` agy и после `renameSession`, `titleOf(id, provider)` для agy уже читает список адаптера — можно перевести на общий), если нет — этот пункт пропусти и скажи об этом в отчёте. Формат `/usage` — по `spikes/antigravity-probe/usage.txt`, парсер мягкий.
