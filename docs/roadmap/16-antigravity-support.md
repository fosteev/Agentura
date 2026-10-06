# 16 — Antigravity (Gemini) как третий движок

> **Статус:** этап 2 принят 2026-10-06 — следующий: 3. Автопилот `/roadmap-run` в worktree
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

- [ ] `listSessions(cwd)` — беседы этого воркспейса. Источник выбрать по факту (записать в
      «Решения»): `conversation_summaries.db` через `node:sqlite`, если он доступен в extension
      host VS Code (проверить, не только в тестовом Node); иначе — перебор
      `brain/*/.system_generated/logs/transcript.jsonl` с воркспейсом из метаданных; иначе —
      собственный индекс бесед, начатых в Agentura (`globalState`). Заголовок: `title` или
      `preview` (без обёртки `<USER_REQUEST>`).
- [ ] `loadHistory` — `transcript.jsonl` → события ленты через тот же маппер (USER_INPUT →
      сообщение пользователя без `<USER_REQUEST>`/`<ADDITIONAL_METADATA>`, PLANNER_RESPONSE →
      текст и tool-вызовы, GENERIC → результаты).
- [ ] `renameSession` — у agy нет API: своё имя в хранилище Agentura поверх `title`/`preview`.
      Файлы `~/.gemini` только читать, никогда не писать.
- [ ] Тесты на фикстурах транскрипта и summaries (очищенных). `npm run check` зелёный.

### 4. Подключение к чату

**Сессия:** sonnet. **Блокер:** этап 3 Codex влит в main. Перед стартом:
`git merge main` в `feature/gemini-support`, конфликты — в пользу main.

- [ ] Экземпляр `EngineLocator` для agy (`antigravityEngine` рядом с `codexEngine`, `resolveAgyExecutable`,
      `AGY_NOT_FOUND`) + прогрев при активации; `engineVersion` из него в конфиг адаптера.
- [ ] Регистрация `AntigravityAdapter` в фабрике провайдеров Codex-этапа 3; `chat.info` —
      флаги возможностей agy: нет `/compact`, субагентов, подписочных лимитов Claude, thinking;
      режимы — 4 (с пометкой, что `default` = авто-отказ).
- [ ] EngineMenu в Composer: пункт «Antigravity», выбор модели из `capabilities()`.
- [ ] Карточка отказа (этап 2) с кнопками повтора; строки en/ru (`strings.ts`, `strings.en.ts`,
      nls) одновременно.
- [ ] Сайдбар и пустой экран показывают беседы agy (этап 3), открытые вкладки
      восстанавливаются после перезагрузки окна.
- [ ] `agentura.defaultProvider` уже принимает `antigravity` (этап 1, `isProvider`/`PROVIDERS`): после
      `git merge main` проверить, что фабрика Codex-этапа 3 обрабатывает его (а не падает/не молчит), и
      что `agentura.openSession`/восстановление вкладок с `provider: 'antigravity'` доходят до адаптера
      (сейчас `ChatPanel.resume` для не-Claude пишет warn и не открывает). **Сразу при мерже main**: в main
      `adapterFor: p === 'codex' ? codex : claude`, `resume` без гейта провайдера, `features.ts` всё не-Codex
      считает Claude — ссылка `antigravity` (openSession, память воркспейса, состояние webview) уйдёт в Claude-
      адаптер с id agy. Ветку `antigravity` в фабрике/`resume`/`features` добавить в том же коммите, что мерж.
- [ ] Тесты контроллера на маршрутизацию; `npm run check` зелёный.
- [ ] Пользователь: новый чат → Antigravity → ответ стримится; Stop; попросить создать файл в
      default → карточка отказа → «Разрешить правки и повторить» → файл создан.

### 5. Полировка: квота, настройки, документация

**Сессия:** sonnet.

- [ ] Квота: `agy -p "/usage"` (короткоживущий процесс, не чаще раза в N минут) → HUD/сайдбар
      вместо лимитов Claude; не распарсили — не показываем.
- [ ] Карточка настроек: путь к agy с кнопкой проверки, движок по умолчанию.
- [ ] README/README.ru/CHANGELOG (английский для публичного): требования (`agy` установлен и
      залогинен), ограничения (нет подтверждений по действию, Stop перезапускает процесс).
- [ ] `docs/` — заметка о протоколе и хрупком хранилище agy (что читаем и где).
- [ ] Ручной smoke-список — в pending «Проверить руками». `npm run check` зелёный; vsix
      собирается, `spikes/antigravity-probe/` в него не попадает.
- [ ] Мерж `feature/gemini-support` → main (после приёмки владельцем).

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
После этапа 2: чтение хранилища — в `storage.ts` (там уже `readTranscriptFull`, `defaultAgyRoot`, мягкая
деградация), имена инструментов — `mapAgyTool` (`tools.ts`), ханки диффа — `parseDiffBlocks` (`patch.ts`);
в `loadHistory` использовать их, а не заводить вторую таблицу. Связь результата правки с вызовом — `findEditDetail` (ближайший planner-шаг, номер вызова = число GENERIC между ними); для истории читать файл целиком `readTranscriptFull` (лимит 32 МБ).

### Промт 4

Этап 4 «Подключение к чату». Блокер: этап 3 Codex в main. Начни с `git merge main`, изучи,
как Codex подключён (фабрика, `chat.info`, EngineMenu, скрытие Claude-only UI), и встройся
так же; свою параллельную инфраструктуру не заводить. Карточка отказа: данные уже есть
(`turn.result.permissionDenials` с `toolName` = `Bash`/`Write`/`Edit`, `tool.result` isError), повтор —
`isAgySession(session) && session.retryWithMode('acceptEdits' | 'bypassPermissions')` из `adapter.ts`
(для `Bash` — только «всё»); общий `AgentSession` не расширять.

### Промт 5

Этап 5 «Полировка». Формат `/usage` — по `spikes/antigravity-probe/usage.txt`, парсер мягкий.
