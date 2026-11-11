# 32 — GLM как пятый движок

> Статус: **закрыт 2026-11-07 — заменён roadmap 33** (ZCode CLI как нативный движок, вход подпиской без ключа; решение владельца). Спайк-артефакты (транспортный контракт эндпоинта Z.ai) остаются как запасной путь. Этапы 2–4 не выполнялись.

## Checkpoint

**2026-11-07 · roadmap закрыт — заменён roadmap 33 (ZCode CLI).**

- Решение владельца: GLM-движок делается на ZCode CLI (`zai-org/ZCode`, вход аккаунтом ZCode через квоту подписки, без API-ключа). Новый план — `docs/roadmap/33-zcode-support.md`.
- Ценность оставшихся артефактов этапа 1: живой контракт Anthropic-совместимого эндпоинта Z.ai (`docs/spikes/glm-claude/report.md`, фикстуры `test/fixtures/glm/`) — если маршрут 33 упрётся (вход не переиспользуется), возврат сюда: нужен только ключ Coding Plan со страницы z.ai/manage-apikey/apikey-list.
- Хвосты: `~/.agentura-glm-key` (устаревший ключ платформы — удалить), `/tmp/glm-spike.bSVv4M`, `/tmp/glm-sdk-spike.mjs`, `/tmp/glm-rename-spike.mjs` — удалить владельцу.

**2026-11-06 · этап 1 исполнен, не принят — вердикт `stop` по DoD, внешний блокер.**

- Сделано: спайк живьём на ключе владельца (`claude` 2.1.318). Транспортный контракт снят: env-минимум (`BASE_URL` + токен + `CLAUDE_CONFIG_DIR` дают живой коннект; `ANTHROPIC_DEFAULT_*_MODEL` нужны, иначе CLI шлёт `claude-opus-5-5`), требование `--verbose` у `-p --output-format stream-json` на 2.1.318, форматы ошибок (баланс `429 1113`, ключ `401 1000`, модель `400 1211`), `GET /v1/models` → 12 живых id, транскрипт дома — 12 видов записей, ядро `user`/`assistant` совместимо с `buildHistory`, `custom-title` пишется записью в jsonl (SDK `renameSession` env не принимает), SDK `query()` с `Options.env` работает, при `result.is_error` итерация бросает Error (адаптеру этапа 2 нужен try/catch). Суффикс `[1m]` — не id, beta-флаг CLI на DEFAULT_OPUS-маппинге.
- Блокер: ни один ход не прошёл — каждый запрос даёт `429 [1113] Insufficient balance or no resource package` (все модели и прямой curl). Ключ валиден (порча → `401`, `/v1/models` → `200`). Похоже на ключ открытой платформы с нулевым балансом, а не ключ Coding Plan.
- Артефакты: `docs/spikes/glm-claude/report.md` (последняя строка `stop`), `test/fixtures/glm/pong.ndjson`, `test/fixtures/glm/transcript-sample.jsonl`. Чекбоксы этапа 1: 3 закрыто, 3 частично (датированные примечания).
- Ветка/коммиты: работал в `stage-1-glm-spike` (создана, пустая), HEAD возвращён на `main`; коммитов нет. Dirty: нетронутый WIP roadmap 31 + новые файлы спайка (untracked). Сырые логи: `/tmp/glm-spike.bSVv4M` (+ `/tmp/glm-sdk-spike.mjs`, `/tmp/glm-rename-spike.mjs`) — удалить владельцу. Ключ: `~/.agentura-glm-key` (оставлен на повтор спайка).
- Проверки приёмки (основной чат, 2026-11-06): `tail -1` отчёта = `stop`; `rg -n "sk-|Bearer|ANTHROPIC_AUTH_TOKEN|api[_-]?key" test/fixtures/glm docs/spikes/glm-claude` — пусто; полнотекстовый поиск значения ключа по артефактам — пусто; `git status` — src/ не менялся, только untracked спайка.
- Модели/усилия: исполнитель — subagent `general-purpose` (`agent_fa8e4f7e-3f10-428c-89b5-e7f1570fce54`), runtime-модель unknown. Основной чат — GLM-5.3 (zai-individual-coding-plan). cwd `/Users/fost/Projects/Agentura` (подтверждён `git branch`).
- Следующий шаг: владелец заводит ключ Coding Plan (z.ai → Coding Plan → Plan Overview → API Keys) или пополняет баланс платформы; повторный прогон — SendMessage тому же агенту, только непройденные пункты (успешный ход, tool/permission-кадры, Stop, ненулевой usage/цена, thinking, таймауты). После `go` — этап 2 (ветка `stage-2-glm-provider`, старт только на чистом дереве после закрытия WIP 31).
- Промт проверки в другом клиенте: прочитать `docs/spikes/glm-claude/report.md` (последняя строка — `stop`); `rg -n "sk-|Bearer|ANTHROPIC_AUTH_TOKEN|api[_-]?key" test/fixtures/glm docs/spikes/glm-claude` — пусто; `git status --short` — из новых каталогов только `docs/spikes/glm-claude/` и `test/fixtures/glm/`.

## Цель

Вкладка Agentura умеет идти на GLM от Z.ai: пятый провайдер `glm` поверх движка Claude Code (Claude Agent SDK уже в проекте) на официальном Anthropic-совместимом эндпоинте Z.ai. Текст стримится, разрешения/план/вопросы приходят карточками, сессии GLM живут в своём каталоге (`~/.agentura/glm`) и не смешиваются с Anthropic-Claude. Поведение Claude, Codex, Antigravity и Cursor не меняется.

## Контекст и ограничения

Проверено по коду 2026-11-06. Маршрут выбран из-за отсутствия официального GLM CLI (спрошено у владельца 2026-11-06, ответа не было — принято по рекомендации; отмечено как допущение, а не подтверждение).

### Что уже известно про GLM-путь Z.ai

Снято с docs.z.ai/devpack/tool/claude 2026-11-06, **живым прогоном не проверено**. На машине: `claude` 2.1.318 в `~/.local/bin`, `~/.claude/settings.json` без Z.ai-переменных.

- Официального CLI «GLM» нет. Z.ai даёт GLM через существующих агентов: Claude Code, Codex CLI, Crush (docs.z.ai/devpack/tool/*). Community `zai-cli` (npm, v0.3.x) нестабилен и не рассматривается.
- Claude Code + GLM — переменные окружения, не флаги CLI: `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_AUTH_TOKEN=<ключ Z.ai>`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL=glm-5.3-flash / glm-5.3`, суффикс `[1m]` у id даёт контекст 1M, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`, `API_TIMEOUT_MS=3000000`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Доки Z.ai проверены на CC 2.0.14; у нас 2.1.318 — спайк подтверждает.
- Ключ — API-ключ платформы Z.ai (Personal/Team Coding Plan или открытая платформа). Входа `login`, как у Codex/Cursor, нет: ключ — единственная аутентификация.
- Китайское зеркало эндпоинта — `https://open.bigmodel.cn/api/anthropic`.

### Контракт SDK, проверенный по типам в node_modules (текущая версия пакета)

- `query()` принимает `Options.env` — окружение процесса движка задаётся на сессию. Живая сессия пишет транскрипты под `CLAUDE_CONFIG_DIR` из этого env.
- `listSessions` / `getSessionMessages` / `renameSession` — **опции `env` не имеют**, читают локальный fs под `CLAUDE_CONFIG_DIR` процесса расширения. Второй дом GLM через эти функции напрямую не читается. Есть alpha-опция `sessionStore` — не опираемся.
- Вывод: список и историю GLM читает свой код Agentura по транскриптам из `~/.agentura/glm` (этап 3), SDK-функции перечисления для GLM не используются.

### Точки входа

- `AgentProvider` — `src/agent/types.ts:29` (union из четырёх).
- `PROVIDERS`, `MACHINE_KEYS`, валидация — `src/settings.ts:167`, `src/settings.ts:291`.
- `engineEnv` (стрижёт `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` и маркеры родительской сессии) — `src/agent/claude/adapter.ts:143`; применяется в `baseOptions` — `:513`; дом сессии — `:496` (`config.env['CLAUDE_CONFIG_DIR']`).
- Фабрика адаптеров — `src/extension/chatPanel.ts:210` (Claude), ленивые `codexAdapter`/`agy`/`cursor`; `adapterOf` — `:1251`, `engineOf` — `:1264`.
- Extra-провайдеры сессий — `src/extension/sessionsService.ts:25` (тип), `:181` (записи), `:280` (`source`), `:482` (`providerOf`).
- Флаги — `CLAUDE_FEATURES` и `providerFeatures` в `src/agent/features.ts`.
- Каталог Claude — `defaultClaudeHome()` (`process.env['CLAUDE_CONFIG_DIR'] || ~/.claude`) — `src/data/sessions.ts:174`; `transcriptPath` рядом.
- Метки движка — `ENGINE_MARK` `src/webview/engineLimitsView.ts:36` (claude `C`, codex `X`, antigravity `G`, cursor `R`).
- Настройки новой сессии — паттерн `agentura.cursor.defaultModel` (roadmap 30, коммит 4192d21).

### Принятые решения

- Маршрут: провайдер `glm`, UI «GLM», метка `ENGINE_MARK` `M`. Код живёт в env-слое и фабрике Claude-адаптера, отдельного `src/agent/glm/` с клиентом/маппером **нет** — маппер и SDK общие с Claude. Абстракцию «произвольный Anthropic-совместимый провайдер» (Kimi, Qwen) не делаем; обобщение — отдельная задача, если понадобится.
- Эндпоинт: настройка `agentura.glmBaseUrl` (строка, дефолт `https://api.z.ai/api/anthropic`), покрывает и зеркало bigmodel.cn.
- Ключ: VS Code SecretStorage (`context.secrets`), поле на странице «Движок»; в `settings.json` ключ не пишем (Settings Sync утёчёт). Читается при каждом запуске движка. Нет ключа — вкладка честно говорит «нет ключа GLM», не падает.
- Дом GLM: `~/.agentura/glm` через `CLAUDE_CONFIG_DIR` в env сессии. `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini` не читаем и не пишем; `.mcp.json` проекта Claude Code CLI подхватывает сам.
- env-слой: `engineEnv` получает опцию-override, применяемую **после** стрижки `ANTHROPIC_*`: для glm выставляются `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `API_TIMEOUT_MS`; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` и маппинг `ANTHROPIC_DEFAULT_*_MODEL` — если спайк покажет, что без них не работает или уезжает телеметрия Anthropic.
- Модели: список из спайка (этап 1) — либо честный `supportedModels()` от CLI на эндпоинте, либо захардкоженный список glm-ид; `setModel` уходит сырым id, маппинг дефолтных моделей через env не для UI, а для внутренних вызовов CLI (haiku-класс и т.п.).
- Скрыто в v1, пока спайк не доказал обратного: цена и лимиты подписки (`cost: false`, кольцо лимитов скрыто — числа Anthropic-тарифов про GLM врут), Remote Control (`remote: false` — привязка к claude.ai неприменима), `accountInfo` → `{}`. Контекстное кольцо (`context`) оставляем, если транскрипт несёт usage — решает спайк.
- Разрешения, план, вопросы, субагенты, картинки, файлы, compact, MCP, браузер, скиллы — как у Claude (тот же CLI); скиллы читаются из дома GLM, не из `~/.claude` — в README сказано прямо.
- `renameSession`: если спайк найдёт, где CLI держит customTitle в доме GLM, — реализуем; нет — тихий no-op, как у Cursor.
- Ветки этапов: `stage-1-glm-spike`, `stage-2-glm-provider`, `stage-3-glm-sessions`, `stage-4-glm-ui` (конвенция `stage-N-*` из roadmap 29). Этапы строго по порядку.
- Настройка новой сессии: `agentura.glm.defaultModel` по паттерну roadmap 30, модель уходит в `createSession`.

## Этапы

### 1. Спайк: Claude Code на эндпоинте Z.ai

Зачем: доки Z.ai сняты с CC 2.0.14 и не показывают живых кадров транскрипта; контракт GLM-дома и моделей решает этапы 2–3. Этап только снимает факты и пишет go/no-go.

- [x] Взять ключ Z.ai у владельца (во временное окружение, не в репо). Нет ключа — отчёт `stop` и остановка, код не писать.
- [ ] Прогон `claude -p` во временной папке с env из раздела «Что уже известно» и `CLAUDE_CONFIG_DIR` во временный дом: ход «ответь одним словом pong», ход с правкой файла (разрешение), ход с чтением, Stop посреди хода. Записать сырой stdout (`--output-format stream-json`) и получившиеся транскрипты дома.
  — Частично (2026-11-06): pong-прогоны и транскрипты сняты, но ни один ход не прошёл — эндпоинт отвечает `429 [1113] Insufficient balance` на всё; правка файла, чтение и Stop живьём не видели. Переснять после пополнения тарифа.
- [ ] Модели: что принял эндпоинт — `glm-5.3`, `glm-5.3-flash`, суффикс `[1m]`, алиасы sonnet/opus; что `supportedModels()`-эквивалент CLI показывает на этом эндпоинте (`claude model list` или аналог, только то, что реально работает).
  — Частично (2026-11-06): список id снят живьём через `GET /v1/models` (12 моделей), `[1m]` — beta context-1m у CLI, не id; `claude model list` без tty висит; «что принял эндпоинт» не видели (тарифная ошибка 1113 раньше валидации модели).
- [x] Транскрипт: структура jsonl-записей GLM-дома против фикстур Claude (`test/fixtures/claude/`): поля usage (input/output/cache), есть ли `cost_usd` и по каким тарифам, customTitle/первый промпт — где CLI хранит, thinking/effort-поля.
- [x] SDK: один прогон `query()` из временного скрипта с `Options.env` (base URL, токен, `CLAUDE_CONFIG_DIR` во временный дом) — события хода и файл сессии в доме GLM; подтвердить, что без env-опций SDK-функции перечисления видят только `~/.claude`.
- [ ] Что ломается: телеметрия/`/status` без `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, поведение при исчерпании квоты Coding Plan (формат ошибки), таймауты без `API_TIMEOUT_MS`.
  — Частично (2026-11-06): формат ошибки пустого баланса (1113) и кривого ключа (401/1000) снят, `DISABLE_NONESSENTIAL_TRAFFIC` меняет только `analytics_disabled` в init; таймауты без `API_TIMEOUT_MS` не видели (успешных ходов не было).
- [x] Очистить записи от ключей, путей машины, почты. Фикстура `test/fixtures/glm/pong.ndjson` (кадры stream-json) и образец записи транскрипта `test/fixtures/glm/transcript-sample.jsonl`. Отчёт `docs/spikes/glm-claude/report.md`: версия CLI, таблица «вопрос → факт» (env-минимум, модели, usage/цена, rename-хранилище, ломкое), строка `go` или `stop`.

**Готово, когда:** `docs/spikes/glm-claude/report.md` заканчивается строкой `go` или `stop`. При `go` есть обе фикстуры и заполнены таблица решений для этапов 2–3 (env-минимум; список моделей; usage в транскрипте; где customTitle; нужен ли `API_TIMEOUT_MS`/`DISABLE_NONESSENTIAL_TRAFFIC`). Проверка: `rg -n "sk-|Bearer|api_key|ANTHROPIC_AUTH_TOKEN|api\\.z\\.ai/api|bigmodel" test/fixtures/glm docs/spikes/glm-claude` — пусто по секретам (сам ключ), эндпоинт в отчёте допустим.

### 2. Провайдер glm: env-слой и адаптер

Зачем: `createSession`/`resumeSession` с провайдером `glm` ходят на эндпоинт Z.ai через существующий Claude-адаптер. UI ещё нет.

**Исполнение:** отдельная сессия. Только после `go` в отчёте спайка и на чистом дереве (см. «Порядок работы»).

- [ ] `AgentProvider` += `'glm'`; `PROVIDERS` и ветки `isProvider`/валидации `defaultProvider` в `src/settings.ts`; enum в `package.json` + `package.nls.json` / `package.nls.ru.json`. Страница настроек значение пока просто tolerates, без своей карточки.
- [ ] `engineEnv` — опция override после стрижки; модуль env-слоя GLM (base URL из настройки, токен из SecretStorage, дом `~/.agentura/glm`, остальное по таблице спайка). Тесты: токен не утекает в Claude-движок, у glm — есть и стрижка родительских маркеров сохранена.
- [ ] Фабрика `createChatServices`: `glmAdapter()` — второй экземпляр `ClaudeAdapter` с env-слоем и тем же локатором `engine` (бинарник общий); `adapterOf`/`engineOf` отдают его для `glm`. Claude-адаптер и его env не меняются.
- [ ] `providerFeatures('glm')`: копия Claude минус `remote`, минус `cost` (и минус `context`, если спайк не увидел usage); собственная константа, не «не-codex → флаги Claude».
- [ ] Нет ключа или пустой base URL — `createSession` бросает понятную ошибку «нет ключа GLM», не процесс и не молчание. Тест.
- [ ] `capabilities()`: модели по таблице спайка (CLI-список или константа из отчёта); `setModel` — сырой id.
- [ ] `TZ=UTC npm run check` зелёный; меню движка и список сессий GLM не показывают.

**Готово, когда:** `TZ=UTC npm run check` зелёный, тесты env-слоя и фабрики есть; вкладка без провайдера `glm` ведёт себя как раньше; `rg -n "providerFeatures" src` показывает ветку glm. Живой smoke `scripts/glm-smoke.mjs` (opt-in: env с ключом из окружения, временный дом, один pong) — не часть check.

### 3. Сессии и история GLM

Зачем: беседа GLM видна в сайдбаре и открывается снова; SDK-перечисление для второго дома не работает, список читаем сами.

- [ ] Чтение дома GLM: параметры «дом» у функций `src/data/sessions.ts` (`defaultClaudeHome`/`transcriptPath` → явный аргумент, дефолт прежний); список сессий GLM собирается из каталога транскриптов дома (фильтр по cwd проекта, как у Claude-списка).
- [ ] `loadHistory` GLM: разбор транскрипта jsonl → существующий `buildHistory` (форма записи снята спайком); `live: true` не закрывает последний ход; кривой файл — пустая история, не ошибка вкладки.
- [ ] `sessionsService`: `ExtraProvider` += `'glm'`, источник — адаптер glm; сбой или отсутствие ключа не стирают строки Claude/Codex/Antigravity/Cursor; `providerOf` различает glm-сессии для resume (resume идёт в glm-адаптер с env-слоем).
- [ ] `renameSession`: по таблице спайка — либо запись туда, где CLI держит customTitle, либо тихий no-op.
- [ ] `accountInfo` → `{}`; кнопок входа и лимитов для glm нет.
- [ ] Фикстуры из этапа 1; тесты списка и истории на фикстуре и на временной папке. `TZ=UTC npm run check` зелёный.

**Готово, когда:** тест поднимает ленту `turn.start` + текст + `turn.result` из фикстуры транскрипта GLM; строки GLM в сайдбаре помечены провайдером и открываются glm-адаптером; падение чтения дома не роняет общий список.

### 4. UI и подключение

Зачем: пустая вкладка выбирает GLM, настройки честные, чужие движки не тронуты.

- [ ] Меню движка пустой вкладки, `/new glm` и `task.newChat` принимают `glm`; сайдбар-метки: `ENGINE_MARK` `M`, `providerNames`, `EXTRA_NAMES`.
- [ ] Страница «Движок» настроек: поле ключа GLM (SecretStorage через settingsController, не `settings.json`), поле base URL с дефолтом, пункт `defaultProvider`, подпись «через Claude Code на эндпоинте Z.ai». Карточка GLM в ⚙ → «Новая сессия» рядом с Claude/Codex/Cursor: модель из списка этапа 2, настройка `agentura.glm.defaultModel` по паттерну roadmap 30.
- [ ] Скрытое по флагам: цена, кольцо лимитов, кнопка «rc», вход в аккаунт. Контекстное кольцо — по решению спайка.
- [ ] README.md / README.ru.md: раздел GLM — где взять ключ, что нужен `claude` CLI, дом сессий `~/.agentura/glm`, скиллы/MCP дома GLM, чего в v1 нет (цена, лимиты, remote). CHANGELOG — одна запись.
- [ ] `TZ=UTC npm run check` зелёный; `npm run test:integration` зелёный, если задет webview-протокол.

**Готово, когда:** `TZ=UTC npm run check` зелёный; `rg` по `src` не находит мест, где `glm` молча получает адаптер или флаги Claude (кроме явного дефолта `adapterOf`). Ручной сценарий владельца: ключ → пустая вкладка → GLM → «pong» → правка файла с разрешением → Stop → повторное открытие из сайдбара → отсутствие ключа даёт понятную ошибку.

## Промты исполнителей

Общее: репозиторий `/Users/fost/Projects/Agentura`, ветка этапа уже создана. Галочки в `docs/roadmap/32-glm-support.md` — после команды из «Готово, когда». Чужие незакоммиченные файлы не трогать; если дерево грязное — стоп и отчёт. Не коммитить, не пушить. Не писать в `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`; дом GLM — только `~/.agentura/glm` или временные папки. Ключ Z.ai живёт в окружении/SecretStorage, в репо и логи не попадает. README.md — английский, README.ru.md — русский.

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-1-glm-spike. Задача: снять живой контракт Claude Code CLI на эндпоинте Z.ai GLM и записать go/no-go. Кода адаптера нет.

Читай: docs/roadmap/32-glm-support.md (разделы «Что уже известно про GLM-путь Z.ai» и этап 1); docs/spikes/cursor-acp/report.md — эталон формы отчёта; test/fixtures/claude/ — с чем сравнивать транскрипт.
Правила репо: AGENTS.md.
Точки входа: бинарник claude (2.1.318), пакет @anthropic-ai/claude-agent-sdk в node_modules (query Options.env; listSessions без env). Точки входа проверены при планировании — открывать только то, что правишь.

Уже решено, не переспрашивать: ключ Z.ai даёт владелец во временное окружение; ключ, пути машины и почту в репо не писать; прогон во временной папке с CLAUDE_CONFIG_DIR во временный дом; ~/.claude не трогать; фиктивные кадры не выдумывать — чего не увидели, то «не видели».

Порядок:
1. Нет ключа — отчёт со строкой stop.
2. Прогоны этапа 1, сырые записи во временной папке.
3. Очистка, фикстуры test/fixtures/glm/, отчёт docs/spikes/glm-claude/report.md с таблицей решений для этапов 2–3.
4. Галочки этапа 1 по факту.
DoD: отчёт заканчивается go или stop; при go есть фикстуры и таблица (env-минимум, модели, usage/цена, customTitle, таймауты). Проверка: rg -n "sk-|Bearer|ANTHROPIC_AUTH_TOKEN" test/fixtures/glm docs/spikes/glm-claude пусто.

Не делать: src/agent/*, src/extension/*, UI, правки настроек; не перебирать выдуманные переменные окружения пачкой — только перечисленные в roadmap и то, что видно в поведении CLI.

Не коммитить, не пушить.
Последним сообщением — отчёт: go или stop / версия CLI / файлы / чего не увидели. Отчёт — единственное, что увидит приёмка.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-2-glm-provider. Задача: провайдер glm на Claude-адаптере с env-слоем Z.ai; без UI и без списка сессий.

Читай: docs/roadmap/32-glm-support.md этап 2 и «Принятые решения»; docs/spikes/glm-claude/report.md (таблица — контракт, не доки Z.ai); src/agent/claude/adapter.ts (engineEnv, baseOptions, фабрика сессий); src/extension/chatPanel.ts (createChatServices, adapterOf, engineOf); src/agent/features.ts.
Правила репо: AGENTS.md.

Уже решено, не переспрашивать: если отчёт спайка не go — стоп. glm — второй экземпляр ClaudeAdapter, не наследник и не форк маппера; бинарник и локатор общие с Claude. env-override применяется после стрижки ANTHROPIC_*/маркеров родительской сессии, стрижку не ослаблять. Ключ — SecretStorage (context.secrets), не настройка settings.json. Дом ~/.agentura/glm. Нет ключа — понятная ошибка createSession. Модели и env-минимум — из таблицы спайка. providerFeatures('glm') — своя константа: без remote и cost. Новых AgentEvent нет.

Порядок:
1. Провайдер в union, PROVIDERS, package.json/nls.
2. env-слой и тесты стрижки.
3. glmAdapter в фабрике, adapterOf/engineOf.
4. providerFeatures, capabilities/setModel.
5. Тест ошибки «нет ключа». TZ=UTC npm run check. Галочки этапа 2.
DoD: TZ=UTC npm run check зелёный; тесты env-слоя и фабрики есть; claude-движок и его env не изменились (diff это показывает). Длинный лог — в файл, в отчёт хвост и ошибки.

Не делать: sessionsService, меню, README, SecretStorage-UI (ключ пока через context.secrets напрямую), чтение дома GLM (этап 3), ~/.claude.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-3-glm-sessions. Задача: список сессий и история GLM из дома ~/.agentura/glm; сайдбар и resume различают glm.

Читай: docs/roadmap/32-glm-support.md этап 3; docs/spikes/glm-claude/report.md (структура транскрипта); test/fixtures/glm/; src/data/sessions.ts (defaultClaudeHome, transcriptPath); src/agent/claude/history.ts (buildHistory); src/extension/sessionsService.ts (ExtraProvider, source, providerOf).
Правила репо: AGENTS.md.

Уже решено, не переспрашивать: SDK-функции listSessions/getSessionMessages для дома GLM не использовать (нет env-опции). Дом — параметр функций src/data/sessions.ts, дефолт для Claude прежний. История — из транскрипта через buildHistory; кривой файл — пустая история. rename — по таблице спайка или no-op. accountInfo {}. Сбой glm-источника не стирает чужие строки.

Порядок:
1. Параметр дома в data/sessions, список GLM из каталога транскриптов.
2. loadHistory по фикстуре; live.
3. ExtraProvider glm, providerOf, resume в glm-адаптер.
4. rename, accountInfo.
5. Тесты на фикстуре и временной папке. TZ=UTC npm run check. Галочки этапа 3.
DoD: TZ=UTC npm run check зелёный; тест ленты turn.start+текст+turn.result из фикстуры GLM; строки GLM в сайдбаре с провайдером glm; Claude-список читает прежний дефолтный дом (тест не сломался).

Не делать: UI-строки и метки (этап 4), README, запись в ~/.agentura/glm при тестах (только чтение и временные папки).

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura, ветка stage-4-glm-ui. Задача: пустая вкладка запускает GLM, настройки и строки честные, скрытое по флагам скрыто.

Читай: docs/roadmap/32-glm-support.md этап 4 и «Принятые решения»; src/agent/features.ts; src/webview/strings.ts и strings.en.ts; src/webview/engineLimitsView.ts (ENGINE_MARK); src/extension/settingsController.ts; src/webview/components/Settings.tsx (карточки движков и «Новая сессия»); как cursor подключён в src/extension/chatSurface.ts и taskCommands/task.newChat.
Правила репо: AGENTS.md.

Уже решено, не переспрашивать: ключ — SecretStorage, поле пишет через settingsController, не settings.json; base URL — настройка с дефолтом api.z.ai; defaultProvider принимает glm; карточка «Новая сессия» с agentura.glm.defaultModel по паттерну agentura.cursor.defaultModel. Скрыты: цена, лимиты, «rc», вход. Публичные тексты: README.md en, README.ru.md ru, CHANGELOG одна запись, номер версии не выдумывать.

Порядок:
1. Меню движка, /new glm, task.newChat, метки и строки en/ru.
2. Страница «Движок»: ключ, base URL, defaultProvider, подпись.
3. Карточка «Новая сессия» GLM.
4. README.md, README.ru.md, CHANGELOG.
5. TZ=UTC npm run check (и test:integration, если задет протокол webview). Галочки этапа 4.
DoD: TZ=UTC npm run check зелёный; rg по src: glm нигде молча не получает адаптер/флаги Claude, кроме явного дефолта adapterOf; в отчёте — список найденных сравнений провайдера и что с каждым.

Не делать: лимиты подписки Z.ai (usage API — отдельная задача), Remote Control, правки чужих движков, живой прогон в check.

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
```

## Риски и открытые вопросы

- Внешнее условие этапа 1: ключ Z.ai (Coding Plan или платформа). Нет ключа — roadmap стоит, подменять прокси-эндпоинтами нельзя.
- Выбор маршрута (Claude Code, не Codex/не community CLI) сделан без ответа владельца. Если имелось в виду другое — roadmap пересобрать до этапа 2, после — дорого.
- Доки Z.ai проверены на CC 2.0.14, локально 2.1.318; `MIN_ENGINE_VERSION` проекта 2.1.285. Расхождение снимает спайк; если новый CLI на эндпоинте ломается — поднять пол, а не молчать.
- SDK-перечисление сессий не принимает env: список/история GLM — свой код. Если запись транскрипта GLM-дома сильно отличается от Claude-фикстур, этап 3 дорожает; форма снята спайком, парсер пишется по ней, не по догадке.
- Цена: CLI считает доллары по тарифам Anthropic — для GLM это ложь, поэтому `cost: false` и лимиты скрыты. Появление честных чисел (usage API Z.ai) — отдельная задача.
- Совпадение имён моделей: если CLI на эндпоинте показывает алиасы sonnet/opus, UI показывает список из спайка, а не алиасы; пользователь не должен гадать, какая модель на самом деле.
- Грязное дерево roadmap 31 (Settings.tsx, chatPanel.ts, chatSurface.ts, strings*, settingsController): этапы 2–4 не стартуют поверх чужого WIP — только после его коммита или в согласованном порядке.
- Windows: поведение то же, что у Claude (общий бинарник), живьём не проверяем.
- Ручная проверка владельцем после этапа 4: ключ, pong, разрешение на правку, Stop, повтор из сайдбара, отсутствие ключа.

## Порядок работы

1 → 2 → 3 → 4, один репозиторий, этап в своей ветке `stage-N-glm-*`. Этап 2 не начинается без `go` в отчёте спайка. Общие с WIP roadmap 31 файлы (Settings.tsx, chatPanel.ts, chatSurface.ts, strings*, settingsController.ts) трогают этапы 2 и 4: до старта убедиться, что WIP 31 закоммичен, иначе стоп. Приёмка этапа — сверка diff с этапом и DoD; дефекты возвращаются исполнителю этапа. Коммит и push — только по явному разрешению владельца.
