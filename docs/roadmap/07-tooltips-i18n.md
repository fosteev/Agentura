# Тултипы на элементах управления и язык интерфейса ru/en

> Статус: готово · закрыт владельцем 2026-10-03 · этапы 1–5 в `main` (ветка `stage-2-i18n-webview`), `.vsix` 0.2.0
> переустановлен поверх · создан 2026-10-02 по запросу владельца.
> Исполнитель отмечает чекбоксы по ходу работы. Дизайн владелец принимает только картинками в галерее-артефакте.

## Цель

1. Вместо системного `title` (серый OS-тултип с задержкой ~1 с) — аккуратные тултипы в стиле hover-виджета VS Code
   на всех элементах управления всех webview (чат, боковая панель, настройки).
2. Интерфейс на русском и английском; по умолчанию — язык VS Code.

## Решения (2026-10-02, при планировании; на подтверждение — в `07-tooltips-i18n.pending.md`)

- **«Системный» = язык интерфейса VS Code** (`vscode.env.language`): `ru*` → русский, всё остальное → английский.
  Язык ОС расширению недоступен надёжно, а VS Code сам показывает свой язык — расхождения не будет.
- Настройка `agentura.language`: `auto` (по умолчанию) | `ru` | `en`. Строка в настройках, раздел «Вид».
- **Смена языка применяется после перезагрузки окна**: уведомление «Язык Agentura применится после перезагрузки
  окна» с кнопкой «Перезагрузить» (`workbench.action.reloadWindow`). Живой перерендер чата посреди хода рискован
  (стейт, очередь), а VS Code сам меняет язык так же.
- Язык в webview приходит атрибутом `<html lang="ru|en">` из `buildWebviewHtml` — до первого рендера, без нового
  сообщения протокола. `strings.ts` выбирает словарь по нему при загрузке модуля; нет атрибута → русский (так
  существующие DOM-тесты остаются как есть).
- Заголовки команд и описания настроек (`package.json`) — через `package.nls.json` (en) + `package.nls.ru.json`.
  Они следуют только языку VS Code, не `agentura.language` — ограничение API, принимаем.
- Не переводим: текст, который уходит модели (`src/shared/prompt.ts`), логи (`Logger`), debug-панель, данные
  сессий и ответы движка.
- Тултип — один слой на поверхность, делегирование по `[data-tip]` (не обёртка вокруг каждой кнопки): задержка
  500 мс, «тёплый» режим (следующий — сразу, если предыдущий скрыт < 300 мс назад), под элементом, переворот вверх
  при нехватке места, прижим к краям вьюпорта 4 px; скрытие на уход курсора/blur/Esc/скролл/нажатие; по фокусу с
  клавиатуры (`:focus-visible`) тоже показывается. Цвета — `--vscode-editorHoverWidget-*`. Переносы `\n` в тексте
  сохраняются. Ссылки markdown (`markdown.ts`) остаются с нативным `title`.

## Этапы

### 1. Прототип тултипа и строки «Язык» в настройках
- [x] `prototype/shared/tooltip.css` + `tooltip.js` (делегирование, задержка, переворот, прижим; хэш `#tip-<имя>`
  показывает тултип сразу — для снимков)
- [x] Подключены на всех экранах; `title` → `data-tip` переводит сам `tooltip.js` на лету (в разметке экранов
  `title` оставлен — меньше правок, вид тот же)
- [x] Строка «Язык интерфейса» в `prototype/screens/settings.html`, раздел «Вид»
- [x] Галерея v21: раздел «Тултипы и язык» — вырезки у ⚙ (прижим к краю панели), ↻ (две строки), вида списка
  (перенос), «скрыть панель» (правый край), «отправить» (переворот вверх, клавиша плашкой); обе темы
- [x] Владелец принял вид (2026-10-03, как в галерее v21)

**Готово, когда:** владелец выбрал/принял вид по галерее.
**Сессия:** opus, в чате (вёрстка на выбор владельца). Параллельно с этапом 2 — файлы не пересекаются.

### 2. Язык: настройка, каркас и перевод webview
- [x] `src/settings.ts`: ключ `language` (`auto|ru|en`), `resolveLanguage(raw, envLanguage)`, тесты
- [x] `package.json`: свойство `agentura.language`
- [x] `html.ts`/`webviewHost.ts`: `lang` в оболочку; все места `renderWebview` передают разрешённый язык
- [x] `strings.ts`: тип словаря, `ru` + `en` (`strings.en.ts`), выбор по `<html lang>`; английский plural
- [x] Захардкоженные строки webview (~45) — в словарь; даты/числа — по языку
- [x] Строка «Язык» в настройках (раздел «Вид»), уведомление о перезагрузке при смене
- [x] Тесты: `strings.test.ts` (в `en` нет кириллицы, ключи совпадают), `resolveLanguage`, `lang` в html

**Готово, когда:** `npm run check` зелёный; с `agentura.language: en` все три поверхности по-английски (тест
строк + чтение кода; F5 — у владельца).
**Сессия:** sonnet, high. Ветка `stage-2-i18n-webview`.

**Решения (2026-10-02, по итогам сессии 2, приняты на приёмке):**
- Тип словаря — `Ui = Widen<typeof ru>` (строковые литералы → `string`, функции и кортежи как есть), `efforts` —
  `readonly EffortLevel[]`; верхний `as const` у `ru` остался. Отвергнуто: снимать `as const` — пришлось бы
  руками типизировать кортежи `modes`/`commands`.
- `strings.en.ts` импортирует только тип `Ui` (`import type`) — циклического импорта в рантайме нет.
- В английском словаре «Русский» в списке языков — кириллицей (название языка на нём самом); тест кириллицы
  пропускает только этот путь.
- Кириллица вне словаря осталась осознанно: регулярки разбора плана `cardView.ts:62-63` (план от модели может
  быть на любом языке) и `ё→е` в поиске `sessionsView.ts`.
- `settingsDom.test.ts`: в фикстуру добавлен `language`, в список ключей — `agentura.language` (новая строка).
- Тексты ошибок `validateSetting`/`thresholdsError` (`src/settings.ts`, показываются во вкладке настроек) пока
  русские — перенесены в этап 3.

### 3. Язык: хост и манифест
- [x] `src/shared/l10n.ts`: словарь сообщений хоста ru/en по разрешённому языку
- [x] Пользовательские тексты хоста (`showInformationMessage`/`showErrorMessage`/QuickPick/тексты в webview) —
  через него; `toLocaleString('ru')` → по языку
- [x] Ошибки `validateSetting`/`thresholdsError` (`src/settings.ts`) — по языку
- [x] `package.nls.json` + `package.nls.ru.json`, `%ключи%` в `package.json`; `.vsix` их содержит

**Готово, когда:** `npm run check` зелёный, `npm run package` + `scripts/vsix-verify.mjs` — nls-файлы в пакете;
`grep` кириллицы в пользовательских вызовах хоста вне `l10n.ts` пуст.
**Сессия:** sonnet, high. После приёмки 2.

**Решения (2026-10-02, по итогам сессии 3, приняты на приёмке):**
- Словарь хоста — `src/shared/l10n.ts` (приёмка перенесла из `src/extension/`: его импортируют `agent/` и `data/`,
  слой `extension` для них — чужой). Без `vscode`; язык в модули без `vscode` приходит полем `lang?` в их deps
  (`ChatDeps`, `SettingsDeps`, `EngineLocatorDeps`, `ResolveDeps`, `AccountDeps`, `LimitsSourceOptions`,
  `MapperOptions`, `ClaudeAdapterConfig`), по умолчанию `'ru'` — существующие тесты не тронуты.
- Сверх промта переведены: ошибки лимитов (`limits.ts`), плашка `api_retry` (`mapper.ts`), транскрипт субагента
  (`subagents.ts`), строка «Вход» (`account.ts`), единицы `formatBytes` (`shared/files.ts`, параметр `lang`).
- `settings.ts` — свой маленький словарь ошибок `ERRORS` (файл общий с webview, тянуть `l10n` туда не стали).
- Не переведено осознанно: запасные имена вложений `документ.pdf/.txt` в истории (`history.ts:189`), тексты
  таймаутов (`executable.ts:109`, `adapter.ts:349` — только в журнал), debug-панель. Если всплывут на F5 — доводка.

### 4. Тултипы в расширении
- [x] `media/tooltip.css` (= `prototype/shared/tooltip.css`), подключение в `webviewHost.ts`
- [x] Компонент-слой `Tooltip` в корне каждой поверхности
- [x] Все `title=` в `src/webview/components/*.tsx` → `data-tip=`; кнопкам «stop» без подсказки — подсказка
- [x] Иконкам без текста — `aria-label` (тултип не заменяет доступное имя)
- [x] DOM-тест слоя: показ по задержке, скрытие по Esc/уходу, переворот у края

**Готово, когда:** `npm run check` зелёный; `grep -n ' title=' src/webview/components` пуст (кроме осознанных
исключений, перечисленных в отчёте).
**Сессия:** sonnet, high. После этапа 1 (вид принят) и приёмки 3.

**Решения (2026-10-03, по итогам сессии 4, приняты на приёмке):**
- `title` остался только пропом компонентов (`Hud`, `LimitMeterView`) — в DOM они уходят как `data-tip`.
- Stop в детали агента (`SidePanes.tsx`) — «Остановить агента» (`ui.agents.group.stop`): гасит субагента, не ход.
- `Esc` плашкой у stop хода — только пока ход не ждёт ответа: в `waiting` Esc отклоняет карточку.
- «Новая сессия»: `⌘⇧N` плашкой; «Сбросить поиск (Esc)» и «…(Esc — прервать ход целиком)» оставлены текстом.
- Приёмка: `show` не показывает тултип элемента, исчезнувшего за время задержки (`isConnected`).
- `scripts/vsix-verify.mjs` проверяет `media/tooltip.css` в пакете.

### 5. Документация и приёмка владельца
- [x] README (настройка `agentura.language`), CHANGELOG; `docs/features.md` — строк про язык и тултипы там нет, не трогали
- [x] F5-чеклист в pending
- [x] F5 владельца (2026-10-03, «можно коммититься»), мерж в `main`

**Сессия:** sonnet, medium; F5 — владелец.

## Промты сессий

### Промт 2

```
Модель: sonnet, effort: high.

Репозиторий /Users/fost/Projects/Agentura. Создай ветку stage-2-i18n-webview от main.
Задача — этап 2 из docs/roadmap/07-tooltips-i18n.md: настройка языка, каркас локализации и английский перевод
всего webview. Прочитай в этом файле разделы «Решения» и «### 2.» — они обязательны, не переспрашивать.
Этап 1 (прототип) параллельно делает другая сессия в prototype/ — туда не заходи.

Точки входа (проверены):
- src/settings.ts:24-34 — эталон enum-настройки `sidebar.top` (SIDEBAR_TOP_MODES, isSidebarTopMode, DEFAULT_*);
  :37 SettingKey, :51 SETTING_KEYS, :73 SettingsValues, :164 validateSetting, :205 readSettings. Добавь ключ
  `language` ровно по этому образцу (LANGUAGE_MODES = ['auto','ru','en']) + чистую функцию
  `resolveLanguage(raw: unknown, envLanguage: string): 'ru' | 'en'` (auto/мусор → envLanguage.startsWith('ru')
  ? 'ru' : 'en'). Тесты — в src/settings.test.ts рядом с тестами sidebar.top.
- package.json contributes.configuration — свойство `agentura.language` по образцу `agentura.sidebar.top`
  (enum + enumDescriptions по-русски; nls — этап 3, не сейчас).
- src/extension/html.ts:26 — `<html lang="ru">` захардкожен. Добавь `lang: 'ru' | 'en'` в WebviewHtmlOptions.
- src/extension/webviewHost.ts:17 renderWebview — новый параметр lang; вызовы: chatPanel.ts:377, debugPanel.ts:34,
  sidebarView.ts:38, settingsPanel.ts:58. Язык брать `resolveLanguage(cfg.get('language'), vscode.env.language)`
  (одна функция-хелпер в webviewHost.ts, не копировать по четырём местам). Заголовок settingsPanel
  'Agentura · настройки' — тоже по языку (Agentura · Settings).
- src/extension/extension.ts:144 — onDidChangeConfiguration. На affectsConfiguration('agentura.language'):
  showInformationMessage (текст по НОВОМУ языку: ru «Язык Agentura применится после перезагрузки окна.» /
  en «Agentura language will apply after the window reloads.») с кнопкой Перезагрузить/Reload →
  executeCommand('workbench.action.reloadWindow'). Перерендер webview не делать.
- src/webview/strings.ts — `export const ui = {...} as const` (строки 2–627), plural на 629 (русский, приватный).
  Сделай: `const ru = {...}` с типом `export type Ui` — такой, чтобы en с теми же ключами и сигнатурами функций
  проверялся компилятором (снять верхний `as const`; tuple-поля, которые читаются как кортежи — `ui.modes[m]!`
  деструктурируется в Composer.tsx:773, `ui.efforts` в Composer.tsx:541 — типизировать явно, не строкой).
  Английский словарь — новый файл src/webview/strings.en.ts (`export const en: Ui`), естественный UI-английский
  в стиле VS Code (sentence case, коротко; технические слова stop/copy/diff/ctx оставить как есть).
  Экспорт: `export const ui: Ui = pickLang() === 'en' ? en : ru`, где pickLang читает
  `document.documentElement.lang` с защитой `typeof document === 'undefined'` → ru. Также экспортируй
  `uiLang: 'ru' | 'en'` для дат/чисел. Импортёры (19 файлов) не переписывать — имя `ui` сохраняется.
- Захардкоженная кириллица вне strings.ts (перенести в словарь, обе версии):
  sessionsView.ts:11-33 (дни/месяцы) и :144-155 (длительности, «в …»); toolView.ts:66,76,92,98,101;
  Composer.tsx:68-70 (описания моделей), :820,828; hudView.ts:192,241,246; limitView.ts:86,89;
  chatState.ts:194 (WEEKDAYS), :908 (« токенов»). Перепроверь сам:
  `grep -nP '[А-Яа-яЁё]' src/webview --include='*.ts' --include='*.tsx' -r | grep -v test | grep -v fixtures`
  — в результате должны остаться только комментарии и strings.ts.
  src/webview/components/Sidebar.tsx:65 `toLocaleTimeString('ru')` → uiLang.
- Строка «Язык» в настройках: src/webview/components/Settings.tsx:457-469 раздел «Вид» — новая Row + Select
  `k="language"` по образцу `sidebar.top` (options как topModes). Подписи — в ui.settings (ru: Язык интерфейса,
  варианты «Как в VS Code» / «Русский» / «English»; en: Interface language, «Same as VS Code» / «Русский» /
  «English» — названия языков на своём языке). Пометка isNew как у соседей. Проверь, что settingsController
  пропускает новый ключ (он должен идти через SETTING_KEYS/validateSetting автоматически).

Тесты:
- Существующие тесты не трогать: в jsdom без lang словарь русский, они должны пройти как есть.
- Новый src/webview/strings.test.ts: обойти en рекурсивно, функции вызвать с аргументами (1), (2), (5), ('x'),
  (1,'x') — по arity — ни в одной строке нет кириллицы; набор ключей en и ru совпадает рекурсивно.
- Тест на html.ts: lang попадает в `<html lang>`.
- Тест resolveLanguage: auto+'ru' → ru, auto+'ru-RU'→ru, auto+'en-US'→en, auto+'de'→en, 'en'+'ru'→en, мусор→как auto.

DoD: `npm run check > $SCRATCH/check.log 2>&1; tail -30 $SCRATCH/check.log` — зелёный (typecheck, lint, test, build).
$SCRATCH = /private/tmp/claude-501/-Users-fost-Projects-Agentura/22b242b3-f05e-4f9f-8a33-9fc898fee400/scratchpad.
Длинный вывод — только в файл, в контекст хвост и grep по FAIL|error.

Не делать: хост-строки (showInformationMessage и т.п., кроме уведомления о перезагрузке) и package.nls — это
этап 3; тултипы и data-tip — этап 4; prototype/ не трогать; браузер/скриншоты не запускать; «заодно улучшить» —
нет. Вопрос без ответа в промте — в отчёт, не додумывать.

Отметь чекбоксы этапа 2 в roadmap по факту. Не коммить, не пушь.
Последним сообщением — отчёт до 30 строк: сделано (файлы) / отклонения от плана / не проверено / открытые
вопросы.
```

### Промт 3

```
Модель: sonnet, effort: high.

Репозиторий /Users/fost/Projects/Agentura, ветка stage-2-i18n-webview (этап 2 принят и закоммичен) — работай на ней.
Задача — этап 3 из docs/roadmap/07-tooltips-i18n.md: английский для хоста расширения и манифеста.
Прочитай в этом файле «Решения», «### 2.» (с блоком решений сессии 2) и «### 3.». Не переспрашивать.

Что уже есть: `currentLanguage()` в src/extension/webviewHost.ts (настройка + vscode.env.language → 'ru'|'en');
webview-словари src/webview/strings.ts (ru) и strings.en.ts (en, тип Ui) — образец стиля английского.
Смена языка = перезагрузка окна, поэтому язык хоста можно читать при каждом показе сообщения, кэш не нужен.

1. src/extension/l10n.ts (приёмка перенесла в src/shared/l10n.ts) — БЕЗ импорта vscode (его импортируют модули, которые тестируются без vscode, напр.
   chatController.ts): `export type Lang = 'ru' | 'en'`, `export function hostStrings(lang: Lang)` → словарь
   сообщений хоста (ru и en объекты одного типа, как в strings.ts: `const ru = {...}`, `type HostUi`,
   `const en: HostUi`). Тест src/extension/l10n.test.ts: в en нет кириллицы, ключи совпадают (по образцу
   src/webview/strings.test.ts).
2. Найди пользовательские тексты хоста:
   `grep -rnP "[А-Яа-яЁё]" src/extension src/data src/agent src/shared src/settings.ts --include='*.ts' | grep -v '\.test\.' | grep -vP '^\S+:\d+:\s*(//|\*|/\*)'`
   Переводить ТОЛЬКО то, что видит пользователь: showInformationMessage/showWarningMessage/showErrorMessage,
   QuickPick (items, placeHolder, title), заголовки вкладок/панелей, тексты, уходящие в webview в сообщениях
   (ошибки, плашки, `chat.info`, ошибки лимитов/аккаунта/движка — проверь по protocol.ts, что поле реально
   показывается). НЕ переводить: логи (log.debug/info/warn/error, Logger), текст для модели
   (src/shared/prompt.ts и всё, что уходит в SDK как prompt/systemPrompt/deny message для модели — напр.
   chatController.ts:161), debug-панель, исключения, которые только логируются. Сомнительное — в отчёт списком.
   Уже известные места: extension.ts:97,100,106 (`toLocaleString('ru')` → по языку), sidebarView.ts:129,159,169
   (`toLocaleTimeString('ru')`), chatPanel.ts:80,139, previewPanels.ts:27, settings.ts:156 (`toLocaleString('ru')`).
3. Как язык доходит до модулей без vscode: модули с `import * as vscode` берут `hostStrings(currentLanguage())`;
   классы, тестируемые без vscode (ChatController — `ChatDeps` в chatController.ts:61), получают язык через
   deps — поле `lang?: Lang`, по умолчанию 'ru' (существующие тесты не трогать); передаёт его chatPanel.ts при
   создании контроллера (`currentLanguage()`).
4. src/settings.ts (общий для хоста и webview, vscode не импортирует): у `validateSetting` и `thresholdsError`
   — необязательный последний параметр `lang: 'ru' | 'en' = 'ru'`, тексты ошибок по нему (маленький словарь
   внутри settings.ts, не тянуть сюда l10n.ts). Вызовы: settingsController.ts:74 (→ currentLanguage()),
   Settings.tsx:176,208,244 (→ uiLang из ../strings), chatPanel.ts:252 (результат не показывается — не трогать).
   Тест: одна ошибка по-английски в settings.test.ts.
5. Манифест: package.nls.json (английский, по умолчанию) + package.nls.ru.json (русский — текущие тексты
   дословно). В package.json заменить на `%ключ%`: description расширения, title всех команд, description и
   enumDescriptions всех свойств contributes.configuration (и markdownDescription, если есть). Ключи вида
   `command.open.title`, `config.language.description`, `config.language.enum.auto`. category «Agentura» и
   displayName не трогать. Проверка: node -e, что каждый `%ключ%` из package.json есть в обоих nls-файлах и
   лишних нет (оформи как тест src/manifest.test.ts, читающий json с диска).
6. .vscodeignore не исключает package.nls*.json — убедись. `npm run package > $SCRATCH/pkg.log 2>&1` и
   `unzip -l agentura-0.2.0.vsix | grep nls` — оба файла в пакете. Сам .vsix не коммитится (он в .gitignore? —
   проверь `git status`; если появился как новый файл — удали его).

DoD: `npm run check > $SCRATCH/check.log 2>&1; tail -30 $SCRATCH/check.log` зелёный; nls-файлы в .vsix;
повторный grep из п.2 показывает только логи, промпт модели, комментарии и словари (перечисли оставшееся по
категориям в отчёте). $SCRATCH = /private/tmp/claude-501/-Users-fost-Projects-Agentura/22b242b3-f05e-4f9f-8a33-9fc898fee400/scratchpad.
Длинный вывод — только в файл, в контекст хвост и grep по FAIL|error.

Не делать: webview-словари трогать только если хост шлёт ключ, а не текст (не переделывать протокол); тултипы —
этап 4; prototype/ не трогать; браузер не запускать; «заодно улучшить» — нет. Вопрос без ответа — в отчёт.

Отметь чекбоксы этапа 3 по факту. Не коммить, не пушь.
Последним сообщением — отчёт до 30 строк: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

### Промт 4

```
Модель: sonnet, effort: high.

Репозиторий /Users/fost/Projects/Agentura, ветка stage-2-i18n-webview (этапы 1–3 приняты и закоммичены) — работай на ней.
Задача — этап 4 из docs/roadmap/07-tooltips-i18n.md: тултипы вместо нативного title во всех webview.
Прочитай в этом файле «Решения» и «### 4.». Вид принят владельцем по прототипу — переносить его ДОСЛОВНО:
prototype/shared/tooltip.css и prototype/shared/tooltip.js (логика: задержка 500, тёплый показ 300, GAP 6,
EDGE 4, переворот вверх, прижим, стрелка через --ax, первая строка обычная, следующие через \n приглушены,
data-tip-key → <kbd> справа, скрытие на pointerout без relatedTarget/focusout/pointerdown/scroll/Esc, показ по
focusin только при :focus-visible, aria-describedby на время показа).

1. media/tooltip.css — копия prototype/shared/tooltip.css (правила темы: в расширении светлая тема задаётся
   переменными VS Code, поэтому блок `:root[data-theme='light'] .tip` убрать — `--vscode-editorHoverWidget-*`
   уже приходят от темы; запасные значения оставить тёмные). Подключить в src/extension/webviewHost.ts:
   styleUris у renderWebview (все поверхности, рядом с webview.css).
2. src/webview/tooltip.ts — `installTooltips(doc: Document = document): () => void` (возвращает снятие
   слушателей и удаление слоя — для тестов). Логика tooltip.js без прототипных частей: без adopt() title→data-tip,
   без PRESETS/хэша, без прижима к .sidebar-view/.webview — границы = вьюпорт (каждая поверхность — свой webview).
   Вызов — в src/webview/chat/index.tsx, sidebar/index.tsx, settings/index.tsx перед render(...).
   Текст читается из data-tip при каждом показе (кнопка вида меняет подсказку по клику).
3. Все ` title=` в src/webview/components/*.tsx (54 шт., `grep -n ' title=' src/webview/components`) →
   `data-tip=`. Иконкам без видимого текста (⚙, ↻, ☰/≡/≣, скрыть/показать панель, ✕ и т.п.) — `aria-label`
   с тем же текстом, если его ещё нет. Исключения не трогать: src/webview/markdown.ts (ссылки из markdown —
   нативный title), `<title>` страницы в src/extension/html.ts.
4. Подсказки, которых нет: кнопки stop в Chat.tsx:370 и SidePanes.tsx:224 — data-tip из словаря (ru
   «Остановить ход», en «Stop the turn»), data-tip-key="Esc" у той, что останавливает по Esc (проверь по коду).
   Ключи — в src/webview/strings.ts и strings.en.ts (тип Ui проверит пару).
5. Клавиши плашкой: `ui.compose.sendTitle` («Отправить (Enter)» / «Send (Enter)») → текст без скобок +
   data-tip-key="Enter" на кнопке отправки. Других «(клавиша)» в словаре — так же, если кнопка одна и клавиша
   очевидна; список таких мест — в отчёт.
6. Две строки: Sidebar.tsx refreshTitle() — части соединять '\n' вместо ' · ' (первая — «Обновить лимиты»,
   дальше время данных / ошибка); hudView.ts limitsView — части 5ч и недели тоже через '\n'. Больше нигде
   разделители не менять.
7. Тесты:
   - существующие DOM-тесты, читающие title (≈14 мест: `grep -n "title" src/webview/*Dom.test.ts`), — на
     getAttribute('data-tip'); ожидаемые тексты не менять, кроме тех, что поменял п.5–6;
   - новый src/webview/tooltip.test.ts (// @vitest-environment jsdom, vi.useFakeTimers): показ через 500 мс по
     pointerover; второй элемент сразу (тёплый); Esc и pointerdown скрывают; '\n' → две .tl; data-tip-key →
     kbd; у нижнего края data-side='top' (getBoundingClientRect замокать, innerHeight/clientHeight задать);
     uninstall удаляет слой. В jsdom нет PointerEvent — диспатчить `new Event('pointerover', {bubbles:true})`
     или MouseEvent, в коде не завязываться на поля PointerEvent.
   - проверка, что в components не осталось ` title=`: тест на чтение исходников не нужен — достаточно grep в DoD.

DoD: `npm run check > $SCRATCH/check.log 2>&1; tail -30 $SCRATCH/check.log` зелёный;
`grep -n ' title=' src/webview/components` пуст; `grep -n 'tooltip.css' src/extension/webviewHost.ts` есть.
$SCRATCH = /private/tmp/claude-501/-Users-fost-Projects-Agentura/22b242b3-f05e-4f9f-8a33-9fc898fee400/scratchpad.
Длинный вывод — только в файл, в контекст хвост и grep по FAIL|error.

Не делать: вид тултипа не «улучшать» (размеры, цвета, задержки — как в прототипе); prototype/ не трогать;
markdown.ts не трогать; браузер не запускать; README/CHANGELOG — этап 5. Вопрос без ответа — в отчёт.

Отметь чекбоксы этапа 4 по факту. Не коммить, не пушь.
Последним сообщением — отчёт до 30 строк: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
```

## Риски и открытые вопросы

- Объём английского перевода (~600 строк словаря) — качество текста проверяет владелец на F5; спорные формулировки
  исполнитель пишет в отчёт.
- `ui` вычисляется при загрузке модуля: если когда-то понадобится живая смена языка — придётся перейти на
  сигнал/контекст. Сейчас осознанно нет (перезагрузка окна).
- Тултип по `pointerover` в webview VS Code: у нативных `title` VS Code ничего не перехватывает, но у кнопок,
  которые меняют DOM по клику (кнопка вида ☰/≡/≣), текст тултипа должен обновляться — слой читает `data-tip`
  при каждом показе.

## Порядок работы

Этап 1 (opus, в чате) ∥ этап 2 (sonnet) → приёмка 2 → 3 → приёмка 3 → 4 (нужен принятый этап 1) → 5. Каждый этап —
своя ветка `stage-N-…` от `main`, мерж после приёмки.
