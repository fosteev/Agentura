# Каталог фич расширения Claude Code для VS Code (v2.1.284)

Объект: `anthropic.claude-code` 2.1.284, darwin-arm64. Минимальная версия VS Code по `package.json` — `^1.94.0` (README говорит 1.98.0 — расхождение, верить `package.json` и странице доки). Расширение не работает в Restricted Mode (`untrustedWorkspaces.supported: false`).

Обозначения источников: **pkg** — `package.json`; **дока** — страница https://code.claude.com/docs/en/vs-code; **walk** — `resources/walkthrough/*.md`; **web** — строка/код в `webview/index.js`; **ext** — код в `extension.js`. Версии «Requires Claude Code vX» — из доки: это версия встроенного CLI-бинарника, а не расширения.

Идентификаторы (команды, настройки, строки интерфейса) приведены байт в байт из источников.

---

## 1. Размещение, запуск и окна

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Панель чата в боковой панели | Чат живёт как webview. По умолчанию открывается в `panel` (редакторная вкладка); можно перетащить в primary/secondary sidebar или в область редактора. Запоминает последнее место. | Команда `claude-vscode.sidebar.open`; настройка `claudeCode.preferredLocation` (enum `sidebar`/`panel`, дефолт `panel`, обновляется автоматически при открытии в новом месте) | pkg, дока |
| Вкладка-редактор | Новый разговор как вкладка рядом с файлами. Каждая вкладка — отдельный разговор со своей историей. | `claude-vscode.editor.open` («Open in New Tab»), хоткей `cmd+shift+escape` / `ctrl+shift+escape` | pkg, дока |
| Открыть «последний» | Служебная команда для иконки в заголовке редактора и статус-бара: открывает Claude там, где он был. Скрыта из палитры (`when: false`). | `claude-vscode.editor.openLast` | pkg |
| Открыть в основном редакторе | Открывает разговор в primary editor. Так же вызывается из URI-обработчика. | `claude-vscode.primaryEditor.open` (палитра, если `claude-vscode.primaryEditorEnabled`; расширение ставит этот контекст всегда) | pkg, ext |
| Новое окно | Новый разговор в отдельном окне VS Code. | `claude-vscode.window.open` | pkg, дока |
| Иконка Spark в тулбаре редактора | Кнопка в `editor/title`: открывает чат (в режиме `useTerminal` — терминал). Видна только при открытом файле. | `menus.editor/title`: `claude-vscode.editor.openLast` при `!config.claudeCode.useTerminal`, `claude-vscode.terminal.open` при `config.claudeCode.useTerminal` | pkg, дока |
| Иконка в Activity Bar (список сессий) | Всегда видимый контейнер `claude-sessions-sidebar` со списком сессий (см. раздел 8). Отдельный контейнер `claude-sidebar` (Activity Bar) показывается, только если чат «припаркован» слева. Вторичная боковая панель `claude-sidebar-secondary` — если VS Code >= 1.106. | viewsContainers: `claude-sidebar`, `claude-sidebar-secondary`, `claude-sessions-sidebar`; views `claudeVSCodeSidebar`, `claudeVSCodeSidebarSecondary`, `claudeVSCodeSessionsList` | pkg, ext |
| Статус-бар «✻ Claude Code» | Правый нижний угол; показывается, если `preferredLocation = sidebar` (или чат открыт через «Open in Side Bar»). Клик открывает Claude, работает без открытого файла. Подсказка «Open Claude Code». | Клик; внутренняя команда `claude-vscode.editor.openLast` | ext, дока |
| Блокировка редакторских групп | Группа, которую расширение создало под вкладку Claude, блокируется, чтобы открываемые файлы шли в другую группу. Уже заблокированные группы остаются заблокированными. | `claudeCode.lockEditorGroups` (boolean, дефолт `true`) | pkg, дока |
| Индикатор состояния вкладки | На иконке вкладки цветная точка: синяя — ждёт разрешения, оранжевая — Claude закончил, пока вкладка была скрыта. | Автоматически | дока |
| Восстановление после перезагрузки окна | Вкладка-редактор возвращается с разговором. Сайдбар — только если было сообщение/ответ за последние 10 минут. Если перезагрузка прервала шаг, Claude продолжает его, в чате появляется заметка «Continuing the step that was interrupted when the window reloaded.». Если шаг прерван более часа назад или сессия открыта в другом месте — возвращается в idle. | `claudeCode.continueAfterReload` (boolean, `true`) | pkg, дока, web |
| Переоткрытие закрытой вкладки сессии | Cmd/Ctrl+Shift+T открывает последнюю закрытую вкладку Claude; если последней закрытой была не сессия Claude — отрабатывает штатный `workbench.action.reopenClosedEditor`. | `claude-vscode.reopenClosedSession`; `claudeCode.enableReopenClosedSessionShortcut` (boolean, `true`) | pkg, ext, дока |
| Новый разговор по хоткею | Cmd/Ctrl+N при фокусе на Claude. По умолчанию выключено. | `claude-vscode.newConversation`; `claudeCode.enableNewConversationShortcut` (boolean, `false`) | pkg, дока |
| Переключение фокуса редактор/чат | Cmd/Ctrl+Esc: из редактора — в поле ввода, из чата — обратно. Плейсхолдер поля подсказывает «⌘ Esc to focus or unfocus Claude». | `claude-vscode.focus` (когда `editorTextFocus`), `claude-vscode.blur` (когда не `editorTextFocus`) | pkg, web |
| Фокус на последнем сообщении | Переводит клавиатурный фокус на новейшее сообщение или ожидающий permission-prompt (для клавиатуры и скринридера). Недоступно в терминальном режиме. | `claude-vscode.focusLastMessage` (палитра, при `!config.claudeCode.useTerminal`) | pkg, дока |
| URI-обработчик `open` | Внешний запуск вкладки: `vscode://anthropic.claude-code/open` с параметрами `prompt` (URL-encoded, вставляется в поле, не отправляется) и `session` (ID сессии; если её нет в открытом workspace — старт нового разговора; если открыта — фокус вкладки). | `vscode://anthropic.claude-code/open?prompt=…&session=…` | дока, ext |
| URI-обработчик `install-plugin` | Открывает диалог Manage plugins на выбранном плагине. Параметры `plugin` (обязателен) и `marketplace` (дефолт `anthropics/claude-plugins-official`; поддерживаются GitHub `owner/repo`, `https://`, git SSH; локальные пути и `http://` — ошибка). | `vscode://anthropic.claude-code/install-plugin?plugin=…&marketplace=…` | дока, ext |
| Терминальный режим / открыть в терминале | См. раздел 16. | | |

---

## 2. Окно чата и ввод

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Поле ввода (contenteditable, plaintext) | Отправка по Enter; Shift+Enter — перенос строки (работает и в свободном поле «Other» диалогов вопросов). Плейсхолдеры: «Ask Claude to edit…», «Queue another message…» (пока Claude занят), «⌘ Esc to attach selected text», «⌘ Esc to focus or unfocus Claude». | Enter / Shift+Enter | дока, web |
| Отправка по Ctrl/Cmd+Enter | Включает режим, где Enter даёт перенос строки, а отправка — Ctrl/Cmd+Enter. | `claudeCode.useCtrlEnterToSend` (boolean, `false`) | pkg, web |
| Очередь сообщений | Пока Claude работает, можно написать следующее сообщение — оно встаёт в очередь. Выделение сохраняется таким, каким было на момент нажатия Enter. | Просто отправить пока Claude занят | web, дока (интерактивный режим) |
| История отправленных сообщений в поле | Стрелки Вверх/Вниз в поле ввода листают ранее отправленные сообщения (`cycleMessage`). | ArrowUp / ArrowDown | web |
| Подсказка следующего промпта (prompt suggestion) | Когда Claude свободен и поле пустое, поле показывает предложенный промпт; Tab принимает его. | Tab | web |
| Вставка текста | Вставленный текст остаётся видимым (не сворачивается в плейсхолдер). Невидимые Unicode-символы удаляются; при вставке — уведомление вида «Removed 3 invisible characters from the pasted text»; если символы найдены при отправке — отправка блокируется, очищенный текст возвращается в поле. | Вставка (Cmd/Ctrl+V) | дока, web |
| Автопрокрутка к низу при отправке | При отправке сообщения лента прокручивается вниз. | `claudeCode.scrollToBottomOnSend` (boolean, `true`) | pkg |
| Временные метки сообщений | Время отправки каждого сообщения; линия с датой при смене дня. | `claudeCode.showMessageTimestamps` (boolean, `false`) | pkg |
| Focus view | Скрывает вызовы инструментов, результаты и thinking за раскрываемыми строками; остаются реплики пользователя и ответы Claude. Последний to-do список остаётся видимым (v2.1.225+), текст ожидающего вопроса — тоже; при работе субагентов под группой вызовов показываются живые строки прогресса (v2.1.269+). Живой индикатор называет текущий инструмент. Применяется ко всем открытым сессиям и сохраняется. | `claudeCode.focusView` (boolean, `false`); команда `claude-vscode.toggleFocusView`; хоткей `ctrl+alt+f`; пункт «Focus view» («Show only your prompts and Claude's responses») в командном меню, раздел Settings; id действия `toggle-focus-view` | pkg, дока, web |
| Копирование ответа | Кнопка «Copy response» при наведении на ответ; `/copy` копирует последний ответ, `/copy 2` — предпоследний. | Кнопка; `/copy [N]` | дока, web |
| Экспорт разговора | Диалог: копировать как plain text или сохранить в файл; `/export notes.txt` пропускает диалог. | Командное меню, раздел Context, действие `export-conversation` («Export conversation»); `/export [filename]` | дока, web |
| Очистка / новый разговор | Команда меню «Clear conversation» («Start a new conversation»); «New conversation» («Open a new conversation in a new tab or the sidebar») — только в фильтре. | Действия `clear-conversation`, `new-conversation` | web |
| Развёрнутый thinking | Рассуждения — свёрнутые блоки; клик раскрывает; Ctrl+O раскрывает/сворачивает все блоки сессии. Во время работы заголовок «Thinking...» с живой оценкой токенов; после — «Thought for Ns». | Клик; Ctrl+O | дока, web |
| Боковой вопрос `/btw` | Вопрос по сессии без добавления в разговор; ответ в панели рядом с чатом, там же можно задавать уточнения. Тред переживает перезагрузку окна; хранятся последние 20 обменов; срок хранения по `cleanupPeriodDays`. Корзина в панели очищает тред; есть изменение размера панели. Пункт меню «Ask a side question» / «Clear side questions». | `/btw [question]`; действие командного меню `/btw` («Ask a quick side question without interrupting the main conversation») | дока, web |
| Проверка орфографии в поле | Встроенный спеллчек со своим словарём и пользовательскими словами (хранятся в `globalState.spellcheckUserWords`). | Настройка `claudeCode.spellcheck` — **не объявлена в `package.json`**, читается в коде, дефолт `true` | ext, web |
| Пользовательские «глаголы спиннера» | Настройка формулировок индикатора работы. Влияет на webview. | `claudeCode.spinnerVerbs` — **не объявлена в `package.json`**, читается в коде; формат не проверялся | ext |
| Командное меню (`/`) | Всплывающее меню по кнопке `/` или набору `/`; секции **Context**, **Model**, **Customize**, **Settings**, **Support**, **Slash Commands**. Фильтр, стрелки, Tab/Enter выбор, Esc закрыть. Элементы с иконкой терминала открываются во встроенном терминале. Полный список действий — раздел «Списки», п. 5. | Кнопка `/` в поле; набор `/` | дока, web |
| Кнопка «+» (добавить) | Меню вложений: «Upload from computer», «Add context» (вставляет `@`), «Browse the web» (вставляет `@browser:`, только если поддерживается интеграция с браузером). | Кнопка в поле ввода | web |
| Справка `/help` | `/help` и «View help docs» — открывает документацию; алиас `help` ведёт в «Slash commands» диалог. | `/help` | web |

---

## 3. Контекст редактора, @-упоминания, вложения

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Автоконтекст выделения | Claude автоматически видит выделенный текст; в футере поля — счётчик выделенных строк; крестик на индикаторе убирает выделение из контекста (вернётся при новом выделении). В транскрипте CLI-режима строка «⧉ Selected N lines from <file>». | Выделить текст в редакторе | дока |
| Автоконтекст открытого файла | Открытый файл добавляется в сообщения и показывается в поле. При выключении в контекст идёт только выделение (путь активного файла передаётся только при выделении в нём). Требует Claude Code 2.1.271+. | `claudeCode.attachOpenFile` (boolean, `true`) | pkg, дока |
| @-упоминание выделения | Вставляет в промпт ссылку вида `@app.ts#5-10`. | Хоткей `alt+k` при `editorTextFocus`; команда `claude-vscode.insertAtMention` («Claude Code: Insert @-Mention Reference»); в терминальном режиме — `claude-code.insertAtMentioned` / `cmd+alt+K` | pkg, дока |
| @-упоминание файлов и папок | Набор `@` даёт меню с нечётким поиском (`@auth` → auth.js, AuthService.ts); для папки — завершающий слэш (`@src/components/`). Пути с пробелами/`#` оборачиваются в `@"…"`. | Набор `@`; кнопка «+» → «Add context»; действие меню `mention-file` («Mention file from this project…») | дока, web |
| @-упоминание терминала | `@terminal:name` подставляет вывод терминала по заголовку в промпт (в сообщение уходит `<terminal name="…">…`). | Набор `@terminal:name` | дока, web |
| @-упоминание браузера | `@browser …` — задачи через расширение Claude in Chrome. | Набор `@browser` | дока, web |
| @-упоминание агентов | Меню `@` содержит агентов (метка вида «… (agent)»). Детали (какие агенты, как передаются) не проверены. | Набор `@` | web (косвенно) |
| Фильтр выделения | Текст выделения из файлов, попадающих под `files.exclude`/`search.exclude`, и из файлов под gitignore (при включённых `search.useIgnoreFiles` и `respectGitIgnore`) не отправляется — уходит максимум путь. Только для чата; в терминале CLI шлёт выделение независимо (защита — `Read` deny rule). | `claudeCode.respectGitIgnore` (boolean, `true`) | pkg, дока |
| Вставка изображений | Картинка из буфера вставляется в поле как вложение. | Paste | дока |
| Перетаскивание файлов | Файлы перетаскиваются в поле с зажатым Shift (VS Code иначе открывает файл). При перетаскивании без Shift показывается подсказка «Hold Shift while dragging to drop files into Claude Code»; при удачном — оверлей «Drop to attach as context». Вложения снимаются крестиком. | Shift + drag | дока, web |
| Загрузка файлов с компьютера | Кнопка «Upload from computer» открывает выбор файлов; принимаются изображения, документы и текстовые файлы по расширениям; неподдерживаемые перечисляются. | Меню «+» | web |
| Чтение PDF по страницам | Можно попросить страницы (одну, диапазон, «с N»); нужен poppler-utils на машине, где запущен CLI. | Текст промпта | дока |
| Автосохранение | Перед чтением/записью Claude файла расширение сохраняет файл. | `claudeCode.autosave` (boolean, `true`) | pkg |

---

## 4. Режимы разрешений и подтверждения

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Индикатор режима в поле ввода | Кнопка внизу поля; меню режимов с описаниями (ниже). Список доступных режимов зависит от настроек и доступности Auto. | Клик; Shift+Tab (цикл по доступным режимам) | дока, web |
| Режим **Manual** (`default`) | «Claude will ask for approval before making each edit». Для правок открывается diff (раздел 5). | Индикатор режима | web, дока |
| Режим **Edit automatically** (`acceptEdits`) | «Claude will edit your selected text or the whole file». Правки без вопросов. | То же | web |
| Режим **Plan** (`plan`) | «Claude will explore the code and present a plan before editing». См. раздел 6. | То же; `/plan` | web |
| Режим **Auto** (`auto`) | «Claude will approve actions that pass a safety check and pause for anything risky». Классификатор проверяет действия. В v2.1.283+ — встроенный стартовый режим; на более ранних — только на Pro/Max/Team. Появляется в списке, если доступность `available` (или `unknown` при текущем `auto`). Есть подсказки «Auto mode is enabled», «Make auto mode your default permission mode?» с кнопкой «Yes, set auto mode as my default», уведомление «Auto mode is now Claude Code's default permission mode.», состояние «Auto mode is waiting for you to choose Continue or Stop». | То же | web, дока |
| Режим **Don't ask** (`dontAsk`) | «Claude will deny actions that need approval instead of asking». Присутствует в карте режимов; условия его показа не установлены. | Индикатор (условия показа неясны) | web |
| Режим **Bypass permissions** (`bypassPermissions`) | «Claude will not ask for approval before running potentially dangerous commands». Виден только при разрешении. Рекомендуется в песочницах без интернета. | `claudeCode.allowDangerouslySkipPermissions` (boolean, дефолт в `package.json` — `null`, в доке — `false`) | pkg, дока, web |
| Стартовый режим для новых разговоров | Enum `default`, `manual` (алиас `default`, метка Manual), `acceptEdits`, `plan`, `bypassPermissions`. Не задан — используется цепочка: настройки CLI → выбор из прошлого разговора → встроенный дефолт (Auto). VS Code читает настройку только из user-настроек, workspace игнорирует (с v2.1.225). Сессия, завершившаяся в plan mode, при возобновлении восстанавливает Plan (v2.1.246+), кроме случаев, когда режим выбран настройкой или задан `claudeProcessWrapper`. | `claudeCode.initialPermissionMode` (string, `null`) | pkg, дока |
| Permission-prompt в чате | Карточка «Do you want to proceed with **<Tool>**?» с кнопками: «Yes» (1), «Yes, and don't ask again» / «Yes, allow all edits this session» / «Yes, return to normal mode» (2 — зависит от вида предложенного правила), «No» с полем «Tell Claude what to do instead» (3). Клавиши 1/2/3, стрелки, Enter; Esc — «Esc to cancel». Карточка сворачивается (fold). Скринридер: подпись опции заканчивается местом сохранения («all projects», «this session»), стрелки Left/Right меняют место (v2.1.268+), можно кликнуть по нему. | Автоматически | web, дока |
| Куда сохраняется «Always»-разрешение | Опции: в user-, project-, local-настройки или только на сессию. Пояснения: «Available in all your projects (~/.claude/settings.json)», «Shared via .claude/settings.json in this project», «Private to you in this project (.claude/settings.local.json)», «Only for this session (not saved)». | Выбор в prompt | web |
| Вопросы Claude (AskUserQuestion) | Диалог с радио/чекбокс-вариантами и полем «Other»; переход между вопросами стрелками Left/Right, Up/Down по вариантам; кнопка «Submit answers». Скринридер озвучивает «Claude is asking you a question.». | Автоматически | web, дока |
| Диалог правил разрешений | Просмотр правил сессии, сгруппированных Allow/Ask/Deny; добавление правил в user/project/local и удаление из них; правила из managed-настроек и сессионные — только чтение (v2.1.269+). Ввод «Enter permission rule…»; формат правила — имя инструмента и, опционально, спецификатор в скобках. | Командное меню → Customize → «Permissions» (`permission-rules`); `/permissions`, `/allowed-tools` | дока, web |
| Песочница (sandbox) | Показывает, работают ли Bash-команды в песочнице; режимы: «Sandbox commands, with auto-allow», «Sandbox commands, with regular permissions», «Commands run outside the sandbox»; поле исключённых команд (`excludedCommands`) и «Allow unsandboxed fallback». Недоступно на платформах без песочницы (WSL1 и др.) и в облачных сессиях. Требует v2.1.280+. | Меню → Customize → «Sandbox» (id `vV0`, «View and change how commands are sandboxed»); `/sandbox` | дока, web |
| Перехват разрешений расширением | Разрешения идут через `control_request` / `can_use_tool` (известно). | | (дано заказчиком) |

---

## 5. Работа с файлами и диффами

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Предлагаемая правка в нативном diff-редакторе | В Manual-режиме Claude открывает штатный `vscode.diff` (слева оригинал, справа предложение), затем спрашивает разрешение. Пользователь может править содержимое прямо в diff перед принятием — Claude получает сообщение, что содержимое изменено пользователем. При `files.autoSave = off` принятие ждёт сохранения файла; закрытие вкладки без принятия — отказ. | Автоматически | дока, ext |
| Принять/отклонить весь diff | Кнопки в `editor/title` (навигация) при контексте `claude-vscode.viewingProposedDiff` (иконки `$(check)` и `$(discard)`). Дублируются legacy-командами `claude-code.*` при контексте `claude-code.viewingProposedDiff`. | `claude-vscode.acceptProposedDiff` («Claude Code: Accept Proposed Changes»), `claude-vscode.rejectProposedDiff` («Claude Code: Reject Proposed Changes»), `claude-code.acceptProposedDiff`, `claude-code.rejectProposedDiff` | pkg, ext |
| Ревью правки по одному изменению (hunk) | Под каждым изменением — кнопки «Accept this change» / «Reject this change» (comment-threads контроллера `claude-code-hunks`, название «Claude Code proposed changes»). Отклонение откатывает hunk в предлагаемом содержимом; принятие помечает просмотренным; принять/отклонить весь файл всё равно завершает ревью. Diff со 100+ изменений открывается без per-change кнопок. Требует Claude Code v2.1.275+. | Кнопки в диффе; команды `claude-vscode.acceptProposedHunkFromBar` / `claude-vscode.rejectProposedHunkFromBar` (скрыты из палитры); в контекстном меню редактора и палитре: `claude-vscode.acceptProposedHunk` («Claude Code: Accept Change at Cursor»), `claude-vscode.rejectProposedHunk` («Claude Code: Reject Change at Cursor») при `resourceScheme == _claude_vscode_fs_right` | pkg, дока, ext |
| Многофайловый обзор изменений | В коде есть вызов `vscode.changes` с заголовком по умолчанию «Review changes» (мультидифф по списку файлов). Что именно его инициирует в UI — не установлено. | Не установлено | ext |
| Карточки инструментов в ленте | Отдельные рендереры для инструментов (Bash, Glob, Grep, WebFetch, WebSearch, Skill, ToolSearch, Artifact, Task/Agent, TaskOutput, REPL, SandboxNetworkAccess и др. — всего около 24 классов). Заголовок инструмента, тело, результат, прогресс. Пути в карточках открываются в редакторе (`fileOpener`). Неизвестные инструменты и MCP-инструменты получают запасные рендереры. | Автоматически | web |
| Правки Jupyter-ноутбуков | Карточки «Edit Notebook Cell …»; см. раздел 15. | | web |
| Артефакты | Инструмент Artifact отображается карточкой «Artifact <file_path>» с состояниями «Opened» / «Created» / «Published» и ссылкой. Автооткрытие ссылок управляется переменной окружения `CLAUDE_CODE_ARTIFACT_AUTO_OPEN` (в коде: включено, пока значение не «ложное»). | Автоматически | web, ext |

---

## 6. План-режим

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Режим Plan | Claude исследует код и формирует план, не меняя файлы; VS Code автоматически открывает план как полноценный Markdown-документ. | Индикатор режима (по тексту чек-листа онбординга (web): «Press Shift-Tab twice, or click the mode picker twice»); `/plan` | дока, web |
| `/plan` | `/plan` — переключиться в plan mode; если уже в нём — показать текущий план; `/plan <задача>` — переключиться и начать планировать; `/plan open` — открыть файл плана в редакторе. Сообщения: «Already in plan mode. No plan written yet.», «Couldn't show the plan», «Couldn't switch to plan mode». Требует v2.1.280+. | `/plan [open\|<description>]` (действие `slash-command-plan`; описание «Enable plan mode or view the current session plan») | дока, web |
| Комментарии к плану | В предпросмотре плана выделить текст и добавить встроенный комментарий; в диалоге приёма отображаются «Comments (N)», каждый комментарий с цитатой (до 80 символов) и кнопкой удаления. | Выделение в превью плана | web, ext (`plan_comment`) |
| Диалог приёма плана | Заголовок «Accept this plan?» (при наличии комментариев — «Continue planning», «N comment(s) will be included as feedback»). Кнопки: «Yes, and use auto mode» или «Yes, and auto-accept» (зависит от следующего режима), «No, keep planning» / «Send feedback and keep planning», поле «Tell Claude what to do instead». Тексты для скринридера: «Claude has finished a plan and is waiting for your review.» | Автоматически | web |
| Итоги решения по плану | В ленте фиксируются решения «User approved the plan» и «User chose to stay in plan mode and continue planning». | Автоматически | web |
| Возобновление в plan mode | Если сессия закончилась в plan mode — она восстанавливается в нём (v2.1.246+). | Автоматически | дока |

---

## 7. Модели, thinking, effort, fast mode

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Выбор модели | Пикер «Select a model» («Loading models…», «No models available»); действие «Switch model…» («Change the AI model»), справа от названия — метка текущей модели; клик по имени модели у поля открывает тот же пикер. Сообщения «Set model to …», «Kept model as …», «Switched model». | Кнопка с именем модели; командное меню → Model → `model`; `/model` | дока, web |
| Effort | В пикере, если модель поддерживает: строка **Effort** («Set how hard the model tries»), клик циклически переключает уровень («Click to cycle effort level»), есть слайдер («Click or drag to set effort level»), краткая подпись уровня всплывает на 3 секунды. Кнопка модели показывает выбранный уровень. Любой уровень, кроме `max`, сохраняется как дефолт модели в `modelSettings` пользовательских настроек; `max` действует только на сессию. Требует v2.1.257+. | Пикер модели; действие `effort-level` | дока, web |
| Ultracode | Переключатель под Effort (только при включённых dynamic workflows и поддержке моделью): Claude планирует workflow на каждую существенную задачу сессии на выбранном effort; на кнопке модели дописывается «· Ultracode». Пункт «Run dynamic workflows on every task (this session only)». Требует v2.1.284+. | Переключатель в пикере | дока, web |
| Extended thinking | Тумблер «Thinking» («Toggle extended thinking mode»); состояние `thinkingLevel` (`off` / `default_on`), сохраняется в `globalState.thinkingLevel`. | Командное меню → Model → `toggle-thinking` | дока, web, ext |
| Fast mode | «Toggle fast mode» («Toggle fast mode for faster responses (Opus only)»), в подписи состояний: «Fast mode enabled», «Fast mode cooling down». Показывается, только если модель поддерживает. | Командное меню → Model → `fast`; шлёт `/fast` | web |
| Переключение модели при блокировке сообщения | Пункт «Switch models when a message is flagged» («When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your session will pause instead.») — за экспериментальным флагом. Карточка «Session paused»: кнопки «Switch to <модель>» и «Edit prompt and retry with <модель>»; «Learn more». | Командное меню → Model → `switch-models-on-flag` (gated) | web |
| Модели «Fable» и usage credits | Карточка запуска: «Our newest model for complex, long-running work. Switch anytime with /model.»; «Included in your plan limits until … , then switch to usage credits to continue.» Диалоги «Fable requires usage credits» с кнопкой «Buy usage credits on claude.ai»; уведомление «Now using usage credits for Fable»; «Switch to the default model and continue». | Автоматически при выборе такой модели | web, дока |
| Подсказка про `/model` | Подсказки в UI: «Type /model to pick the right tool for the job.», совет про тяжёлые скиллы («cheaper model via skill frontmatter»). | Автоматически | web |

---

## 8. Контекст, компакция, кэш

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Индикатор контекста (пирог) | Круговая диаграмма у поля; `aria-label` «`N`% context used — click to compact»; тултип «`M`% of context remaining until auto-compact.» + подсказка «Click to compact now.». **Не показывается, пока осталось >= 50% окна** (код: `if (100 - used >= 50) return null`); появляется, когда использовано больше половины. Клик запускает компакцию. | Клик по индикатору | web |
| Диалог «Context usage» | Модальное окно: строка «модель — `totalTokens` / `rawMaxTokens` tokens (`N`%)», сегментированная полоса, таблица категорий (Category / Tokens / Usage) с процентами до 0,1%, списки «Memory files» (топ-5 по токенам, подсказка `/memory`) и «Custom agents» (топ-5, подсказка `/agents`). Сообщения «Loading context usage…», «Failed to load context usage: …». | Слеш-команда `/context` (в коде ведёт на этот диалог, если CLI отдал её в список команд) | web |
| Компакция вручную/авто | `/compact`. В ленте маркер «Compacted chat · manual|auto · Nk tokens freed» (раскрываемый, внутри — резюме или «Conversation was compacted to free up context.»). Скринридер: «Compacting conversation». | `/compact`; клик по индикатору контекста | дока, web |
| Часы кэша промпта | Иконка часов рядом с индикатором контекста: отсчёт оставшегося времени жизни prompt cache (5 минут или 1 час), например **12m**. Каждый ответ, использующий кэш, перезапускает отсчёт. После истечения минуты пропадают, иконка краснеет до следующего ответа (следующее сообщение будет медленнее и дороже). После компакции иконка краснеет без минут («Prompt cache does not cover the compacted conversation.» — «your next message will re-cache it»). Остальные инвалидирующие кэш действия (смена модели) часы не сбрасывают. Подсказки: «Prompt cache warm, about N min left.», «Prompt cache likely expired (idle …)», «… will re-cache about Nk tokens». | Автоматически | дока, web |
| Индикатор живой оценки thinking | Во время рассуждения показывает оценку токенов. | Автоматически | web |

---

## 9. Сессии и история

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| История сессий (диалог) | Кнопка «Session history» в верху панели; поиск по ключевому слову («Search sessions…») или просмотр по времени; клик возобновляет разговор с полной историей; если он уже открыт в другой вкладке окна — переключение на неё. Совместима с CLI (`claude --resume`). | Кнопка; `/resume` (алиасы `/continue`); действие `resume-conversation` | дока, walk, web |
| Список сессий в Activity Bar | Постоянная панель («Session manager»), клик открывает сессию в предпочитаемом месте; сворачиваемая; секция «Account & usage» (сворачиваемая, `collapsedPanelSections`: `usage`, `sessions`). Состояния строк: Needs input / Working / Completed / Unread; подписи «Open in a tab», «Open in a terminal», «Open in another VS Code window», «Open in Claude Desktop», «Open in another Claude process» (+ «— awaiting input» / «— running»). | View `claudeVSCodeSessionsList` (доступен при `claude-vscode.sessionsListEnabled`) | pkg, web, дока |
| Заголовки | Новые сессии получают AI-заголовок по первому сообщению. | Автоматически | дока |
| Переименование сессии | Действие в списке («Rename session»); для вкладки — команда. Требует v2.1.257+. | `claude-vscode.renameSessionTab`; контекстное меню webview | pkg, дока |
| Архивация | Действие «Archive session» (раньше «Delete session»), группа «Archived sessions», «Unarchive session»; кнопка массового разархивирования у заголовка группы (v2.1.277+). Автоархив после N дней без активности (кроме открытых, работающих, ждущих ввода, непрочитанных, сессий в группах). | `claudeCode.archiveInactiveSessions` (number, `14`, enum `[0,1,2,7,14]`, `0` = выключить); требует v2.1.265+ | pkg, дока |
| Пометить как непрочитанную | Отметка сессии активной вкладки как unread в списке. Требует v2.1.257+. | `claude-vscode.markSessionUnread`; контекстное меню webview | pkg, дока |
| Группы сессий | Именованные сворачиваемые группы: создание из сессии, перенос, удаление группы (сессии возвращаются в общий список), мультивыбор Cmd/Ctrl-клик и Shift-клик, «New group from session», «Start new session in this group», «Remove from group». Хранятся по папке workspace; поиск показывает плоский список. Требует v2.1.229+. | Правый клик по сессии/группе; `claude-vscode.addSessionTabToGroup` (v2.1.257+) | pkg, дока, web |
| Фильтры списка | Переключатель **Active** (нужно ввода/работают/непрочитанные + последняя сфокусированная вкладка) и фильтр по статусу (воронка): Needs input / Working / Completed, Open / Closed. Архивные скрыты при включённом фильтре. Сохраняются между перезагрузками. Требует v2.1.271+. | Элементы в шапке списка | дока, web |
| Несколько разговоров параллельно | Каждая вкладка/окно — свой контекст. | `claude-vscode.editor.open`, `claude-vscode.window.open` | дока |
| Диалог «Different repository» | При возобновлении сессии из другого репозитория: «This session was created in <repo>. Open that folder first, or continue in the current workspace.», варианты «Open folder…», «Continue here», третий вариант (подпись не извлечена). | Автоматически | web |
| Сообщение от другой сессии (peer) | «Another Claude session sent a message while you were working:» — вход от соседней сессии Claude, обрабатывается как запрос коллеги в рамках прав текущей сессии. | Автоматически | web |
| Worktree сессии | В списке сессий — ввод «New worktree name» (плейсхолдер `e.g. my-feature`, валидация имени, «Creating worktree…»); у сессии в worktree — баннер «This session is in worktree <name>» с кнопкой «Open worktree» (открывает папку в новом окне). Команда `claude-vscode.createWorktree` объявлена в `package.json`, но в палитре скрыта (контекст `claude-vscode.createWorktreeEnabled` в коде не устанавливается), в `extension.js` как команда не зарегистрирована; запрос `create_worktree` идёт из webview напрямую. | Панель сессий (кнопка создания worktree — не удалось точно определить, где именно); `claude-vscode.createWorktree` | pkg, web, ext |

---

## 10. Чекпоинты и откат (Rewind)

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Rewind | При наведении на сообщение — кнопка отката; три варианта: «Fork conversation from here» (новая ветка, код не откатывается), «Rewind code to here» (откат файлов, история сохраняется), «Fork conversation and rewind code». Сообщения: «A new forked conversation will be created after rewinding.», «Code rewind successful», «Failed to rewind: no checkpoint for this message», «No messages to rewind to yet.» Предупреждение: «Rewinding does not affect files edited manually or via bash.» | Кнопка при наведении; командное меню → Context → `rewind` («Restore code and conversation to an earlier point»); `/rewind`, `/checkpoint`, `/undo` | дока, web |

---

## 11. Аккаунт, вход, лимиты, usage

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Экран входа | При первом открытии: «Sign in with your claude.ai account»; способ: **Claude.ai Subscription** или **Anthropic Console** (API billing); ручной ввод кода («Paste the code here», «Or, paste your authorization code manually»); «Continue in browser» показывает URL для копирования; при принудительном методе — «Login method pre-selected: …»; при `forcedLoginMethod = gateway` — вход только через терминал. | Автоматически; после «Not logged in · Please run /login» — экран возвращается | дока, web |
| Смена аккаунта / выход | «Switch account» (`login`, «Log in with a different account») и «Sign out» (`logout`, «Sign out of Claude on this computer»); на third-party провайдере пункты скрыты. Требует v2.1.277+. | Меню → Settings; `/logout`; команда `claude-vscode.logout` («Claude Code: Logout»; показывает «Successfully logged out from Claude») | pkg, дока, web |
| Account & usage | Диалог: аккаунт, лимиты. Для плана claude.ai: полосы «Session (5hr)», «Weekly (7 day)», «Weekly Sonnet» (Max/Team) и лимиты по моделям, время до сброса. Раздел «What’s contributing to your limits usage?»: поведения, дающие >= 10% недавнего usage (cache misses, long context, subagent-heavy/параллельные сессии) с советами; таблицы вкладов Skills / Subagents / Plugins / MCP servers («% of usage»); переключатель Day / Week (24 часа / 7 дней; оценка по локальным сессиям, без других устройств и claude.ai). Для API-ключа/3P: блок «Session» — Total cost, Total duration (API), Total duration (wall), Total code changes, «Usage by model» (токены, cache read/creation, web search, стоимость). | Меню → Model → `account-usage` («Account & usage…», «View account info and usage»); `/usage` | дока, web |
| Предупреждения о лимитах | Строки вида «You've used N% of your <окно>» / «Approaching …»; при исчерпании: «Usage limit reached», «Usage limit reached · wrapping up», «Usage limit reached · brief included wrap-up, then usage credits», «… resets <время>». Ссылки «Manage usage on claude.ai», «Buy usage credits on claude.ai». | Автоматически | web |
| Usage в списке сессий | Для не-подписочных входов заголовок «Account & usage» списка сессий показывает итоги активной сессии. Требует v2.1.277+. | Автоматически | дока |
| Статус `/status` | Диалог: версия Claude Code, аккаунт, модель, сведения о серверах MCP («Version, session, account, model and server details»). Требует v2.1.280+. | Меню → Customize → «Status» (`status`); `/status` | дока, web |
| Сторонние провайдеры | Bedrock / Google Agent Platform (Vertex) / Microsoft Foundry; отключает экран входа; фичи с аккаунтом claude.ai (полосы плана, голос, Web-вкладка облачных сессий) недоступны. | `claudeCode.disableLoginPrompt` (boolean, `false`); настройки в `~/.claude/settings.json` | pkg, дока |
| Внешний процесс Claude | Запуск Claude через обёртку; при этом стартовый режим — Manual, если не задан `initialPermissionMode`. | `claudeCode.claudeProcessWrapper` (string, `null`) | pkg, дока |
| Переменные окружения | Для процесса Claude; лучше задавать в settings.json Claude. | `claudeCode.environmentVariables` (array, `[]`) | pkg |
| Python-окружение | Активация окружения workspace при запуске Claude (нужно расширение Python). | `claudeCode.usePythonEnvironment` (boolean, `true`) | pkg |

---

## 12. MCP, плагины, скиллы, хуки, память, стили

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Диалог MCP | Список серверов («Loading MCP servers…», «No MCP servers configured.»), добавление («Add MCP server»; транспорты «HTTP (remote)», «SSE (remote, legacy)» и др.), удаление серверов уровней local/user/project, включение/выключение, переподключение, OAuth. Add/remove — v2.1.261+. Открыть сведения о сервере («Open MCP server details»). Источники конфигурации указываются («Shared via .mcp.json in this project»). Общая конфигурация с CLI. | Меню → Customize → «MCP servers» (`mcp-config`); `/mcp` | дока, web |
| Управление плагинами | Диалог Manage plugins: вкладки **Plugins** и **Marketplaces**; установленные с переключателями, доступные с поиском («Search plugins…»), кнопка Install, выбор области (для вас / для проекта / локально); «Enable plugin»/«Disable plugin»/«Uninstall and remove plugin»/«Reload plugins»; маркетплейсы: добавление (GitHub repo, URL, локальный путь), обновление (иконка refresh), удаление (корзина). Изменения применяются к открытым сессиям окна; если сессия не может перезагрузить плагины — предложение «Restart Claude in that session» («Restart Claude to apply plugin changes»). Официальный маркетплейс «Official Claude Code marketplace». | Меню → Customize → «Manage plugins» (`plugins`); `/plugins`, `/plugin`, `/marketplace` | дока, web |
| Команда установки плагина | Объявлена в `package.json`, но в коде регистрируется только при `process.env.ENABLE_INSTALL_PLUGIN === "true"`; в палитре видна при `claude-vscode.updateSupported` (в коде выставляется `false`). Практически недоступна. | `claude-vscode.installPlugin` | pkg, ext |
| Скиллы | Диалог «Slash commands» (фильтр; выбор запускает команду); `/skills` открывает тот же диалог; в строке скилла — видимость («On», «Name only» — «Listed for Claude by name only, without its description»; «Hidden from Claude and from the command list»; «Listed for Claude, and yours to invoke»), меняется кликом, кроме строк «locked» (плагинные). Требует v2.1.257+ / v2.1.280+. | Меню → Customize → «Slash commands» (`browse-slash-commands`); `/skills`; на строке: «Set in the skill's own file» | дока, web |
| Хуки | Просмотр загруженных хуков по событиям; добавление/правка/удаление в user/project/local настройках; из managed и плагинов — только чтение. Сообщения: «All hooks are currently disabled by a managed settings file», «Safe mode: hooks from settings files are suspended and will not run this session». Требует v2.1.269+. | Меню → Customize → «Hooks» (`hooks-config`); `/hooks` | дока, web |
| Память | Тумблер auto memory; просмотр сохранённых памятей и открытие папок в файловом менеджере; клик по памяти — чтение, правка, удаление, открытие файла (v2.1.275+). Сообщение «No memories saved for this project yet.» | Меню → Customize → «Memory» (`memory`, «View and manage what Claude remembers about this project»); `/memory` | дока, web |
| Инструкции (CLAUDE.md) | Список файлов CLAUDE.md; выбор открывает файл в редакторе, отсутствующий — создаётся. Уведомление «Claude reads … when a session starts. … to apply changes to the current session.» с кнопкой «Reload Claude». Требует v2.1.274+. | Меню → Customize → «Instructions» (`instructions`, «Edit CLAUDE.md files») | дока, web |
| Output styles | Выбор стиля вывода, включая пользовательские; «Build a custom style» — Claude пишет файл стиля на уровне проекта или пользователя; форма: название, «Status message», описание («Added to Claude's system prompt whenever this style is active»). Требует v2.1.257+ / v2.1.261+. | Меню → Customize → «Output styles» (`output-style`, «Change response formatting style») | дока, web |
| Настройки Claude | Общие с CLI `~/.claude/settings.json`; JSON-схема подключена через `jsonValidation` для `**/.claude/settings.json`, `**/.claude/settings.local.json`, `**/ClaudeCode/managed-settings.json`, `**/claude-code/managed-settings.json` (файл `claude-code-settings.schema.json`, 172 верхнеуровневых свойства). Ошибки настроек показываются баннером («Settings file failed to parse: …»). | Автоматически; «General config…» (`general-config`) открывает настройки расширения | pkg, дока, web |
| Общие настройки-алиасы | `/config` и `/settings` ведут в «General config…». | `/config`, `/settings` | web |
| Remote Control для всех сессий | Тумблер «Enable Remote Control for all sessions» (`remoteControlAtStartup`): применяется к уже открытым сессиям окна; при выключении открытые сессии отключаются; с v2.1.261+ затрагивает и другие окна. Требует v2.1.203+. Описание: «Connect all sessions to claude.ai/code automatically so you can view and control them from the web.» | Меню → Settings | дока, web |
| Терминальный баннер и реклама | Баннер «Prefer the Terminal experience?» / «Open Claude in Terminal» («Open a new Claude instance in the Terminal»). Флаги `showTerminalBanner`, `reviewUpsellBanner`. | Автоматически | web, ext |

---

## 13. Субагенты, задачи, агентная карта

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Счётчик агентов | В нижней части поля появляется «N agents» с точкой статуса (работает / ждёт разрешения). Подсказки: «Agents are working · Click to open the agent map», «An agent is waiting for your permission · Click to open the agent map», «An agent failed · Click to open the agent map». | Клик по счётчику | дока, web |
| Agent map | Дерево субагентов под главным агентом со статусом, временем и числом токенов. Клик по субагенту: его промпт и вызовы инструментов, открыть read-only транскрипт, остановить. Ниже — фоновые задачи (shell, мониторы); клик открывает карточку задачи, там же остановка. Сообщения об ошибке «The agent could not be stopped. It may have finished already.» / «The task could not be stopped…». Требует v2.1.269+. | Клик; `/tasks` (когда счётчика нет; фоновые задачи — v2.1.277+) | дока, web |
| Кастомные агенты | Категория «Custom agents» в диалоге Context usage (подсказка `/agents`). | `/agents` (подсказка) | web |

---

## 14. Интеграция с Chrome (браузер)

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| `@browser` | Claude управляет вкладками Chrome через расширение Claude in Chrome (>= 1.0.36), с общим логином; тестирование, консоль, автоматизация. | Набор `@browser …`; меню «+» → «Browse the web»; подсказки `@browser:` | дока, web |
| Управление подключением | Диалог: «Connecting to browser…», «Browser connected», «Disconnect browser», «Install Chrome extension», «Open Claude in Chrome settings», «Learn more about Claude in Chrome», выбор из нескольких браузеров. Недоступно при не-claude.ai входе, в WSL, при отключении организацией, и из облачных сессий. Требует v2.1.280+. | Меню → Customize → «Claude in Chrome» (`chrome-settings`); `/chrome` | дока, web |

---

## 15. Jupyter, IDE MCP-сервер

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Встроенный MCP-сервер `ide` | Локальный WebSocket-сервер `ws://127.0.0.1:<порт 10000–65535 случайный>`, аутентификация токеном из lock-файла `~/.claude/ide/<port>.lock` (`0600`, каталог `0700`), заголовок `X-Claude-Code-Ide-Authorization`. CLI использует его для открытия diff, чтения выделения, сохранения файлов. Скрыт из `/mcp`. Модели видны два инструмента. | Автоматически | дока |
| `mcp__ide__getDiagnostics` | Диагностика языковых серверов (Problems), можно по одному файлу. Read-only. | Вызывается моделью | дока |
| `mcp__ide__executeCode` | Выполняет Python в ядре активного Jupyter-ноутбука; код вставляется новой ячейкой в конец, VS Code прокручивает к ней, Quick Pick «Execute/Cancel»; Esc = отмена; отказ при отсутствии ноутбука, расширения `ms-toolsai.jupyter` или не-Python ядре. | Вызывается моделью; подтверждение — в VS Code | дока |
| Подключение ноутбука в чате | Всплывающая плашка «Jupyter notebook detected» / «N Jupyter notebooks detected» с кнопкой подключения, состояния «Notebook connected», «Notebook error: …», «Disconnect notebook». | Плашка при открытом ноутбуке | web |

---

## 16. Терминальный режим

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Режим CLI вместо GUI | Запускает Claude в терминале VS Code вместо webview. Меняет `when`-условия хоткеев и кнопки. | `claudeCode.useTerminal` (boolean, `false`) | pkg, дока |
| Открыть в терминале | Команда открывает новый экземпляр Claude в терминале. Иконка в `editor/title` при `useTerminal`. | `claude-vscode.terminal.open` («Claude Code: Open in Terminal»); хоткей `cmd+escape` / `ctrl+escape` при `config.claudeCode.useTerminal` — команда `claude-vscode.terminal.open.keyboard` (в `commands` не объявлена, есть только в `keybindings` и в коде) | pkg, ext |
| Вставка @-упоминания в терминал | В терминальном режиме команда `claude-code.insertAtMentioned` (хоткей `cmd+alt+K`/`ctrl+alt+K`, палитра при `useTerminal`). | см. раздел 3 | pkg |
| «Continue in Terminal» | Диалоги «Continue in Terminal to manage plugins?»; действия с иконкой терминала в меню открываются в встроенном терминале. | Меню | web, дока |
| CLI внутри VS Code | В интегрированном терминале можно запустить `claude` (нужна отдельная установка CLI); интеграция с IDE (diff, диагностика) работает. Во внешнем терминале — `/ide`. Общая история: `claude --resume`. | Терминал VS Code | дока |

---

## 17. Облако и удалённое управление

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Возобновление облачных сессий | В диалоге истории вкладки **Local** и **Web**; Web показывает сессии claude.ai (при открытом GitHub-репо — только его сессии); клик скачивает копию истории, изменения обратно не синхронизируются. Ошибки скачивания — без сохранения копии. Требует входа Claude.ai Subscription. Сообщение «Failed to teleport session», «Teleporting session…»; метка «Teleported from web» с веткой; предупреждения «Branch checkout skipped/failed: …» и кнопка checkout. | Кнопка Session history → вкладка Web | дока, web |
| Remote Control сессии | В Web-вкладке также сессии Remote Control; если сессия запускалась в открытой папке — открывается локальный разговор. Плашка «Remote Control» (`Remote Control is active · Click to open claude.ai/code · Run /remote-control to turn off`), состояния «Connecting to claude.ai/code…», «Remote Control error: …». | `/remote-control` («View and control this session from claude.ai/code») | дока, web |
| Claude Design | Пункт «Claude Design», диалог авторизации доступа к дизайн-системе через аккаунт claude.ai (ввод кода); сообщения «Claude Design sync is not available in this session.». Назначение подробнее не установлено. | Меню → Customize → `design-login`; `/design-login` | web |
| Slack tag | Внутреннее состояние `slackTag` (подключён ли Claude в Slack), тост-активность и отключение. Пользовательский сценарий не установлен. | — | web (косвенно) |
| «Open in Claude Desktop» | Метка для сессий, открытых в Claude Desktop (статус в списке). | Автоматически | web |

---

## 18. Голосовой ввод и правописание

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Голосовая диктовка | Кнопка микрофона в поле ввода («Voice dictation» / «Stop recording»; «Microphone access denied»; «Dictation error: …»); уровень звука рисуется, промежуточный распознанный текст выделяется (`voiceInterim`). Доступна только при вошедшем аккаунте claude.ai (`claudeAiFeatureGate`), не на 3P-провайдерах и не в remote (`env.remoteName`). Транскрипция — потоковая через `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`; захват звука нативным модулем `resources/audio-capture/arm64-darwin/audio-capture.node`. Язык берётся из `accessibility.voice.speechLanguage` VS Code. При отказе доступа — подсказка идти в «System Settings → Privacy & Security → Microphone». | Кнопка; в поле ввода **Cmd+D** (macOS) / **Ctrl+D** (иначе): короткое нажатие включает/выключает запись, удержание >= 200 мс работает как push-to-talk (запись останавливается при отпускании) | web, ext, дока |
| Команда переключения диктовки | Зарегистрирована, но **не объявлена в `package.json`** и без хоткея; вызывается программно. | `claude-vscode.toggleDictation` | ext |
| Орфография | См. раздел 2 (`claudeCode.spellcheck`, не объявлена). | | ext, web |

---

## 19. Доступность (скринридер)

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Озвучивание разговора | Всегда включено, без визуальных изменений (v2.1.236+): ответ озвучивается один раз по завершении (без потоковой озвучки), блоки кода — как сводка по числу строк, таблицы — по ячейкам; озвучиваются запросы разрешений, вопросы, готовый план, смена статуса (начал работу / готов / компакция), ошибки, диалоги согласия. При открытии/переключении сессии молчит. | Автоматически | дока |
| Навигация по ленте | Скрытый заголовок на каждый ход (по тексту промпта); роли «You», «Claude», «Claude, Bash», «Claude, thinking»; транскрипт — labeled region, достижим по Tab. | Клавиатура | дока |
| Focus last message | Команда переводит фокус на новое сообщение/запрос разрешения. | `claude-vscode.focusLastMessage` | pkg, дока |

---

## 20. Онбординг, обратная связь, диагностика

| Фича | Что делает и как ведёт себя | Как вызывается | Источник |
|---|---|---|---|
| Walkthrough «Get started with Claude Code» | Нативное VS Code-прохождение из 4 шагов: `welcome` («Your AI coding partner»), `open-claude` (завершается по `onCommand:claude-vscode.sidebar.open` или `onCommand:claude-vscode.editor.open`), `chat`, `sessions`. Содержимое в `resources/walkthrough/step1..4.md`. | `claude-vscode.openWalkthrough` («Claude Code: Open Walkthrough») | pkg, walk, ext |
| Чек-лист «Learn Claude Code» | Показывается после входа: пункты с кнопкой «Show me» и крестиком; значок выпускной шапки. Пункты (из кода): «Prompt Claude to write code» (id `write-code`), «Highlight code and ask for edits» (`highlight-code`), «Give Claude rules to remember» (`claude-rules`), «Let Claude edit without stopping» (`auto-accept`), «Use Plan mode for complex changes» (`plan-mode`); «Finish onboarding», «Learn your next skill →». Скрывается настройкой; внутреннее действие `reset-onboarding` («Restart the onboarding flow»). | `claudeCode.hideOnboarding` (boolean, `false`) | pkg, дока, web |
| Обратная связь | «Send feedback and report a bug» (`/bug`, `/feedback` с необязательным описанием; кнопка «Report a problem» внизу меню). Отчёт при входе Anthropic first-party отправляется в Anthropic; иначе сохраняется локально в `~/.claude/feedback-bundles/` с редактированием ключей и токенов, подтверждение с кнопкой «Show folder» (сохранение — v2.1.284+). Отключается политикой организации или переменными `DISABLE_FEEDBACK_COMMAND`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. | Меню → Support; `/bug`, `/feedback` | дока, web |
| Опрос «How is Claude doing this session?» | Баннер оценки сессии с вариантами оценок, затем «Thanks for the feedback!», диалог отзыва. Условия показа не установлены. | Автоматически | web |
| Логи расширения | Открывает output channel «Claude VSCode». | `claude-vscode.showLogs` | pkg, ext |
| Обновление расширения | Команда объявлена, в палитре видна только при `claude-vscode.updateSupported` (в коде выставляется `false`; в списке команд, регистрируемых в `extension.js`, отсутствует). Практически недоступна в этой сборке. | `claude-vscode.update` | pkg, ext |
| Автоустановка IDE-расширения из CLI | Если запустить `claude` в терминале VS Code, CLI переустановит расширение; отключается `autoInstallIdeExtension` в `/config` или `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1`. | Настройка CLI | дока |

---

# Списки (полные)

## Список 1. Команды (`contributes.commands`, 31 шт.)

Формат: `id` — заголовок. Помета «палитра» — условие показа в Command Palette из `menus.commandPalette`.

| # | id | Заголовок | Условие в палитре / примечание |
|---|---|---|---|
| 1 | `claude-vscode.editor.open` | Claude Code: Open in New Tab | всегда |
| 2 | `claude-vscode.editor.openLast` | Claude Code: Open | скрыта (`false`) |
| 3 | `claude-vscode.primaryEditor.open` | Claude Code: Open in Primary Editor | `claude-vscode.primaryEditorEnabled` |
| 4 | `claude-vscode.window.open` | Claude Code: Open in New Window | всегда |
| 5 | `claude-vscode.createWorktree` | Claude Code: Create Worktree | `claude-vscode.createWorktreeEnabled` (в коде не выставляется; команда в `extension.js` не найдена) |
| 6 | `claude-vscode.sidebar.open` | Claude Code: Open in Side Bar | всегда |
| 7 | `claude-vscode.newConversation` | Claude Code: New Conversation | скрыта (`false`); вызывается хоткеем |
| 8 | `claude-vscode.reopenClosedSession` | Claude Code: Reopen Closed Session | всегда |
| 9 | `claude-vscode.update` | Claude Code: Update extension | `claude-vscode.updateSupported` |
| 10 | `claude-vscode.focus` | Claude Code: Focus input | всегда |
| 11 | `claude-vscode.focusLastMessage` | Claude Code: Focus last message | `!config.claudeCode.useTerminal` |
| 12 | `claude-vscode.blur` | Claude Code: Blur input | скрыта (`false`) |
| 13 | `claude-vscode.logout` | Claude Code: Logout | всегда |
| 14 | `claude-vscode.terminal.open` | Claude Code: Open in Terminal | всегда |
| 15 | `claude-vscode.acceptProposedDiff` | Claude Code: Accept Proposed Changes | кнопка в `editor/title` при `claude-vscode.viewingProposedDiff` |
| 16 | `claude-vscode.rejectProposedDiff` | Claude Code: Reject Proposed Changes | то же |
| 17 | `claude-vscode.acceptProposedHunk` | Claude Code: Accept Change at Cursor | контекстное меню при `resourceScheme == _claude_vscode_fs_right` |
| 18 | `claude-vscode.rejectProposedHunk` | Claude Code: Reject Change at Cursor | то же |
| 19 | `claude-vscode.acceptProposedHunkFromBar` | Accept this change | скрыта (`false`); кнопка в comment thread `claude-code-hunks` |
| 20 | `claude-vscode.rejectProposedHunkFromBar` | Reject this change | скрыта (`false`); то же |
| 21 | `claude-vscode.insertAtMention` | Claude Code: Insert @-Mention Reference | `!config.claudeCode.useTerminal` |
| 22 | `claude-vscode.installPlugin` | Claude Code: Install Plugin | `claude-vscode.updateSupported`; регистрируется в коде только при `ENABLE_INSTALL_PLUGIN=true` |
| 23 | `claude-code.acceptProposedDiff` | Claude Code: Accept Proposed Changes | `editor/title` при `claude-code.viewingProposedDiff` (legacy) |
| 24 | `claude-code.rejectProposedDiff` | Claude Code: Reject Proposed Changes | то же (legacy) |
| 25 | `claude-code.insertAtMentioned` | Claude Code: Insert At-Mentioned | `config.claudeCode.useTerminal` |
| 26 | `claude-vscode.showLogs` | Claude Code: Show Logs | всегда |
| 27 | `claude-vscode.toggleFocusView` | Claude Code: Toggle Focus view | всегда |
| 28 | `claude-vscode.openWalkthrough` | Claude Code: Open Walkthrough | всегда |
| 29 | `claude-vscode.markSessionUnread` | Claude Code: Mark Session as Unread | `activeWebviewPanelId == 'claudeVSCodePanel'`; также в `webview/context` |
| 30 | `claude-vscode.renameSessionTab` | Claude Code: Rename Session Tab | то же |
| 31 | `claude-vscode.addSessionTabToGroup` | Claude Code: Add Session Tab to Group | то же |

Команды, которые есть в коде, но **не объявлены** в `contributes.commands`: `claude-vscode.terminal.open.keyboard` (используется в хоткее), `claude-vscode.toggleDictation`.

Меню `webview/context` (правый клик по вебвью, при `webviewId == 'claudeVSCodePanel'`): `markSessionUnread`, `renameSessionTab`, `addSessionTabToGroup`.

Контекстные ключи, которыми управляет расширение: `claude-vscode.viewingProposedDiff`, `claude-code.viewingProposedDiff`, `claude-vscode.sideBarActive`, `claude-vscode.lastClosedWasSession`, `claude-vscode.sessionsListEnabled`, `claude-vscode.primaryEditorEnabled`, `claude-vscode.updateSupported`, `claude-code:doesNotSupportSecondarySidebar`.

## Список 2. Настройки (`contributes.configuration`)

Объявлено 21. Дефолт `null` означает «не задан».

| Ключ | Тип | Дефолт | Описание (из `package.json`) |
|---|---|---|---|
| `claudeCode.environmentVariables` | array | `[]` | Переменные окружения при запуске Claude. Предпочтительнее задавать в Claude settings.json |
| `claudeCode.useTerminal` | boolean | `false` | Запускать Claude в терминале вместо нативного UI |
| `claudeCode.allowDangerouslySkipPermissions` | boolean | `null` | Разрешить режим bypass permissions. Только для песочниц без интернета |
| `claudeCode.claudeProcessWrapper` | string | `null` | Путь к исполняемому файлу, через который запускается процесс Claude |
| `claudeCode.respectGitIgnore` | boolean | `true` | Учитывать .gitignore при поиске файлов (можно фильтровать по `.ignore`) |
| `claudeCode.initialPermissionMode` | string, enum `default`, `manual`, `acceptEdits`, `plan`, `bypassPermissions` | `null` | Начальный режим разрешений для новых разговоров; `manual` — алиас `default` |
| `claudeCode.disableLoginPrompt` | boolean | `false` | Никогда не показывать запрос входа (внешняя аутентификация) |
| `claudeCode.autosave` | boolean | `true` | Автосохранение файлов перед чтением/записью Claude |
| `claudeCode.focusView` | boolean | `false` | Focus view: скрыть вызовы инструментов и активность в чате |
| `claudeCode.useCtrlEnterToSend` | boolean | `false` | Отправка по Ctrl/Cmd+Enter вместо Enter |
| `claudeCode.preferredLocation` | string, enum `sidebar`, `panel` | `"panel"` | Где Claude открывается по умолчанию; обновляется автоматически |
| `claudeCode.lockEditorGroups` | boolean | `true` | Блокировать редакторские группы, созданные под вкладки Claude |
| `claudeCode.enableNewConversationShortcut` | boolean | `false` | Cmd/Ctrl+N для нового разговора при фокусе на Claude |
| `claudeCode.enableReopenClosedSessionShortcut` | boolean | `true` | Cmd/Ctrl+Shift+T для возврата закрытой вкладки сессии |
| `claudeCode.hideOnboarding` | boolean | `false` | Скрыть чек-лист онбординга |
| `claudeCode.attachOpenFile` | boolean | `true` | Добавлять открытый в редакторе файл в сообщения |
| `claudeCode.continueAfterReload` | boolean | `true` | После перезагрузки окна продолжать прерванный шаг |
| `claudeCode.scrollToBottomOnSend` | boolean | `true` | Прокручивать разговор вниз при отправке сообщения |
| `claudeCode.showMessageTimestamps` | boolean | `false` | Показывать время сообщений; линия даты при смене дня |
| `claudeCode.archiveInactiveSessions` | number, enum `[0,1,2,7,14]` | `14` | Архивировать сессию после N дней без активности; `0` — выключить |
| `claudeCode.usePythonEnvironment` | boolean | `true` | Активировать Python-окружение workspace при запуске Claude |

Читаются кодом, но **не объявлены** в `package.json`: `claudeCode.spellcheck` (по коду дефолт `true`), `claudeCode.spinnerVerbs` (формат значения не проверен).

Хранилище состояния (`globalState`): `autoArchiveNoticeShown`, `chromeExtensionNotificationDismissed`, `collapsedPanelSections`, `defaultPermissionMode`, `experimentGates`, `hiddenSessionIds`, `lastClaudeLocation`, `lastClaudeLocationMigrated`, `permissionModeClearedForAutoDefault`, `reviewUpsellDismissedMetadata`, `reviewUpsellLastShownTimestamp`, `sessionListFilter`, `sessionUnarchivedAt`, `settingsMigrated20251024`, `showTerminalBanner`, `spellcheckUserWords`, `thinkingLevel`, `walkthroughShown`.

## Список 3. Хоткеи

Из `contributes.keybindings` (Mac / Win / Linux; там, где не указано отдельно, `key` совпадает):

| Команда | Mac | Win/Linux | when |
|---|---|---|---|
| `claude-vscode.insertAtMention` | `alt+k` | `alt+k` | `editorTextFocus` |
| `claude-vscode.focus` | `cmd+escape` | `ctrl+escape` | `!config.claudeCode.useTerminal && editorTextFocus` |
| `claude-vscode.blur` | `cmd+escape` | `ctrl+escape` | `!config.claudeCode.useTerminal && !editorTextFocus` |
| `claude-vscode.editor.open` | `cmd+shift+escape` | `ctrl+shift+escape` | `!config.claudeCode.useTerminal` |
| `claude-vscode.terminal.open.keyboard` | `cmd+escape` | `ctrl+escape` | `config.claudeCode.useTerminal` |
| `claude-code.insertAtMentioned` | `cmd+alt+K` | `ctrl+alt+K` | `editorTextFocus` |
| `claude-vscode.newConversation` | `cmd+n` | `ctrl+n` | `config.claudeCode.enableNewConversationShortcut && (activeWebviewPanelId == 'claudeVSCodePanel' \|\| (claude-vscode.sideBarActive && !editorFocus && !panelFocus))` |
| `claude-vscode.toggleFocusView` | `ctrl+alt+f` (общий `key`, без отдельного `mac`) | `ctrl+alt+f` | `activeWebviewPanelId == 'claudeVSCodePanel' \|\| claude-vscode.sideBarActive` |
| `claude-vscode.reopenClosedSession` | `cmd+shift+t` | `ctrl+shift+t` | `config.claudeCode.enableReopenClosedSessionShortcut && claude-vscode.lastClosedWasSession` |

Хоткеи внутри webview (не объявлены в `package.json`, найдены в коде и доке):

| Клавиша | Где | Действие | Источник |
|---|---|---|---|
| Enter | поле ввода | отправить (или перенос строки при `useCtrlEnterToSend`) | web |
| Shift+Enter | поле ввода | перенос строки | дока, web |
| Ctrl/Cmd+Enter | поле ввода | отправить при `useCtrlEnterToSend` | web |
| Shift+Tab | поле ввода | цикл по доступным режимам разрешений | web |
| Tab | поле ввода | принять подсказку промпта; в меню — выбрать элемент | web |
| Стрелка вверх/вниз | поле ввода | история ранее отправленных сообщений; в меню — навигация | web |
| Esc | по контексту | закрыть меню/диалог; в permission-prompt — «Esc to cancel»; двойной Esc при пустом поле вызывает обработчик (не установлено, какой; по аналогии с CLI — вероятно откат/rewind) | web |
| Ctrl+O | лента | раскрыть/свернуть все thinking-блоки | дока, web |
| Cmd+D (Mac) / Ctrl+D | поле ввода | голосовая диктовка (тап — тумблер, удержание >= 200 мс — push-to-talk) | web |
| 1 / 2 / 3, стрелки, Enter | permission-prompt и диалоги | выбор варианта | web |
| Left/Right | permission-prompt с местом сохранения | смена места сохранения правила (v2.1.268+) | дока |
| Alt+K / Option+K | редактор | вставка @-упоминания | pkg, дока |

## Список 4. Действия командного меню чата (`/`), реестр `commandRegistry`

Формат: секция — `id` — метка — описание.

| Секция | id | Метка | Описание |
|---|---|---|---|
| Context | `attach-file` | Attach file… | Upload a file to include in conversation |
| Context | `mention-file` | Mention file from this project… | Reference a project file with @mention |
| Context | `clear-conversation` | Clear conversation | Start a new conversation |
| Context | `export-conversation` | Export conversation | Copy the conversation as plain text or save it to a file |
| Context | `rewind` | Rewind | Restore code and conversation to an earlier point |
| Context | `new-conversation` | New conversation | Open a new conversation in a new tab or the sidebar (только по фильтру) |
| Context | `resume-conversation` | Resume conversation | Continue a previous conversation (только по фильтру) |
| Model | `model` | Switch model… | Change the AI model |
| Model | `effort-level` | Effort | Set how hard the model tries |
| Model | `toggle-thinking` | Thinking | Toggle extended thinking mode |
| Model | `fast` | Toggle fast mode | Toggle fast mode for faster responses (Opus only) |
| Model | `switch-models-on-flag` | Switch models when a message is flagged | (за флагом) |
| Model | `account-usage` | Account & usage… | View account info and usage |
| Customize | `browse-slash-commands` | Slash commands | Browse slash commands |
| Customize | `mcp-config` | MCP servers | Configure Model Context Protocol servers |
| Customize | `output-style` | Output styles | Change response formatting style |
| Customize | `hooks-config` | Hooks | View and edit hooks |
| Customize | `memory` | Memory | View and manage what Claude remembers about this project |
| Customize | `instructions` | Instructions | Edit CLAUDE.md files |
| Customize | `permission-rules` | Permissions | View and edit permission rules |
| Customize | `plugins` | Manage plugins | Install, enable, or disable plugins |
| Customize | `status` | Status | Version, session, account, model and server details |
| Customize | (id `vV0`) | Sandbox | View and change how commands are sandboxed |
| Customize | `chrome-settings` | Claude in Chrome | Check and manage the Claude in Chrome connection |
| Customize | `design-login` | Claude Design | (авторизация дизайн-системы) |
| Settings | `toggle-focus-view` | Focus view | Show only your prompts and Claude's responses |
| Settings | (id из `Pp`) | Enable Remote Control for all sessions | Connect all sessions to claude.ai/code automatically so you can view and control them from the web. |
| Settings | (id `we` = `general-config`) | General config… | Open Claude Code Extension configuration |
| Settings | `login` / `logout` | Switch account / Sign out | Log in with a different account / Sign out of Claude on this computer |
| Settings | `reset-onboarding` | Reset onboarding [internal] | Restart the onboarding flow |
| Support | (id `XX.help`) | View help docs | Open help documentation |
| Support | `issue` | /issue: flag model behavior (internal) | Report model issues to the research team (внутреннее) |
| Support | `share` | Share with team (internal) | Share conversation with team members (внутреннее) |
| Slash Commands | `slash-command-btw`, `-bug`, `-chrome`, `-design-login`, `-feedback`, `-remote-control`, `-skills`, `-help`, `-tasks`, `-terminal`, `-copy`, `-export`, `-status`, `-plan` | `/btw` и т.д. | реализованы в webview |

Слеш-команды, для которых webview подменяет CLI-реализацию нативным UI (алиасы): `/mcp`→MCP; `/config`, `/settings`→General config; `/hooks`; `/memory`; `/permissions`, `/allowed-tools`; `/plugin`, `/plugins`, `/marketplace`; `/rewind`, `/checkpoint`, `/undo`; `/resume`, `/continue`; `/help`; `/model`; `/context`→диалог Context usage; `/usage`→Account & usage; остальные команды из списка CLI передаются как текст `/name`.

---

# Не подтверждено

Выведено из косвенных признаков или прочитано не полностью; не выдавать за факт.

1. **Индикатор контекста «только с 50%»**: условие `if(100-used>=50) return null` прочитано в коде, но есть переопределение через глобальную переменную `Zj1` (назначение неизвестно; возможно, отладочное). Поведение «скрыт, пока использовано меньше половины» — по коду, вживую не проверялось.
2. **`/context` в интерфейсе**: код показывает, что команда `context` ведёт на диалог «Context usage» с токенами по категориям. Появляется ли она в списке слеш-команд у пользователя, зависит от списка `claudeConfig.commands` от CLI; не проверено.
3. **Двойной Esc при пустом поле**: код вызывает обработчик (`B()`) при двух Esc в пределах 800 мс; что он делает (откат/rewind, отмена, что-то другое) — не установлено.
4. **Режим Don't ask (`dontAsk`)**: описан в карте режимов, но при каких условиях попадает в переключатель — не выяснено (в доке не упомянут).
5. **Создание worktree из UI**: поле «New worktree name» и запрос `create_worktree` есть в webview; где именно кнопка вызова и когда она доступна — не подтверждено. Команда `claude-vscode.createWorktree` в палитре скрыта, в коде не зарегистрирована.
6. **`vscode.changes` «Review changes»**: код умеет открывать мультидифф по списку файлов; какое действие в UI его запускает — не найдено.
7. **`@`-меню агентов**: в коде есть суффикс «(agent)» и префикс `agent-`; полный список сущностей меню `@` (файлы, папки, терминалы, браузер, агенты, ресурсы MCP?) не восстановлен.
8. **`claudeCode.spellcheck` и `claudeCode.spinnerVerbs`**: читаются кодом, не объявлены в `package.json`. Назначение `spinnerVerbs` (формат значения) не проверено.
9. **`claude-vscode.toggleDictation`**: зарегистрирована, но без хоткея и без объявления; кто её вызывает (возможно, внутренний/экспериментальный путь) — не установлено. Доступность диктовки зависит от гейта `claudeAiFeatureGate({hostBearer:true})` и `Lz1()` (проверка нативного модуля/платформы), не проверялась.
10. **Slack tag, Claude Design, review upsell, опрос «How is Claude doing this session?», промо**: есть код состояния и текстов, но пользовательские сценарии и условия показа не подтверждены.
11. **Fable/usage credits, `switch-models-on-flag`, Ultracode, Auto-режим**: показ зависит от экспериментальных гейтов (`experimentGates`) и плана; часть текстов взята из кода, актуальность для конкретного аккаунта не проверена.
12. **Точный формат `/export`, что попадает в «plain text»** — из доки; в коде не разбирался.
13. **Список карточек инструментов** (~24 рендерера): перечислены только те, чьё имя удалось прочитать; Edit/Write/Read/TodoWrite/NotebookEdit/ExitPlanMode рендерятся, но по имени в бандле не подтверждены (использование другого способа регистрации).
14. **Различие v2.1.283 (Auto как встроенный дефолт) и ранних версий**: взято из доки, в этой сборке (2.1.284) действует новое поведение, но дефолт на конкретной машине зависит от цепочки настроек.
15. **`allowDangerouslySkipPermissions`**: дефолт в `package.json` — `null`, в доке — `false`. Расхождение принято как несущественное (falsy).
16. **Терминальный режим**: точное поведение `claude-vscode.terminal.open` (аргументы запуска `claude`, `--ide`) не разбиралось; сведения из доки.
17. **`--output-format stream-json` и протокол webview–extension**: считаются известными по заданию, в каталог не включены.

---

# Чего не хватает глазами пользователя

Только то, что следует из источников.

1. **Контекст в процентах и только после 50%.** Круговой индикатор показывает процент использованного окна, скрыт до половины заполнения; токены и размер окна показываются лишь в отдельном диалоге «Context usage» (через `/context`), не постоянно рядом с полем.
2. **Кэш — только оценка времени.** Часы кэша показывают минуты до истечения по локальной оценке TTL (5 минут или 1 час) и красную иконку; фактической доли попаданий/промахов нет. Стоимость перекэширования в токенах видна только в подсказке («about Nk tokens») и лишь после истечения.
3. **Стоимость и токены сессии — скупо.** Для подписочных входов усреднённые полосы лимитов (Session 5hr, Weekly 7 day, Weekly Sonnet) без токенов; блок «Session» с Total cost, длительностью API/стенной, строками кода и «Usage by model» — показывается для API-ключа и 3P-провайдера; в ленте нет стоимости и токенов по каждому ходу. Токены видны по субагентам в Agent map и в маркере компакции («Nk tokens freed»).
4. **Usage по локальным сессиям.** Разбивка по скиллам, субагентам, плагинам, MCP — приблизительная и только по этой машине; использование с других устройств и из claude.ai не входит.
5. **Нет сводки по ходу.** В расширении нет аналога `showTurnDuration` из CLI («Cooked for Nm Ns» — это настройка CLI); длительность видна только у thinking («Thought for Ns»).
6. **Нет единого экрана «что сейчас в контексте» кроме модального диалога.** Список вложений, выделения и открытого файла показывается чипами у поля, но без веса в токенах.
7. **Ограниченные сведения о разрешениях.** Диалог «Permissions» показывает правила, но не журнал того, что было одобрено/отклонено за сессию; одобрения «только на сессию» помечены «Approved for this session only; not saved in a settings file.» и доступны как read-only.
8. **Нет обзора параллельных сессий по ресурсу.** Список сессий даёт статусы (Needs input / Working / Completed), но без токенов, стоимости и процента контекста каждой сессии; итоги «Account & usage» в списке — только активной сессии и только для не-подписочных входов.
9. **Скупая видимость кэша/лимитов для команд.** Предупреждения о лимитах — текст «You've used N% of your …» и «Usage limit reached», без графика динамики.
10. **Ограничения выделения.** Выделение в исключённых/gitignore-файлах не передаётся (только путь), и UI об этом явно не сообщает в самой ленте.
