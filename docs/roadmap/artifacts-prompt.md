Сессия 1 — артефакты: инструмент Artifact и локальный превью HTML · Модель: sonnet, effort: high · одна сессия

Работаем в /Users/fost/Projects/Agentura (VS Code-расширение, TS, webview на Preact, движок — Claude Agent SDK 0.3.285).
Задача: (1) включить в движке инструмент Claude Code `Artifact` и показать его вызов своей карточкой со
статусом и ссылкой на claude.ai; (2) кнопка «превью» у записанных/изменённых `.html` и у артефакта — открывает
файл в соседней вкладке webview, перерисовывает при изменении файла. Стройка поверх готового (релиз 0.1.0).

Читай: README.md (раздел проверок, `npm run check`); CHANGELOG.md (формат записи).
Точки входа (проверены при планировании — не перечитывать ради подтверждения, открывать только правимый фрагмент):
- src/agent/claude/adapter.ts:108 `engineEnv()`; тест src/agent/claude/adapter.test.ts:64-90 (`describe('engineEnv')`, `toEqual` на всё окружение).
- src/webview/toolView.ts:43 `toolView()` — `switch (name)`; тесты src/webview/toolView.test.ts.
- src/webview/components/Log.tsx:39 `ToolRight` (ссылка «diff» — эталон кнопки), :68 `toolRight()`, :89 `Tool()`, :147 рендер `ToolRight`, :196/:235/:246 проброс `onDiff`.
- src/webview/components/Chat.tsx:204 — `onDiff={… send({type:'diff.open', …})}`.
- src/protocol.ts:165 `FromWebview` (`diff.open`), :244 список имён для `isFromWebview`; тест src/protocol.test.ts.
- src/extension/chatController.ts:44-56 тип deps (`openDiff?`), :401 `case 'diff.open'` в `handle()`; тесты src/extension/chatController.test.ts:309-370 (diff.open — эталон).
- src/extension/chatPanel.ts:253-259 — проводка `openDiff` в deps с выбором колонки (One↔Two).
- src/extension/diffDocuments.ts + `services.diffs` — эталон сервиса, который регистрируется в extension.ts (`services.diffs.register()`).
- src/extension/html.ts:14 `buildWebviewHtml` — как собирается CSP; тест src/extension/html.test.ts — эталон теста чистой функции.
- src/webview/strings.ts:12 `ui.log` (там `diff: 'diff'`).

Факты (проверены пробой и транскриптами, не перепроверять):
- Без env `CLAUDE_CODE_ARTIFACT=1` в `init.tools` нет `Artifact`/`ArtifactComments`/`ArtifactData`; с ним — есть.
  `CLAUDE_CODE_ARTIFACT_AUTO_OPEN` управляет автооткрытием ссылки самим CLI.
- input `Artifact`: `{ action?: 'publish'|'read'|'list'|'delete'|'open'|'pin'|'unpin'|'quickstart', file_path?, url?, title?, type_url?, … }`; без `action` = publish.
- `tool_use_result` (приходит в строку как `t.result`) у publish: `{ url, path, title, updated: boolean, seq: number, version, … }`;
  создание из типа: `{ created_from_type: true, url, title, … }`; read файла: `{ file_read: {…} }`; quickstart: `{ quickstart: {…} }`;
  ошибка — строка `"Error: …"` (строка уйдёт в state 'err' штатно).

Уже решено, не переспрашивать:
1. engineEnv: после чистки выставить `CLAUDE_CODE_ARTIFACT` = '1' и `CLAUDE_CODE_ARTIFACT_AUTO_OPEN` = '0', но только если в base их нет
   (`??=` — пользователь может переопределить). Обновить ожидание в adapter.test.ts + отдельный кейс «значение из base сохраняется».
   Комментарий у кода: флаг недокументирован, проверен на CC 2.1.285.
2. toolView: `case 'Artifact'` → `{ op: 'artifact', what }`: action publish/undefined — basename `file_path`, иначе `title`, иначе `url`;
   прочие action — `what` = action (+ ` · ${url}` клипом, если url есть). Тесты на publish / quickstart / read.
3. Новая чистая функция в toolView.ts `toolLinks(name, input, result, state): { preview?: string; url?: string }` (только при state 'ok'):
   - Write/Edit/MultiEdit с `file_path` на `/\.html?$/i` → `preview = file_path`;
   - Artifact: `url = result.url` (строка, начинается с `https://claude.ai/`), `preview = result.path ?? input.file_path`, если на `.html?`;
   - иначе `{}`. Тесты на все ветки, включая «не https://claude.ai — url нет».
   И `artifactStatus(result): string | undefined`: `created_from_type` → ui.log.artifactCreated; `updated === true` → `${ui.log.artifactUpdated} · v${seq}`;
   `updated === false` и есть url → ui.log.artifactPublished; иначе undefined. Тесты.
4. Log.tsx: в `Right` добавить `preview?: string; url?: string`; `toolRight` при ok кладёт туда `toolLinks(...)`, а для Artifact — статус в `text`
   (перед длительностью: `статус · 1.2s`). `ToolRight` рисует после «diff» ссылки `ui.log.preview` и `ui.log.open` тем же паттерном
   (`href="#"`, preventDefault + stopPropagation, разделитель ' · '). Пропсы: `onPreview: (path: string) => void`, `onOpenUrl: (url: string) => void`,
   пробросить так же, как `onDiff` (Tool, Log, вложенные группы на :246).
5. Протокол: `{ type: 'preview.open'; path: string }` и `{ type: 'link.open'; url: string }` в `FromWebview` + в список имён :244 + тест валидации.
   Chat.tsx шлёт их из `onPreview`/`onOpenUrl`.
6. chatController: deps `openPreview?(path: string): Promise<void>` и `openExternal?(url: string): void`; в `handle()`:
   `preview.open` — только абсолютный путь на `/\.html?$/i`, иначе `log.warn` и выход; `link.open` — только `/^https:\/\/claude\.ai\//`, иначе warn.
   Тесты по образцу diff.open: валидный вызывает deps, невалидный — нет.
7. Новый src/extension/previewHtml.ts (без импорта vscode) — `previewHtml(source, { cspSource, baseHref }): string`: вставляет сразу после
   открывающего `<head…>` (регистронезависимо; нет `<head>` — в начало документа) `<meta http-equiv="Content-Security-Policy" content="…">`
   и `<base href="…">`. CSP ровно:
   `default-src 'none'; img-src ${cspSource} https: data: blob:; media-src ${cspSource} https: data: blob:;
   style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com;
   font-src ${cspSource} data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
   script-src ${cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com;
   connect-src ${cspSource}` (в коде — массив строк через '; ', как в html.ts). Тест previewHtml.test.ts: с `<head>`, `<HEAD lang>`, без head, атрибуты экранированы.
8. Новый src/extension/previewPanels.ts — класс `PreviewPanels` (dispose-able, создаётся рядом с `diffs` в services, dispose в subscriptions):
   `open(path, column)`: `stat` файла (нет — `showWarningMessage('Agentura: файла нет — <path>')`); уже открыт — `reveal(column, true)` и перерисовка;
   иначе `createWebviewPanel('agentura.preview', \`превью · ${basename}\`, { viewColumn: column, preserveFocus: true },
   { enableScripts: true, localResourceRoots: [Uri.file(dirname(path)), ...workspaceFolders.map(f => f.uri)] })`. Рендер: readFile utf8 →
   `previewHtml(src, { cspSource: webview.cspSource, baseHref: webview.asWebviewUri(Uri.file(dirname + '/')).toString() })`.
   Слежка: `createFileSystemWatcher(new RelativePattern(Uri.file(dirname), basename))`, onDidChange/onDidCreate → перерисовка с debounce 150 мс.
   onDidDispose — снять watcher, таймер и запись из Map<fsPath, …>. Сообщений webview не слушать (`onDidReceiveMessage` не вешать) — превью
   изолировано от расширения намеренно. `retainContextWhenHidden` не ставить.
9. chatPanel.ts: в deps `openPreview: (p) => services.previews.open(p, <та же колонка, что у openDiff>)` — вынести выбор колонки в локальную
   функцию и использовать в обоих; `openExternal: (u) => void vscode.env.openExternal(vscode.Uri.parse(u))`.
10. strings.ts `ui.log`: `preview: 'превью'`, `open: 'открыть'`, `artifactCreated: 'создан'`, `artifactUpdated: 'обновлён'`, `artifactPublished: 'опубликован'`.
11. CHANGELOG.md — запись в начало (раздел «не выпущено» по формату файла): артефакты Claude Code в ленте и превью HTML.

Порядок:
1. engineEnv + тест.
2. toolView (`case 'Artifact'`, `toolLinks`, `artifactStatus`) + тесты.
3. strings, Log.tsx, Chat.tsx.
4. protocol + тест.
5. chatController + тесты.
6. previewHtml + тест, previewPanels, проводка в services/chatPanel/extension.ts.
7. CHANGELOG.

DoD: `npm run check` зелёный (typecheck, lint, vitest, build); новые тесты из пунктов 1, 2, 3, 5, 6, 7 существуют и проходят.
Проверка: `npm run check > /tmp/agentura-check.log 2>&1; tail -30 /tmp/agentura-check.log`. Интеграционные тесты и `npm run package` не запускать.

Не делать: свою реализацию публикации/чтения артефактов (это делает CLI), `window.claude.*` в превью, канал сообщений превью↔расширение,
настройки в package.json, правки прототипа (prototype/), «заодно улучшить» соседний код. Чужие незакоммиченные файлы не трогать.
Вопрос, на который нет ответа здесь, — в отчёт, не додумывать.

Не коммитить и не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы.
Отчёт — единственное, что увидит приёмка: без него работа потеряна.
