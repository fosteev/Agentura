# Спайк Claude Code на эндпоинте Z.ai GLM · 2026-11-06

Живой прогон `claude` 2.1.318 (`/Users/fost/.local/bin/claude --version`) на `https://api.z.ai/api/anthropic` с ключом платформы Z.ai (дан владельцем во временное окружение, читался в env каждого прогона, в репо и логи не попал). Все прогоны — во временной папке с `CLAUDE_CONFIG_DIR` внутри неё; `~/.claude` не читался и не писался. SDK — `@anthropic-ai/claude-agent-sdk` 0.3.285 из node_modules репо.

Итог в двух строках: транспорт, аутентификация, форматы ошибок, транскрипт и SDK-контракт сняты живьём, но **ни один ход не прошёл** — каждый запрос сообщений (все glm-модели, включая самый дешёвый `glm-4.5-air`, и прямым curl без CLI) получает `429 [1113][Insufficient balance or no resource package. Please recharge.]`. Ключ валиден (испорченный даёт `401 1000`), `/v1/models` отвечает `200`. Это пустой тариф аккаунта, а не поломка интеграции — но по критерию спайка это `stop`: контракт успешного хода не снят.

## Запуск

Базовая команда (ключ подставлялся в env из файла владельца, значение нигде не печаталось):

```text
env ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic \
    <токен-переменная из env-минимума roadmap 32>=$KEY \
    CLAUDE_CONFIG_DIR=$TMP/config \
    API_TIMEOUT_MS=3000000 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash \
    ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3 \
    ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3 \
  claude -p 'reply with one word: pong' --output-format stream-json --verbose
```

Факт версии: на 2.1.318 `-p --output-format stream-json` без `--verbose` падает с `Error: When using --print, --output-format=stream-json requires --verbose` (stderr, exit 1). В доках Z.ai, снятых с CC 2.0.14, этого требования не было — адаптеру этапа 2 `--verbose` обязателен.

## Прогоны

| # | Условия | Что вышло |
| --- | --- | --- |
| 01 | полный env из доков Z.ai | init `model: glm-5.3[1m]`, затем `api_retry` ×10 (429) и synthetic assistant с `[1113] Insufficient balance…`, `result` `is_error: true` за 190 с |
| 02 | `--model glm-5.3-flash` | то же 1113, init `glm-5.3-flash` |
| 03 | `--model glm-5.3` | то же 1113, init `glm-5.3`, без beta `context-1m` |
| 04 | минимальный env (без `API_TIMEOUT_MS`, `DISABLE_NONESSENTIAL_TRAFFIC`, `DEFAULT_*_MODEL`) | init `model: claude-opus-5-5` (CLI-дефолт -p), `analytics_disabled: false`, то же 1113, stderr пуст |
| 05 | `--model sonnet` без DEFAULT-переменных | init `claude-sonnet-5-5`, то же 1113 |
| 06 | SDK `query()` с `Options.env` (скрипт в /tmp) | события `system/init` → `system/api_retry` ×10 → `assistant` → `result/success` с `is_error`, после чего итерация бросила `Error: Claude Code returned an error result: API Error…` |
| 07 | испорченная последняя буква ключа | `Failed to authenticate. API Error: 401 身份验证失败。`, тоже 10 ретраев и ~190 с до сдачи |
| 08 | `claude model list` (без tty) | висит, списка не отдаёт — headless-способа спросить модели у CLI нет |
| curl | `GET /v1/models` | `200`, 12 моделей: `glm-4.5`, `glm-4.5-air`, `glm-4.6`, `glm-4.7`, `glm-5`, `glm-5-turbo`, `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx`, `glm-5.3-flashx-legal` (`hasMore: false`) |
| curl | `POST /v1/messages` `model=glm-5.3[1m]` | `400 [1211][Unknown Model, please check the model code.]` — id с суффиксом API не знает |
| curl | `model=glm-4.5-air` | то же `429 1113` — тариф пуст на всех моделях |

Порядок проверки эндпоинта: сначала CLI (3 модели), затем прямой минимальный curl тем же ключом — ошибка идентична, значит дело в аккаунте, а не в запросах CLI.

## Таблица решений (для этапов 2–3)

| Вопрос | Что пришло |
| --- | --- |
| env-минимум | `ANTHROPIC_BASE_URL` + токен-переменная + `CLAUDE_CONFIG_DIR` дают живой коннект (init, тарифный ответ эндпоинта). `ANTHROPIC_DEFAULT_*_MODEL` нужны: без них `-p` шлёт `claude-opus-5-5`, алиасы резолвятся в `claude-sonnet-5-5`; рабочий ли Anthropic-id на платном тарифе — не видели, полагаться только на маппинг. `API_TIMEOUT_MS`: влияния не видели (успешных ходов нет; ретраи 429 шли одинаково с ним и без). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: единственное видимое отличие — `analytics_disabled: true/false` в init; stderr пуст в обоих случаях, лишнего трафика в stream-json не видели. |
| Модели | Что принял эндпоинт — не видели: тарифная проверка 1113 срабатывает раньше валидации модели (прошла и `claude-opus-5-5`). init принимает любой `--model`. Список id снят живьём через `GET /v1/models` (12, см. выше); CLI-способа списка нет (`claude model list` без tty висит). Суффикс `[1m]` — не id: API отвергает его `1211`; CLI показывает `glm-5.3[1m]` и шлёт `params.model: glm-5.3` + beta `context-1m-2025-08-07`, когда модель пришла из `ANTHROPIC_DEFAULT_OPUS_MODEL`; явный `--model glm-5.3` beta не включает. То есть 1M-контекст — beta-флаг CLI, навешивается на DEFAULT_OPUS-маппинг автоматически (тарифно дороже — для Agentura не нужен). |
| usage/цена | Живого usage нет (нули в каждом кадре). Форма снята: `result.usage` = `{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens_details.thinking_tokens, server_tool_use, …}`; `result.total_cost_usd: 0`; в транскрипте `cost-state.totalCostUSD: 0`, `modelUsage: {}`. Ненулевой цены и тарифов не видели — прятать `cost` и лимиты (решение roadmap остаётся). Контекстное кольцо: полей usage в транскрипте достаточно, но ненулевых чисел не видели. |
| customTitle / rename | Хранится записью `{"type":"custom-title","customTitle":"…","sessionId":"…"}` в самом jsonl сессии (дописана SDK `renameSession`, проверено живьём). После этого `listSessions` отдаёт `customTitle`, а `summary` берётся из него. Нюанс для этапа 3: `renameSession`/`listSessions`/`getSessionMessages` env-опций не имеют и работают от `CLAUDE_CONFIG_DIR` процесса — для `~/.agentura/glm` годится только свой писатель записи `custom-title` (форма снята), SDK-функция пишет в дом процесса. |
| Транскрипт против фикстур Claude | Совместим по ядру: записи `user`/`assistant` несут `message{role, content, usage, id, model}` + `uuid/parentUuid/sessionId/cwd/gitBranch/version` — как в `test/fixtures/claude/`. `buildHistory`-совместимая форма на месте. Отличия от фикстур 2.1.220 — от версии CLI, не от GLM: `user` дополнительно несёт `permissionMode`, `promptSource`, `turnOrigin`, `turnPosition`; `assistant` при ошибке — `isApiErrorMessage`, `apiErrorStatus`, `perTurnEffort`; новых служебных видов записей 12: `queue-operation`, `attachment` (environment/model/…), `atis-latch`, `api-request-shape`, `api-request-blob`, `api-request`, `last-prompt`, `system/api_error`, `cost-state`, `custom-title`. |
| thinking/effort | В `api-request` зафиксировано `params.thinking {type: adaptive, display: updates}`, `output_config.effort: high`, `context_management.edits`, betas (перечислены в фикстуре). Живого thinking-блока в ответе не видели (ходов не было). |
| Формат ошибок | Баланс/пакет: `429` `{"type":"rate_limit_error","code":"1113","message":"[1113][Insufficient balance or no resource package. Please recharge.][<request_id>]"}`; в CLI это 10 кадров `api_retry` (каждый ~40 с), synthetic assistant `API Error: Request rejected (429) · [1113]…` и `result` `is_error` с `terminal_reason: api_error` — ошибка surfaced только через ~190 с. Кривой ключ: `401` `{"error":{"message":"身份验证失败。","type":"1000"}}`, CLI ждёт те же 10 ретраев. Неизвестная модель (прямой API): `400 [1211] Unknown Model`. Квота: в `system/api_error` есть поле `rateLimits` — было `null`; лимитов в кадрах не видели. |
| SDK | `query()` с `Options.env` работает: init-событие пришло, сессия легла в `CLAUDE_CONFIG_DIR` из env. При `result.is_error` цикл бросает `Error: Claude Code returned an error result: …` — обработчику адаптера нужен try/catch. `listSessions({dir})` при `CLAUDE_CONFIG_DIR` процесса видит сессии временного дома (7 шт.): поля `sessionId, summary, lastModified (epoch ms), fileSize, firstPrompt, gitBranch, cwd, createdAt` (+`customTitle` после rename). По типам (`sdk.d.ts`): `listSessions(_options?: ListSessionsOptions)`, `getSessionMessages(_sessionId, _options?: GetSessionMessagesOptions)`, `renameSession(_sessionId, _title, _options?: {dir?})` — env-опций нет; против `~/.claude` не гоняли, чтобы его не читать. |

## Что ужато в фикстурах

`test/fixtures/glm/pong.ndjson` — кадры stream-json прогона 01: `init` (массивы `slash_commands` и `skills` обрезаны до двух образцов + `{_…Count}`), `api_retry` attempt 1 и 10 + сентинел `{_apiRetryFramesOmitted: 8}`, synthetic assistant и `result` целиком. Пути временной папки → `<tmp>`, сокет → `<sock>`.

`test/fixtures/glm/transcript-sample.jsonl` — по одной записи каждого вида из живых транскриптов: длинные тексты `api-request-shape` (system-блоки, tools → два образца + `{_toolsOmitted}`) и `api-request-blob` обрезаны с маркером `<_text_truncated>`; `api-request`, `user`, `assistant`, `cost-state`, `custom-title` — целиком. Все сентинелы с подчёркиванием — обрезка фикстуры, не поля протокола. Ключа в транскриптах нет (проверено полнотекстовым поиском по значению ключа), почты и имён владельца не было.

## Не проверено / не видели

Успешный ход: pong-текст, ненулевые usage/цена, tool-кадры (Write/Read) и `permission-mode` в действии, Stop посреди хода, thinking-блок ответа, таймаут без `API_TIMEOUT_MS` (ходов не было), исчерпание квоты Coding Plan в бою (снят только формат ошибки пустого баланса), принимает ли эндпоент реально `claude-*-5-5` и алиасы, модели из `/v1/models` кроме `glm-5.3`/`glm-5.3-flash`/`glm-4.5-air` прогонами не трогали. Всё это — предмет повтора спайка после пополнения тарифа; транспортная часть контракта выше от этого не изменится.

## Сырые логи

`/tmp/glm-spike.bSVv4M`: `logs/01…08` (stdout/stderr прогонов), `config/projects/…` (транскрипты), плюс `/tmp/glm-sdk-spike.mjs`, `/tmp/glm-rename-spike.mjs`. Ключа в файлах нет (проверено); каталог удалит владелец.

stop
