# 26 · Новые чаты внутри задачи

Запрос владельца 2026-10-19: в рамках задачи, пока её делаем, заводить новые чаты, не уходя из чата задачи.
Прототип: `prototype/screens/task-chats.html`, галерея v50, раздел `#task-chats`. Выбраны **А** (чипы чатов задачи
в полосе), **Б** (всплывашка «＋ чат») и **Г** (`/new`, `/fork` в поле ввода). **В** (ответвить с сообщения) — не берём.
Сейчас новый чат задачи создаётся только «＋» группы в сайдбаре и блоком «Чаты по задаче» на вкладке «задача»
(`task.newChat` → `agentura.chatForTask`, `src/extension/taskCommands.ts:118`), всегда движком по умолчанию и только
с контекстом задачи. Ветка: `main`. Версия: 0.19.0.

- [x] Сессия 1 (opus, high) — хост: опции нового чата, передача (итог чата, изменения задачи), движок, автоотправка, worktree, «рядом»
- [x] Приёмка 1 (opus, plan-review) 2026-10-19 — `npm run check` зелёный (2090), ревью дифа: 2 бага + риски → доводка 1
- [x] Доводка 1 (opus, high) — п. Д1–Д8 «Решений приёмки 1»
- [x] Приёмка доводки 1 (opus, plan-review) 2026-10-19 — `npm run check` зелёный (2108); публичная `chatForTask` кладёт
      `prompt` в поле без автоотправки (автоотправка — только из вкладки чата, с `from`); `task.newChat` из вкладки
      всегда несёт `from` → движок по умолчанию — движок вкладки (п. 3 выполнен и для блока «Чаты по задаче»)
- [x] Сессия 2 (sonnet, high) — webview: чипы в полосе, всплывашка, ⌥-клик, `/new` и `/fork`, строки, тесты
- [x] Приёмка 2 (opus, plan-review) 2026-10-19 — `npm run check` зелёный (2127); вёрстка глазами — на кадрах сессии 3
- [ ] Сессия 3 (sonnet, medium) — сцена `newchat` в readme-shots, README/README.ru/CHANGELOG, 0.19.0
- [ ] Приёмка 3 (opus, plan-review) — релиз 0.19.0, галерея: раздел «в коде», `#task-chats` → «выбраны А, Б, Г · реализовано»
- [ ] Глазами (владелец): создать чат каждым входом (＋, ⌥＋, всплывашка, `/new`, `/new codex`, `/fork`), итог чата
      в новом чате, worktree на живом репо, «рядом», чипы при 1/3/6 чатах, режим `tasks.tab = task`

## Решения

1. **Протокол.** `task.newChat` расширяется необязательными полями (старые отправители — сайдбар, блок «Чаты по
   задаче» — шлют только `taskKey` и работают как раньше):
   `{ type: 'task.newChat'; taskKey: string; provider?: AgentProvider; prompt?: string; carry?: { task?: boolean;
   summary?: boolean; changes?: boolean }; where?: 'same' | 'worktree'; beside?: boolean }`.
   Валидация в `FIELD_CHECKS`: `provider` — `isProvider`; `prompt` ≤ 2000 символов; `carry` — объект с булевыми
   полями; `where` — одно из двух; `beside` — boolean. Нет `carry` — `{ task: true }`. Источник итога (чей «итог этого
   чата») — сессия той вкладки, откуда пришло сообщение; webview его не передаёт. Из сайдбара `summary`/`changes`/
   `where`/`beside` игнорируются (там нет «этого чата»).
2. **Команда.** `agentura.chatForTask` принимает вторым аргументом опции `NewChatOptions` (= поля п. 1 без `type`/
   `taskKey` + `from?: { provider, id, cwd }` — сессия-источник, заполняет хост вкладки). Сбор контекста задачи — как
   сейчас. `ContextRequest` получает `provider?`, `files?` (доп. текстовые вложения), `autoSend?`, `cwd?`, `beside?`;
   `contextRequest()` валидирует их (команда `agentura.openWithContext` — внешний вход, поля недоверенные).
3. **Движок.** Новый чат открывается движком из `provider` (нет — движок вкладки-источника; из сайдбара — по умолчанию).
   Передаётся через `OpenOptions.provider` в конструктор `ChatPanel`. Настройку `agentura.defaultProvider` **не трогаем**
   (`setProvider` пишет её — для этого пути не использовать). Пустая вкладка (`routeNew` → reuse) переиспользуется,
   только если её движок совпадает; иначе — новая вкладка. Ожидающая вкладка той же задачи (`waiting`,
   `chatPanel.ts:~456`) переиспользуется только при пустых опциях (поведение «＋» сайдбара не меняется).
4. **Что передать** — отдельными текстовыми вложениями (чипы в поле ввода, × убирает), по порядку:
   - `carry.task` → `<KEY>.md` — как сейчас (`issueContext`).
   - `carry.summary` → `<KEY>-handoff.md`: итог чата-источника. История — `adapterFor(from.provider).loadHistory(from.id,
     from.cwd)`; из событий собирается вход: реплики пользователя, текст ответов, имена инструментов с путём/командой
     (без вывода), последние ~60 000 символов. Итог пишет `services.adapter.complete(cwd, { system, prompt, model:
     'sonnet', timeoutMs: 90_000 })` (только Claude умеет `complete` — итог всегда пишет Claude, движок источника любой).
     Системный промт: «передача работы другому агенту: цель, что сделано (коммиты, файлы), что не закончено, принятые
     решения, следующие шаги; до 250 слов; язык — как у пользователя в чате; без вступлений». Шапка файла:
     `# Handoff from chat «<title>» (<provider>)`. Пока пишется — `withProgress` «Готовлю итог чата…». Сбой/таймаут/
     нет сессии-источника — чат открывается без итога, предупреждение одной строкой.
   - `carry.changes` → `<KEY>-changes.md`: из `collectCode` (`src/extension/jira/taskCode.ts:450`) по задаче —
     на репо: имя, ветка задачи → база и `ahead`/±, до 20 коммитов `short subject (author, дата)`, незакоммиченные файлы
     с ±. Пусто — строка «No commits or uncommitted agent edits found for <KEY>.». Билдер — чистая функция с тестом.
   Чистые функции (вход итога из событий, текст изменений, имена файлов) — новый модуль
   `src/extension/jira/handoff.ts` + `handoff.test.ts`.
5. **Codex и Antigravity не принимают файлы** (`codex/adapter.ts:363`, `antigravity/adapter.ts:310` — выбрасывают).
   Для движка без `features.files` текстовые вложения (`kind: 'text'`) хост дописывает в блок контекста сообщения
   (`[Agentura: контекст]`, `src/shared/prompt.ts`) как `--- <name> ---\n<text>`; в ленте пользователь их не видит
   (`splitPrompt` отделяет блок). Webview для таких движков текстовые вложения больше не помечает «не поддерживается»
   (`store.ts:~420`), pdf/двоичные — по-прежнему. Это же чинит нынешний `chatForTask` для codex/agy (контекст задачи
   сейчас теряется).
6. **Автоотправка.** Непустой `prompt` из всплывашки/`/new`/`/fork` уходит первым сообщением сам: хост шлёт
   `composer.prefill` с новым полем `send: true` **после** вложений (оба через `postWhenReady`, порядок сохраняется);
   webview пишет текст и вызывает обычную отправку поля ввода (с вложениями). Пустой `prompt` — вкладка открывается с
   чипами вложений, без отправки (как сейчас). `prompt` из `openWithContext` без `autoSend` — как сейчас, только prefill.
7. **Свой worktree** (`where: 'worktree'`): репо — git-корень рабочей папки источника (`services.git.rootsFor(cwd)`),
   нет репо — опция недоступна (п. 9). Путь — соседняя папка `<parent>/<repoName>-<KEY>-<n>`, ветка
   `feature/<KEY>-<n>` от текущего `HEAD` репо; `n` — наименьшее ≥ 2, при котором нет ни папки, ни ветки (локальной).
   Команда — `git worktree add -b <branch> <path> HEAD` через `runGit` (массив аргументов). Ключ в имени ветки — его
   найдёт вкладка «код» (roadmap 24, `KEYRE`). Незакоммиченное источника в worktree не попадает — это написано во
   всплывашке. Удаление worktree — не делаем (README: `git worktree remove`). Сбой `git worktree add` — ошибка
   одной строкой, чат не открывается.
8. **Рабочая папка чата не из воркспейса.** `OpenOptions.cwd` → конструктор `ChatPanel`: вместо `folder.uri.fsPath`
   везде, где это cwd чата (контроллер, `WorkspaceFiles`, `git.attach`, `TaskCode.cwd`, чтение вложений). Возобновление
   сессии (`ChatPanel.resume`, восстановление вкладок сериализатором) берёт `cwd` строки сессии (`SessionRow.cwd`),
   если он есть и папка существует; иначе — папку воркспейса, как сейчас. В `PanelState`/состоянии сериализатора cwd
   хранится, чтобы восстановленная вкладка worktree-чата не уехала в основную папку.
9. **Что знает webview.** `TaskChatsMessage` получает `newChat: { worktree: boolean; summary: boolean }`:
   `worktree` — рабочая папка вкладки в git-репо; `summary` — у вкладки есть сессия (есть что пересказывать) и Claude
   доступен (`services.adapter.complete` есть). Шлётся вместе с `task.chats` (`pushTaskChats`).
10. **«Рядом»** (`beside: true`) → `ViewColumn.Beside`. При `tasks.tab = task` игнорируется (чат — внутренняя вкладка).
11. **А · чипы в полосе** (`TaskStrip`, только `tasks.tab = chat`; при `task` чаты уже есть в `ChatTabs`): вместо
    вкладки «чат» — чипы всех чатов задачи из `taskChats` (порядок — как в `taskChatRows`) + кнопка «＋ чат», затем
    разделитель и «задача | код». Чип: `Mark` движка + название (`title || ui.task.tabUntitled`), `max-width` ~150px с
    многоточием, полное — в `data-tip`. Текущий чат (`current`) — чип-вкладка вида «чат» (`onView('chat')`), на нём
    живут прежние индикаторы `activity` (спиннер, число, жёлтая точка), когда открыта «задача»/«код». Другой чат —
    точка по `state` (`live` синяя, `waiting` жёлтая, `error`/`limit` — красная), клик — `task.openChat`. Вкладка ещё
    без сессии (нет строки `current`) — первым идёт синтетический текущий чип «новый чат». Номеров «Чат N» нет
    (решение 8 roadmap 24). Больше 4 чатов — видны текущий и 3 последних по `updatedAt`, остальные — кнопка «ещё N ▾» с
    меню (клик — `task.openChat`).
12. **«＋ чат» и ⌥.** Клик — всплывашка (п. 13). ⌥/Alt+клик — сразу, без вопросов: `task.newChat {taskKey, provider:
    движок вкладки, carry: {task: true}}`. В режиме `tasks.tab = task` то же делает «＋» в `ChatTabs` (сейчас
    `tab.new`): клик — всплывашка, ⌥ — сразу.
13. **Б · всплывашка «Новый чат по задаче»** (вёрстка — `task-chats.html#pop`, свой компонент `NewChatPopover`):
    поле «о чём» (необязательно, станет первым сообщением, ≤ 2000), агент — сегменты claude / codex / antigravity
    (движки из `engines`/`features` webview; недоступный — `disabled` с подсказкой), «Передать в новый чат» — флажки
    «Контекст задачи» ✓, «Итог этого чата» ✓ (нет `newChat.summary` — снят и `disabled` с подсказкой), «Изменения
    задачи» ☐; «Где работает» — «та же папка» / «свой worktree» (нет `newChat.worktree` — `disabled`; выбран — подпись
    «ветка feature/<KEY>-N от HEAD, незакоммиченное не переносится»); кнопки «рядом» (нет при `tasks.tab = task`) и
    «создать ⏎». Enter — создать, ⌥Enter — рядом, Esc и клик мимо — закрыть. По умолчанию движок — вкладки.
    Выбор не запоминается. После «создать» всплывашка закрывается сразу (прогресс итога — уведомлением хоста).
14. **Г · команды.** Свои команды `new` и `fork` в `OWN_COMMANDS`, видны только во вкладке задачи. `/new [движок]
    [текст]` — `task.newChat {provider: движок или вкладки, prompt: текст, carry: {task: true}}`; движок — первое слово,
    если оно `claude` | `codex` | `agy` | `antigravity`. `/fork [текст]` — то же с `carry: {task: true, summary: true}`
    движком вкладки. Работают и во время лимита (как `clear`/`status`). Вне задачи не показываются и уходят движку как
    обычный текст (поведение не меняется).

## Решения приёмки 1 (2026-10-19)

Принято как сделано:
- `task.newChat` только с `taskKey` (сайдбар, блок «Чаты по задаче») — как раньше, движок по умолчанию, без `from`
  (п. 1 важнее п. 3). Сессия 2 у «＋ чат», ⌥ и `/new` передаёт `provider` явно.
- С `cwd` или `beside` вкладка всегда новая; вкладка со своей папкой не считается пустой и не занимается чужим чатом.
- `carry.task = false` — файла `<KEY>.md` нет. Итог и изменения — под одним `withProgress`.
- Репозиторий для worktree — корень, содержащий cwd, иначе единственный вложенный; несколько вложенных — опция недоступна.
- `newChat.summary` проверяет только наличие `complete` (вход в Claude не проверяем — сбой покажет предупреждение).
- Приёмка: `GitService.rootsFor` при пустом результате один раз зовёт `api.openRepository(cwd)` — папка worktree вне
  воркспейса иначе не видна git-расширению (вкладки «git»/«код» и флаг `newChat.worktree` были бы пустыми).
- К сессии 2: в меню «+» поля ввода у codex/agy пункт «только картинки» — теперь текстовые файлы доходят; поправить подпись.

Доводка 1 (ревью дифа, баги и риски):
- **Д1 (баг, п. 8 не сделан).** cwd чата хранится в состоянии вкладки: `PanelState.cwd` (webview `setState`, читает
  сериализатор) и слоты `TaskTabState` (режим `tasks.tab = task`). Восстановление: cwd из состояния (папка существует)
  → `SessionRow.cwd` → папка воркспейса. Ожидание списка сессий до 3 с в сериализаторе убрать, если cwd есть в
  состоянии. Сейчас worktree-чат без сообщений и любой codex/agy worktree-чат после Reload Window уезжает в основную папку.
- **Д2 (баг).** Сессии codex/agy из worktree не попадают в список сессий (`codex/adapter.ts:129-142` фильтрует
  `thread/list` по cwd воркспейса; agy пишет `cwd: dir`) → нет в «Чатах по задаче», сайдбаре, вкладке «код», не
  возобновляются. `SessionRef` групп задач получает `cwd?` (пишется при `taskGroups.add`, если cwd чата не папка
  воркспейса); `sessionsService` дополнительно листает codex/agy для этих cwd и сливает строки (дедуп по id, `cwd`
  строки — реальный). Resume берёт cwd строки/ссылки.
- **Д3 (баг).** `autoSend` — всегда новая вкладка (`{kind:'new'}`), никакого reuse пустой/ожидающей: иначе prompt
  теряется в непустом поле или уходит с чужим черновиком.
- **Д4 (риск, безопасность).** Внешний вход `agentura.openWithContext` не принимает `cwd` и `autoSend` (игнор; `provider`
  можно). Публичная `agentura.chatForTask` не принимает `from`/`where`/`beside`/`carry.summary|changes` из аргумента
  команды — их передаёт только внутренний вызов из `ChatPanel` (прямой вызов функции/сервиса, не `executeCommand`).
  Иначе любое расширение или `command:`-ссылка открывает агента в любой папке с автоотправкой или делает
  `git worktree add` в любом репо.
- **Д5 (риск).** Автоотправка из `composer.prefill {send}`: текст уходит как обычное сообщение (не разбирается как
  `/команда`); заблокировано (лимит, сессия закрыта) — текст остаётся в поле + системная строка в ленте, почему не ушло.
- **Д6.** `handoffInput`: при `turn.start.prompts` (склейка сообщений) разбирать каждое отдельно через `splitPrompt`.
- **Д7.** Worktree из worktree-чата: имя репо — от основного репозитория (`git rev-parse --git-common-dir` → его
  родитель), не `<repo>-K-1-2-K-1-2`; cwd источника — подпапка репо → новый чат стартует в той же подпапке worktree.
- **Д8.** `carry.task = false` — задачу из Jira не тянуть, `meta` из группы; pdf/двоичные вложения для движков без
  files отфильтровать на хосте (без предупреждений адаптера в журнале).
- Тесты: восстановление cwd (чистая функция выбора cwd), Д2 слияние строк, Д3 маршрут при autoSend, Д4 валидация
  внешнего входа, Д5 DOM, Д6, Д7 (чистые функции имени/подпапки).

## Решения приёмки 2 (2026-10-19)

- Сегменты агента во всплывашке всегда активны: признака «движок установлен» в webview нет, и меню «агент» поля ввода
  тоже не дизейблит движки — единообразно. Недоступный движок покажет ошибку в новой вкладке.
- Всплывашка — `position: fixed` по координатам кнопки (ряд `ChatTabs` с `overflow` её обрезал бы), прижата к правому
  краю, `max-width: calc(100vw - 8px)`.
- `/fork` не проверяет `newChat.summary` — при недоступном итоге хост предупредит и откроет чат без него.

## Промты

### Доводка 1

```
Доводка 1 — новые чаты внутри задачи: баги приёмки 1 · Модель: opus, effort: high

Работаем в /Users/fost/Projects/Agentura (ветка main, не переключать). Незакоммиченные правки сессии 1 и приёмки
(в т.ч. src/extension/git/gitService.ts rootsFor → openRepository) — основа, не откатывать.
Задача: закрыть п. Д1–Д8 раздела «Решения приёмки 1» в docs/roadmap/26-task-new-chats.md (это спека, там же сценарии
отказа). Правила репо: AGENTS.md. Код сессии 1: src/extension/chatPanel.ts (chatCwd/sessionCwd/ownCwd, сериализатор
~:585, openWithContext ~:430-500, task.newChat), src/extension/taskCommands.ts (chatForTask, makeWorktree),
src/extension/contextRequest.ts, src/extension/jira/handoff.ts, src/webview/components/Composer.tsx (prefill send
~:324-340), src/extension/taskGroups.ts (SessionRef, add, taskChatRows :321), src/extension/sessionsService.ts,
src/agent/codex/adapter.ts:129-142, src/agent/antigravity/adapter.ts:148-159, src/webview/vscode.ts:44-170
(PanelState, readPanel/savePanel), src/extension/jira/taskTab* / TaskTabState (слоты режима tasks.tab=task).

Уже решено, не переспрашивать: Д1–Д8 дословно. Webview в этой доводке трогать можно только для Д1 (PanelState.cwd —
хост присылает cwd, webview хранит; или хост пишет его в state через существующий механизм — выбери по коду
минимальный путь) и Д5.

Порядок: Д3, Д4, Д8, Д6, Д7 (мелкие) → Д5 → Д1 → Д2 → тесты из последнего пункта «Решений приёмки 1» → npm run check.

DoD: `npm run check` зелёный; тесты на каждое Д. Не делать: UI полосы/всплывашки/slash (сессия 2); удаление worktree;
чужие незакоммиченные файлы (.codex/, AGENTS.md, prototype/screens/task-chats.html) не трогать. Вопрос без ответа —
в отчёт. Не коммитить, не пушить.
Последним сообщением — отчёт: сделано по каждому Д (файлы) / отклонения / не проверено / открытые вопросы.
```

### Сессия 1

```
Сессия 1 — новые чаты внутри задачи: хост · Модель: opus, effort: high

Работаем в /Users/fost/Projects/Agentura (ветка main, не переключать). Задача: хост умеет открыть новый чат задачи с
опциями — движок, первое сообщение с автоотправкой, передача (контекст задачи / итог чата-источника / изменения
задачи), своя git worktree, «рядом»; текстовые вложения доходят до codex/agy. Webview в этой сессии НЕ трогаем, кроме
типов (src/shared, src/protocol.ts) и двух мест из п. 5 и п. 6 решений (store/Composer: снять «не поддерживается» с
текстовых вложений, `composer.prefill {send}`).

Читай: docs/roadmap/26-task-new-chats.md — «Решения» п. 1–10 это спека. Правила репо: AGENTS.md в корне.
Точки входа:
- src/protocol.ts:453 тип `task.newChat`, :629 FROM_WEBVIEW_TYPES, :720 FIELD_CHECKS; :252 `composer.prefill`.
- src/extension/chatPanel.ts: :214 defaultProvider, :220-231 OpenOptions, :340 folder(), :348-378 apply (new/reuse),
  :391 resume(..., column), :423-478 openWithContext (route, waiting, attachFiles, prefill), :635 конструктор
  (provider), :656 `cwd: folder.uri.fsPath`, :839-860 TaskCode deps (cwd), :874 row.cwd, :920 git.attach,
  :928 обработка task.newChat (сюда — передать опции и from = {provider, id, cwd} этой вкладки), :1035 pushTaskChats.
- src/extension/taskCommands.ts:118-169 chatForTask (сюда опции, передача, worktree), :173 регистрация.
- src/extension/contextRequest.ts — ContextRequest и contextRequest() (+ тест contextRequest.test.ts).
- src/extension/chatController.ts:393 setProvider (НЕ использовать — пишет настройку), :616 prefill, :915 case 'send'.
- src/shared/prompt.ts — CONTEXT_MARKER и сборка блока контекста; src/shared/files.ts — текстовые вложения;
  src/agent/codex/adapter.ts:363, src/agent/antigravity/adapter.ts:310 — где файлы выбрасываются.
- src/agent/types.ts:577 CompletionRequest, :651 complete?; src/agent/claude/adapter.ts:432 (эталон вызова —
  src/extension/git/gitService.ts:675-697 + src/extension/git/commitMessage.ts).
- src/extension/jira/taskCode.ts:450 collectCode (CodeCollectInput {key, cwd, chats, match?}); типы CodeRepo и др. —
  src/shared/task.ts:249-293. src/shared/task.ts:207 TaskChatRow, :220 TaskChatsMessage.
- src/extension/taskGroups.ts:321 taskChatRows; src/extension/sessionsService.ts:422 cwdOf.
- src/extension/git/gitService.ts: rootsFor(cwd), runGit(gitPath, args, cwd).
Точки входа проверены при планировании — не перечитывать ради подтверждения, открывать только нужный фрагмент.

Уже решено, не переспрашивать: всё в «Решениях» п. 1–10. Номеров «Чат N» не вводить. Настройку defaultProvider не
менять. Worktree не удалять. Итог пишет только Claude complete (model 'sonnet').

Порядок:
1. src/extension/jira/handoff.ts + handoff.test.ts: вход итога из событий истории (обрезка до ~60k с конца), системный
   промт, текст изменений из CodeRepo[], имена файлов вложений, выбор `n` для worktree (по списку занятых веток/папок).
2. Протокол: поля task.newChat, `composer.prefill.send`, `TaskChatsMessage.newChat`; валидаторы + protocol.test.ts.
3. ContextRequest: provider/files/autoSend/cwd/beside + валидация + тест.
4. Текстовые вложения для движков без files → блок контекста (хост) + тест на сборку промта; webview перестаёт помечать
   текстовые вложения неподдерживаемыми (только kind 'text').
5. ChatPanel: OpenOptions.cwd и provider для новой вкладки, reuse только при совпадении движка, cwd в состоянии
   вкладки и при resume/восстановлении (п. 8), beside, autoSend (prefill с send после attachFiles); webview: Composer
   по `send` вызывает обычную отправку (минимальная правка, с DOM-тестом в composerDom.test.ts).
6. chatForTask(arg, opts): движок, передача (итог с withProgress, изменения), worktree, вызов openWithContext;
   chatPanel: task.newChat → опции + from; pushTaskChats → newChat {worktree, summary}.
7. Строки хоста (src/shared/l10n.ts, ru и en): прогресс итога, сбои итога/worktree.
8. npm run check.

DoD: `npm run check` зелёный; новые тесты на handoff.ts, валидаторы task.newChat/ContextRequest, сборку промта с
текстовыми вложениями для codex, prefill.send в Composer. Проверка: npm run check (полная сборка vsix не нужна).

Не делать: UI полосы, всплывашку, slash-команды (сессия 2); удаление worktree; запоминание выбора; изменение
поведения «＋» сайдбара; чужие незакоммиченные файлы (.codex/, AGENTS.md, prototype/screens/task-chats.html) не
трогать. Вопрос, на который нет ответа в промте, — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы. Отчёт —
единственное, что увидит приёмка: без него работа потеряна.
```

### Сессия 2

```
Сессия 2 — новые чаты внутри задачи: webview · Модель: sonnet, effort: high · после приёмки 1

Работаем в /Users/fost/Projects/Agentura (ветка main, не переключать). Задача: в webview — чипы чатов задачи в полосе
задачи, кнопка «＋ чат» со всплывашкой «Новый чат по задаче» и ⌥-кликом, команды /new и /fork. Хост готов (сессия 1):
`task.newChat` с опциями и `TaskChatsMessage.newChat` уже есть.

Читай: docs/roadmap/26-task-new-chats.md — «Решения» п. 1, 9, 11–14 (спека) и «Решения приёмки 1», если есть.
Вёрстка: prototype/screens/task-chats.html (#strip — полоса, #pop — всплывашка; классы .cc, .np, .nc — образец, стили
переносить в стили webview по месту, где лежат стили .tk-strip). Правила репо: AGENTS.md.
Точки входа:
- src/webview/components/TaskPane.tsx:111-170 TaskStrip (вкладки chat/task/code, activity), :176 ChatTabs (＋ → tab.new).
- src/webview/components/Chat.tsx:533-541 монтирование TaskStrip; :191 PanelState; :409 showView; :811 taskChats.
- src/webview/store.ts:179 taskChats, :585 task.chats; features/engines — сигналы движков для сегментов агента.
- src/webview/components/TaskView.tsx:660-690 блок «Чаты по задаче» — эталон строк чатов (Mark, title, state).
- src/webview/composer.ts:46 OWN_COMMANDS, :52 ownCommands, :68 buildSlashItems; Composer.tsx:384-394 меню,
  :435-490 submit() (свои команды, :453 список разрешённых при лимите).
- src/webview/strings.ts (ui.task, ui.commands :969) и strings.en.ts — паритет проверяет strings.test.ts.
- src/webview/components/SettingsPreview.tsx:807, :863 — TaskStrip в предпросмотре настроек (передать новые пропсы).
- Тесты-эталоны: src/webview/taskPaneDom.test.ts (:140 полоса, :648 чаты по задаче), taskTabDom.test.ts (ChatTabs),
  composer.test.ts:85-109 (ownCommands), composerDom.test.ts.
Точки входа проверены при планировании — не перечитывать ради подтверждения, открывать только нужный фрагмент.

Уже решено, не переспрашивать: п. 11–14 «Решений» дословно. Номеров «Чат N» нет. Выбор во всплывашке не запоминается.

Порядок:
1. TaskStrip: чипы (текущий = вкладка «чат» с индикаторами activity, другие — точка state и task.openChat, синтетический
   «новый чат», «ещё N ▾» при > 4), «＋ чат» (клик — всплывашка, Alt — сразу). Только tasks.tab = chat.
2. NewChatPopover (новый компонент): поля, флажки, disabled-состояния по newChat/engines, Enter/⌥Enter/Esc/клик мимо,
   отправка task.newChat с опциями.
3. ChatTabs «＋» (tasks.tab = task): клик — всплывашка, Alt — task.newChat сразу (вместо tab.new).
4. /new и /fork: OWN_COMMANDS, фильтр «только вкладка задачи», разбор движка, task.newChat, разрешены при лимите.
5. Строки ru/en; SettingsPreview.
6. DOM-тесты: чипы (1/3/6 чатов, синтетический текущий, клик по чужому → task.openChat, по своему → вид chat), ＋ и Alt,
   всплывашка (дефолты, disabled, Enter/⌥Enter/Esc, состав сообщения), /new, /new codex текст, /fork, вне задачи.
7. npm run check.

DoD: `npm run check` зелёный; тесты из п. 6. Проверка: npm run check.

Не делать: хост (кроме явного бага — тогда в отчёт); ответвление с сообщения (вариант В); запоминание выбора;
чужие незакоммиченные файлы не трогать. Вопрос без ответа в промте — в отчёт.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

### Сессия 3

```
Сессия 3 — новые чаты внутри задачи: кадры и доки · Модель: sonnet, effort: medium · после приёмки 2

Работаем в /Users/fost/Projects/Agentura (ветка main). Задача: сцена `newchat` в scripts/readme-shots, раздел в
README.md и README.ru.md, запись в CHANGELOG.md, версия 0.19.0 в package.json/package-lock.json.

Читай: docs/roadmap/26-task-new-chats.md (решения и решения приёмок). Правила репо: AGENTS.md.
Точки входа: scripts/readme-shots/run.mjs:238 codeJobs — эталон сцены, :331 диспетчер сцен;
scripts/readme-shots/data.mjs — фикстуры (task.chats с 3 чатами разных движков и состояний, newChat {worktree: true,
summary: true}). Кадры (обе темы): `newchat-strip` (полоса с чипами), `newchat-pop` (открытая всплывашка — click по
кнопке «＋ чат»), `newchat-slash` (меню / с набранным «/new»), `newchat-many` (6 чатов, «ещё 3 ▾» открыто).
Раздел README — как у разделов задач (стиль соседних, английский в README.md, русский в README.ru.md): три входа
(＋/⌥＋, всплывашка, /new и /fork), что передаётся, worktree и как его удалить (`git worktree remove`).
CHANGELOG — в стиле предыдущих записей, на английском.

DoD: `node scripts/readme-shots/run.mjs newchat` отрабатывает и даёт 8 PNG; `npm run check` зелёный.

Кадры просмотри сам (Read по PNG, по одному на кадр, тёмная тема): обрезка, наезды, перенос строк в чипах и
всплывашке — правь стили в media/tasks.css (.ncp, чипы полосы) и перерендери. Не делать: прочие правки src (явный
баг — в отчёт); vsix не собирать; не коммитить, не пушить.
Последним сообщением — отчёт: сделано / отклонения / не проверено / открытые вопросы.
```
