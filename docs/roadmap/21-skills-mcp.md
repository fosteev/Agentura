# 21 — Скиллы и MCP-серверы: метки в ленте, статус серверов

> **Статус:** план 2026-10-10, ветка `feature/skills-mcp` от `main` (0.10.0). Этапы не начаты.
> Прототип — `prototype/screens/tools-mcp.html` (`#feed-b|#popover|#panel|#sys`); галерея v42, раздел «Скиллы и
> MCP-серверы». **Выбраны: лента B, кнопка у поля (3), вкладка «mcp» (4), системная строка (5).** Вариант A (`#feed-a`)
> не берём.
> Исполнитель отмечает чекбоксы по ходу работы — по факту проверки. Ручные проверки и решения на подтверждение —
> `21-skills-mcp.pending.md` (пополняется приёмкой каждого этапа).

## Цель

По чату видно, какие скиллы использованы и через какие MCP-серверы шли вызовы, а также какие серверы подняты, какие
упали или ждут входа. Четыре отображения: метки в ленте, кнопка «mcp N/M» со всплывашкой, вкладка «mcp» в правой
панели и системная строка в ленте. Каждое включается и выключается в настройках.

## Контекст (разведка 2026-10-10)

**Движок и протокол**
- `src/agent/types.ts:150`: в `session.init` есть `skills[]`, но нет MCP. Строки `:197`/`:206`: `tool.start {toolUseId, name, input}`
  и `tool.result`. На `:474` — `AgentSession`, необязательные методы добавляются по образцу `setRemote`.
- `src/agent/claude/mapper.ts:375`, `init()`: `mcp_servers`, `plugins` и `plugin_errors` не читает. Событие
  шлётся только при смене `sessionId|model|mode` (`lastInitKey`). Неизвестные system-subtype молча отбрасываются (`:248`).
- `src/agent/claude/adapter.ts:530`: `ClaudeSession.q: Query`. Образцы вызова control-методов — `contextUsage()` `:755`
  и `capabilities()` `:764`.
- SDK (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):
  - init: `mcp_servers[{name, status, source?}]` (`:5843`);
  - `Query.mcpServerStatus(): McpServerStatus[]` (`:3012`) с полями `{name, status:
    connected|failed|needs-auth|pending|disabled, serverInfo?{name,version}, error?, scope?, source?, tools?[]}` (`:1226`);
  - `reconnectMcpServer(name)` `:3144`, `toggleMcpServer(name, enabled)` `:3152`.
  - Метода авторизации MCP в SDK нет.
- Инструмент `Skill` в Claude Code: вход `{skill: string, args?: string}`. Плагинные скиллы называются `plugin:skill`.
  В пробах `spikes/sdk-probe/logs` вызовов `Skill` нет, а `mcp_servers` есть.
- Codex 0.160.0 (схема `npm run codex:protocol -- --keep`, проверено 2026-10-10):
  - запрос `mcpServerStatus/list` (`ListMcpServerStatusParams {cursor?, limit?, detail?: full|toolsAndAuthOnly}`) →
    `McpServerStatus {name, runtimeStatus: notStarted|starting|connected|authenticationRequired|failed|cancelled|disabled
    | null, serverInfo, httpOrigin, pluginId, …}`;
  - уведомление `mcpServer/startupStatus/updated {threadId, name, status: starting|ready|failed|cancelled, error,
    failureReason: reauthenticationRequired|null}`;
  - запрос `mcpServer/reload`;
  - у скиллов `skills/list` и `skills/changed`.
  - В `src/agent/codex/protocol.ts:388/433` всего этого нет. Неизвестные уведомления — `return []`
    (`codex/mapper.ts:285`). Вызовы MCP приходят как `mcpToolCall` и превращаются в `mcp__server__tool` (`codex/tools.ts:74/91`).
- Antigravity: данных про MCP нет (`src/agent/antigravity`, только `mcpCapabilities` в пробе ACP).

**Webview**
- `src/webview/toolView.ts:41`, `shortName()`: режет `mcp__server__tool` до `tool`. Своей ветки у `Skill` нет (`:148`,
  default → op `skill`).
- Строку инструмента рендерит единственный компонент — `Log.tsx:254` (`Tool`, `toolView()` на `:272`). Итог хода —
  `SumView` `Log.tsx:617`, собирается в `chatState.ts:674` (`kind:'sum'`, тип `:74`). Скиллы из init хранятся в
  `chatState.ts:175/483`.
- Вид ленты задаёт только CSS: `data-feed` (`Chat.tsx:432`, правила в `media/feed.css`). Отдельный компонент есть лишь у
  `FoldRow` (`Log.tsx:630`, вид `folded`).
- Composer — один компонент `Composer.tsx:272`, шесть раскладок: card `:683`, gauges `:715`, minimal `:745`,
  statusline `:771`, shell `:800`, classic. В каждой есть `<RemoteMenu {...menuProps}/>`. Образец всплывашки —
  `RemoteMenu` `:1459` (`.pop` + `.menu up`, `ItemButton`, `Switch` `:268`), меню перечислены в `MenuName` `:79`.
- Правая панель:
  - `vscode.ts:40` (`PanelState.tab`) и `readPanel()` `:135`;
  - `Chat.tsx:403` (`panelAll` с бейджами), фильтр `:421`, иконки полосы-рейла `Chat.tsx:~700–730`;
  - узкий режим — `Hud.tsx:8/~70–100`;
  - подписи — `strings.ts:24`, `strings.en.ts:20`;
  - тела вкладок — `SidePanes.tsx`.

**Настройки** (образец end-to-end — `agentura.remoteControl`)
- Объявление и описания: `package.json:275`, `package.nls*.json:31`.
- `src/settings.ts`: `SettingKey` `:143`, список `:180`, `SettingsValues` `:234`, валидация `:462`, чтение `:574`.
- Протокол: `src/protocol.ts:164/422/579`.
- В чат значение идёт через `chat.info`: `chatPanel.ts:~660` → `chatController.ts:96/110/269` → `protocol.ts:181` →
  `store.ts:~390`.
- Страницы настроек: `SETTINGS_SECTIONS` (`vscode.ts:86`), `Settings.tsx` (`Row` `:79`, `Toggle` `:125`, страница
  look `:961`), строки `strings.ts:918` / `strings.en.ts:899`.

**Проверки и тесты**
- `npm run check` = typecheck + lint + vitest + build.
- Фикстуры маппера `src/agent/claude/__fixtures__/*.expected.json` перегенерирует `node scripts/gen-adapter-fixtures.mjs`
  (дифф смотреть глазами).
- Тесты webview: `toolView.test.ts`, `taskPaneDom.test.ts` (mount + `tool.start`, пример с `mcp__agentura_jira__` на `:603`),
  `feedDom`, `composerDom`, `panelDom`, `settingsDom`. Для настроек — `settings.test.ts` и `manifest.test.ts`.
- Скриншоты README: `scripts/readme-shots/run.mjs` (группа по `process.argv[2]`, данные в `data.mjs`).

## Решения (2026-10-10)

1. **Одно событие статуса:** `mcp.status {servers: McpServerInfo[], at}`, где `McpServerInfo = {name, status:
   'connected'|'pending'|'failed'|'needs-auth'|'disabled', error?, version?, tools?: number, scope?, builtin?: boolean}`.
   Событие всегда несёт полный список. Нормализация Codex:
   - `connected`/`ready` → `connected`;
   - `starting`/`notStarted` → `pending`;
   - `authenticationRequired` или `failureReason: reauthenticationRequired` → `needs-auth`;
   - `failed`/`cancelled` → `failed`;
   - `disabled` → `disabled`.
   `builtin` — in-process серверы самого Agentura (Claude `source: 'sdk'`, например jira); в списке подписываются
   «встроенный».
2. **Когда приходит статус.**
   - Claude: из `mcp_servers` в init (только имя и статус); затем `mcpServerStatus()` сразу после init, после каждого
     `turn.result` и по ↻. Polling по таймеру не делаем.
   - Codex: `mcpServerStatus/list` (`detail: toolsAndAuthOnly`) после старта треда и по ↻, плюс
     `mcpServer/startupStatus/updated` — точечное обновление одного сервера в сохранённом списке, наружу снова уходит
     полный `mcp.status`.
   - Antigravity: событий нет, все четыре отображения скрыты.
3. **Действия по серверу.**
   - «повторить» есть только у Claude (`reconnectMcpServer`). У Codex `mcpServer/reload` перезагружает все серверы
     сразу — кнопка «перезапустить все» в шапке всплывашки и вкладки только для Codex.
   - «войти» в SDK нет. Для `needs-auth` выводим подсказку текстом: «войдите через `/mcp` в Claude Code или в
     настройках коннекторов claude.ai» (Codex — `codex mcp login <name>`), с кнопкой «скопировать команду».
   - Вкл/выкл сервера (`toggleMcpServer`) — не в этом roadmap.
4. **Счётчики вызовов** считает webview по ленте: `tool.start` с `mcp__<server>__` — плюс один серверу и туле. Хост их
   не хранит. После reseed/истории считаются заново по загруженной ленте.
5. **Скиллы в сессии** — тоже из ленты:
   - вызов `Skill` (`input.skill`; у плагинного берём часть после `:` для поиска файла, показываем полное имя);
   - сообщение пользователя, начинающееся с `/<имя>`, где имя есть в `skills` из init (как вызвал: `/имя` или «сам
     агент»).
   Доступные скиллы — `skills` из init, число «доступно N». У Codex список скиллов в этом roadmap не показываем
   (раздел скрыт).
6. **«открыть SKILL.md».** Хост ищет `<cwd>/.claude/skills/<имя>/SKILL.md`, потом `~/.claude/skills/<имя>/SKILL.md` и
   открывает найденный файл в редакторе. Не нашёл (плагинный, встроенный) — ссылки нет. Webview шлёт только имя, путь
   собирает хост, имя проверяется по `^[a-z0-9][a-z0-9:_-]{0,63}$`.
7. **Число токенов скилла** в строке не показываем: надёжного источника нет (допущение — результат `Skill` содержит
   только «Launching skill», а текст приходит отдельным сообщением). В прототипе «3.1k» — не делаем.
8. **Лента, вариант B.**
   - Строка MCP: op `mcp`, перед именем тула чип сервера (`.chip2`); если сервер в статусе `failed`, чип и op красные.
   - Строка `Skill` — полоса-разделитель (`◆ скилл <имя> · вызвал <как>` · «открыть SKILL.md»).
   - В итоге хода счётчики `mcp N` и `скилл N` — только если они не ноль.
   - Касается всех четырёх видов ленты: journal, folded, replies, cards. В `FoldRow` (folded) в сводку добавляются
     «mcp N».
9. **Кнопка «mcp N/M» у поля ввода** — во всех шести раскладках, рядом с `RemoteMenu`. N — число `connected`, M — все,
   кроме `disabled`. Жёлтая точка — есть `failed` или `needs-auth`. По клику открывается всплывашка по образцу
   `RemoteMenu`: серверы (статус, версия, тулов, вызовов в сессии, действие), затем «Скиллы в этой сессии», «доступно
   N», ↻. Пока статуса нет (до init) — кнопки нет.
10. **Вкладка «mcp» в правой панели** — после «агенты»: серверы с раскрытием вызовов по тулам (клик по строке), скиллы
    сессии, «все доступные скиллы…» (раскрывает список имён). Бейдж — число `failed`+`needs-auth` (жёлтый). Есть иконка
    в полосе-рейле и вкладка в узком режиме (`Hud.tsx`). Сохранённое `tab: 'mcp'` при выключенной настройке нормализуется
    в `changes`.
11. **Системная строка в ленте** ставится в ход, в который пришёл `mcp.status`:
    - «при старте» — сводка «MCP: N подключены · X не подключился (ошибка) · K ждут входа» и раскрываемый список;
    - «при сбое» — сервер был `connected`, а стал `failed`/`needs-auth`: строка «MCP: X отключился (ошибка)».
    В историю сессии строка не пишется: при reseed её нет, это живое состояние.
12. **Настройки** (`agentura.mcp.*`, страница «Внешний вид», подраздел «MCP и скиллы»):
    - `agentura.mcp.feedLabels`: boolean, по умолчанию `true` — метки B в ленте; `false` — как сейчас (короткое имя,
      `Skill` обычной строкой, без счётчиков);
    - `agentura.mcp.composerButton`: boolean, `true`;
    - `agentura.mcp.panelTab`: boolean, `true`;
    - `agentura.mcp.feedStatus`: enum `failures|start|off`, по умолчанию `failures`. `failures` — строка, только если
      что-то не подключено (при старте или по ходу); `start` — сводка при каждом старте сессии плюс сбои; `off` — никогда.
    Хост статус запрашивает, только если включено хотя бы одно из трёх статусных отображений. `feedLabels` от статуса
    не зависит, кроме красного чипа.

## Этапы

### 1. Движки и протокол — **opus, high** (два движка, нормализация статусов, новый путь webview→хост)

- [ ] `src/agent/types.ts`: `McpServerInfo`, событие `mcp.status {servers, at}` в `AgentEvent`; в `AgentSession` —
      необязательные `mcpStatus?(): Promise<void>` (запросить, ответ придёт событием) и `mcpReconnect?(name)`,
      `mcpReloadAll?()`. Флаги возможностей (`canReconnect`, `canReloadAll`, `skillsKnown`) — в `capabilities()` или в
      `session.init`, по месту.
- [ ] Claude, mapper: `init()` читает `mcp_servers` и шлёт `mcp.status` (статус приводится к решению 1, неизвестный →
      `pending`, `source:'sdk'` → `builtin`). Событие идёт и тогда, когда `lastInitKey` не изменился, но список изменился.
- [ ] Claude, adapter: `mcpStatus()` через `q.mcpServerStatus()` (tools → число, `serverInfo.version`, `error`, `scope`);
      вызов после init и после каждого `turn.result` — только если хост просил (флаг от контроллера, решение 12);
      `mcpReconnect(name)` → `q.reconnectMcpServer`, затем `mcpStatus()`. Ошибки control-запроса — в лог, без падения хода.
- [ ] Codex: в `protocol.ts` — запрос `mcpServerStatus/list`, уведомление `mcpServer/startupStatus/updated`, запрос
      `mcpServer/reload`; списки в `scripts/codex-protocol.mjs` пополнить (скрипт сверяет их со схемой CLI). Маппер:
      держит последний список, на уведомление обновляет один сервер (`threadId` чужого треда игнорирует) и шлёт полный
      `mcp.status`. `mcpStatus()` листает страницы по `cursor` до конца, максимум 10 страниц.
- [ ] Antigravity: ничего не реализует; `mcpStatus` отсутствует.
- [ ] Контроллер чата: передаёт `mcp.status` в webview (через существующий поток событий); запросы webview →
      `mcp.refresh`, `mcp.reconnect {name}`, `mcp.reloadAll`, `skill.open {name}` — в `FROM_WEBVIEW_TYPES` и
      `FIELD_CHECKS` (имя сервера ≤ 128, имя скилла по regex из решения 6). `skill.open` ищет файл по решению 6 и
      открывает его через `vscode.window.showTextDocument`.
- [ ] Настройки 4 ключа (решение 12) end-to-end по образцу `remoteControl`: `package.json` + nls ru/en, `settings.ts`
      (ключи, типы, валидация enum, чтение), `chat.info` → `store.ts` (signals `mcpFeedLabels`, `mcpComposerButton`,
      `mcpPanelTab`, `mcpFeedStatus`). Строки на странице «Внешний вид» рисует этап 3 — здесь только данные.
- [ ] Тесты:
      - `mapper.unit.test.ts`: init с `mcp_servers`, в том числе неизвестный статус и `source:'sdk'`;
      - `adapter.test.ts`: fake `mcpServerStatus`/`reconnectMcpServer`, ошибка control-запроса;
      - Codex `mapper.test.ts` + `fakeServer.ts`: list с двумя страницами, updated по одному серверу, чужой `threadId`;
      - контроллер: `skill.open` с плохим именем отклоняется, с `../` — отклоняется;
      - `settings.test.ts` и `manifest.test.ts` — новые ключи.
- [ ] Перегенерировать фикстуры `node scripts/gen-adapter-fixtures.mjs`. В `expected.json` должно добавиться только
      событие `mcp.status` (дифф глазами).

**Готово, когда:** `npm run check` зелёный; в фикстуре с `mcp_servers` есть `mcp.status`; тесты Codex на
`startupStatus/updated` и пагинацию проходят; `skill.open` с `../x` или пустым именем отклоняется тестом.

### 2. Лента: метки B и системная строка — **sonnet, high**, после 1

- [ ] `chatState.ts`: хранит последний `mcp.status` и предыдущий (для «отключился»), счётчики вызовов по серверам и
      тулам, список скиллов сессии `{name, how: 'agent'|'slash', at}` — по решениям 4–5, в том числе при reseed/истории.
- [ ] `toolView.ts`: при `feedLabels` для `mcp__s__t` — `op: 'mcp'`, поле `server: s`, `what` — тул и аргумент; для
      `Skill` — `kind: 'skill'`, `name`, `how`. При выключенной настройке — как сейчас (`shortName`).
- [ ] `Log.tsx`: чип сервера в `Tool` (красный, если сервер `failed`); компонент строки скилла (полоса по прототипу
      `#feed-b`), «открыть SKILL.md» шлёт `skill.open`. В `SumView` — `mcp N` и `скилл N` (только ненулевые). В
      `FoldRow` — «mcp N» в сводке.
- [ ] Системная строка (решение 11) по `mcpFeedStatus`: при старте или при сбое, со списком серверов (раскрывается, по
      умолчанию свёрнут при `failures`, раскрыт при `start`). Встаёт в текущий ход; в историю не пишется.
- [ ] CSS для всех четырёх видов ленты (`media/feed.css` и стили ленты): journal/cards как прототип; replies — чипы
      внутри строки инструментов; folded — полоса скилла видна и в свёрнутом ходе. Цвета — только переменные темы
      VS Code (как остальная лента).
- [ ] Строки ru/en в `strings.ts`/`strings.en.ts`.
- [ ] Тесты: `toolView.test.ts` (mcp с флагом и без, Skill, плагинный `a:b`); DOM-тест ленты (`feedDom`/по образцу
      `taskPaneDom.test.ts:603`): чип, полоса скилла, счётчики в итоге, системная строка в режимах
      `failures`/`start`/`off`, «отключился» при переходе `connected → failed`.

**Готово, когда:** `npm run check` зелёный; DOM-тесты на все пункты выше проходят; `feedLabels=false` даёт ленту без
изменений (тест сравнивает с текущим выводом).

### 3. Кнопка у поля, вкладка «mcp», страница настроек — **sonnet, high**, после 2

- [ ] `Composer.tsx`: `McpMenu` по образцу `RemoteMenu` (новое имя в `MenuName`, Escape через `menuKeys`) во всех
      шести раскладках рядом с `RemoteMenu`. Кнопка `mcp N/M` + точка (решение 9). Во всплывашке — серверы, «повторить»
      (Claude) / «перезапустить все» (Codex), подсказка входа с «скопировать команду», раздел скиллов (для Claude), ↻
      шлёт `mcp.refresh`. Скрыта, если `!mcpComposerButton` или статуса нет.
- [ ] Правая панель: вкладка `mcp` (`vscode.ts` тип + `readPanel` нормализация, `Chat.tsx` `panelAll`/фильтр по
      `mcpPanelTab` и наличию статуса/рейл-иконка, `Hud.tsx` узкий режим, `SidePanes.tsx` тело, `strings`). Тело —
      по прототипу `#panel`: серверы с раскрытием тулов, скиллы сессии, «все доступные скиллы…».
- [ ] Общий компонент строки сервера/скилла для всплывашки и вкладки (одна вёрстка, как в прототипе `.srv`).
- [ ] `Settings.tsx`, страница look: подраздел «MCP и скиллы» — три `Toggle` и выбор `feedStatus` (как другие enum на
      странице); превью в `SettingsPreview.tsx` — если для соседних настроек оно есть.
- [ ] Тесты: `composerDom` (кнопка в каждой раскладке, точка при `failed`, скрыта при выключенной настройке и до
      статуса, «повторить» шлёт `mcp.reconnect`), `panelDom` (вкладка, бейдж, нормализация сохранённого `mcp`),
      `settingsDom` (новые строки пишут `settings.set`).

**Готово, когда:** `npm run check` зелёный; DOM-тесты выше проходят; кадры `node scripts/readme-shots/run.mjs mcp`
(сценарий добавляет этап 4) — или, до него, ручной mount в тесте — показывают всплывашку и вкладку как в прототипе.

### 4. Релиз 0.11.0 — **sonnet, medium**, после 3

- [ ] `scripts/readme-shots`: группа `mcp` (`process.argv[2] === 'mcp'`), данные в `data.mjs` — init с 8 серверами
      (как в прототипе), ход с `Skill`, тремя вызовами MCP и вызовом к упавшему серверу. Кадры: лента B, всплывашка
      открыта, вкладка «mcp», системная строка; одна картинка в README — `docs/images/skills-mcp.png`.
- [ ] `README.md`, `README.ru.md` — раздел про скиллы и MCP (что видно, где отключить).
- [ ] `CHANGELOG.md` (английский) `## 0.11.0 — <дата>`, `### Added`; `package.json` версия 0.11.0; `npm run package`.
- [ ] `docs/features.md` — B12 (MCP) из «Потом» в сделанное; `docs/feature-inventory.md` раздел 12 — отметить.
- [ ] Галерея прототипа: раздел `#tools` — тег «выбрано B, 3, 4, 5 · реализовано», добавить «настоящий webview» из
      кадров run.mjs (по образцу `#task-real`).

**Готово, когда:** `npm run check` зелёный, `agentura-0.11.0.vsix` собран, README-картинка обновлена, CHANGELOG на
английском.

## Промты сессий

Общая шапка (в начало каждого промта):

```
Работаем в /Users/fost/Projects/Agentura, ветка feature/skills-mcp. Правила репо — стиль окружающего кода
(комментарии по-русски, их плотность — как рядом).
Читай: docs/roadmap/21-skills-mcp.md — «Контекст», «Решения» и свой этап; прототип prototype/screens/tools-mcp.html.
Точки входа в «Контексте» проверены при планировании — не перечитывать их ради подтверждения, открывать только
фрагмент, который правишь. Файлы > 300 строк целиком не читать: grep -n по сигнатурам, потом кусок.
Длинный вывод команд — в файл ($TMPDIR/x.log), в контекст только tail -30 и grep FAIL|error.
Решения не переспрашивать и не менять. Вопрос без ответа в roadmap — в отчёт, не додумывать.
Галочки в roadmap — по факту проверки.
Не делать: «заодно улучшить», правки вне этапа, чужие незакоммиченные файлы (.codex/, AGENTS.md).
Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

### Промт 1

```
Сессия 1 — движки и протокол MCP-статуса · Модель: opus, effort: high · первая
<общая шапка>
Задача: этап 1 roadmap 21 — событие mcp.status, Claude (init + mcpServerStatus/reconnectMcpServer), Codex
(mcpServerStatus/list, mcpServer/startupStatus/updated, mcpServer/reload), запросы webview mcp.refresh/mcp.reconnect/
mcp.reloadAll/skill.open, 4 настройки agentura.mcp.* до store.ts. Решения 1–3, 6, 12.
Эталоны: control-метод SDK — adapter.ts:755 contextUsage(); необязательный метод сессии — setRemote в types.ts:474;
уведомления Codex — codex/protocol.ts:388/433 и codex/mapper.ts:285; проверка полей webview — FIELD_CHECKS в
src/protocol.ts; настройка end-to-end — agentura.remoteControl (пути в «Контексте»). Схема Codex:
npm run codex:protocol -- --keep.
Порядок — чекбоксы этапа 1 сверху вниз. DoD: «Готово, когда» этапа 1. Проверка: npm run check.
```

### Промт 2

```
Сессия 2 — лента: метки B и системная строка · Модель: sonnet, effort: high · после сессии 1
<общая шапка>
Задача: этап 2 roadmap 21 — чип сервера у MCP-вызовов, полоса скилла, счётчики mcp/скилл в итоге хода и FoldRow,
системная строка MCP по agentura.mcp.feedStatus, всё под agentura.mcp.feedLabels. Решения 4, 5, 7, 8, 11, 12.
Событие mcp.status и signals настроек уже есть (этап 1): src/agent/types.ts (McpServerInfo), store.ts.
Эталоны: toolView.ts:41/148, Log.tsx:254 (Tool), :617 (SumView), :630 (FoldRow), chatState.ts:674 (sum), :175/483
(skills); DOM-тест — taskPaneDom.test.ts:603; вёрстка — prototype/screens/tools-mcp.html#feed-b и #sys.
Порядок — чекбоксы этапа 2. DoD: «Готово, когда» этапа 2. Проверка: npm run check.
```

### Промт 3

```
Сессия 3 — кнопка «mcp N/M», вкладка «mcp», страница настроек · Модель: sonnet, effort: high · после сессии 2
<общая шапка>
Задача: этап 3 roadmap 21 — McpMenu в шести раскладках composer, вкладка mcp в правой панели (рейл, узкий режим),
общий компонент строки сервера/скилла, подраздел «MCP и скиллы» на странице «Внешний вид». Решения 3, 5, 9, 10, 12.
Состояние MCP, счётчики и скиллы сессии уже в chatState (этап 2); запросы mcp.refresh/mcp.reconnect/mcp.reloadAll —
в протоколе (этап 1).
Эталоны: RemoteMenu — Composer.tsx:1459, MenuName :79, menuProps :616; вкладка панели — vscode.ts:40/135,
Chat.tsx:403/421/~700, Hud.tsx:8, SidePanes.tsx; строка настроек — Settings.tsx:825 (remoteControl), Row :79,
Toggle :125; вёрстка — prototype/screens/tools-mcp.html#popover и #panel.
Порядок — чекбоксы этапа 3. DoD: «Готово, когда» этапа 3. Проверка: npm run check.
```

### Промт 4

```
Сессия 4 — релиз 0.11.0 · Модель: sonnet, effort: medium · после сессии 3
<общая шапка>
Задача: этап 4 roadmap 21 — группа mcp в scripts/readme-shots (run.mjs, data.mjs), картинка docs/images/skills-mcp.png,
README/README.ru, CHANGELOG (англ.), версия 0.11.0, vsix, docs/features.md B12, раздел галереи #tools.
Эталон — релиз 0.10.0 (коммит 9300ecf) и группа tasks в run.mjs:181–248. Галерея — память agentura-prototype-artifact
(перед публикацией прочитать живую версию). DoD: «Готово, когда» этапа 4.
```

## Риски и открытые вопросы

- **Форма `Skill`.** Её не проверяли на живом SDK: в пробах вызовов `Skill` нет. Приёмка этапа 1 делает одну живую
  пробу (`spikes/sdk-probe`) с вызовом скилла и сверяет, что приходят `input.skill` и сообщение `/имя`. Если форма
  другая, поправить решение 5 до этапа 2.
- **`mcpServerStatus()` после каждого хода** — лишний control-запрос. Если окажется медленным (> 300 мс) или будет
  мешать следующему ходу, перейти на запрос только при открытой всплывашке или вкладке и при `feedStatus != off`.
- **Сбой сервера посреди хода у Claude** виден только после конца хода. Push-события об этом в SDK не нашли — принято.
- **Codex `runtimeStatus: null`** («конфиг изменился») — считаем `pending`. Если на живом Codex это частое состояние,
  пересмотреть.
- **Скиллы у Codex** (`skills/list`, вызов через `$skill`) не показываем. Отдельной задачей — если понадобится.
- **«войти» для `needs-auth`** — только подсказка: в SDK нет авторизации MCP. Если владельцу нужна настоящая кнопка,
  это отдельная работа через терминал `claude /mcp`.

## Порядок работы

1 → 2 → 3 → 4, последовательно (одно репо, общий webview). Каждый этап — исполнитель-субагент, затем приёмка
`/plan-review` с коммитом в `feature/skills-mcp`. До старта этапа 1 ветка `feature/skills-mcp` от `main`; первым
коммитом — прототип (`prototype/screens/tools-mcp.html`) и этот файл.
