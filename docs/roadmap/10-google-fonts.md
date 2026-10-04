# Шрифты из Google Fonts: поиск и загрузка из расширения

> Статус: этап 1 принят 2026-10-04 (ветка `stage-1-google-fonts`); дальше — ручная проверка в живом VS Code и
> подтверждение решений: `10-google-fonts.pending.md`.
> Создан 2026-10-04 по запросу владельца («даём возможность выбирать и загружать шрифты из google fonts»), вариант 1 —
> поиск в QuickPick VS Code (каталог с превью в настройках — отвергнут как дорогой, может прийти потом поверх той же
> загрузки). Прототип не нужен: UI — штатный QuickPick плюс кнопка и ✕ в существующих карточках шрифтов.
> Предыдущее: шрифты в vsix (`scripts/fetch-fonts.mjs`, `scripts/fonts.json`, `media/fonts/`, `src/webview/bundledFonts.ts`,
> коммит `fc50439`), карточки шрифтов в ⚙ → «Вид» (`92cef95`).

## Цель

Команда «Agentura: Add Google Font…» (и кнопка «Добавить из Google Fonts…» под карточками шрифтов в ⚙ → «Вид»)
открывает QuickPick со всеми семействами Google Fonts: имя, категория, есть ли кириллица; уже скачанные — с ✓.
Выбранное семейство скачивается (woff2, latin / latin-ext / cyrillic, начертания 400–700 из доступных) в папку данных
расширения и сразу появляется в карточках выбора как «есть всегда», во всех открытых webview. У скачанного шрифта в
карточке — ✕ «удалить». После загрузки — уведомление с кнопкой «Применить» (ставит его шрифтом интерфейса или кода).

## Решения (2026-10-04, при планировании)

- **Каталог** — `GET https://fonts.google.com/metadata/fonts` (без ключа; неофициальный JSON сайта, проверен
  2026-10-04: ~2.7 MB, 1950 семейств). Тело может начинаться с `)]}'` — отрезать всё до первой `{`. Поля:
  `familyMetadataList[]` → `family`, `category` (`Sans Serif` / `Serif` / `Display` / `Handwriting` / `Monospace`),
  `subsets[]`, `fonts` (ключи вида `"400"`, `"400i"`), `popularity` (меньше — популярнее). Кэш каталога —
  `<globalStorage>/fonts/catalog.json`, живёт 7 дней; сеть недоступна — старый кэш, нет кэша — ошибка с текстом.
- **Загрузка** — `https://fonts.googleapis.com/css2?family=<Имя+С+Плюсами>:wght@<веса>&display=swap` с User-Agent
  современного Chrome (иначе не woff2), как в `scripts/fetch-fonts.mjs` (эталон разбора). Веса — пересечение
  `{400,500,600,700}` с нормальными (без `i`) ключами `fonts`; пусто — один ближайший к 400 нормальный вес. Наборы —
  `latin`, `latin-ext`, `cyrillic` из ответа; у вариативных семейств один файл на все веса — качать по url один раз.
- **Хранилище** — `<context.globalStorageUri>/fonts/<slug>/*.woff2` (slug — имя в нижнем регистре без пробелов),
  манифест `<…>/fonts/fonts.json` (`[{ family, kind: 'ui'|'code', files: string[] }]`, `kind` = `code` для категории
  `Monospace`, иначе `ui`) и сгенерированный `<…>/fonts/fonts.css` (`@font-face` с относительными url). Лицензию не
  качаем (это загрузка пользователем для себя, не распространение). Модуль `src/extension/googleFonts.ts`: чистые
  функции (`parseCatalog`, `pickWeights`, `parseFontCss`, `fontFaceCss`) + класс `UserFonts` (add / remove / list /
  `onDidChange`) поверх `node:fs/promises` и инъецируемого `fetch` — тестируется без VS Code. Разбор css2 — своя копия
  в TS (скрипт `.mjs` не импортирует TS; дублирование ~20 строк осознанное).
- **Webview** — `webviewOptions(extensionUri, fontsDir?)` добавляет `<globalStorage>/fonts` в `localResourceRoots`
  (все пять вызовов: `chatPanel.ts:161,239`, `debugPanel.ts:32`, `sidebarView.ts:35`, `settingsPanel.ts:24`).
  Сообщение `appearance` (`src/protocol.ts:123`) получает `userFonts: { ui: string[]; code: string[]; css?: string }`
  (`css` — `asWebviewUri(fonts.css)` + `?v=<mtime>` для сброса кэша; нет скачанных — без `css`). Webview держит один
  `<link id="user-fonts">` и меняет ему `href` (CSP `style-src ${cspSource}` это пропускает — тот же источник).
  `postAppearance` вызывается и на `UserFonts.onDidChange` (каждый хост подписывается, как на конфиг,
  `webviewHost.ts:96`).
- **Списки выбора** (`src/webview/fonts.ts`): скачанные — «всегда установлены», как `BUNDLED`; порядок карточек:
  `system-ui` → встроенные → скачанные → системные кандидаты. Модульные `UI_FONTS` / `CODE_FONTS` становятся функциями
  от скачанных (или сигнал в `store.ts` + функции) — как удобнее, без дублей.
- **Настройки** (`Settings.tsx`, `FontCards` `:203`, секция шрифтов `:700–770`): под карточками интерфейса и кода —
  кнопка «Добавить из Google Fonts…» → `{ type: 'fonts.add'; kind: 'ui' | 'code' }`; у карточки скачанного шрифта —
  ✕ → `{ type: 'fonts.remove'; family }`. Оба типа — в `FROM_WEBVIEW_TYPES` (`Record`, компилятор проверит).
  Хост: `fonts.add` → та же функция, что у команды, с фильтром по `kind` (`code` — только `Monospace`, `ui` — всё
  кроме); `fonts.remove` → удалить папку, переписать манифест и css. Удаление шрифта, выбранного в настройке, настройку
  не трогает — стек упадёт на шрифт VS Code.
- **QuickPick** — элементы по `popularity`; `label` — имя (у скачанных `$(check) ` впереди), `description` —
  категория + «кириллица», если `cyrillic` в `subsets`; `matchOnDescription: true`. Каталог грузится с
  `withProgress` в QuickPick (`busy`). Выбор скачанного — ничего не качать, сразу уведомление «Применить».
  Загрузка — `withProgress` (notification) «Скачиваю <имя>…»; ошибка — `showErrorMessage` + `log.warn`.
  «Применить» пишет `font.interface` (ui) или `font.code` (code) через тот же `writeSetting`, что у `pickFeedStyle`
  (`extension.ts:120–145`). Команда `agentura.addGoogleFont`, категория Agentura, строки ru/en в `package.nls*.json`
  и `src/shared/l10n.ts`.
- **Сеть** — только по действию пользователя (команда / кнопка); при старте ничего не качаем.
- Кнопка и для шрифта панелей — по решению владельца 2026-10-04: `fonts.add` с `kind: 'panels'` открывает QuickPick
  со всеми семействами, «Применить» пишет `font.panels`; `kind` в манифесте — по-прежнему от категории.

## Решения (2026-10-04, по итогам приёмки этапа 1)

- **Пути и данные из сети:** имя семейства — только `[A-Za-z0-9][A-Za-z0-9 ._-]*` (весь каталог 2026-10-04 — латиница,
  цифры, пробелы; коллизий slug нет), slug — `[a-z0-9-]`, пустой — ошибка; `remove` трогает только семейства из
  манифеста. Файлы — только с `https://fonts.gstatic.com/`, сигнатура `wOF2`, до 8 MB; `font-weight` и
  `unicode-range` из css2 проверяются регулярками — в `fonts.css` не попадает ничего, кроме ожидаемого. Таймаут
  запроса 60 с (иначе повисший запрос держит очередь правок).
- **Запись:** `fonts.json`, `fonts.css`, `catalog.json` — через временный файл и `rename`; загрузка — во временную
  папку с уникальным именем. Кэш каталога проверяется по форме записей; `fetchedAt` из будущего — не свежий.
- **Несколько окон VS Code** (globalStorage общий): webview перечитывает манифест при открытии и при смене настроек
  вида; `FileSystemWatcher` не ставим. Одновременная загрузка в двух окнах может потерять запись в манифесте —
  принято как редкий случай (подробнее — pending).
- **Рядом со шрифтом** — `<slug>/face.css`, `fonts.css` склеивается из них (отклонение исполнителя, здравое: не надо
  хранить разбор css2 в манифесте). ✕ — кнопка рядом с карточкой в обёртке `.cw` (кнопка внутри `role=radio`
  невалидна); стрелки на ✕ выбор не меняют, после ✕ фокус — на выбранную карточку. Добавление и удаление из
  настроек идут в хост через команды; служебная `agentura.removeGoogleFont` в палитру не выносится.
- `appearance` отправляется со счётчиком: устаревшее (асинхронное чтение манифеста) не перебивает свежее.

## Этап 1 — загрузка из Google Fonts · sonnet, high

- [x] `src/extension/googleFonts.ts` + `googleFonts.test.ts`: `parseCatalog` (префикс `)]}'`), `pickWeights`,
      `parseFontCss` (только нужные наборы, дедуп по url), `fontFaceCss`; `UserFonts` add / remove / list / onDidChange
      на временной папке с поддельным `fetch`; кэш каталога 7 дней и откат на старый кэш при ошибке сети
- [x] Команда `agentura.addGoogleFont` (QuickPick, загрузка, «Применить») в `extension.ts`, `package.json` + nls, l10n
- [x] `webviewOptions(…, fontsDir)` во всех вызовах; `appearance.userFonts`; `<link id="user-fonts">` в webview;
      рассылка на `onDidChange`
- [x] `fonts.ts`: скачанные в списках и «установлены»; `Settings.tsx`: кнопка «Добавить из Google Fonts…» и ✕;
      `fonts.add` / `fonts.remove` в протоколе и хосте; строки ru/en
- [x] Тесты: протокол (`fonts.add`, `fonts.remove`), `appearance` (ссылка ставится / меняется / снимается),
      `settingsDom` (кнопка шлёт `fonts.add` с `kind`, ✕ только у скачанных и шлёт `fonts.remove`), `fonts`
      (порядок, «установлены»)
- [x] CHANGELOG (англ.), `npm run check` зелёный

Готово, когда: `npm run check` зелёный; тесты выше есть и проходят.

## Промты

### Сессия 1 — загрузка из Google Fonts · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura`, ветка `stage-1-google-fonts` (уже создана от main, дерево чистое).
Задача: дать пользователю искать шрифт в каталоге Google Fonts через QuickPick VS Code, скачивать его в папку данных
расширения и выбирать в карточках шрифтов настроек. Доработка: карточки шрифтов, встроенные шрифты и сообщение
`appearance` уже есть.

Читай: этот файл (раздел «Решения» — контракт). Эталон разбора css2 — `scripts/fetch-fonts.mjs`. Правил репо
(CLAUDE.md) нет; стиль — как в соседнем коде: комментарии по-русски, коротко; коммиты и CHANGELOG — по-английски.

Точки входа:
- `src/extension/webviewHost.ts`: `:8` `webviewOptions`, `:40–50` `styleUris`, `:56` `APPEARANCE_KEYS`, `:63`
  `postAppearance`, `:96` подписка на конфиг.
- Вызовы `webviewOptions`: `chatPanel.ts:161,239`, `debugPanel.ts:32`, `sidebarView.ts:35`, `settingsPanel.ts:24`.
- `src/extension/extension.ts`: `:25` `activate` (`context.globalStorageUri`), `:120–145` `pickFeedStyle` (эталон
  QuickPick + `writeSetting`), `:192` регистрация команд.
- `src/shared/l10n.ts` — строки хоста (`hostStrings`, рядом с `feedStylePlaceholder`).
- `package.json:54` `contributes.commands`; `package.nls.json` / `package.nls.ru.json`.
- `src/protocol.ts:123` сообщение `appearance`; `FROM_WEBVIEW_TYPES` — `Record` по типам (добавить новые ключи).
- `src/webview/appearance.ts` — `applyAppearance` (сюда — `<link id="user-fonts">`), `appearance.test.ts`.
- `src/webview/fonts.ts` — `BUNDLED`, `UI_FONTS` / `CODE_FONTS`, `isInstalled`; `fonts.test.ts`.
- `src/webview/components/Settings.tsx`: `:203` `FontCards`, `:700–770` секция шрифтов; `settingsDom.test.ts`.
- Обработка сообщений настроек на хосте — `src/extension/settingsController.ts` / `settingsPanel.ts` (найти, где
  разбираются входящие `settings.*`, и добавить `fonts.add` / `fonts.remove` рядом).
Точки входа проверены при планировании — не перечитывать ради подтверждения, открывать только фрагмент, который
правишь.

Уже решено, не переспрашивать: всё из раздела «Решения». Кратко: каталог — `fonts.google.com/metadata/fonts` с кэшем
7 дней; загрузка — css2 с UA Chrome, веса 400–700 из доступных, наборы latin / latin-ext / cyrillic; хранилище —
`globalStorage/fonts` с манифестом и `fonts.css`; лицензию не качаем; `appearance.userFonts` + `<link
id="user-fonts">`; кнопка «Добавить из Google Fonts…» и ✕ в карточках; «Применить» в уведомлении; сеть — только по
действию пользователя.

Порядок:
1. `googleFonts.ts` + тест (сначала тест).
2. Хост: `UserFonts` в `activate`, команда, `webviewOptions`, `appearance.userFonts`, рассылка, `fonts.add/remove`.
3. Webview: ссылка на css, списки в `fonts.ts`, кнопка и ✕ в `Settings.tsx`, строки.
4. Тесты протокола / appearance / settingsDom / fonts; CHANGELOG.
5. `npm run check > /tmp/agentura-check.log 2>&1; tail -40 /tmp/agentura-check.log` — до зелёного.
Галочки в этом файле (этап 1) — по факту проверки.

DoD: `npm run check` зелёный (typecheck, lint, test, build). Живой запрос к Google в тестах — нет (поддельный `fetch`).
Один ручной прогон загрузки допустим: временный скрипт в `/tmp`, который через собранный модуль качает «Onest» во
временную папку и печатает манифест, — затем удалить папку.

Не делать: каталог с превью в webview, CSP с доменами Google, лицензии, правки `scripts/fetch-fonts.mjs` и
`media/fonts/`, автозагрузку при старте; «заодно улучшить» — нет. Вопрос, на который нет ответа здесь, — в отчёт.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от плана /
не проверено / открытые вопросы. Отчёт — единственное, что увидит приёмка.
