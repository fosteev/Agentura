# 14 · Поле ввода: шесть раскладок с настройкой

> Статус: этап 1 принят 2026-10-05 (ветка `stage-1-composer-parts`), следующий — 2. На подтверждение и ручную проверку —
> `14-composer-layouts.pending.md`. Прототип — `prototype/screens/composer.html#a…#f` (+ `-typed`), стили —
> `prototype/shared/composer.css`, картинки — галерея, раздел «Поле ввода: варианты» (v31).

## Цель

Нижняя панель ввода чата (`Composer`) получает шесть раскладок по прототипу, выбор — настройкой
`agentura.composer.layout` (⚙ → «Внешний вид», команда «Agentura: Composer Layout…»), как `feed.style` / `git.layout`.
Поведение поля (клавиши, `/` и `@`, история, черновики картинок и файлов, автоконтекст, сжатие, пороги, тултипы) во всех
раскладках одинаковое — меняются только расстановка и подписи. Во время хода во всех раскладках — «↵ в очередь» и стоп.

## Что есть сейчас (разведка 2026-10-05)

- `src/webview/components/Composer.tsx` (1000 строк): одна функция `Composer()` `:255–937`, корень
  `<footer class="compose">` `:562`. Внутри по порядку: `div.blocks` `:570` (20 блоков из `hv.context.blocks`),
  `div.att` `:575` (`DraftChip` `:150`, `FileChip` `:208`), `div.ctx` `:585` (`.hint`, `span.auto` с `.x`, `span.cn`
  `:631` — «контекст N / max · сжать»), `div.pop` `:661` с `div.prompt` (`span.p` + `div.typed` contenteditable) и
  меню `/` `@` `div.menu.up` `:686`, `div.note` `:701`, `div.opts` `:712` (`+` с меню `:713`, mode `:767`, agent `:802`,
  model `:843`, effort+thinking `:867`, `span.meters` `:899` — кэш `.clock`, `LimitMeterView` `:939` для 5ч и недели
  (неделя — если >70 %), `button.send` `:924`).
- Метрики: `store.ts:236 meters`; `hudView.ts` — `contextView:123` (зона), `contextBlocks:75`, `cacheView:168`,
  `limitMeter:215` (`level`: `lim-warn` >70, `lim-hot` >85, `lim-full`).
- Очередь уже есть: Enter во время хода → `sendMessage` → `queueUser` (`chatState.ts:233`). Стопа в поле нет: `button.stop`
  в строке `.live` ленты (`Chat.tsx:438–466`) → `interrupt()` (`store.ts:749`); Esc → `interrupt` (`Chat.tsx:223`).
- CSS поля: `media/hud.css:26–49,170–197,268–269`, `media/webview.css:46–64,86,131,156`, `media/attach.css:18–58`.
- Эталон настройки «вид» — `feed.style`, вся цепочка:
  `package.json:92` (команда), `:265–280` (configuration + enumDescriptions); `package.nls.json:9,37–41` и
  `package.nls.ru.json`; `src/settings.ts:39–41,85,108,140,183,347,372,399`; `src/protocol.ts:167` (`chat.info.feedStyle`);
  `src/extension/chatPanel.ts:282` (чтение), `chatController.ts:80,232–239` (`pushInfo`), `chatPanel.ts:509` +
  `extension.ts:263` (живое обновление), `extension.ts:205–222,275` (QuickPick `pickFeedStyle`);
  `src/shared/l10n.ts:26,29,39,162,165,175`; `src/webview/store.ts:115,296`; `Chat.tsx:346` (`data-feed` на `.webview`);
  `Settings.tsx:703–713,761` (`ChoiceCards` + превью); `SettingsPreview.tsx:126` (`FeedPreview`);
  `src/webview/strings.ts:759`, `strings.en.ts:741`.
- Тесты-эталоны: `src/settings.test.ts:83,180`, `src/manifest.test.ts`, `chatController.test.ts:213`,
  `feedDom.test.ts:88`, `settingsDom.test.ts:44,118,178–194`; поле — `composerDom.test.ts` (`:68` каркас, `:84` Enter и
  очередь, `:271` приборы), `composer.test.ts`.
- Картинки README: `scripts/readme-shots/run.mjs` (`chatMessages(…, {feedStyle, agentsView, gitLayout})` `:33`,
  кадры стилей `:80–90`, страница настроек `:140–158` — полный `values`).

## Решения (2026-10-05, при планировании)

1. **Настройка** `agentura.composer.layout`: `classic` | `card` | `statusline` | `gauges` | `minimal` | `shell`,
   по умолчанию `classic`. Команда `agentura.composerLayout` — «Agentura: Composer Layout…» / «Agentura: Вид поля
   ввода…». Цепочка — ровно как у `feed.style` (все точки из «Что есть»), поле `chat.info.composerLayout`, сигнал
   `composerLayout` в `store.ts`. Названия: RU «классика / карточка / строка состояния / приборы сверху / минимум /
   командная строка», EN «Classic / Card / Status line / Gauges on top / Minimal / Shell prompt»; описания — по подписям
   галереи, одной фразой.
2. **Раскладка — структура, а не только CSS**: `Composer` разбивается на части-компоненты, а раскладка расставляет их.
   Корень — `<footer class="compose" data-layout={layout}>`; стили раскладок — новый `media/composer.css` (подключить,
   как `feed.css`), селекторы `.compose[data-layout="…"]`; база — `prototype/shared/composer.css`.
3. **Части** (в `src/webview/components/composer/` или в том же файле — на выбор исполнителя, но по одной функции на
   часть): `ContextBlocks`, `Drafts` (`.att`), `AutoContext` (автоконтекст файла/выделения; проп `look: 'chip' | 'ref'
   | 'plus'`), `ContextCount` (`.cn` с «сжать»), `PromptField` (`.pop` + `.prompt` + меню `/` `@`; весь ввод, клавиши,
   paste/drop остаются в нём), `Note`, `PlusMenu`, `ModeMenu`, `AgentMenu`, `ModelMenu`, `EffortMenu`, `Meters` (кэш,
   5ч, неделя), `SendControl`. Новые: `ContextRing` (кольцо conic-gradient + %), `ContextBar` (полоса 60–90 px с засечками
   порогов), `EngineMenu` (одна кнопка «agent · model · effort» → одно меню с секциями «агент / модель / effort +
   thinking» из тех же пунктов). Цвета — по зоне `contextView` и `limitMeter.level`, как сейчас.
4. **Ход идёт** (`status === 'working'`, то же условие, что у `.live` в ленте) — `SendControl` во всех раскладках:
   вместо «enter ↵»/↑/«отправить» подпись «↵ в очередь» (`.q`, цвет info) и кнопка стопа (`.stopb`: красный квадрат +
   «esc», тултип «Остановить (Esc)») → `interrupt()`. Стоп в `.live` ленты остаётся. Enter по-прежнему ставит в очередь.
5. **Раскладки** (картинки — галерея `#composer`, разметка — `prototype/screens/composer.html`):
   - `classic` — как сейчас, DOM не меняется (кроме `SendControl` в ходе). `composerDom.test.ts` проходит без правок
     существующих проверок.
   - `card` — без полосы блоков; одна рамка (radius 8, фон поля, рамка акцентом на `:focus-within`): черновики, автоконтекст
     чипами, поле (мин. 2 строки), нижний ряд — круглый `+`, пилюля режима (значение цветом режима), пилюля
     `EngineMenu`, распорка, `ContextRing` + %, круглая ↑ (`--btn`) / `SendControl` в ходе. Под рамкой справа мелко:
     «контекст N / max · сжать», кэш, 5ч (неделя — если показывается); слева — `.hint`/`Note`.
   - `statusline` — черновики над полем; поле без рамки, кромка 2 px по верху = заполнение контекста (`used/fullAt`,
     цвет зоны); автоконтекст — `@file:строки` цветом ссылки перед текстом (✕ на наведении). Под полем полоса 22 px
     (`--bg-raise`): сегменты `+`, режим (блок цветом режима, капсом), agent, model, effort (каждый — кнопка своего меню,
     меню вверх), распорка, `ctx` + `ContextBar` + `131k/200k` (+ «сжать», если зона не ok), кэш, 5ч, подсказка клавиши /
     `SendControl`.
   - `gauges` — верхний ряд: черновики и автоконтекст чипами слева; справа `ContextBar` с засечками + `131k/200k` +
     «сжать», кэш (`.clock` + время), 5ч `.cells` (+неделя). Поле мин. 48 px. Нижний ряд: «+ файл», режим ▾, agent ▾,
     model ▾, effort ▾, распорка, кнопка «отправить ↵» (`--btn`) / `SendControl`.
   - `minimal` — 1 px линия по верху = заполнение контекста; одна строка в рамке: `$` цветом режима (клик — меню
     режима), автоконтекст чипами, поле (растёт при многострочном вводе), `ContextRing` + % **только если зона не ok**,
     `+`, кнопка `EngineMenu` «model · effort», «↵» / `SendControl`. Кэш не показывается; 5ч и неделя — компактно
     «5ч 62%» **только при `level` хуже нормы (>70 %)**. Под строкой — `.hint`/`Note`; если поле пустое и нот нет —
     шпаргалка «/ команды · @ файл».
   - `shell` — фон `--bg-code`, без рамки поля. Строка 1: проект (`chat.project`, info, жирный) · режим · `agent/
     model:effort` (каждая часть — своё меню) · `+`; справа `ContextBar` + %, кэш, 5ч. Строка 2: автоконтекст как
     `+ file:строки` цветом ссылки (картинки — миниатюрами, как везде). Строка 3: `❯` (цвет ok) + поле, справа «↵» /
     `SendControl`. Курсор — `caret-shape: block`, если Chromium VS Code его знает; поддельный курсор не рисовать.
6. **Узкая вкладка** (`html[data-width="380"]`, < 700 px): все раскладки переносятся (flex-wrap), горизонтальной прокрутки
   нет; полоса `statusline` и строка 1 `shell` — в две строки.
7. **Настройки**: группа `composer.layout` в «Внешний вид» сразу после `feed.style`, `ChoiceCards` с `ComposerPreview`
   (`SettingsPreview.tsx`, статичные данные по образцу `FeedPreview`, `scaled`); строки — `strings.ts`/`strings.en.ts`.
8. **Публичное** — на английском: CHANGELOG `Unreleased`, README.md и README.ru.md — строка про настройку; картинка
   `docs/images/composer-layouts.png` (6 вырезок низа вкладки) из `run.mjs`.

## Этапы

### 1. Разбор `Composer` на части + настройка + стоп в поле · sonnet, high

- [x] ветка `stage-1-composer-parts` от `main`
- [x] части из «Решения 3» (кроме новых `ContextRing`/`ContextBar`/`EngineMenu`), `Composer` = состояние + раскладка
      `classic`; DOM `classic` не изменился (существующие проверки `composerDom.test.ts`/`imagesDom.test.ts` зелёные без правок)
- [x] `SendControl` с режимом «ход идёт» (Решение 4) + тест: в ходе видны «↵ в очередь» и стоп, клик → `interrupt`
- [x] настройка целиком по цепочке `feed.style` (Решение 1): manifest, nls, `settings.ts`, протокол, хост, QuickPick,
      `l10n.ts`, store; `data-layout` на `footer`; значения ≠ `classic` пока рисуют `classic`
- [x] тесты настройки по эталонам (`settings.test.ts`, `manifest.test.ts`, `chatController.test.ts`)
- [x] `npm run check` зелёный

### Решения (2026-10-05, по итогам сессии 1)

- Части — функции в том же `Composer.tsx`. Всё состояние и все хуки (текст, каретка, меню `/` `@`, история, drop,
  открытое меню) остались в `Composer`; части без хуков, получают пропсы. Сверх списка — `DraftHint` (`.hint` в `.ctx`).
- Всплывающие меню (`PlusMenu`, `ModeMenu`, `AgentMenu`, `ModelMenu`, `EffortMenu`) — управляемые: пропсы
  `MenuProps { menu, toggle, close }`, открыто одно меню на поле (`menu: MenuName` в `Composer`), закрытие кликом вне и по
  Esc — эффект в `Composer` по `.closest('.pop')`, поэтому каждое меню рисуется в своей обёртке `span.pop`. Кнопка-триггер
  и список пунктов пока зашиты внутри компонента (вид classic). Для этапов 2–3: внешний вид триггера задавать пропом
  (класс/подпись или `children`), пункты меню для `EngineMenu` вынести в отдельные функции-списки (`ModelItems`,
  `EffortItems`, `AgentItems`), не дублировать; новое меню — новое значение `MenuName`. DOM classic при этом не меняется.
- `AutoContext` принимает `look`, но пока рисует только `chip`; `ref`/`plus` — этапы 2–3.
- `SendControl` в ходе — фрагмент `span.q` + `button.stopb` (`<i>` — красный квадрат, подпись `esc`, `data-tip-key="Esc"`),
  стоп возвращает фокус в поле. Стили — `media/hud.css` (`.compose .q`, `.compose .stopb`, по прототипу: рамка
  `--line-strong`, квадрат `--del`), место в `.opts` — `margin-left: auto`, как у `.send`.
- Условие хода — только `status === 'working'`; при `waiting` — обычная отправка (поле отвечает карточке, Esc отклоняет
  карточку). На подтверждение — `14-composer-layouts.pending.md`.
- Неизвестное значение настройки отсекается на хосте (`isComposerLayout` → `classic`), webview без поля → `classic`.

### 2. Раскладки `card`, `gauges`, `minimal` · sonnet, high · после 1

- [ ] `media/composer.css` (подключён), `ContextRing`, `ContextBar`, `EngineMenu`
- [ ] три раскладки по Решению 5, правила видимости `minimal`
- [ ] `composerDom.test.ts`: на каждую раскладку — ключевые элементы есть, Enter отправляет, меню режима и `EngineMenu`
      открываются; `minimal` — кольцо и 5ч скрыты в норме и видны за порогом
- [ ] `npm run check` зелёный

### 3. Раскладки `statusline`, `shell` + страница настроек + картинки · sonnet, high · после 2

- [ ] две раскладки по Решению 5, узкая вкладка (Решение 6) для всех шести
- [ ] тесты раскладок как в этапе 2
- [ ] `ComposerPreview` + группа на странице настроек (Решение 7), `settingsDom.test.ts`
- [ ] `run.mjs`: `composerLayout` в `chatMessages`, кадр `composer-layouts.png`, `composer.layout` в `values` страницы
      настроек; CHANGELOG, оба README (Решение 8)
- [ ] `npm run check` зелёный; `npm run build && node scripts/readme-shots/run.mjs` отработал

### 4. Приёмка и картинки · opus

- [ ] приёмка каждого этапа — `plan-review`, мерж в `main`
- [ ] раздел галереи «Поле ввода: настоящий webview» (`#composer-real`), 6 раскладок × (пусто / ход идёт) × 2 темы
- [ ] ручные проверки владельца — `14-composer-layouts.pending.md`

## Промты сессий

### Сессия 1 — разбор Composer на части, настройка, стоп · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura` (расширение VS Code, TypeScript + Preact). Задача: подготовить поле ввода к
шести раскладкам — разобрать `Composer` на части без изменения вида, завести настройку `agentura.composer.layout` и
добавить в поле стоп и «в очередь» во время хода. Новых раскладок в этом этапе нет.

Читай: этот файл (`docs/roadmap/14-composer-layouts.md`) — «Что есть сейчас», «Решения» 1–4 и «Этапы → 1» обязательны.
Точки входа и эталоны (вся цепочка `feed.style`) перечислены в «Что есть сейчас» с номерами строк и проверены при
планировании — не перечитывать их ради подтверждения, открывать только фрагмент, который правишь. `Composer.tsx` —
1000 строк: сначала `grep -n` по структуре, потом куски.

Уже решено, не переспрашивать: всё в «Решения». Разбор — механический: логику, обработчики и порядок DOM не менять,
только вынести в функции-компоненты с пропсами/сигналами. Значения настройки ≠ `classic` в этом этапе рисуют `classic`.

Порядок: ветка `stage-1-composer-parts` от `main` → чекбоксы «Этапы → 1» по порядку. Сначала разбор и прогон
`composerDom.test.ts` (зелёный без правок существующих проверок), потом `SendControl`, потом настройка. Галочки в roadmap —
по факту проверки.

DoD: `npm run check` зелёный; существующие проверки `composerDom.test.ts` и `imagesDom.test.ts` не правились; новые тесты —
`SendControl` в ходе и цепочка настройки. Проверка: `npm run check > $TMPDIR/check.log 2>&1; tail -30 $TMPDIR/check.log`.

Не делать: раскладки `card`…`shell`, `media/composer.css`, страницу настроек, README/CHANGELOG, `run.mjs`; «заодно
улучшить» — нет; чужие незакоммиченные файлы не трогать. Вопрос без ответа в промте — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от плана /
не проверено / открытые вопросы. Отчёт — единственное, что увидит приёмка.

### Сессия 2 — раскладки card, gauges, minimal · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura`. Задача: три раскладки поля ввода — `card`, `gauges`, `minimal` — по
прототипу `prototype/screens/composer.html` (`#b`, `#d`, `#e`; разметка там, стили — `prototype/shared/composer.css`).
Части поля и настройка уже есть (этап 1).

Читай: этот файл — «Решения» (особенно 2–5) и «Решения (2026-10-05, по итогам сессии 1)» — там устройство частей и
меню (`MenuProps`, одно открытое меню, `span.pop`); «Этапы → 2». Эталон стилевого
файла вида — `media/feed.css` и как он подключён. Открывать только фрагменты, которые правишь.

Уже решено, не переспрашивать: всё в «Решения». Цвета — только токены (`var(--…)`), как в прототипе. Классы и
вложенность — по прототипу, имена частей — из этапа 1. Части живут в `src/webview/components/Composer.tsx`; триггеры
меню под раскладки — через проп (вид триггера), пункты для `EngineMenu` — общие функции-списки, вынесенные из
`AgentMenu`/`ModelMenu`/`EffortMenu`, без копий. Новые хуки в части не добавлять без нужды — состояние поля в `Composer`.

Порядок: ветка `stage-2-composer-layouts` от `main` (после мержа этапа 1) → чекбоксы «Этапы → 2».

DoD: `npm run check` зелёный; тесты из чекбокса этапа 2 есть. Проверка: `npm run check > $TMPDIR/check.log 2>&1; tail -30 $TMPDIR/check.log`.

Не делать: `statusline`, `shell`, страницу настроек, README, `run.mjs`; изменения DOM `classic`; чужие незакоммиченные
файлы не трогать. Вопрос без ответа — в отчёт.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от плана /
не проверено / открытые вопросы.

### Сессия 3 — statusline, shell, настройки, картинки · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura`. Задача: раскладки `statusline` и `shell` (прототип `#c`, `#f`), узкая
вкладка для всех шести, карточки раскладок на странице настроек с превью, кадр для README. Части, настройка и три
раскладки уже есть (этапы 1–2).

Читай: этот файл — «Решения» 5–8 и решения по итогам сессий 1–2; «Этапы → 3». Эталоны: `FeedPreview` в
`src/webview/components/SettingsPreview.tsx:126`, группа `feed.style` в `Settings.tsx:703–713`, кадры стилей ленты в
`scripts/readme-shots/run.mjs:80–90`. Открывать только фрагменты, которые правишь.

Уже решено, не переспрашивать: всё в «Решения». Публичные тексты (CHANGELOG, README.md) — на английском, README.ru.md —
на русском, обе версии.

Порядок: ветка `stage-3-composer-rest` от `main` (после мержа этапа 2) → чекбоксы «Этапы → 3».

DoD: `npm run check` зелёный; `npm run build && node scripts/readme-shots/run.mjs` отработал и создал
`docs/images/composer-layouts.png`. Проверка: `npm run check > $TMPDIR/check.log 2>&1; tail -30 $TMPDIR/check.log`.

Не делать: изменения раскладок `classic`/`card`/`gauges`/`minimal`, кроме переноса на узкой вкладке; Marketplace и
версию; чужие незакоммиченные файлы не трогать. Вопрос без ответа — в отчёт.

Не коммитить, не пушить — это сделает приёмка. Последним сообщением — отчёт: сделано (файлы) / отклонения от плана /
не проверено / открытые вопросы.

## Риски и открытые вопросы

- Разбор 1000-строчного `Composer` — главный риск регрессий (фокус, каретка, меню, paste/drop). Страховка — существующие
  DOM-тесты не правятся; приёмка этапа 1 гоняет их и смотрит дифф на «логика не менялась».
- `EngineMenu` — новое меню из трёх секций; клавиатурная навигация как у существующих меню (стрелки, Enter, Esc).
- `caret-shape: block` может не поддерживаться Chromium VS Code — тогда обычный курсор (Решение 5, `shell`).
- Каждая следующая доработка поля проверяется в шести раскладках — цена выбора «все варианты».

## Порядок работы

Автопилот `roadmap-run`: этап → исполнитель-субагент (модель из пометки) → `plan-review` → мерж в `main` → следующий.
