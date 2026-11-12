# 38. Antigravity (`agy acp`): ретраи, команды, квота `/usage`, инструменты, субагенты и наследование прав `1.5.6`

> Статус: черновик · 2026-11-12. Исполнитель отмечает чекбоксы только по факту проверки. Продолжать с первого незакрытого этапа (`Этап 1`) по маршруту `roadmap-run-agy` (в AGY) или `.codex/WORKFLOW.md` (в Codex).

## Цель и границы

Довести адаптер Antigravity (`agy acp`) в Agentura на реальных сценариях `agy 1.5.6`:
1. Убрать склейку транзиентных сетевых ошибок `⚠ API error (attempt N): ...` с текстом ответа ассистента — переводить их в штатную сворачиваемую плашку `api_retry`.
2. Подхватить живые слэш-команды из `available_commands_update` для меню `/`, защитить парсеры моделей/квоты (`gemini-4-carbon`, `\r`-спиннер, именные пулы Gemini) и починить диагностику/обновление лимитов `/usage` (`AgyQuotaService`, `summarizeAgy`, HUD), чтобы ошибки `agy -p "/usage"` (включая гео-/региональные сбои `Eligibility check failed` на `aicode.googleapis.com`) не глотались молча на 10 минут и не вешали вечный `loading`.
3. Отображать `oneharness`-инструменты `agy` (вызовы MCP с чипом сервера, `invoke_subagent`/`manage_subagents`/`swarm`, задачи/таймеры) штатными карточками ленты с индикацией `waiting_for_input` у заблокированных субагентов и открывать ссылки `conversation://<uuid>` во вкладке чата Agentura.
4. Реализовать наследование прав родительской сессии дочерними субагентами (`agy acp --dangerously-skip-permissions` при `bypassPermissions` с прозрачным перезапуском через `session/resume` при смене режима, плюс учёт серверного режима `auto` в `agy >= 1.5.4`) и честно отразить протокольное ограничение ACP для подтверждений фоновых субагентов в `default`-режиме.
5. Синхронизировать `docs/antigravity-protocol.md`, `README.md`, `README.ru.md` и `scripts/agy-smoke.mjs`.

**Вне скоупа:** оценка стоимости в USD (`agy acp` не передаёт цены), нативные карточки утверждения плана (`create_plan` в `agy` отсутствует), PDF-вложения (`promptCapabilities` не поддерживает `document`), инлайн-карточки `session/request_permission` от фоновых субагентов в режиме `default` (сервер `agy acp` не пересылает их в родительский stdio-поток).

## Контекст и подтверждённые факты

- **Склейка `⚠ API error (attempt N)` с ответом (причина бага):**
  - Бинарник `agy` (`1.5.3`–`1.5.6`) при транзиентном обрыве запроса к Cloud Code (`connection reset by peer`, `timeout`, `HTTP 429/5xx`) отправляет предупреждение по шаблону `"\n⚠ %s\n"` + `"API error (attempt %d): %v"` обычным текстовым кадром `session/update` с `sessionUpdate: "agent_message_chunk"` (в `stderr` и в `transcript.jsonl` на диск эта строка не попадает).
  - `AgyAcpMapper.applyUpdate` (`src/agent/antigravity/acpMapper.ts:69-77`) безусловно клеит любой `agent_message_chunk` в `text.delta` и `this.text`. Одиночный `\n` после текста ошибки рендерится Markdown-парсером как пробел, вклеивая ошибку прямо в абзац ответа модели.
  - Для Claude аналогичные повторы маппятся в `{ type: 'error', fatal: false, code: 'api_retry', message }` (`src/agent/claude/mapper.ts:363-374`, `src/shared/l10n.ts:193-194,456-457`) и схлопываются функцией `retryRow` в одну нейтральную системную строку `tag: 'retry'` (`src/webview/chatState.ts:706,765-772`). При этом сама `retryRow` сейчас не закрывает открытую стримящуюся карточку текста (`streaming: false`), в отличие от `tool.start` (`src/webview/chatState.ts:579-581`).
- **Пустое меню `/` в чатах Antigravity:**
  - Сразу после `session/new` и `session/resume` сервер `agy acp` присылает `session/update` с `sessionUpdate: "available_commands_update"` (`availableCommands: [{ name, description }]` — `compact`, `goal`, `plan` и пользовательские скиллы; `docs/spikes/antigravity-acp/report.md:22`, `test/fixtures/antigravity/acp-pong.ndjson:5`).
  - В `AgySession.onNotification` (`src/agent/antigravity/adapter.ts:970-980`) все уведомления вне активного хода (`this.loading || !this.turn`) отбрасываются, а `buildSessionInit` (`src/agent/antigravity/adapter.ts:788`) всегда возвращает `slashCommands: []`, из-за чего автодополнение `/` в `src/webview/components/Composer.tsx:402` пустое.
- **Почему перестают обновляться лимиты `/usage` для Gemini (подтверждено на `agy 1.5.6`):**
  - В ACP нет RPC-метода чтения квоты, а отправка `/usage` через `session/prompt` в `agy acp` **не** перехватывается как локальная команда (уходит обычным промтом в модель и жжёт токены). Единственный штатный канал CLI — `agy -p "/usage"` (`src/agent/antigravity/quota.ts:86`).
  - В `agy 1.5.6` режим `printmode` (`agy -p`) перед локальной командой `/usage` выполняет обязательную проверку `printmode.waitForEligibility` к хосту **`aicode.googleapis.com`**, тогда как основной чат `agy acp` работает через **`daily-cloudcode-pa.googleapis.com`**. Если в split-tunnel VPN (например, Wayfork) маршрут до `aicode.googleapis.com` обрывается или выходит через неподходящую локацию, `agy -p "/usage"` завершается с кодом `1` и `stderr`: `error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.`, хотя сам чат Antigravity полностью работоспособен (`Google AI Ultra`).
  - В Agentura этот сбой полностью скрыт тремя дефектами:
    1. `AgyQuotaService.fetchOnce` (`src/extension/agyQuota.ts:48-65`) ловит любое исключение пустым `catch {}` без логирования, не уведомляет `listeners`, но взводит `this.lastAttempt = this.now()` на полные **10 минут** (`AGY_QUOTA_INTERVAL_MS = 10 * 60_000`).
    2. На холодном старте (`updatedAt === 0`) `summarizeAgy` (`src/extension/engineLimits.ts:29-46`) при `snap.updatedAt === 0` возвращает вечный `state: 'loading'` и никогда не выставляет `state: 'error'` / `error` (в отличие от `CodexLimitsService` в `src/extension/codexLimits.ts:80-85`). Если же ранний снимок был в кэше, то после наступления `r.resetsAt <= now` кольца квоты в HUD (`src/webview/hudView.ts:310`) молча пропадают без индикации устаревания или причины сбоя. А если `agy` вернул код `0` с нераспознанным выводом при уже имевшихся `rows`, строка `this.last = { rows, updatedAt }` затирает прежний кэш и переводит панель в ложный `signedOut`.
    3. В `parseModels` (`src/agent/antigravity/models.ts:13-18`) и `parseAgyUsage` (`src/agent/antigravity/quota.ts:48-50`) `.replace(/\r$/, '')` не счищает промежуточный TTY-спиннер `\r⠋ Fetching...\r`, а `parseFamily` (`quota.ts:18-23`) и `quotaFamily` (`src/webview/hudView.ts:301-305`) хардкодят `/argon/i` перед `/gemini/i`, из-за чего новые именные пулы (`Gemini 4 Carbon`) сливаются с `Gemini Models` в ключ `'Gemini'` и перезаписывают кольцо общего пула Gemini.
- **Неполный маппинг инструментов `oneharness` и отсутствие перехода в субагентов (`conversation://`):**
  - `mapAgyTool` (`src/agent/antigravity/tools.ts:37-116`) знает только базовые файловые операции и старые `cortex`-имена. Eager-инструменты `mcp_<serverName>_<toolName>` (одинарное `_` вместо `mcp__<server>__<tool>` в `src/webview/toolView.ts:51-57`), lazy-обёртки (`call_mcp_tool`, `list_resources`, `read_resource`) и инструменты оркестрации (`invoke_subagent`, `send_message`, `manage_subagents`, `define_subagent`, `manage_task`, `schedule`, `swarm`) рендерятся без чипов MCP/агентов и человекочитаемых статусов (включая `waiting_for_input`).
  - Ссылки на дочерние сессии вида `[Role](conversation://<uuid>)`, которые генерирует `agy`, вырезаются санитайзером `DOMPurify` в `src/webview/markdown.ts:35-40` (схема `conversation:` не входит в дефолтный `ALLOWED_URI_REGEXP`) и отклоняются в `src/extension/chatController.ts:825-830` (`ссылка не открыта: conversation://...`), хотя в `chatPanel.ts:958` уже проброшен `deps.openSession(id, provider)` (`ChatPanel.resume`), способный открыть транскрипт и сессию дочернего субагента во вкладке Agentura.
- **Почему нельзя подтвердить инструмент в фоновом субагенте в режиме `default` и как устроено наследование прав в `agy 1.5.6`:**
  - В бинарнике `agy` (`cli/acp`) запрос `session/request_permission` жёстко привязан к активному `promptTurn` родительского вызова `session/prompt` (начиная с `agy 1.5.1`, все незакрытые запросы прав принудительно закрываются при завершении `session/prompt`).
  - Вызов `invoke_subagent` создаёт отдельную фоновую беседу (`conversationId`) внутри серверного процесса `agy` и мгновенно возвращает `{ conversationId }` родителю, после чего ход родителя завершается. Когда фоновый субагент упирается в требующий подтверждения инструмент (`run_command` или запись вне workspace), `agy` переводит шаг дочерней беседы в `waiting_for_input`, но **не отправляет `session/request_permission`** ни в stdio родительской сессии, ни при внешнем `session/resume` дочернего `conversationId` (RPC-метода подтверждения чужого `conversationId` в ACP нет).
  - Наследование прав от родителя к дочерним субагентам в `agy` работает на уровне серверного режима и флагов запуска `agy acp`:
    1. **Режим `bypassPermissions` (`allowBypass === true`):** сейчас `AgySession` (`src/agent/antigravity/adapter.ts:420`) всегда спавнит `agy` как `['acp']`, а `agyModeId('bypassPermissions', true)` (`src/agent/antigravity/acpProtocol.ts:201`) выставляет на сервере лишь `'accept-edits'` (разрешает правки файлов в workspace, но **не** `run_command`) и авто-отвечает на `session/request_permission` только у родителя (`adapter.ts:1005`). В результате родитель работает без вопросов, а его субагенты на первой же команде зависают в `waiting_for_input`! У `agy acp` есть штатный флаг `--dangerously-skip-permissions` (`agy acp --help`), который включает авто-одобрение на стороне самого бэкенда `agy` и **наследуется всеми дочерними субагентами и worktree** (починено в `agy 1.5.2`, при этом системный denylist опасных команд и явные `Deny`-правила пользователя продолжают действовать).
    2. **Серверный режим `auto` (`agy >= 1.5.4`):** в `session/new` / `session/resume` сервер `agy 1.5.6` возвращает 4 режима в `modes.availableModes`: `default`, `accept-edits`, `auto` (*"Approve edits and safe commands; ask before irreversible actions."*) и `plan` (для корпоративных аккаунтов Gemini Enterprise режим `auto` может отсутствовать в списке). Сейчас `acpProtocol.ts:192` знает только 3 режима и игнорирует `auto`.
- **Состояние рабочего дерева:** в `/Users/fost/Projects/Agentura` могут находиться незакоммиченные изменения предыдущего roadmap (`37-antigravity-context.md`). Перед стартом проверить `git status -s`; чужие правки сохранять, при параллельной работе использовать отдельный git worktree.

## Принятые решения

- **Формат `api_retry` и закрытие стримящегося текста:** использовать существующий `{ type: 'error', fatal: false, code: 'api_retry', message }` с новым локализованным форматтером без `maxRetries` в `src/shared/l10n.ts`; в `AgyAcpMapper` сбрасывать `messageId` и закрывать `thinking`, а в `retryRow` (`src/webview/chatState.ts`) переводить открытые строки `kind: 'text'` в `streaming: false`.
- **Поведение `AgyQuotaService` при сбоях `/usage` (по образцу `CodexLimitsService`):**
  - В `runAgyUsage` (`src/agent/antigravity/quota.ts`) захватывать `stderr` и формировать чистое сообщение ошибки (с классификацией `isAgyAuthError` для неавторизованного CLI vs прочих ошибок вроде `Eligibility check failed`, таймаута или сетевого обрыва).
  - В `AgyQuotaSnapshot` (`src/extension/agyQuota.ts`) добавить `state: 'loading' | 'ok' | 'signedOut' | 'missing' | 'error'` и `error?: string` (сохраняя прежние `rows` и `updatedAt` при транзиентной ошибке `state === 'error'`, чтобы кэш не обнулялся). При ошибке использовать короткий кулдаун повтора (`AGY_QUOTA_ERROR_COOLDOWN_MS = 60_000` вместо 10 минут) и логировать причину через опциональный логгер (`warn`), а ручной вызов обновления из UI (`limits.refresh` с явным флагом при необходимости) не блокировать 10-минутным окном после ошибки.
  - В `summarizeAgy` (`src/extension/engineLimits.ts`) пробрасывать `state` и `error` в боковую панель `EngineLimits`, а в HUD чата (`quota.update` / `hudView.ts`) при устаревшем или ошибочном снимке показывать причину сбоя в тултипе/индикаторе вместо бесследного исчезновения колец.
- **Ссылки `conversation://<uuid>` и прозрачность субагентов:**
  - Разрешить строго валидированные ссылки `^conversation:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$` в `src/webview/markdown.ts` и `src/extension/chatController.ts` (`case 'link.open'`): при клике вызывать `deps.openSession(uuid, 'antigravity')`, открывая дочерний разговор во вкладке Agentura для чтения полного транскрипта, диагностики стопора или прямого продолжения беседы.
  - В карточках `invoke_subagent` и `manage_subagents` выводить читабельную роль, `conversationId` и статус (`waiting_for_input` подсвечивать явно как ожидание подтверждения в дочерней сессии), не включая чужой граф Claude (`ANTIGRAVITY_FEATURES.subagents` остаётся `false`). Обычный `read_file` на `SKILL.md` оставлять `Read`.
- **Наследование прав субагентами (`bypassPermissions` + `auto`):**
  - При `permissionMode === 'bypassPermissions' && allowBypass` запускать процесс `agy` с аргументами `['acp', '--dangerously-skip-permissions']`.
  - Если пользователь переключает `setMode` между обычным режимом и `bypassPermissions` на уже открытой сессии вне активного хода (`!this.turn`), `AgySession` корректно закрывает текущий дочерний процесс `agy acp` и прозрачно поднимает новый через `session/resume` на том же `this.id` с нужным набором CLI-флагов (сохраняя `model`, `effort` и `cwd`). Если переключение запрошено прямо во время хода, применять клиентский фолбэк до конца текущего хода и перезапускать воркер перед следующим ходом (либо после завершения текущего).
  - Расширить `AgyServerMode` в `src/agent/antigravity/acpProtocol.ts` значением `'auto'` (`'default' | 'accept-edits' | 'auto' | 'plan'`), сохраняя список реально поддерживаемых сервером режимов из `modes.availableModes` ответа `session/new` / `session/resume`. Для `acceptEdits` использовать `'accept-edits'` (или при явной настройке/выборе `auto` — `'auto'`, если сервер его объявил), а если внешний `session/resume` вернул `currentModeId: 'auto'`, корректно маппить его без сброса в `'default'`.

## Этапы

### 1. Перехват транзиентных ретраев `agy acp` (`⚠ API error (attempt N)`) в `api_retry`

**Файлы:** `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/acpMapper.test.ts`, `src/shared/l10n.ts`, `src/webview/chatState.ts`, `src/webview/chatState.test.ts`.

- [ ] Добавить в `src/shared/l10n.ts` (RU/EN) локализованную строку повтора запроса без потолка попыток (`agyApiRetry(attempt: number, detail?: string)`) с компактным извлечением сути сбоя (`connection reset by peer`, `i/o timeout`, `HTTP 429/5xx`, без полных URL `https://daily-cloudcode-pa...`).
- [ ] В `AgyAcpMapper.applyUpdate` (`src/agent/antigravity/acpMapper.ts:69-77`) перед эмитом `text.delta` разбирать в `agent_message_chunk` вхождения строки ретрая `\n?⚠ API error \(attempt (\d+)\): ([^\n]+)\n?`:
  - одиночный чанк предупреждения закрывает открытый `thinking` (`this.closeThinking(now)`), сбрасывает `this.messageId = ''`, **не** пишется в `this.text` и эмитит `{ type: 'error', fatal: false, code: 'api_retry', message }`;
  - если в одном консолидированном чанке вокруг строки предупреждения есть обычный текст модели, текст до и после эмитится отдельными `text.delta` (с новым `messageId` после `api_retry`), а само предупреждение уходит только в `api_retry` и вырезается из `this.text` (`turn.result.text`);
  - обычный текст модели (включая символ `⚠` без префикса `⚠ API error (attempt N): `) передаётся посимвольно без изменений.
- [ ] В `retryRow` (`src/webview/chatState.ts:765-772`) при добавлении новой строки `tag: 'retry'` закрывать открытые стримящиеся блоки текста (`r.kind === 'text' && r.streaming ? { ...r, streaming: false } : r`), сохраняя схлопывание серии подряд идущих `api_retry` в одну строку `tag: 'retry'`.
- [ ] Покрыть тестами в `src/agent/antigravity/acpMapper.test.ts` и `src/webview/chatState.test.ts`: ретрай перед ответом, серия `attempt 1` + `attempt 2`, ретрай посреди стрима между двумя кусками текста, обычный ответ с `⚠`.

**Готово, когда:** `npx vitest run src/agent/antigravity/acpMapper.test.ts src/webview/chatState.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** во время хода Antigravity с сетевым ретраем в ленте появляется компактная нейтральная строка повтора, а текст ответа ассистента не содержит сырого `⚠ API error (attempt 1): Post ...`.

**Исполнение:** последовательно (первый этап).

---

### 2. Слэш-команды `available_commands_update`, парсеры моделей/квоты `1.5.6` и диагностика сбоев `/usage`

**Файлы:** `src/agent/antigravity/acpProtocol.ts`, `src/agent/antigravity/adapter.ts`, `src/agent/antigravity/adapter.test.ts`, `src/agent/antigravity/fakeServer.ts`, `src/agent/antigravity/models.ts`, `src/agent/antigravity/models.test.ts`, `src/agent/antigravity/quota.ts`, `src/agent/antigravity/quota.test.ts`, `src/extension/agyQuota.ts`, `src/extension/agyQuota.test.ts`, `src/extension/engineLimits.ts`, `src/extension/engineLimits.test.ts`, `src/extension/chatController.ts`, `src/protocol.ts`, `src/webview/hudView.ts`, `src/webview/hudView.test.ts`.

- [ ] В `src/agent/antigravity/acpProtocol.ts` добавить чистый парсер `availableCommandsOf(update: unknown): string[] | undefined` для `sessionUpdate === 'available_commands_update'` (непустые `name` без ведущего `/`, дедупликация с сохранением порядка).
- [ ] В `AgySession` (`src/agent/antigravity/adapter.ts:729-795,970-980`) принимать `available_commands_update` в `onNotification` включая фазу `handshake` и простой между ходами (`!this.closed`), включать список в `buildSessionInit().slashCommands` и перевыпускать `session.init` при изменении списка после старта.
- [ ] В `parseModels` (`src/agent/antigravity/models.ts:11-20`) и `parseAgyUsage` (`src/agent/antigravity/quota.ts:47-53`) перед разбором каждой строки очищать прогресс TTY-спиннера по `\r` (`line.split('\r').pop() ?? ''`), чтобы первая строка (`gemini-4-carbon-*` / первая строка квоты) не съедалась спиннером `Fetching...`.
- [ ] В `parseFamily` (`src/agent/antigravity/quota.ts:18-23`) и группировке квоты в `src/webview/hudView.ts:301-305` маппить в общий `'Gemini'` только общий пул (`/^gemini(?:\s+models)?$/i`), а выделенные пулы конкретных моделей (`Gemini 4 Argon`, `Gemini 4 Carbon` и др.) оставлять отдельными семействами без коллизий ключей и перезаписи кольца `Gemini`.
- [ ] В `runAgyUsage` (`src/agent/antigravity/quota.ts:83-101`) захватывать `stderr` при ненулевом коде возврата `execFile`, вычищать префикс `error: `/управляющие символы и выбрасывать информативный `Error` (например, `Eligibility check failed: ... not currently available in your location`), а также добавить предикат `isAgyAuthError(errOrOutput)` для различения реального разлогина (`not logged in` / `authentication required`) от сетевых и региональных сбоев `aicode.googleapis.com`.
- [ ] Перевести `AgyQuotaService` (`src/extension/agyQuota.ts`) на модель состояний по образцу `CodexLimitsService`:
  - расширить `AgyQuotaSnapshot` полями `state: 'loading' | 'ok' | 'signedOut' | 'missing' | 'error'` и `error?: string`;
  - при ошибке запуска/eligibility сохранять предыдущие `rows` и `updatedAt`, выставлять `state: 'error'` и `error`, уведомлять `listeners`, логировать предупреждение и использовать короткий кулдаун повтора `AGY_QUOTA_ERROR_COOLDOWN_MS = 60_000` (вместо 10-минутной блокировки `AGY_QUOTA_INTERVAL_MS`), а также поддержать `refresh(force?: boolean)` для ручного обновления из UI (`case 'limits.refresh'` в `chatController.ts:891`);
  - не затирать непустые `this.last.rows` в `signedOut`, если процесс завершился с пустым выводом без явного признака разлогина.
- [ ] Обновить `summarizeAgy` (`src/extension/engineLimits.ts:29-46`) и `quota.update` / `quotaView` (`src/protocol.ts`, `src/extension/chatController.ts:1566-1571`, `src/webview/hudView.ts`), чтобы `EngineLimits` в боковой панели показывал `state: 'error'` с текстом причины (вместо бесконечного `loading`), а HUD чата отображал диагностический тултип/индикатор сбоя обновления квоты.
- [ ] Покрыть unit-тестами в `adapter.test.ts`, `models.test.ts`, `quota.test.ts`, `agyQuota.test.ts`, `engineLimits.test.ts` и `hudView.test.ts` (включая сценарий `EXIT:1` с `Eligibility check failed` на холодном старте и поверх ранее закэшированных `rows`, соседство `Gemini Models` + `Gemini 4 Carbon`, `refresh(true)` после ошибки).

**Готово, когда:** `npx vitest run src/agent/antigravity/ src/extension/agyQuota.test.ts src/extension/engineLimits.test.ts src/webview/hudView.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** ввод `/` показывает команды `agy`; в селекте моделей доступен `Gemini 4 Carbon`; при недоступности `aicode.googleapis.com` панель лимитов вместо вечной загрузки показывает точный текст ошибки `Eligibility check failed...`, а после восстановления маршрута обновляет лимиты Gemini по кнопке обновления или через минуту.

**Исполнение:** последовательно после этапа 1.

---

### 3. Инструменты `oneharness` в ленте (`MCP`, субагенты, задачи) и открытие `conversation://<uuid>` во вкладке Agentura

**Файлы:** `src/agent/antigravity/tools.ts`, `src/agent/antigravity/tools.test.ts`, `src/webview/toolView.ts`, `src/webview/toolView.test.ts`, `src/webview/markdown.ts`, `src/webview/markdown.test.ts`, `src/extension/chatController.ts`, `src/extension/chatController.test.ts`.

- [ ] Расширить `mapAgyTool` в `src/agent/antigravity/tools.ts`:
  - **Lazy MCP (`call_mcp_tool`, `list_resources`, `read_resource`):** при наличии `ServerName` маппить в `mcp__<ServerName>__<ToolName>` / `list_resources` / `read_resource` с распаковкой аргументов, чтобы `toolView` рендерил чип сервера (`op: 'mcp', server`) и инкрементировал `counts.mcp`.
  - **Eager MCP (`mcp_<server>_<tool>`):** конвертировать одиночный префикс `mcp_` в канонический `mcp__<server>__<tool>` с аккуратным выделением серверного префикса и безопасным фолбэком.
  - **Субагенты (`invoke_subagent`, `define_subagent`, `manage_subagents`, `send_message`, `swarm`):** маппить `invoke_subagent` в карточку `Agent` (`{ name: 'Agent', input: compact({ description: Role ?? TypeName, prompt: Prompt, subagent_type: TypeName, model: Model }) }`), а для `manage_subagents` / `send_message` / `manage_task` / `schedule` / `swarm` формировать понятные подписи в `toolView.ts` (при наличии `waiting_for_input` в результате `manage_subagents` — явно отображать статус ожидания подтверждения).
- [ ] Поддержать переход по ссылкам `conversation://<uuid>` в дочерние сессии Antigravity:
  - в `src/webview/markdown.ts:35-40` разрешить в `DOMPurify` безопасную схему `conversation://` (наряду со стандартными URI, не ослабляя запрет на `javascript:`/`data:`/`vbscript:`/`command:`);
  - в `src/extension/chatController.ts:807-839` (`case 'link.open'`) перед проверкой локальных путей перехватывать `^conversation:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$`: вызывать `deps.openSession?.(uuid, this.engineProvider === 'antigravity' ? 'antigravity' : ...)` (только для валидного UUID, с отказом на произвольные пути/параметры).
- [ ] Покрыть тестами в `tools.test.ts`, `toolView.test.ts`, `markdown.test.ts` и `chatController.test.ts` (чипы MCP, `invoke_subagent` → `Agent`, сохранение `Read` на `SKILL.md`, клик по `conversation://<uuid>` открывает сессию, невалидный `conversation://../etc/passwd` и `command:` блокируются).

**Готово, когда:** `npx vitest run src/agent/antigravity/tools.test.ts src/webview/toolView.test.ts src/webview/markdown.test.ts src/extension/chatController.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** вызов MCP отображается с чипом сервера, `invoke_subagent` — карточкой `Agent`, а клик по ссылке `[Subagent](conversation://<uuid>)` в ответе открывает вкладку с транскриптом этого субагента.

**Исполнение:** последовательно после этапа 2 (пересекается с `chatController.ts`).

---

### 4. Наследование прав родителя дочерними субагентами (`--dangerously-skip-permissions` и режим `auto`)

**Файлы:** `src/agent/antigravity/acpProtocol.ts`, `src/agent/antigravity/acpProtocol.test.ts` (или `adapter.test.ts`), `src/agent/antigravity/adapter.ts`, `src/agent/antigravity/adapter.test.ts`, `src/agent/antigravity/fakeServer.ts`.

- [ ] Расширить протокольный маппинг режимов в `src/agent/antigravity/acpProtocol.ts:192-209`:
  - добавить `'auto'` в `AgyServerMode` (`'default' | 'accept-edits' | 'auto' | 'plan'`) и парсер списка доступных серверных режимов `availableModesOf(result: unknown): AgyServerMode[]` из `modes.availableModes` ответа `session/new` / `session/resume`;
  - обновить `permissionModeOf(modeId)` (чтобы серверный `'auto'` не сбрасывался в `'default'`, а корректно маппился без потери режима при `session/resume`) и `agyModeId(mode, allowBypass, availableModes)` (если в `acceptEdits` или при будущем расширении выбран серверный режим, учитывать наличие `'auto'` в `availableModes`).
- [ ] Реализовать полноценное серверное наследование `bypassPermissions` для дочерних субагентов в `AgySession` (`src/agent/antigravity/adapter.ts:413-430,570-595`):
  - вынести вычисление аргументов спавна `agySpawnArgs(permissionMode, allowBypass)`: возвращать `['acp', '--dangerously-skip-permissions']`, когда `permissionMode === 'bypassPermissions' && allowBypass`, и `['acp']` во всех остальных режимах;
  - передавать эти аргументы при первичном старте воркера в `createSession` и `resumeSession`, чтобы все дочерние субагенты (`invoke_subagent`) и операции в git worktree наследовали права родителя без зависания в `waiting_for_input`;
  - в `setMode(next)` отслеживать смену флага `needsBypassFlag` (`(this.permissionMode === 'bypassPermissions' && this.allowBypass)` ↔ другое значение): если ход сейчас не идёт (`!this.turn && !this.loading && this.id`), штатно закрывать текущий процесс `agy acp` и прозрачно перезапускать его через `session/resume` с новым набором аргументов CLI и прежними `this.id`, `this.model`, `this.effort` (без сброса вкладки в UI); если же `setMode` вызван посреди активного хода, выставлять флаг отложенного перезапуска `pendingRespawn` и выполнять прозрачный `session/resume` сразу в `finally` завершения хода (до конца текущего хода сохраняя клиентский авто-ответ в `onRequestPermission`).
- [ ] Расширить `fakeServer.ts` и `src/agent/antigravity/adapter.test.ts`:
  - проверить, что `createSession` / `resumeSession` с `permissionMode: 'bypassPermissions'` и `allowBypass: true` спавнит процесс с `--dangerously-skip-permissions`, а при `allowBypass: false` — строго `['acp']` без флага;
  - проверить переключение `setMode('bypassPermissions')` → `setMode('default')` на живой сессии: старый воркер корректно закрывается, новый поднимается с `session/resume` на том же `sessionId`, сохраняя выбранные модель и `effort`;
  - проверить переключение `setMode` во время активного `send()`: текущий ход не обрывается, перезапуск происходит после завершения хода.

**Готово, когда:** `npx vitest run src/agent/antigravity/adapter.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Ручная проверка:** запустить сессию Antigravity в режиме `Без подтверждений` (`bypassPermissions`) и попросить агента вызвать субагента (`invoke_subagent` `self`) с выполнением `run_command` (например, `git status`) — субагент отрабатывает команду до конца без зависания в `waiting_for_input`. Переключить режим обратно в `Обычный` — сессия продолжает диалог с тем же `sessionId`, а прямые команды снова запрашивают подтверждение.

**Исполнение:** последовательно после этапа 2 (трогает `acpProtocol.ts` и `adapter.ts`).

---

### 5. Документация, `agy-smoke.mjs` и финальная приёмка

**Файлы:** `docs/antigravity-protocol.md`, `README.md`, `README.ru.md`, `scripts/agy-smoke.mjs`.

- [ ] Обновить `docs/antigravity-protocol.md`:
  - зафиксировать проверенную версию `agy 1.5.6` (`gemini-4-carbon`, режим `auto` в `availableModes`, `available_commands_update` → `slashCommands`, перехват `⚠ API error (attempt N)` → `api_retry`, маппинг `oneharness`-инструментов и ссылок `conversation://<uuid>`);
  - задокументировать архитектурное ограничение ACP для субагентов: почему фоновый `invoke_subagent` в режиме `default` переходит в `waiting_for_input` без присылки `session/request_permission` в родительский stdio-поток, и как в Agentura работает наследование прав через `agy acp --dangerously-skip-permissions` (+ перезапуск через `session/resume` при смене режима);
  - задокументировать разницу эндпоинтов `agy acp` (`daily-cloudcode-pa.googleapis.com`) и `agy -p "/usage"` (`aicode.googleapis.com`, `Eligibility check failed` при гео-блокировке маршрута) и почему `/usage` нельзя вызывать через `session/prompt`.
- [ ] Точечно обновить раздел Antigravity в `README.md` (строго EN) и `README.ru.md` (строго RU): автодополнение `/`, чипы MCP/субагентов и кликабельные ссылки `conversation://`, наследование прав субагентами в `bypassPermissions` и диагностика ошибок квоты `/usage` (не задевая соседние секции).
- [ ] В `scripts/agy-smoke.mjs` добавить проверку непустого `session.init.slashCommands` на холодном старте `agy acp` (без отправки `session/prompt` и без расхода квоты).
- [ ] Выполнить полную проверку репозитория: `TZ=UTC npm run check`, `npm run test:integration`, `node scripts/agy-smoke.mjs` (при залогиненном `agy`) и `git diff --check`.

**Готово, когда:** `TZ=UTC npm run check`, `npm run test:integration`, `node scripts/agy-smoke.mjs` и `git diff --check` завершаются с кодом `0`.

**Ручная проверка:** контрольный прогон пунктов из этапов 1–4 в окне Extension Development Host (`F5`).

**Исполнение:** строго после приёмки этапов 1–4.

## Промты исполнителей

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 1 — перехват транзиентных ретраев `agy acp` (`⚠ API error (attempt N): ...`) в сворачиваемую плашку `api_retry` вместо склейки в текст ответа.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md;
- src/agent/antigravity/acpMapper.ts:40-103, src/agent/antigravity/acpMapper.test.ts;
- src/agent/claude/mapper.ts:363-374, src/shared/l10n.ts:192-196,455-459;
- src/webview/chatState.ts:571-583,704-712,764-773, src/webview/chatState.test.ts:609-635.
Уже решено:
- Новых типов AgentEvent не вводить: эмитить `{ type: 'error', fatal: false, code: 'api_retry', message }`.
- Вырезать `\n?⚠ API error \(attempt (\d+)\): ([^\n]+)\n?` как из одиночного `agent_message_chunk`, так и из консолидированного чанка с текстом вокруг, закрывая `thinking` и сбрасывая `messageId`, не загрязняя `this.text` (`turn.result.text`).
- В `retryRow` (`chatState.ts`) закрывать открытые `streaming: true` текстовые строки перед новой плашкой `tag: 'retry'`, сохраняя схлопывание серии подряд идущих `api_retry` в одну строку.
Не делать: изменения вне файлов этапа 1, рефакторинг чужих модулей, коммит и push. Не трогай чужие незакоммиченные изменения (`git status -s`).
DoD и проверка:
- `npx vitest run src/agent/antigravity/acpMapper.test.ts src/webview/chatState.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы. Чекбоксы в roadmap сам не ставь.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 2 — подхват `available_commands_update`, устойчивость парсеров моделей/квоты `agy 1.5.6` (`gemini-4-carbon`, `\r`-спиннер) и диагностика сбоев `/usage` (`AgyQuotaService` + `summarizeAgy` + HUD).
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md;
- src/agent/antigravity/acpProtocol.ts:37-76, src/agent/antigravity/adapter.ts:729-796,970-980, src/agent/antigravity/fakeServer.ts, src/agent/antigravity/adapter.test.ts;
- src/agent/antigravity/models.ts:10-61, src/agent/antigravity/models.test.ts;
- src/agent/antigravity/quota.ts, src/agent/antigravity/quota.test.ts;
- src/extension/agyQuota.ts, src/extension/agyQuota.test.ts, src/extension/codexLimits.ts:20-98, src/extension/engineLimits.ts, src/extension/engineLimits.test.ts;
- src/extension/chatController.ts:891-893,1560-1573, src/protocol.ts:340-360,558-576, src/webview/hudView.ts:295-335, src/webview/hudView.test.ts.
Уже решено:
- `available_commands_update` принимать в том числе во время `handshake` и между ходами; отдавать дедуплицированные имена без `/` в `session.init.slashCommands`.
- В `parseModels` и `parseAgyUsage` брать последний сегмент после `\r`, чтобы TTY-спиннер не съедал первую строку.
- В `quota.ts` и `hudView.ts` маппить в общий `'Gemini'` только общий пул (`Gemini Models` / `Gemini`), а именные пулы (`Gemini 4 Argon`, `Gemini 4 Carbon`) оставлять отдельными семействами без перезаписи кольца `Gemini`.
- В `runAgyUsage` читать `stderr` и возвращать чистое сообщение сбоя (например, `Eligibility check failed: ...`); различать разлогин и прочие сбои.
- В `AgyQuotaService` ввести `state` и `error?: string` по образцу `CodexLimitsService`: при ошибке сохранять прежние `rows`/`updatedAt`, уведомлять подписчиков, логировать warn, ставить короткий кулдаун повтора `60_000` мс вместо 10 минут и поддержать `refresh(force?: boolean)` для ручного обновления. Пробросить `state`/`error` в `summarizeAgy` и HUD.
Не делать: отправку `/usage` через `agy acp` `session/prompt` (это тратит квоту LLM), включение `ANTIGRAVITY_FEATURES.skills`, коммит и push. Не трогай чужие изменения.
DoD и проверка:
- `npx vitest run src/agent/antigravity/ src/extension/agyQuota.test.ts src/extension/engineLimits.test.ts src/webview/hudView.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 3 — маппинг `oneharness`-инструментов `agy` (`MCP`, субагенты, задачи) в карточки ленты и открытие ссылок `conversation://<uuid>` во вкладке Agentura.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md;
- src/agent/antigravity/tools.ts, src/agent/antigravity/tools.test.ts;
- src/webview/toolView.ts:45-175, src/webview/toolView.test.ts;
- src/webview/markdown.ts, src/webview/markdown.test.ts;
- src/extension/chatController.ts:807-839, src/extension/chatController.test.ts:631-670, src/extension/chatPanel.ts:955-962.
Уже решено:
- `call_mcp_tool`, `list_resources`, `read_resource` и eager `mcp_<server>_<tool>` нормализовать к `mcp__<server>__<tool>`, чтобы штатно работали чипы MCP (`op: 'mcp', server`) и `counts.mcp`.
- `invoke_subagent` маппить в `Agent` (`description: Role ?? TypeName`, `prompt: Prompt`), а для `manage_subagents`, `send_message`, `manage_task`, `schedule`, `swarm` вывести читабельные подписи (явно подсвечивая `waiting_for_input` в статусе субагентов).
- Обычный `read_file` на `SKILL.md` оставлять карточкой `Read`.
- В `markdown.ts` разрешить схему `conversation://` в DOMPurify (без ослабления запрета опасных схем), а в `chatController.ts` (`case 'link.open'`) открывать строго валидный `^conversation:\/\/([0-9a-f-]{36})\/?$` через `deps.openSession(uuid, 'antigravity')`.
Не делать: включение `ANTIGRAVITY_FEATURES.subagents`, разрешение произвольных схем (`command:`, `javascript:`, `file://`), коммит и push. Не трогай чужие изменения.
DoD и проверка:
- `npx vitest run src/agent/antigravity/tools.test.ts src/webview/toolView.test.ts src/webview/markdown.test.ts src/extension/chatController.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы.
```

### Этап 4

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 4 — наследование прав родителя дочерними субагентами (`agy acp --dangerously-skip-permissions` при `bypassPermissions` с перезапуском через `session/resume` + учёт серверного режима `auto`).
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md;
- src/agent/antigravity/acpProtocol.ts:185-215, src/agent/antigravity/adapter.ts:365-605,725-880,995-1030;
- src/agent/antigravity/fakeServer.ts, src/agent/antigravity/adapter.test.ts.
Уже решено:
- Расширить `AgyServerMode` значением `'auto'`, разбирать `modes.availableModes` из `session/new` и `session/resume`, не сбрасывать `'auto'` в `'default'` при `permissionModeOf`.
- Когда `permissionMode === 'bypassPermissions' && allowBypass`, спавнить процесс `agy` с аргументами `['acp', '--dangerously-skip-permissions']` (иначе строго `['acp']`), чтобы дочерние субагенты (`invoke_subagent`) наследовали авто-одобрение на стороне сервера `agy` и не зависали в `waiting_for_input`.
- При вызове `setMode(next)` со сменой признака `bypassPermissions` вне активного хода штатно закрывать текущий процесс `agy acp` и прозрачно перезапускать его через `session/resume` на том же `sessionId` (сохраняя `model`, `effort`, `cwd`); если `setMode` вызван во время активного хода — откладывать перезапуск до завершения текущего хода.
Не делать: передачу `--dangerously-skip-permissions` при `allowBypass === false`, потерю `sessionId`/`model`/`effort` при смене режима, коммит и push. Не трогай чужие изменения.
DoD и проверка:
- `npx vitest run src/agent/antigravity/adapter.test.ts` — код 0;
- `npm run typecheck` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, отклонения, вывод проверок, открытые вопросы.
```

### Этап 5

```text
Работаем в /Users/fost/Projects/Agentura. Задача: Roadmap 38, этап 5 — документация (`antigravity-protocol.md`, `README.md`, `README.ru.md`), `scripts/agy-smoke.mjs` и финальная проверка.
Читай:
- AGENTS.md, .codex/WORKFLOW.md, docs/roadmap/38-antigravity-followups.md;
- docs/antigravity-protocol.md, README.md:208-253, README.ru.md, scripts/agy-smoke.mjs;
- актуальный код `src/agent/antigravity/`, `src/extension/agyQuota.ts`, `src/extension/engineLimits.ts`, `src/webview/toolView.ts`.
Уже решено:
- В `docs/antigravity-protocol.md` отразить все факты `agy 1.5.6`: `api_retry`, `available_commands_update`, разницу эндпоинтов `agy acp` vs `agy -p "/usage"` (`aicode.googleapis.com`), наследование прав субагентами через `--dangerously-skip-permissions`, режим `auto` и протокольное ограничение подтверждений фоновых субагентов в `default`-режиме.
- `README.md` строго на английском, `README.ru.md` строго на русском; править только подраздел Antigravity, не задевая чужие незакоммиченные секции.
- В `scripts/agy-smoke.mjs` проверить `slashCommands.length > 0` в стартовом `session.init` без платного `session/prompt`.
Не делать: сборку/установку `.vsix`, коммиты, теги и push без отдельного указания.
DoD и проверка:
- `TZ=UTC npm run check` — код 0;
- `npm run test:integration` — код 0;
- `node scripts/agy-smoke.mjs` — код 0;
- `git diff --check` — код 0.
В отчёте: сделано, результаты всех 4 команд, короткий чеклист ручной проверки в VS Code, открытые вопросы.
```

## Риски и открытые вопросы

- **Подтверждения в фоновых субагентах при режиме `default` / `acceptEdits`:** протокол `agy acp` (`1.5.6`) закрывает клиентский канал разрешений сразу по окончании родительского `session/prompt` и не имеет RPC-метода для подтверждения `waiting_for_input` в дочернем `conversationId`. Поэтому для сценариев, где субагенты обязаны вызывать `run_command` (например, `roadmap-run-agy`), штатное решение — запуск родительской сессии в `bypassPermissions` (с `--dangerously-skip-permissions`) либо использование серверного `auto` для безопасных команд в песочнице; в `default`-режиме клик по `conversation://<uuid>` позволяет открыть транскрипт субагента и увидеть, на каком инструменте он встал.
- **Перезапуск `agy acp` при переключении `bypassPermissions` на лету:** если у родителя в фоне остались незавершённые демоны/субагенты внутри старого процесса `agy acp`, закрытие процесса для смены флага `--dangerously-skip-permissions` остановит фоновых воркеров старого процесса (история на диске сохранится). В `adapter.ts` перезапуск выполняется только вне активного хода (`!this.turn`).
- **Маршрутизация `aicode.googleapis.com` для `/usage`:** даже после добавления индикации ошибки в Agentura сам бинарник `agy -p "/usage"` продолжит требовать доступный с разрешённой геолокацией `aicode.googleapis.com`. При split-tunnel VPN (Wayfork) этот домен должен идти через рабочий туннель с поддерживаемой локацией, как и `daily-cloudcode-pa.googleapis.com`.
- **Разделитель `_` в eager MCP-именах `agy` (`mcp_<serverName>_<toolName>`)** и **незакоммиченный WIP Roadmap 37 в `/Users/fost/Projects/Agentura`:** при наличии чужих незакоммиченных изменений выполнять этапы в отдельном git worktree или после коммита Roadmap 37.

## Порядок работы

Этапы выполняются последовательно `1 → 2 → 3 → 4 → 5`.
- **В Antigravity (`roadmap-run-agy`):** чтобы субагенты могли гонять `vitest` и `typecheck`, запускать после включения `--dangerously-skip-permissions` (либо до релиза Этапа 4 выполнять shell-проверки в основном чате); основной чат принимает diff и команды DoD, ставит `[x]` и обновляет `## Checkpoint`.
- **В Codex (`.codex/WORKFLOW.md`):** последовательно по промтам этапов с приёмкой и чекпоинтом после каждого этапа.
- Коммит, сборка `.vsix` и push — только по явному запросу пользователя.
