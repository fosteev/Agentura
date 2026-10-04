# Вкладка «git»: рабочее дерево, индекс, коммит — один репозиторий и три раскладки для нескольких

> Статус: в работе · создан 2026-10-04 по запросу владельца («реализуем все варианты с возможностью выбора»).
> Прототип: `prototype/screens/git-pane.html#one|one-tree|ma|mb|mc`, `prototype/shared/git.css`, `prototype/shared/git.js`
> (разметку собирает скрипт — это и есть эталон DOM); галерея — раздел «Вкладка «git»: варианты» (артефакт v29, `#git`).
> Дизайн владелец принимает картинками в галерее. Исполнитель отмечает чекбоксы этого файла по ходу работы.
> Строки кода — по разведке 2026-10-04, перед правкой сверять.

## Цель

Третья вкладка правой панели чата: `изменения | git | агенты`. Показывает рабочее дерево по git (а не по ленте): файлы
вне индекса и в индексе со статусом и +/−, ветку, ↓/↑ против upstream, последние коммиты; действия — в индекс / из
индекса / отменить изменения / открыть дифф, коммит (amend, «и push»), fetch / pull / push, смена ветки. Файлы, которые
правил агент в этой сессии, помечены точкой (●), чип «● агент N» фильтрует только их. Если в рабочей папке несколько
репозиториев, раскладку выбирает настройка `agentura.git.layout`: `stack` (А, стопка, по умолчанию) · `picker`
(Б, выбор сверху) · `unified` (В, общий список, один коммит в несколько репо). Кнопка ✦ в поле коммита — сообщение
пишет агент по индексу.

## Что есть сейчас (разведка 2026-10-04)

- Git в расширении — только `git check-ignore` (`src/extension/workspaceFiles.ts:16`). API встроенного `vscode.git` не
  используется, `git.d.ts` нет, `extensionDependencies` в `package.json` нет. `engines.vscode` — `^1.138.0`.
- Рабочая папка чата — только `workspaceFolders[0]` (`src/extension/chatPanel.ts:150,262`), multi-root нет.
- Сервисы чата — `ChatServices` (`chatPanel.ts:63`), собираются в `extension.ts:96`. Эталон «сервис → все панели»:
  `services.usage.onUpdate` / `services.sessions.onChange` → `postToWebview` (`chatPanel.ts:425-440`). Сообщения webview
  идут в `this.controller.handle(m)` (`chatPanel.ts:~419`).
- Протокол: `ToWebview` (`src/protocol.ts:122`), `FromWebview` (`:247`), исчерпывающий `FROM_WEBVIEW_TYPES`
  (`:~388-436`), валидаторы по типу (`:~448`).
- Дифф: `DiffDocuments` (`src/extension/diffDocuments.ts`) — только строки в памяти (`agentura-diff:`); для git нужен
  `vscode.diff` над `api.toGitUri(...)` и файлом.
- Вкладки панели: `Tab` (`src/webview/components/Hud.tsx:8`), вкладки шапки `Hud.tsx:61-74`; `PanelState.tab`
  (`src/webview/vscode.ts:26`) + белый список в `readPanel` (`:104-105`); `Chat.tsx`: `panelTab`/`panelItems`
  (`:293-309`), иконки `ICON_CHANGES`/`ICON_AGENTS` (`:90-110`), `<aside class="pane side" data-active>` (`:430-455`),
  монтирование `ChangesPane`/`AgentsPane` (`:508-530`), свёрнутая полоса `.rail` (`:533-560`); панели — `SidePanes.tsx`
  (`role="tabpanel"`, `labelledBy`); показ — `media/hud.css:68`; строки `tabs` — `strings.ts:16`/`strings.en.ts:13`.
  Переключатели внутри вкладки хранятся в `PanelState` (эталон — `changes`, `agScope`).
- Список правок агента — чистая `changesView(...)` (`src/webview/changesView.ts:116`), пути относительно cwd.
- Эталон настройки-вида — `agentura.agents.view`: `package.json:277-294` (+ команда `:97`), `package.nls*.json:10,41-46`,
  `src/settings.ts:43-48,79,101,132,177,335,357,383`, `protocol.ts:22,167-168` (`chat.info.agentsView`),
  `chatController.ts:46,82-83,236`, `chatPanel.ts:15,277`, команда `extension.ts:145-162,237`, перепуск при смене
  конфигурации `extension.ts:224`, `l10n.ts:18,35,118,135`, `store.ts:115-116,214`, `Chat.tsx:310` (`data-agents`),
  `Settings.tsx:719-729` (`ChoiceCards`), `SettingsPreview.tsx:~295`, `strings.ts:677`/`strings.en.ts:662`.
- CSS webview — `media/*.css`, список в `webviewHost.ts:55-70`; `--add`/`--del` уже из `gitDecoration` (`media/tokens.css:42-43,74-75`).
- Тесты: vitest, `*Dom.test.ts` на jsdom, `vscode` мокается в файле (`vi.mock('vscode', …)`, эталон
  `src/extension/diffDocuments.test.ts:5`). `npm run check` = typecheck + lint + vitest + build.
- Одноразового запроса к модели нет: адаптер держит одну живую `query()` на сессию (`src/agent/claude/adapter.ts:448`);
  временная `query()` без хода — `accountInfo` (`adapter.ts:332`), эталон обвязки (таймаут, `close`, `abort`).

## Решения (2026-10-04, при планировании)

- **Движок — API встроенного расширения `vscode.git`, не свой `spawn('git')`.** Плюсы: репозитории (включая вложенные
  на глубину `git.repositoryScanMaxDepth`) находит VS Code, состояние и события изменений готовые, push/pull идут через
  askpass VS Code (не виснут на логине), `toGitUri` для диффа. Свой `spawn` — только для чтения цифр +/−:
  `git diff --numstat -z` и `git diff --cached --numstat -z` бинарником `api.git.path`, в корне репозитория. Типы —
  копия `extensions/git/src/api/git.d.ts` из `microsoft/vscode` (MIT, шапку лицензии сохранить) в `src/extension/git/git.d.ts`.
  Жёсткой зависимости (`extensionDependencies`) не ставим: нет расширения или оно выключено (`git.enabled: false`) —
  вкладка показывает «git недоступен» и причину.
- **Какие репозитории.** `api.repositories`, у которых корень внутри cwd чата или cwd внутри корня. cwd внутри одного
  репо — режим «один репозиторий». Корень cwd — репо и внутри есть ещё — все, cwd-репо первым. Порядок — по пути.
  Не нашлось ни одного — пустое состояние: «репозиториев нет» + подсказка про `git.repositoryScanMaxDepth` (по
  умолчанию 1 — глубже VS Code не ищет) и кнопка «Открыть репозиторий…» (`git.openRepository`).
- **Один сервис на окно**: `GitService` в `ChatServices` (`services.git`), события → `git.state` во все панели чата
  (как `usage.onUpdate`). Снимок без цифр +/− дешёвый (из `repository.state`) и уходит всегда — для бейджа вкладки.
  Цифры +/− считаются, только пока хотя бы одна панель держит вкладку «git» открытой (`git.watch {on}` из webview),
  дебаунс 300 мс; снимок с цифрами — тот же `git.state`, поле `add`/`del` у файлов появляется.
- **Снимок** (`src/shared/git.ts`, общий для хоста и webview):
  `GitSnapshot = { state: 'ok' | 'unavailable' | 'none'; reason?: string; repos: GitRepoView[] }`,
  `GitRepoView = { root: string /* абсолютный */; rel: string /* от cwd, '' для cwd */; name: string; branch?: string;
  detached?: boolean; upstream?: string; ahead?: number; behind?: number; published: boolean; op?: 'merge' | 'rebase';
  unstaged: GitFileView[]; staged: GitFileView[]; log: GitCommitView[] }`,
  `GitFileView = { path: string /* от корня репо, '/' */; status: 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'T'; from?: string /* R */;
  add?: number; del?: number; binary?: boolean }`, `GitCommitView = { hash: string /* 7 */; subject: string; at: number; unpushed: boolean }`.
  Статусы: `Status.UNTRACKED`/`INTENT_TO_ADD` → `U`, конфликты (`BOTH_*`, `ADDED_BY_*`, `DELETED_BY_*`) → `C`
  (только в `unstaged`), `INDEX_*`/`MODIFIED`/`DELETED`/`TYPE_CHANGED` — по смыслу. Неотслеживаемые — в `unstaged`;
  +/− для них — число строк файла, если он < 1 МБ и не бинарный, иначе без цифр. Лог — `repository.log({ maxEntries: 5 })`,
  `unpushed` — первые `ahead` коммитов. Лог читается вместе с цифрами (только при открытой вкладке).
- **Действия** (`FromWebview`, все с `root` репозитория; хост проверяет, что `root` — один из текущих репо, а пути —
  внутри него): `git.watch {on}`, `git.stage {root, paths}` (`add`), `git.unstage {root, paths}` (`revert`),
  `git.discard {root, paths}` — **модальное подтверждение на хосте** («Отменить изменения в N файлах? Это нельзя
  вернуть», неотслеживаемые — «Удалить N неотслеживаемых файлов?»), затем `clean`; `git.commit {roots, message, amend,
  push}` — по очереди в каждый `root`, ошибка в одном не отменяет другие, итог по каждому; `git.sync {root?, op:
  'fetch' | 'pull' | 'push'}` (без `root` — во всех; push неопубликованной ветки — `push(remote, branch, true)` в
  единственный или `origin` remote, иначе QuickPick remote); `git.branch {root}` — QuickPick локальных и удалённых
  веток (`getRefs`) + «Создать ветку…», затем `checkout` / `createBranch`; `git.open {root, path, staged}` — дифф
  (`vscode.diff`: unstaged — индекс ↔ файл; staged — `HEAD` ↔ индекс; ref индекса для `toGitUri` — как у SCM VS Code
  (`'~'`, сверить по исходникам `extensions/git`); новый — просто файл;
  удалённый — `HEAD` ↔ пусто), `git.openFile {root, path}`. Идущая операция — `GitRepoView.busy?: 'commit' | 'pull' | …`
  в снимке (кнопки гаснут). Ошибка — `git.error {root?, op, message}` в webview (строка над полем коммита) +
  `log.error`; уведомление VS Code не дублируем.
- **Вкладка в webview**: `Tab` и `PanelState.tab` получают `'git'`; бейдж — число файлов во всех репо (`unstaged + staged`);
  вкладка есть всегда, при `state !== 'ok'` бейджа нет. Переключатель «путь / дерево» — `PanelState.gitTree?: boolean`,
  выбранный репо в раскладке `picker` — `PanelState.gitRepo?: string` (root), фильтр «агент» — `PanelState.gitAgent?: boolean`.
  Модель — чистые функции в новом `src/webview/gitView.ts` (строки пути / дерева, метка агента, группы раскладок, текст
  кнопки коммита), DOM — новый `src/webview/components/GitPane.tsx`, стили — `media/git.css` (перенос
  `prototype/shared/git.css`, цвета статусов — `--vscode-gitDecoration-*`).
- **Метка агента**: путь файла относительно cwd (`rel/path`) ∈ множество путей `changesView(...)` за сессию.
- **Поле коммита**: заголовок — однострочное поле, счётчик `72 − длина` (меньше нуля — цветом `--warn`), описание —
  многострочное; сообщение = заголовок + пустая строка + описание. Черновик — в сигнале webview на репо (не в
  `PanelState`). Кнопка: «Коммит · N файла → ветка»; индекс пуст — «Коммит» неактивна с подсказкой «сначала в индекс».
  ▾ — меню: «Коммит и push», «Коммит всех изменений» (`commit({all: true})` — без индекса), «Stash» — нет (не в скоупе).
  `amend` и «и push» — чекбоксы. ⌘/Ctrl+Enter в поле — коммит.
- **Раскладки нескольких репо** (`agentura.git.layout`, применяется только когда репо ≥ 2):
  `stack` — стопка разделов как в прототипе `#ma`: шапка репо (имя, ветка, бейдж, ↓/↑, ⋯), свои секции, своё поле
  коммита в одну строку (раскрывается на фокус в полное); чистые свёрнуты в строку «чисто». `picker` — `#mb`: список
  репо сверху, ниже выбранный как в режиме одного репо. `unified` — `#mc`: общие секции с подзаголовками репо; чипы
  «в: ☑ repo N» над общим полем коммита (по умолчанию отмечены все с непустым индексом), одно сообщение — отдельный
  коммит в каждом отмеченном; чистые — строками внизу.
- **✦ сообщение агентом** — отдельный этап 4. Одноразовая `query()` без инструментов, модель — `sonnet`, вход —
  `git diff --cached --stat` + `git diff --cached` (обрезка 24 000 символов) + 5 последних заголовков коммитов (стиль
  репо), ответ — заголовок ≤ 72 + описание. **Не должна появиться в списке сессий** (список читается из транскриптов
  проекта) — способ (опция SDK без сохранения транскрипта / удаление файла после / отдельный cwd) выбирает этап 4.

## Этапы

### 1. Хост: `GitService` и протокол · opus, high

- [ ] `src/extension/git/git.d.ts` (копия из `microsoft/vscode`, с шапкой лицензии) + `getGitApi()` (ленивая активация
  `vscode.git`, `getAPI(1)`, причины недоступности)
- [ ] `src/shared/git.ts`: типы снимка и действий; маппинг `Status` → буква (`gitStatus(...)`), чистая функция + тест
- [ ] `src/extension/git/gitService.ts`: выбор репо по cwd, снимок, подписки `onDidOpenRepository`/`onDidCloseRepository`/
  `state.onDidChange`, дебаунс, `watch`-счётчик, `numstat` (`spawn`, `-z`, бинарные `-\t-`), строки неотслеживаемых, лог
- [ ] действия: stage / unstage / discard (модалка) / commit (несколько root, итог по каждому) / sync / branch (QuickPick) /
  open (дифф через `toGitUri`) / openFile; проверка `root` и путей
- [ ] протокол: `git.state`, `git.error` в `ToWebview`; `git.watch|stage|unstage|discard|commit|sync|branch|open|openFile`
  в `FromWebview` + `FROM_WEBVIEW_TYPES` + валидаторы; `protocol.test.ts`
- [ ] `services.git` в `ChatServices`/`extension.ts`, подписка панели (`git.state` на изменение и на `ready`), маршрут
  `git.*` из `chatPanel.ts` в сервис (cwd панели)
- [ ] тесты: `gitService.test.ts` на моке API (выбор репо для cwd-в-репо / cwd-над-репо / пусто / недоступно; статусы;
  `numstat` с бинарным и переименованием; commit в два root, один падает; discard без подтверждения не зовёт `clean`;
  путь вне репо отклонён)
- [ ] `npm run check` зелёный

### 2. Webview: вкладка «git», один репозиторий · sonnet, high · после 1

- [ ] `'git'` в `Tab`, `PanelState.tab` (+ `readPanel`), `panelItems`, вкладки шапки, иконка (как в прототипе), `.rail`,
  `media/hud.css` (`data-active="git"`), строки `tabs.git`
- [ ] `PanelState.gitTree|gitRepo|gitAgent` + `readPanel`/`savePanel` + тест в `panelDom.test.ts`
- [ ] сигнал снимка в `store.ts` из `git.state`; `git.watch` при открытии / закрытии вкладки и при скрытии панели
- [ ] `src/webview/gitView.ts` + `gitView.test.ts`: строки «путь» и «дерево», метка агента, фильтр, бейдж, текст кнопки
- [ ] `GitPane.tsx` для одного репо (прототип `#one` / `#one-tree`): шапка (ветка ▾, ↓/↑, fetch/pull/push), итог + чип
  «агент» + путь/дерево, секции с «+ все в индекс» / «− все», строка файла с действиями на наведении и по клавиатуре,
  последние коммиты, поле коммита (amend, «и push», ▾, ⌘Enter), строка ошибки, пустые состояния (`unavailable`, `none`)
- [ ] `media/git.css` + подключение в `webviewHost.ts`; строки `strings.ts`/`strings.en.ts`
- [ ] `gitDom.test.ts` (jsdom): снимок → строки, клик «+» шлёт `git.stage`, «− все» — `git.unstage` со всеми путями,
  коммит шлёт `git.commit` с сообщением из двух полей, фильтр «агент», дерево
- [ ] `npm run check` зелёный
- [ ] **пользователь:** вкладка глазами в VS Code (тёмная и светлая, 220 / 300 / 600 px), stage / unstage / discard
  (модалка) / коммит / push на живом репо

### 3. Несколько репозиториев: три раскладки + настройка · sonnet, high · после 2

- [ ] настройка `agentura.git.layout` (`stack|picker|unified`, по умолчанию `stack`) по эталону `agentura.agents.view`
  целиком: `package.json` + nls, `settings.ts`, `chat.info.gitLayout`, сигнал, `data-git` на `.webview`, команда
  `agentura.gitLayout` (QuickPick, `writeWhereSet`), `l10n.ts`, перепуск при смене конфигурации
- [ ] `gitView.ts`: группы для `stack` / `picker` / `unified`, чипы целей коммита + тесты
- [ ] `GitPane.tsx`: раскладки `#ma` / `#mb` / `#mc` прототипа; `unified` шлёт один `git.commit` с несколькими `roots`;
  итог по каждому репо в строке ошибки/успеха
- [ ] строка «Вкладка git: несколько репозиториев» в ⚙ → «Вид» (`ChoiceCards` + превью на фикстуре из трёх репо)
- [ ] тесты: `settings.test.ts`, `manifest.test.ts`, `settingsDom.test.ts`, `gitDom.test.ts` (три раскладки), `chatController.test.ts` (`chat.info`)
- [ ] CHANGELOG «Unreleased → Added»: вкладка git, настройка, команда
- [ ] `npm run check` зелёный
- [ ] **пользователь:** папка с 2–3 репо — все три раскладки, коммит в два репо из `unified`

### 4. ✦ Сообщение коммита агентом · opus, high · после 3

- [ ] одноразовый запрос в адаптере (по образцу `accountInfo`, таймаут 60 с), не попадает в список сессий — проверено тестом
- [ ] `git.message {roots}` → `git.message.result {text} | git.error`; кнопка ✦ крутится, пока ждёт; заполняет заголовок
  и описание (не затирает непустой черновик без подтверждения — заменяет, черновик в «отменить» ⌘Z не нужен)
- [ ] тесты + `npm run check` зелёный
- [ ] **пользователь:** ✦ на живом индексе; список сессий не вырос

### 5. Приёмка и картинки

- [ ] `/plan-review` каждого этапа, коммит на ветке `stage-N-git-*`, мерж в main
- [ ] галерея: раздел «Вкладка «git»: настоящий webview» (как `#amap-real`)
- [ ] `12-git-tab.pending.md` — ручные проверки по этапам

## Промты сессий

### Сессия 1 — хост: GitService и протокол · Модель: opus, effort: high

Работаем в `/Users/fost/Projects/Agentura` (расширение VS Code, TypeScript). Задача: серверная часть вкладки «git» —
сервис над API встроенного `vscode.git` и протокол с webview. UI не трогаем (этап 2).

Читай: этот файл (`docs/roadmap/12-git-tab.md`) — «Решения» и «Этапы → 1» обязательны; прототип
`prototype/shared/git.js` — какие данные показывает вкладка. Точки входа — в «Что есть сейчас»: открывать только
фрагмент, который правишь.

Уже решено, не переспрашивать: всё в «Решения»; формы снимка и сообщений — дословно оттуда (можно добавить поле, если без
него нельзя, — тогда в отчёт). `git.d.ts` — скачать
`https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/api/git.d.ts`; если сети нет — написать
минимальные типы для используемого (`API`, `Repository`, `RepositoryState`, `Change`, `Status`, `Branch`, `Ref`,
`Commit`, `LogOptions`, `CommitOptions`) и сказать в отчёте.

Порядок: ветка `stage-1-git-service` от `main` → чекбоксы «Этапы → 1» по порядку. Галочки — по факту проверки.

DoD: `npm run check` зелёный; `gitService.test.ts` покрывает список из чекбокса тестов. Проверка: `npm run check > $TMP/check.log 2>&1; tail -30 $TMP/check.log`.

Не делать: webview, CSS, настройки, ✦; `extensionDependencies`; свой парсинг `git status`; уведомления VS Code об ошибках
(только `git.error` + лог); чужие незакоммиченные файлы не трогать. Вопрос без ответа в промте — в отчёт.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от плана /
не проверено / открытые вопросы.

### Сессия 2 — webview: вкладка git, один репозиторий · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura`. Задача: вкладка «git» правой панели для одного репозитория по прототипу
`prototype/screens/git-pane.html#one` и `#one-tree` (DOM и классы — из `prototype/shared/git.js`, стили —
`prototype/shared/git.css`). Хост и протокол уже есть (этап 1: `src/shared/git.ts`, `src/extension/git/gitService.ts`).

Читай: этот файл — «Решения» и «Этапы → 2»; `src/shared/git.ts`. Точки входа вкладок — «Что есть сейчас»; эталон
вкладки — `ChangesPane` в `src/webview/components/SidePanes.tsx` и его тесты. Открывать только фрагменты, которые правишь.

Уже решено, не переспрашивать: всё в «Решения». Несколько репо в этом этапе показывать раскладкой `stack` без настройки
(просто разделы подряд) — раскладки и настройка в этапе 3.

Порядок: ветка `stage-2-git-pane` от `main` (после мержа этапа 1) → чекбоксы «Этапы → 2».

DoD: `npm run check` зелёный, `gitView.test.ts` и `gitDom.test.ts` есть. Проверка: `npm run check > $TMP/check.log 2>&1; tail -30 $TMP/check.log`.

Не делать: раскладки `picker`/`unified`, настройку, ✦ (кнопка видна, но `disabled` с подсказкой «скоро»); правки
хоста, кроме мелких дыр протокола (их — в отчёт). Не коммитить, не пушить. Отчёт последним сообщением: сделано /
отклонения / не проверено / вопросы.

### Сессия 3 — несколько репозиториев и настройка · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura`. Задача: раскладки `stack` / `picker` / `unified` вкладки «git» (прототип
`#ma` / `#mb` / `#mc`) и настройка `agentura.git.layout` целиком по эталону `agentura.agents.view` (все точки — «Что
есть сейчас»).

Читай: этот файл — «Решения» и «Этапы → 3»; `src/webview/gitView.ts`, `src/webview/components/GitPane.tsx` (этап 2).

Порядок: ветка `stage-3-git-layouts` от `main` → чекбоксы «Этапы → 3». DoD: `npm run check` зелёный. Не делать: ✦,
хост (кроме `chat.info.gitLayout`). Не коммитить, не пушить. Отчёт последним сообщением.

### Сессия 4 — ✦ сообщение коммита агентом · Модель: opus, effort: high

Работаем в `/Users/fost/Projects/Agentura`. Задача: кнопка ✦ в поле коммита — сообщение пишет модель по индексу.
Читай: «Решения» (пункт ✦) и «Этапы → 4»; эталон одноразового запроса — `accountInfo` в `src/agent/claude/adapter.ts:332`.
Главный риск — запрос не должен создать сессию в списке: выбрать способ, доказать тестом, описать в отчёте.
Ветка `stage-4-git-message`. DoD: `npm run check` зелёный. Не коммитить, не пушить. Отчёт последним сообщением.

## Риски и открытые вопросы

- `git.repositoryScanMaxDepth` по умолчанию 1: папка с репо глубже (как `Projects/at/<репо>`) покажет «репозиториев нет» —
  поэтому подсказка в пустом состоянии. Менять настройку VS Code за пользователя не будем.
- Пользователь мог выключить `git.autoRepositoryDetection` — то же пустое состояние.
- Монорепо с тысячами изменённых файлов: список без виртуализации; при > 500 файлов в секции — первые 500 и строка
  «ещё N — открыть в SCM» (`workbench.view.scm`). Решение исполнителя этапа 2, если упрётся раньше.
- Вкладки «изменения» и «git» частично пересекаются; разводит их метка агента. Если владелец после дегустации решит
  слить — отдельный roadmap.

## Порядок работы

Этапы строго последовательно (одно репо, общие файлы). После каждого — `/plan-review` (приёмка), коммит на ветке этапа,
мерж в main; ручные проверки копятся в `12-git-tab.pending.md`.
