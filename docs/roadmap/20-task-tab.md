# 20 — Вкладка «задача» рядом с чатом: карточка по вёрстке Jiraffe

> **Статус:** план 2026-10-09, ветка `feature/task-groups` (поверх 0.9.0, ещё не в main). Этап 1 принят 2026-10-09.
> Прототип — `prototype/screens/task-tab.html` (`#chat|#task|#wide|#busy|#wait`); галерея v40, раздел «Вкладка «задача»
> рядом с чатом». **Выбран широкий вариант (`#wide`).**
> Исполнитель отмечает чекбоксы по ходу работы — по факту проверки. Ручные проверки и решения на подтверждение —
> `20-task-tab.pending.md` (пополняется приёмкой каждого этапа).

## Цель

Карточка задачи уходит из правой панели в саму вкладку чата: в полосе задачи над лентой вкладки «чат | задача».
Вкладка «задача» показывает полную карточку, свёрстанную по Jiraffe: описание HTML, вложения, комментарии, история,
ворклог, лента изменений чата, смена статуса, комментарий, ворклог, «↳ в чат». Агент работает, пока открыта «задача»;
на вкладке «чат» видно, что идёт ход и что агент ждёт ответа.

## Контекст (разведка 2026-10-09)

Agentura (Preact + `@preact/signals`):
- Правая панель: `src/webview/components/Chat.tsx:410` `panelAll` (`changes|git|agents|task`), фильтр `:435`
  (`task` только при `taskOn`), `taskOn` — `:282` `taskPanelShown(taskCardMode.value, ts)`; бейдж `:401–402`
  (`taskShown`, `unseenCount`); узкий режим — `<TabBar>` `:586`; полоса `<nav class="rail">` `:715`, значок задачи
  `:747`; сама панель `<TaskPane>` `:697`.
- Полоска задачи `<TaskStrip>` — `Chat.tsx:502` (`isTaskChat(ts)`), внутренние вкладки чатов `<ChatTabs>` `:503`.
- `src/webview/components/TaskPane.tsx` (433 строки): `TaskPane` `:134` (переключатель «карточка | изменения» —
  `taskView` в `PanelState`, вложения `:275`), `TaskStrip` `:377`, ссылка «в Jiraffe ↗» `:389`, `ChatTabs` `:401`.
- Состояние вкладки: `src/webview/vscode.ts:21` `PanelState` (`tab?: 'changes'|'git'|'agents'|'task'`, `taskView`…).
- Типы данных задачи: `src/shared/task.ts` — `TaskCard` `:47` (description — уже текст), `TaskComment` `:37`
  (`text`), `TaskAttachment` `:28`, `TaskEvent` `:72`, `TaskStateMessage` `:96`, `TaskRequest` `:131`
  (`task.toComposer` требует `commentId` — `:134`).
- Карточка собирается на хосте: `src/extension/jira/taskEvents.ts:95` (`htmlToText` описания `:107` и комментариев
  `:92`, история → события `:113+`). Вход — `IssueDetail` + `Worklog[]` (`src/data/jira/types.ts`, копия Jiraffe).
- Протокол webview → хост: `src/protocol.ts:587+` (`FROM_WEBVIEW_TYPES`, `FIELD_CHECKS`); обработчик запросов
  задачи — `src/extension/jira/taskTab.ts:103` (`task.toComposer` и др.).
- Сервис задачи: `src/extension/jira/taskService.ts` (опрос 30 с, общий кеш на задачу, `TaskView.visible()`).
- Источники: `src/extension/jira/source.ts` — `JiraSource` `:102` (`issue()` → `{issue, worklogs}`), `JiraWriter`
  `:38` (`addComment`, `transitions`, `transition`, `logWork`; есть у своего подключения всегда, у Jiraffe — с API v2),
  потолки `MAX_COMMENT`/`MAX_WORK_COMMENT`/`MAX_WORK_SECONDS` `:29–31`.
- **Jiraffe API v2 уже отдаёт всё, что нужно** (`/Users/fost/Projects/jiraffe/src/api.ts:35–38`): `IssueDetail`
  с санитизированными `descriptionHtml` и `comments[].bodyHtml`, `history`, `attachments`, `timetracking`, поля, плюс
  `worklogs`. Своё подключение (`OwnSource.issue`, `source.ts:231`) отдаёт тот же `IssueDetail` **без санитизации**
  (см. `src/data/jira/mappers.ts:112`). Репо Jiraffe в этой задаче не трогаем.
- Санитайзер Jiraffe — `jiraffe/src/jira/sanitize.ts` (sanitize-html, список тегов `ALLOWED_TAGS`, `resolveHref`).
  В Agentura уже есть `dompurify` (webview, `Cards.tsx:448`, `Log.tsx:362` — `dangerouslySetInnerHTML`). CSP webview
  (`src/extension/html.ts:16`): `img-src` только `cspSource` и `data:`, скрипты по nonce.
- Настройка `agentura.tasks.card` (`package.json:403`, enum `panel|split|strip`), чтение — `chatPanel.ts:460`, `:668`
  (`isTaskCardMode`, `DEFAULT_TASK_CARD`), сплит с Jiraffe — `chatPanel.ts:422`, `:455`.
- Вёрстка-образец Jiraffe: `jiraffe/webview/issue.ts` (295), `jiraffe/webview/render.ts` (284), стили — рядом в
  `jiraffe/webview/*.css`. Прототип: `prototype/screens/task-tab.html` (стили внутри `<style>`), `prototype/shared/tasks.css`.
- Скриншоты README: `node scripts/readme-shots/run.mjs tasks`. Проверка: `npm run check` (typecheck + lint + vitest + build).

## Решения (2026-10-09)

1. **Вкладки «чат | задача»** живут в полосе задачи (`TaskStrip`) слева от ключа, как в `#wide`. Состояние — новое
   поле `PanelState.view?: 'chat' | 'task'` (своё у каждой вкладки чата, по умолчанию `chat`). Переключение — только
   в webview, хосту не сообщается. Лента и поле ввода **не размонтируются** — прячутся (`hidden`), прокрутка и черновик
   сохраняются.
2. **Правая панель без «задачи»:** из `panelAll` и полосы убрать `task`; на `view = 'task'` правая панель (и полоса)
   не рисуются, карточка занимает всю ширину вкладки. `PanelState.tab === 'task'` из старого состояния → `changes`.
3. **Широкая раскладка:** слева контент (крошки с ↻ и временем обновления, заголовок, кнопки, описание, вложения,
   подвкладки), справа колонка 280 px «Поля / Время / Чаты по задаче» (список чатов — тот, что сейчас в подвале
   `TaskPane`). Вкладка уже 720 px — колонка полей уходит под заголовок строкой-сеткой (как `#task`).
4. **Подвкладки:** Комментарии · История · Ворклог · Изменения. «Изменения» — нынешняя лента событий чата
   (`TaskEvent`, с плашкой «прокомментировал, пока агент работал → в чат»); бейдж непросмотренных — на ней и на
   вкладке «задача» полосы. Логика «видел» — как сейчас у сегмента «изменения».
5. **HTML:** хост передаёт `descriptionHtml` и `comments[].html` (клип по размеру, как сейчас у текста); webview
   рисует их через DOMPurify с белым списком тегов Jiraffe (`ALLOWED_TAGS` из `jiraffe/src/jira/sanitize.ts`), без
   атрибутов кроме `href` у `a` (только `http:`/`https:`/`mailto:`), `img` → плашка `[картинка]`. Клик по ссылке
   перехватывается и уходит на хост (`task.openLink`), хост открывает только http/https/mailto через `openExternal`.
   Санитайзинг для обоих источников один — в webview (Jiraffe-HTML проходит его повторно, это нормально).
   Текстовые `description`/`text` остаются — они нужны для контекста агента и «↳ в чат».
6. **Вложения:** плитки с типом файла (расширение крупно), именем и размером; превью картинок **не делаем** (нужна
   авторизация — CSP и токены). Клик — существующий `task.openExternal {attachmentId}`.
7. **Действия пользователя** (запись от его имени, без диалогов подтверждения — он нажал сам):
   - статус: кнопка «<статус> ▾» → меню из `writer.transitions()`; переход с `requiresFields` — пункт неактивен с
     подсказкой «нужны поля — откройте в Jira/Jiraffe»;
   - комментарий: поле внизу «Комментарии», Ctrl/Cmd+Enter — отправить, ≤ `MAX_COMMENT`;
   - ворклог: кнопка «Ворклог» → строка-форма (время `1h 30m`/`1.5h`, дата, комментарий) над подвкладками;
   - нет `writer` (Jiraffe без API v2) — кнопки неактивны с подсказкой «обновите Jiraffe».
   После успешной записи — `refresh` задачи. Ошибка — строкой под формой/кнопкой (текст ошибки источника, клип 300).
8. **«↳ в чат»:** у карточки — вставляет в поле ввода контекст задачи (как при открытии чата по задаче, `issueContext`),
   у комментария (кнопка при наведении) — как сейчас `task.toComposer {commentId}`. После вставки вкладка
   переключается на «чат», фокус в поле ввода.
9. **Индикаторы на «чате»**, пока открыта «задача»: идёт ход — спиннер + число новых записей ленты с момента
   переключения; агент ждёт ответа (разрешение / вопрос / план) — жёлтая точка и тост внизу вкладки
   «Агент ждёт ответа: <что> · к чату» (кнопка переключает на «чат»). Тост исчезает, когда ожидание снято.
10. **Настройка `agentura.tasks.card`:** enum `tab | split` (по умолчанию `tab`). `tab` — карточка во вкладке «задача»;
    `split` — как сейчас, плюс вкладка «задача» тоже есть. Старые значения `panel`/`strip` читаются как `tab`
    (`isTaskCardMode` + нормализация при чтении; `package.json` — только новый enum, описания ru/en обновить).
11. **Не делаем:** редактирование описания и полей, назначение исполнителя, загрузку вложений, превью картинок,
    упоминания @ в комментарии, правки репо Jiraffe.

### Решения по итогам этапа 1 (2026-10-09)

12. После успешной записи хост зовёт `service.afterWrite` (как инструменты агента), а не `refresh`: `refresh` упирается
    в окно 5 с и отдал бы старый кеш.
13. Ошибка получения переходов приходит в `task.transitions {items: [], error}` (это чтение), запись — в `task.action`.
14. Хост не пускает второй запрос записи того же вида, пока летит первый (дубль комментария/ворклога), и **ничего не
    отвечает** на отброшенный — webview обязан сам блокировать кнопку до `task.action`. Таймаут ответа источника — 60 с
    (`WRITE_TIMEOUT_MS`), ошибка «may have been saved — refresh».
15. «↳ в чат» у карточки (`task.toComposer` без `commentId`) прикладывает к полю ввода файл `<KEY>.md` с контекстом
    задачи — как «Чат по задаче…», а не вставляет текст. Переключение на «чат» и фокус — на стороне webview (этап 2).
16. `TASK_LIMITS`, `isIsoDate`, `isOpenableLink` живут в `src/shared/task.ts` — их берёт и протокол webview.
17. Превью `tasks.card` в настройках (`SettingsPreview.tsx`) сейчас только поправлено под новый enum — перерисовать под
    вкладки «чат | задача» на этапе 2. `scripts/readme-shots/data.mjs` строит `task.state` без новых полей — дополнить
    на этапе 2 (иначе кадры вкладки пустые).

## Этапы

### 1. Хост и протокол — **opus, high** (HTML из Jira идёт в webview, запись от имени пользователя)

- [x] `src/shared/task.ts`: `TaskCard` + `descriptionHtml`, `reporter?`, `created`, `due?`, `labels`, `components`,
      `fixVersions`, `epic?`, `time {originalSec?, remainingSec?, spentSec?}`, `history: TaskHistory[]`
      (`{at, author, items:{field, from, to}[]}`), `worklogs: TaskWorklog[]` (`{id, author, mine, at, seconds, comment}`),
      `canWrite: boolean`; `TaskComment` + `html`. Клипы: HTML описания 1 000 000 → как `MAX_DESCRIPTION`-аналог
      по символам HTML (взять 200 000), комментария — 200 000; истории — последние 200 записей; ворклогов — 200.
- [x] `taskEvents.ts:95` — заполнить новые поля из `IssueDetail`/`Worklog[]` (текстовые поля оставить как есть).
- [x] Запросы webview → хост (в `TaskRequest`, `FROM_WEBVIEW_TYPES`, `FIELD_CHECKS` с проверкой длин):
      `task.transitions` → ответ `task.transitions {items}`; `task.transition {transitionId}`;
      `task.comment {body}` (≤ `MAX_COMMENT`, непустой); `task.logWork {seconds, date, comment}` (потолки
      `source.ts:29–31`, `isIsoDate`); `task.openLink {url}` (только http/https/mailto, ≤ 4000);
      `task.toComposer` — `commentId` становится необязательным (нет — весь контекст задачи, решение 8).
      Ответ на запись — `task.action {kind, ok, error?}`; после `ok` — `refresh`.
- [x] Обработка в `taskTab.ts` через `source.writer` текущей задачи (тот же путь, что у инструментов агента в
      `agentTools.ts`, но без разрешения — инициатор пользователь). Нет writer — `task.action {ok:false, error:'no-writer'}`.
- [x] Настройка `tasks.card`: enum `tab|split`, по умолчанию `tab`, `panel`/`strip` → `tab` при чтении; `package.json`,
      `package.nls.json`, `package.nls.ru.json`.
- [x] Тесты: `taskEvents.test.ts` (новые поля, клипы), `taskTab.test.ts` (каждый новый запрос: ok, нет writer, ошибка
      источника, отказ на плохих полях), `protocol` (FIELD_CHECKS: длины, схемы URL `javascript:`/`file:` — отказ).

**Готово, когда:** `npm run check` зелёный; webview получает в `task.state` HTML и историю/ворклоги; новые запросы
покрыты тестами, `task.openLink` с `javascript:` отклоняется.

### 2. Webview: вкладки и карточка — **sonnet, high**, после 1

- [ ] `PanelState.view` (решение 1), вкладки в `TaskStrip` (стили — `prototype/screens/task-tab.html`, `.strip .vtab`).
- [ ] Убрать `task` из `panelAll`, полосы и узкого `TabBar`; миграция `tab === 'task'` → `changes` (решение 2);
      на `view = 'task'` панель и полоса не рисуются.
- [ ] Новый компонент `src/webview/components/TaskView.tsx` по `#wide` (решения 3–8): крошки, заголовок, кнопки
      (статус ▾, «Ворклог», «↳ в чат»), описание HTML (DOMPurify, решение 5 — конфиг санитайзера отдельной функцией
      в `src/webview/taskHtml.ts` с юнит-тестом), вложения-плитки, подвкладки, комментарии с «↳ в чат» при наведении,
      поле комментария, форма ворклога, колонка полей/времени/чатов; узкая вкладка (< 720 px) — поля сеткой под заголовком.
      Стили — новый `media/task-view.css` (или куда кладутся стили webview — по образцу соседних), цвета только
      `var(--vscode-*)`/токены проекта, как у соседей.
- [ ] Старую карточку из `TaskPane.tsx` убрать; `TaskStrip` и `ChatTabs` остаются; «изменения» задачи переезжают
      подвкладкой (решение 4), плашка «в чат» — тоже.
- [ ] Индикаторы и тост (решение 9) — от уже имеющихся в webview сигналов хода и ожидания (найти, откуда рисуются
      карточки разрешения/вопроса/плана, и взять оттуда же признак).
- [ ] i18n: все новые строки — в словари webview ru/en, как соседние.
- [ ] Тесты: `taskHtml` (скрипт/`on*`/`style`/`javascript:` вырезаются, `img` → плашка, ссылки остаются), логика
      счётчика новых и бейджа (если вынесена в чистые функции — как `unseenCount`).

**Готово, когда:** `npm run check` зелёный; `node scripts/readme-shots/run.mjs tasks` рендерит вкладку «задача» без
ошибок в консоли; правая панель не содержит «задачу».

### 3. Релиз 0.10.0 — **sonnet, medium**, после 2

- [ ] Скриншоты README (`run.mjs tasks`): кадры «чат» с вкладками и «задача» широкая; обновить README/README.ru
      (раздел про задачи Jira — одна-две фразы и картинки).
- [ ] `CHANGELOG.md` (англ.), версия 0.10.0 в `package.json`, `npm run package` → `agentura-0.10.0.vsix`.
- [ ] В `19-jira-tasks.md` у решений 9–10 пометка «заменено roadmap 20».

**Готово, когда:** `npm run check` зелёный, vsix собран, README показывает новую вкладку.

## Промты сессий

Общая шапка (в начало каждого промта):

```
Работаем в /Users/fost/Projects/Agentura, ветка feature/task-groups. Правила репо — стиль окружающего кода
(комментарии по-русски, их плотность — как рядом).
Читай: docs/roadmap/20-task-tab.md — «Контекст», «Решения» и свой этап; прототип prototype/screens/task-tab.html.
Точки входа в «Контексте» проверены при планировании — не перечитывать их ради подтверждения, открывать только
фрагмент, который правишь. Файлы > 300 строк целиком не читать: grep -n по сигнатурам, потом кусок.
Длинный вывод команд — в файл ($TMPDIR/x.log), в контекст только tail -30 и grep FAIL|error.
Решения не переспрашивать и не менять. Вопрос без ответа в roadmap — в отчёт, не додумывать.
Галочки в roadmap — по факту проверки.
Не делать: «заодно улучшить», правки вне этапа, репо Jiraffe, чужие незакоммиченные файлы (.codex/, AGENTS.md).
Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

### Промт 1

```
Сессия 1 — хост и протокол вкладки «задача» · Модель: opus, effort: high · первая
<общая шапка>
Задача: этап 1 roadmap 20 — расширить TaskCard (HTML, история, ворклоги, поля), запросы записи от пользователя,
task.openLink, настройка tasks.card = tab|split. Решения 5, 7, 8, 10.
Эталоны: проверка недоверенного ввода — FIELD_CHECKS в src/protocol.ts:620+; запись через writer — agentTools.ts;
сборка карточки — taskEvents.ts:95; тесты — taskTab.test.ts, taskEvents.test.ts.
Порядок — чекбоксы этапа 1 сверху вниз. DoD: «Готово, когда» этапа 1. Проверка: npm run check.
```

### Промт 2

```
Сессия 2 — webview: вкладки «чат | задача» и карточка · Модель: sonnet, effort: high · после сессии 1
<общая шапка>
Задача: этап 2 roadmap 20 — вкладки в полосе задачи, правая панель без «задачи», TaskView по прототипу #wide.
Решения 1–9 и 12–17. Новые поля и запросы протокола уже есть (этап 1) — src/shared/task.ts (TaskCard, TaskComment.html,
TaskHistory, TaskWorklog, TaskTransition, TaskTransitionsMessage, TaskActionMessage, TaskRequest); ответы хоста приходят
в store webview там же, где task.state. Кнопки записи блокировать до task.action (решение 14). Превью tasks.card в
SettingsPreview.tsx и фикстуру scripts/readme-shots/data.mjs дополнить (решение 17).
Эталоны: TaskPane.tsx (текущая карточка, «изменения», ChatTabs/TaskStrip), Chat.tsx:282/401/410/435/502/586/697/715/747,
DOMPurify — Cards.tsx:448; вёрстка — prototype/screens/task-tab.html (#wide и #task для узкой), jiraffe/webview/render.ts.
Порядок — чекбоксы этапа 2. DoD: «Готово, когда» этапа 2. Проверка: npm run check, node scripts/readme-shots/run.mjs tasks.
```

### Промт 3

```
Сессия 3 — релиз 0.10.0 · Модель: sonnet, effort: medium · после сессии 2
<общая шапка>
Задача: этап 3 roadmap 20 — скриншоты README, CHANGELOG (англ.), версия 0.10.0, vsix, пометка в roadmap 19.
Эталон — коммит 2ec5ca9 (релиз 0.9.0) и 600b534 (README). DoD: «Готово, когда» этапа 3.
```

## Риски и открытые вопросы

- HTML своего подключения не санитизирован на хосте — вся защита в DOMPurify webview + CSP. Приёмка этапа 1–2
  проверяет конфиг санитайзера тестом с вредоносными образцами.
- Большие задачи (сотни комментариев) — клипы этапа 1; если вкладка тормозит, следующим шагом — ленивая подгрузка.
- `split` теперь дублирует карточку (Jiraffe рядом + вкладка) — оставлено сознательно, решение 10.

## Порядок работы

1 → 2 → 3. Каждый этап — исполнитель-субагент, затем приёмка `/plan-review` с коммитом в `feature/task-groups`.
До старта этапа 1 закоммитить прототип (`prototype/screens/task-tab.html`) и этот файл.
