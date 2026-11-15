# 42. Редизайн левой панели (нативный `view/title`, брендовые SVG, 3 режима лимитов и ровный список сессий)

> Статус: реализовано (приняты Этапы 1–4 из 4; ожидает ручной проверки в Extension Development Host `F5`) · 2026-11-15. Исполнитель отмечает чекбоксы `[x]` только по факту прохождения проверок этапа.

## Checkpoint

- **Принятый этап:** Этап 4 («Страница „Боковая панель“ в Настройках, живые миниатюры `SidebarPreview`, документация и сквозная приёмка»), попыток приёмки: 1. Все технические этапы (1–4) приняты: Этап 1 (попыток: 1), Этап 2 (попыток: 2), Этап 3 (попыток: 2), Этап 4 (попыток: 1).
- **Изменённые файлы по всему roadmap 42:** `eslint.config.mjs`, `package.json`, `package.nls.json`, `package.nls.ru.json`, `src/settings.ts`, `src/settings.test.ts`, `src/protocol.ts`, `src/shared/l10n.ts`, `src/extension/extension.ts`, `src/extension/sidebarView.ts`, `src/extension/sidebarView.test.ts`, `src/manifest.test.ts`, `src/webview/components/BrandIcon.tsx` (новый), `src/webview/engineLimitsView.ts`, `src/webview/components/EngineLimits.tsx`, `src/webview/sessionsView.ts`, `src/webview/sessionsView.test.ts`, `src/webview/components/Sidebar.tsx`, `src/webview/components/SidebarTaskPicker.tsx`, `src/webview/components/Settings.tsx`, `src/webview/components/SettingsPreview.tsx`, `src/webview/strings.ts`, `src/webview/strings.en.ts`, `media/hud.css`, `media/tasks.css`, `media/settings.css`, `src/webview/engineLimits.test.ts`, `src/webview/sessionsDom.test.ts`, `src/webview/taskPickerDom.test.ts`, `src/webview/settingsDom.test.ts`, `README.md`, `README.ru.md`.
- **Ветка / worktree / подтверждённый `cwd`:** `main` (ahead 5), основной worktree `/Users/fost/Projects/Agentura` (`pwd` подтверждён).
- **Проверки (независимо основным чатом):**
  - `TZ=UTC npm run check` → `0` (`tsc --noEmit`, `eslint .`, `vitest run` — 175 файлов / 2543 теста, `node esbuild.mjs`);
  - `npm run test:integration` → `0` (все тесты VS Code Extension Host пройдены);
  - `sh prototype/tools/layout-check.sh` → `0` (все экраны прототипа, включая `sidebar-next.html`: OK);
  - `git diff --check` → `0`.
- **Runtime / модели:** основной чат AGY — `Gemini 4 Carbon (Medium)` (`USER_SETTINGS_CHANGE`); исполнители этапов (`invoke_subagent(TypeName: "self", Model: "flash", Workspace: "inherit")`): Этап 1 — `4d8ea621-3f1b-42c1-934a-c0d1a8825894`, Этап 2 — `3808dc34-43dc-4c18-a0b4-888399dfe1f3`, Этап 3 — `f4e8a7ff-9467-4d3a-b98f-e454bab5912a`, Этап 4 — `602f0e39-e986-4c9e-b4b2-80488aeca365`.
- **Dirty / unpushed:** изменения roadmap 42 и прототипа `sidebar-next.html` зафиксированы коммитом и отправлены в `origin/main`; локальные несвязанные файлы (`.codex/config.toml`, `docs/roadmap/43-acp-questions-and-live-bugs.md`) оставлены вне индекса.
- **Блокер:** нет.
- **Следующий шаг:** ручная live-проверка в Extension Development Host (`F5`) по чеклисту в разделе «Риски и открытые вопросы», после чего коммит / сборка `.vsix` по команде пользователя.
- **Промт кросс-клиентской проверки:** `Прими целиком docs/roadmap/42-sidebar-redesign.md в /Users/fost/Projects/Agentura (/plan-review): сверь git diff со всеми пунктами этапов 1–4 и prototype/screens/sidebar-next.html, убедись что чужие dirty-файлы (prototype/*, .codex/config.toml, docs/roadmap/43-*) не затронуты, прогони TZ=UTC npm run check && npm run test:integration && sh prototype/tools/layout-check.sh && git diff --check.`

## Цель

Привести левую панель Agentura (`agentura.sidebar`) к утверждённому интерактивному прототипу `prototype/screens/sidebar-next.html`: убрать дублирующую шапку `AGENTURA ⚙` внутри webview в пользу нативного `view/title` VS Code, заменить самодельные цветные квадраты `C / X / G / R / K` на единые брендовые SVG из `media/brands/`, внедрить три не режущих кнопки режима блока «Лимиты» (**A · Вкладки**, **B · Радар**, **C · Список**) с читаемой диагностикой ошибок квоты, выровнять ритм строк и заголовки в «Сессиях» и упростить настройки вида панели с мягкой миграцией старых значений.

## Контекст и ограничения

### Подтверждённые факты по коду
- **Эталон вёрстки и поведения:** `prototype/screens/sidebar-next.html` (проходит `sh prototype/tools/layout-check.sh`).
- **Шапка и команды VS Code (`package.json:47-55, 62-70, 122-131, 188-236`):**
  - Вид `agentura.sidebar` зарегистрирован с `name: "Agentura"`, а внутри `SidebarView` (`src/webview/components/Sidebar.tsx:629-680`) рисуется второй заголовок `<div class="head"><span>AGENTURA</span>...<button class="gear">⚙</button></div>`.
  - У команды `agentura.newSession` (`package.json:62-70, 230-235`) иконка задана логотипом расширения (`media/icon-light.svg` / `media/icon-dark.svg`) для `editor/title` — вешать её напрямую в `menus["view/title"]` нельзя, иначе вместо `+` в шапке сайдбара появится логотип Agentura и пропадёт меню выбора `SidebarTaskPicker` («Новый чат» / «По задаче Jira…», `src/webview/components/SidebarTaskPicker.tsx:193-245`).
- **Причина поломки свитчера движков и ошибок квоты (`media/hud.css:452, 460-463`, `src/webview/components/EngineLimits.tsx:84-98, 124, 151-197`):**
  - `.sidebar .seg button` задаёт `flex: 1; min-width: 0; overflow: hidden` прямо на `<button>`, из-за чего при 4 движках (`Claude`, `Codex`, `Antigravity`, `Kimi Code`, собственная ширина ~393px) в стандартной панели 260–300px режутся иконки и подписи (`[G] Antigravit`, `[K] Kimi Cod`).
  - Ошибка опроса квоты (`e.state === 'error'`, например `Eligibility check failed` у Antigravity) рендерится в однострочный `<span class="wait">` с `text-overflow: ellipsis` и безусловной серой точкой `<Dot>` (`okd off`) справа.
- **Схема настроек и живые миниатюры (`src/settings.ts:28-46, 200-206, 673-686, 741-799`, `src/webview/components/Settings.tsx:865-875, 1140-1215, 1410`, `src/webview/components/SettingsPreview.tsx:614-655`, `media/settings.css:507-533, 635-639`):**
  - Сейчас сосуществуют `agentura.sidebar.top` (`detailed | compact | dense`), `agentura.sidebar.limits` (`stack | switch | table | active | header`) и `agentura.sessionList.view` (`detailed | compact | dense`).
  - В `src/settings.ts:61-62` уже используется паттерн мягкой миграции устаревших enum-значений при чтении (`LEGACY_TASK_CARD` → `tab`) без поломки пользовательского `settings.json`.
  - Страница `Settings.tsx` рендерит настоящие `<SidebarView>` в карточках выбора (`part="limits" | "tasks" | "list"`) и в превью шрифта панелей на странице «Внешний вид» (`Settings.tsx:1410`, `.pv-one.pv-panels .pv-side`).
  - В `src/webview/settingsDom.test.ts:141-148` есть тест на `.head .gear`, а в `337-395` — проверка полного отсортированного списка всех `.set .key`.
- **Список сессий и сырые заголовки (`src/agent/kimi/adapter.ts:176`, `src/webview/sessionsView.ts:68-137`, `src/webview/components/Sidebar.tsx:150-254, 765-791`, `media/hud.css:346-359, 383-395`):**
  - При отсутствии `title` у сессии Kimi `listSessions` возвращает `id` вида `session_a6b9fb6b-7f7d-...`.
  - Левая колонка `.sidebar .s` шириной `10px` в большинстве строк пуста (точка `.dot` видна только у `live`/`wait`), а режим `data-list="compact"` (`hud.css:386-387`) делает строки `cur/live/wait/err` двухстрочными при однострочных остальных, ломая вертикальный ритм.
- **Брендовые иконки:** `media/brands/` уже содержит `claude-color.svg`, `openai.svg`, `openai-dark.svg`, `antigravity.svg`, `cursor.svg`, `kimi.svg`, `kimi-dark.svg` (подключены в `media/composer.css:255-285`, разрешены в webview через `localResourceRoots`).

### Принятые продуктовые решения
1. **Три режима блока «Лимиты» (`agentura.sidebar.limits`):**
   - `tabs` (**A · Вкладки**, по умолчанию) — адаптивные сегментированные вкладки: активная всегда держит полную ширину названия (`min-inline-size: max-content` + нижний акцент `::after`), неактивные в узком сайдбаре (`@container sidebar (max-width: 345px)`) компактно показывают логотип и индикатор перегрева/ошибки.
   - `radar` (**B · Радар**) — все видимые движки сразу в один ряд микро-плиток (логотип + худший `%` / `!` + нижняя полоска прогресса), ниже — аккаунт и шкалы выбранного движка.
   - `list` (**C · Список**) — плотный вертикальный аккордеон со строкой и мини-шкалой на каждый движок и раскрытием всех окон по клику.
2. **Упрощение и мягкая миграция настроек вида панели:**
   - Настройка `agentura.sidebar.top` удаляется из схемы `package.json`, `SettingKey`, протокола `sidebar.view` и страницы Настроек.
   - Старые значения `agentura.sidebar.limits` в пользовательском `settings.json` при чтении (`readSidebarLimitsMode`) мягко маппятся без ошибок: `'switch' → 'tabs'`, `'table' | 'stack' | 'header' → 'radar'`, `'active' → 'list'`; валидатор записи (`validateSetting`) принимает только `['tabs', 'radar', 'list']`.
   - `agentura.sessionList.view` приводится к двум честным плотностям с ровной высотой всех строк: `'compact'` (1 строка, по умолчанию) и `'detailed'` (2 строки); старое `'dense'` при чтении маппится в `'compact'`.

### Принятые технические допущения
- **Нативный `view/title` + сохранение `SidebarTaskPicker`:** в `menus["view/title"]` (`when: "view == agentura.sidebar"`) выносятся три иконки: новая команда `agentura.sidebarNewChat` (`icon: "$(add)"`, `navigation@1`), `agentura.refreshUsage` (`icon: "$(refresh)"`, `navigation@2`) и `agentura.openSettings` (`icon: "$(gear)"`, `navigation@3`). `agentura.sidebarNewChat` при открытом webview сайдбара шлёт `{ type: 'task.picker.toggle' }` (открывает меню `SidebarTaskPicker`: «Новый чат» / «По задаче Jira…» у правого верхнего края панели; если Jira отключена `jira.source === 'off'` и нет подключений или панель закрыта — сразу вызывает `agentura.newSession`). Компактный триггер `<SidebarTaskPicker />` также остаётся доступным из клавиатурного/DOM-потока панели без полноширинной кнопки `.new`.
- **Действия в блоке диагностики квоты (`.diag-box`):** кнопка «Сменить аккаунт» шлёт существующий `{ type: 'engine.login', engine }` (`codex | antigravity | kimi`), а «Скрыть вкладку» шлёт `{ type: 'sidebar.hideEngine', engine }`, который в `SidebarProvider` дописывает движок в `agentura.sidebar.limitsHidden` (с проверкой `overriddenKeys`, как у `setListView`).
- **Единый вид блока лимитов при 1 и ≥ 2 движках:** таблица `.kv` на 4 строки для одиночного Claude убирается; при `engines.length === 1` рендерится та же компактная карточка `.panel-body` (строка аккаунта с чипом плана + шкалы `.gauges`) без лишней полосы переключения движков. В свёрнутом состоянии секции «Лимиты» (`.sec.acc.folded`) в её шапке показывается однострочная сводка `Claude 42% · Codex 92% · AGY !`.
- **Чистка заголовков без порчи данных:** `displaySessionTitle(s)` в `src/webview/sessionsView.ts` форматирует отображаемое имя (`session_a6b9fb6b-...` и голые UUID → `Без названия · #a6b9` / `Untitled · #a6b9`, срезает префикс `https://github.com/`), но хранимый `SessionInfo.title` не мутирует; при двойном клике по `untitled`-сессии поле переименования открывается пустым с `placeholder` текущего короткого имени.

### Границы (вне скоупа)
- Замена цветных меток `.mk` за пределами боковой панели (`TaskPane.tsx`, чипы чатов в `.tk-strip` внутри вкладки редактора).
- Изменение логики опроса квот CLI/OAuth (`UsageService`, `CodexLimitsService`, `AgyQuotaService`, `loadKimiModels`).
- Коммит, сборка `.vsix` и публикация без отдельной команды пользователя.

---

## Этапы

### 1. Схема настроек, миграция старых значений, команды `view/title` и контракты хоста

**Файлы:** `package.json`, `package.nls.json`, `package.nls.ru.json`, `src/settings.ts`, `src/settings.test.ts`, `src/protocol.ts`, `src/shared/l10n.ts`, `src/extension/extension.ts`, `src/extension/sidebarView.ts`, `src/extension/sidebarView.test.ts`, `src/manifest.test.ts` (+ минимальная синхронизация типов в `src/webview/components/Sidebar.tsx`, `src/webview/components/EngineLimits.tsx`, `src/webview/components/Settings.tsx`, `src/webview/components/SettingsPreview.tsx` для прохождения `tsc --noEmit`).

- [x] В `package.json`, `package.nls.json`, `package.nls.ru.json`:
  - удалить свойство `agentura.sidebar.top` и его `%config.sidebar.top.*%`-ключи;
  - обновить `agentura.sidebar.limits` на `enum: ["tabs", "radar", "list"]`, `default: "tabs"` и описания `A · Вкладки / B · Радар / C · Список`;
  - обновить `agentura.sessionList.view` на `enum: ["compact", "detailed"]`, `default: "compact"` (1 строка / 2 строки);
  - добавить иконку `"icon": "$(refresh)"` команде `agentura.refreshUsage`, зарегистрировать команду `agentura.sidebarNewChat` (`"icon": "$(add)"`, скрыта из палитры через `menus.commandPalette: when: "false"`, чтобы не дублировать `agentura.newSession`) и прописать `menus["view/title"]` (`when: "view == agentura.sidebar"`) для `agentura.sidebarNewChat` (`navigation@1`), `agentura.refreshUsage` (`navigation@2`), `agentura.openSettings` (`navigation@3`).
- [x] В `src/settings.ts` и `src/settings.test.ts`:
  - удалить `SIDEBAR_TOP_MODES`, `SidebarTopMode`, `DEFAULT_SIDEBAR_TOP` и ключ `'sidebar.top'`;
  - перевести `SIDEBAR_LIMITS_MODES` на `['tabs', 'radar', 'list']` (`DEFAULT_SIDEBAR_LIMITS = 'tabs'`) с чтением устаревших значений через `readSidebarLimitsMode` (`switch → tabs`, `table | stack | header → radar`, `active → list`);
  - перевести `SESSION_LIST_MODES` на `['compact', 'detailed']` (`DEFAULT_SESSION_LIST = 'compact'`) с чтением устаревшего `'dense'` как `'compact'` в `readSessionListMode` и переключением `compact ↔ detailed` в `nextSessionListMode`.
- [x] В `src/protocol.ts`, `src/shared/l10n.ts`, `src/extension/extension.ts`, `src/extension/sidebarView.ts`:
  - убрать `top` из `sidebar.view`, добавить `ToWebview`-сообщение `{ type: 'task.picker.toggle' }` и `FromWebview`-сообщение `{ type: 'sidebar.hideEngine'; engine: AgentProvider }`;
  - обновить QuickPick команды `agentura.sidebarLimits` (`extension.ts:318-334`, `l10n.ts`) под `tabs | radar | list`;
  - добавить метод `SidebarProvider.promptNewChat()` для команды `agentura.sidebarNewChat` (если `this.view?.visible`, шлёт `{ type: 'task.picker.toggle' }`, иначе вызывает `agentura.newSession`) и обработку `sidebar.hideEngine` (запись в `agentura.sidebar.limitsHidden` с проверкой `overriddenKeys`);
  - синхронизировать типы `SidebarLook` / `EngineLimitsBody` / `Settings` так, чтобы проект собирался без ошибок типов.
- [x] Обновить и дополнить тесты в `src/settings.test.ts`, `src/manifest.test.ts` и `src/extension/sidebarView.test.ts` (миграция старых значений, `menus["view/title"]`, `sidebar.hideEngine`, `promptNewChat`).

**Готово, когда:** `npx vitest run src/settings.test.ts src/manifest.test.ts src/extension/sidebarView.test.ts`, `npm run typecheck` и `npm run lint` проходят с кодом `0`.

**Исполнение:** последовательно (задаёт типы настроек и протокола для этапов 2–4).

---

### 2. Блок «Лимиты»: уборка дубля шапки, брендовые SVG, режимы `tabs / radar / list` и `.diag-box`

**Файлы:** `src/webview/engineLimitsView.ts`, `src/webview/components/BrandIcon.tsx` (новый), `src/webview/components/EngineLimits.tsx`, `src/webview/components/Sidebar.tsx`, `src/webview/strings.ts`, `src/webview/strings.en.ts`, `media/hud.css`, `src/webview/engineLimits.test.ts`.

- [x] Создать лёгкий общий компонент `src/webview/components/BrandIcon.tsx` (`<span class={`brand brand-${provider}`} aria-hidden="true" />`) и прописать в `media/hud.css` общие правила `.sidebar .brand` для `claude`, `codex`, `antigravity`, `cursor`, `kimi` с переключением `openai-dark.svg` и `kimi-dark.svg` для `body.vscode-dark, body.vscode-high-contrast`.
- [x] В `src/webview/components/Sidebar.tsx` убрать верхнюю полосу `<div class="head">AGENTURA ... ⚙</div>`, `<EnginePopup>` и старую ветку `.kv` одиночного Claude; задать `.sidebar { container: sidebar / inline-size; }` в `media/hud.css`; оформить спокойный sentence-case заголовок секции `Лимиты` со сворачиванием и инлайн-сводкой `.sec-summary` в свёрнутом виде (`Claude 42% · Codex 92% · AGY !`).
- [x] Переписать `src/webview/components/EngineLimits.tsx` и стили лимитов в `media/hud.css` по эталону `prototype/screens/sidebar-next.html`:
  - **`tabs` (A · Вкладки):** `.eng-tabs` с `interpolate-size: allow-keywords`, обёртка текста `.tab-lbl`, активная вкладка с `min-inline-size: max-content` и нижним индикатором `::after`, скрытие `.tab-lbl` у неактивных вкладок при `@container sidebar (max-width: 345px)`, сигнальная точка `.st-pip` только при перегреве (`lim-warn` / `lim-full`) или проблеме (`error` / `signedOut`), навигация стрелками `ArrowLeft` / `ArrowRight` / `Home` / `End`, отступы панелей внутри `.panel-body`;
  - **`radar` (B · Радар):** сетка плиток `.radar-grid` (логотип, `%` худшего окна либо `!` / `—`, нижний трек `.r-track`) + `.panel-body` выбранного движка ниже;
  - **`list` (C · Список):** аккордеон `.acc-list` с мини-шкалой и `%` в строке каждого движка и раскрытием всех окон `.acc-sub` по клику;
  - **`.diag-box` для ошибок квоты и `signedOut`:** заголовок с версией CLI, многострочный текст ошибки без обрезки в 1 строку и без серой точки справа, действия «Сменить аккаунт» (`engine.login`) и «Скрыть вкладку» (`sidebar.hideEngine`).
- [x] Обновить переводы в `src/webview/strings.ts` и `src/webview/strings.en.ts` и полностью покрыть все три режима (`tabs`, `radar`, `list`), одиночный движок, свёрнутую сводку, клавиатурную навигацию по вкладкам и `.diag-box` в `src/webview/engineLimits.test.ts`.

**Готово, когда:** `npx vitest run src/webview/engineLimits.test.ts`, `npm run typecheck` и `npm run lint` проходят с кодом `0`.

**Исполнение:** последовательно после этапа 1 (использует новые `SidebarLimitsMode` и `sidebar.hideEngine`; пересекается с этапом 3 по `Sidebar.tsx` и `media/hud.css`).

---

### 3. Секция «Сессии»: единый поиск с `/`, чистка заголовков, иконки провайдеров, ровный ритм `1/2 стр.` и `SidebarTaskPicker`

**Файлы:** `src/webview/sessionsView.ts`, `src/webview/sessionsView.test.ts`, `src/webview/components/Sidebar.tsx`, `src/webview/components/SidebarTaskPicker.tsx`, `media/hud.css`, `media/tasks.css`, `src/webview/sessionsDom.test.ts`, `src/webview/taskPickerDom.test.ts`.

- [x] В `src/webview/sessionsView.ts` (и `sessionsView.test.ts`) добавить чистый помощник `displaySessionTitle(s: Pick<SessionSummary, 'id' | 'title'>): { text: string; untitled: boolean }`:
  - сырые авто-ID (`title === id`, `/^session_[0-9a-f_-]{6,}$/i`, голый UUID) отображать как `Без названия · #<короткий_хвост>` (`Untitled · #...` в EN) с `untitled: true`;
  - срезать ведущий `https://github.com/` (и `http://github.com/`) у авто-заголовков из ссылок, сохраняя остальной текст;
  - обновить `subLabel` так, чтобы при наличии постоянной иконки провайдера слева не дублировать имя движка в компактном режиме, но сохранять его во второй строке `detailed` и в подсказке `data-tip`.
- [x] В `src/webview/components/Sidebar.tsx`, `media/hud.css` и `media/tasks.css`:
  - заменить `.tools` с внешней кнопкой `⚲` на единое поле `.search-wrap` (SVG-лупа слева, клавиша `/` для фокуса вне полей ввода, `Escape` и кнопка `✕` внутри поля только при непустом запросе);
  - перевести `SessionRow` (включая группы Jira `.tgp`, карточки секции `.tk` и блок «Архив») на левый слот `.s-ico` с `<BrandIcon provider={s.provider ?? 'claude'} />` и угловым бейджем живого статуса `.s-badge` (`live` / `wait` / `err`) с вырезом `box-shadow: 0 0 0 1.5px var(--row-bg)`;
  - выровнять плотность строк: в `data-list="compact"` все строки строго однострочные (для `waiting` справа перед временем — компактная пилюля `ждёт`), в `data-list="detailed"` — у всех двухстрочные;
  - защитить подтверждение инлайн-переименования по `Enter` проверкой `if (e.isComposing || e.keyCode === 229) return;` и для `untitled`-строк открывать поле переименования с пустым значением и `placeholder` отображаемого короткого имени.
- [x] В `src/webview/components/SidebarTaskPicker.tsx` заменить квадраты `.mk` на `<BrandIcon>`, убрать устаревший полноширинный режим `detailed={true}` и подписаться на сообщение хоста `{ type: 'task.picker.toggle' }` (открытие меню у правого верхнего края панели по клику на `+` в нативном `view/title`).
- [x] Обновить DOM- и unit-тесты в `src/webview/sessionsView.test.ts`, `src/webview/sessionsDom.test.ts` и `src/webview/taskPickerDom.test.ts` под новую разметку, `displaySessionTitle`, поиск по `/`, IME-safe `Enter` и `task.picker.toggle`.

**Готово, когда:** `npx vitest run src/webview/sessionsView.test.ts src/webview/sessionsDom.test.ts src/webview/taskPickerDom.test.ts`, `npm run typecheck` и `npm run lint` проходят с кодом `0`.

**Исполнение:** последовательно после этапа 2 (общие файлы `Sidebar.tsx`, `strings*.ts`, `media/hud.css`).

---

### 4. Страница «Боковая панель» в Настройках, живые миниатюры `SidebarPreview`, документация и сквозная приёмка

**Файлы:** `src/webview/components/Settings.tsx`, `src/webview/components/SettingsPreview.tsx`, `media/settings.css`, `src/webview/strings.ts`, `src/webview/strings.en.ts`, `src/webview/settingsDom.test.ts`, `README.md`, `README.ru.md`.

- [x] В `src/webview/components/Settings.tsx` и `src/webview/components/SettingsPreview.tsx`:
  - убрать карточку настройки `sidebar.top`;
  - обновить карточки `sidebar.limits` на 3 варианта (`tabs`, `radar`, `list`) с многодвижковой фикстурой (включая Kimi и показательный процент на Codex) и `sessionList.view` на 2 варианта (`compact`, `detailed`);
  - перевести превью шрифта панелей на странице «Внешний вид» (`Settings.tsx:1410`) с удалённого `part="top"` на `part="full"`.
- [x] В `media/settings.css` подогнать высоты и селекторы `.pv-side`, `.pv-limits`, `.pv-list`, `.pv-tasks` под новую разметку `.sidebar` без `.head`.
- [x] В `src/webview/settingsDom.test.ts`:
  - обновить эталонный список ключей `.set .key` (убрать `agentura.sidebar.top`), фикстуру настроек и проверки переключения карточек `sidebar.limits` (`tabs / radar / list`) и `sessionList.view` (`compact / detailed`);
  - заменить старый тест клика по `.head .gear` на проверку действий новой панели (кнопка «Скрыть вкладку» в `.diag-box` / переключение плотности).
- [x] Обновить описание боковой панели и настроек `agentura.sidebar.limits` / `agentura.sessionList.view` в `README.md` и `README.ru.md` (убрать упоминания `agentura.sidebar.top` и старых 5 режимов).

**Готово, когда:** `TZ=UTC npm run check`, `npm run test:integration`, `sh prototype/tools/layout-check.sh` и `git diff --check` проходят с кодом `0`.

**Исполнение:** последовательно после этапа 3 (замыкает все тестовые наборы и документацию).

---

## Промты исполнителей

### Этап 1

```text
Рекомендуемая модель в AGY: Gemini 4 Hydrogen (High) (или субагент flash/inherit через roadmap-run-agy).
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 1 из docs/roadmap/42-sidebar-redesign.md (схема настроек, мягкая миграция старых значений, нативные действия view/title и контракты SidebarProvider).
Читай: AGENTS.md, docs/roadmap/42-sidebar-redesign.md, package.json:38-248,455-545, package.nls.json, package.nls.ru.json, src/settings.ts:23-65,174-275,340-360,670-690,740-805, src/protocol.ts:315-355, src/shared/l10n.ts:125-165,375-415, src/extension/extension.ts:315-355,490-510, src/extension/sidebarView.ts:60-235, src/manifest.test.ts:145-240, src/settings.test.ts:135-160,360-395, src/extension/sidebarView.test.ts.
Уже решено: удаляем agentura.sidebar.top; agentura.sidebar.limits = ['tabs', 'radar', 'list'] (default 'tabs', мягкое чтение старых switch->tabs, table|stack|header->radar, active->list); agentura.sessionList.view = ['compact', 'detailed'] (default 'compact', старое dense->compact); в menus["view/title"] для view == agentura.sidebar добавляем agentura.sidebarNewChat ($(add), шлёт task.picker.toggle если панель видима, иначе agentura.newSession), agentura.refreshUsage ($(refresh)) и agentura.openSettings ($(gear)); добавляем сообщение sidebar.hideEngine для записи в sidebar.limitsHidden. Не делать: верстку новых режимов в EngineLimits.tsx/Sidebar.tsx и переписывание Settings UI (только минимальная правка типов, чтобы tsc проходил с 0).
Порядок: 1) package.json + package.nls*.json; 2) src/settings.ts + миграция; 3) src/protocol.ts + l10n.ts + extension.ts + sidebarView.ts + синхронизация типов в webview; 4) тесты settings.test.ts, manifest.test.ts, sidebarView.test.ts.
DoD: npx vitest run src/settings.test.ts src/manifest.test.ts src/extension/sidebarView.test.ts, npm run typecheck и npm run lint проходят с кодом 0.
Не трогай чужие изменения (.codex/config.toml, prototype/*). Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 2

```text
Рекомендуемая модель в AGY: Gemini 4 Hydrogen (High / XHigh) (или субагент через roadmap-run-agy).
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 2 из docs/roadmap/42-sidebar-redesign.md (блок «Лимиты»: уборка дубля шапки, брендовые SVG, режимы tabs/radar/list, сворачивание со сводкой и .diag-box).
Читай: AGENTS.md, docs/roadmap/42-sidebar-redesign.md, prototype/screens/sidebar-next.html:105-458,880-1092, src/webview/engineLimitsView.ts, src/webview/components/EngineLimits.tsx, src/webview/components/Sidebar.tsx:549-745, media/composer.css:255-285, media/hud.css:317-514, src/webview/strings.ts, src/webview/strings.en.ts, src/webview/engineLimits.test.ts.
Уже решено: общий BrandIcon на SVG из media/brands/ (openai-dark.svg и kimi-dark.svg для body.vscode-dark и body.vscode-high-contrast); убираем div.head («AGENTURA ⚙»), EnginePopup и старую таблицу .kv одиночного Claude; задаём container: sidebar / inline-size на .sidebar; реализуем 3 режима (tabs с .tab-lbl, min-inline-size: max-content у активной вкладки, ::after-индикатором и @container sidebar (max-width: 345px); radar плитками; list аккордеоном), однострочную сводку при свёрнутой секции «Лимиты» и .diag-box с кнопками «Сменить аккаунт» (engine.login) и «Скрыть вкладку» (sidebar.hideEngine). Не делать: переработку списка сессий, поиска и страницы Settings (этапы 3–4).
Порядок: 1) BrandIcon.tsx + правила .brand в media/hud.css; 2) EngineLimits.tsx + Sidebar.tsx (верх панели) + strings*.ts; 3) стили tabs/radar/list/.diag-box в media/hud.css; 4) полное обновление src/webview/engineLimits.test.ts.
DoD: npx vitest run src/webview/engineLimits.test.ts, npm run typecheck и npm run lint проходят с кодом 0.
Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 3

```text
Рекомендуемая модель в AGY: Gemini 4 Hydrogen (High) (или субагент через roadmap-run-agy).
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 3 из docs/roadmap/42-sidebar-redesign.md (секция «Сессии»: единый поиск с /, displaySessionTitle, логотипы движков с угловым статусом, ровная плотность 1/2 стр., IME-safe rename и SidebarTaskPicker).
Читай: AGENTS.md, docs/roadmap/42-sidebar-redesign.md, prototype/screens/sidebar-next.html:460-703,1094-1243,1420-1511, src/webview/sessionsView.ts, src/webview/components/Sidebar.tsx:150-440,750-892, src/webview/components/SidebarTaskPicker.tsx, media/hud.css:345-395, media/tasks.css:1-65, src/webview/sessionsView.test.ts, src/webview/sessionsDom.test.ts, src/webview/taskPickerDom.test.ts.
Уже решено: displaySessionTitle превращает пустые/сырые session_<hex> и UUID в «Без названия · #<хвост>» (untitled: true) и срезает ведущий https://github.com/ без мутации хранимого title; единый .search-wrap с лупой, хоткеем / и очисткой ✕ внутри поля; в каждой строке .s левый слот .s-ico держит BrandIcon + угловой .s-badge (live/wait/err) с вырезом --row-bg; в compact все строки строго в 1 линию (у waiting пилюля «ждёт» справа), в detailed — в 2 линии; при Enter в rename проверяем e.isComposing || e.keyCode === 229; SidebarTaskPicker переходит на BrandIcon и открывает меню по сообщению task.picker.toggle. Не делать: изменение карточек на странице Settings (этап 4) и замену .mk вне сайдбара (TaskPane / .tk-strip).
Порядок: 1) displaySessionTitle и subLabel в sessionsView.ts + sessionsView.test.ts; 2) поиск, SessionRow и задачи в Sidebar.tsx + SidebarTaskPicker.tsx; 3) стили в media/hud.css и media/tasks.css; 4) обновление sessionsDom.test.ts и taskPickerDom.test.ts.
DoD: npx vitest run src/webview/sessionsView.test.ts src/webview/sessionsDom.test.ts src/webview/taskPickerDom.test.ts, npm run typecheck и npm run lint проходят с кодом 0.
Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 4

```text
Рекомендуемая модель в AGY: Gemini 4 Hydrogen (High) (или субагент через roadmap-run-agy), финальная приёмка — Gemini 4 Carbon / Argon.
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 4 из docs/roadmap/42-sidebar-redesign.md (обновление страницы «Боковая панель» в Настройках, миниатюр SidebarPreview, README и прогон всех сквозных проверок).
Читай: AGENTS.md, docs/roadmap/42-sidebar-redesign.md, src/webview/components/Settings.tsx:860-880,1140-1220,1405-1420, src/webview/components/SettingsPreview.tsx:109-135,614-656, media/settings.css:507-550,634-640, src/webview/settingsDom.test.ts:65-80,140-150,335-400,580-645, README.md:105-130, README.ru.md:105-135.
Уже решено: карточка sidebar.top удаляется; sidebar.limits показывает 3 живые миниатюры (tabs, radar, list), sessionList.view — 2 миниатюры (compact, detailed); превью шрифта панелей на вкладке look использует part="full"; селекторы .pv-side в media/settings.css очищаются от удалённого .head; обновляются settingsDom.test.ts и оба README.
Порядок: 1) SettingsPreview.tsx + Settings.tsx + media/settings.css + strings*.ts; 2) обновление src/webview/settingsDom.test.ts; 3) README.md и README.ru.md; 4) полный прогон всех проверок репозитория и прототипа.
DoD: TZ=UTC npm run check, npm run test:integration, sh prototype/tools/layout-check.sh и git diff --check проходят с кодом 0.
Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

---

## Риски и открытые вопросы

- **Container Queries внутри уменьшенных превью Настроек (`SettingsPreview`):** в `.pv-side` применяется CSS `zoom` (`--pz`), поэтому фактическая inline-ширина `.sidebar` внутри карточки выбора известна заранее — на Этапе 4 проверить, чтобы миниатюра `tabs` не схлопывала подписи лишний раз либо имела адекватную ширину контейнера в `.pv-limits`.
- **Перекрытие настроек на уровне Workspace (`overriddenKeys`):** кнопка «Скрыть вкладку» в `.diag-box` пишет в Global `agentura.sidebar.limitsHidden`; как и для `sessionList.view` (`sidebarView.ts:206-211`), при перекрытии ключа в `.vscode/settings.json` рабочей папки нужно показать `overriddenView`, а не молча терять клик.
- **Чеклист ручной проверки после Этапа 4 (Extension Development Host, `F5`):**
  - В шапке контейнера `Agentura` видны нативные кнопки `+`, `↻`, `⚙`, дублирующей строки `AGENTURA ⚙` внутри панели нет; клик по `+` открывает меню «Новый чат / По задаче Jira…».
  - На узкой панели (~250–260px) при 4 движках в режиме **A · Вкладки** ни один логотип не обрезан, активная вкладка читается целиком; переключение в **B · Радар** и **C · Список** работает из Настроек и команды `Agentura: Вид лимитов…`.
  - В тёмной и светлой темах VS Code иконки OpenAI (`Codex`) и `Kimi Code` контрастны.
  - Строки списка сессий держат одинаковую высоту в `1 стр.` и `2 стр.`, `session_...` отображается как `Без названия · #...`, двойной клик переименовывает без срыва при IME-вводе.

## Порядок работы

Все 4 этапа выполняются **строго последовательно (`1 → 2 → 3 → 4`)** в одном рабочем дереве (пересекаются по `Sidebar.tsx`, `media/hud.css`, `strings*.ts` и общим DOM-тестам). После приёмки каждого этапа обновлять чекбоксы и блок `## Checkpoint` в этом файле. Коммит и сборка `.vsix` — только по отдельной команде пользователя.
