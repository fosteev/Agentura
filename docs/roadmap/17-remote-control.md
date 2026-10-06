# 17 — Remote Control (/rc): сессия Claude с телефона и claude.ai

> **Статус:** спайк пройден 2026-10-06; этапы 1–2 приняты 2026-10-06; релиз 0.6.0 собран
> в ветке (README, CHANGELOG, vsix) — мерж в main и тег `v0.6.0` после живой проверки владельцем (pending). Ветка `feature/remote-control` от main. Прототип — `prototype/screens/remote.html`
> (`#slash|#on|#menu`), `settings.html#session`; галерея — раздел «Remote Control · /rc».
> Ручные проверки и решения — `17-remote-control.pending.md`.

## Почему свой мост

Agentura гоняет Claude через Agent SDK (headless, stream-json). Там Remote Control CLI не работает:
`claude -p --remote-control <имя>` флаг молча игнорирует, `/remote-control` промптом отвечает
«isn't available in this environment» (проверено 2026-10-06, CLI 2.1.284).

Рабочий путь — alpha-API моста в SDK 0.3.285: `@anthropic-ai/claude-agent-sdk/bridge`
(`node_modules/@anthropic-ai/claude-agent-sdk/bridge.d.ts` — контракт и комментарии, читать его).
Так это делает официальное расширение: процесс сам создаёт сессию на claude.ai, подключает транспорт
и пересылает сообщения в обе стороны.

Спайк (`scratchpad`, скрипт ~60 строк) проверен с владельцем end-to-end:
- `createCodeSession('https://api.anthropic.com', oauthToken, title, 20000, [], undefined, cwd, model)`
  → `cse_…`;
- `fetchRemoteCredentials(sid, base, oauthToken, 20000)` → `{worker_jwt, api_base_url, expires_in: 46800,
  worker_epoch}`; **trusted-device токен не понадобился**;
- `attachBridgeSession({sessionId, ingressToken: worker_jwt, apiBaseUrl: api_base_url, epoch: worker_epoch,
  onInboundMessage, …})` → handle; `connected = true` через ~30 с, держится;
- `handle.write(SDKAssistantMessage)` + `handle.sendResult()` — текст виден на claude.ai;
- сообщение, набранное на claude.ai, пришло в `onInboundMessage`:
  `{type:'user', message:{role:'user', content:'123'}, uuid, client_platform:'web_claude_ai', …}`
  (эхо наших записей SDK отфильтровывает сам);
- ссылка сессии: `https://claude.ai/code/<cse id>`.

OAuth-токен — тот же, что для лимитов: `readToken()` из `src/data/agentmeter/desktop/token.ts:40`
(файл `~/.claude/.credentials.json`, затем Keychain `Claude Code-credentials`).

## Решения (2026-10-06)

- Только движок Claude (`features.remote`); у Codex и Antigravity кнопки нет.
- Переключатель на вкладку: кнопка «rc» под полем ввода (все 6 раскладок), `/rc` и `/remote-control`.
  Настройка `agentura.remoteControl` (выкл) — включать для каждой новой и восстановленной Claude-вкладки;
  `agentura.remoteControlNamePrefix` (пусто → имя машины) — имя на claude.ai «префикс · заголовок».
- Токен читается при каждом включении и обновлении (его обновляет Claude Code). Настройка
  `agentura.limits.readKeychain` RC не гасит: включение RC — явное действие пользователя.
- Включение посреди сессии истории на claude.ai не повторяет — там видно только то, что после включения
  (известное ограничение, в README).
- Разрешения: каждый `canUseTool` уходит и в ленту, и на claude.ai; кто ответил первым — тот и решил,
  второму запрос снимается. Переход в `bypassPermissions` с claude.ai — только если разрешён
  `agentura.allowBypassPermissions`, иначе отказ.
- Отключение/закрытие вкладки — `flush()` (до 2 с) и `close()`; сессия на claude.ai остаётся в списке.

## Этапы

### 1. Хост: мост, сессия, протокол, настройки — **opus, high**

- [x] `src/agent/claude/remote.ts` — `RemoteBridge`: включение, исходящие, входящие, разрешения, обновление JWT, закрытие
- [x] `ClaudeSession.setRemote(on)`; события `remote.state`, `remote.prompt`; `permission.resolved.by: 'remote'`
- [x] протокол `remote.set`, `ChatController`, включение по настройке
- [x] настройки `agentura.remoteControl`, `agentura.remoteControlNamePrefix` (package.json, nls ×2, settings.ts); `features.remote`
- [x] тесты `remote.test.ts` на фейковом мосте, протокол
- [x] `npm run check` зелёный — принято 2026-10-06: зелёный с прототипом из HEAD; `settingsDom.test.ts` сверяет страницу настроек с `prototype/screens/settings.html`, где уже две строки RC, — краснеет до этапа 2 (прототип коммитится вместе с ним)

Готово, когда: `npm run check` зелёный; тесты покрывают сценарии из промта 1.

### Решения по итогам этапа 1 (2026-10-06)

- `readToken` в конфиге может вернуть Promise: `readOAuthToken()` в `src/data/limits.ts` читает Keychain асинхронно
  (хост не ждёт `security`), без оглядки на `limits.readKeychain`.
- `PermissionObserver.onSettled(toolUseId, by)` — мост сам решает, слать ли cancel (не шлёт на свой же ответ).
- Форма `can_use_tool` к claude.ai собрана по `SDKControlRequest`: `tool_name`, `input`, `tool_use_id`,
  `permission_suggestions`, `title`, `description`, `decision_reason`, `blocked_path`, `agent_id` (= id задачи SDK —
  догадка). Ответ: `response.response` как `PermissionResult`; нет `updatedInput` — исходный input; `error`/непонятный —
  `false` (запрос ждёт повторной доставки). Проверяется только вживую (pending).
- Режимы с claude.ai: кроме bypass без разрешения отклоняются `dontAsk`/`auto` — расширение их не ведёт.
- Каждое включение — новая сессия на claude.ai; старые остаются в списке.
- Приёмка: выбор «rc» во вкладке (`remote.set`) запоминается на вкладку (`ChatController.remoteWanted`) — переживает
  `/clear` и перекрывает настройку; без выбора — `agentura.remoteControl`. Тест в `chatController.test.ts`.
- Известно, не чиним в v1 (в pending): запросы разрешений, открытые до включения моста или во время
  переподключения, на claude.ai не досылаются; одобрение правки с телефона не зовёт `saveBeforeEdit` — грязный буфер
  VS Code покажет конфликт при сохранении; смена модели с claude.ai видна в ленте только через поток движка.

### 2. Webview: кнопка, меню, лента, настройки — **sonnet, high**

- [x] кнопка «rc» и меню (переключатель, QR, ссылка, копирование, пояснение) во всех 6 раскладках
- [x] метка «remote» в шапке, системные строки, «с телефона / с claude.ai» у реплик
- [x] `/rc`, `/remote-control`
- [x] две строки на странице настроек «Новая сессия»
- [x] строки ru/en, CSS, DOM-тесты
- [x] `npm run check` зелёный

Готово, когда: `npm run check` зелёный; DOM-тесты из промта 2 есть и проходят.

### Решения по итогам этапа 2 (2026-10-06)

- Строка «Remote Control для новых сессий» без `.set.on` (в прототипе так) — `.on` у строки подсвечивает только
  предупреждение bypass.
- Вопрос/план, отвеченные с claude.ai, закрываются итогом «ответ отправлен» без выбранных вариантов — webview их не знает.
- QR — `qrcode-generator` (MIT, devDependency, бандлится в webview), путь SVG без innerHTML (`src/webview/qr.ts`).
  Приёмка: тихая зона 4 модуля (viewBox с отступом), размер 112 px — исполнитель дал ~1,7 модуля, камера ловит хуже.
- Вёрстка меню «rc» в раскладках card/minimal/statusline/shell глазами не проверена — в pending.

### 3. Документация и релиз 0.6.0 — **сам (Opus), после приёмки 2**

README.md / README.ru.md (раздел и известные ограничения), CHANGELOG `## 0.6.0`, версия в
package.json, `npm run package`, мерж в main, тег — по политике прошлых релизов.

## Промты

### Промт 1

```
Сессия 1 — Remote Control, хост · Модель: opus, effort: high · первая

Работаем в /Users/fost/Projects/Agentura, ветка feature/remote-control (уже создана, ты на ней).
Задача: поднять мост Remote Control для Claude-сессии в хосте расширения — сессия видна и управляема
с claude.ai/code и телефона. Webview не трогаешь (этап 2), только хост, протокол, настройки, тесты.

Читай: docs/roadmap/17-remote-control.md (разделы «Почему свой мост», «Решения»);
node_modules/@anthropic-ai/claude-agent-sdk/bridge.d.ts целиком (контракт моста, alpha);
в node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts — типы SDKControlRequest, SDKControlResponse,
SDKControlPermissionRequest (или как называется `can_use_tool`), PermissionResult, SDKUserMessage.
Правила репо: AGENTS.md. Комментарии в коде — по-русски, как в соседнем коде.

Точки входа (проверены):
- src/agent/claude/adapter.ts:477 `ClaudeSession`; :479 `input` (AsyncQueue<SDKUserMessage>);
  :535 `sdk.query`; ~:547 `send()` (notePrompt + input.push); ~:664 `pump()` — `for await` по сырым
  SDKMessage (место для зеркалирования); ~:637 `dispose()`, ~:651 `close()`; :204 `loadSdk()` —
  образец динамического import и инъекции через config для тестов.
- src/agent/claude/permissions.ts — `PermissionBroker.canUseTool` (Promise в `pending` по toolUseId),
  `respondPermission`/`answerQuestion`/`decidePlan`, `finish()` эмитит `permission.resolved {by:'user'}`,
  `cancel()` — `by:'abort'`.
- src/agent/types.ts:148 `AgentEvent`; :237 `permission.resolved`; :434 `AgentSession`.
- src/protocol.ts:112 `AGENT_EVENT_TYPES` (новое событие обязано попасть в список — иначе не соберётся);
  :269 `FromWebview`; :449 таблица разрешённых типов.
- src/agent/features.ts:30/49/66 — флаги движков (`compact: true|false`) — добавить `remote`.
- src/extension/chatController.ts:811 `case 'effort.set'` — образец обработки; :1320 `ensureSession`
  (там `provider === 'claude'`); :1584 `teardown()`.
- src/data/agentmeter/desktop/token.ts:40 `readToken({claudeHome, platform})`; как его зовут — src/data/limits.ts:219.
- src/settings.ts:97/124/167/419-447 — ключи, типы, чтение; package.json:192 `agentura.defaultEffort` —
  образец contributes.configuration; package.nls.json / package.nls.ru.json:23 — образец ключей.
- Тесты: src/agent/claude/adapter.test.ts (fakeSdk + config.loadSdk) — образец; vitest.
- esbuild.mjs:14-17: SDK external, расширение CJS → мост грузить только динамическим
  `import('@anthropic-ai/claude-agent-sdk/bridge')`, статический import запрещён.

Уже решено, не переспрашивать:
1. Новый файл src/agent/claude/remote.ts, класс `RemoteBridge`, один на ClaudeSession, создаётся лениво.
   Зависимости инъекцией (для тестов): `loadBridge(): Promise<BridgeModule>`, `readToken(): string | undefined`,
   `now/setTimeout` (или vi.useFakeTimers — на выбор), `hostname`. В `ClaudeAdapterConfig` — поле
   `remote?: { loadBridge?, readToken?, namePrefix?: () => string, allowBypass?: () => boolean }`
   (адаптер создаётся в extension.ts — прокинуть туда чтение настроек и readToken с claudeHome как в limits.ts).
2. Включение `enable()`: state `connecting` → token (нет → state `error`, error `'no-token'`) →
   `createCodeSession(BASE, token, title, 20000, [], undefined, cwd, model)` где BASE='https://api.anthropic.com',
   title = `${prefix || os.hostname()} · ${options.title ?? basename(cwd)}` → `fetchRemoteCredentials` →
   `attachBridgeSession({sessionId, ingressToken: worker_jwt, apiBaseUrl: api_base_url, epoch: worker_epoch, …})`
   → `reportMetadata({cwd})` → state `on`, url `https://claude.ai/code/<sessionId>`.
   Ошибки классифицировать типгардами модуля: CredentialsRejection/oauth_rejected → `'oauth'`,
   CreateSessionFailure/CredentialsFailure → `'rejected'` (detail: reason/status), null/исключение → `'network'`.
   Повторное enable при `on`/`connecting` — no-op.
3. Новые AgentEvent (types.ts + AGENT_EVENT_TYPES):
   `{type:'remote.state'; state:'connecting'|'on'|'off'|'error'; url?: string;
     error?: 'no-token'|'oauth'|'rejected'|'network'|'closed'|'superseded'; detail?: string}`
   `{type:'remote.prompt'; uuid: string; text: string; from: 'phone'|'web'}`.
   `permission.resolved.by` расширить значением `'remote'`.
4. Исходящие: в pump() каждое сырое сообщение, пока мост `on`: `stream_event` — не слать;
   `result` — не писать, а `handle.sendResult()` + `reportState('idle')`; остальное — `handle.write(message)`.
   Локальный промпт в send() — после input.push записать тот же SDKUserMessage в мост и `reportState('running')`.
   Ошибка записи в мост никогда не роняет сессию — лог `warn`.
5. Входящие `onInboundMessage(msg)`: только `msg.type === 'user'`. text = строка content или склейка
   text-блоков через '\n'. from = /ios|android|mobile/i.test(String(msg.client_platform)) ? 'phone' : 'web'.
   uuid = msg.uuid ?? randomUUID(). Эмит `remote.prompt`, `mapper.notePrompt(text, uuid)`,
   `input.push({type:'user', message: msg.message, parent_tool_use_id: null, uuid})` (content как пришёл —
   картинки проходят движку; в ленте без миниатюр — ок для v1), `reportState('running')`.
   Сессия закрыта — игнор.
6. Разрешения: PermissionBroker получает наблюдателя (`onRequest(toolUseId, toolName, input, options)`,
   `onSettled(toolUseId)`) и метод `resolveExternal(toolUseId, result: ToolPermissionResult): boolean`
   (finish с `by:'remote'`). RemoteBridge на onRequest — `sendControlRequest` формы `can_use_tool`
   из sdk.d.ts (tool_name, input, tool_use_id, permission_suggestions, title/description/decision_reason/
   blocked_path, если есть) с request_id = randomUUID, map request_id↔toolUseId, `reportState('requires_action')`.
   `onPermissionResponse(res)`: найти по request_id; успешный ответ → PermissionResult; из `updatedPermissions`
   выкинуть записи, переводящие в `bypassPermissions` (как локальное правило в permissions.ts);
   `resolveExternal`; неизвестный/битый ответ → `return false`. Ответили локально (onSettled без remote) →
   `sendControlCancelRequest(request_id)`. Вопросы (AskUserQuestion) и план (ExitPlanMode) идут тем же путём.
7. Управление с claude.ai: `onInterrupt` → q.interrupt(); `onSetModel(m)` → q.setModel(m), `{ok:true}`;
   `onSetPermissionMode(mode)` → bypass без `allowBypass()` → `{ok:false, error}`, иначе q.setPermissionMode
   и эмит `mode.changed`; `onStopTask` → q.stopTask; `onBackgroundTasks` → q.backgroundTasks(id).
   onRenameSession, onSetMaxThinkingTokens — не передавать.
8. Обновление: таймер на max(60, expires_in·0.8) с → свежий токен → `fetchRemoteCredentials` →
   `handle.reconnectTransport({ingressToken, apiBaseUrl, epoch: worker_epoch})`, перевзвести таймер.
   `onClose(code)`: 401 или 4094 → одна попытка полного переподключения (fetch + attach с
   `initialSequenceNum: old.getSequenceNum()`), не вышло → state `error` `'closed'`; 4090 → state `off`,
   error `'superseded'`; прочие → state `error` `'closed'`, detail = код. Таймер гасится всегда.
9. `disable()` и dispose сессии: таймер, `await Promise.race([handle.flush(), 2 c])`, `close()`, state `off`.
   ClaudeSession.dispose/close зовёт мост без await-блокировки закрытия сессии.
10. `AgentSession.setRemote?(on: boolean): Promise<void>` — опциональный, реализует только ClaudeSession.
    `features.remote`: claude true, codex/antigravity false.
11. Протокол: FromWebview `{type:'remote.set'; sessionId?: string; on: boolean}` (+ таблица разрешённых);
    ChatController `case 'remote.set'` → `session.setRemote?.(m.on)`. В ensureSession для provider 'claude'
    после создания/возобновления: настройка `agentura.remoteControl` → `void session.setRemote?.(true)`.
12. Настройки: `agentura.remoteControl` (boolean, false), `agentura.remoteControlNamePrefix` (string, "");
    описания en в package.nls.json, ru в package.nls.ru.json; ключи в settings.ts по образцу defaultEffort.
    Страницу настроек webview не трогать (этап 2).

Порядок:
1. remote.ts + инъекция в адаптер/конфиг, события и типы.
2. Интеграция в ClaudeSession (pump/send/dispose) и PermissionBroker.
3. Протокол, ChatController, extension.ts (конфиг адаптера), настройки, features.
4. Тесты: src/agent/claude/remote.test.ts на фейковом модуле моста — enable (аргументы create/fetch/attach,
   события connecting→on с url); нет токена → error 'no-token'; oauth_rejected → 'oauth'; исходящие
   (stream_event пропущен, result → sendResult, локальный промпт записан); входящие (input получил
   сообщение, notePrompt, remote.prompt с from phone/web); разрешение: запрос ушёл, удалённый ответ
   резолвит промис и даёт permission.resolved by 'remote'; локальный ответ шлёт cancel; bypass с claude.ai
   отклонён без allowBypass; таймер обновления → reconnectTransport; onClose 401 → переподключение;
   4090 → off/superseded; disable → flush+close, state off. Протокол: remote.set разрешён (src/protocol.test.ts).
5. Галочки этапа 1 в docs/roadmap/17-remote-control.md — по факту.

DoD: `npm run check` зелёный (typecheck, lint, test, build). Проверка: `npm run check > /tmp/… 2>&1`,
в контекст — хвост и строки с ошибками.

Не делать: webview (src/webview/**), CSS, README/CHANGELOG, версию; живые запросы к api.anthropic.com
из тестов; статический import моста; рефакторинг вне задачи; .codex/ и AGENTS.md (чужие, не трогать).
Вопрос без ответа в промте — в отчёт, не додумывать. Решение, принятое по ходу (форма control_request,
поля, которых нет в d.ts), — в отчёт отдельным списком.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / решения по ходу / не проверено /
открытые вопросы. Отчёт — единственное, что увидит приёмка: без него работа потеряна.
```

### Промт 2

```
Сессия 2 — Remote Control, webview · Модель: sonnet, effort: high · после сессии 1 (принята)

Работаем в /Users/fost/Projects/Agentura, ветка feature/remote-control. Задача: интерфейс Remote Control
во вкладке чата и в настройках по прототипу. Хост уже готов (этап 1): события `remote.state`,
`remote.prompt`, `permission.resolved.by: 'remote'`, сообщение `remote.set`, `features.remote`,
настройки `agentura.remoteControl` и `agentura.remoteControlNamePrefix`.

Читай: docs/roadmap/17-remote-control.md (решения + отчёт приёмки этапа 1); прототип
prototype/screens/remote.html и prototype/shared/remote.css (разметка, тексты, состояния #slash/#on/#menu),
блок «Remote Control» в prototype/screens/settings.html (страница session). Правила: AGENTS.md.

Точки входа (проверены):
- src/webview/components/Composer.tsx: :72 `MenuName`; :273 состояние `menu` (одно открытое меню);
  :584 `menuProps`; :1384 `EffortMenu` — образец кнопки с поповером `.menu.up role=menu`; раскладки
  :651 card, :682 gauges, :711 minimal, :736 statusline, :764 shell, :819 классика — везде есть
  `<EffortMenu>` (у card/minimal — найди их контрол модели/effort); :396-425 диспатч своих команд.
- src/webview/composer.ts:46 `OWN_COMMANDS`, :49 `ownCommands(features)`.
- src/webview/store.ts:829-842 — `setMode`/`setEffort` отправляют сообщения хосту (образец для `setRemote`).
- src/webview/chatState.ts:453 — sys-строка `mode.changed` (образец); :469 `turn.start` и `deliverUser`
  (здесь помечать реплику `via`); :590 — sys-строки сжатия.
- src/webview/components/Log.tsx:422 `case 'user'`, :551 `UserRowView`.
- src/webview/components/Settings.tsx:604-636 страница `session`, :633 строка defaultEffort (образец);
  поле ввода текста — см. :313/:348.
- src/webview/strings.ts:745 (блок settings.effort — образец), strings.en.ts — те же ключи (тип общий).
- protocol.ts: `link.open` (:307) — открыть ссылку через хост.
- Стили: media/composer.css, media/hud.css (и др. в media/) — классы по образцу соседних.
- Тесты: src/webview/composerDom.test.ts, feedDom.test.ts, settingsDom.test.ts (jsdom, preact render).

Уже решено, не переспрашивать:
1. `RemoteButton` (MenuName 'remote') — сразу после контрола effort во всех 6 раскладках; только при
   `features.remote`. Подпись `rc` + значение: `выкл` / `…` (connecting) / `вкл` (зелёная точка) / `ошибка`;
   look как у соседних кнопок раскладки (value/text/pill).
2. Меню (поповер вверх, как EffortMenu): заголовок «Remote Control · эта сессия»; строка-переключатель
   «Управлять с телефона и claude.ai» (подстрока «или /rc в поле ввода») → `remote.set`; когда `on`: QR
   ссылки (пакет `qrcode-generator`, devDependency как preact, SVG-разметкой, белая подложка), строки
   «Открыть на claude.ai/code ↗» (`link.open`) и «Скопировать ссылку» (navigator.clipboard.writeText;
   нет — `link.open` не нужен, просто sys-строка «ссылка: …»), пояснение из прототипа; `error` — текст
   причины по коду и кнопка «Повторить» (`remote.set on:true`).
3. Шапка: при `on` — метка «● remote» (title = url, клик → `link.open`).
4. Лента: sys-строки на переходы — on: «Remote Control включён · <url без https://>»; off (после on):
   «Remote Control выключен»; error: текст причины. `remote.prompt` → запомнить в состоянии
   ожидающих (text → from); `deliverUser` при совпадении текста ставит строке `via: 'phone'|'web'` и
   снимает ожидание; UserRowView рисует «с телефона ·» / «с claude.ai ·» перед временем.
   `permission.resolved by 'remote'` закрывает карточку так же, как 'user'.
5. `/rc` и `/remote-control` — в OWN_COMMANDS (по features.remote), переключают состояние.
6. Настройки, страница session, после effort: «Remote Control для новых сессий» (переключатель,
   agentura.remoteControl) и «Префикс имени в Remote Control» (текст, placeholder «пусто — имя машины»);
   тексты описаний — из прототипа settings.html.
7. Строки — в strings.ts и strings.en.ts (англ. «Remote Control», «from phone», «from claude.ai», …).
9. src/webview/settingsDom.test.ts сверяет разметку строк и CSS-классы страницы настроек с
   prototype/screens/settings.html: две строки RC там уже есть (в рабочем дереве, не коммичены) — Settings.tsx
   должен дать ту же разметку. Прототип не менять; сейчас этот тест красный именно из-за них.
10. Хост уже запоминает выбор «rc» на вкладку (переживает /clear) и шлёт последнее `remote.state` при пересеве
   webview; после `session.reset` webview сбрасывает своё состояние remote в `off` без sys-строки.
8. Тексты причин ошибок: no-token «нет входа Claude Code — выполните claude login»; oauth «вход Claude
   Code устарел — перезапустите claude»; rejected «claude.ai отклонил подключение (<detail>)»;
   network «нет связи с claude.ai»; closed «связь с claude.ai прервана»; superseded «сессию подхватил
   другой процесс».

Порядок: store/chatState → Composer (кнопка, меню, команды) → шапка → Log → Settings → строки → CSS →
тесты (кнопка только у Claude; клик-переключатель шлёт remote.set; /rc шлёт remote.set; remote.state on
даёт метку и sys-строку; remote.prompt помечает реплику; строки настроек есть) → галочки этапа 2.

DoD: `npm run check` зелёный. Проверка: `npm run check > /tmp/… 2>&1`, в контекст — хвост и ошибки.
Скриншоты/браузер не запускать.

Не делать: хост (src/agent/**, src/extension/**) — только если без этого не собрать, и тогда в отчёт;
README/CHANGELOG/версию; .codex/ и AGENTS.md; «заодно улучшить» — нет. Вопрос без ответа — в отчёт.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```
