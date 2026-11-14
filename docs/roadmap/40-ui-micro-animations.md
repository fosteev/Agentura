# 40. Микроанимации интерфейса (уровень 1: чистый CSS и выключатель `agentura.ui.animations`)

> Статус: выполнено · 2026-11-13. Все 3 этапа (`1 → 2 → 3`) реализованы и приняты независимой проверкой.

## Checkpoint

**2026-11-13 · принят Этап 3 / 3 (`roadmap-run-agy` завершён).**

- Принятые этапы: `3 / 3` (`Этап 1` с 1-й попытки; `Этап 2` с 1-й попытки; `Этап 3` с 1-й попытки).
- Изменённые файлы по этапам:
  - Этап 1: `package.json`, `package.nls.json`, `package.nls.ru.json`, `src/settings.ts`, `src/settings.test.ts`, `src/protocol.ts`, `src/extension/webviewHost.ts`, `src/webview/appearance.ts`, `src/webview/appearance.test.ts`, `src/webview/components/Settings.tsx`, `src/webview/strings.ts`, `src/webview/strings.en.ts`, `src/webview/settingsDom.test.ts`, `media/tokens.css`, `src/webview/statesDom.test.ts`.
  - Этап 2: `media/hud.css`, `media/composer.css`, `src/webview/composerLayouts.test.ts`, `src/webview/engineLimits.test.ts`.
  - Этап 3: `media/hud.css`, `media/webview.css`, `media/tasks.css`, `media/agents-graph.css`, `src/webview/agentsGraphDom.test.ts`, `README.md`, `README.ru.md`.
- Ветка / worktree / `cwd`: ветка `main` (`origin/main` на `efb0b63`), основной worktree, подтверждённый `cwd`: `/Users/fost/Projects/Agentura`.
- Выполненные финальные проверки приёмки (основной чат):
  - `TZ=UTC npm run check` — код `0` (`tsc --noEmit`, `eslint .`, `vitest run` — 163 файла / 2414 тестов, `esbuild.mjs`);
  - `npm run test:integration` — код `0` (`extension.test.js` в VS Code Extension Host);
  - `git diff --check` — код `0`.
- Конфигурация запуска: основной чат AGY — `Gemini 4 Carbon (Medium)` (`f7bdaa45-b47e-4b58-b487-dae095f032fa`); субагенты-исполнители (`invoke_subagent`, `TypeName: "self"`, `Model: "inherit"`, `Workspace: "inherit"`): Этап 1 — `c20e8018-0cef-42b6-adb0-1244daf82929`, Этап 2 — `46f754d8-b898-433c-a15d-0950cd907ff4`, Этап 3 — `5c0f6762-937d-4df6-9090-361426c99324`.
- Dirty / unpushed: 25 изменённых файлов Этапов 1–3 (`M`) + `?? docs/roadmap/40-ui-micro-animations.md`; чужие untracked файлы `?? .codex/config.toml` и `?? docs/roadmap/39-kimi-code-support.md` сохранены без изменений. Коммит, сборка `.vsix` и push не выполнялись.
- Блокер: нет.
- Следующий шаг: ручная визуальная проверка по чеклисту в Extension Development Host (`F5`), затем коммит / сборка `.vsix` по явному запросу пользователя.
- Промт кросс-клиентской финальной приёмки: `В /Users/fost/Projects/Agentura проверь полный git diff по docs/roadmap/40-ui-micro-animations.md и прогони TZ=UTC npm run check && npm run test:integration && git diff --check.`

## Цель

Добавить ненавязчивые, быстрые (`120–220 мс`) CSS-микроанимации для приборов контекста и лимитов, выпадающих меню/попапов, дискретных карточек ленты и живого графа субагентов — без сторонних библиотек, без усложнения Preact-разметки и с мгновенным глобальным выключателем `agentura.ui.animations`.

## Контекст и ограничения

### Подтверждённые факты по коду
- **Среда рендера:** вебвью (`chat`, `sidebar`, `settings`, `agents`) работают на Preact + `@preact/signals` и статических таблицах стилей `media/*.css` (`src/extension/webviewHost.ts:55-73`), минимальный движок — VS Code `^1.100.0` (современный Chromium с поддержкой CSS `@property` и `@keyframes`).
- **Доступность и отключение движения:** в `media/tokens.css:93-95` уже задан глобальный сброс `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }`, который проверяется регрессионным тестом `src/webview/statesDom.test.ts:416-421`.
- **Канал доставки настроек вида:** `APPEARANCE_KEYS` и `postAppearance` в `src/extension/webviewHost.ts:78-125` рассылают сообщение `{ type: 'appearance', ... }` (`src/protocol.ts:177-190`) во все открытые поверхности сразу при изменении настроек VS Code; `applyAppearance` (`src/webview/appearance.ts:81-94`) синхронно обновляет переменные `:root` и `data-*` атрибуты `document.body` (например, `body.dataset.hlTheme`).
- **Стриминг ленты и масштаб:**
  - На `#root` действует `zoom: var(--ui-zoom, 1)` (`media/webview.css:11-14`), а на `.log` — `zoom: calc(var(--feed-zoom, 1) / var(--ui-zoom, 1))` (`media/hud.css:108`). Чистые CSS `opacity`, `transform`, `width` и `--p` работают корректно при любом `--ui-zoom`.
  - Во время ответа модели `.log .txt` обновляется десятками `text.delta` в секунду; анимация высоты или layout-свойств на стримящихся текстовых/инструментальных строках запрещена, чтобы не ломать автоскролл ленты.
  - В `src/webview/settingsDom.test.ts:337-395` проверяется полный отсортированный список всех ключей `.set .key` на странице настроек — при добавлении `agentura.ui.animations` этот список нужно синхронно обновить.
- **Тестовая среда:** DOM-тесты работают в `jsdom` (нет Web Animations API `el.animate` и `document.startViewTransition`), поэтому весь скоуп этого roadmap опирается исключительно на декларативный CSS.

### Принятые допущения и границы
- **Допущение по настройке:** единый булев тумблер `agentura.ui.animations` (по умолчанию `true`) на странице ⚙ → «Внешний вид» (`look`), пробрасываемый в `body[data-motion="off"]` при значении `false`. Системный `prefers-reduced-motion: reduce` всегда имеет приоритет и выключает анимации независимо от настройки.
- **Вне скоупа (оставлено на следующие итерации при необходимости):** анимация раскрытия/сворачивания высоты аккордеонов с изменением DOM (`grid-template-rows: 0fr → 1fr`), exit-анимации удаляемых узлов Preact, `document.startViewTransition` между вкладками и FLIP-перестроение координат карточек `AgentsGraph`.

---

## Этапы

### 1. Настройка `agentura.ui.animations`, токены движения и единый выключатель `data-motion`

**Файлы:** `package.json`, `package.nls.json`, `package.nls.ru.json`, `src/settings.ts`, `src/settings.test.ts`, `src/protocol.ts`, `src/extension/webviewHost.ts`, `src/webview/appearance.ts`, `src/webview/appearance.test.ts`, `src/webview/strings.ts`, `src/webview/strings.en.ts`, `src/webview/components/Settings.tsx`, `src/webview/settingsDom.test.ts`, `media/tokens.css`, `src/webview/statesDom.test.ts`.

- [x] Объявить настройку `agentura.ui.animations` (`type: "boolean"`, `default: true`) в `package.json` и локализациях `package.nls.json` / `package.nls.ru.json`.
- [x] Добавить чтение/запись и валидацию `'ui.animations': boolean` в `src/settings.ts` (по аналогии с `'diff.syntaxHighlighting'`), покрыть в `src/settings.test.ts`.
- [x] Расширить сообщение `appearance` в `src/protocol.ts` полем `animations?: boolean`, добавить `'agentura.ui.animations'` в `APPEARANCE_KEYS` и `postAppearance` в `src/extension/webviewHost.ts:78-125`.
- [x] В `applyAppearance` (`src/webview/appearance.ts:81-94`) выставлять `body.dataset.motion = m.animations === false ? 'off' : 'on'` и покрыть в `src/webview/appearance.test.ts` (включая дефолт `'on'`, когда поле не передано).
- [x] Добавить тумблер `<Toggle k="ui.animations" value={v['ui.animations']} />` в раздел `look` (`src/webview/components/Settings.tsx:1304-1310`, рядом с `ui.fontSize`), переводы в `src/webview/strings.ts` и `src/webview/strings.en.ts`, обновить фикстуру и список ключей в `src/webview/settingsDom.test.ts`.
- [x] В `media/tokens.css` добавить токены длительности/кривых (`--dur-fast: 120ms`, `--dur: 180ms`, `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`) и правило `body[data-motion="off"] *, body[data-motion="off"] *::before, body[data-motion="off"] *::after { animation: none !important; transition: none !important; }`; дополнить проверку в `src/webview/statesDom.test.ts`.

**Готово, когда:** `npx vitest run src/settings.test.ts src/webview/appearance.test.ts src/webview/settingsDom.test.ts src/webview/statesDom.test.ts` и `npm run typecheck` проходят с кодом `0`.

**Исполнение:** последовательно (базовый контракт `tokens.css` и `data-motion`, от которого зависят этапы 2 и 3). В AGY — субагент (`roadmap-run-agy`), в Codex — отдельная сессия или текущий чат.

---

### 2. Плавные шкалы приборов, лимитов и переключателей (HUD, сайдбар, композер)

**Файлы:** `media/hud.css`, `media/composer.css`, `src/webview/composerLayouts.test.ts`, `src/webview/engineLimits.test.ts`.

- [x] В `media/hud.css` добавить плавный переход ширины и цвета (`transition: width var(--dur) var(--ease-out), background-color var(--dur) ease`) для всех полос лимитов боковой панели:
  - `.sidebar .lim .row .bar i` (`hud.css:336`),
  - `.sidebar .head .hl .m i b` (`hud.css:417`),
  - `.sidebar .L .bar i` (`hud.css:438`),
  - `.sidebar .grid .c .bar i` (`hud.css:468`),
  - `.sidebar .one .bar i` (`hud.css:478`),
  - `.sidebar .hx .m i.b b` (`hud.css:497`).
- [x] В `media/hud.css` добавить плавные переходы микроконтролов:
  - секционные и движковые шевроны `.sidebar .one .tw` (`hud.css:475-476`), кнопки сегментов `.sidebar .seg button` (`hud.css:456-458`);
  - тумблеры в выпадающих меню `.menu .it .sw` и `.menu .it .sw::after` (`hud.css:289-292` — `background-color` и `left`/`transform` за `var(--dur-fast)`).
- [x] В `media/hud.css` и `media/composer.css` анимировать индикаторы контекста во всех 6 раскладках композера:
  - классические блоки `.blocks i` и частичное заполнение `.blocks i.part::after` (`hud.css:27-31`);
  - полоса контекста `.compose:not([data-layout="classic"]) .bar > i` (`composer.css:11`);
  - зарегистрировать `@property --p` (`syntax: '<number>'; inherits: true; initial-value: 0;`) в `media/composer.css`, чтобы кольцо `.ring` (`conic-gradient`, `composer.css:7-8`) и верхняя кромка прогресса в `minimal` / `statusline` (`composer.css:72-73, 99-100`) плавно интерполировали `--p` за `var(--dur) var(--ease-out)`.
- [x] Добавить проверки ключевых CSS-правил (`@property --p`, переходы шкал) в `src/webview/composerLayouts.test.ts` и `src/webview/engineLimits.test.ts`.

**Готово, когда:** `npx vitest run src/webview/composerLayouts.test.ts src/webview/engineLimits.test.ts` и `npm run check` проходят с кодом `0`.

**Исполнение:** последовательно после этапа 1 (использует `--dur` / `--dur-fast` / `--ease-out` и оба трогают `media/hud.css`).

---

### 3. Появление меню, попапов, дискретных карточек ленты и живые рёбра `AgentsGraph`

**Файлы:** `media/hud.css`, `media/webview.css`, `media/tasks.css`, `media/agents-graph.css`, `src/webview/agentsGraphDom.test.ts`, `README.md`, `README.ru.md`.

- [x] Добавить быстрый входной keyframe (`120 мс`, `opacity: 0 → 1` и лёгкий сдвиг `translateY(±4px → 0)` без влияния на поток документа) для всплывающих слоёв:
  - `.menu.up` (снизу вверх) и `.menu.down` (сверху вниз) в `media/hud.css:277-279`;
  - попап лимитов `.sidebar > .pop` в `media/hud.css:503`;
  - поповер создания чата задачи `.ncp` в `media/tasks.css`.
- [x] Добавить мягкое появление (`var(--dur) var(--ease-out)`, `opacity` + `translateY(3px → 0)`) только для **дискретных нестримящихся** блоков ленты чата (`media/hud.css`, `media/webview.css`):
  - карточки запросов `.ask` (разрешения инструментов, вопросы агента, план — `hud.css:219`);
  - верхний `.banner` (`hud.css:267`);
  - раскрываемые по клику детали инструмента `.log .tool-full` и мыслей `.log .txt.think-full` (`webview.css:71, 74`), **не затрагивая** обычный `.log .txt` и `.log .e`.
- [x] Оживить граф субагентов в `media/agents-graph.css`:
  - бегущий пунктир (`@keyframes gmap-flow` по `stroke-dashoffset`) на активных связях `.gmap svg.edges path.busy` (`agents-graph.css:20`);
  - плавная ширина и цвет полосы контекста главного узла `.gmap .n.main .ctxb i` (`agents-graph.css:42`);
  - мягкое появление новых узлов `.gmap .n` (`opacity` за `var(--dur-fast)`) и плавная смена рамки/выделения (`border-color`, `box-shadow` на `.gmap .n`).
- [x] Дополнить регрессионный тест стилей графа в `src/webview/agentsGraphDom.test.ts` и кратко упомянуть `agentura.ui.animations` в разделе настроек `README.md` и `README.ru.md`.

**Готово, когда:** `TZ=UTC npm run check`, `npm run test:integration` и `git diff --check` проходят с кодом `0`.

**Исполнение:** последовательно после этапа 2 (пересекается по `media/hud.css`).

---

## Промты исполнителей

### Этап 1

```text
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 1 из docs/roadmap/40-ui-micro-animations.md (настройка agentura.ui.animations, токены движения и выключатель body[data-motion="off"]).
Читай: AGENTS.md, docs/roadmap/40-ui-micro-animations.md, package.json, package.nls.json, package.nls.ru.json, src/settings.ts:1-160, src/protocol.ts:175-195, src/extension/webviewHost.ts:77-125, src/webview/appearance.ts:26-101, src/webview/components/Settings.tsx:1300-1320, src/webview/settingsDom.test.ts:335-400, media/tokens.css:78-95, src/webview/statesDom.test.ts:415-425.
Уже решено: ключ agentura.ui.animations (boolean, default true), прокидывается через сообщение appearance во все поверхности webview и выставляет body.dataset.motion = "on" | "off"; в media/tokens.css добавляются --dur-fast (120ms), --dur (180ms), --ease-out и сброс анимаций/переходов для body[data-motion="off"] наравне с prefers-reduced-motion. Не делать: сами анимации шкал, меню и графа (это этапы 2–3), сторонние пакеты.
Порядок: 1) схема в package.json + nls; 2) src/settings.ts + settings.test.ts; 3) protocol.ts + webviewHost.ts + appearance.ts + appearance.test.ts; 4) Settings.tsx + strings*.ts + settingsDom.test.ts; 5) media/tokens.css + statesDom.test.ts.
DoD: npx vitest run src/settings.test.ts src/webview/appearance.test.ts src/webview/settingsDom.test.ts src/webview/statesDom.test.ts и npm run typecheck проходят с кодом 0.
Не трогай чужие изменения (.codex/config.toml, docs/roadmap/39-kimi-code-support.md и др.). Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 2

```text
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 2 из docs/roadmap/40-ui-micro-animations.md (плавные шкалы лимитов, приборов контекста и микроконтролов в HUD, сайдбаре и композере).
Читай: AGENTS.md, docs/roadmap/40-ui-micro-animations.md, media/tokens.css, media/hud.css:25-50,285-295,330-340,410-505, media/composer.css:6-105, src/webview/composerLayouts.test.ts, src/webview/engineLimits.test.ts.
Уже решено: используем токены --dur, --dur-fast, --ease-out из Этапа 1; в media/composer.css регистрируем @property --p (syntax: '<number>', inherits: true, initial-value: 0) для плавной интерполяции conic-gradient кольца .ring и кромки прогресса statusline/minimal; плавные переходы ширины и цвета на всех полосах лимитов сайдбара и тумблерах .sw. Не делать: JS-анимации, изменение DOM-структуры компонентов, анимации меню/ленты/графа (это этап 3).
Порядок: 1) переходы полос лимитов и тумблеров в media/hud.css; 2) @property --p и переходы индикаторов контекста в media/hud.css и media/composer.css; 3) регрессионные тесты в composerLayouts.test.ts и engineLimits.test.ts.
DoD: npx vitest run src/webview/composerLayouts.test.ts src/webview/engineLimits.test.ts и npm run check проходят с кодом 0.
Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

### Этап 3

```text
Работаем в /Users/fost/Projects/Agentura. Задача: выполнить Этап 3 из docs/roadmap/40-ui-micro-animations.md (появление меню, попапов, дискретных карточек ленты и анимация активных рёбер/узлов AgentsGraph + документация).
Читай: AGENTS.md, docs/roadmap/40-ui-micro-animations.md, media/hud.css:218-295,500-508, media/webview.css:68-115, media/tasks.css, media/agents-graph.css:17-48, src/webview/agentsGraphDom.test.ts, README.md, README.ru.md.
Уже решено: быстрый вход 120ms для .menu.up/.menu.down, .sidebar > .pop и .ncp; мягкий вход для .ask, .banner, .log .tool-full и .log .txt.think-full; КАТЕГОРИЧЕСКИ не вешать анимации на обычный стримящийся .log .txt и строки .log .e; в media/agents-graph.css добавить бегущий пунктир stroke-dashoffset для .gmap svg.edges path.busy, переход ширины .ctxb i и мягкий вход/рамку .gmap .n; описать agentura.ui.animations в README.md и README.ru.md. Не делать: изменение координатной раскладки графа, JS-анимации.
Порядок: 1) меню/попапы и дискретные карточки ленты в hud.css, webview.css, tasks.css; 2) граф агентов в agents-graph.css + тест в agentsGraphDom.test.ts; 3) README.md и README.ru.md; 4) полные проверки.
DoD: TZ=UTC npm run check, npm run test:integration и git diff --check проходят с кодом 0.
Не трогай чужие изменения. Не коммить и не пушь без явного требования.
В отчёте: сделано, отклонения, непроверенное, открытые вопросы.
```

## Риски и открытые вопросы

- **Дёрганье автоскролла ленты при стриминге:** закрыто архитектурно — селекторы анимаций в ленте ограничены `.ask`, `.banner`, `.tool-full` и `.think-full`; основной текстовый поток `.log .txt` и строки вызовов `.log .e` не трогаются.
- **Превью в окне настроек (`SettingsPreview`):** карточки выбора вида монтируют мини-превью один раз при открытии вкладки `look`; короткие переходы `120–180 мс` не мешают статическому превью и автоматически выключаются при переключении тумблера `agentura.ui.animations`.
- **Скриншоты `scripts/readme-shots/run.mjs`:** при генерации скриншотов в headless-браузере короткий входной `@keyframes` завершится за `< 200 мс` до снимка (либо может отключаться через `prefers-reduced-motion: reduce`).
- Открытых вопросов, меняющих скоуп, нет.

## Порядок работы

1. Выполнить этапы строго последовательно `1 → 2 → 3` в одной рабочей копии (этапы делят `media/hud.css` и опираются на токены этапа 1).
2. В AGY запускать через маршрут `roadmap-run-agy` (оркестратор в основном чате + чистый субагент `self` на каждый этап + запись `Checkpoint` после приёмки этапа); в Codex — через `/roadmap-run`.
3. После принятия этапа 3 выдать пользователю короткий чеклист визуальной проверки в окне расширения (плавность шкал, открытие меню, бегущие рёбра `AgentsGraph`, мгновенное отключение тумблером `agentura.ui.animations`), затем коммит и пересборка `.vsix` по команде.
