# Codex: протокол app-server и обновление CLI

Codex подключён как второй движок (roadmap 15). Agentura запускает `codex app-server` (JSON-RPC 2.0 поверх stdio,
построчный JSON) на каждую вкладку и один короткий процесс на чтение списка/истории/rename. Сам протокол Codex
помечает как **experimental**, поэтому типы не копируются из CLI, а описаны вручную и сверяются скриптом.

## Где что лежит

- `src/agent/codex/protocol.ts` — используемое подмножество протокола: методы, уведомления, server requests, типы.
  В шапке — версия CLI, с которой сверено (`CODEX_PROTOCOL_VERSION`, сейчас `0.160.0`). Чего здесь нет — `unknown`.
- `scripts/codex-protocol.mjs` (`npm run codex:protocol`) — регенерирует схему `codex app-server generate-ts` во
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

- Политика подтверждений и sandbox: `thread/start` их не задаёт, действует `~/.codex/config.toml`. Настроек
  `approvalPolicy`/`sandbox` в расширении нет (`CodexAdapterConfig.thread` — только для smoke и тестов).
- Режимы, план, compact, субагенты, файлы, цена/кэш/лимиты — у Codex в этом протоколе нет аналогов; UI прячет их по
  флагам провайдера (`src/agent/features.ts`: `modes`, `compact`, `subagents`, `plan`, `files`, `cost`; `context` у
  Codex включён). Нули в `turn.result` у Codex означают «неизвестно», не «0».
- Запросы, которых Agentura не поддерживает (форма MCP-сервера, секретный ввод, неизвестный метод), получают отказ и
  красную карточку «Codex request … is not supported / declined»; ход продолжается.
