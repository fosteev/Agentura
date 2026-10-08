# 19 — Чаты по задачам Jira: группы, режим задачи, своё подключение и Jiraffe

> **Статус:** черновик · 2026-10-08. Ветка `feature/task-groups` (от `feature/engine-limits`, 0.8.0 ещё не в main).
> Прототип — `prototype/screens/tasks.html` (`#a|#b|#c|#d|#ask`) и `prototype/screens/task-mode.html`
> (`#open|#comment|#changes|#rail|#jiraffe|#settings`); галерея v38, разделы «Режим задачи» и «Чаты по задачам Jira».
> Исполнитель отмечает чекбоксы по ходу работы — по факту проверки. Ручные проверки — `19-jira-tasks.pending.md`
> (создаёт приёмка этапа 9).

## Цель

По одной задаче Jira — несколько чатов, сгруппированных и привязанных к задаче; у чата по задаче справа вкладка
«задача» с карточкой и лентой изменений (комментарий агента виден сразу). Jira подключается либо через расширение
Jiraffe, либо своим подключением Agentura в этом воркспейсе. Все варианты прототипа реализованы; где вариантов
несколько у одного и того же — настройка-вид с превью в настройках (как `agentura.composer.layout`).

## Контекст (разведка 2026-10-08)

Agentura:
- Сейчас «один внешний ключ → одна сессия»: `src/extension/sessionMemory.ts:56` `keyed()` / `:64` `setKeyed()` над
  `workspaceState` ключ `agentura.keyedSessions` (`Record<string, SessionRef>`). Ключ ставится при `session.init`:
  `src/extension/chatPanel.ts:567`. Вход — команда `agentura.openWithContext` (`extension.ts:332`) →
  `ChatPanel.openWithContext` (`chatPanel.ts:~327`), аргумент проверяет `src/extension/contextRequest.ts`.
- Вкладка = одна `WebviewPanel` = один `ChatController` = одна сессия. Заголовок — `chatController.ts` `tabLabel()`;
  маршрутизация открытия — `src/extension/panelRouting.ts`; восстановление после Reload — `chatPanel.ts` serializer.
- Сайдбар: `src/extension/sidebarView.ts` (сообщение `sidebar.view`), webview `src/webview/components/Sidebar.tsx`,
  логика списка `src/webview/sessionsView.ts`, тип строки `SessionSummary` (`src/protocol.ts:452`), данные —
  `src/extension/sessionsService.ts`.
- Правая панель: `src/webview/components/Chat.tsx:334` `panelAll` (вкладки `changes|git|agents`), полоса `:608`
  `<nav class="rail">`, панели — `SidePanes.tsx`, состояние вкладки — `src/webview/vscode.ts:21` `PanelState`.
- Настройка-вид с превью — эталон `agentura.sidebar.limits` (roadmap 18) и `agentura.composer.layout`: места
  правки перечислены в «Чек-лист настройки-вида» ниже.
- Строка инструмента в ленте — единственная точка `src/webview/toolView.ts:44` `toolView()`; MCP-имена режет
  `shortName` (`:40`).
- `context.secrets` в Agentura пока не используется. Claude-адаптер уже передаёт `mcpServers: {}`
  (`src/agent/claude/adapter.ts:397`).
- Проверка: `npm run check` (typecheck + lint + vitest + build).

Jiraffe (`/Users/fost/Projects/jiraffe`, 0.7.0, ветка main, VS Code Marketplace):
- Инстансы — `globalState` `jiraffe.instances`, токен — SecretStorage `jiraffe.token.<id>`
  (`src/state/instances.ts:6-7`); id инстанса = `instanceIdFromUrl(baseUrl)` (`:10`).
- Клиент без vscode: `src/jira/{http,client,mappers,types}.ts` — `HttpClient` (`http.ts:119`), `authHeader`
  (`:85`, DC — Bearer PAT, Cloud — Basic email:token), `canonicalBaseUrl` (`:48`), `JiraClient.issueDetail`
  (`client.ts:164`), `myself` (`:52`), `transition` (`:144`), `addWorklog` (`:128`). REST v2 везде, HTML через
  `renderedFields`. Метода добавления комментария **нет**.
- `activate()` ничего не возвращает (`src/extension.ts:29`) — публичного API нет.
- Кнопка «Спросить ИИ»: `src/panels/issuePanel.ts:259` `askAi` → `agentura.openWithContext`
  `{name, context: issueContext(...), prompt: url, sessionKey: 'jiraffe:<instanceId>:<key>'}`;
  `src/panels/aiContext.ts` — `htmlToText`, `issueContext` (чистые).
- `jiraffe.openIssueByKey` принимает только ключ (`src/commands/filters.ts:322`) — открыть карточку конкретного
  инстанса снаружи нечем.
- Проверка: `npm run lint && npm test && npm run build`.

## Решения (2026-10-08)

1. **Ключ задачи** — `jira:<instanceId>:<KEY>`, `instanceId` = `instanceIdFromUrl(baseUrl)` (тот же алгоритм у
   Jiraffe и своего подключения → одна группа независимо от источника). Старый `jiraffe:<inst>:<KEY>` принимается
   как синоним. Допущение: id инстанса в Jiraffe всегда получен `instanceIdFromUrl` (проверить в этапе 2 по
   `src/commands/instances.ts`).
2. **Модель групп** — новый ключ `workspaceState` `agentura.taskGroups`:
   `Record<taskKey, { task: TaskMeta; sessions: SessionRef[]; openedAt: Record<sessionId, number> }>`,
   `TaskMeta = { key; instanceId; title; status?; statusCategory?; url }`. Миграция: записи
   `agentura.keyedSessions` с префиксом `jiraffe:` переезжают в группы (title = ключ задачи до первого обновления),
   старый ключ удаляется. Сессия входит максимум в одну группу.
3. **Источник Jira** — настройка `agentura.jira.source`: `auto` (по умолчанию: Jiraffe, если установлен и отдаёт
   API; иначе свои подключения, если есть) | `jiraffe` | `own` | `off`. При `off` группы в сайдбаре остаются
   (это локальные данные), полоски, панели и опроса нет.
4. **Своё подключение** — как в Jiraffe, но в рамках воркспейса: список инстансов — `workspaceState`
   `agentura.jira.instances` (`{id, name, baseUrl, kind:'dc'|'cloud', email?}`), токен — `context.secrets`
   `agentura.jira.token.<wsId>.<instanceId>`, `wsId` = sha1 от URI первой папки воркспейса (без папки — `global`).
   Добавление — команда «Agentura: Подключить Jira…» по шагам Jiraffe `addInstance` (URL или ссылка на задачу →
   тип → email для Cloud → токен → имя; проверка `myself()`; `http://` — предупреждение). Удалить, проверить —
   там же и на странице настроек.
5. **Клиент Jira** — копия чистого слоя Jiraffe в `src/data/jira/` (`http.ts`, `client.ts` — только нужные методы,
   `mappers.ts`, `types.ts`, `htmlToText`/`issueContext` из `aiContext.ts`), в шапке каждого файла: «скопировано из
   fosteev/jiraffe 0.7.0 src/jira/<файл>, правки — помечены». Зависимость `sanitize-html` не тянем: в карточке
   Agentura описание и комментарии — **текстом** (`htmlToText`), картинки не встраиваются, вложения — чипы со
   ссылкой в браузер.
6. **Jiraffe API v1** (контракт, реализует этап 3) — `activate()` возвращает:
   ```ts
   export interface JiraffeApi {
     apiVersion: 1;
     instances(): { id: string; name: string; baseUrl: string; kind: 'dc' | 'cloud' }[]; // в scope воркспейса
     issue(instanceId: string, key: string): Promise<{ issue: IssueDetail; worklogs: Worklog[] }>;
     myself(instanceId: string): Promise<{ accountId?: string; name?: string; displayName: string }>;
     openIssue(instanceId: string, key: string, beside?: boolean): Promise<void>;
     onDidChangeInstances: vscode.Event<void>;
     // v2 (этап 8): addComment, transitions, transition, logWork
   }
   ```
   `IssueDetail`/`Worklog` — типы Jiraffe `src/jira/types.ts` (в Agentura — их копия). Agentura проверяет
   `apiVersion >= 1`; нет API (старый Jiraffe) → источник `jiraffe` недоступен, `auto` падает на `own`.
7. **«Открыть в Agentura»** (Jiraffe): кнопка «Спросить ИИ» переименована в «Открыть в Agentura ▾». Меню — из
   команды Agentura `agentura.taskSessions({instanceId, key})` → `{id, provider, title, updatedAt, live}[]`:
   «Продолжить: <чат>», остальные чаты, разделитель, «Новый чат по задаче». Нет чатов — сразу новый, без меню.
   В `agentura.openWithContext` добавляются поля `task: TaskMeta` и `session?: string | 'new'`; `sessionKey`
   остаётся для Agentura 0.8.0. Нет команды `agentura.taskSessions` (старая Agentura) — поведение как сейчас.
8. **Режим задачи** чата = сессия входит в группу. Заголовок вкладки «NEWMFC-1482 · <название чата>», над лентой
   полоска задачи (ключ, статус-пилюля, заголовок, «в Jiraffe ↗» / «в браузере ↗» для своего подключения).
9. **Настройки-виды** (каждая — enum, превью-карточки в настройках, команда quick pick):
   - `agentura.tasks.sidebar`: `groups` (А — группы в списке сессий, по умолчанию) | `section` (В — секция «Задачи»
     над «Сессиями», в списке сессий метка ключа справа). Раздел «Боковая панель».
   - `agentura.tasks.tab`: `chat` (вкладка на чат, по умолчанию) | `task` (Б — вкладка на задачу, чаты внутренними
     вкладками). Раздел «Внешний вид».
   - `agentura.tasks.card`: `panel` (Г/режим задачи — вкладка «задача» правой панели, по умолчанию) | `split`
     (В — карточка Jiraffe слева, чат справа; только при источнике Jiraffe, иначе работает как `panel`, в превью
     пометка «только с Jiraffe») | `strip` (только полоска). Раздел «Внешний вид».
10. **Вкладка «задача»** правой панели (`changes | git | agents | task`, только у чатов по задаче и при
    `tasks.card` ≠ `strip`): переключатель «карточка | изменения»; карточка — шапка (ключ, статус, исполнитель,
    приоритет, ↻, «обновлено N с назад»), описание 4 строки + «ещё», вложения чипами, комментарии (новые снизу),
    закреплённый внизу блок «Чаты по задаче» (чаты группы, текущий отмечен, «＋ новый чат»). Изменения — события
    с `openedAt` сессии, новые сверху: статус/поле, комментарий, ворклог; автор; метка «из этого чата», если
    автор = `myself` и время внутри хода этой сессии (+60 с) — **допущение**, эвристика. Новое с прошлого просмотра —
    бейдж на вкладке и в полосе, подсветка кромкой и «новое · только что». Комментарий человека (автор ≠ myself)
    во время хода — плашка «<имя> прокомментировал(а), пока агент работал. Отправить агенту?» + «в чат»
    (вставляет текст комментария в поле ввода, не отправляет).
11. **Обновление** — `agentura.tasks.refresh`: `30s` (по умолчанию) | `manual`. Опрос только пока видима хотя бы
    одна вкладка чата этой задачи; плюс сразу после хода и после результата инструмента, в тексте которого есть
    ключ задачи; не чаще раза в 5 с на задачу. `agentura.tasks.humanChanges` (bool, `true`) — показывать
    изменения от людей и плашку.
12. **Привязка без Jiraffe** — команды «Agentura: Чат по задаче…» (ключ или ссылка → инстанс, если их несколько →
    новая вкладка с контекстом задачи файлом, как у Jiraffe) и «Agentura: Привязать вкладку к задаче…» / «Отвязать
    от задачи» (контекстное меню строки сайдбара и `⋯` полоски). «＋» у группы в сайдбаре и в блоке «Чаты по
    задаче» — новый чат по задаче.
13. **Инструменты Jira для агента** (этап 8) — только движок Claude: in-process MCP-сервер `jira` через SDK
    (`createSdkMcpServer`, подключается в `mcpServers` адаптера) с `comment`, `transition`, `worklog`; пишет через
    текущий источник (своё — метод `addComment` дописываем в копию клиента; Jiraffe — API v2). `comment` без
    вопроса, `transition` и `worklog` — через обычную карточку разрешения. Настройка
    `agentura.jira.agentTools` (`{comment, transition, worklog}: boolean`, все `true`). В ленте — `jira · комментарий
    NEWMFC-1482 ✓ · в задаче →`. Codex и Antigravity — не в этом roadmap (агент пишет в Jira своими скиллами;
    изменения всё равно видны через опрос).
14. **Страница настроек «Интеграции»** (шестая, `settings#integrations`): источник; Jiraffe — версия, число
    инстансов или «не установлен · поставить»; свои подключения списком (+ подключить, проверить, удалить);
    `tasks.refresh`, `tasks.humanChanges`, `jira.agentTools` (неактивно, пока источник не дал запись).
15. Версии: Agentura **0.9.0**, Jiraffe **0.8.0**.

### Чек-лист настройки-вида (эталон — `agentura.sidebar.limits`)

`src/settings.ts` (массив значений, тип, guard, `SettingKey`, `SETTING_KEYS`, `SettingsValues`, валидация, `readSettings`) →
`package.json` (`contributes.configuration` + команда) → `package.nls.json` / `package.nls.ru.json` →
`src/shared/l10n.ts` (quick pick ru/en) → `extension.ts` (`pickX` по образцу `pickSidebarLimits`, `writeWhereSet`) →
`src/protocol.ts` (поле в `sidebar.view` или `chat.info`) → провайдер (`sidebarView.ts` / `chatPanel.ts` +
`chatController.ts settings()`) → стор webview → компонент → `Settings.tsx` `ChoiceCards` + превью в
`SettingsPreview.tsx` → `strings.ts` / `strings.en.ts` → тесты `manifest.test.ts`, `settings.test.ts`,
`settingsDom.test.ts`.

## Этапы

### 1. Модель групп задач (хост) — **sonnet, high**

Группы вместо «ключ → одна сессия», расширенный `openWithContext`, команды для Jiraffe и ручной привязки.
Без Jira-данных: метаданные задачи приходят из запроса.

- [ ] `src/extension/taskGroups.ts`: `TaskKey`, `TaskMeta`, `parseTaskKey` (`jira:` и `jiraffe:`), `TaskGroups`
      над `MementoLike` (`groups()`, `groupOf(sessionId)`, `add(taskKey, meta, ref, openedAt)`, `remove(sessionId)`,
      `updateMeta`), миграция из `agentura.keyedSessions` (решение 2); тесты `taskGroups.test.ts`
- [ ] `sessionMemory.ts`: `keyed/setKeyed` удалены, вызовы переведены на `TaskGroups`
- [ ] `contextRequest.ts`: поля `task` и `session` (проверка недоверенного ввода, ограничения длины как у
      остальных полей); тесты в `contextRequest.test.ts`
- [ ] `ChatPanel.openWithContext`: `session` = id → возобновить его; `'new'` → новая вкладка в группе; не задан →
      последний чат группы (по `updatedAt`), если есть, иначе новый
- [ ] команда `agentura.taskSessions` (служебная, без палитры) → `{id, provider, title, updatedAt, live}[]`
- [ ] `SessionSummary` + `task?: { key; title; status?; statusCategory? }`; `sessions.update` несёт группы
      (`tasks: {taskKey, meta, sessionIds}[]`) — протокол и `protocol.test.ts`
- [ ] команды «Agentura: Привязать вкладку к задаче…» (ввод ключа вида `NEWMFC-1482` или ссылки; инстанс —
      из ссылки или выбор из известных групп/подключений; Jira не запрашивается) и «Отвязать от задачи»;
      nls ru/en
- [ ] заголовок вкладки в режиме задачи «KEY · название» (`tabLabel`)

**Готово, когда:** `npm run check` зелёный; тест миграции `keyedSessions → taskGroups`; тест `openWithContext`
с `session: 'new'` / id / без поля (юнит на маршрут); `agentura.taskSessions` возвращает чаты группы.

**Сессия:** sonnet, high; первая, последовательно (всё дальше опирается на модель).

### 2. Источники Jira: своё подключение и Jiraffe (хост) — **sonnet, high**, после 1

Копия клиента, два источника за одним интерфейсом, сервис задачи с опросом и лентой изменений.

- [ ] `src/data/jira/`: копии `http.ts`, `client.ts` (`myself`, `issue`, `issueDetail`, `worklogs`), `mappers.ts`,
      `types.ts`, `text.ts` (`htmlToText`, `issueContext`) с шапкой-источником (решение 5); тесты копируются вместе с
      фикстурой `test/fixtures/issue-dc.json` Jiraffe
- [ ] сверить: Jiraffe `src/commands/instances.ts` — id инстанса = `instanceIdFromUrl` (решение 1); расхождение —
      в отчёт
- [ ] `src/extension/jira/source.ts`: `interface JiraSource { kind: 'jiraffe'|'own'; instances(); issue(inst,key);
      myself(inst); openIssue?(inst,key,beside) }`; `OwnSource` (решение 4, `context.secrets`), `JiraffeSource`
      (`vscode.extensions.getExtension('fosteev.jiraffe')` → `activate()` → `exports.apiVersion >= 1`),
      `resolveSource(setting)` по решению 3, пересчёт при установке/удалении расширений и смене настройки
- [ ] команды «Agentura: Подключить Jira…», «Отключить Jira…», «Проверить подключение Jira» — шаги по образцу
      Jiraffe `src/commands/instances.ts:96`; nls ru/en
- [ ] `src/extension/jira/taskService.ts`: `TaskCard` (решение 10, текст вместо HTML), `TaskEvent`
      `{kind:'status'|'field'|'comment'|'worklog', at, author, mine, fromThisChat, text}`, `eventsSince(card,
      openedAt, turns)`; опрос по решению 11; кеш карточки на задачу (одна выборка на все вкладки группы)
- [ ] протокол: `task.state {card?, events, error?, fetchedAt, source}` хост → вкладка чата;
      `task.refresh`, `task.toComposer {commentId}`, `task.openExternal` вкладка → хост
- [ ] настройки `agentura.jira.source`, `agentura.tasks.refresh`, `agentura.tasks.humanChanges` (без превью)
- [ ] команда «Agentura: Чат по задаче…» (решение 12) — с источником тянет карточку и кладёт `issueContext` файлом

**Готово, когда:** `npm run check` зелёный; тесты `eventsSince` (статус, комментарий агента «из этого чата»,
комментарий человека, ворклог) на фикстуре; тест `resolveSource` на четыре значения настройки × «Jiraffe есть/нет».

**Сессия:** sonnet, high; после 1. Можно параллельно с этапом 3 (другое репо, контракт — решение 6).

### 3. Jiraffe: API v1 и «Открыть в Agentura» (репо jiraffe) — **sonnet, high**, параллельно с 2

- [ ] `src/api.ts`: `JiraffeApi` ровно по решению 6; `activate()` возвращает его; `openIssue` открывает карточку
      инстанса (`beside` → `ViewColumn.Beside`); тест на форму API
- [ ] `askAi` → «Открыть в Agentura»: передаёт `task` (`key, instanceId, title, status, statusCategory, url`),
      `session`; сохраняет `sessionKey` для старой Agentura
- [ ] кнопка «Открыть в Agentura ▾» и меню по решению 7 (данные — `executeCommand('agentura.taskSessions', …)`,
      ошибка/нет команды — старое поведение); строки l10n ru/en, `README`, `README.ru.md`, `CHANGELOG`
- [ ] версия 0.8.0 в `package.json`

**Готово, когда:** `npm run lint && npm test && npm run build` зелёные в `/Users/fost/Projects/jiraffe`;
тест меню: 0 чатов → без меню, 2 чата → «Продолжить» первым.

**Сессия:** sonnet, high; параллельно с 2 (разные репо, контракт зафиксирован).

### 4. Боковая панель: группы и секция «Задачи» — **sonnet, high**, после 1

- [ ] `agentura.tasks.sidebar` по чек-листу настройки-вида (значения `groups|section`, превью — `SidebarPreview`
      с фикстурой групп)
- [ ] `groups`: заголовок группы — ключ, статус-пилюля, число чатов, «＋», сворачивание (состояние в
      `setState` webview), заголовок задачи второй строкой; чаты вложены; «Без задачи» в конце. Вёрстка —
      `prototype/screens/tasks.html#a`, стили `prototype/shared/tasks.css`
- [ ] `section`: секция «Задачи» (карточки задач, движки чатов, «＋») над «Сессиями», в строке сессии — метка
      ключа справа (`tasks.html#c`)
- [ ] все три вида списка (`sessionList.view`) и три вида верха работают с группами; тесты `sessionsDom.test.ts`
- [ ] контекстное меню строки: «Привязать к задаче…» / «Отвязать от задачи»

**Готово, когда:** `npm run check` зелёный; DOM-тесты на оба вида; превью в настройках рисуется.

**Сессия:** sonnet, high; после 1 (после 2 — если исполнитель один; файлы не пересекаются, но одно репо —
последовательно).

### 5. Вкладка чата: полоска, вкладка «задача», сплит — **sonnet, high**, после 2 и 4

- [ ] `agentura.tasks.card` по чек-листу (значения `panel|split|strip`, превью-карточки; `split` при источнике не
      Jiraffe — как `panel`, пометка в превью)
- [ ] полоска задачи над лентой (решение 8; `task-mode.html#open`)
- [ ] вкладка правой панели `task`: `PanelState['tab']`, `panelAll`, панель в `<aside>`, кнопка в полосе с
      бейджем, узкий режим (вкладки в шапке), строки `ui.tabs.*`; содержимое по решению 10 (`task-mode.html#open`,
      `#comment`, `#changes`, `#rail`)
- [ ] «в чат» у плашки комментария человека → `task.toComposer` → `composer.prefill`
- [ ] `split`: при открытии чата по задаче — `JiraffeSource.openIssue(inst, key, false)` в активной колонке, чат —
      `Beside` (`tasks.html#c`)
- [ ] ошибки источника: нет подключения / 401 / сеть — строка в шапке панели с «подключить» / «повторить»
- [ ] DOM-тесты панели (новое событие → бейдж и кромка, плашка человека, `humanChanges=false` прячет)

**Готово, когда:** `npm run check` зелёный; DOM-тесты зелёные.

**Сессия:** sonnet, high; после 2 и 4.

### 6. Страница настроек «Интеграции» — **sonnet, high**, после 5

- [ ] шестая страница `integrations` в `Settings.tsx` по решению 14 (`task-mode.html#settings`); стрелки ↑↓ и
      узкий сплит — как у остальных страниц
- [ ] сообщения: список своих подключений, «подключить» / «проверить» / «удалить» → команды этапа 2
- [ ] `settingsDom.test.ts`: страница рисуется для «Jiraffe есть», «Jiraffe нет, 2 своих», «ничего»

**Готово, когда:** `npm run check` зелёный.

**Сессия:** sonnet, high; после 5.

### 7. Вкладка на задачу (вариант Б) — **opus, high**, после 6

Вкладка редактора держит несколько сессий. Самый дорогой этап: сейчас `ChatController` = одна сессия и одна
webview. Сначала спайк, потом реализация или остановка с решением владельца.

- [ ] спайк (≤ 1 ч, без кода в `src/`): можно ли отцепить идущий `ChatController` от webview и прицепить обратно
      (идущий ход продолжается, при возврате — `loadHistory` + текущее состояние хода); итог — в раздел «Решения
      по итогам этапа 7» этого файла
- [ ] при «да»: `agentura.tasks.tab` по чек-листу (`chat|task`, превью); панель задачи держит `Map<sessionId,
      ChatController>`, внутренние вкладки чатов под полоской (`tasks.html#b`, `#d`), «＋» — новый чат в той же
      вкладке; бейдж «ждёт ответа» на внутренней вкладке; Reload Window восстанавливает все чаты вкладки
- [ ] при «нет»: остановиться, в отчёт — что мешает и цена; вариант Б уходит в pending на решение владельца

**Готово, когда:** спайк записан; при реализации — `npm run check` зелёный и тест восстановления панели задачи
из serializer-состояния.

**Сессия:** opus, high; после 6 (трогает `chatPanel.ts`/`chatController.ts`, конфликтует со всем).

### 8. Инструменты Jira для агента (Claude) — **opus, high**, после 7; Jiraffe API v2 — параллельно

- [ ] Agentura: `addComment` в копии клиента (`POST /rest/api/2/issue/{key}/comment`, тело — wiki-текст), `transition`,
      `addWorklog` (без Tempo — только Jira worklog; Tempo — допущение «потом»)
- [ ] MCP-сервер `jira` (решение 13) в Claude-адаптере, только когда сессия в группе и источник даёт запись;
      ключ задачи по умолчанию — из группы; `agentura.jira.agentTools`
- [ ] `toolView.ts`: `mcp__jira__*` → op `jira`, «jira · комментарий KEY», ссылка «в задаче →» открывает вкладку
      «задача» и прокручивает к событию; немедленное обновление карточки после результата
- [ ] разрешения: `transition`, `worklog` — карточка разрешения как у прочих инструментов
- [ ] Jiraffe (репо jiraffe, параллельно): API v2 — `addComment` (новый метод клиента), `transitions`,
      `transition`, `logWork` (через `submitWorklog`, с Tempo); `apiVersion: 2`, v1 совместим
- [ ] тесты: MCP-инструменты на фейковом источнике; `toolView` для `mcp__jira__comment`

**Готово, когда:** `npm run check` зелёный в обоих репо; живой прогон — в pending.

**Сессия:** opus, high (запись во внешнюю систему от имени пользователя, разрешения); Jiraffe-часть — sonnet,
high параллельно.

### 9. Релиз 0.9.0 — **сам (Opus) или sonnet, medium**, после 8

- [ ] `docs/features.md` — строка A16 «Чаты по задачам Jira»; `CHANGELOG.md` (английский); README — раздел и
      скриншот
- [ ] галерея «Режим задачи: настоящий webview» (`scripts/readme-shots/` + фикстура задачи), раздел в артефакте
- [ ] `19-jira-tasks.pending.md` — ручные проверки (живой Jira DC и Cloud, Jiraffe 0.8.0 и без него, своё
      подключение в двух воркспейсах, комментарий агента, комментарий человека во время хода, Reload Window)
- [ ] версия 0.9.0, `npm run package`, vsix без `.codex/` и `AGENTS.md`

**Готово, когда:** vsix собран, pending-файл есть.

## Промты сессий

Общая шапка для всех промтов Agentura (вставляется в начало каждого):

```
Работаем в /Users/fost/Projects/Agentura, ветка feature/task-groups. Правила репо — /Users/fost/Projects/Agentura/CLAUDE.md
(если есть) и стиль окружающего кода (комментарии по-русски, их плотность — как рядом).
Читай: docs/roadmap/19-jira-tasks.md — разделы «Контекст», «Решения», «Чек-лист настройки-вида» и свой этап.
Точки входа в «Контексте» проверены при планировании — не перечитывать их ради подтверждения, открывать только
фрагмент, который правишь. Файлы > 300 строк целиком не читать: grep -n по сигнатурам, потом кусок.
Длинный вывод команд — в файл ($TMPDIR/x.log), в контекст только tail -30 и grep FAIL|error.
Решения из раздела «Решения» не переспрашивать и не менять. Вопрос без ответа в roadmap — в отчёт, не додумывать.
Галочки в roadmap — по факту проверки.
Не делать: «заодно улучшить», правки вне этапа, чужие незакоммиченные файлы (.codex/, AGENTS.md) не трогать.
Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

### Промт 1

```
Сессия 1 — группы чатов по задачам, хост · Модель: sonnet, effort: high · первая
<общая шапка>
Задача: этап 1 roadmap — заменить «внешний ключ → одна сессия» на группы задач (решения 1, 2, 7, 8, 12 без Jira-данных).
Эталон: src/extension/sessionMemory.ts (MementoLike, стиль миграции openSessions), contextRequest.ts (проверка
недоверенного ввода), chatPanel.ts:327 openWithContext и :567 setKeyed, extension.ts:332 регистрация команды.
Порядок — чекбоксы этапа 1 сверху вниз.
DoD: «Готово, когда» этапа 1. Проверка: npm run check.
```

### Промт 2

```
Сессия 2 — источники Jira и сервис задачи · Модель: sonnet, effort: high · после приёмки сессии 1
<общая шапка>
Задача: этап 2 roadmap (решения 3, 4, 5, 6, 10 — данные, 11, 12).
Копируешь из /Users/fost/Projects/jiraffe (только чтение, ничего там не правишь): src/jira/http.ts, client.ts
(нужные методы), mappers.ts, types.ts, src/panels/aiContext.ts (htmlToText, issueContext), их тесты из test/ и
test/fixtures/issue-dc.json. Зависимость ../l10n у Jiraffe заменить на src/shared/l10n.ts Agentura или строки на месте.
Шаги команды подключения — по образцу jiraffe src/commands/instances.ts:96 (addInstance).
JiraffeSource работает с API из решения 6 — его ещё может не быть в установленном Jiraffe; это нормально, тест на
фейковом exports.
DoD: «Готово, когда» этапа 2. Проверка: npm run check.
```

### Промт 3

```
Сессия 3 — Jiraffe API v1 и «Открыть в Agentura» · Модель: sonnet, effort: high · параллельно с сессией 2
Работаем в /Users/fost/Projects/jiraffe, создать ветку feature/agentura-tasks от main.
Читай: /Users/fost/Projects/Agentura/docs/roadmap/19-jira-tasks.md — «Контекст» (часть Jiraffe), решения 1, 6, 7 и
этап 3. Точки входа: src/extension.ts:29 activate; src/panels/issuePanel.ts:259 askAi, :37 CARD_ACTIONS, :242
флаг ai; webview/render.ts (кнопка), webview/issue.ts (события); src/panels/protocol.ts; l10n — как у соседних строк.
Контракт API — дословно решение 6, не расширять. Agentura старой версии (без agentura.taskSessions) должна
работать как сейчас.
DoD: «Готово, когда» этапа 3. Проверка: npm run lint && npm test && npm run build.
Не коммитить, не пушить. Не трогать репо Agentura. Отчёт — последним сообщением: сделано / отклонения / не
проверено / вопросы.
```

### Промт 4

```
Сессия 4 — группы в боковой панели · Модель: sonnet, effort: high · после приёмки сессии 2
<общая шапка>
Задача: этап 4 roadmap (решение 9, agentura.tasks.sidebar). Вёрстка — prototype/screens/tasks.html (#a — groups,
#c — section) и prototype/shared/tasks.css: перенести в media/*.css на токенах VS Code, как сделано для лимитов
(media/hud.css). Эталон настройки-вида — agentura.sidebar.limits, места — «Чек-лист настройки-вида».
Компоненты: src/webview/components/Sidebar.tsx, src/webview/sessionsView.ts; превью — SettingsPreview.tsx:581.
DoD: «Готово, когда» этапа 4. Проверка: npm run check.
```

### Промт 5

```
Сессия 5 — режим задачи во вкладке чата · Модель: sonnet, effort: high · после приёмки сессии 4
<общая шапка>
Задача: этап 5 roadmap (решения 8, 9 — tasks.card, 10, 11 — сторона webview). Вёрстка — prototype/screens/task-mode.html
(#open, #comment, #changes, #rail) и tasks.html#c (split). Точки входа: src/webview/components/Chat.tsx:334 panelAll,
:608 rail; SidePanes.tsx (эталон панели — ChangesPane); src/webview/vscode.ts:21 PanelState; TabBar.tsx (бейджи).
Данные — сообщение task.state из этапа 2 (src/protocol.ts).
DoD: «Готово, когда» этапа 5. Проверка: npm run check.
```

### Промт 6

```
Сессия 6 — страница настроек «Интеграции» · Модель: sonnet, effort: high · после приёмки сессии 5
<общая шапка>
Задача: этап 6 roadmap (решение 14). Вёрстка — prototype/screens/task-mode.html#settings. Эталон страницы —
src/webview/components/Settings.tsx (страницы session|limits|sidebar|look|engine), строки — strings.ts/strings.en.ts.
DoD: «Готово, когда» этапа 6. Проверка: npm run check.
```

### Промт 7

```
Сессия 7 — вкладка на задачу (вариант Б) · Модель: opus, effort: high · после приёмки сессии 6
<общая шапка>
Задача: этап 7 roadmap. Сначала спайк (без правок src/): как ChatController (src/extension/chatController.ts — resume
:392, doResume :405, teardown) и ChatPanel (chatPanel.ts — panels :215, apply :265, serializer) поведут себя, если
у одной WebviewPanel несколько контроллеров и активен один. Итог спайка — в раздел «Решения по итогам этапа 7»
roadmap. Если путь есть и он укладывается в этап — реализуй по чекбоксам; если нет — остановись и опиши в отчёте
препятствие и цену.
Вёрстка — prototype/screens/tasks.html#b и #d.
DoD: «Готово, когда» этапа 7. Проверка: npm run check.
```

### Промт 8

```
Сессия 8 — инструменты Jira для агента (Claude) · Модель: opus, effort: high · после приёмки сессии 7
<общая шапка>
Задача: этап 8 roadmap, часть Agentura (решение 13). Точки входа: src/agent/claude/adapter.ts:397 mcpServers;
src/webview/toolView.ts:44 toolView, :40 shortName; копия клиента src/data/jira/client.ts (этап 2).
SDK — проверить createSdkMcpServer/tool в установленной версии @anthropic-ai/claude-agent-sdk (node_modules, d.ts),
не по памяти. Jiraffe API v2 делает параллельная сессия 8b — в Agentura опираться на контракт: addComment(inst, key,
text), transitions(inst, key), transition(inst, key, id), logWork(inst, key, {seconds, started, comment}), apiVersion 2.
DoD: «Готово, когда» этапа 8. Проверка: npm run check.
```

### Промт 8b

```
Сессия 8b — Jiraffe API v2 (запись) · Модель: sonnet, effort: high · параллельно с сессией 8
Работаем в /Users/fost/Projects/jiraffe, ветка feature/agentura-tasks.
Читай: /Users/fost/Projects/Agentura/docs/roadmap/19-jira-tasks.md — решение 6 и этап 8 (пункт про Jiraffe).
Добавить в JiraClient addComment(key, body) — POST /rest/api/2/issue/{key}/comment; в API: addComment, transitions,
transition, logWork (через src/jira/worklog.ts:148 submitWorklog), apiVersion: 2; v1-методы без изменений. Тесты
клиента — по образцу test/client.test.ts.
DoD: npm run lint && npm test && npm run build зелёные. Не коммитить, не пушить, Agentura не трогать.
Отчёт — последним сообщением: сделано / отклонения / не проверено / вопросы.
```

## Риски и открытые вопросы

- **Вариант Б (этап 7) — самый дорогой**, может не уложиться: модель «вкладка = сессия» прошита в контроллер,
  восстановление и маршрутизацию. Спайк первым; при «нет» — решение владельца (выкинуть Б или отдельный roadmap).
- **Своё подключение дублирует Jiraffe** (клиент, команды подключения): копия будет расходиться с оригиналом.
  Шапка-источник в каждом файле; при правках клиента в Jiraffe — сверять вручную. Вынести в общий npm-пакет —
  отдельная задача, не здесь.
- «Из этого чата» — эвристика по времени и автору; при двух чатах одной задачи, идущих одновременно, метка может
  достаться не тому. Проверить вживую (pending).
- Опрос 30 с × число задач с видимыми вкладками — нагрузка на Jira мала, но для Cloud есть rate limit; при 429 —
  растягивать интервал (сделать в этапе 2, если окажется нужно — в отчёт).
- Jiraffe на Marketplace: API v1 — публичный контракт, ломать его потом нельзя.
- **Вопрос владельцу:** `split` без Jiraffe — сейчас падает на `panel`. Нужна ли своя карточка-вкладка редактора
  Agentura для своего подключения? (Не в плане.)
- **Вопрос владельцу:** инструменты агента для Codex/Antigravity — не в плане (решение 13).

## Порядок работы

1 → 2 ∥ 3 (разные репо) → 4 → 5 → 6 → 7 → 8 ∥ 8b → 9. Каждый этап — исполнитель-субагент, затем приёмка
`/plan-review` с коммитом в `feature/task-groups` (Jiraffe — в `feature/agentura-tasks`). До старта этапа 1
закоммитить прототип (`prototype/screens/tasks.html`, `task-mode.html`, `prototype/shared/tasks.css`, README) и
этот файл.
