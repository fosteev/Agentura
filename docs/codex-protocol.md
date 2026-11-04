# Codex: протокол app-server и обновление CLI

Codex подключён как второй движок (roadmap 15). Agentura запускает `codex app-server` (JSON-RPC 2.0 поверх stdio,
построчный JSON) на каждую вкладку и один короткий процесс на чтение списка/истории/rename. Сам протокол Codex
помечает как **experimental**, поэтому типы не копируются из CLI, а описаны вручную и сверяются скриптом.

## Где что лежит

- `src/agent/codex/protocol.ts` — используемое подмножество протокола: методы, уведомления, server requests, типы.
  В шапке — версия CLI, с которой сверено (`CODEX_PROTOCOL_VERSION`, сейчас `0.166.0`). Чего здесь нет — `unknown`.
- `scripts/codex-protocol.mjs` (`npm run codex:protocol`) — регенерирует схему `codex app-server generate-ts --experimental` во
  временную папку (в репо она не попадает, 600+ файлов) и проверяет, что методы и поля, которые использует Agentura,
  на месте. Списки в скрипте — зеркало `protocol.ts`, их ведут руками. Код 1 — расхождение или нет `codex`. В
  `npm run check` не входит (CI без Codex). `--keep` оставляет папку со схемой и печатает путь.
- `src/agent/codex/` — `client.ts` (JSON-RPC клиент), `adapter.ts` (`CodexAdapter`/`CodexSession`), `mapper.ts` (события Codex ->
  `AgentEvent`), `approvals.ts` (подтверждения), `tools.ts`/`patch.ts` (инструменты и правки под именами Claude), `history.ts` (список и лента из `thread/list`/`thread/read`),
  `executable.ts` (поиск бинарника). Фикстуры — `test/fixtures/codex/` (без личных путей и токенов).
- `scripts/codex-smoke.mjs` — живой прогон адаптера (opt-in, ход тратит лимит Codex): без аргументов handshake +
  `model/list`, с `--turn` ещё один короткий ход и resume, `--record <файл>` пишет фикстуру.

## Обновление Codex CLI

1. `codex --version`; если версия новее `CODEX_PROTOCOL_VERSION`, прогнать `npm run codex:protocol`. Расхождения
   (переименованный метод, исчезнувшее поле) — сначала в `protocol.ts`, потом в скрипте, потом в коде.
2. Поля вне схемы, на которые код опирается, скрипт не видит и сверять их нужно на живом сервере. На 0.160.0 это
   `availableDecisions` у запросов подтверждения команды (сервер присылает, в сгенерированной схеме поля нет): по
   нему решается, предлагать ли «всегда» (`acceptForSession` / правило в `~/.codex/rules`).
3. `node scripts/codex-smoke.mjs` (handshake + `model/list` бесплатны); `--turn` — один короткий ход на самой дешёвой
   модели. Если формы событий изменились — перезаписать фикстуру (`--record`) и поправить маппер и его тесты.
4. Ручной smoke — «Финальный smoke Codex» в `docs/roadmap/15-codex-support.pending.md`.
5. Подправить `CODEX_PROTOCOL_VERSION`, шапку `protocol.ts`, упоминание версии в README (раздел Codex).

## Что Agentura не передаёт и почему

- Начальные policy берутся из thread/start/resume; расширение не задаёт их без явного выбора
  (`CodexAdapterConfig.thread` — исключение для smoke/тестов). Глобальный config не пишется.
  `thread/settings/update` меняет одну выбранную ось текущей сессии: approvalPolicy либо sandboxPolicy либо collaborationMode.
  Полные sandbox roots/network/tmp читаются из ответа и `thread/settings/updated`, показываются в меню, не пересылаются обратно
  при выборе другой оси. Повторный выбор текущего sandbox — no-op. Новые readOnly/workspaceWrite пресеты консервативны:
  networkAccess=false, writableRoots=[], excludeTmpdirEnvVar=true, excludeSlashTmp=true (поля workspaceWrite).
  Последние два флага исключают неявные временные корни записи, а не запрещают чтение временных файлов.
  dangerFullAccess доступен только при явном выборе и agentura.allowBypassPermissions; политика never независима от sandbox.
  Изменения разрешены idle без pending approvals/questions; очередь ждёт RPC, Stop отменяет ещё не начавшийся ход.
  Ошибка не подменяет подтверждённое состояние; таймаут закрывает сессию с неизвестными правами. Effective notification главнее RPC payload.
- Manual compact реализован через `thread/compact/start` и lifecycle contextCompaction. `autoCompact` отдельно
  управляет порогами Claude. Skills: `skills/list` и структурированный `UserInput.skill`, идентичность по пути.
- Planning — отдельный native default/plan: `TurnStartParams.collaborationMode` и thread/settings/update,
  settings содержат model/reasoning_effort и developer_instructions=null (встроенные инструкции Codex).
  Вход до первого сообщения не создаёт пустой thread; выбранный режим уходит первым turn/start.
  Resume читает effective collaborationMode; reload восстанавливает актуальные policy и planning.
  `ThreadItem.plan` и item/plan/delta выводятся текстом, включая history. ExitPlanMode не синтезируется;
  для исполнения пользователь переключает default и отправляет сообщение. Native plan approval callback отсутствует.
- Живой usage доступен; цены и TTL кэша нет. История отмечена `usageKnown:false`, числовой placeholder не отображается.
  Текстовые вложения включаются в промпт; PDF/document input не реализован.
- Jira: experimental `thread/start.dynamicTools` → `item/tool/call` → host `TaskTools`. Только новый тред;
  resume или смена binding/settings требуют нового чата. Повтор callId не повторяет запись, pending подтверждение
  отзывается при Stop/close/rebind; transition/worklog и небезопасные комментарии всегда требуют карточку.
- MCP: reload-all текущего app-server. Per-server toggle/reconnect не интегрирован; browser setting действует с нового чата.
- Субагенты приходят `item/started|completed` как `collabAgentToolCall` (`spawnAgent`) и
  `subAgentActivity`; mapper связывает их по дочернему `threadId`. В ленте доступны статусы и итог, но не
  отдельный транскрипт: app-server не передаёт его в родительском потоке.
- Запросы, которых Agentura не поддерживает (форма MCP-сервера, секретный ввод, неизвестный метод), получают отказ и
  красную карточку «Codex request … is not supported / declined»; ход продолжается.

## Остатки и доказательства (0.166.0)

| Остаток | Причина / обход | Новый скоуп |
| --- | --- | --- |
| PDF/document | Нет реализованного преобразования; передать извлечённый текст | Да, извлечение PDF |
| Полный diff | В потоке hunk, достоверного snapshot нет; показывается fragment | Да, захват snapshots |
| Исторический usage | thread/read не возвращает счётчики по ходу; отображать неизвестно | Нет, ждать контракт |
| Child transcript/Stop | Доступ/активный turnId через текущий клиент не подтверждены; summary доступен | Отдельная интеграция и live-проверка |
| Remote Control | Не интегрирован; использовать отдельный клиент Codex | Да |
| Native plan acceptance | Нет native approval callback; план — текст, продолжение через default + сообщение | Отдельный callback требует нового API |
| Jira resume/update | Нет dynamicTools в resume/update; новый чат | Отдельная проверка lifecycle |

Схема и handshake проверены живьём; compact, skill invocation и Jira writes — только автоматические тесты,
не live-подтверждение. Planning и session policy switching также проверены автоматическими тестами без live model turns. Ручной checklist: новый/resume чат; очередь/Stop; compact→продолжение; выбор и открытие скилла;
Jira allow/deny/rebind на тестовой задаче только после разрешения; агенты/карта; MCP/browser; текст/картинка/PDF;
лимиты и usage; контрольная Claude-сессия.
