# Релиз 0.3.0 — промт исполнителя (скриншоты для README)

README, CHANGELOG и версию делает Opus-сессия параллельно; исполнитель делает только скриншоты.

## Промт 1 — скриншоты README из настоящих webview

```
Сессия 1 — английские скриншоты для README · Модель: sonnet, effort: high

Работаем в /Users/fost/Projects/Agentura. Задача: воспроизводимый скрипт `scripts/readme-shots/`, который
рендерит настоящие webview-бандлы (`dist/webview/{chat,sidebar,agents,settings}.js`) headless-хромом с английским
интерфейсом на английских данных и складывает готовые PNG в `docs/images/`. Стройка, но эталоны есть.

Эталоны (оставлены прошлыми сессиями, скопировать идеи, не запускать оттуда):
- /private/tmp/claude-501/-Users-fost-Projects-Agentura/e84bbf98-8b77-4842-aaf8-1553c9614cae/scratchpad/real/ —
  render.py (переменные тем VS Code `THEMES`/`vars_`, список css из `media/`, заглушка `acquireVsCodeApi`,
  сообщения `init`/`appearance`, команда хрома), build.mjs + chatEntry.tsx + gen.ts + sim.ts (живой ход с агентами
  поверх реального store), graph-*.html (вкладка графа агентов на `dist/webview/agents.js`).
- /private/tmp/claude-501/-Users-fost-Projects-Agentura/a8f714ce-cf14-4d74-acee-00fe3656d561/scratchpad/real-git/gen.mjs —
  вкладка git: `chat.info` с `gitLayout`, `session.history` с Edit/Write (метка агента), `git.state`, panel-state
  через `getState`.
- /private/tmp/claude-501/-Users-fost-Projects-Agentura/3fb9e939-f81c-4144-95bb-d0de9c7f5b4b/scratchpad/feed-harness/ —
  стили ленты (`agentura.feed.style`: journal / folded / replies / cards).
Протокол сообщений хост ↔ webview: src/protocol.ts. Боковая панель: src/webview/sidebar/, настройки:
src/webview/settings/. Обвязки для них нет — собрать по образцу, сообщения взять из protocol.ts и того, как их шлёт
хост (src/extension/sidebarView.ts или аналог — найти grep по 'sessions.' / 'account').

Уже решено, не переспрашивать:
- Язык: `<html lang="en">` (src/webview/strings.ts:917 берёт язык отсюда). ВСЕ данные английские: проект, имена
  сессий, промпты, ответы ассистента, описания агентов, коммиты, аккаунт (user@example.com). Ни одной кириллической
  буквы в кадре. Фикстуры src/webview/fixtures/* и транскрипты src/agent/claude/__fixtures__ — русские, не
  годятся как есть: свои данные в `scripts/readme-shots/data.mjs` (или .ts). Сюжет один на все кадры:
  проект `queue` (электронная очередь), задача «Fix the board counter blink on reconnect» — как в real-git/gen.mjs.
- Темы: VS Code Dark Modern / Light Modern — переменные из render.py как есть. Грабли: двойные кавычки внутри
  `style` на `<html>` обрывают `--vscode-*` (тема и шрифты не применяются) — внутри только одинарные.
- Хром: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --disable-gpu
  --allow-file-access-from-files --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=3000`.
  Склейка и обрезка — Python PIL (12.1.1 есть). Подписи в монтажах — тонкий текст над кадром, системный шрифт,
  цвет `descriptionForeground` темы, фон монтажа = фон редактора темы, отступ 24 px (в 2x — 48).
- Скрипт: один вход `node scripts/readme-shots/run.mjs` (сам собирает обвязку esbuild'ом из node_modules проекта,
  пишет временные html в `os.tmpdir()`/scratchpad, не в репо, рендерит, монтирует). Требует собранного `dist/`
  (`npm run build`) — проверять наличие и падать с понятной ошибкой. В шапке run.mjs — 3–5 строк, что делает и как
  запускать. Пути не зашивать абсолютными на /Users/fost — от `import.meta.url`.
- Итоговые файлы ровно эти (`docs/images/`), PNG, сохранять PIL `optimize=True`:
  1. `hero-dark.png`, `hero-light.png` — 1324×760 (в 2x 2648×1520): слева боковая панель (sidebar.js, ширина 300,
     аккаунт и лимиты + список сессий, вид compact), справа вкладка чата (chat.js) с законченным ходом: промпт,
     пара вызовов инструментов, правка с диффом, ответ ассистента; приборы у поля ввода (контекст, стоимость, кэш,
     лимиты) видны; правая панель открыта на вкладке «changes» шириной 360. Склейка — страница с двумя iframe
     (у каждого свой html со своей заглушкой acquireVsCodeApi), разделитель 1 px цветом `panel-border`. Без
     фальшивого хрома VS Code (заголовок окна, activity bar не рисовать).
  2. `feed-styles.png` — монтаж 2×2: journal, folded, replies, cards (тёмная тема), подписи `journal (default)`,
     `folded`, `replies`, `cards`. Каждый кадр — вкладка чата 760×760 без правой панели, один и тот же ход.
  3. `agents-views.png` — монтаж 2×2: list, tree, lanes, cards (тёмная): правая панель на вкладке «agents»,
     момент «ход идёт, 3–4 субагента, один упал или завершён». Кадр — вырезка правой панели (360 px) высотой 760.
     Если 4 вырезки по 360 в 2×2 выглядят пусто — 1×4 в ряд; выбрать по виду и написать в отчёте.
  4. `agents-graph.png` — вкладка графа (agents.js) 1100×760, тёмная, тот же ход, агент выбран.
  5. `git-layouts.png` — монтаж 1×3: stack, picker, unified (тёмная), вырезки правой панели 360×760, подписи.
     Данные multi-repo — как в real-git/gen.mjs.
  6. `session-list.png` — монтаж 1×3: detailed, compact, dense (тёмная), вырезки боковой панели 300×760, подписи.
  7. `settings-look.png` — вкладка настроек (settings.js), страница «Look» (там превью стилей), 1100×760, тёмная.
- Перед каждым кадром — `waitFor`: дать бандлу отрисоваться (virtual-time-budget, при нужде больше). Пустой или
  полупустой кадр — баг обвязки, не «так и задумано».

Порядок:
1. `npm run build`, затем каркас run.mjs + общий модуль темы/html/хрома (по render.py).
2. Кадр hero (самый сложный: sidebar-обвязка + склейка). Посмотреть PNG глазами (Read), поправить.
3. Остальные кадры и монтажи. Каждый PNG открыть Read и проверить: английский текст, ничего не обрезано на краях
   панели, нет пустых областей, тема применилась (не белый фон в тёмной).
4. Повторный прогон `node scripts/readme-shots/run.mjs` с нуля даёт те же файлы без ручных шагов.
5. Размер: `du -ch docs/images/*.png` — цель ≤ 8 МБ суммарно. Больше — монтажи сохранить с уменьшением до ширины
   2400 px (LANCZOS), hero не трогать.

DoD: `npm run build && node scripts/readme-shots/run.mjs` создаёт ровно 8 файлов из списка в docs/images/;
каждый открыт и осмотрен; в данных обвязки нет кириллицы (`grep -nP '[\x{0400}-\x{04FF}]' scripts/readme-shots/*`
пусто); `npm run lint` и `npm run typecheck` зелёные (если скрипт попадает под eslint — привести в порядок, а не
исключать из конфига без нужды; если исключение неизбежно — одна строка в eslint.config.mjs с комментарием).
`.vscodeignore` уже исключает `docs/**` и `scripts/**` — не трогать.

Не делать: не править src/, media/, README*, CHANGELOG, package.json (кроме ничего); не трогать prototype/;
не публиковать артефакты; не рендерить прототип. Вопрос без ответа в промте — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы, размеры PNG) / отклонения от плана (в т.ч. выбор 2×2 или 1×4 для
agents-views) / что не получилось отрендерить и почему / открытые вопросы. Отчёт — единственное, что увидит
приёмка: без него работа потеряна.
```

## Приёмка (2026-10-05)

Принято: 8 PNG в `docs/images/` (2,8 МБ), `node scripts/readme-shots/run.mjs` пересобирает их с нуля. Отклонения
исполнителя приняты: `agents-views` — 1×4 (2×2 из узких вырезок выходит колонкой); esbuild не нужен — бандлы
`dist/webview/*` получают сообщения протокола напрямую; боковая панель — в iframe (headless-хром не делает окно
уже ~500 px). Правка приёмки: `settings-look.png` обрезан до карточек стиля ленты — ниже превью видов агентов.

Открыто (баг приложения, не обвязки):
- [ ] ⚙ → «Внешний вид» → «Карта агентов» при ширине страницы ~1100: превью `tree` и `cards` сжаты (колонка
      основного агента в символ шириной, «main136k» слипается), превью `graph` уходит под край
- [ ] Вид `cards` на 360 px: «turn 1 | session» и «1 running · 1 done · 1 error» переносятся в две строки

Проверки: `npm run check`, `npm run test:integration`, `npm run package` (agentura-0.3.0.vsix, 6,5 МБ),
`node scripts/vsix-verify.mjs` — зелёные. Тег `v0.3.0` — владелец.
