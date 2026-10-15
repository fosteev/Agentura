# 25 — настройки поиска коммитов по задаче и попап «как ищем?»

Сессия 1 — настройки «где искать ключ» + общий текст попапа + ссылка на настройки · Модель: sonnet, effort: high · после 0.17.1

Работаем в `/Users/fost/Projects/Agentura`. Задача: во вкладке «код» задачи (roadmap 24) сделать настраиваемым,
где ищется ключ задачи (сообщение коммита / имя ветки), переписать попап «как ищем?» общим текстом без
конкретики репозитория и добавить в него ссылку, открывающую настройки Agentura сразу на разделе «Интеграции».
Доработка существующего кода, не стройка.

Читай: `docs/roadmap/24-task-code.md` (как устроена вкладка, только разделы про поиск и попап). Правила репо:
`AGENTS.md` / `CLAUDE.md` в корне, если есть. Публичное (строки en, package.nls.json) — на английском, ru — на русском.

## Точки входа (проверены при планировании — не перечитывать целиком, открывать только правимый фрагмент)

Хост:
- `src/extension/jira/taskCode.ts:284` `collectRepo` — поиск: `git log --all --grep` (стр. ~295), имена веток
  `branchesOf(for-each-ref …)` (~300), пометка «в базе» через `git log <base> --grep` (~344).
- `src/extension/jira/taskCode.ts:239` `CodeCollectInput`, `:425` `collectCode` — сюда добавить параметр.
- `src/extension/jira/taskCode.ts:547` `TaskCodeDeps`, `:630` `TaskCode.load` — собирает `task.code.state`.
- `src/extension/jira/taskCode.ts:627` `TaskCode.refresh(taskKey)` — тихая перезагрузка, если вкладка загружалась.
- `src/extension/jira/setup.ts:29` `taskSettings()` — эталон чтения task-настроек из конфига.
- `src/extension/chatPanel.ts:838` `new TaskCode({...})` — сюда новый dep; `:1068` `static settingsChanged()`.
- `src/extension/jira/taskTab.ts:204` `onAgentEvent` — эталон вызова `this.deps.code?.refresh(key)`.
- `src/extension/extension.ts:431` команда `agentura.openSettings` → `SettingsPanel.show(context, log, jira)`;
  ниже `onDidChangeConfiguration` (там же `ChatPanel.settingsChanged()`).
- `src/extension/settingsPanel.ts:20` `SettingsPanel.show` — при открытой панели только `reveal()`.
- `src/extension/chatController.ts:850` `case 'settings.open': deps.openSettings?.()`; `:191` тип dep;
  `src/extension/chatPanel.ts:773` `openSettings: () => … executeCommand('agentura.openSettings')`.
- `src/protocol.ts:463` `{ type: 'settings.open' }`, `:628` валидатор сообщений webview → хост.
- `src/shared/task.ts:293` `TaskCodeStateMessage`.

Настройки (эталон — булева `tasks.humanChanges`, пройти по всем её местам):
- `src/settings.ts:197` union `SettingKey`, `:243` `SETTING_KEYS`, `:308` тип значения, `:555` валидация,
  `:711` чтение со значением по умолчанию.
- `package.json:689` `agentura.tasks.humanChanges`; `package.nls.json:124`, `package.nls.ru.json:124`.
- `src/webview/components/Settings.tsx:390` строка в `IntegrationsRows` (раздел `integrations`);
  строки `I.humanChanges` в `src/webview/strings.ts:1218` и `src/webview/strings.en.ts:1199`.
- `src/webview/vscode.ts:96` `SETTINGS_SECTIONS`, `:221` проверка раздела; `Settings.tsx:693` `active`,
  `:713` `go(id)`; `src/webview/settingsStore.ts:23` `handleSettingsMessage`.

Webview вкладки:
- `src/webview/components/TaskCode.tsx` функция `How` (в конце файла) — попап.
- `src/webview/taskCodeView.ts:49` `howCommands(taskKey, repos)` — сейчас подставляет реальную базу и ветку первого
  репо; это и убираем.
- Строки попапа: `src/webview/strings.ts:200–212` (`howTitle` … `howCopy`) и то же в `strings.en.ts`.
- Тесты: `src/webview/taskCodeDom.test.ts` (describe «как ищем?», ~стр. 460), `src/webview/taskCodeView.test.ts`,
  тесты хоста `src/extension/jira/taskCode*.test.ts`, тесты настроек (`settingsDom.test.ts`, тесты `src/settings`).

## Уже решено, не переспрашивать

1. Две новые настройки, обе `boolean`, по умолчанию `true`, раздел UI «Интеграции» сразу после `tasks.humanChanges`:
   - `agentura.tasks.code.matchMessage` — искать ключ в сообщениях коммитов (все ветки).
   - `agentura.tasks.code.matchBranch` — искать ключ в именах веток и брать их коммиты сверх базы.
   Базу, дополнительные репозитории, лимит коммитов НЕ выносим.
2. Хост: `TaskCodeDeps.match(): { message: boolean; branch: boolean }` (в chatPanel читает конфиг через новый
   хелпер рядом с `taskSettings()` в `setup.ts`, `!== false`). `CodeCollectInput.match` того же типа, по
   умолчанию оба `true`. В `collectRepo`:
   - `message === false` — не запускать `log --all --grep`;
   - `branch === false` — не запускать `for-each-ref`, `branches: []`;
   - пометка «в базе»: при `message` — как сейчас (grep по базе); без `message` — для каждого sha
     `merge-base --is-ancestor <sha> <base>` (исключение `run` = не в базе);
   - оба выключены — только незакоммиченные правки агентов (`dirty`), без git log.
3. `TaskCodeStateMessage` получает `search?: { message: boolean; branch: boolean }` — значения, с которыми реально
   собран итог; хост кладёт его в каждый `task.code.state` (и в `loading`). Webview берёт значения для попапа отсюда,
   отсутствие поля = оба `true`.
4. Смена настроек: в `extension.ts` `onDidChangeConfiguration` — `if (e.affectsConfiguration('agentura.tasks.code'))
   ChatPanel.taskCodeSettingsChanged()`; он для каждой панели зовёт `taskTab.codeSettingsChanged()`, а тот —
   `this.deps.code?.refresh(this.key)` при наличии ключа (тихо, только если вкладка уже загружалась).
5. Попап «как ищем?» — общий текст, никаких реальных базы/ветки/имени репо. Содержимое (ru; en — перевод):
   - Заголовок прежний. Вступление: «Смотрим git-репозитории, в которых работали чаты задачи {KEY}. Коммит попадает
     в список, если:»
   - Пункт 1 (с отметкой вкл/выкл по `search.message`): «ключ {KEY} есть в сообщении коммита — в любой ветке,
     например „{KEY}: поправил вход“». Команда: `git log --all -i --grep={KEY}` (как сейчас, ключ в кавычках через
     `shq`).
   - Пункт 2 (по `search.branch`): «ключ есть в имени ветки, например feature/{KEY}, — тогда берём все коммиты этой
     ветки, которых ещё нет в базе, даже без ключа в сообщении». Команды: `git branch -a --list '*{KEY}*'` и
     `git log --oneline <база>..<ветка>` — буквально с плейсхолдерами `<база>` / `<ветка>` (en: `<base>` /
     `<branch>`).
   - Строка про базу: «База — ветка по умолчанию у origin (origin/HEAD), иначе develop, main или master.»
   - Выключенный пункт виден, но приглушён, с пометкой «выключено в настройках», команды у него не показываем.
   - Оба выключены — вместо правила-подсказки строка «Поиск по git выключен — видны только незакоммиченные правки
     агентов.»
   - Абзац про «не закоммичено» (`howDirty`) — без изменений. Правило в рамке (`rule`) — остаётся, но без «Agentura»:
     «…Иначе коммит не найдётся.»
   - Внизу ссылка-кнопка «настройки поиска →» (en «search settings →»): шлёт `{ type: 'settings.open', section:
     'integrations' }`.
   `howCommands` становится `howCommands(taskKey)` без `repos`; плейсхолдеры — из строк. Копирование команд
   (`task.code.copy`) остаётся.
6. Открытие настроек на разделе:
   - протокол: `{ type: 'settings.open'; section?: SettingsSection }`, валидатор пропускает только раздел из
     `SETTINGS_SECTIONS` (иначе поле отбрасывается, сообщение валидно);
   - `chatController` передаёт `section` в `deps.openSettings(section)`; chatPanel —
     `executeCommand('agentura.openSettings', section)`; команда передаёт его в `SettingsPanel.show(..., section)`;
   - `SettingsPanel`: панель открыта — `reveal()` + post `{ type: 'settings.section', section }`; новая — тот же post
     сразу после первого `settings.state` (найти, где панель шлёт стартовое состояние);
   - webview: `settings.section` в `handleSettingsMessage` → сигнал в `settingsStore`; `Settings.tsx` по нему
     зовёт `go(section)`. Тип сообщения хост → webview добавить в `ToWebview`.
   Вызов без раздела (карточка «claude не найден», сайдбар) работает как раньше.
7. Описание в `package.nls*.json` и строки настроек в UI (name/desc) — короткие, по образцу `humanChanges`, с `isNew`.

## Порядок

1. Настройки: `settings.ts`, `package.json`, `package.nls*.json`, строки и две `Row` с `Toggle` в `IntegrationsRows`.
2. Хост: `match` в `collectCode`/`collectRepo`, `search` в `task.code.state`, dep в chatPanel, перезагрузка по смене
   настроек.
3. `settings.open` с разделом: протокол → chatController → chatPanel → команда → `SettingsPanel` → webview настроек.
4. Попап: `howCommands(taskKey)`, новый `How`, строки ru/en, стиль приглушённого пункта и ссылки в
   `media/taskCode.css` (рядом с `.tcd .how`).
5. Тесты: хост — режимы «только сообщение», «только ветки», «оба выкл» (какие git-команды НЕ вызываются, что в
   итоге), пометка «в базе» без message; `search` в state; валидатор `settings.open` с разделом и с мусором;
   DOM попапа — нет реальной базы/ветки, плейсхолдеры есть, выключенный пункт приглушён, ссылка шлёт
   `settings.open` с `integrations`; DOM настроек — `settings.section` переключает раздел, новые тумблеры есть.
   Поправить существующие тесты, которые сломаются от смены `howCommands`.

## DoD

- `npm run typecheck && npm run lint && npm test && npm run build` — всё зелёное.
- `grep -n "repos\[0\]\|visibleBranches" src/webview/taskCodeView.ts` — `howCommands` больше не смотрит в репо.
- В попапе нет имени репо / реальной базы / реальной ветки (покрыто DOM-тестом).

## Не делать

- Не трогать раскладку диффа (0.17.1 только что сделан), не менять поиск сверх пунктов выше, не выносить в настройки
  базу/репо/лимит.
- Не менять версию, CHANGELOG, не собирать vsix — это приёмка.
- Чужие незакоммиченные файлы (`.codex/`, `AGENTS.md`) не трогать. Dev-процессы не запускать. «Заодно улучшить» — нет.
- Вопрос без ответа в промте — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы. Отчёт —
единственное, что увидит приёмка: без него работа потеряна.
