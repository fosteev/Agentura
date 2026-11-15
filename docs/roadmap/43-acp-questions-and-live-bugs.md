# 43. Текущие ошибки живых сессий (`0.24.0`): вопросы ACP (`elicitation/create`), субагенты Antigravity (`0.0s` / вечный `идёт`), список и `session.init` Kimi, таймауты старта и квота `agy`

> Статус: реализовано (приняты Шаги 1–4 из 4) · 2026-11-15 (`v0.24.0`, `agy 1.5.9`, `kimi 2.6.0`). Исполнитель не ставит чекбоксы — `[x]` отмечает приёмщик по факту прохождения проверок.

## Checkpoint

- **Принятый этап:** Шаг 4 («Успокоить повторные `[warning]` и короткий статус `Eligibility check failed` в `agyQuota.ts` / `usage.ts` + смягчить таймаут `listSessions` и пустой вкладки на холодном старте»), попыток приёмки: 1. Все 4 этапа (Шаги 1–4) приняты с первой попытки: Шаг 1 (попыток: 1), Шаг 2 (попыток: 1), Шаг 3 (попыток: 1), Шаг 4 (попыток: 1).
- **Изменённые файлы по всему roadmap 43 (29 файлов):** `src/agent/antigravity/acpMapper.ts`, `src/agent/antigravity/acpMapper.test.ts`, `src/agent/antigravity/adapter.ts`, `src/agent/antigravity/adapter.test.ts`, `src/agent/antigravity/fakeServer.ts`, `src/agent/antigravity/history.ts`, `src/agent/antigravity/quota.ts`, `src/agent/antigravity/quota.test.ts`, `src/agent/antigravity/subagents.ts`, `src/agent/antigravity/subagents.test.ts`, `src/agent/cursor/adapter.ts`, `src/agent/cursor/adapter.test.ts`, `src/agent/kimi/adapter.ts`, `src/agent/kimi/adapter.test.ts`, `src/agent/kimi/history.test.ts`, `src/agent/kimi/interactive.test.ts`, `src/agent/kimi/subagents.ts`, `src/agent/kimi/subagents.test.ts`, `src/extension/agyQuota.ts`, `src/extension/agyQuota.test.ts`, `src/extension/chatController.ts`, `src/extension/chatController.test.ts`, `src/extension/extension.ts`, `src/extension/sidebarView.ts`, `src/extension/usage.ts`, `src/extension/usage.test.ts`, `src/shared/l10n.ts`, `src/webview/hudState.ts`, `src/webview/hudState.test.ts`.
- **Ветка / worktree / подтверждённый `cwd`:** `main` (`main...origin/main`), основной worktree `/Users/fost/Projects/Agentura` (`pwd` подтверждён).
- **Проверки (независимо основным чатом):**
  - `TZ=UTC npm run check` → `0` (`tsc --noEmit`, `eslint .`, `vitest run` — 175 файлов / 2569 тестов, `node esbuild.mjs`);
  - `git diff --check` → `0`.
- **Runtime / модели:** основной чат AGY — `Gemini 4 Carbon (Medium)` (`8cf69270-b659-414f-ac41-035ec4b0e917`); исполнители (`invoke_subagent(TypeName: "self", Model: "flash", Workspace: "inherit")`): Шаг 1 — `ffed7e1b-1f9e-40fa-8dab-1eb740f0a301`, Шаг 2 — `2f375da1-c198-4e26-babc-1d8c4d7409b3`, Шаг 3 — `6d3154fe-a003-4e76-ad06-c16b36117514`, Шаг 4 — `44db81f7-f4e8-428b-ab38-7747fc6d3b29`.
- **Dirty / unpushed:** 29 модифицированных файлов Шагов 1–4 в working tree (не индексированы и не закоммичены); локальные `.codex/config.toml`, `docs/roadmap/43-acp-questions-and-live-bugs.md` вне индекса.
- **Блокер:** нет.
- **Следующий шаг:** ручная дымовая проверка в Extension Development Host (`F5`) либо коммит / сборка `.vsix` по команде пользователя.
- **Промт кросс-клиентской проверки:** `Прими целиком docs/roadmap/43-acp-questions-and-live-bugs.md в /Users/fost/Projects/Agentura (/plan-review): сверь git diff по всем 4 шагам («Ошибка 1»–«Ошибка 4»), убедись что .codex/config.toml не затронут и ничего не проиндексировано, прогони TZ=UTC npm run check && git diff --check.`

## Контекст и источники фактов

Разбор собран по реальным сбоям в сессиях `a7f1724b-0c3d-4515-b63c-cfb5f80450b6` (ход `/roadmap` `11:50:37`–`12:04:38`), `879f1d8d-4ccc-43a8-b84c-1a9df647c465` (прогон `/roadmap-run-agy` с тремя субагентами `75c6c3a9`, `862a53bf`, `d9618efd`, скриншот в `12:19:30`) и повторному воспроизведению в `75df8b5a-f029-4e29-b482-30f573972d40` (прогон `/roadmap-run-agy 42` с четырьмя субагентами `4d8ea621`, `3808dc34`, `f4e8a7ff`, `602f0e39` и реплеем истории при отправке `"комитим и пушим"` в `15:40:06`), логам четырёх открытых окон VS Code (`~/Library/Application Support/Code/logs/20261114T190119/window{1..4}/exthost/fosteev.agentura/Agentura.log`), транскриптам `agy` (`brain/{a7f1724b,879f1d8d,75df8b5a,...}/.system_generated/logs/transcript.jsonl`) и актуальному коду `main`.

---

## Ошибка 1 (критичная). Вопросы `ask_question` (`elicitation/create`) и вечное зависание «ждёт ответа» в Antigravity ACP и Kimi ACP

### Симптомы
1. Агент вызывает `ask_question` во время хода, статус вкладки, строки сайдбара и HUD переключается в **«ждёт ответа»** (`waiting`), но к моменту просмотра чата внизу ленты вопроса нет — там уже лежит готовый финальный ответ агента.
2. Статус **«ждёт ответа»** остаётся висеть навсегда даже после успешного `turn.result` (`ход завершён: ok`).
3. Даже если пользователь успевает увидеть карточку вопроса во время 60-секундного окна:
   - после выбора ответа и нажатия «Ответить» карточка застревает в промежуточном состоянии `sent`, а статус «ждёт ответа» не снимается;
   - кнопка «Отклонить» и клавиша `Esc` на карточке вопроса вообще не отправляют отказ в движок.

### Хронология по логам (`a7f1724b`)
- `11:58:35` (`transcript.jsonl`, шаг `189`–`190`): вызов `ask_question` с двумя вопросами.
- `11:58:37.122` (`window2/.../Agentura.log:168`): `agy acp` присылает `elicitation/create` → `AgySession.handleElicitationRequest` эмитит `question.request`, карточка встаёт в середину идущего хода.
- `11:59:35` (ровно **60.0 с** спустя): сервер `agy acp` по внутреннему 60-секундному таймауту прекращает ждать ответ на `elicitation/create`, автоматически подставляет первые `(Recommended)` варианты (`A1`, `A2`) и продолжает тот же ход.
- `11:59:35`–`12:04:38.382`: агент выполняет ещё ~15 вызовов инструментов, пишет `docs/roadmap/42-sidebar-redesign.md` и завершает ход финальным ответом. Автоскролл (`useStickToBottom`) уводит ленту вниз к итогу, оставляя карточку вопроса погребённой выше в середине хода, а сессию — навечно в статусе `'waiting'`.

### Точные причины в коде
В архитектуре статусов Agentura:
- `updatePending` (`src/agent/status.ts:69-82`) добавляет `toolUseId` на `permission.request`, `question.request` и `plan.request`, а удаляет **только** по `permission.resolved` (или `session.closed`).
- `nextStatus` (`src/agent/status.ts:36-38`) на `turn.result` возвращает `pending > 0 ? 'waiting' : 'idle'`.
- Аналогично устроены `hudState.waiting` (`src/webview/hudState.ts:338-352`), `ChatController.pendingRequests` (`src/extension/chatController.ts:1983-1991`) и `resolveCard` в ленте (`src/webview/chatState.ts:839-866`).

В Claude (`src/agent/claude/permissions.ts:186-190, 215-244`) и ответ, и отмена вопроса проходят через `finish`/`cancel` с эмитом `permission.resolved`. В Antigravity и Kimi пропущены все три ветки закрытия вопроса:

1. **Ответ пользователя не эмитит `permission.resolved`:**
   - `AgySession.answerQuestion` (`src/agent/antigravity/adapter.ts:669-679`) шлёт `this.client.respond(p.id, res)`, но не эмитит `{ type: 'permission.resolved', toolUseId, decision: 'allow', by: 'user' }`.
   - `KimiSession.answerQuestion` (`src/agent/kimi/adapter.ts:423-438`) в обеих ветках (`question` и `questionFallback`) отвечает в RPC, но не эмитит `permission.resolved`.
2. **Отказ от вопроса («Отклонить» / `Esc`) не обрабатывается:**
   - Фронтенд в `declineQuestion` (`src/webview/store.ts:1148-1159`) отправляет `{ type: 'permission.respond', sessionId, toolUseId, decision: 'deny' }`.
   - `AgySession.respondPermission` (`src/agent/antigravity/adapter.ts:645-648`) ищет `toolUseId` только в `this.pendingPermissions` и возвращает `false`, игнорируя `this.pendingQuestions` (должен отвечать `elicitationDecline()` и эмитить `permission.resolved` с `decision: 'deny', by: 'user'`).
   - `KimiSession.respondPermission` (`src/agent/kimi/adapter.ts:409-413`) отсекает всё, кроме `pending.kind === 'permission'`, игнорируя `question` (`elicitationDecline()`) и `questionFallback` (`q0_skip` / `reject_once`).
3. **Отмена, серверный таймаут `elicitation/create` и завершение хода не гасят зависшие вопросы:**
   - `AgySession.abortPending` (`src/agent/antigravity/adapter.ts:1612-1619`) шлёт `{ action: 'cancel' }` для `pendingQuestions`, но в отличие от цикла по `pendingPermissions` (строки `1603-1608`) не эмитит `{ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'abort' }`.
   - `KimiSession.settlePending` (`src/agent/kimi/adapter.ts:922-933`) не эмитит `permission.resolved` для `pending.kind === 'question'` (строка `927` пропускает `question`).
   - Когда `agy acp` сам закрывает `ask_question` по 60-секундному таймауту и шлёт терминальный `tool_call_update` / следующие шаги / итог хода в `onNotification` (`src/agent/antigravity/adapter.ts:1484-1492`) и `drain` (`src/agent/antigravity/adapter.ts:1358-1376`), `pendingQuestions` не очищается и не переводит карточку в `cancelled` (`by: 'abort'`).

### Что нужно сделать
- В `AgySession` (`src/agent/antigravity/adapter.ts`):
  - в `answerQuestion` эмитить `{ type: 'permission.resolved', toolUseId, decision: 'allow', by: 'user' }`;
  - в `respondPermission` при `decision === 'deny'` и наличии `toolUseId` в `pendingQuestions` удалять запись, слать `elicitationDecline()`, эмитить `{ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'user' }` и обновлять `scheduleWakeupFinish()`;
  - в `abortPending` эмитить `permission.resolved` (`decision: 'deny', by: 'abort'`) для каждого элемента `pendingQuestions`;
  - при получении терминального `tool_call_update` по `toolCallId` из `pendingQuestions`, при старте следующего шага модели после `ask_question` и в `finally`/завершении хода в `drain` автоматически закрывать протухшие `pendingQuestions` событием `{ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'abort' }` (без повторного `client.respond`, если сервер сам закрыл шаг).
- В `KimiSession` (`src/agent/kimi/adapter.ts`):
  - в `answerQuestion` (ветки `question` и `questionFallback`) эмитить `{ type: 'permission.resolved', toolUseId, decision: 'allow', by: 'user' }`;
  - в `respondPermission` при `decision === 'deny'` поддержать `pending.kind === 'question'` (`elicitationDecline()`) и `questionFallback` (`q0_skip` / `reject_once`) с эмитом `{ type: 'permission.resolved', toolUseId, decision: 'deny', by: 'user' }`;
  - в `settlePending` убрать исключение `if (pending.kind !== 'question')` для эмита `permission.resolved` (`by: 'abort'`) и вызывать зачистку незакрытых `pending` при завершении хода.
- Покрыть unit-тестами в `src/agent/antigravity/adapter.test.ts` и `src/agent/kimi/interactive.test.ts` все 4 сценария: ответ пользователя, отказ (`Esc` / «Отклонить»), отмена хода (`interrupt`) и серверный таймаут `elicitation/create` с продолжением хода до `turn.result` (статус возвращается в `'idle'`).

---

## Ошибка 2. Пустые сессии `session_<uuid>` в сайдбаре и пачка из 6–7 `session.init` в Kimi ACP

### Симптомы
1. В списке «Сессии» боковой панели появляются технические строки вида `session_a6b9fb6b-7f7d-404e-9cd1-...` без заголовка (видно на скриншоте сайдбара и в `Agentura.log`).
2. Каждое открытие пустой вкладки с движком Kimi пишет в `Agentura.log` сразу 6–7 подряд одинаковых событий `session.init` (`window4/.../Agentura.log`, `12:17:54` и `12:32:19`).

### Точные причины в коде
1. **Пустые `session_<uuid>` на диске:**
   - При открытии пустой вкладки чата Kimi поднимает процесс и в `handshake` (`src/agent/kimi/adapter.ts:575`) сразу вызывает `session/new`, который немедленно создаёт пустой каталог сессии в `~/.kimi/sessions/...`.
   - `KimiAdapter.listSessions` (`src/agent/kimi/adapter.ts:167-181`) забирает из `session/list` все записи этого `cwd` без проверки на пустую/неначатую сессию и при пустом `row.title` подставляет сырой `id` (`title: this.index.nameOf(id) ?? (nativeTitle || id)`).
2. **Шторм `session.init` при старте:**
   - В `KimiSession.handshake` (`src/agent/kimi/adapter.ts:591-600`) флаг `this.loading = false` сбрасывается **до** применения стартовых настроек `changeModel`, `changeEffort`, `changeMode`.
   - Каждый из `changeModel` (`:618`), `changeEffort` (`:633`), `changeMode` сам эмитит `buildSessionInit()`, плюс параллельно прилетают серверные уведомления `config_option_update` / `current_mode_update` / `available_commands_update`, которые при `this.loading === false` тоже эмитят `buildSessionInit()`, а в конце `handshake` (`:599`) отправляется ещё один `buildSessionInit()`.

### Что нужно сделать
- В `KimiSession.handshake` (`src/agent/kimi/adapter.ts:590-600`) держать `this.loading = true` до завершения стартовой синхронизации `model` / `effort` / `permissionMode` и `saveSettings()`, чтобы при старте вкладки уходил ровно **один** итоговый `session.init`.
- В `KimiAdapter.listSessions` (`src/agent/kimi/adapter.ts:167-182` и `src/agent/kimi/history.ts`) отсеивать пустые сессии без пользовательских ходов (либо не имеющие `wire.jsonl` / сообщений и пользовательского переименования в `sessionIndex`), как это сделано для пустых черновиков в остальных адаптерах.

---

## Ошибка 3. Таймауты 120 с при параллельном старте нескольких окон и шум ошибок квоты `agy -p /usage`

### Симптомы в `Agentura.log` (`window1`–`window4`)
1. При одновременной активации/пробуждении нескольких окон VS Code (`11:49:26`–`11:51:27`):
   - `agy: listSessions failed: Antigravity RPC session/list timed out after 120000 ms.` (`window1`, `window2`, `window4`);
   - `agy session failed: Antigravity RPC session/new timed out after 120000 ms.` → фатальная карточка ошибки в пустой вкладке чата (`window4:11:51:27`, пользователю пришлось нажимать «Повторить ход» в `11:54:08`);
   - `список сессий Cursor: CursorRpcError: Cursor RPC authenticate timed out after 120000 ms.`
2. Фоновый опрос квоты во всех 4 окнах каждые несколько минут спамит парными предупреждениями:
   - `[warning] квота agy: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.` / `agy -p /usage: no answer`;
   - `[warning] Лимиты не обновились: нет токена Claude Code (войдите в claude)`;
   - длинная английская строка `Eligibility check failed: Your current account is not...` выводится курсивом прямо в блок «Аккаунт и лимиты» боковой панели.

### Причины (подтверждено по `wayforkctl` и `agy -p /usage --log-file`)
- По `wayforkctl status` / `wayforkctl rules` весь список `google` (`*.google.com`, `*.googleapis.com`, `daily-cloudcode-pa.googleapis.com`, `aicode.googleapis.com`) сейчас направлен в туннель **`nederlands-grpc-px3eg199`** (`32244064-FA6D-4CD7-A705-6E3FCB57351C`). Подсеть этого NL-сервера у Google GeoIP размечена как неподдерживаемый регион (RU), поэтому `POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` отвечает `Account ineligible: Your current account is not eligible for Antigravity, because it is not currently available in your location.`
- В `agy acp` и `agy models` этот ответ `loadCodeAssist` пишется только нефатальным предупреждением (`W ... server_oauth.go:133`), поэтому чат и модели работают штатно. Но в режиме `agy -p "/usage"` (`src/agent/antigravity/quota.ts:121-140`) гейт `printmode.go:297` (`Print mode: eligibility check failed`) считает тот же флаг фатальной ошибкой и завершает процесс с `exit 1`, отменяя уже стартовавший запрос `retrieveUserQuotaSummary` (`context canceled`). При сетевых подвисаниях туннеля `loadCodeAssist` висит дольше 35 с и срабатывает сторож `agy -p /usage: no answer`.
- `AgyQuotaService` (`src/extension/agyQuota.ts:22`) трактует `Eligibility check failed` как обычную транзиентную сетевую ошибку с коротким ретраем в 1 минуту (в каждом открытом окне отдельно), а UI сайдбара выводит сырой `stderr` без короткой локализованной формулировки (эта часть UI также учтена в [42-sidebar-redesign.md](file:///Users/fost/Projects/Agentura/docs/roadmap/42-sidebar-redesign.md)).
- При холодном старте/пробуждении сразу нескольких окон каждое окно независимо спавнит одноразовые процессы `agy acp` для `listSessions`, `agy -p /usage`, `agent acp` для `listSessions` и боевой `agy acp` для открытой вкладки; на фоне обрыва VPN (`broken pipe` в `11:51`–`11:55`) `session/new` пустой вкладки без автоповтора роняет вкладку в `fatal`.

### Что нужно сделать
- Для `Eligibility check failed` в `src/agent/antigravity/quota.ts` и `src/extension/agyQuota.ts`:
  - возвращать короткую понятную диагностику для UI (вместо простыни английского `stderr`), не дёргать минутный ретрай как при сетевом флапе (оставить штатный редкий интервал или обновление по кнопке `↻`), не дублировать одинаковый `[warning]` в лог на каждый тик без смены текста ошибки (аналогично для `нет токена Claude Code` в `UsageService`).
- Для холодного `session/list` (`AntigravityAdapter.listSessions`, `CursorAdapter.listSessions`) уменьшить таймаут фонового листинга (не держать висящий процесс 120 с) и при таймауте `session/new` в ещё пустой непритронутой вкладке (`pristine`) пересоздавать сессию прозрачно при первой отправке сообщения вместо мгновенного `fatal`-экрана в пустом чате.

---

## Ошибка 4 (критичная). Субагенты Antigravity в живой сессии: перезапись/реплей состояния истории при отправке нового сообщения, `0.0s` в чате, «вечно работающий» субагент (`идёт 18m 48s` / `ход 1 · идёт 614m`) и порча summary

### Симптомы (сессии `879f1d8d` и `75df8b5a`)
1. **При отправке любого нового сообщения после тихих реактивных ходов обновляется/дублируется состояние истории чата и панели агентов:** сразу под новой репликой пользователя в ленту повторно вываливаются все промежуточные реактивные ходы (мысли, вызовы инструментов, отчёты, карточки `AgentGroup`), а завершённые субагенты и прошлый ход в правой панели откатываются обратно в статус `◐ идёт` с обнулёнными таймкодами `0.0`.
2. **В ленте чата** карточки `AgentGroup` для `Stage 2 Dom Executor` и `Stage 3 Build Verifier` показывают время **`0.0s`** (и в шапке группы, и в строке агента), без токенов и без строки итога, а все соседние плашки размышлений показывают `think 0.0s`.
3. **В правой панели (`агенты 1/1`)**:
   - первый субагент (`Stage 1 Storage Executor`, `75c6c3a9`), реально завершивший оба раунда ещё в `01:43:10` ночи, висит в статусе **`◐ идёт 18m 48s`** с промптом `Приёмка Этапа 1 не пройдена (попытка 1/2)...`, а у всех его 81 вызовов слева стоит относительный таймкод **`0.0`**;
   - шапка хода показывает **`▾ ход 1 · 02:05 · идёт 614m 23s  338k`**, хотя основной агент стоит в `ждёт задачу` и в чате уже прошло три пользовательских сообщения;
   - у завершённых `Stage 2` (`12m 16s`) и `Stage 3` (`6m 26s`) вместо отчёта выведено **`→ not actually sent by the ...`**.

### Хронология по `Agentura.log` и `transcript.jsonl` (`879f1d8d` и повтор в `75df8b5a`)
- **`879f1d8d` (`window1/.../Agentura.log`):**
  - **`01:23:29`–`01:26:54.327` (`Agentura.log:63`):** пользовательский ход 1 (`/roadmap-run-agy`) спавнит `Stage 1` (`step=48..49`) и завершает RPC `session/prompt` на шаге `50`.
  - **`01:39:07`–`02:07:05` (`Agentura.log:67, 70, 74, 75`):** пока `session/prompt` не активен, `agy acp` не шлёт `session/update` наружу при реактивных пробуждениях от субагентов, но выполняет шаги `51`–`119` и пишет их в `transcript.jsonl`. Их штатно вычитывает `AgyParentTranscriptTailer.pollSilentTurn` (`src/agent/antigravity/adapter.ts:2051-2089`), создавая узлы `agy-parent:81:0` (`12m 16s`) и `agy-parent:99:0` (`6m 26s`). К `02:07:05` все три субагента завершены (`0/3`), `lastStepIndex = 119`.
  - **`12:00:41.657` (`Agentura.log:127`, пользователь отправляет `"закомить и запуш"`, шаг `120`):** `AgySession.drain` (`src/agent/antigravity/adapter.ts:1310-1312`) вызывает `this.parentToolReader?.clearUnclaimed()`. Сервер `agy acp`, чей собственный курсор неотправленных по ACP шагов оставался на шаге `50`, **перед стримингом нового хода (`121`–`127`) залпом выплёскивает в поток `session/update` все ночные реактивные шаги `52`–`119`** уже с идентификаторами `call_*` и без временных меток. Ровно в `12:00:42` (`12:19:30 - 18m 48s = 12:00:42`) этот повтор дублирует ночные карточки в конец ленты чата с `0.0s` и переоткрывает `Stage 1` старым `send_message` из шага `61`.
- **Повторное воспроизведение 1:1 в `75df8b5a` (`window2/.../Agentura.log:199-239`, `transcript.jsonl` шаги `0`–`159`):**
  - **`13:01:28`–`13:03:57.629`:** пользовательский ход 1 (`/roadmap-run-agy 42`) спавнит `Stage 1` (`4d8ea621`, шаг `28`) и завершает `session/prompt` на шаге `30`.
  - **`13:44:02`–`15:13:20.500`:** проходят **6 тихих реактивных ходов** (116 шагов `31`–`146` в `transcript.jsonl`, отрисованных через `pollSilentTurn`): спавн `Stage 2` (`3808dc34`, шаг `53`), возврат правок `send_message` (шаг `70`), спавн `Stage 3` (`f4e8a7ff`, шаг `85`), возврат правок `send_message` (шаг `108`), спавн `Stage 4` (`602f0e39`, шаг `127`) и финальный отчёт на шаге `146`.
  - **`15:40:06` (`transcript.jsonl` шаг `147`, пользователь пишет `"комитим и пушим"`):** при вызове `session/prompt` сервер `agy acp` вываливает с застрявшего курсора `30` все **116 шагов (`31`–`146`)** в `session/update` поверх нового сообщения перед шагами `148`–`159`, повторно перекрашивая ленту истории и повторно вызывая `reopenByUuid` по обоим старым `send_message` (`70` и `108`) на давно завершённых `Stage 2` и `Stage 3`.

### Точные причины в коде
1. **Повторный сброс в поток ACP уже показанных тихих шагов (`transcript.jsonl` ↔ `session/prompt`):**
   - `AgySession` читает реактивные шаги из `transcript.jsonl` через `pollSilentTurn`, но живой процесс `agy acp` не знает об этом и при следующем `session/prompt` досылает шаги `52`–`119` как обычные `session/update` (`src/agent/antigravity/adapter.ts:1318-1359, 1476-1515`), повторно вставляя сообщения/карточки в `ChatState` и повторно исполняя побочные эффекты в `handleParentToolEvent` (`:2107-2218`).
2. **`0.0s` в карточках `AgentGroup` и `think 0.0s` в ленте чата:**
   - **Отсутствуют `at` и `durationMs` в живом маппере ACP:** `AgyAcpMapper` (`src/agent/antigravity/acpMapper.ts:34-37, 169-176, 218-246`) хранит в `ToolState` только `{ name, input }` и не передаёт `at` / `durationMs` ни в `tool.start` / `tool.result`, ни в `thinking.start` / `thinking.stop`. Поэтому в `ChatState` (`src/webview/chatState.ts:612-613`) у любого живого ACP-вызова `FeedRow.durationMs === undefined`.
   - **Разрыв связки `FeedRow.toolUseId` ↔ `HudState.agents`:**
     - `matchesInvokeCall` (`src/agent/antigravity/subagents.ts:2018-2032`) сравнивает `query.prompt !== candidate.prompt` строгим равенством, тогда как живой `agy acp` шлёт полный `Prompt` (`8179` / `7124` / `2938` символов), а компактный `transcript.jsonl` усекает `tool_calls` до ~`1.6` КБ (`"truncated_fields": ["tool_calls"]`) — для промптов длиннее ~1.5 КБ сопоставление **всегда возвращает `false`**;
     - `launchSubagentReader` (`src/agent/antigravity/adapter.ts:1855`) при повторном/альтернативном `toolUseId` для уже известного `childUuid` просто делает `return`, а `clearUnclaimed()` (`:1311`) перед новым ходом стирает буфер `parentToolReader`. В итоге в `agentsView.ts:166, 198` `byId.get(r.toolUseId)` равен `undefined`, и карточка падает на фолбэк `r.durationMs ?? 0` → **`0.0s`**.
3. **«Вечно работающий» субагент (`Stage 1 · идёт 18m 48s`, `агенты 1/1`) и `ход 1 · 02:05 · идёт 614m 23s`:**
   - В `handleParentToolEvent` (`src/agent/antigravity/adapter.ts:2161-2178`) приход `send_message` безусловно вызывает `reader.reopenByUuid(recipient, event.at, msg)` (с `event.at === undefined` → `Date.now()` = `12:00:42`).
   - `AgySubagentReader.reopen` (`src/agent/antigravity/subagents.ts:763-771`) без проверки прогресса дочернего транскрипта ставит `roundCompleted = false` и перезаписывает `startedAt = now` (ломая относительные метки `entry.at - a.startedAt` → `0.0` у прошлых вызовов), а `poll()` (`:814-816`) на `lines.length === 0` сразу возвращает `[]`, оставляя уже дочитанный до EOF (`step=165` с `01:43:10`) субагент навечно в `status: 'running'`.
   - В `agentTurns` (`src/webview/agentViews.ts:228-236`) один зависший `status === 'running'` в `turnNo = 1` делает весь `ход 1` «идущим» (`live = true`) и держит вечный секундный `setInterval` в `src/webview/components/Chat.tsx:238`.
   - В `src/webview/hudState.ts:15, 369-375` каждый тихий реактивный `turn.start` (без `e.prompt`) переиспользует `turnNo = 1`, но пушит новую запись `{ turnNo: 1, startedAt: e.at }` в `s.turns.slice(-KEEP_TURNS)` (`KEEP_TURNS = 4`), вытесняя исходный старт `01:23:29` и подменяя его последним ночным ходом `02:05:07` (`12:19:30 - 02:05:07 = 614m 23s`).
4. **Мусор `→ not actually sent by the ...` вместо summary у завершённых субагентов:**
   - В `src/agent/antigravity/subagents.ts:14, 470-496` регулярка `SYSTEM_MSG_BLOCK_RE = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/gi` матчится от **первого** литерала `<SYSTEM_MESSAGE>` прямо внутри английской преамбулы `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system...`. Из-за этого `MESSAGE_PREFIX_RE` (`/^\[Message\].../`) не срабатывает, в `msg.body` уходит кусок преамбулы, и в `pickSummary` (`:1071-1075`) он перетирает реальный отчёт субагента по длине строки.

### Что нужно сделать
- **Синхронизация курсора `agy acp` и подавление реплея тихих ходов (`src/agent/antigravity/adapter.ts`):**
  - отслеживать флаг эмита тихих реактивных шагов из `parentTailer` с момента последнего `session/prompt`;
  - если к началу следующего `session/prompt` такие тихие шаги были и **нет активных фоновых субагентов/задач** (`!this.hasActiveSubagents() && !this.parentTailer?.hasPendingReactiveWork()`), выполнять прозрачный `respawnTransport()` (`session/resume` под `this.loading = true` без `session.reset` / `session.history`), сдвигающий внутренний курсор `agy acp` на актуальный конец истории;
  - если же фоновые субагенты или задачи ещё живы (убивать `proc` через `respawnTransport()` нельзя), в `onNotification` на открытом `turn` отбрасывать досылаемый реплей старых тихих шагов до прихода эха текущего промпта (`user_message_chunk`), не пропуская его ни в `AgyAcpMapper`, ни в `handleParentToolEvent`.
- **Тайминги в `AgyAcpMapper` (`src/agent/antigravity/acpMapper.ts`):**
  - добавить инжектируемые часы `now: () => number = Date.now`, сохранять `startedAt` в `ToolState` и для открытого `thoughtId`; проставлять `at` в `tool.start`, `at` + `durationMs` в `tool.result` и `at` в `thinking.start` / `thinking.stop`.
- **Сопоставление `Prompt` и защита `reopen` (`src/agent/antigravity/subagents.ts`):**
  - в `matchesInvokeCall` учитывать усечение `args.Prompt` в компактном `transcript.jsonl` (`truncated_fields: ["tool_calls"]`): отрезать маркер усечения и сверять общий префикс (либо дочитывать строку `transcript_full.jsonl`);
  - в `AgySubagentReader` отслеживать число `USER_INPUT`-раундов и таймстемп последнего завершённого ответа дочернего транскрипта: не уводить ридер в вечный `running` при позднем/повторном `send_message`, закрывать раунд при достижении финального ответа/отчёта родителя и не затирать базовый `startedAt` прошлых вызовов при `reopen`;
  - в `extractSystemMessages` обрезать внешнюю преамбулу до последнего открывающего `<SYSTEM_MESSAGE>` (`inner.replace(/^[\s\S]*<SYSTEM_MESSAGE>\s*/i, '')`) и матчить заголовок `/(?:^|\n)\[Message\][^\n]*?\bcontent=([\s\S]*)$/`.
- **Старт хода в HUD (`src/webview/hudState.ts`):**
  - на реактивном `turn.start` без `e.prompt`, продолжающем текущий `turnNo`, сохранять исходный `startedAt` первой записи этого `turnNo` в `s.turns`, не вытесняя его ночными досылами.
- **Тесты:** покрыть все 4 подпункта в `src/agent/antigravity/subagents.test.ts`, `src/agent/antigravity/acpMapper.test.ts`, `src/agent/antigravity/adapter.test.ts` и `src/webview/hudState.test.ts`.

---

## Порядок починки и DoD

Рекомендуемый порядок — отдельными атомарными шагами:
- [x] **Шаг 1 (S, приоритет 1):** Починить `question.request` / `permission.resolved` / `declineQuestion` / автозакрытие по серверному таймауту и концу хода в `src/agent/antigravity/adapter.ts` и `src/agent/kimi/adapter.ts` + unit-тесты.
- [x] **Шаг 2 (M, приоритет 1):** Починить субагенты и тихие ходы Antigravity (`extractSystemMessages`, усечённый `Prompt` в `matchesInvokeCall`, `at`/`durationMs` в `AgyAcpMapper`, синхронизацию `respawnTransport` после тихих ходов, защиту `AgySubagentReader.reopen` от вечного `running` и сохранение `startedAt` хода в `hudState.turns`) + unit-тесты.
- [x] **Шаг 3 (S):** Убрать шторм `session.init` при `handshake` и фильтрацию пустых `session_<uuid>` в `src/agent/kimi/adapter.ts` + unit-тесты.
- [x] **Шаг 4 (S/M):** Успокоить повторные `[warning]` и короткий статус `Eligibility check failed` в `agyQuota.ts` / `usage.ts` + смягчить таймаут пустой вкладки на холодном старте.

Проверки приёмки:
- `TZ=UTC npm run check`
- `git diff --check`
