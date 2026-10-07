# 18 — Лимиты всех движков в боковой панели

Сейчас «Аккаунт и лимиты» показывает только Claude. Квота Antigravity видна лишь у поля ввода во вкладке agy,
лимиты Codex не читаются нигде. Делаем все пять вариантов прототипа (`prototype/screens/limits-multi.html`,
галерея v35 `#limits`) с выбором через настройку — как `agentura.composer.layout`.

Ветка `feature/engine-limits` от `feature/remote-control` (0.6.0 ещё не в main).

## Источники данных (разведка 2026-10-07, ClaudeBar `tddworks/ClaudeBar` + живой вызов)

| Движок | Источник | Окна | Аккаунт |
|---|---|---|---|
| Claude | уже есть: `UsageService` → OAuth `/api/oauth/usage` (`data/limits.ts`) | `fiveHour`, `weekly`, `weeklyModel` (Fable и т. п.) | `AccountService` (SDK) |
| Codex | короткий `codex app-server --listen stdio://`: `initialize` → `account/rateLimits/read` + `account/read {refreshToken:false}` — как ClaudeBar `P/codex.json`, проверено на codex-cli 0.160 | `rateLimits.primary` (`windowDurationMins` 300) → 5 ч; `secondary` (10080) → неделя; `usedPercent` 0…100, `resetsAt` — epoch **секунды**; доп. окна — `rateLimitsByLimitId` кроме ключа `codex` (имя — `limitName ?? limitId` без префикса `codex_`) | `account.email`, `account.planType` (`plus` → «Plus»); `account: null` / ошибка авторизации → «не вошли» |
| Antigravity | уже есть: `AgyQuotaService` → `agy -p "/usage"` (~7 с, не чаще раза в 10 мин) | строка на семейство моделей, `remaining` → показываем `100 − remaining` (израсходовано) | email у `/usage` нет — без аккаунта; пустой разбор при «not logged in» → «не вошли» |

Ответ `account/rateLimits/read` (живой, 2026-10-07):
```json
{"rateLimits":{"limitId":"codex","primary":{"usedPercent":4,"windowDurationMins":300,"resetsAt":1791380292},
 "secondary":{"usedPercent":1,"windowDurationMins":10080,"resetsAt":1791967092},"planType":"plus", "credits":{…}},
 "rateLimitsByLimitId":{"codex":{…то же…}}}
```
`account/read` → `{"account":{"type":"chatgpt","email":"…","planType":"plus"},"requiresOpenaiAuth":true}`.

Не берём из ClaudeBar: локальный language server Antigravity (поиск процесса, CSRF из командной строки, `lsof`) —
работает только при запущенном agy и хрупкий; `chatgpt.com/backend-api/wham/usage` — недокументированный, а
app-server даёт то же официально.

## Решения (2026-10-07)

1. Настройка `agentura.sidebar.limits`: `stack` (A стопка) | `switch` (B переключатель) | `table` (C таблица) |
   `active` (D активный подробно) | `header` (E в заголовке). **По умолчанию `active`.** Раздел настроек «Боковая
   панель» + команда «Agentura: Вид лимитов…» (quick pick, как `agentura.composerLayout`).
2. Показываются только **установленные** движки (исполняемый файл находится). Установлен один Claude — секция
   ровно как сейчас при любом значении настройки (все три `sidebar.top`). Движков ≥ 2 — работает вариант из
   настройки.
3. `sidebar.top` в мультидвижковом режиме: `dense` всегда рисует вариант `header` (E) — это его обобщение;
   `detailed` и `compact` рисуют вариант из настройки одинаково (компактные строки: подпись · шкала · % · сброс),
   таблица аккаунта `kv` не показывается. «Новая сессия» по-прежнему по `sidebar.top`.
4. Движок «текущий» = движок активной вкладки чата (новая вкладка без сессии — её выбранный движок). Используют B
   (выбор по умолчанию), D (раскрыт), A (метка «вкладка»).
5. Цвета — существующий `limitLevel()` (`hudView.ts:218`, >70 жёлтый, >85 красный); у движка «худший» лимит —
   максимум `percent`.
6. ↻ обновляет все движки: Claude — свой кулдаун 60 с, Codex — кулдаун 60 с, Antigravity — свой пол 10 мин
   (не трогаем). Автоопрос — тот же `usagePollMinutes` (`extension.ts:106`).
7. «Не вошли» — строка движка с «войти» (клик → терминал с `codex login` / `agy`); «не установлен» — не
   показываем (строку «как поставить» из прототипа не делаем).
8. Лимиты Codex у поля ввода во вкладке Codex — не в этом roadmap (позже: `account/rateLimits/updated` в сессии).

## Этапы

### 1. Хост: лимиты Codex, сводка движков, протокол, настройка — **sonnet, high**

- [x] `account/rateLimits/read`, `account/read` в `CodexRequests`; `readCodexLimits()` + разбор, тесты на фикстуре
- [x] `CodexLimitsService` (кэш, склейка, кулдаун 60 с), состояния `ok | signedOut | error`
- [x] сводка `EngineLimitsSummary` для codex/antigravity → сообщение `engines.limits` в боковую панель; движок
      активной вкладки в `sessions.update`
- [x] настройка `agentura.sidebar.limits` (package.json, nls ×2, settings.ts, `sidebar.view.limits`), команда
- [x] `npm run check` зелёный

### Решения по итогам этапа 1 (2026-10-07)

- Общий запуск короткого app-server вынесен из `CodexAdapter.query` в `queryAppServer()` (`adapter.ts`) — им
  пользуются и адаптер, и `readCodexLimits`; поведение адаптера не менялось.
- Локатор Codex не переносили: `codexEngine`/`antigravityEngine` уже приходят из `createAdapter` в `extension.ts`.
- Доп. лимиты Codex (`rateLimitsByLimitId`, кроме `codex`) — окна `model`; если у лимита два окна, к имени второго
  добавляется длительность (`… 7d`).
- `engines.limits` всегда несёт две записи — codex и antigravity; `missing` — не установлен (по тихой пробе
  `locate(true)`), `loading` — ещё ни разу не получали (у agy и «ни разу не запустился» — тоже `loading`:
  `AgyQuotaService` ошибку не хранит), `signedOut` у agy — запуск удался, а строк нет.
- Приёмка: agy в общем ↻/автоопросе обновляется только если установлен (`antigravityEngine.available()`), иначе
  громкий `path()` писал бы «не найден» в журнал на каждом опросе.
- Смена движка в пустой вкладке шлёт `ChatPanel.changed` (`rememberProvider`) — `currentProvider` в боковой панели
  обновляется сразу.
- Живая проверка `readCodexLimits` на codex-cli 0.160: `Plus`, 5 ч 4 %, неделя 1 %, email есть.

### 2. Webview: пять вариантов, настройки — **sonnet, high**, после 1

- [x] `EngineLimits` в `Sidebar.tsx`: stack / switch / table / active / header (+ всплывашка), один движок — как было
- [x] CSS из прототипа в `media/hud.css`; строки ru/en
- [x] строка «Лимиты движков» на странице «Боковая панель» настроек + та же строка в `prototype/screens/settings.html`
- [x] DOM-тесты вариантов; `npm run check` зелёный

### Решения по итогам этапа 2 (2026-10-07)

- Модель — `src/webview/engineLimitsView.ts` (`buildEngines`, `worstWindow`, `pickEngine`), отрисовка —
  `src/webview/components/EngineLimits.tsx`; CSS в конце `media/hud.css`, селекторы под `.sidebar` (общие имена
  `.grid`, `.one`, `.pop` уже заняты).
- Строка настройки — выпадающий список (как «Движок по умолчанию»), без карточек с превью.
- В E мини-шкалы — кнопка `.mm` (клавиатура и клик открывают всплывашку).
- «Горячий» уровень (≤ 70 %) в вариантах A–E — оранжевый, как в прототипе; в однодвижковой секции Claude полоса
  по-прежнему серая — не трогали.
- Claude в мультидвижковых вариантах всегда `ok` (его окна приходят отдельно и своё «нет данных» показывают как раньше).
- Приёмка: «войти» запускает найденный исполняемый файл (путь из настройки тоже) прямо в терминале
  (`shellPath`/`shellArgs`), а не `sendText` голого имени.

### 3. Галерея «настоящий webview», CHANGELOG, документация — **сам (Opus), после приёмки 2**

- [x] кадры `limits-real-*` (рендер `dist/webview/sidebar.js` + чат, 1324×760) — галерея, раздел `#limits-real`
- [x] CHANGELOG (Unreleased)
- [ ] ручная проверка в VS Code — `18-engine-limits.pending.md`

## Промты

### Промт 1

Сессия 1 — лимиты всех движков, хост · Модель: sonnet, effort: high

Работаем в /Users/fost/Projects/Agentura, ветка `feature/engine-limits` (уже создана, не переключать). Задача:
научить хост читать лимиты Codex и отдавать боковой панели сводку лимитов Codex и Antigravity плюс новую
настройку вида. Webview (отрисовку) не трогаем — это сессия 2.

Читай: этот файл целиком (разделы «Источники данных» и «Решения» — контракт); `AGENTS.md`; `docs/codex-protocol.md`
(как устроен клиент app-server).
Точки входа (проверены при планировании — не перечитывать ради подтверждения, открывать только правимый фрагмент):
- `src/agent/codex/protocol.ts:311` — `interface CodexRequests` (метод → [params, result]); добавить
  `'account/rateLimits/read': [Record<string, never> | undefined, CodexRateLimitsResponse]` и
  `'account/read': [{ refreshToken: boolean }, CodexAccountResponse]` с типами по ответам из раздела «Источники».
- `src/agent/codex/adapter.ts:183` — приватный `query()`: короткий app-server, handshake, `fn`, закрытие. Эталон
  для нового `src/agent/codex/limits.ts`: `readCodexLimits(executable, deps)` — тот же запуск
  (`['app-server', '--listen', 'stdio://']`, `CodexRpcClient`, таймаут 15 с), cwd — `os.homedir()`; оба запроса
  параллельно; чистая функция `parseCodexLimits(rate, account)` → `CodexLimits` отдельно, чтобы тестировать без
  процесса. Если удобнее — вынести общий запуск из `adapter.query` в функцию и вызывать из обоих мест (без
  изменения поведения адаптера).
- `src/extension/agyQuota.ts` — эталон сервиса (кэш, `onUpdate`, склейка параллельных `refresh`, интервал).
  Новый `src/extension/codexLimits.ts`: `CodexLimitsService(executable: () => Promise<string|undefined>, run, now,
  cooldownMs = 60_000)`; нет исполняемого файла → `state: 'missing'`; ошибка авторизации (RPC-ошибка с
  «auth»/«login»/401 или `account: null`) → `signedOut`; прочее → `error` с текстом, прежние окна сохраняются.
- `src/extension/chatPanel.ts:131` — `codexEngine` (`EngineLocator`) создаётся здесь; `extension.ts:117` —
  `AgyQuotaService(() => antigravityEngine.path())`. Сервису Codex нужен такой же `() => codexEngine.path()`:
  если locator живёт только в chatPanel — перенести его создание туда же, где `antigravityEngine`, и передать в
  services (поведение чата не менять).
- `src/protocol.ts:236-256` — сообщения боковой панели (`sidebar.view`, `account.info`, `limits.update`); `:401`
  — `AccountSummary`. Добавить:
  ```ts
  export type EngineLimitsState = 'ok' | 'signedOut' | 'missing' | 'error' | 'loading';
  export interface EngineWindowSummary {
    kind: 'fiveHour' | 'weekly' | 'model';
    /** У `model` — имя от источника (`Gemini`, `Claude/GPT`, имя доп. лимита Codex); у остальных — нет. */
    name?: string;
    /** Израсходовано, 0…100 (у agy — 100 − остаток). */
    percent: number;
    resetsAt?: number; // мс
  }
  export interface EngineLimitsSummary {
    engine: 'codex' | 'antigravity';
    state: EngineLimitsState;
    email?: string;
    plan?: string;      // `Plus`, `Pro` — planType с заглавной
    version?: string;   // `codex 0.160.0` / `agy 1.4` — если уже известна локатору, иначе нет
    windows: EngineWindowSummary[];
    updatedAt: number;
    error?: string;
  }
  ```
  сообщение `{ type: 'engines.limits'; engines: EngineLimitsSummary[] }`; в `sidebar.view` — поле
  `limits: SidebarLimitsMode`; в `sessions.update` — `currentProvider?: AgentProvider` (движок активной вкладки).
  Не забыть списки типов в `protocol.ts` (`Record<…['type'], true>`) и `protocol.test.ts`.
- `src/extension/sidebarView.ts:56-68` (`limits.refresh`, `ready`), `:100-120` (`pushSessions`, `pushView`), `:162`
  (`refreshUsage`). `refreshUsage()` обновляет все три источника: Claude как сейчас, параллельно Codex и agy
  (`agyQuota.refresh()`), потом шлёт `engines.limits`. Подписаться на `onUpdate` обоих сервисов → `engines.limits`.
  agy без исполняемого файла → `missing`; agy с пустыми строками после удачного запуска → `signedOut`.
- `src/extension/chatPanel.ts:232` — `currentSessionId()`; рядом добавить `static currentProvider()` (по
  `p.provider` активной/последней вкладки, `chatPanel.ts:223`), отдавать в `pushSessions`.
- Настройка — копировать `agentura.sidebar.top` целиком: `package.json:294-308`, `package.nls.json` и
  `package.nls.ru.json` (`config.sidebar.top.*`), `src/settings.ts` (`:28-34` константы и тип, `:110`, `:139`,
  `:186`, `:227` guard, `:401` валидация, `:433` чтение). Значения `stack | switch | table | active | header`,
  по умолчанию `active`. Команда `agentura.sidebarLimits` «Agentura: Вид лимитов…» — копия
  `agentura.composerLayout` (`package.json:98`, `extension.ts:224-243` quick pick, `:320` регистрация, строки
  `src/shared/l10n.ts:27,46,176,195`).

Уже решено, не переспрашивать: всё в «Решениях» выше; Claude-путь (`limits.update`, `account.info`) не меняем —
webview соберёт три движка сам; локальный language server agy и `wham/usage` не используем.

Порядок:
1. Типы и `parseCodexLimits` + тесты `src/agent/codex/limits.test.ts` на фикстуре из раздела «Источники» (5 ч,
   неделя, доп. лимит из `rateLimitsByLimitId`, `resetsAt` секунды → мс, `account: null` → signedOut, planType →
   «Plus»).
2. `readCodexLimits` (процесс) и `CodexLimitsService` + `codexLimits.test.ts` по образцу `agyQuota.test.ts`
   (кулдаун, склейка, missing, signedOut, ошибка сохраняет окна).
3. Протокол, сводка в `sidebarView.ts`, `currentProvider`.
4. Настройка, команда, `settings.test.ts` / `manifest.test.ts`.
5. `npm run check > /tmp/engine-limits-check.log 2>&1; tail -30 /tmp/engine-limits-check.log`.
Галочки этапа 1 в этом файле — по факту проверки.

DoD: `npm run check` зелёный; `limits.test.ts` и `codexLimits.test.ts` есть и проходят; в `protocol.ts`
сообщение `engines.limits`, поле `sidebar.view.limits`, `sessions.update.currentProvider`; настройка видна в
`package.json` с ru/en описаниями.

Не делать: webview (`src/webview/**`, `media/**`) — кроме правок, без которых не компилируется (обработать новое
сообщение заглушкой можно); логику Claude-лимитов и `AgyQuotaService` не менять; лимиты Codex в чат не слать;
чужие незакоммиченные `.codex/`, `AGENTS.md` не трогать; живые `codex`/`agy` в тестах не запускать.
Вопрос, на который нет ответа в промте, — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от
плана / не проверено / открытые вопросы.

### Промт 2

Сессия 2 — лимиты всех движков, webview · Модель: sonnet, effort: high · после приёмки сессии 1

Работаем в /Users/fost/Projects/Agentura, ветка `feature/engine-limits`. Задача: отрисовать в боковой панели пять
вариантов лимитов нескольких движков по прототипу и настройке `agentura.sidebar.limits` (хост уже шлёт данные).

Читай: этот файл (разделы «Решения», «Этап 1» и решения по итогам этапа 1, если появятся); `AGENTS.md`.
Визуальный эталон — `prototype/screens/limits-multi.html`: разметка строится скриптом внизу файла (функции
`row`, `R.a…R.d`, ветка `v === 'e'`), стили — `<style>` в head (классы `.mk`, `.L`, `.lims`, `.eng/.eh`, `.seg`,
`.grid/.c`, `.one/.exp`, `.hx/.pop`). Повторить классы и структуру; прототип — источник правды по виду.
Точки входа:
- `src/webview/components/Sidebar.tsx:385-418` — секция «Аккаунт и лимиты» (`kv`, `AccountLine`, `.lim` строки
  Claude), `:337-345` — `dense` (мини-шкалы в заголовке), `:244-250` — приём `limits.update` / `account.info`,
  `:102` — уровень цвета, `:38,332` — `data-top`.
- `src/webview/hudView.ts:218` — `limitLevel(percent)`.
- `src/webview/limitView.ts` — подписи окон Claude (переиспользовать для подписи 5 ч / неделя / модель).
- `src/webview/strings.ts:950-985` (`ui.sidebar`) + `strings.en.ts` — строки.
- `media/hud.css` — стили боковой панели (`.sidebar .lim …`, `data-top`).
- Настройки: `src/webview/components/Settings.tsx:693-700` (строка `sidebar.top` на странице «Боковая панель»),
  `:758-768` (карточки выбора, если нужны); `prototype/screens/settings.html` — та же страница в прототипе:
  `settingsDom.test.ts` сверяет DOM со скелетом прототипа, поэтому строку добавить и туда тем же разметочным
  скелетом.
- `src/webview/sessionsDom.test.ts` — сверка боковой панели с `prototype/screens/*.html`: однодвижковый режим
  должен остаться как есть (тест зелёный без правок прототипа).

Уже решено, не переспрашивать:
- Модель движка в webview: `{ engine: 'claude'|'codex'|'antigravity', state, email?, plan?, version?, windows:
  { label, short, percent, reset? }[] }`, Claude собирается из существующих `limits.update` + `account.info`
  (окна как сейчас: «Окно 5 часов», «Неделя», «Неделя · Fable»), codex/agy — из `engines.limits`. `state:
  'missing'` не показывается. Движков после фильтра один → старая разметка без изменений.
  `loading` — строка движка без окон с приглушённым «обновляется…» (в C и E — «—»). Хост: `src/protocol.ts`
  (`EngineLimitsSummary`, `engines.limits`, `sidebar.view.limits`, `sessions.update.currentProvider`),
  `src/extension/sidebarView.ts` (`pushEngineLimits`, `refreshUsage`); `SIDEBAR_LIMITS_MODES` и тип — `src/settings.ts`.
- Порядок: Claude, Codex, Antigravity. Метки — квадратик с буквой C / X / G, цвета `#c96442` / `#6b6bd6` /
  `#2f7de1` (как в прототипе), без логотипов.
- `top === 'dense'` при ≥ 2 движках → вариант `header`. Иначе — `sidebar.view.limits`.
- A `stack`: заголовок «Аккаунты и лимиты», блок на движок: метка, имя, `email · plan` (tooltip — версия), метка
  «вкладка» у текущего (`currentProvider`), зелёная точка; строки окон `.L`.
- B `switch`: сегменты на движки с точкой худшего лимита; выбран текущий; клик выбирает вручную до смены
  `currentProvider`; ниже `who`-строка (как `AccountLine`) и окна выбранного.
- C `table`: заголовок «Лимиты», строка на движок, до трёх ячеек окон (короткие подписи `5 ч`, `нед`, имя модели),
  пусто — «—»; сброс и аккаунт — в `data-tip`. Имя Antigravity в таблице сокращать до «Antigr.».
- D `active`: текущий раскрыт (шапка с аккаунтом + окна), остальные — строкой: ▸, метка, имя, шкала, % и сброс
  худшего окна; клик по строке раскрывает её (раскрыт всегда один); при смене `currentProvider` раскрыт текущий.
- E `header`: в заголовке панели на движок — метка + мини-шкала + число худшего окна, ↻; клик по мини-шкалам
  открывает всплывашку `.pop` со стопкой (как A без «вкладка»), закрытие — Esc, клик мимо, повторный клик.
- «Не вошли» (`signedOut`): строка движка «не вошли · войти»; «войти» шлёт `{ type: 'engine.login', engine }`
  — добавить в протокол `FromWebview`, хост открывает терминал `vscode.window.createTerminal` с `codex login`
  или `agy` и `show()` (обработчик в `sidebarView.ts`, ~5 строк). `error` — строка с текстом ошибки в
  `data-tip`, окна последние известные.
- `data-tip` (не `title`) для подсказок — как везде в Sidebar.
- Строки ru/en: «Аккаунты и лимиты» / «Accounts & limits», «вкладка» / «tab», «не вошли» / «signed out»,
  «войти» / «sign in», «Лимиты движков» / «Engine limits» и подписи пяти вариантов
  «стопка / переключатель / таблица / активный подробно / в заголовке» — «stack / switch / table / active expanded /
  in header».

Порядок:
1. Модель и сборка движков в store (`engines.limits`, `currentProvider`, `sidebar.view.limits`).
2. Компонент `src/webview/components/EngineLimits.tsx` с пятью вариантами, подключение в `Sidebar.tsx`.
3. CSS в `media/hud.css`.
4. Строка настройки в Settings.tsx и `prototype/screens/settings.html`; обработчик `engine.login` на хосте.
5. DOM-тесты `src/webview/engineLimits.test.ts`: по варианту — ключевые классы и тексты; один движок → старая
   разметка; signedOut; dense → header; D переключение раскрытого; B ручной выбор.
6. `npm run check > /tmp/engine-limits-check.log 2>&1; tail -30 /tmp/engine-limits-check.log`.

DoD: `npm run check` зелёный; пять вариантов рендерятся по настройке; `sessionsDom.test.ts` и
`settingsDom.test.ts` зелёные.

Не делать: хост сверх `engine.login`; Claude-лимиты у поля ввода и квоту agy в чате не трогать; браузер и
скриншоты не запускать; чужие `.codex/`, `AGENTS.md` не трогать.
Вопрос, на который нет ответа в промте, — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от
плана / не проверено / открытые вопросы.
