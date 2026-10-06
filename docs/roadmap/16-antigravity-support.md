# 16 — Antigravity (Gemini) как третий движок

> **Статус:** roadmap составлен 2026-10-06 — следующий: 1. Автопилот `/roadmap-run` в worktree
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

- [ ] `AgentProvider` += `'antigravity'`; `SessionRef`-маршрут (этап 1 Codex) принимает его.
      Настройки `agentura.antigravityExecutable` + значение в `agentura.defaultProvider`
      (`package.json`, `package.nls*.json`, `src/settings.ts`, `MACHINE_KEYS`). Locator — тот же
      обобщённый `EngineLocator` (`src/extension/engineLocator.ts`), бинарник `agy`, ошибки
      «agy не найден» отдельные.
- [ ] `src/agent/antigravity/protocol.ts` — типы событий agy 1.2.17 (вход/`init`/`step_update`/
      `result`) по report.md и логам; версия в шапке.
- [ ] `src/agent/antigravity/process.ts` — spawn (`shell: false`, cwd сессии, env целиком),
      построчный NDJSON-парсер stdout с лимитом строки (64 МБ), stderr → `Logger.debug`
      (`AGY_ERROR:` — разбирать в `error`), сбор потомков (`ps -A -o pid=,ppid=` до kill) и kill
      дерева: SIGINT agy → grace → SIGKILL agy и всех собранных потомков.
- [ ] `src/agent/antigravity/mapper.ts` — события → `AgentEvent`: `session.init` (из `init`),
      `turn.start`, `text.delta` (messageId по `step_index`), `tool.start`/`tool.result` по шагам
      tool (имя как есть, результат — `output`/`error.message`), `turn.result` (ok при SUCCESS,
      usage — сумма шагов хода), `error` + `session.closed` при смерти процесса. Пустые
      `text_delta` и хвостовой `"\n"` не плодят пустых сообщений.
- [ ] `src/agent/antigravity/adapter.ts` — `AntigravityAdapter implements AgentAdapter`:
      `createSession`/`resumeSession` (`--conversation`), `send` (текст; картинки — пока нет,
      запись в «Решения»), очередь на стороне сессии (как Codex), `interrupt()` = SIGINT + kill
      дерева + `turn.result` interrupted, следующий `send` поднимает процесс с `--conversation`;
      `setModel`/`setMode` — пересоздание к следующему ходу; `capabilities()` — модели из
      `agy models` (кэш на процесс расширения). `listSessions`/`loadHistory`/`renameSession` —
      пусто/no-op (этап 3).
- [ ] Фейковый agy для тестов (скрипт-бинарник или фейковый `RpcProcess`-подобный процесс по
      образцу `src/agent/codex/fakeServer.ts`): обычный ход, ход с tool, отказ, многоходовость
      в одном процессе, SIGINT, падение процесса, resume.
- [ ] Живой smoke `scripts/agy-smoke.mjs` (opt-in, временная папка, `gemini-3.8-flash-low`,
      «ответь одним словом pong»); фикстура `test/fixtures/antigravity/` без путей и id машины;
      тест маппера по ней.
- [ ] `npm run check` зелёный; Claude и Codex не изменились.

**Готово, когда:** адаптер проходит fake-тесты и тест по живой фикстуре; в UI не подключён.

### 2. Инструменты, правки и отказы

**Сессия:** sonnet.

- [ ] Имена инструментов agy → привычные карточки ленты: `run_command` → Bash (команда из
      `CommandLine`, вывод), `write_to_file`/`replace_file_content` → Write/Edit, чтение/поиск —
      как Read/Grep/Glob, остальное — общая карточка. Таблица соответствия — в `mapper.ts`, по
      `tools` из `init` (60 имён) и логам.
- [ ] Диффы правок: после DONE шага правки читать `transcript_full.jsonl` этой беседы
      (`storage.ts`, единственное место, знающее пути `~/.gemini/antigravity-cli`), брать
      аргументы и unified diff → `tool.result` с данными для DiffPreview/вкладки «изменения»
      (`editFiles`/`fileSpans`), если это ложится на существующие поля. Нет файла / не разобрали —
      карточка без диффа, без ошибки.
- [ ] Отказы: шаг tool ERROR с `user denied permission` + `result.denied_actions` → событие для
      карточки отказа (если нужен новый вариант `AgentEvent` — минимальный, записать в
      «Решения»). Метод сессии «повторить с режимом X»: пересоздать процесс в режиме и отправить
      служебный повтор. UI карточки — этап 4.
- [ ] Режимы (см. «Решения оркестратора») на spawn; `mode.changed` при смене.
- [ ] Тесты по фейку: правка с диффом, правка без транскрипта, отказ → повтор в accept-edits,
      bypass не включается сам. `npm run check` зелёный.

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

- [ ] Регистрация `AntigravityAdapter` в фабрике провайдеров Codex-этапа 3; `chat.info` —
      флаги возможностей agy: нет `/compact`, субагентов, подписочных лимитов Claude, thinking;
      режимы — 4 (с пометкой, что `default` = авто-отказ).
- [ ] EngineMenu в Composer: пункт «Antigravity», выбор модели из `capabilities()`.
- [ ] Карточка отказа (этап 2) с кнопками повтора; строки en/ru (`strings.ts`, `strings.en.ts`,
      nls) одновременно.
- [ ] Сайдбар и пустой экран показывают беседы agy (этап 3), открытые вкладки
      восстанавливаются после перезагрузки окна.
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

### Промт 3

Этап 3 «История». Источник списка выбери по проверке в extension host (см. этап), решение и
причину — в «Решения». Фикстуры транскрипта/summaries — очищенные от путей и текста владельца.

### Промт 4

Этап 4 «Подключение к чату». Блокер: этап 3 Codex в main. Начни с `git merge main`, изучи,
как Codex подключён (фабрика, `chat.info`, EngineMenu, скрытие Claude-only UI), и встройся
так же; свою параллельную инфраструктуру не заводить.

### Промт 5

Этап 5 «Полировка». Формат `/usage` — по `spikes/antigravity-probe/usage.txt`, парсер мягкий.
