# 41. Открытие файловых ссылок `file://` и диапазонов строк `#L10-L20` из чата

> Статус: выполнено · 2026-11-14 · размер S/M (4 файла + тесты).

## Контекст и диагноз

В системном промте Antigravity (`agy`) жёстко зашито требование оформлять любые ссылки на файлы через схему `file://` и диапазоны строк GitHub-формата:
- `[notes.md](file:///path/to/notes.md)`
- `[notes.md](file:///path/to/notes.md#L10-L20)`

В отличие от Claude и Codex (которые чаще пишут бесcхемные пути `/abs/path:10` или `src/file.ts#L10`), ссылки Antigravity сейчас режутся сразу в трёх местах подряд:

1. **Санитайзер `DOMPurify` в webview (`src/webview/markdown.ts:36-37`):**
   `ALLOWED_URI_REGEXP` разрешает `conversation://` (добавлено в roadmap 38), но **не разрешает `file://`**. `DOMPurify.sanitize()` молча удаляет атрибут `href` у `<a href="file:///...">`, оставляя голый тег `<a>текст</a>` (это поведение даже закреплено в старом тесте `src/webview/markdown.test.ts:42,53`). При этом правило `.log .txt a { color: var(--link); }` (`media/webview.css:78`) красит `<a>` без `href` в цвет кликабельной ссылки, а клик в `onMarkdownClick` (`src/webview/markdown.ts:78-79`) получает `link.getAttribute('href') === null` и ничего не шлёт хосту.
2. **Фильтр схем в хосте (`src/extension/chatController.ts:825-843`):**
   Даже если `file:///...` доходит в `case 'link.open'`, строка не распаковывается из `file://`-URI в локальный путь, попадает под запрет схем `/^[a-z][a-z\d+.-]*:/i.test(path)` и отбрасывается с `this.log.warn('ссылка не открыта: ...')` (закреплено в `src/extension/chatController.test.ts:640` ещё со времён до коммита `ddae600`, когда `link.open` вызывал только `vscode.env.openExternal`).
3. **Суффикс диапазона строк `#L10-L20` / `:10-20` (`src/extension/chatController.ts:832`):**
   Текущая регулярка `/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/` матчит только одиночную строку (`#L9`, `:35:4`), но **не матчит диапазоны** `#L793-L801`, `#L10-20`, `#L10C1-L20C5`, `:10-20`. Суффикс `#L793-L801` остаётся приклеенным к имени файла, и `vscode.Uri.file(path)` пытается открыть несуществующий файл `login.php#L793-L801`.

## Принятые решения и границы безопасности

- **`file://` открывать только во вкладке редактора VS Code (`deps.openPath`), никогда через `openExternal`:**
  Передача `file://` в `vscode.env.openExternal` отдаёт файл системному LaunchServices/Shell (опасно для `.app`, `.command`, `.bat`, `.desktop`). Напротив, `deps.openPath` вызывает `vscode.window.showTextDocument(vscode.Uri.file(p))` — безопасное открытие текстового буфера в редакторе, ровно как уже работают бесcхемные пути `/etc/passwd` и `/tmp/...` (`chatController.test.ts:651`).
- **Строгий разбор `file://` без сетевых UNC-шар:**
  Принимать только локальные `file://` URI с пустым хостом или `localhost`:
  - POSIX: `file:///Users/fost/...` и `file://localhost/Users/fost/...` → `/Users/fost/...`;
  - Windows-пути из промта AGY (`For Windows, use forward slashes`): `file:///C:/Users/...` и `file://localhost/C:/Users/...` → `C:/Users/...`.
  Любой непустой `host !== 'localhost'` (`file://evil-host/share/a.txt`), `file://` без абсолютного пути (`file:relative`, `file://`), процент-кодированные управляющие символы (`%00`, `\p{Cc}`), query-параметры `?` до `#` и пути `//remote/...` отклонять с `this.log.warn`.
- **Диапазоны строк и колонок:**
  Поддержать оба формата локации в конце пути (до декодирования фрагмента или на распакованном пути):
  - `#L<line>[C<col>][-L?<endLine>[C<endCol>]]` (`#L10`, `#L10C4`, `#L10-L20`, `#L10-20`, `#L10C2-L20C8`);
  - `:<line>[:<col>][-<endLine>[:<endCol>]]` (`:12`, `:35:4`, `:10-20`, `:10:2-20:8`).
  Расширить `ChatDeps.openPath?(path: string, line?: number, column?: number, endLine?: number, endColumn?: number)` и в `src/extension/chatPanel.ts:887-894` выставлять `vscode.Range(line - 1, col - 1, endLine - 1, endCol - 1)`, чтобы диапазон подсвечивался в редакторе (если `endLine < line`, игнорировать конец диапазона и ставить курсор на `line`).
- **Честная стилизация вычищенных ссылок в CSS (`media/webview.css`):**
  По образцу `media/tasks.css:281` (`.tv .rich a:not([href])`) задать для `.log .txt a:not([href]), .ask .md a:not([href])` `color: inherit; text-decoration: none; cursor: default;`, чтобы реально заблокированные опасные схемы (`javascript:`, `command:`, `vscode:`) не притворялись синими ссылками, а живым `.log .txt a[href], .ask .md a[href]` добавить `cursor: pointer;`.

## Точки входа

- `src/webview/markdown.ts` (`ALLOWED_URI_REGEXP`, строки `35-38`) и `src/webview/markdown.test.ts` (`38-69`).
- `src/extension/chatController.ts` (`ChatDeps.openPath` на `166-167`, `case 'link.open'` на `807-851`) и `src/extension/chatController.test.ts` (`631-697`).
- `src/extension/chatPanel.ts` (`openPath` на `887-895`).
- `media/webview.css` (`.log .txt a`, `.ask .md a` на `78`, `98`).

## План и DoD

1. В `src/webview/markdown.ts` разрешить `file:\/\/` в `ALLOWED_URI_REGEXP` (оставив запрет на `javascript:`, `data:`, `vbscript:`, `command:`, `vscode:`).
2. В `src/extension/chatController.ts` в `case 'link.open'`:
   - перед общей проверкой схем обрабатывать `^file:\/\/` через чистый парсер локального `file://` URI (только пустой `authority` или `localhost`, без `?query`, `decodeURIComponent` пути и `#fragment`, запрет `\p{Cc}` и ведущего `//`);
   - вырезать суффикс локации с поддержкой одиночной позиции и диапазонов (`#L10-L20`, `#L10-20`, `#L10C2-L20C8`, `:10-20`, `:10:2-20:8`);
   - передавать путь и координаты в `deps.openPath(resolveFrom(deps.cwd, path), line, column, endLine, endColumn)` (никогда не в `openExternal`).
3. В `src/extension/chatPanel.ts` пробросить `endLine` / `endColumn` в `new vscode.Range(...)` при вызове `showTextDocument`.
4. В `media/webview.css` добавить `:not([href])`-сброс для `.log .txt a` и `.ask .md a` и `cursor: pointer` для `a[href]`.
5. Обновить и дополнить unit/DOM-тесты в `src/webview/markdown.test.ts` и `src/extension/chatController.test.ts`:
   - `file:///abs/path.md`, `file:///abs/my%20file.php#L793-L801`, `file://localhost/tmp/a.ts#L10C3-L12C9`, `file:///C:/dir/a.ts#L5-10`, бесcхемный `/abs/a.ts:10-20`;
   - негативные кейсы: `file://remote-host/share/a.txt`, `file:relative.txt`, `file:///tmp/a.txt?x=1`, `file:///tmp/%00a`, `vscode://file/etc/passwd`, `command:...`, `javascript:...` (ни `openPath`, ни `openExternal` не вызываются).
6. Проверки DoD:
   - `npx vitest run src/webview/markdown.test.ts src/extension/chatController.test.ts` — код `0`;
   - `npm run typecheck && npm run lint && npm run build && git diff --check` — код `0` (не трогая чужие dirty-изменения в рабочем дереве).

## Checkpoint (2026-11-14)

- **Реализация:**
  - `src/webview/markdown.ts`: `ALLOWED_URI_REGEXP` расширен `file:\/\/` с сохранением блокировки опасных схем.
  - `src/extension/pathKey.ts`: `resolveFrom` распознаёт Windows absolute drive paths (`/^[a-zA-Z]:[\\/]/`) на любой платформе (macOS/Linux), не склеивая их с cwd.
  - `src/extension/chatController.ts`: `ChatDeps.openPath` расширен параметрами `(path, line, column, endLine, endColumn)`. Реализован строгий парсер `file://` (только `localhost` или пустой authority, запрет `?query`, `\p{Cc}`, UNC-путей `//`, `\\\\` и `/\\\\` в т.ч. после URL-encoding, диска без слеша `file:///C:`, невалидного `%`-encoding) и поддержка диапазонов `#L10-L20`, `:10-20` (с защитой буквы диска `C:/...`). В бесcхемной ветке добавлена блокировка `\\\\`.
  - `src/extension/chatPanel.ts`: проброшен `vscode.Range(line - 1, startCol, endLine - 1, endCol)` с дефолтом `Number.MAX_SAFE_INTEGER` при отсутствии `endColumn`.
  - `media/webview.css`: стили `:not([href])` и `a[href] { cursor: pointer; }`.
  - `src/webview/markdown.test.ts` и `src/extension/chatController.test.ts`: покрыты все позитивные и негативные сценарии.
- **Проверки:**
  - `npx vitest run src/webview/markdown.test.ts src/extension/chatController.test.ts` — код 0 (147 tests passed).
  - `npm run typecheck` — код 0.
  - `npm run lint` — код 0.
  - `npm run build` — код 0.
  - `git diff --check` — код 0.

