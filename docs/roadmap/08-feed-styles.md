# Вид ленты чата: четыре варианта переключателем

> Статус: готово · этап 1 принят и смержен в main 2026-10-03; решения `[скоуп]` подтверждены владельцем 2026-10-03;
> осталась ручная проверка в VS Code (`08-feed-styles.pending.md`).
> Создан 2026-10-03 по запросу владельца («реализуем все варианты в качестве переключателя»).
> Прототип: `prototype/screens/chat-feed.html#a…d`, `prototype/shared/feed.css`; галерея — раздел «Лента чата: варианты»
> (артефакт v22). Дизайн владелец принимает только картинками в галерее-артефакте.

## Цель

Настройка `agentura.feed.style` переключает вид ленты основного чата между четырьмя вариантами прототипа:
`journal` (А, как сейчас, по умолчанию) · `folded` (Б, свёрнутые действия) · `replies` (В, реплики) · `cards` (Г, карточки ходов).
Переключается в ⚙ → «Вид», командой `Agentura: Feed Style…` и в settings.json; открытые вкладки чата меняют вид сразу.

## Решения (2026-10-03, при планировании)

- **Один DOM ленты, вариант — атрибут `data-feed` на `.webview` чата + CSS.** Никаких четырёх рендеров: всё, что
  появится в ленте потом (агенты, карточки, картинки), автоматически работает во всех видах.
- **Ход — контейнер.** `Log` группирует плоские `rows` (через `feedItems`) по ходам чистой функцией
  `feedTurns(items)` в новом `src/webview/turnView.ts`: ход открывает строка `user`, закрывает `sum`. Строки до
  первого `user` и `sys` между ходами (вне открытого хода) — вне контейнеров. Ход, начатый движком без `user`
  (пробуждение после фоновой задачи): не-`sys` строка после закрытого хода открывает «безымянный» ход без `.u`.
  Разметка хода:
  ```
  <section class="turn" data-state="done|live" data-open="true|false">
    <div class="u">…</div>                 ← как сейчас; + <span class="tm"> (цена · время из sum / «идёт Ns») — виден только в cards
    <div class="who">claude</div>           ← виден только в replies (модель не пишем: по ходу она не хранится)
    <button class="fold">…</button>         ← только если в ходе есть действия; виден только в folded
    <div class="steps">tool/think/agents</div>  ← каждая непрерывная серия tool/think/agents-строк — своя .steps
    … text, карточки, sys — как сейчас, в исходном порядке
    <div class="sum">…</div>
    {children (.live) — внутри последнего хода, если он live; иначе после всех ходов, как сейчас}
  </section>
  ```
- **Вид А должен остаться пиксель-в-пиксель как сейчас:** в `journal` `.turn` и `.steps` — `display: contents`,
  `.fold/.who/.tm` скрыты. Селекторы `media/hud.css` и `media/webview.css`, завязанные на `:first-child`, `+`, `~`,
  `.log > *`, пересмотреть под новую вложенность (например `.log .u:first-child` теперь срабатывает в каждом ходе →
  `.log > .turn:first-of-type .u:first-child` или аналог).
- **Б · folded.** Завершённый ход по умолчанию свёрнут: все его `.steps` скрыты, на месте первой `.steps` — строка
  `.fold`: `▸ N действий · мини-полоса · сводка · время`. Клик раскрывает/сворачивает (состояние — локальный
  `Set` id ходов в компоненте, не персистится). Идущий ход всегда раскрыт, `.fold` у него — «N действий · идёт».
  Сводка — чистая функция `foldSummary(rows)` в `turnView.ts`: N = число tool + think строк (группа агентов
  считается по числу агентов); сводка — op по порядку первого появления с `×k` при повторах (`read ×2`), у
  edit/write — сумма `+a −d`, у bash — результат последнего запуска, если есть (как в `ToolRight`); think — `think Ns`;
  время справа — сумма `durationMs` строк. Мини-полоса — сегменты `flex: durationMs` с классами `th` (think),
  `ed` (edit/write/multiedit/notebookedit), `rn` (bash), без класса — остальное; до 40 сегментов, остальное отбросить.
  Плюрализация — существующим `plural` в `strings.ts` (ru), в `strings.en.ts` — по-английски.
- **В · replies.** `.u` — пузырь справа (`justify-self: end; max-width: 78%`), время под ним; `.who` — «claude» с
  квадратной меткой; `.steps` — `flex-wrap`, `.e` — чипы (скрыть `.p`, `.dim`, длинный `.what` обрезать ~28ch);
  `.grp` (агенты) и карточки `.ask` остаются блоками; `.sum` — мелкой строкой без `──`.
- **Г · cards.** `.turn` — рамка; `.u` — шапка карточки (фон `--bg-raise`), справа `.tm`: `cost · time` из `sum` хода
  либо `идёт Ns` (live, тот же таймер, что у `.live`). `.steps` — вертикальная ось с точками по типу (think — полая,
  edit — `--add`, bash — `--info`, текущий — с ореолом). `.sum` — подвал карточки (в нём скрыть `cost` и время —
  они в шапке; для этого время в `sum` обернуть в `<span class="t">`). Live-ход — рамка `--info`, `.live` внутри.
- **CSS** — новый `media/feed.css` (подключить в `src/extension/webviewHost.ts` рядом с `agents.css`), стили
  варианта А в `hud.css` не трогать кроме правок вложенности. Значения — из `prototype/shared/feed.css`, селекторы
  `.log[data-v="b"]` → `.webview[data-feed="folded"] .log` и т.д.
- **Настройка:** `agentura.feed.style`, enum `journal|folded|replies|cards`, default `journal`, enumDescriptions,
  nls en/ru. Эталон — `agentura.sidebar.top` (package.json:229, `src/settings.ts` SettingKey/SETTING_KEYS/
  SettingsValues/validateSetting/readSettings, `Settings.tsx:473` строка в «Вид», `strings.ts:601`/`strings.en.ts:587`).
- **Доставка в чат** — новое необязательное поле `feedStyle` в `chat.info` (как `contextThresholds`):
  `chatController.ts` `pushInfo()`, `protocol.ts:125`, `store.ts:206` → сигнал → `data-feed` на `.webview`
  (`Chat.tsx:269`). Живое обновление уже есть: `extension.ts:149` → `ChatPanel.settingsChanged()` → `pushInfo()`.
- **Команда** `agentura.feedStyle` («Agentura: Feed Style…» / «Agentura: Вид ленты…»): QuickPick из четырёх
  вариантов с отметкой текущего, пишет `agentura.feed.style` в Global.
- Не делаем: персист свёрнутости в Б, модель в `.who`, перенос вида в боковую панель, анимации.

## Решения (2026-10-03, по итогам приёмки этапа 1)

- **Ход закрывает и ошибка без итога:** карточка `fail` или погашенная `retireFails` строка `sys` — у неё теперь
  `tag: 'fail'`. Без этого всё после ошибки (следующее сообщение, пробуждение движка, `sys`) склеивалось с мёртвым
  ходом, а при `working` он становился «идущим».
- **«В очереди» посреди хода по `turn.start` переезжает в конец ленты** (`deliverUser(…, toEnd)` в `chatState.ts`,
  перед остальными строками «в очереди», id тот же). Иначе доставленная строка открывала ход посреди прошлого и
  забирала его хвост и итог (в «карточках» — чужая цена в шапке). Меняет и журнал: строка встаёт туда, где начался
  её ход, — как при восстановлении истории. `turn.input` (влито в идущий ход) — на месте, как было.
- **Скрытые рассуждения** (⚙ «показывать рассуждения» выкл.): ходы строятся по всем строкам (id хода стабилен),
  думание скрывается при рендере; в «N действий» не считается; `.steps` только из скрытых думаний не рисуется.
- **Б:** закрытый ход с ещё идущими фоновыми агентами или инструментом не сворачивается (там их «stop»).
- **Команда** пишет вид туда, где он задан (папка / воркспейс / Global), ошибка записи — сообщением.
- **Сводка в Б:** у bash — длительность последнего запуска или «ошибка» (в прототипе «12 ✓» — числа тестов
  движок не сообщает); у идущего хода справа — сумма длительностей действий, а не время хода.
- **Г · шапка** в три колонки: текст · время отправки · `cost · time`; номера хода `#N` из прототипа нет.
- **В · чипы:** у think текст мысли скрыт — чип «think 12s» (в прототипе «думал 12s»).
- Сводка закрытого хода кэшируется по строке `sum` (WeakMap) — перерендер раз в секунду не пересчитывает её
  для всех ходов; развёрнутые вручную ходы привязаны к первой строке ленты (другая сессия или пересев истории —
  id строк снова с 1 — сбрасывают раскрытое).
- Журнал: вложенность сломала `.log .u:first-child` и `.log > * { min-width: 0 }` — поправлено в `hud.css`/
  `feed.css` (`.log > .turn:first-child > .u:first-child`, `.log .turn > *, .log .steps > *`).


## Этап 1 — реализация · sonnet, high

- [x] `turnView.ts`: `feedTurns`, `foldSummary` + `turnView.test.ts` (группировка: обычные ходы, ход без `user`,
      `sys` между ходами, открытый последний ход, серии `.steps`; сводка: ×k, +/−, think, длительность, полоса ≤ 40)
- [x] `Log.tsx`: рендер ходов, `.steps`, `.fold` с toggle, `.who`, `.tm`, `<span class="t">` в `sum`, `.live` внутри
      live-хода
- [x] настройка end-to-end + команда + строка в ⚙ «Вид» + nls/strings en/ru
- [x] `media/feed.css`, подключение в `webviewHost.ts`, правки селекторов вложенности в `hud.css`/`webview.css`
- [x] DOM-тесты: существующие зелёные; новый `feedDom.test.ts` (jsdom): `data-feed` из `chat.info`, свёрнут/раскрыт
      по клику в folded, `.live` внутри live-хода, `.tm` с ценой в cards
- [x] `npm run check` зелёный

**Готово, когда:** `npm run check` зелёный; в `journal` DOM-тесты ленты проходят без правки ожиданий по видимому
тексту; переключение `agentura.feed.style` в settings.json меняет `data-feed` открытой вкладки без переоткрытия.

## Этап 2 — приёмка · opus (автопилот: ревьюер `plan-review`)

- [x] `/plan-review` этапа 1 на ветке исполнителя, коммит (2026-10-03); мерж в main — после того, как другая сессия закоммитит
      свои правки в `chatController.ts`/`chatPanel.ts` — смержено 2026-10-03.
- Картинки вариантов — уже в галерее (прототип, v22). Как выглядит настоящий webview в четырёх видах — владелец
  смотрит в VS Code сам: пункт в `08-feed-styles.pending.md` «Проверить руками».

## Промты

### Сессия 1 — вид ленты переключателем · Модель: sonnet, effort: high

Работаем в git worktree репозитория Agentura (VS Code extension, TypeScript, Preact). Задача: реализовать настройку
`agentura.feed.style` с четырьмя видами ленты чата — по разделу «Решения» файла `docs/roadmap/08-feed-styles.md`.
Сейчас лента — плоский список строк в `.log`, вида-настройки нет.

Перед работой: в worktree нет `node_modules` — `ln -s /Users/fost/Projects/Agentura/node_modules node_modules`.
Roadmap и прототип не закоммичены — читать по абсолютным путям.

Читай: `/Users/fost/Projects/Agentura/docs/roadmap/08-feed-styles.md` (весь; галочки ставить в нём же); `prototype/shared/feed.css` и `prototype/screens/chat-feed.html`
(источник стилей и разметки; путь `/Users/fost/Projects/Agentura/prototype/…`). Правила репо: `/Users/fost/Projects/CLAUDE.md`, дальше по ссылкам.

Точки входа (проверены при планировании):
- `src/webview/components/Log.tsx:337` — `Log()`, `feedItems(rows)` → `items.map`; `sum` рендерится на ~447;
  `{children}` (строка `.live` из `Chat.tsx:348`) — последним ребёнком `.log`.
- `src/webview/agentsView.ts:80` — `feedItems()` (группа агентов `kind:'agents'`); `src/webview/chatState.ts:24` — `FeedRow`,
  tool-строка с `durationMs` (~56–62).
- `src/webview/components/Chat.tsx:269` — корень `<div class="webview">`.
- `src/protocol.ts:125` — `chat.info`; `src/extension/chatController.ts:206` — `pushInfo()`; `src/webview/store.ts:206` — приём.
- Эталон настройки: `agentura.sidebar.top` — `package.json:229`, `package.nls.json`/`package.nls.ru.json`,
  `src/settings.ts` (SettingKey ~53, SETTING_KEYS ~68, SettingsValues ~92, validateSetting ~248, readSettings ~273),
  `src/webview/components/Settings.tsx:462–476` (раздел «Вид»), `src/webview/strings.ts:601`, `strings.en.ts:587`.
- Команды — `src/extension/extension.ts:128–166`; строки хоста — `src/shared/l10n.ts`.
- CSS подключается в `src/extension/webviewHost.ts:44`. Стили ленты: `media/hud.css:106–136, 199–204, 349`,
  `media/webview.css:67–81, 127–128, 135`.
- Тесты-эталоны: `src/webview/agentsDom.test.ts`, `src/webview/sessionsDom.test.ts:219,250`, `src/webview/settingsDom.test.ts`
  (список ключей ~108, значения ~42), `src/manifest.test.ts`, `src/settings.test.ts`.

Уже решено, не переспрашивать: всё в разделе «Решения» roadmap — один DOM + `data-feed`, разметка хода, правила
группировки, состав сводки, где лежат стили, путь настройки через `chat.info`, команда QuickPick, default `journal`.

Порядок:
1. `turnView.ts` + тест (чистые функции).
2. `Log.tsx` — разметка ходов; прогнать существующие DOM-тесты, починить селекторы вложенности в CSS.
3. Настройка end-to-end, строка в ⚙, команда, nls/strings.
4. `media/feed.css` + подключение.
5. `feedDom.test.ts`. Галочки этапа 1 в roadmap — по факту проверки.

DoD: `npm run check` зелёный (typecheck, lint, test, build). Проверка: `npm run check > /tmp/feed-check.log 2>&1; tail -30 /tmp/feed-check.log`.

Не делать: этап 2; правки вне перечисленного; «заодно улучшить» — нет; dev-процессы не запускать; `.vsix` не
собирать. Вопрос без ответа в roadmap — в отчёт, не додумывать.

Не коммитить, не пушить. Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено /
открытые вопросы.
