# 23 · Архив чатов в боковой панели

Запрос владельца 2026-10-13: «как у Claude — архивировать чаты». Архив = скрыть из основного списка с возвратом,
не удаление. Связь «чат → архив» — наша надстройка, как группы задач (`agentura.taskGroups`): движки о ней не знают,
файлы сессий не трогаются. Сопутствующее (уже в main, `a6c3184`): заголовок «Задачи · N» сворачивает все группы.

- [x] Сессия 1 (sonnet, high) — хранилище, команды, сайдбар, тесты
- [x] Приёмка (opus, plan-review) 2026-10-13 — проверки зелёные (1989 тестов), рендер в галерею v46 (`#archive-real`)
- [ ] Ручная проверка владельцем в живом VS Code → коммит, CHANGELOG, версия 0.16.0

## Решения

- Хранилище: `workspaceState`, ключ `agentura.archivedSessions` — `string[]` id сессий (новые в конце).
  Удаления нет вообще. Codex native `thread/archive` — не трогаем (его архивные сервер и так не отдаёт).
- Архивный чат в группе задачи остаётся привязанным (`taskGroups` не трогаем), но из группы/карточки задачи и
  счётчиков пропадает; все чаты задачи в архиве → группы нет. Вернул из архива — снова в группе.
- В списке: архивные убраны из всех мест (группы, «Без задачи», список по дням, карточки секции) и собраны в блок
  «Архив · N» в самом низу списка; блок по умолчанию **свёрнут**; при поиске раскрыт и показывает найденные архивные.
- Действия: контекстное меню строки — «В архив» / «Вернуть из архива». После архивирования — информационное
  сообщение VS Code с кнопкой «Отменить». Открытая вкладка архивного чата не закрывается; авто-разархивирования
  при новом сообщении нет.

## Решения приёмки (2026-10-13)

- Отступ вложенных строк архива в списке без задач: правило `.s.nest` было только под `.sidebar[data-tasks]` →
  `.sidebar:is([data-tasks], :has(.tgp.arch))`; плюс своя черта над `.tgp.arch` (в списке по дням `.tgp + .tgp` нет).
- Метки движков (`mixedProviders`) — по всем строкам, а не по активным: иначе Codex-чат в архиве терял метку,
  если активных Codex-чатов нет.
- Сцена скриншотов: `ARCHIVE_SHOTS_DIR=… node scripts/readme-shots/run.mjs archive` → `archive-real-<groups|groups-open|plain-open>-<тема>.png`.
- Нестабильные под нагрузкой `sessionsService.test.ts` / `engineLimits.test.ts` — падают и на чистом main, к архиву
  не относятся; в полном прогоне приёмки зелёные.

## Промты

### Сессия 1

```
Сессия 1 — архив чатов в боковой панели Agentura · Модель: sonnet, effort: high

Работаем в /Users/fost/Projects/Agentura (ветка main, не переключать). Задача: дать архивировать чат из боковой
панели — скрыть из основного списка в свёрнутый блок «Архив» внизу и вернуть обратно. Стройка с нуля по эталону
групп задач.

Читай: docs/roadmap/23-archive.md (раздел «Решения» — это спека). Правила репо: CLAUDE.md, AGENTS.md в корне,
если есть.
Точки входа:
- src/extension/taskGroups.ts:142-260 — эталон хранилища в workspaceState (MementoLike, onChange, save).
- src/extension/extension.ts:68 — где создаётся TaskGroups; :114 — SidebarProvider получает его; :138 — services.
- src/extension/sidebarView.ts:100 — подписка onChange → pushSessions; :128-141 pushSessions (decorateSessions).
- src/extension/taskCommands.ts:95-112 (unbind) и :170-174 (регистрация) — эталон команды из контекстного меню
  (sessionIdOf(arg) из ./taskLink); строки хоста — src/shared/l10n.ts (taskUnbound: :78 ru, :307 en).
- package.json:82-90 (contributes.commands), :178-190 (menus.webview/context), commandPalette рядом;
  package.nls.json / package.nls.ru.json — заголовки команд.
- src/protocol.ts:526-541 — SessionSummary (добавить `archived?: true`).
- src/webview/components/Sidebar.tsx: :210-218 data-vscode-context строки (добавить sessionArchived);
  SidebarView (~:540) — раскладка; блок «Без задачи» с FREE_FOLD — эталон для блока «Архив»; список по дням
  (ветка без групп) — ниже; секция «Задачи» (asSection) — выше.
- src/webview/vscode.ts:193-202 — taskFold (readTaskFold/saveTaskFold).
- src/webview/strings.ts:1307 / strings.en.ts:1288 — ui.sidebar.tasks.* (добавить archive: 'Архив' / 'Archive').
- Тесты-эталоны: src/webview/sessionsDom.test.ts (describe «задачи Jira», тест «строка сессии несёт контекст меню»),
  src/extension/taskGroups.test.ts.
Точки входа и эталоны проверены при планировании — не перечитывать их ради подтверждения, открывать только
фрагмент, который правишь.

Уже решено, не переспрашивать:
- Новый файл src/extension/archive.ts: класс ArchivedSessions(state: MementoLike) — ключ 'agentura.archivedSessions',
  ids(): ReadonlySet<string>, has(id), add(id), remove(id), onChange(listener) — как в TaskGroups. Без миграций.
- Создать в extension.ts рядом с TaskGroups, передать в SidebarProvider (новый параметр конструктора после
  taskGroups) и в объект services там, где taskGroups.
- pushSessions: метки задач (`task` у строки) — из decorateSessions по всем строкам; `tasks` (группы) — из
  decorateSessions по НЕархивным строкам; архивным строкам проставить `archived: true`. Подписка onChange архива →
  pushSessions.
- Команды 'agentura.archiveSession' / 'agentura.unarchiveSession' (новый файл src/extension/archiveCommands.ts по
  образцу taskCommands, регистрация там же, где registerTaskCommands). Аргумент — контекст строки, id через
  sessionIdOf(arg); без id — молча return. archive: add + showInformationMessage(l10n archived, кнопка l10n undo) →
  по кнопке remove. unarchive: remove + showInformationMessage(l10n unarchived). Строки ru/en в src/shared/l10n.ts.
- package.json: обе команды в commands (category Agentura, title через %command.archiveSession.title% /
  %command.unarchiveSession.title%; ru «В архив» / «Вернуть из архива», en «Archive» / «Unarchive»); в
  webview/context — when `webviewId == 'agentura.sidebar' && webviewSection == 'session' && !sessionArchived` /
  `... && sessionArchived`, group "archive@1"; в commandPalette — обе с when "false".
- Webview: data-vscode-context строки + `sessionArchived: !!s.archived`. В SidebarView разделить data.sessions на
  active / archived в самом начале; всё существующее (groupByDay, taskLayout, filterSessions, mixedProviders,
  карточки секции) считать по active, чтобы прежнее поведение не изменилось. Блок «Архив» — последним в `.list` в
  обоих ветках (группы и список по дням), только если archived.length > 0 (при поиске — если есть найденные
  архивные): разметка как у «Без задачи» (`div.tgp.none.arch` > `div.tg-h.nokey` со стрелкой `i.tw`, `button.kp.hit`
  c `<b>Архив</b>` и aria-expanded, `span.cn` с числом), внутри — SessionRow с nest, деление по дням как в
  «Без задачи». По умолчанию свёрнут: ключ в taskFold '-archive-open' = раскрыт (инверсия к остальным ключам);
  при поиске раскрыт всегда, клик при поиске ничего не делает (как у «Без задачи»). Текущий чат в свёрнутом
  архиве — класс sel на блоке (как у «Задачи»).
- Пустой список: если активных нет, а архивные есть — вместо «нет сессий» ничего не писать, блок «Архив» на месте.
- Превью в настройках (settingsDom) не трогать: фикстура без архивных.
- CSS: только если без правок блок выглядит не так, как «Без задачи»; правки — media/tasks.css.

Порядок:
1. archive.ts + тест src/extension/archive.test.ts (add/remove/has/onChange, дубль add не дублирует).
2. Протокол, sidebarView.pushSessions, extension.ts, archiveCommands.ts, l10n, package.json/nls.
3. Sidebar.tsx: разделение active/archived, блок «Архив», контекст строки, строки ru/en.
4. Тесты в sessionsDom.test.ts: (а) архивная строка ушла из группы и «Без задачи», блок «Архив · 1» свёрнут,
   клик раскрывает, saveTaskFold получил '-archive-open'; (б) все чаты задачи в архиве → группы нет; (в) поиск
   находит архивный, блок раскрыт; (г) контекст строки: sessionArchived false/true; (д) режим без задач (список
   по дням) — архивный внизу в блоке. Тест pushSessions, если у sidebarView есть тестовый файл; нет — не заводить.

DoD: архивирование/разархивирование из контекстного меню работает по коду (команды, when, контекст строки,
pushSessions); все проверки зелёные. Проверка: `npm run typecheck`, `npx eslint .`, `npx vitest run`,
`npm run build` — вывод в файл, в контекст только хвост и FAIL/error.

Не делать: удаление сессий и файлов; изменения в TaskGroups/decorateSessions сигнатур; Codex thread/archive;
правки prototype/, README, CHANGELOG, версии; «заодно улучшить» — нет. Чужие незакоммиченные файлы (.codex/,
AGENTS.md) не трогать. Вопрос, на который нет ответа в промте, — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка. Отметить галочку «Сессия 1» в docs/roadmap/23-archive.md только
после зелёных проверок.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы. Отчёт —
единственное, что увидит приёмка: без него работа потеряна.
```
