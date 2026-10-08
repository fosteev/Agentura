# 19 — Чаты по задачам Jira: группы, режим задачи, своё подключение и Jiraffe

> **Статус:** этап 1 принят 2026-10-08 (ветка `stage-1-task-groups` от `feature/task-groups`); этап 3 (Jiraffe) принят
> отдельной приёмкой (`feature/agentura-tasks`, 30d982d); этап 2 принят 2026-10-08 (ветка `stage-2-jira-sources`); этап 4 принят 2026-10-08 (ветка `stage-4-sidebar-tasks`); этап 5 принят 2026-10-08 (ветка `stage-5-task-tab`, вёрстка — ручная проверка в pending); этап 6 принят 2026-10-08 (ветка `stage-6-integrations`, вёрстка и живые действия — ручная проверка в pending); этап 7 принят 2026-10-08 (ветка `stage-7-task-tab-per-task`, вёрстка и живое переключение/Reload Window — ручная проверка в pending); следующий — **8**. Ветка roadmap `feature/task-groups`
> (от `feature/engine-limits`, 0.8.0 ещё не в main).
> Прототип — `prototype/screens/tasks.html` (`#a|#b|#c|#d|#ask`) и `prototype/screens/task-mode.html`
> (`#open|#comment|#changes|#rail|#jiraffe|#settings`); галерея v38, разделы «Режим задачи» и «Чаты по задачам Jira».
> Исполнитель отмечает чекбоксы по ходу работы — по факту проверки. Ручные проверки и решения на
> подтверждение — `19-jira-tasks.pending.md` (пополняется приёмкой каждого этапа).

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

- [x] `src/extension/taskGroups.ts`: `TaskKey`, `TaskMeta`, `parseTaskKey` (`jira:` и `jiraffe:`), `TaskGroups`
      над `MementoLike` (`groups()`, `groupOf(sessionId)`, `add(taskKey, meta, ref, openedAt)`, `remove(sessionId)`,
      `updateMeta`), миграция из `agentura.keyedSessions` (решение 2); тесты `taskGroups.test.ts`
- [x] `sessionMemory.ts`: `keyed/setKeyed` удалены, вызовы переведены на `TaskGroups`
- [x] `contextRequest.ts`: поля `task` и `session` (проверка недоверенного ввода, ограничения длины как у
      остальных полей); тесты в `contextRequest.test.ts`
- [x] `ChatPanel.openWithContext`: `session` = id → возобновить его; `'new'` → новая вкладка в группе; не задан →
      последний чат группы (по `updatedAt`), если есть, иначе новый
- [x] команда `agentura.taskSessions` (служебная, без палитры) → `{id, provider, title, updatedAt, live}[]`
- [x] `SessionSummary` + `task?: { key; title; status?; statusCategory? }`; `sessions.update` несёт группы
      (`tasks: {taskKey, meta, sessionIds}[]`) — протокол и `protocol.test.ts`
- [x] (код и парсер ввода проверены тестами; живой прогон — `19-jira-tasks.pending.md`) команды «Agentura: Привязать вкладку к задаче…» (ввод ключа вида `NEWMFC-1482` или ссылки; инстанс —
      из ссылки или выбор из известных групп/подключений; Jira не запрашивается) и «Отвязать от задачи»;
      nls ru/en
- [x] заголовок вкладки в режиме задачи «KEY · название» (`tabLabel`)

**Готово, когда:** `npm run check` зелёный; тест миграции `keyedSessions → taskGroups`; тест `openWithContext`
с `session: 'new'` / id / без поля (юнит на маршрут); `agentura.taskSessions` возвращает чаты группы.

**Сессия:** sonnet, high; первая, последовательно (всё дальше опирается на модель).

**Решения (2026-10-08, по итогам сессии 1):**

Раскладка файлов (`src/extension/`):
- `taskGroups.ts` — модель и чистая логика без vscode: `TaskKey`, `TaskMeta`, `TaskGroup`, `taskKeyOf`, `parseTaskKey`,
  `taskMeta` (проверка недоверенного ввода), класс `TaskGroups` (`groups() group(key) groupOf(id) add remove updateMeta
  onChange`), `taskSessionRows`, `routeTaskOpen`, `decorateSessions`. Тесты — `taskGroups.test.ts`.
- `taskLink.ts` — `parseIssueInput` (ключ / ссылка на задачу / ключ группы), `canonicalBaseUrl` и `instanceIdFromUrl`
  (копия Jiraffe 0.7.0, id совпадает), `bareMeta`. Тесты — `taskLink.test.ts`.
- `taskCommands.ts` — `registerTaskCommands(services)`: `agentura.bindTask`, `agentura.unbindTask` (необязательный аргумент —
  id сессии из строки списка). `agentura.taskSessions` зарегистрирована в `extension.ts` рядом с `openWithContext`.
- `ChatPanel`: `bind(taskKey, meta)`, `unbind()`, статические `target()` и `panelOf(id)`; `pendingKey` заменён на
  `pendingTask`; `ChatServices.taskGroups`. `ChatController.setTask(key)` / `.task` — ключ в заголовке вкладки
  (`tabTitle(..., taskKey?)` в `agent/status.ts`: «● KEY · название», обрезается только название).
- `SidebarProvider` получает `taskGroups` (5-й параметр) и шлёт `sessions.update` с метками.

Контракт (на него опираются этапы 2–5):
- Хранилище `workspaceState['agentura.taskGroups']`: `Record<TaskKey, { task: TaskMeta; sessions: SessionRef[];
  openedAt: Record<sessionId, number> }>`; `TaskKey = 'jira:<instanceId>:<KEY>'` (ключ в верхнем регистре, id — в нижнем).
  `TaskMeta = { key; instanceId; title; status?; statusCategory?: 'new'|'indeterminate'|'done'; url }` — `url` всегда
  строка (пустая, если неизвестна; только http/https). Группа без сессий не хранится; сессия — максимум в одной группе.
- `TaskGroups.add(taskKey, meta, ref, openedAt)` идемпотентен: у уже состоящей в группе сессии `openedAt` не меняется.
  `updateMeta`/`add` сливают метаданные: «голое» название (= ключ) и пустая `url` хорошее не затирают — этапу 2 можно
  вызывать `updateMeta(taskKey, {title, status, statusCategory, url})` после каждого опроса. Подписка — `onChange(cb)`.
- `agentura.openWithContext`: `{ name?, context, prompt?, sessionKey?, task?: TaskMeta, session?: string }`; `task`
  проверяется `taskMeta` (key `[A-Za-z][A-Za-z0-9_]*-\d+`, instanceId `[a-z0-9-]{1,200}`, title ≤ 500, status ≤ 100,
  url ≤ 2000 и http(s)). Нет `task`, но `sessionKey` вида `jiraffe:<инстанс>:<KEY>` (Jiraffe 0.7.0 / Agentura 0.8.0) —
  задача берётся из него (название = ключ). `session`: `'new'` | id чата группы | нет (= последний чат группы по `updatedAt`
  среди тех, что есть в списке сессий; иначе новая вкладка). Id не из группы трактуется как «не задан».
- `agentura.taskSessions({instanceId, key})` → `{id, provider, title, updatedAt, live}[]`, новые сверху; только чаты из
  списка сессий проекта (отправленные хотя бы раз); `live` = состояние `live|waiting`. Неверный аргумент — `[]`.
- Протокол: `SessionSummary.task?: {key; title; status?; statusCategory?}`; `sessions.update.tasks?: TaskGroupSummary[]`
  (`{taskKey, meta, sessionIds}`, id только из присланного списка, порядок как в списке; поле только в боковой панели,
  у вкладки чата его нет; пустой массив не шлётся). Webview пока поле не читает — это этап 4.
- Чат входит в группу, когда движок прислал id сессии (`onSession`); привязка уже начатой сессии — сразу. Вкладка при
  открытии/возобновлении берёт ключ из группы (`groupOf`).

Отступления и почему:
- Миграция `keyedSessions`: переезжают только `jiraffe:*`; прочие ключи остаются в старом хранилище нетронутыми (ключ
  удаляется, только если чужих нет). `keyed/setKeyed` удалены, поэтому `sessionKey` без распознаваемой задачи больше
  не возобновляет сессию — единственный известный вызывающий (Jiraffe) шлёт ключ `jiraffe:*`.
- `openedAt` у мигрированных сессий = 0 (время входа неизвестно); этап 2/5 должен трактовать 0 как «с начала».
- `ListedRow`/`taskSessionRows` ищут сессию в списке по паре (id, provider) — различие Claude/Codex соблюдается.
- Привязка с ключом без ссылки (`NEWMFC-1482`) возможна только к инстансу, уже известному по группам; своих подключений
  и Jiraffe в этапе 1 нет, поэтому первый раз нужна ссылка. После этапа 2 — расширить `knownInstances` (`taskCommands.ts`)
  подключениями и инстансами Jiraffe.
- Для вкладки чата (`sessions.update` внутри `ChatPanel`) метки задач не добавлялись — не нужны до этапа 5.

**Приёмка этапа 1 (2026-10-08):** контракт с Jiraffe 0.8.0 (30d982d) сверен — `task` и `session` важнее `sessionKey`
(Jiraffe шлёт `sessionKey` всегда), `updatedAt` в мс, id ≤ 200 у обоих. Правки приёмки: вкладка задачи без
отправленных сообщений переиспользуется повторным `openWithContext` той же задачи (и при `'new'`) и больше не считается
пустой (`views().pristine`) — раньше клик по другой сессии или другой задаче забирал её вместе с `pendingTask` и
файлом контекста; `/clear` во вкладке по задаче снимает ключ из заголовка сразу; `sessionKey`/`session` длиннее 200
отбрасываются, а не режутся (обрезанный ключ — другая задача); `TaskGroups.add` не пишет группу с ключом не своей
задачи и битый id, `readGroups` такие отбрасывает; «Отвязать» на непривязанном чате говорит «не привязан».
Известные ограничения: удаления сессий в Agentura нет — ссылки на пропавшие сессии в группах не чистятся, а
отфильтровываются при чтении (`taskSessionRows`, `decorateSessions`); `knownInstances` их учитывает (этап 4 — при
желании чистить по `sessions.onChange`). Сессии сравниваются по id без провайдера (кроме `taskSessionRows`).
`pendingTask` не переживает Reload Window: у вкладки без отправленных сообщений ключ из заголовка пропадает.

Не проверено: команды `bindTask`/`unbindTask`, `taskSessions` и `openWithContext` в живом VS Code (склейка `ChatPanel`
проверена только typecheck/lint; логика маршрута, парсеры и хранилище — юнит-тестами); восстановление ключа в заголовке
после Reload Window; отображение в сайдбаре (этап 4). Проверки: `npm run check` (TZ=UTC) — 118 файлов, 1555 тестов, зелёный.

### 2. Источники Jira: своё подключение и Jiraffe (хост) — **sonnet, high**, после 1

Копия клиента, два источника за одним интерфейсом, сервис задачи с опросом и лентой изменений.

- [x] `src/data/jira/`: копии `http.ts`, `client.ts` (`myself`, `issue`, `issueDetail`, `worklogs`), `mappers.ts`,
      `types.ts`, `text.ts` (`htmlToText`, `issueContext`) с шапкой-источником (решение 5); тесты копируются вместе с
      фикстурой `test/fixtures/issue-dc.json` Jiraffe
- [x] сверить: Jiraffe `src/commands/instances.ts` — id инстанса = `instanceIdFromUrl` (решение 1); расхождение —
      в отчёт
- [x] `src/extension/jira/source.ts`: `interface JiraSource { kind: 'jiraffe'|'own'; instances(); issue(inst,key);
      myself(inst); openIssue?(inst,key,beside) }`; `OwnSource` (решение 4, `context.secrets`), `JiraffeSource`
      (`vscode.extensions.getExtension('fosteev.jiraffe')` → `activate()` → `exports.apiVersion >= 1`),
      `resolveSource(setting)` по решению 3, пересчёт при установке/удалении расширений и смене настройки
- [x] (код и чистая логика проверены тестами; живой прогон — пользователь) команды «Agentura: Подключить Jira…», «Отключить Jira…», «Проверить подключение Jira» — шаги по образцу
      Jiraffe `src/commands/instances.ts:96`; nls ru/en
- [x] `src/extension/jira/taskService.ts` (+ `taskEvents.ts`): `TaskCard` (решение 10, текст вместо HTML), `TaskEvent`
      `{kind:'status'|'field'|'comment'|'worklog', at, author, mine, fromThisChat, text}`, `eventsSince(card,
      openedAt, turns)`; опрос по решению 11; кеш карточки на задачу (одна выборка на все вкладки группы)
- [x] протокол: `task.state {card?, events, error?, fetchedAt, source}` хост → вкладка чата;
      `task.refresh`, `task.toComposer {commentId}`, `task.openExternal` вкладка → хост
- [x] настройки `agentura.jira.source`, `agentura.tasks.refresh`, `agentura.tasks.humanChanges` (без превью)
- [x] (код и разбор ввода проверены; живой прогон — пользователь) команда «Agentura: Чат по задаче…» (решение 12) — с источником тянет карточку и кладёт `issueContext` файлом

- [x] (решение владельца 2026-10-08) `/clear` во вкладке задачи: новая сессия остаётся в группе той же задачи
      (перенести задачу в `pendingTask`, заголовок «KEY · …» не снимать); тест

**Готово, когда:** `npm run check` зелёный; тесты `eventsSince` (статус, комментарий агента «из этого чата»,
комментарий человека, ворклог) на фикстуре; тест `resolveSource` на четыре значения настройки × «Jiraffe есть/нет».

**Сессия:** sonnet, high; после 1. Можно параллельно с этапом 3 (другое репо, контракт — решение 6).

**Решения (2026-10-08, по итогам сессии 2):**

Раскладка файлов:
- `src/data/jira/` — копия чистого слоя Jiraffe 0.7.0 (в шапке каждого файла: источник и список правок): `types.ts`, `http.ts`
  (только `HttpClient.getJson`, `authHeader`, `normalizeBaseUrl`, `JiraError`; **без** `getBinary`, `postJson`, `isOwnUrl`,
  `canonicalBaseUrl` — последний уже в `extension/taskLink.ts`), `client.ts` (`myself`, `issue`, `watchers`, `worklogs`,
  `issueDetail`, `createJiraClient`; из `issueDetail` убран best-effort запрос названия эпика DC), `mappers.ts` (без
  `mapVersion`), `text.ts` (`htmlToText`, `issueContext`; `IssueCard` Jiraffe заменён на `{instanceName, issue}`), `i18n.ts`
  (замена `l10n.ts` Jiraffe: ключ — английский текст, перевод ru в таблице, `setJiraLang`; по умолчанию `en`). Тесты
  `http/mappers/text.test.ts` — копии тестов Jiraffe (без sanitize/epics/поиска), фикстура `test/fixtures/jira/issue-dc.json`.
- `src/shared/task.ts` — типы для хоста и webview (без vscode): `TaskCard`, `TaskEvent`, `TaskStateMessage`, `TaskRequest`,
  `TaskError`/`TaskErrorCode`, `TaskSourceKind`, `isTaskRequest`.
- `src/extension/jira/`: `jiraffeApi.ts` (интерфейс API v1 + `parseJiraffeApi(exports)`), `ownInstances.ts`
  (`OwnInstanceStore`, `workspaceId`, `ownTokenKey`), `source.ts` (`JiraSource`, `JiraffeSource`, `OwnSource`,
  `resolveSourceKind`, `JiraSources`, `normalizeIssueKey`), `taskEvents.ts` (`buildSnapshot`, `eventsSince`, `TurnLog`),
  `taskService.ts` (`TaskService`), `taskTab.ts` (`TaskTab` — связка вкладки чата с сервисом), `connectCommands.ts`
  (команды подключения), `setup.ts` (`createJira(context, taskGroups)` — всё вместе, читает настройки). Тесты рядом.
- `ChatServices` получил `tasks: TaskService` и `jira: JiraSources`. `registerTaskCommands(context, log, services)` (раньше
  только `services`); `knownInstances(groups, sources)` теперь учитывает инстансы Jiraffe и своих подключений.

Контракт (на него опираются этапы 4–6, 8):
- **Протокол.** Хост → вкладка: `{ type: 'task.state'; taskKey?: string; card?: TaskCard; events: TaskEvent[]; error?: TaskError;
  fetchedAt: number; source: 'jiraffe'|'own'|'none' }` — на `ready` webview, после каждой загрузки, при смене привязки и
  видимости; нет `taskKey` — вкладка вне задачи (сбросить). Есть `card` и `error` одновременно — карточка устарела (последняя
  удачная), рядом причина. Вкладка → хост: `{ type: 'task.refresh' }`, `{ type: 'task.toComposer'; commentId }` (хост
  вставляет `«KEY · автор:\nтекст»` через `composer.prefill`, не отправляет), `{ type: 'task.openExternal'; attachmentId? }`
  (без поля — задача: при источнике Jiraffe `openIssue(…, beside=true)`, иначе/при сбое — ссылка в браузере; с полем —
  вложение по id из последнего снимка, только http/https). Запросы разбирает `TaskTab.handle`, до `ChatController` не доходят.
- **`TaskCard`**: `key, instanceId, instanceName, title, type, status, statusCategory, assignee?, priority?, url, updatedAt (мс),
  description (текст ≤ 20 000), attachments[{id, filename, size, mimeType, url}], comments[{id, author, mine, at, text}]`
  (новые снизу). Описание и комментарии — **текст**: webview обязан рисовать его как текст (`textContent`), не как HTML.
- **`TaskEvent`**: `id, kind ('status'|'field'|'comment'|'worklog'), at (мс), author, mine, fromThisChat, duringTurn, text,
  field?/from?/to? (status, field), commentId? (comment)`. Лента — новые сверху, только `at > openedAt` сессии (0 — с начала),
  не больше 100. `mine` = автор совпал с `myself` (Cloud — `accountId`, DC — `name`; `myself` не ответил — `mine` везде
  `false`). `fromThisChat` = `mine` и `at` внутри хода сессии + 60 с. **`duringTurn`** (новое поле, нужно для плашки) =
  `at` внутри хода без запаса: плашка «<имя> прокомментировал(а), пока агент работал» — `kind==='comment' && !mine &&
  duringTurn`; `humanChanges=false` хост применяет сам (не-`mine` события в ленту не попадают). Время ворклога — `started`
  (когда работа сделана), не момент записи. Бейдж «новое с прошлого просмотра» хост не считает — этап 5 сравнивает
  `event.at` со своим `lastSeen`.
- **Ходы** вкладки: `ChatController.turns()` (журнал `TurnLog`: `turn.start`/`turn.result` главного агента, в памяти, `/clear`
  обнуляет; после Reload Window журнал пуст — «из этого чата» у старых событий не определяется). Новый dep
  `ChatDeps.onEvent(e)` (каждое событие движка) — по нему `TaskTab` подталкивает загрузку после `turn.result` и после
  `tool.result`, в тексте которого есть ключ задачи (без учёта регистра).
- **Опрос**: `TaskService` держит запись на задачу (кеш общий для вкладок группы, у каждой вкладки своя лента по её
  `openedAt` и ходам). Таймер 30 с — только пока видна хотя бы одна вкладка и `tasks.refresh = '30s'`; загрузка не чаще
  раза в 5 с на задачу (↻ тоже: в окно 5 с вкладка получает кеш); первая загрузка — при открытии вкладки в любом режиме,
  в `manual` затем только ↻. После каждой загрузки `TaskGroups.updateMeta` — только если title/status/statusCategory/url
  изменились (иначе сайдбар перерисовывался бы каждые 30 с).
- **Источник** (`JiraSources`): `current()` по `resolveSourceKind` (решение 3), `forInstance(id)`, `allInstances()`,
  `jiraffeStatus() → {state: 'absent'|'no-api'|'ready'|'inactive', instances, apiVersion?}` (`inactive` — добавлено приёмкой) и `ownInstances()` — для страницы
  «Интеграции» (этап 6), `refresh()`/`onDidChange`. Jiraffe активируется только при `auto`/`jiraffe`. `exports === undefined`
  (недоверенный воркспейс) и бросок `activate()` = `no-api`. Токен своего подключения — `agentura.jira.token.<wsId>.<id>`,
  `wsId = sha1(URI первой папки)` / `global`; список — `workspaceState['agentura.jira.instances']`.
- **Команды**: `agentura.jira.connect`, `agentura.jira.disconnect(instanceId?)`, `agentura.jira.test(instanceId?)`,
  `agentura.chatForTask(taskKey?)` (аргумент — ключ группы `jira:<инстанс>:<KEY>` — без вопроса; нужен этапу 4 для «＋»).
- **Настройки** (`src/settings.ts`: `JIRA_SOURCES`, `DEFAULT_JIRA_SOURCE`, `TASK_REFRESH_MODES`, `DEFAULT_TASK_REFRESH`): в
  `SettingKey`/`SettingsValues` и в страницу настроек не добавлялись — это этап 6 (`setup.ts` читает конфигурацию напрямую).
- **`/clear`** (решение владельца): `ChatDeps.onSession(id, why?: 'clear')`; чистая функция `nextTabTask` (taskGroups.ts):
  задача из группы переходит в `pendingTask`, ключ в заголовке остаётся, пришедшая сессия входит в ту же группу. Сбой
  возобновления по-прежнему в группу не входит. Распространяется и на «новую сессию» кнопкой во вкладке (тот же `newSession`).

Отступления и почему:
- `eventsSince(snapshot, openedAt, turns, {now, humanChanges, limit})` — первым аргументом снимок `TaskSnapshot {card, changes}`
  (все изменения без привязки к чату), а не `card`: ленту собирает `buildSnapshot` один раз на загрузку.
- Источник при `auto`: если Jiraffe не знает инстанс задачи (вне набора воркспейса), а свои знают — берутся свои
  (`forInstance`); при явных `jiraffe`/`own` подмены нет. Решение 3 это прямо не говорит; обратимо (убрать ветку в `forInstance`).
- `manual`: `nudge` (после хода/инструмента) тоже отключён — иначе «вручную» не вручную. Решение 11 говорит о nudge без
  оговорки про режим.
- `OwnSource` не определяет capabilities (поле Epic Link DC): эпик DC в карточке не заполняется, Cloud — из `parent`.
  Карточка Agentura эпик пока не показывает.
- `canonicalBaseUrl` в `data/jira/http.ts` не дублируется — остался в `extension/taskLink.ts` (копия 0.7.0, этап 1).
- Тексты ошибок Jira — на языке хоста через `data/jira/i18n.ts` (ключ — английская фраза Jiraffe; не переведённая —
  выводится как есть).

Правки приёмки (2026-10-08, два прохода ревью):
- **Опрос после сбоя.** 401/403 (`error.code === 'auth'`) — таймер, `nudge` и «вкладка стала видимой» больше не грузят
  (опрос с плохим токеном доводит учётку DC до CAPTCHA): только ↻ (`task.refresh`) или `reconfigure` (смена
  настройки/источника, переподключение). Прочие сбои подряд (429, сеть, неизвестный инстанс) — автоматическая загрузка с
  паузой 30 с → 60 → … ≤ 10 мин (`TaskService.autoAllowed`, `MAX_BACKOFF_MS`); ↻ паузу не ждёт (окно 5 с остаётся).
- `reconfigure` во время загрузки: результат старого источника выбрасывается (`Entry.gen`), загрузка повторяется.
- Переподключение своего инстанса (тот же id, новый токен) — `notifyIfChanged(true)` → `reconfigure` (раньше набор id не
  менялся и ошибка 401 висела до ↻).
- Текст ошибки источника в `task.state` — не длиннее 500 символов.
- `buildSnapshot` проверяет типы и длины данных источника (Jiraffe — чужое расширение): строки/числа/массивы, ≤ 500
  записей каждого вида, `statusCategory` вне `new|indeterminate|done` → `new`; id событий истории уникальны (повтор в ту
  же секунду — суффикс `#n`). `JiraffeSource.instances()` — не бросает, мусорные записи отбрасывает.
- `/clear`: новая сессия входит в группу с текущими метаданными группы, а не с запомненными вкладкой (не откатывает статус).
- Второй проход (opus): журнал ходов закрывает ход и по `session.closed`/`teardown` (иначе ложные `duringTurn`); загрузка
  источника ждёт не дольше 45 с (`SOURCE_TIMEOUT_MS`, `myself` — 15 с; повисший промис Jiraffe больше не держит `inflight`);
  `htmlToText` режет вход до 100 000 символов (регулярки квадратичны на незакрытых тегах); `getJson` читает ответ с
  потолком 20 МБ (код `limit`); запись задачи в `TaskService` забывается, когда закрылась последняя вкладка и загрузки нет;
  `jiraffeStatus().state` — новое значение `inactive` (установлен, но `jira.source` = `own`/`off`: API не держим, число
  инстансов 0); смена `agentura.tasks.*` — `TaskService.settingsChanged()` (таймеры и ленты заново без сброса кеша,
  окна 5 с и блока после 401), полный `reconfigure` — только при смене источника/подключений.
- Редиректы: `getJson` ходит только на `baseUrl` + путь, `Authorization` на чужой origin при редиректе fetch (undici,
  Node ≥ 20) снимает, а сам ответ после такого редиректа — ошибка `redirect`; так же у Jiraffe 0.7.0 (`isOwnUrl` там
  только у `getBinary`/`postJson`). Запросов по адресам из ответа Jira нет.

Не проверено: живой Jira (DC/Cloud) и живой Jiraffe 0.8.0 — всё на фикстуре и фейковом `exports`/`fetch`; команды
подключения/«Чат по задаче…», `ChatPanel`-склейка (`onSession`, `TaskTab` в конструкторе, `onDidChangeViewState`), активация
Jiraffe через `extensions.getExtension('fosteev.jiraffe').activate()` — только typecheck/lint и тесты чистой логики; поведение
`panel.visible` для опроса; сообщения `task.state` webview пока не читает (этап 5). Проверки: `npm run check` (TZ=UTC) — см.
отчёт сессии (126 файлов, 1675 тестов).

### 3. Jiraffe: API v1 и «Открыть в Agentura» (репо jiraffe) — **sonnet, high**, параллельно с 2

- [x] `src/api.ts`: `JiraffeApi` ровно по решению 6; `activate()` возвращает его; `openIssue` открывает карточку
      инстанса (`beside` → `ViewColumn.Beside`); тест на форму API
- [x] `askAi` → «Открыть в Agentura»: передаёт `task` (`key, instanceId, title, status, statusCategory, url`),
      `session`; сохраняет `sessionKey` для старой Agentura
- [x] кнопка «Открыть в Agentura ▾» и меню по решению 7 (данные — `executeCommand('agentura.taskSessions', …)`,
      ошибка/нет команды — старое поведение); строки l10n ru/en, `README`, `README.ru.md`, `CHANGELOG`
- [x] версия 0.8.0 в `package.json`

**Готово, когда:** `npm run lint && npm test && npm run build` зелёные в `/Users/fost/Projects/jiraffe`;
тест меню: 0 чатов → без меню, 2 чата → «Продолжить» первым.

**Сессия:** sonnet, high; параллельно с 2 (разные репо, контракт зафиксирован).

**Решения (2026-10-08, по итогам сессии 3):**

- **Контракт API v1 (Jiraffe `src/api.ts`, коммит в `feature/agentura-tasks`)** — ровно решение 6, лишних полей нет.
  - `instances()` — только `{id, name, baseUrl, kind}` инстансов из scope воркспейса (`jiraffe.instances`);
    email, caps, токены не отдаются.
  - `issue(instanceId, key)`, `myself(instanceId)`, `openIssue(instanceId, key, beside?)` — инстанс должен быть
    в scope воркспейса, иначе reject `Jiraffe: unknown instance "<id>"`; ключ тримится и приводится к верхнему
    регистру, не `^[A-Za-z][A-Za-z0-9_]*-\d+$` → reject `Jiraffe: invalid issue key`. Нет токена → reject
    (`token not found…`), без диалогов.
  - `issue()` возвращает `IssueDetail` уже санитизированным (`sanitizeDetail`: `descriptionHtml` и `bodyHtml`
    комментариев через `sanitizeJiraHtml` — схемы http/https/mailto, картинки своего инстанса → `span.img-ph`
    с `data-src`, чужие → ссылка). Agentura всё равно гонит HTML через `htmlToText` (решение 5).
  - `myself()`: Cloud → `{accountId, displayName}`, DC → `{name, displayName}`; email не отдаётся. Для «автор =
    я» (решение 10) Agentura сравнивает с `UserRef.id` автора: Cloud — `accountId`, DC — `name`.
  - `openIssue` — Promise резолвится сразу после открытия/фокуса вкладки (загрузка карточки асинхронно);
    `beside: true`: новая вкладка — в соседней колонке; уже видимая карточка остаётся на месте, скрытая (под другой
    вкладкой) — переезжает рядом.
  - Тексты ошибок обрезают чужой ввод (ключ/instanceId) до 50 символов.
  - Доступ: API получает любое установленное расширение (`await getExtension('fosteev.jiraffe').activate()`); в
    недоверенном воркспейсе Jiraffe не активируется — API нет (`untrustedWorkspaces.supported: false`). Agentura
    обязана обрабатывать `exports === undefined`. Оговорка — в README/README.ru/CHANGELOG.
  - `onDidChangeInstances` срабатывает на добавление/удаление инстанса и на смену scope воркспейса.
- **Payload `agentura.openWithContext` от Jiraffe 0.8.0:** `{ name: '<KEY>.md', context, prompt: '<url> ',
  sessionKey: 'jiraffe:<instanceId>:<KEY>', task: { key, instanceId, title, status, statusCategory:
  'new'|'indeterminate'|'done', url }, session?: '<sessionId>' | 'new' }`. `session` есть только если
  `agentura.taskSessions` ответила массивом; Agentura при наличии `session` (или `task`) должна предпочесть его
  `sessionKey`: `'new'` — новый чат в группе задачи, id — открыть этот чат. Agentura 0.8.0 лишние поля
  игнорирует (проверено по `contextRequest.ts` 0.8.0) — работает как раньше.
- **Меню:** Jiraffe активирует Agentura, зовёт `executeCommand('agentura.taskSessions', {instanceId, key})`.
  Ответ — недоверенный: не массив → старое поведение; элементы без строкового `id` или с `id` > 200 символов
  пропускаются; `title` режется до 200, `provider` до 40, `$(` в подписи экранируется (не рисует codicon); `updatedAt` — число или ISO-строка, иначе 0; сортировка
  по `updatedAt` по убыванию, не больше 50. 0 чатов → сразу `session: 'new'` без меню. Иначе нативный QuickPick
  (не меню в вебвью): «Продолжить: <title>» (самый свежий), остальные чаты (описание — `provider · выполняется`,
  деталь — дата), разделитель, «＋ Новый чат по задаче». Закрыли меню (Esc) — ничего не открывается.
- **Нет `agentura.taskSessions` / команда бросила / вернула не массив** (Agentura 0.8.0) → payload без `session`,
  поведение 0.8.0 (одна сессия на `sessionKey`); `task` всё равно передаётся.
- **Контракт для этапа 2 (Agentura):** `agentura.taskSessions` возвращает `{id, provider, title, updatedAt: number
  (ms epoch), live: boolean}[]`; ключ группы строится из `task.instanceId` + `task.key` по решению 1.

### 4. Боковая панель: группы и секция «Задачи» — **sonnet, high**, после 1

- [x] `agentura.tasks.sidebar` по чек-листу настройки-вида (значения `groups|section`, превью — `SidebarPreview`
      с фикстурой групп)
- [x] `groups`: заголовок группы — ключ, статус-пилюля, число чатов, «＋», сворачивание (состояние в
      `setState` webview), заголовок задачи второй строкой; чаты вложены; «Без задачи» в конце. Вёрстка —
      `prototype/screens/tasks.html#a`, стили `prototype/shared/tasks.css`
- [x] `section`: секция «Задачи» (карточки задач, движки чатов, «＋») над «Сессиями», в строке сессии — метка
      ключа справа (`tasks.html#c`)
- [x] все три вида списка (`sessionList.view`) и три вида верха работают с группами; тесты `sessionsDom.test.ts`
- [ ] контекстное меню строки: «Привязать к задаче…» / «Отвязать от задачи» — код, манифест (`webview/context`) и тесты
      готовы; **живой клик правой кнопкой в VS Code — пользователь** (форма аргумента команды из меню — см. «Решения сессии 4»)
- [ ] вёрстка группы/секции/метки ключа/превью в настройках в обеих темах и трёх видах списка — **пользователь** (глазами;
      браузер в сессии не использовался)

**Готово, когда:** `npm run check` зелёный; DOM-тесты на оба вида; превью в настройках рисуется.

**Сессия:** sonnet, high; после 1 (после 2 — если исполнитель один; файлы не пересекаются, но одно репо —
последовательно).

**Решения (2026-10-08, по итогам сессии 4):**

Раскладка файлов:
- `src/settings.ts` — `TASK_SIDEBAR_MODES = ['groups','section']`, `DEFAULT_TASK_SIDEBAR = 'groups'`, `isTaskSidebarMode`, ключ
  `tasks.sidebar` в `SettingKey`/`SETTING_KEYS`/`SettingsValues`/`validateSetting`/`readSettings`. По чек-листу: `package.json`
  (настройка `agentura.tasks.sidebar`, команда `agentura.taskSidebar` — quick pick `pickTaskSidebar` в `extension.ts`),
  `package.nls*.json`, `shared/l10n.ts` (`taskSidebarViews`, `taskSidebarPlaceholder`), `protocol.ts` (`sidebar.view.tasks?`),
  `sidebarView.ts` (шлёт `tasks`, слушает `agentura.tasks.sidebar`), `strings*.ts` (`ui.sidebar.tasks.*`, `tasksSidebar` для
  настроек), `Settings.tsx` (`ChoiceCards` в странице «Боковая панель», после лимитов), `SettingsPreview.tsx`
  (`SidebarPreview part="tasks"` + `taskFixture`: две задачи и свободные чаты), `media/settings.css` (`.pv-tasks`).
- `src/webview/sessionsView.ts` — чистая логика: `taskLayout(sessions, tasks, query)` → `{blocks, free}`, `pillClass`,
  `blockEngines`. `src/webview/components/Sidebar.tsx` — `TaskGroup` (вид `groups`), `TaskCard` (вид `section`), `NewTaskChat`,
  `StatusPill`, `EngineMark`; сигналы `tasksMode`, `taskGroups`, `taskFold`. `src/webview/vscode.ts` — `readTaskFold/saveTaskFold`
  (`WebviewState.taskFold: string[]`, ≤ 200) и `SidebarFold.tasks` (секция «Задачи»).
- `media/tasks.css` (новый, подключён в `webviewHost.ts` после `hud.css`; всё под `.sidebar`). Классы: `.tgp` (+`.sel`, `.none`) —
  группа; `.tg-h` (+`.nokey`) — заголовок (`.tw`/`.tw.open` стрелка, `.kp`, `.tkey`, `.pill.wip|done|open`, `.cn`, `.plus`, `.tt`);
  `.s.nest` — вложенный чат; `.sec.tasks` / `.tk` (+`.sel`, `.kp`, `.ri`, `.tt`, `.sub`) — секция и карточка; `.s.tagged` / `.s .tag`
  — метка ключа в строке. Атрибут `data-tasks="groups|section"` на `.sidebar` — только когда в списке есть хотя бы одна группа.
- Меню строки: `package.json` `menus["webview/context"]` (`webviewId == 'agentura.sidebar' && webviewSection == 'session'`,
  `sessionBound`), `data-vscode-context` на каждой строке сессии; `sessionIdOf(arg)` (`extension/taskLink.ts`) — команды
  `bindTask`/`unbindTask` принимают и строку-id, и объект меню (`{sessionId, webview, …}`).

Контракт (на него опираются этапы 5–6):
- `sidebar.view.tasks?: 'groups'|'section'` (нет — `groups`). Новое сообщение webview → хост `{ type: 'task.newChat'; taskKey }`
  (длина 1…400): `sidebarView.ts` вызывает `agentura.chatForTask` с этим ключом (команда сама разбирает `parseTaskKey`). Этап 5 для
  «＋ новый чат» в блоке «Чаты по задаче» может переиспользовать то же сообщение, добавив обработчик во вкладке чата.
- Раскладка: `groups` — группы сверху (самая свежая по `updatedAt` чата выше, а не в порядке хранилища), «Без задачи» в конце;
  дней-заголовков внутри нет (время в строке уже даёт `whenLabel`). Нет групп вообще → прежний список по дням, без «Без задачи»
  (`data-tasks` не ставится). `section` — секция скрыта, пока групп нет; список сессий прежний (по дням) с меткой
  `task.key` справа у привязанных.
- Поиск ищет и по ключу/названию задачи: совпала задача — видны все её чаты, иначе только совпавшие; при поиске свёрнутые группы
  раскрыты. Плейсхолдер поиска меняется на «Поиск по названию, ключу задачи», когда группы есть.
- Свёрнутость: `setState` webview `taskFold` (ключи групп; «Без задачи» — `-free`); по умолчанию всё развёрнуто.

Отступления и почему:
- В `section` нет «↻» секции из прототипа (подтянуть задачи из Jiraffe): секция показывает только задачи, у которых уже есть чаты,
  списка «моих задач» источники не дают. Клик по карточке — возобновить её самый свежий чат (в прототипе поведения нет).
- Заголовок группы и карточка — `div` с сеткой, не `<button>` как в прототипе: вложенные кнопки невалидны. Действие — настоящая
  `<button class="kp hit">` вокруг ключа и статуса, её `::before` растянут на весь заголовок (кликабелен весь, фокус обводит весь);
  «＋» — соседняя кнопка поверх (`z-index`). *(Приёмка: у исполнителя был `div role="button"` с вложенной «＋» — скринридер
  такую «＋» не видит.)*
- Класс ключа задачи `.tkey`, а не `.key` из прототипа: `.set .key` в настройках — подпись ключа настройки (тест
  `settingsDom` и стили `settings.css` на него опираются).
- Чат во вложенной строке не получает колонку-метку движка из прототипа (она сломала бы три вида списка): в списке с Codex/
  Antigravity метка `C`/`X`/`G` стоит перед названием, иначе её нет (движок и так в подписи второй строки).
- Панель в `section` — flex-колонка (`.sidebar[data-tasks="section"]`): сетка hud.css/webview.css рассчитана на пять
  дочерних элементов, секция «Задачи» добавляет шестой. `.sec.tasks` ограничена 45 % высоты и прокручивается.
- В `prototype/screens/settings.html` добавлена строка настройки `agentura.tasks.sidebar` (тест `settingsDom` сверяет число строк
  `.set` с прототипом).
- Команда `agentura.bindTask` в меню — «Привязать к задаче…» (переименована из «Привязать вкладку к задаче…», чтобы подходила и
  строке без вкладки); `unbindTask` без изменений.
- Чистка ссылок на пропавшие сессии в группах (из «известных ограничений» этапа 1) не делалась: раскладка и `decorateSessions`
  их отфильтровывают.

Приёмка (2026-10-08, свой проход + второй проход Opus): поиск в `section` ищет и по ключу/названию задачи (`filterSessions` смотрит
`s.task`); `TaskBlock.all` — все чаты группы без учёта поиска (карточка: число, движки, последний чат); во время поиска
сворачивание групп не действует; «Без задачи» — имя кнопки её текст; хост игнорирует `task.newChat` с ключом, который не
разбирается `parseTaskKey`; `taskLayout` без поиска считается один раз за рендер; `.sidebar[data-tasks] .s.nest` — отступ
вложенного чата не теряется у текущей/живой строки в compact. Тесты: состояние свёрнутости → `saveTaskFold`, поиск в `section`,
`section` без чатов в группах = прежний вид.

Скоуп (владельцу): (1) клик по карточке секции «Задачи» открывает последний чат — откат: убрать `onClick` у `TaskCard`;
(2) сворачивание групп запоминается в состоянии webview панели, но не в настройках — откат не нужен.

Не проверено: вёрстка и цвета в браузере/VS Code (только DOM-тесты и сборка), обе темы; живое меню `webview/context` (форма
аргумента `{sessionId, webview, …}` взята из реализации VS Code, не из документации — если придёт иначе, правка в `sessionIdOf`);
«＋» у группы в живом VS Code (`agentura.chatForTask` проверена этапом 2 только тестами); ширины колонок `.s.tagged` в трёх
видах списка. Проверки: `TZ=UTC npm run check` — 126 файлов, 1706 тестов (после приёмки), зелёный.

### 5. Вкладка чата: полоска, вкладка «задача», сплит — **sonnet, high**, после 2 и 4

- [x] `agentura.tasks.card` по чек-листу (значения `panel|split|strip`, превью-карточки; `split` при источнике не
      Jiraffe — как `panel`, пометка в превью)
- [x] полоска задачи над лентой (решение 8; `task-mode.html#open`)
- [x] вкладка правой панели `task`: `PanelState['tab']`, `panelAll`, панель в `<aside>`, кнопка в полосе с
      бейджем, узкий режим (вкладки в шапке), строки `ui.tabs.*`; содержимое по решению 10 (`task-mode.html#open`,
      `#comment`, `#changes`, `#rail`)
- [x] «в чат» у плашки комментария человека → `task.toComposer` → `composer.prefill` (webview → хост проверен DOM-тестом,
      `toComposer`→`prefill` — тестом `TaskTab` этапа 2)
- [x] (код, выбор режима и условие показа проверены тестами; живой прогон с Jiraffe — пользователь) `split`: при открытии
      чата по задаче — `JiraffeSource.openIssue(inst, key, false)` в активной колонке, чат — `Beside` (`tasks.html#c`)
- [x] ошибки источника: нет подключения / 401 / сеть — строка в шапке панели с «подключить» / «повторить»
- [x] DOM-тесты панели (новое событие → бейдж и кромка, плашка человека, `humanChanges=false` прячет)
- [ ] вёрстка полоски, вкладки «задача», рельса и превью `tasks.card` в обеих темах и в узком режиме — **пользователь**
      (глазами; браузер в сессии не использовался)

- [x] (решение владельца 2026-10-08, долг этапа 4) сайдбар `groups`: внутри «Без задачи» — прежнее деление по
      дням (`groupByDay(layout.free)`); DOM-тест

**Готово, когда:** `npm run check` зелёный; DOM-тесты зелёные.

**Сессия:** sonnet, high; после 2 и 4.

**Решения (2026-10-08, по итогам сессии 5):**

Раскладка файлов:
- `src/settings.ts` — `TASK_CARD_MODES = ['panel','split','strip']`, `DEFAULT_TASK_CARD = 'panel'`, `isTaskCardMode`, ключ `tasks.card`
  (`SettingKey`/`SETTING_KEYS`/`SettingsValues`/`validateSetting`/`readSettings`). По чек-листу: `package.json` (настройка и команда
  `agentura.taskCard`), `package.nls*.json`, `shared/l10n.ts` (`taskCardViews`, `taskCardPlaceholder`), `extension.ts` (`pickTaskCard`),
  `protocol.ts` (`chat.info.taskCard?`), `chatController.ts` (`settings().taskCard` → `pushInfo`), `chatPanel.ts` (читает настройку),
  `strings*.ts` (`ui.settings.tasksCard`), `Settings.tsx` (`ChoiceCards` на странице «Внешний вид» после `git.layout`),
  `SettingsPreview.tsx` (`TaskCardPreview` — схема окна: настоящая `TaskStrip` + условные блоки; в `split` пометка «только с Jiraffe»),
  `media/settings.css` (`.pv-taskcard`, `.tcp-*`), `prototype/screens/settings.html` (строка настройки — `settingsDom` сверяет число `.set`).
- Webview: `src/webview/taskView.ts` — чистая логика (`taskPanelShown`, `visibleEvents`, `latestSeen`, `unseenCount`, `humanPrompts`, `agoLabel`,
  `eventText`, `eventActor`, `initials`, `sizeLabel`, `issueKeyOf`); `components/TaskPane.tsx` — `TaskPane` (вкладка) и `TaskStrip` (полоска);
  `store.ts` — сигналы `taskState`, `taskChats`, `taskCardMode` и обработка `task.state` / `task.chats` / `chat.info.taskCard`;
  `Chat.tsx` — вкладка `task` в `panelAll`/`panelItems`, `<TaskPane>` в `<aside>`, кнопка рельса с бейджем, полоска между шапкой/плашкой
  лимита и `.body`; `Hud.tsx` — вкладка «задача» в узком режиме (`taskTab`, `badges.task`, тип `Tab` + `'task'`); `vscode.ts` — `PanelState`:
  `tab: 'task'`, `taskView: 'card'|'changes'`, `taskSeen` (мс), `taskSeenKey`.
- `media/tasks.css` (общий с боковой панелью): `.tk-strip` (+`.tkey`, `.pill`, `.ttl`, `.lnk`), вкладка — `.tkp` (корень `section.tabpane`), `.tk-seg`, `.tk-ph`
  (`.l1`/`.l2`), `.tk-err`, `.tk-body`, `.tk-txt(.clamp)`, `.tk-cm(.new)`, `.tk-ban`, `.tk-feedh`, `.tk-evt(.new|.hum)`, `.tk-chats` (`.r`, `.cur`, `.newchat`).
  Строки полоски: `grid-template-rows` корня `.webview` пересчитывается через `:has(> .tk-strip)`.
- Хост: `shared/task.ts` — `TaskChatRow`, `TaskChatsMessage`; `TaskStateMessage.humanChanges?`; `TaskRequest` + `task.openChat {sessionId}`,
  `task.connect`; `taskGroups.ts` — `taskChatRows(group, rows, current)`; `jira/taskTab.ts` — `taskKey` (геттер), dep `connect?`, обработка `task.connect`;
  `jira/taskService.ts` — `humanChanges` в `task.state`; `chatPanel.ts` — `syncTask()` (= `taskTab.sync()` + `pushTaskChats()`), `pushTaskChats` (дедуп по JSON;
  `force` на `ready`), перехват `task.newChat` (та же проверка `parseTaskKey`, команда `agentura.chatForTask`) и `task.openChat` (только сессии группы
  задачи этой вкладки), `openCardBeside` (сплит), `OpenOptions.column`, параметр `column` у `resume`/`apply`.

Контракт (на него опираются этапы 6–8):
- Вкладка «задача» есть у чата, когда пришёл `task.state` с `taskKey` и `taskPanelShown(tasks.card, state)`: `panel` — всегда; `strip` — никогда; `split` —
  **изменено в этапе 6 (решение владельца): вкладка есть и при Jiraffe, по умолчанию открыта на «изменениях»** (было: только если `state.source !== 'jiraffe'`). Полоска — всегда, пока есть `taskKey`.
- «Новое»: `PanelState.taskSeen` — `max(at)` событий и комментариев карточки на первой успешной загрузке (`fetchedAt > 0`) и далее при каждом
  открытии вкладки «изменения» (панель видна + вид «изменения»); пока отметки нет — «нового» нет. Бейдж = события новее `taskSeen`; подсветка кромкой и
  «новое · …» — новее отметки на момент открытия ленты (`baseline`), поэтому после открытия бейдж гаснет, а кромка остаётся, пока лента открыта. Комментарии
  карточки новее отметки подсвечиваются в виде «карточка» и тоже входят в отметку (`latestSeen`). Пока лента открыта, бейджи не считаются. Плашка «пока агент работал» — `humanPrompts` (комментарий не-`mine` с `duringTurn`), «в чат» →
  `task.toComposer` и плашка гаснет до перезагрузки webview (набор закрытых — в памяти).
- Ошибки: `no-source`/`unknown-instance` → «подключить» (`task.connect` → `agentura.jira.connect`); `auth` → подсказка «Проверьте токен и нажмите ↻.», «подключить» и
  «повторить»; `network`/`not-found`/`other` → «повторить» (`task.refresh`); `off` — только текст. Есть `card` и `error` — карточка показана, к тексту добавляется «показаны последние загруженные данные».
- `task.chats {taskKey?, chats: TaskChatRow[]}` (хост → вкладка): чаты группы из списка сессий, новые сверху, `current` — сессия вкладки; шлётся при смене привязки/
  видимости/списка сессий/группы и на `ready`. `task.openChat {sessionId}` (вкладка → хост) открывает чат группы через `ChatPanel.resume`.
- `chat.info.taskCard` — значение настройки; `TaskStateMessage.humanChanges` — копия `agentura.tasks.humanChanges` (webview фильтрует чужие события и без хоста).
- Сплит: `ChatPanel.openWithContext` (входы: «Открыть в Agentura» в Jiraffe и `agentura.chatForTask`/«＋») при `tasks.card = split` и источнике Jiraffe с `openIssue`
  вызывает `openIssue(inst, key, false)`, затем открывает чат с `column: Beside`; сбой `openIssue` — чат открывается как обычно.

Отступления и почему:
- Полоска — отдельная строка на всю ширину вкладки (между шапкой и `.body`), а не внутри колонки ленты, как в прототипе: колонка ленты прокручивается, а сетка
  `.webview` рассчитана на фиксированные ряды; ряды переключает `:has(> .tk-strip)`.
- «Чаты по задаче» — заголовки чатов (`title` из списка сессий) + метка движка, а не «Чат N · движок» из прототипа: порядковых номеров чатов в группе у хоста нет.
  Строка чужого чата — настоящая кнопка (открывает чат), в прототипе она не интерактивна. Это добавило сообщения `task.chats`/`task.openChat`.
- Заголовок ленты без времени открытия чата («события задачи с открытия чата · новые сверху»): `openedAt` в вкладку не передаётся.
- Нет `⋯` полоски (отвязка от задачи, решение 12) — отвязка пока только из меню строки сайдбара; в прототипе полоски `⋯` тоже нет.
- Сплит включается только при открытии чата по задаче через `openWithContext`; обычный клик по чату группы в сайдбаре карточку Jiraffe не открывает (иначе каждый клик
  плодил бы вкладки Jiraffe).
- Узкая вёрстка: вкладка «задача» — в шапке (тип `Tab` + `'task'`), содержимое то же; рельса в узком режиме нет (как у остальных вкладок).
- Описание — текст с `white-space: pre-wrap` и сворачиванием по эвристике (> 240 символов или > 4 строк), а не измерением высоты: в jsdom нет вёрстки.

Скоуп (владельцу): перенесён в `19-jira-tasks.pending.md` («Решения на подтверждение», строки «этап 5»).

Приёмка (2026-10-08, два прохода): исправлено —
- `TaskService.postTo` до первого ответа отдаёт `source` по `sources.forInstance` (было `'none'`): при `split` с Jiraffe вкладка «задача» мелькала на время
  первой загрузки, и клик по ней записывал `PanelState.tab = 'task'`;
- относительные времена вкладки («обновлено …») стояли в простое (общий `tick` идёт только при ходе/агентах/кэше): пока вкладка «задача» видна, `Chat.tsx`
  тикает раз в 15 с;
- `taskGroups.onChange` теперь `syncTask()` (и `task.chats`), а не только `taskTab.sync()` — блок «Чаты по задаче» не обновлялся при привязке из сайдбара;
- отметка «видел» = `latestSeen` (события и комментарии карточки): при `humanChanges = false` чужой комментарий карточки подсвечивался вечно; база
  подсветки сбрасывается при смене задачи и не фиксируется, пока отметки нет; при открытой ленте бейджи (вкладка, рельс, переключатель) не считаются —
  не мелькают на кадр до сдвига отметки;
- `openWithContext`: вкладка задачи без сообщений при сплите показывается в колонке `Beside` (`reveal(column)`), а не под карточкой Jiraffe;
- `key` у списков `TaskPane` (комментарии со своим «ещё», вложения, плашки, события, чаты); DOM-тесты: отвязка при `tab = 'task'`, повторный опрос без
  бейджа, `humanChanges = false` и комментарии карточки.

Не проверено: вёрстка и цвета в браузере/VS Code (только DOM-тесты и сборка), обе темы, узкий режим и рельса; живой `openIssue` Jiraffe и колонки `Beside`
(`openCardBeside`/`apply` с `column` — только typecheck); `task.openChat`/`task.newChat` из вкладки в живом VS Code; `pushTaskChats` на реальных событиях списка сессий; поведение
`reveal(column)` для уже открытой вкладки; ширина панели 380 из прототипа (`rp.wide`) не воспроизводилась — панель с прежней шириной по умолчанию. Проверки: `TZ=UTC npm run check` — 128 файлов, 1732 теста, зелёный.

### 6. Страница настроек «Интеграции» — **sonnet, high**, после 5

- [x] шестая страница `integrations` в `Settings.tsx` по решению 14 (`task-mode.html#settings`); стрелки ↑↓ — DOM-тест; узкий сплит — общие правила `.st-nav` (глазами — пользователь)
- [x] сообщения: список своих подключений, «подключить» / «проверить» / «удалить» → команды этапа 2 (DOM-тест на сообщения, `SettingsController` — на проксирование в deps)
- [x] `settingsDom.test.ts`: страница рисуется для «Jiraffe есть», «Jiraffe нет, 2 своих», «ничего»

- [x] (решение владельца 2026-10-08, долг этапа 5) `tasks.card = split` с Jiraffe: вкладка «задача» показывается
      (убрать ветку `split` в `taskPanelShown`) и по умолчанию открыта на «изменениях» (карточка и так слева);
      описание превью `split` в настройках поправить; DOM-тест

**Готово, когда:** `npm run check` зелёный (`TZ=UTC npm run check` — 129 файлов, 1745 тестов, зелёный). Вёрстка и цвета страницы — пользователь.

**Сессия:** sonnet, high; после 5.

**Решения (2026-10-08, по итогам сессии 6):**

Раскладка файлов:
- `src/settings.ts` — ключи `jira.source`, `tasks.refresh`, `tasks.humanChanges` в `SettingKey`/`SETTING_KEYS`/`SettingsValues`/`validateSetting`/`readSettings` (константы и guard'ы были с этапа 2).
- `src/shared/integrations.ts` — `IntegrationsState { jiraffe: {state, version?, instances[]}, own[], active? }`; `protocol.ts` — `integrations.state` (хост → страница) и `integrations.connect|test{instanceId}|disconnect{instanceId}|installJiraffe` (страница → хост, поля проверяются в `FIELD_CHECKS`).
- `src/extension/jira/integrationsState.ts` — чистая сборка состояния из `JiraSources`; в `JiraSources` добавлены `jiraffeInstances()` (имена инстансов Jiraffe для строки статуса) и `activeKind()` (какой источник работает сейчас).
- `settingsController.ts` — необязательная зависимость `integrations` (`state/connect/test/disconnect/installJiraffe`); `pushState()` дополнительно шлёт `integrations.state`, есть `pushIntegrations()`. `settingsPanel.ts` — `SettingsPanel.show(context, log, jira)` собирает зависимость: версия Jiraffe из `vscode.extensions.getExtension('fosteev.jiraffe').packageJSON.version`, действия — команды `agentura.jira.connect|test|disconnect` (с `instanceId`), «поставить» — `extension.open` с `fosteev.jiraffe`; подписка на `sources.onDidChange` обновляет страницу сразу после подключения/отключения/смены источника. `extension.ts` передаёт `jira`.
- Webview: `vscode.ts` — раздел `integrations` между `look` и `engine`; `settingsStore.ts` — сигнал `integrations`, `integrationsAction`; `Settings.tsx` — `InfoRow` (строка `.set` без настройки) и `IntegrationsRows`; `strings.ts`/`strings.en.ts` — `ui.settings.integrations`, `sections.integrations`; `media/settings.css` и `prototype/shared/settings.css` — `.cn` (список подключений), `.cbs` (неактивные флажки); `prototype/screens/settings.html` — страница `integrations` (6 строк `.set`), без неё `settingsDom` не сходится по числу `.set`.
- Долг этапа 5: `taskView.ts` — `taskPanelShown` теперь `mode !== 'strip'`, новая `taskDefaultView(mode, state)` (`split` + источник Jiraffe → `changes`, иначе `card`); `Chat.tsx` берёт вид из `panel.taskView ?? taskDefaultView(...)` (и для бейджа вкладки); явный выбор человека (`PanelState.taskView`) главнее. Превью `split` в настройках теперь рисует и правую панель (вкладка «изменения» активна), описания (`strings*.ts`, `package.nls*.json`, `shared/l10n.ts`) — «…вкладка «задача» открыта на изменениях».

Страница (порядок строк): источник (`jira.source`, `<select>`, под ним «Сейчас работает: …») → Jiraffe (статус: `ready` «✓ Jiraffe X установлен · N инстансов: имена», `inactive`, `no-api`, `absent` + кнопка «поставить») → свои подключения (список «имя · адрес · тип · проверить · удалить», кнопка «подключить») → `tasks.refresh` → `tasks.humanChanges` → `jira.agentTools` (три отключённых флажка и «пока недоступно», настройки в `package.json` нет — этап 8). Результат «проверить» — уведомление VS Code самой команды (отдельной строки результата на странице нет).

Отступления и почему:
- Прототип `task-mode.html#settings` старый (`agentura.jiraffe.enabled/taskPanel/refresh/showHumanChanges/tools`); сделано по решению 14: вместо тумблера «Интеграция с Jiraffe» — настройка `jira.source`, а «Открывать панель «задача»» заменяет `tasks.card` (страница «Внешний вид»).
- Строки Jiraffe и «Свои подключения» — не настройки, а `.set` без `data-key`: чтобы не вводить второй вид строк и не расходиться со стилями.
- `jira.agentTools` не заведена как настройка (в `package.json` её нет, это этап 8): показан неактивный блок; `manifest.test` её не знает.
- Узкий сплит и стрелки ↑↓ отдельного кода не требуют: страница — ещё один раздел `SETTINGS_SECTIONS`.

Скоуп (владельцу): перенесён в `19-jira-tasks.pending.md` («Решения на подтверждение», строки «этап 6»).

Приёмка (2026-10-08): хост принимает `integrations.test|disconnect` только с id из своих подключений (`SettingsController.ownInstance`) — команды этапа 2 на незнакомый id не отказывают, а берут единственное подключение или спрашивают. Отказы команд страницы пишутся в журнал. Известное (второй проход, не чинили): при `auto`, если Jiraffe готов, но в наборе воркспейса 0 инстансов, «Сейчас работает: Jiraffe», хотя задачи своих подключений идут запасным путём `forInstance` (решение 3, так устроен `current()`); версия Jiraffe не входит в сигнатуру `notifyIfChanged` — после обновления Jiraffe без перезагрузки окна страница покажет старую версию до следующего изменения.

Не проверено: вёрстка и цвета страницы в VS Code (обе темы, узкий режим) — только DOM-тесты и сборка; живые «подключить/проверить/удалить» из страницы и `extension.open` (в тестах — только сообщения и проксирование в deps); обновление страницы по `sources.onDidChange` в живом окне. Проверки: `TZ=UTC npm run check` — 129 файлов, 1745 тестов, зелёный.

### 7. Вкладка на задачу (вариант Б) — **opus, high**, после 6

Вкладка редактора держит несколько сессий. Самый дорогой этап: сейчас `ChatController` = одна сессия и одна
webview. Сначала спайк, потом реализация или остановка с решением владельца.

- [x] спайк (≤ 1 ч, без кода в `src/`): можно ли отцепить идущий `ChatController` от webview и прицепить обратно
      (идущий ход продолжается, при возврате — `loadHistory` + текущее состояние хода); итог — в раздел «Решения
      по итогам этапа 7» этого файла (ниже: **да**)
- [x] при «да»: `agentura.tasks.tab` по чек-листу (`chat|task`, превью) — `manifest.test`, `settings.test`, `settingsDom.test`
- [x] панель задачи держит чаты (`TaskTabPanel` + `TabSlots`, чат = `ChatPanel` на поверхности `ChatSurface`), внутренние
      вкладки под полоской (`ChatTabs`, `tasks.html#b`, `#d`), «＋» — новый чат в той же вкладке (`tab.new` →
      `agentura.chatForTask` → `ChatPanel.apply` кладёт его во вкладку задачи); бейдж «ждёт ответа» (точка статуса) на
      внутренней вкладке — `tabSlots.test`, `taskTabDom.test`, `chatController.test` (фоновый чат)
- [x] Reload Window восстанавливает все чаты вкладки: состояние `taskTab` webview → `readTaskTabState` →
      `restoredTabChats` → `ChatPanel.restoreTaskTab` (видимый — с движком, остальные лениво) — тест «восстановление вкладки
      задачи из состояния сериализатора» (`tabSlots.test`), `taskTab.test`, `vscodeState.test`; живой прогон — **пользователь**
- [ ] вёрстка ряда внутренних вкладок и превью `tasks.tab` в обеих темах, узкий режим, живое переключение с идущим ходом
      и Reload Window в VS Code — **пользователь** (глазами; браузер в сессии не использовался)
- [—] при «нет» — не понадобилось

**Готово, когда:** спайк записан; при реализации — `npm run check` зелёный и тест восстановления панели задачи
из serializer-состояния. (`TZ=UTC npm run check` — 132 файла, 1778 тестов, зелёный.)

**Сессия:** opus, high; после 6 (трогает `chatPanel.ts`/`chatController.ts`, конфликтует со всем).

**Решения по итогам этапа 7 (спайк, 2026-10-08): да, укладывается.**

- Отцепить идущий `ChatController` от webview можно без правок модели «контроллер = сессия»: контроллер знает
  webview только через `deps.post`/`deps.setTitle`. Глушим их у фонового чата — сессия, ход, реестр живых
  (`live`), `turnLog`, `streamTail`, ждущие разрешения и превью продолжают жить в контроллере; события не теряются,
  а не доходят до webview.
- Прицепить обратно — уже готовый путь «webview пересоздан при живом хосте» (`onReady` → `readyCount > 1` →
  `reseed()`): история из транскрипта (`live: inTurn`) + хвост текущего ответа + `init`/контекст/`remote`/название
  + `turn.start` идущего хода + ждущие запросы и превью диффа. Возврат к чату = webview сбрасывает сессионные
  сигналы + хост шлёт контроллеру синтетический `ready`. Первый показ ни разу не активного чата — обычный `ready`
  (у восстановленного фонового — `seedPending` → тот же пересев). Восстанавливается ровно то, что сейчас
  восстанавливает «Reload Webviews»; webview-локальное (текст поля ввода, чипы) хранит сам webview по чату.
- Чтобы не переписывать `ChatPanel` (вся статика — `views()`/маршрутизация/`panelOf`/`renamed`/память
  открытых — считает «вкладка = чат»), `ChatPanel` остаётся «чатом», а `vscode.WebviewPanel` в нём заменяется
  интерфейсом поверхности `ChatSurface` (post, title, visible/active, reveal, сообщения, dispose). Обычная вкладка —
  поверхность над своей `WebviewPanel` (поведение как было); вкладка задачи — `TaskTabPanel` (одна `WebviewPanel`,
  N поверхностей, активная одна, внутренние вкладки, сериализация списка чатов). Это и есть `Map<sessionId,
  ChatController>` чекбокса, только ключ — поверхность (у нового чата id сессии ещё нет).
- Одна правка контроллера: `reseed()` без id сессии (новый чат без сообщений) теперь всё равно шлёт возможности
  движка — иначе после возврата к такому чату меню моделей/команд пустое (тот же пробел был и у «Reload Webviews»
  пустой вкладки). Плюс геттер статуса для бейджа «ждёт ответа».
- Цена: новый файл хоста (`taskTabPanel.ts`) + замена `panel` на поверхность в `ChatPanel`, маршрутизация чата
  задачи в её вкладку при `tasks.tab = task`, сериализатор с двумя видами состояния, webview — полоса внутренних
  вкладок и сброс сессионных сигналов. Риск — пересев на каждом переключении читает транскрипт (как «Reload
  Webviews»: десятки мс на длинных сессиях).

**Решения (2026-10-08, по итогам сессии 7):**

Раскладка файлов:
- `src/settings.ts` — `TASK_TAB_MODES = ['chat','task']`, `DEFAULT_TASK_TAB = 'chat'`, `isTaskTabMode`, ключ `tasks.tab` по чек-листу;
  `package.json` (настройка и команда `agentura.taskTab`), `package.nls*.json`, `shared/l10n.ts` (`taskTabViews`, `taskTabPlaceholder`),
  `extension.ts` (`pickTaskTab`), `strings*.ts` (`ui.settings.tasksTab`, `ui.task.tab*`), `Settings.tsx` (`ChoiceCards` на «Внешнем виде» после
  `tasks.card`), `SettingsPreview.tsx` (`TaskTabPreview`: ряд вкладок редактора, настоящие `TaskStrip` и `ChatTabs`), `media/settings.css`
  (`.pv-tasktab`, `.ttp-*`), `prototype/screens/settings.html` (строка). Поля в `chat.info` нет: настройку читает только хост (маршрутизация).
- Хост: `src/extension/chatSurface.ts` — интерфейс `ChatSurface` и `panelSurface` (своя вкладка, поведение как было);
  `src/extension/tabSlots.ts` — `TabSlots` без vscode (чаты вкладки, показанный, глушение сообщений фоновых, синтетический `ready`, `tab.chats`,
  заголовок); `src/extension/taskTabPanel.ts` — `TaskTabPanel` (одна `WebviewPanel` на задачу, `forTask`, `create`, `addSurface`);
  `src/shared/taskTab.ts` — сообщения `tab.chats` / `tab.select|close|new`, `readTaskTabState`, `restoredTabChats`, `nextActive`, `taskTabTitle`.
  `chatPanel.ts` — `ChatPanel` получает поверхность вместо `WebviewPanel` (`const panel = surface` — остальной код конструктора прежний),
  `OpenOptions.task`, `inTab`, `info()`, `taskTabOf`, `restoreTaskTab`, сериализатор различает состояние вкладки задачи (`taskTab`).
  `panelRouting.ts` — `PanelView.tab`, параметр `tab` у `routeResume`/`routeNew`. `chatController.ts` — геттеры `chatStatus`/`chatTitle`,
  `reseed()` без id шлёт возможности движка.
- Webview: `store.ts` — `tabChats`, `activeTabChat`, `switchTabChat` (сброс ленты, приборов, возможностей, вложений и плашки ответа; черновики
  чипов/картинок/файлов и текста поля — `chatDrafts` по id внутренней вкладки, только в памяти), `stashComposerText`/`takeComposerText`;
  `Composer` монтируется заново на каждый чат (`key`); `TaskPane.tsx` — `ChatTabs`; `Chat.tsx` — ряд под полоской; `vscode.ts` — `taskTab`
  в состоянии, `saveTaskTab`, `forgetSession` его не стирает; `media/tasks.css` — `.tk-ctabs` и ряды сетки `.webview` с ним.

Контракт:
- `tasks.tab = task`: чат задачи (в группе или открываемый по задаче — `openWithContext`, `agentura.chatForTask`, «＋» группы/блока/ряда,
  возобновление чата группы из сайдбара/блока «Чаты по задаче»/Jiraffe) открывается внутренней вкладкой вкладки этой задачи; её нет — создаётся.
  Чаты без задачи, ⌘⇧N, «Открыть чат» — свои вкладки, как раньше; пустой чат вкладки задачи занимается только чатом той же задачи
  (`PanelView.tab`). `tasks.tab = chat` — код пути прежний (поверхность `panelSurface`, `tab` не задан).
- Заголовок вкладки задачи — ключ (`NEWMFC-1482`) с маркером самого срочного чата (`?` ждёт ответа → `!` ошибка/лимит → `●` ход).
- Внутренняя вкладка: метка движка, название чата (нет — «новый чат»), точка статуса (`working`/`waiting`/`error`/`limited`), «×» закрывает чат
  (его движок останавливается, как при закрытии вкладки чата; закрыли последний — закрывается вкладка), «＋», справа «чатов: N».
- Переключение: хост шлёт `tab.chats` с новой активной, webview сбрасывает сессионное состояние, показанный чат получает синтетический `ready` →
  `ChatController.onReady` (первый показ — обычный, дальше — `reseed`); `TaskTab.resend`, `pushTaskChats(true)`, `git.refresh`, `graph.chatReady` —
  тем же путём, что и на настоящий `ready`.
- Сериализатор: `state.taskTab = {taskKey, chats: SessionRef[] (только чаты с сессией), active?}` пишет webview из `tab.chats.persist`.
  Восстановление — `restoredTabChats` (без открытых в других вкладках), видимый — с движком (если вкладка видна), остальные — `lazy`; не осталось
  ни одного — один новый чат, привязанный к задаче (если группа есть).

Отступления и почему:
- `pushTaskChats`/`task.openChat`/`openCardBeside` не подняты на уровень панели (пометка этапа 5): каждый чат по-прежнему `ChatPanel` со своим
  `TaskTab` и `pushTaskChats`, а вкладка задачи отдаёт webview только показанному — блок «Чаты по задаче» и полоска всегда от показанного чата,
  `current` у блока верный. Подъём дал бы то же поведение ценой переписывания `ChatPanel`.
- Не `Map<sessionId, ChatController>`, а список поверхностей с id `c<N>`: у нового чата id сессии ещё нет, а `/clear` его меняет.
- Блок «Чаты по задаче» правой панели оставлен (не заменён внутренними вкладками): он показывает и чаты группы, не открытые во вкладке.
- Граф агентов фонового чата не обновляется, пока чат не показан (снимки графа шлёт webview показанного чата).

Скоуп (владельцу):
- «Привязать вкладку к задаче» при `tasks.tab = task` не переносит уже открытый чат во вкладку задачи — он остаётся своей вкладкой (в группе),
  во вкладку задачи попадёт при следующем открытии; «Отвязать» чат во вкладке задачи оставляет его внутренней вкладкой до закрытия — перенос
  живого контроллера между webview — отдельная доработка — откат не нужен.
- Смена `tasks.tab` действует на чаты, открытые после неё: открытые вкладки не перестраиваются; вкладка задачи после Reload Window
  восстанавливается вкладкой задачи и при `tasks.tab = chat` (иначе её чаты пришлось бы раскладывать по новым вкладкам) — откат: в
  `ChatPanel.serializer` при `chat` восстанавливать только `taskTab.active` как обычную вкладку.
- «×» внутренней вкладки закрывает чат без вопроса (как закрытие вкладки чата), подсказка «ход останавливается» — откат не нужен.
- Черновик поля ввода и вложения фонового чата живут в памяти webview: после Reload Window у восстановленных чатов поле пустое (у обычной
  вкладки черновик тоже не сохраняется) — откат не нужен.

**Приёмка этапа 7 (2026-10-08, два прохода: свой + независимый opus):** режим `tasks.tab = chat` и чаты без задачи — без
регрессий (`panelSurface` = прежний код по смыслу). Починено по ходу приёмки:
- гонка переключения: webview помечает каждое сообщение хосту показанным у себя чатом (`tab`, `setTabChat` в `webview/vscode.ts`),
  `TabSlots.receive` отбрасывает помеченные не показанным чатом — промпт/ответ на разрешение/«стоп» ушедшего в фон чата не уходит новому;
- `git.watch`: чат, ушедший в фон, снимает `watch` своего git-клиента на хосте, webview шлёт `git.watch` заново на каждый показанный чат;
- чипы черновика (`extra`) возвращённого чата переживают его пересев (`session.history`/`session.reset` после `switchTabChat`);
- переход на чат без задачи сбрасывает полоску и «Чаты по задаче» прежнего (`taskState`/`taskChats` в `switchTabChat`);
- чаты вкладки задачи не пишутся в `openSessions` (запас сериализатора для вкладки без состояния не утащит их в обычную вкладку);
- «Открыть чат» без активной вкладки не выбирает фоновый чат вкладки задачи (`PanelView.background`, `ChatSurface.shown`);
- черновики закрытых чатов удаляются из памяти webview; внутренние вкладки доступны с клавиатуры (без `tabIndex = -1`).

Не проверено: вёрстка ряда вкладок и превью в VS Code (обе темы, узкий режим) — только DOM-тесты и сборка; живое переключение с идущим ходом,
карточкой разрешения и превью диффа (пересев покрыт тестами контроллера, связка `TaskTabPanel` ↔ VS Code — только typecheck); Reload Window с
несколькими чатами (чистая часть — тестами); `reveal(column)` вкладки задачи при сплите (`tasks.card = split`).

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
      подключение в двух воркспейсах, комментарий агента, комментарий человека во время хода, Reload Window; вкладка на задачу —
      переключение внутренних вкладок с идущим ходом и карточкой разрешения, «＋»/«×», Reload Window с несколькими чатами)
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
По реальному коду (после этапа 1): метаданные задачи после опроса — `TaskGroups.updateMeta(taskKey, {title, status,
statusCategory, url})` (src/extension/taskGroups.ts; «голое» название и пустая url хорошее не затирают), подписка —
`onChange`. openedAt = 0 у мигрированных сессий = «с начала» в eventsSince. «Agentura: Чат по задаче…» — через
`ChatPanel.openWithContext(…, {name, context, task, session: 'new'})`; разбор ввода — `parseIssueInput` (taskLink.ts).
Расширить `knownInstances` в src/extension/taskCommands.ts подключениями и инстансами Jiraffe.
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
По реальному коду (после этапа 1): данные — `sessions.update.tasks?: TaskGroupSummary[]` (`{taskKey, meta, sessionIds}`,
id в порядке списка, поля нет — групп нет) и `SessionSummary.task?` (src/protocol.ts); шлёт только боковая панель
(sidebarView.ts pushSessions, decorateSessions). Пункты меню строки — команды `agentura.bindTask` / `agentura.unbindTask`
с аргументом id сессии (src/extension/taskCommands.ts). «＋» у группы — `agentura.chatForTask` с аргументом-ключом
группы (`jira:<инстанс>:<KEY>`, делается в этапе 2: без вопроса, тянет карточку из источника, открывает новую вкладку
в группе); отдельную команду заводить не нужно.
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
После этапа 4: «＋ новый чат» в блоке «Чаты по задаче» — то же сообщение `task.newChat {taskKey}` (protocol.ts), что шлёт боковая
панель; в sidebarView.ts оно уже превращается в `agentura.chatForTask`, для вкладки чата нужен такой же обработчик (chatPanel.ts), с той же проверкой `parseTaskKey(m.taskKey)` (недоверенный ввод).
Кнопки внутри кликабельной строки — по образцу `.hit` из media/tasks.css (настоящая кнопка + растянутый `::before`), не `role="button"` с вложенной кнопкой.
По реальному коду (после этапа 2): точные типы — src/shared/task.ts (`TaskStateMessage`, `TaskCard`, `TaskEvent`,
`TaskRequest`); контракт и семантика полей (`duringTurn` для плашки, `mine`, `fromThisChat`, отсутствие `taskKey` =
«задачи нет», `card`+`error` = устаревшая карточка) — «Решения … по итогам сессии 2» в этом файле. Описание и
комментарии приходят текстом — рисовать как текст. Бейдж «новое» считает webview по `event.at` и своему `lastSeen`.
Запросы вкладки: `task.refresh`, `task.toComposer {commentId}`, `task.openExternal {attachmentId?}` (хост уже
обрабатывает в `TaskTab.handle`; `split` — открыть карточку Jiraffe через `services.tasks.sourceFor(taskKey)?.openIssue
(instanceId, key, false)` — добавить отдельным запросом, в этапе 2 его нет). Ошибки источника — `state.error.code`
(`off|no-source|unknown-instance|auth|not-found|network|other`), сообщение уже на языке хоста. При `auth` хост сам
больше не опрашивает (только ↻) — в карточке рядом с ошибкой нужна подсказка «проверьте токен и нажмите ↻»; при других
сбоях опрос идёт с растущей паузой (до 10 мин).
DoD: «Готово, когда» этапа 5. Проверка: npm run check.
```

### Промт 6

```
Сессия 6 — страница настроек «Интеграции» · Модель: sonnet, effort: high · после приёмки сессии 5
<общая шапка>
Задача: этап 6 roadmap (решение 14). Вёрстка — prototype/screens/task-mode.html#settings. Эталон страницы —
src/webview/components/Settings.tsx (страницы session|limits|sidebar|look|engine), строки — strings.ts/strings.en.ts.
По реальному коду (после этапа 2): настройки `agentura.jira.source`, `agentura.tasks.refresh`,
`agentura.tasks.humanChanges` уже в package.json и в src/settings.ts (`JIRA_SOURCES`, `TASK_REFRESH_MODES`), но не в
`SettingKey`/`SettingsValues` и не в settingsController — добавить. Данные страницы — `ChatServices.jira` (`JiraSources`:
`setting()`, `jiraffeStatus() → {state: absent|no-api|ready|inactive, instances, apiVersion?}` (`inactive` — установлен,
но не используется при `jira.source` = own/off), `ownInstances()`, `onDidChange`);
действия — команды `agentura.jira.connect`, `agentura.jira.disconnect(instanceId)`, `agentura.jira.test(instanceId)`
(src/extension/jira/connectCommands.ts). Версию Jiraffe (`jiraffe.packageJSON.version`) нужно брать из
`vscode.extensions.getExtension('fosteev.jiraffe')` — `jiraffeStatus()` её не отдаёт.
После этапа 5: `agentura.tasks.card` уже в `src/settings.ts`/`SettingKey`/странице «Внешний вид» (страница «Интеграции» его не дублирует);
`settingsDom.test.ts` сверяет число `.set` страницы с `prototype/screens/settings.html` — новые строки добавлять и туда.
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
После этапа 5 в `chatPanel.ts` на вкладку приходятся `TaskTab`, `pushTaskChats` (`task.chats`), перехват `task.newChat`/`task.openChat` и `openCardBeside`
(`OpenOptions.column`) — при нескольких контроллерах в одной панели они должны жить на уровне панели/активного чата; блок «Чаты по задаче» уже в `TaskPane`
(`src/webview/components/TaskPane.tsx`), внутренние вкладки чатов могут его заменить или дополнить.
DoD: «Готово, когда» этапа 7. Проверка: npm run check.
```

### Промт 8

```
Сессия 8 — инструменты Jira для агента (Claude) · Модель: opus, effort: high · после приёмки сессии 7
<общая шапка>
Задача: этап 8 roadmap, часть Agentura (решение 13). Точки входа: src/agent/claude/adapter.ts:397 mcpServers;
src/webview/toolView.ts:44 toolView, :40 shortName; копия клиента src/data/jira/client.ts (этап 2).
По реальному коду (после этапа 2): в копии клиента `src/data/jira/http.ts` нет `postJson`/`isOwnUrl` (не копировались) —
взять из jiraffe `src/jira/http.ts` вместе с `maybeSaved` и его l10n-ключом в `data/jira/i18n.ts`; источник —
интерфейс `JiraSource` (src/extension/jira/source.ts): записывающие методы дописать в него, `OwnSource` и `JiraffeSource`
(через API v2); текущий источник задачи — `services.tasks.sourceFor(taskKey)` / `services.jira.forInstance(instanceId)`;
«немедленное обновление карточки» — `services.tasks.nudge(taskKey)` (TaskTab уже подталкивает по ключу в `tool.result`;
`nudge` молчит в `manual` и после сбоя — для записи агентом надёжнее `services.tasks.refresh(taskKey)`).
`postJson` копировать вместе с защитой Jiraffe как есть: адрес только `baseUrl` + путь через `isOwnUrl`, `redirect: 'manual'`,
любой 3xx — ошибка (тело записи и `Authorization` никуда не пересылаются); токен — через `scrub` в текстах ошибок.
После этапа 5: вкладка «задача» — `src/webview/components/TaskPane.tsx` (лента — вид `changes`, строки `.tk-evt` по `TaskEvent.id`); какая вкладка
панели открыта, решает webview (`PanelState.tab`/`taskView` в `src/webview/vscode.ts`, `updatePanel` в `Chat.tsx`) — «в задаче →» это клик внутри webview,
сообщение хосту не нужно. Вкладки нет только при `tasks.card = strip` (`taskPanelShown`, `src/webview/taskView.ts`; после этапа 6 `split` с Jiraffe вкладку тоже показывает) — там «в задаче →»
открывает задачу как полоска (`task.openExternal`).
Страница «Интеграции» (этап 6): строка `agentura.jira.agentTools` сейчас — неактивная `InfoRow` с тремя отключёнными флажками (`IntegrationsRows` в `Settings.tsx`);
в этапе 8 добавить настройку по чек-листу (`SettingKey`/`package.json`/nls) и заменить заглушку на `Row` с рабочими флажками (комментарий / статус / ворклог). «Новое» считается по `event.at` (`PanelState.taskSeen`), у ворклога `at` = `started` — свежий ворклог
задним числом бейджа не даст.
SDK — проверить createSdkMcpServer/tool в установленной версии @anthropic-ai/claude-agent-sdk (node_modules, d.ts),
не по памяти. Jiraffe API v2 делает параллельная сессия 8b — в Agentura опираться на контракт: addComment(inst, key,
text), transitions(inst, key), transition(inst, key, id), logWork(inst, key, {seconds, started, comment}), apiVersion 2.
После этапа 7: при `tasks.tab = task` вкладка задачи держит несколько чатов, но каждый — прежний `ChatPanel` со своим `ChatController`
(webview — через `ChatSurface`; фоновому чату сообщения в webview глушит `TabSlots`) — MCP-сервер задачи вешать на контроллер/адаптер как обычно;
«в задаче →» работает в показанном чате. Сообщения webview → хост во вкладке задачи несут поле `tab` (id внутренней вкладки) —
новые типы сообщений с ним уживаются сами (`isFromWebview` лишних полей не проверяет).
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
