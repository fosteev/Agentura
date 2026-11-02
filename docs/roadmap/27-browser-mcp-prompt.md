# 27 — тумблер «Браузер» (Playwright MCP --extension)

Сессия 1 — тумблер «Браузер» · Модель: sonnet, effort: high · одна сессия

Работаем в /Users/fost/Projects/Agentura. Задача: настройка `agentura.browser.enabled` (по умолчанию выкл.) подключает к сессиям Claude и Codex MCP-сервер `browser` = `npx -y @playwright/mcp@latest --extension` (Playwright MCP управляет настоящим Chrome пользователя через расширение Playwright MCP Bridge). Antigravity — не поддерживает (MCP у agy нет). Стройка поверх существующих механизмов, своего браузерного расширения не пишем.

Читай: ~/.claude/roles/coder.md; docs/roadmap/22-mcp-toggle.md (раздел «Разведка» — как устроены MCP у движков); AGENTS.md (правила репо).
Точки входа (проверены при планировании — не перечитывать ради подтверждения, открывать только правимый фрагмент):
- `src/agent/types.ts:414` `SessionOptions` — рядом с `mcpWatch`; `src/agent/types.ts:548` `setMcpWatch?` в `AgentSession` — рядом.
- `src/agent/features.ts` — `ProviderFeatures` (поле `mcp` на :32), значения у CLAUDE (:54), CODEX (:80), ANTIGRAVITY (:103).
- `src/agent/claude/adapter.ts:609-617` — сборка `sdkOptions.mcpServers` (сейчас только `agentura_jira`); `:671-691` `syncTaskTools` — `setMcpServers(servers)` ЗАМЕНЯЕТ весь набор SDK-серверов; `:824` `setMcpWatch` — образец «меняется на ходу».
- `src/agent/codex/adapter.ts:328-332` — спавн `codex app-server --listen stdio://`; `:489` `setMcpWatch`.
- `src/extension/chatController.ts:1508-1516` — объект `base` опций сессии; `:289` — `this.current?.setMcpWatch?.(...)` после смены настроек (место для живого переключения); `:104` — поля `deps.settings()`.
- `src/extension/chatPanel.ts:754-777` — `settings: () => {...}` (образец `gitHideClean: cfg.get<unknown>('git.hideClean') === true`).
- `src/settings.ts` — `SettingKey` (:205), `SETTING_KEYS` (:253), тип значения (:324), валидация boolean (:566), `readSettings` (:729). Эталон целиком — ключ `git.hideClean`, повторить его путь во всех местах.
- `package.json:553` — `agentura.git.hideClean` в `contributes.configuration`; описания в `package.nls.json` / `package.nls.ru.json`.
- `src/webview/components/Settings.tsx:1102` — `<Row … k="git.hideClean"><Toggle …/></Row>`; строки — `src/webview/strings.ts` / `strings.en.ts`.

Уже решено, не переспрашивать:
1. Константы в новом `src/agent/browserMcp.ts`: `BROWSER_SERVER = 'browser'`, `BROWSER_COMMAND = 'npx'`, `BROWSER_ARGS = ['-y', '@playwright/mcp@latest', '--extension']`. Без настройки своей команды/аргументов.
2. `ProviderFeatures.browser: boolean` — Claude `true`, Codex `true`, Antigravity `false`.
3. `SessionOptions.browser?: boolean`. В `chatController` `base` получает `browser: true` только если `providerFeatures(provider).browser && s.browser`.
4. Claude: stdio-сервер `{ type: 'stdio', command, args }` в `sdkOptions.mcpServers` рядом с jira. Набор SDK-серверов собирать одной приватной функцией (jira по текущему spec + browser по флагу), её же звать в конструкторе, в `syncTaskTools` и в новом `setBrowser(on)` — иначе `setMcpServers` из `syncTaskTools` снесёт браузер, а `setBrowser` — jira. `setBrowser(on)`: флаг не изменился — ничего; изменился — `setMcpServers(набор)`, затем `refreshMcp(false)` если `mcpWatch`, ошибки — `this.log('warn', …)`. Метод в `AgentSession` — опциональный `setBrowser?(on: boolean): void`.
5. Codex: при `options.browser` добавить к аргументам спавна app-server `-c`, `mcp_servers.browser.command="npx"`, `-c`, `mcp_servers.browser.args=["-y","@playwright/mcp@latest","--extension"]` (TOML-значения, собрать из констант через `JSON.stringify`; `codex app-server --help` подтверждает `-c key=value` с TOML). Живого переключения у Codex нет (`setBrowser` не реализовывать) — действует с нового чата / возобновления; это сказать в описании настройки.
6. Живое переключение: в `chatController` рядом с `:289` — `this.current?.setBrowser?.(providerFeatures(this.engineProvider).browser && s.browser === true)`.
7. Настройка `agentura.browser.enabled`, boolean, default `false`, по пути `git.hideClean`. Ключ в settings.ts — `'browser.enabled'`, поле в `deps.settings()` — `browser`.
8. Строка в UI настроек — в секции MCP (рядом с настройками `mcp.*`), `Toggle` по образцу, `isNew`. Название RU «Браузер (Playwright MCP)», EN «Browser (Playwright MCP)». Описание (RU/EN, по смыслу одинаково, то же — в package.nls*): агент управляет вашим Chrome через расширение Playwright MCP Bridge (поставить из Chrome Web Store); Claude и Codex, у Codex — с нового чата; предупреждение: страницы могут содержать инструкции для агента (prompt injection), а у агента есть доступ к файлам и терминалу — не включайте без нужды и не разрешайте браузерные действия не глядя.
9. Разрешения не трогать: вызовы инструментов `browser` идут через обычный `canUseTool` → вопрос пользователю. В `autoAllow` браузер НЕ добавлять.

Порядок:
1. Тесты: `src/agent/claude/adapter.test.ts` — с `browser: true` в опциях query есть `mcpServers.browser`; без — нет; `setBrowser(true)` зовёт `setMcpServers` с набором, где есть и jira (если задача привязана), и browser; повторный `setBrowser(true)` ничего не зовёт; `syncTaskTools` при включённом браузере не теряет его. `src/agent/codex/adapter.test.ts` — с `browser: true` аргументы спавна содержат обе пары `-c`, без — как раньше. Тест настройки по образцу тестов `git.hideClean` (если такие есть).
2. Константы, features, типы, адаптеры Claude и Codex.
3. Настройка: package.json + nls, settings.ts, chatPanel `settings()`, chatController `base` и живое переключение.
4. UI-строка в Settings.tsx + строки RU/EN.

DoD: `npm run check` зелёный (typecheck + lint + test + build). Новые тесты из п.1 есть и проходят.
Проверка: `npm run check > $SCRATCH/check.log 2>&1; tail -30 $SCRATCH/check.log` (SCRATCH — /private/tmp/claude-501/-Users-fost-Projects-Agentura/fbe4b647-6fc4-4a1a-a0cf-b1521ce088ab/scratchpad).
Примеры:
- Claude, браузер выкл., задача с Jira → `mcpServers` = только `agentura_jira`.
- Claude, браузер вкл., без задачи → `mcpServers` = только `browser`; в ленте MCP он появится сам (статус от движка).
- Claude, сессия идёт, пользователь включил тумблер → `setMcpServers({browser})` без перезапуска; выключил → `setMcpServers({})`.
- Codex, браузер вкл. → спавн `codex app-server --listen stdio:// -c mcp_servers.browser.command="npx" -c mcp_servers.browser.args=[…]`; переключение посреди чата — ничего не происходит.
- Antigravity, браузер вкл. → в опциях сессии `browser` нет.

Не делать: своё браузерное расширение, кнопку в composer, отдельную вкладку, автоустановку Playwright/расширения, изменения `autoAllow`/разрешений, README/CHANGELOG/версию (это приёмка); чужие незакоммиченные файлы (`.codex/`, `AGENTS.md`) не трогать; «заодно улучшить» — нет. Вопрос, на который нет ответа в промте, — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено / открытые вопросы. Отчёт — единственное, что увидит приёмка: без него работа потеряна.
