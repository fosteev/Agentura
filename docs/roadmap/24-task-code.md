# 24 · Вкладка «код» в полосе задачи

Запрос владельца 2026-10-14: во вкладке чата задачи рядом с «чат | задача» — вкладка со всеми изменениями по задаче.
Прототип: `prototype/screens/task-git.html#b` (выбран вариант **Б**), пояснялка — `#how`; галерея v48, раздел `#task-git`.
Дополнительно: дифф открывается **внутри этой же вкладки с ×**, как в `~/Projects/gitsprout`, а не в соседней вкладке
редактора; оттуда же — настройки шрифта и цветовой схемы диффа (без «auto»-темы и Google Fonts).

- [x] Сессия 1 (sonnet, high) — хост: сбор коммитов/веток/правок по задаче, патчи, протокол, тесты
- [x] Приёмка 1 (opus, plan-review) 2026-10-14 — `npm run check` зелёный (2023 теста), правки ниже
- [x] Сессия 2 (sonnet, high) — webview: вкладка «код», детали коммита, «как ищем?», встроенный дифф, README
- [x] Приёмка 2 (opus, plan-review) 2026-10-14 — `npm run check` зелёный (2053), кадры сцены `code` просмотрены, галерея v49 (`#task-git-real`)
- [ ] Сессия 3 (sonnet, high) — настройки диффа: шрифт, размер, палитра, подсветка
- [ ] Приёмка 3 (opus, plan-review), релиз 0.17.0

## Решения

1. **Где.** Третья вкладка полосы задачи: `чат | задача | код N` (N = коммиты + незакоммиченные файлы; пока не
   загружено — без числа). `PanelState.view` расширяется значением `'code'`. Вкладка широкая: композер и правая
   панель скрыты так же, как на «задаче».
2. **Репозитории.** Рабочие папки (`SessionInfo.cwd`, через `sessions.list()`) всех чатов группы задачи
   (`taskGroups.group(key).sessions`); чат без cwd — cwd вкладки. Для каждой папки — `git.reposFor(cwd)` (vscode.git
   API), дедуп по корню. Нет git API — состояние с ошибкой «Git недоступен».
3. **База.** `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` (→ `origin/develop`); нет — первая из
   `develop`, `main`, `master`, `origin/develop`, `origin/main`, `origin/master`, для которой
   `git rev-parse --verify --quiet <ref>` успешен. Нет базы — ветки показываются без «сверх базы» (только коммиты по ключу).
4. **Ключ в тексте** — регулярка `KEYRE = (^|[^A-Za-z0-9])<KEY>([^0-9]|$)` без учёта регистра (чтобы `GARM-87` не
   ловил `GARM-870`). Ключ задачи — `[A-Z][A-Z0-9_]*-\d+`, экранировать нечего.
5. **Коммиты по ключу:** `git log --all -i -E --grep=<KEYRE> -n 200 --format=%H%x1f%h%x1f%an%x1f%at%x1f%s`.
   Метка источника `key`.
6. **Ветки задачи:** `git for-each-ref --format=%(refname:short) refs/heads refs/remotes`, фильтр `KEYRE` по имени,
   без `*/HEAD`; есть локальная и `origin/<то же>` — берём локальную. Коммиты ветки сверх базы:
   `git log <base>..<branch> -n 200 --format=…` (тот же формат); не найденные по ключу — метка `branch`.
   Итог ветки: `git diff --numstat -M <base>...<branch>` + `--name-status` → файлы и ±, `ahead` = число коммитов.
7. **Статусы коммита:** «↑ локально» — sha в выводе `git rev-list <shas…> --not --remotes` (пересечь с нашими);
   «в <база>» — sha в `git log <base> -i -E --grep=<KEYRE> -n 200 --format=%H`. Коммиты сортируются по времени, новые сверху.
8. **Незакоммиченное = правки агентов.** Пути из истории всех чатов группы: `adapterFor(provider).loadHistory(id, cwd)`
   → события `tool.start` с `name ∈ {Edit, MultiEdit, Write, NotebookEdit}` и `input.file_path` (у всех трёх движков
   правки нормализованы в эти имена; относительный путь — от cwd чата). Пересечь с `git status --porcelain=v1 -z`
   репозитория (`-uall`); ± — `git diff --numstat HEAD -- <path>`, у неотслеживаемого — число строк файла.
   У файла — список чатов, которые его правили (метка движка `mk` + название чата в тултипе; клик — `task.openChat`).
   Номеров «Чат N» в коде нет — **не вводим**. Правки руками, без агента, сюда не попадают — это сказано в «как ищем?».
9. **Чат у коммита — не показываем** (в прототипе был номер чата; надёжно сопоставить коммит с чатом нечем).
   У коммита: хэш, тема, автор, время, метка `ключ`/`ветка`, «↑ локально» / «в develop».
10. **Детали коммита справа:** файлы `git show --format= --name-status -M <sha>` + `--numstat`; кнопки «дифф
    коммита» (встроенный дифф по первому файлу, j/k — по остальным), «в чат ↳» (в поле ввода: `<short> <тема>`
    + имя репо, через `prefill`), «копировать хэш» (`vscode.env.clipboard`, полный sha).
11. **Встроенный дифф** — порт gitsprout: `parsePatch` (`src/git/parse.ts:249-290`, типы `FilePatch/Hunk/PatchLine`
    из `src/git/types.ts`, кап 10 000 строк) на хосте; рендер `webview/render.ts:401-495` (inline + split) и
    `webview/highlight.ts` (highlight.js 11, core + языки как там) в webview. Патчи:
    - файл коммита: `git diff --no-color --no-ext-diff -M <sha>^ <sha> -- <path>`; корневой коммит —
      `git diff-tree -p --no-color --root -M <sha> -- <path>`;
    - файл ветки: `git diff --no-color --no-ext-diff -M <base>...<branch> -- <path>`;
    - незакоммиченный: `git diff --no-color --no-ext-diff HEAD -- <path>`; неотслеживаемый — патч собирается на хосте
      из содержимого файла (все строки `+`), без `--no-index`.
    Дифф занимает место списка вкладки «код» (список остаётся смонтированным и прячется — скролл не теряется).
    Шапка: путь, ±, «файл i / N», переключатель inline | split (запоминается в `PanelState`), ×. Закрытие — ×
    и Esc; j/k — следующий/предыдущий файл набора. Устаревшие ответы отсекаются счётчиком `req`.
12. **Обновление:** загрузка при первом открытии вкладки «код» и по ↻; после `turn.result` своей вкладки — тихая
    перезагрузка, если «код» уже загружался. Живого слежения за git нет.
13. **«Как ищем?»** — всплывашка по ссылке в шапке вкладки: текст по кадру `#how`, но команды **настоящие** с ключом
    задачи и базой репо (п. 5, 6 — в упрощённом виде для человека: `git log --all -i --grep='<KEY>'`,
    `git branch -a --list '*<KEY>*'`, `git log --oneline <base>..<branch>`), «копировать» у каждой; правило
    «ключ в сообщении или в имени ветки»; «незакоммиченное — только правки агентов в чатах задачи». Та же пояснялка —
    раздел в README.md (EN) и README.ru.md.
14. **Настройки диффа** (сессия 3): `agentura.diff.syntaxHighlighting` (bool, true), `agentura.diff.highlightTheme`
    (`simple | github | one`, по умолчанию `github`; у каждой палитры светлый и тёмный вариант — `tokens.css`
    gitsprout без блока `auto`), `agentura.diff.fontSize` (целое 0…40, 0 — размер `agentura.feed.fontSize`).
    Семейство шрифта — уже существующий `agentura.font.code` (переменная `--mono`), новой настройки нет.
    Применение — через сообщение `appearance` и CSS-переменные на `:root` (`appearance.ts`), CSP без `unsafe-inline`.
15. Не делаем: auto-тему из активной темы VS Code, Google Fonts, слежение за git, MR/GitLab, удаление/откат файлов,
    коммит из вкладки «код» (для этого есть вкладка «git»).

## Решения приёмки 1 (2026-10-14)

- Модули: `src/extension/jira/taskCode.ts` (разборщики, `collectCode`, `commitFiles`, `codePatch`, класс `TaskCode`),
  `src/shared/patch.ts` (`parsePatch`, `FilePatch`), типы и валидаторы `Code*` / `task.code.*` — `src/shared/task.ts`;
  `GitService.rootsFor(cwd)` (грузит API, ждёт инициализации до 5 с; git недоступен — исключение с локализованным
  текстом, а не `undefined` — принято).
- Файлы коммита — `git diff --name-status/--numstat -z -M <sha>^ <sha>` (корневой — `diff-tree --root`), не `git show`:
  у мерж-коммита `show` пуст, а так список совпадает с патчем п. 11. `TaskCodeCommitMessage` получил `error?`.
- Исправлено на приёмке: дифф ветки принимается, только если `base`/`branch` есть в последнем итоге этого репо
  (не произвольный ref из webview); без remote «↑ локально» не ставится и `rev-list` не запускается (иначе выдал бы
  всю историю); история чатов кэшируется в `TaskCode` по `id + updatedAt` (только события правок) — тихая
  перезагрузка после хода не перечитывает транскрипты; большой/нечитаемый неотслеживаемый файл → патч
  `{ truncated: true, hunks: [] }` вместо английской ошибки.
- Ветка без базы или без общей истории приходит с `ahead: 0, files: []`. **UI (сессия 2):** при известной базе ветки с
  `ahead: 0` (уже влиты) не показывать; без базы — только имя ветки.
- Ошибки хоста — текст stderr git (английский, как есть); фиксированных английских строк к пользователю больше нет
  (`Bad task key` практически недостижим).
- Риски: `loadHistory` Codex может поднять процесс движка (ошибка проглатывается — правок чата нет); потолок 200
  коммитов на запрос.

## Решения приёмки 2 (2026-10-14)

- Webview: `src/webview/components/TaskCode.tsx` (список, детали, дифф, «как ищем?»), чистая логика —
  `taskCodeView.ts`, рендер диффа — `diffView.ts` + `highlight.ts` (highlight.js 11, devDependency) + `escHtml.ts`;
  стили `media/taskCode.css`. Палитра пока одна (`github`) и висит на `.tcd` — сессия 3 переводит на `data-hl-theme`.
- Ответ диффа принимается только с текущим `req` (состояние компонента), иначе «загрузка» — принято.
- Esc ловится на `window` в capture-фазе со `stopPropagation`, только пока открыт дифф или «как ищем?»: иначе общий
  обработчик чата остановил бы ход. Без диффа Esc по-прежнему останавливает ход (тест).
- Несколько веток задачи в одном репо: первая — в шапке репо, остальные — строками под ней.
- Сцена скриншотов: `TASK_SHOTS_DIR=… node scripts/readme-shots/run.mjs code` → `task-real-code-<list|diff|how>-<тема>.png`.
- Проверить глазами (владелец): живой репо с веткой задачи — коммиты/метки/«↑ локально»; незакоммиченные правки
  агента; дифф ×/Esc/j/k/inline|split; «копировать» в «как ищем?».

## Промты

### Сессия 1

```
Сессия 1 — вкладка «код» задачи: хост · Модель: sonnet, effort: high

Работаем в /Users/fost/Projects/Agentura (ветка main, не переключать). Задача: на хосте собрать для задачи
вкладки чата коммиты по ключу, ветки задачи, незакоммиченные правки агентов и патчи файлов; отдать в webview по
новому протоколу `task.code*`. Webview в этой сессии НЕ трогаем (кроме типов в src/shared и src/protocol.ts).

Читай: docs/roadmap/24-task-code.md — раздел «Решения» это спека (п. 2–12; команды git там дословно).
Правила репо: AGENTS.md в корне.
Точки входа:
- src/extension/jira/taskTab.ts:19-45 TaskTabDeps, :112 handle(m) switch, :185 onAgentEvent (turn.result) —
  сюда кейсы `task.code.*` и тихая перезагрузка (п. 12). post (строка 31) — расширить тип.
- src/extension/chatPanel.ts:836-850 — создание TaskTab (добавить deps для кода); :984-1000 pushTaskChats — эталон
  «группа × строки сессий»; :634 adapterFor(provider) — адаптеры для loadHistory; services.git — GitService.
- src/extension/taskGroups.ts:195 group(taskKey) → sessions: SessionRef[]; :285 taskSessionRows — эталон join.
- src/extension/sessionsService.ts:338 list(): SessionRow[] (есть cwd?).
- src/agent/types.ts:619 loadHistory(sessionId, cwd, opts); :216 событие tool.start {name, input}.
- src/extension/git/gitService.ts:308 reposFor(cwd) (работает только после загрузки api — :235 ensure, :239 load:
  добавить публичный async-метод, который грузит api и отдаёт { gitPath, reposFor } или undefined);
  :849 runGit(gitPath, args, cwd); :138 parseNumstat — переиспользовать.
- src/shared/task.ts:226-248 TaskRequest/isTaskRequest; :171 TaskStateMessage — образец сообщения хоста.
- src/protocol.ts: ToWebview (~324-329 task.*), FROM_WEBVIEW_TYPES (~634-643), FIELD_CHECKS (~676-712);
  тесты src/protocol.test.ts:88-104 — образец.
- Порт из ~/Projects/gitsprout: src/git/parse.ts:249-290 parsePatch, src/git/types.ts (FilePatch, Hunk, PatchLine).
Точки входа проверены при планировании — не перечитывать ради подтверждения, открывать только нужный фрагмент.

Уже решено, не переспрашивать:
- Новый модуль src/extension/jira/taskCode.ts: чистые функции разбора вывода git (log с %x1f, for-each-ref,
  name-status+numstat, status -z, фильтр веток по KEYRE, сборка патча неотслеживаемого файла) + класс/функция
  сборщика с зависимостями run(args, cwd), repos(cwd), history(ref) — чтобы тестировалось без vscode и git.
  parsePatch и типы патча — src/shared/patch.ts (их импортирует и webview в сессии 2).
- Протокол (типы в src/shared/task.ts):
  webview→host: `task.code.load {force?: boolean}`, `task.code.commit {root, sha}`,
  `task.code.diff {req: number, root, target}` где target = {kind:'commit', sha, path} | {kind:'branch', base,
  branch, path} | {kind:'wip', path}, `task.code.prefill {text}` (≤ 2000), `task.code.copy {text}` (≤ 200).
  host→webview: `task.code.state {taskKey, loading?: true, error?: string, repos: CodeRepo[]}`,
  `task.code.commit {root, sha, files: CodeFile[]}`, `task.code.diff {req, patch?: FilePatch, error?: string}`.
  CodeRepo {root, name, base?, branches: CodeBranch[], commits: CodeCommit[], dirty: CodeDirty[], error?}.
  CodeBranch {name, ahead, add, del, files: CodeFile[]}. CodeCommit {sha, short, subject, author, at (мс),
  src: 'key'|'branch', branch?, unpushed?: true, inBase?: true}. CodeFile {path, status: 'M'|'A'|'D'|'R'|'T',
  from?, add?, del?, binary?: true}. CodeDirty = CodeFile + chats: {id, provider?, title}[].
  Валидация в FIELD_CHECKS: строки ограничены по длине, root/sha/path — непустые строки, sha `^[0-9a-f]{4,40}$`,
  base/branch не начинаются с '-'; path не абсолютный и без '..' сегментов. Хост дополнительно проверяет, что root —
  один из корней последнего task.code.state (иначе игнор).
- Все команды git — массивом аргументов через runGit (никакого shell); пути после `--`.
- Ошибка одного репо → CodeRepo.error, остальные репо показываются.
- Перед cwd без git-репо — пропуск без ошибки.

Порядок:
1. src/shared/patch.ts (порт parsePatch + типы) + тест на 2–3 патча (обычный, переименование, бинарный).
2. src/extension/jira/taskCode.ts + taskCode.test.ts: разборщики и сборщик на заглушках run/history
   (KEYRE: GARM-87 не матчит GARM-870; ветка только по имени → метка branch; локальная vs origin; unpushed/inBase;
   правки агентов ∩ status; относительный путь из истории от cwd чата; неотслеживаемый файл → патч из содержимого).
3. Типы и валидаторы протокола + protocol.test.ts (валидные/невалидные task.code.*).
4. Проводка: GitService (публичная загрузка api), TaskTab.handle кейсы task.code.*, deps из chatPanel
   (sessions.list, taskGroups.group, adapterFor, git, prefill, clipboard), перезагрузка после turn.result.
5. npm run check.

DoD: `npm run check` зелёный; новые тесты покрывают п. 4–8, 10–11 «Решений»; в webview ничего не рендерится
(сообщения task.code.* просто доходят — проверка тестами).

Не делать: webview-компоненты, строки UI, настройки, README — это сессии 2 и 3; не трогать вкладку «git» и
diff.changes; чужие незакоммиченные файлы (.codex/, AGENTS.md, prototype/screens/task-git.html) не трогать;
«заодно улучшить» — нет. Вопрос без ответа в промте — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
Отчёт — единственное, что увидит приёмка: без него работа потеряна.
```

### Сессия 2

```
Сессия 2 — вкладка «код» задачи: webview и встроенный дифф · Модель: sonnet, effort: high · после приёмки 1

Работаем в /Users/fost/Projects/Agentura (ветка main, не переключать). Задача: нарисовать вкладку «код» по
прототипу prototype/screens/task-git.html#b поверх протокола task.code.* из сессии 1, встроенный дифф по образцу
gitsprout (внутри вкладки, ×/Esc/j/k, inline|split), всплывашку «как ищем?» и раздел README.

Читай: docs/roadmap/24-task-code.md («Решения» п. 1, 8–13 и «Решения приёмки 1» — там контракт хоста по факту); прототип —
prototype/screens/task-git.html (функции codeTab() и howBox(), CSS-блок «Б» и «.how») — вёрстку и классы брать
оттуда. Правила репо: AGENTS.md.
Точки входа:
- src/webview/components/TaskPane.tsx:110-170 TaskStrip (view: 'chat'|'task' → + 'code', кнопка vtab-code с числом).
- src/webview/components/Chat.tsx:294 вычисление view, :405-408 showView, :528 <TaskStrip>, :802-817 <TaskView>
  (рядом смонтировать <TaskCode hidden={view !== 'code'}>), data-view скрывает композер/панель — проверить для 'code'.
- src/webview/vscode.ts:42-44 PanelState.view, :154 readPanel (принять 'code'); добавить diffMode: 'inline'|'split'.
- src/webview/store.ts:557-570 обработка task.state / task.chats — рядом task.code.state/commit/diff → сигналы.
- src/webview/strings.ts:25-142 и strings.en.ts:21-138 блок task — новые строки (паритет проверяет strings.test.ts).
- Порт из ~/Projects/gitsprout: webview/render.ts:401-495 (diffBarHtml, diffBodyHtml, hunkSides, inlineRowsHtml,
  splitRowsHtml) и webview/highlight.ts (languageFor, highlightLines), webview/diff.css; esc из webview/format.ts.
  Логика открытия/закрытия — webview/main.ts:339-510 (openDiff :424, closeDiff :436-446, stepDiff, Esc :988).
- Тесты-эталоны webview: src/webview/sessionsDom.test.ts, src/shared/taskTab.test.ts.
- Сцена скриншотов: scripts/readme-shots/run.mjs:176-243 (taskJobs), data.mjs:203-285 — добавить сцену `code`.
Точки входа проверены при планировании — не перечитывать ради подтверждения.

Уже решено, не переспрашивать:
- Новые файлы: src/webview/components/TaskCode.tsx (список + детали + «как ищем?»), src/webview/diffView.ts
  (строковый рендер из gitsprout, экранирует сам; вставка через dangerouslySetInnerHTML), src/webview/highlight.ts,
  media/taskCode.css (или файл стилей, куда подключаются стили задачи — по образцу tasks), highlight.js@^11 в
  devDependencies (бандлится esbuild, import из 'highlight.js/lib/core' + языки как в gitsprout).
- CSP без unsafe-inline: никаких style="" в HTML-строках диффа; динамика — классы или el.style/CSSOM.
- Открытие вкладки «код» шлёт task.code.load (первый раз и по ↻); пока loading — скелет «загрузка…».
- Клик по коммиту → task.code.commit, детали справа (п. 10). Клик по файлу коммита/ветки/незакоммиченного или
  «дифф коммита» / «дифф ветки» → встроенный дифф по набору файлов этого объекта (j/k по набору).
- Палитра подсветки в этой сессии одна — `github` из tokens.css gitsprout (светлая/тёмная по body.vscode-light);
  настройки — сессия 3.
- «как ищем?» — команды с подставленным ключом и базой первого репо; «копировать» → task.code.copy.
- Контракт хоста готов (сессия 1): типы Code*, TaskCode*Message, CodeDiffTarget, FilePatch — src/shared/task.ts и
  src/shared/patch.ts; хост на ветку отвечает только если base/branch из state. Патч `truncated: true` без строк —
  показать «файл слишком большой» (строка UI). Ветки с ahead 0 при известной base не показывать.
- README.md (EN) и README.ru.md: короткий раздел «Task code tab / Вкладка «код»» — что показывает и три команды
  поиска (как в «как ищем?», с примером ключа), правило про ключ в сообщении/ветке.

Порядок:
1. Порт diffView.ts + highlight.ts + тесты рендера (inline/split, экранирование <script> в строке кода).
2. TaskStrip/PanelState/store/strings для 'code'.
3. TaskCode.tsx по прототипу #b, встроенный дифф с ×/Esc/j/k/inline|split, «как ищем?».
4. Тесты DOM: вкладка «код» рендерит репо, коммиты с метками, незакоммиченные с чатами; × и Esc закрывают дифф
   и список на месте.
5. Сцена `node scripts/readme-shots/run.mjs code` (кадры code-list, code-diff, code-how в TASK_SHOTS_DIR).
6. README.md / README.ru.md.
7. npm run check.

DoD: `npm run check` зелёный; `npm run build && node scripts/readme-shots/run.mjs code` даёт 3 кадра × 2 темы.

Не делать: настройки шрифта/палитры (сессия 3), auto-тему, Google Fonts, изменения хоста кроме мелких правок
протокола (если нужны — в отчёт с причиной); вкладку «git» и «изменения» не трогать; чужие незакоммиченные
файлы не трогать. Вопрос без ответа — в отчёт.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

### Сессия 3

```
Сессия 3 — настройки встроенного диффа · Модель: sonnet, effort: high · после приёмки 2

Работаем в /Users/fost/Projects/Agentura (ветка main). Задача: настройки шрифта и цветовой схемы встроенного
диффа вкладки «код» (п. 14 «Решений» docs/roadmap/24-task-code.md), по образцу gitsprout без auto-темы и шрифтов Google.

Читай: docs/roadmap/24-task-code.md (п. 14, «Решения приёмки 2»). Правила репо: AGENTS.md.
Точки входа:
- Цепочка настройки по образцу git.hideClean: src/settings.ts (SettingKey ~192, список ~235, типы ~300,
  валидатор ~523, чтение ~672); package.json contributes.configuration (рядом agentura.font.* ~583-610) и
  package.nls.json / package.nls.ru.json; страница настроек src/webview/components/Settings.tsx (~1104 feed.fontSize,
  ~1121 font.interface — сюда же строки диффа), строки страницы strings.ts/strings.en.ts.
- Сообщение appearance и CSS-переменные: src/webview/appearance.ts:6-30 (appearanceVars, --mono от font.code);
  где хост собирает appearance — найти grep "type: 'appearance'" в src/extension.
- Порт из ~/Projects/gitsprout: webview/diffStyle.ts (applyDiffStyle — CSSOM), webview/tokens.css (блоки simple,
  github, one со светлыми вариантами; блок auto НЕ переносить), package.json ключи gitsprout.diff.*.

Уже решено: ключи agentura.diff.syntaxHighlighting / highlightTheme (simple|github|one, default github) /
fontSize (0…40, 0 = agentura.feed.fontSize); семейство — agentura.font.code; применяется живьём через appearance
(body[data-hl-theme], --diff-size); syntaxHighlighting=false — дифф без подсветки (только +/− фон).

DoD: `npm run check` зелёный; тест appearance на новые переменные; смена настройки живьём меняет дифф (тест на
appearance → атрибут/переменная).

Не делать: auto-тему, Google Fonts, другие настройки. Не коммитить, не пушить.
Последним сообщением — отчёт: сделано / отклонения / не проверено / открытые вопросы.
```
