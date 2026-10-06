# Antigravity (`agy`): протокол и хрупкое хранилище

Снято с `agy` 1.2.17 (сырые логи и подробности — `spikes/antigravity-probe/report.md`, в репозиторий и vsix не входит). Всё ниже — недокументированное поведение чужого CLI: после обновления `agy` может поменяться, поэтому везде мягкая деградация, а не ошибка.

## Что запускаем

| Что | Команда | Где в коде |
| --- | --- | --- |
| Ход чата | долгоживущий процесс на сессию: `agy -p= --input-format stream-json --output-format stream-json --model <id> [--conversation <id>] [--mode accept-edits \| --dangerously-skip-permissions]`; ход — строка NDJSON в stdin, ответ — NDJSON в stdout (`init`, `step_update`, `result`) | `src/agent/antigravity/adapter.ts`, `process.ts`, `protocol.ts`, `mapper.ts` |
| Версия | `agy --version` | `executable.ts` (поиск и проверка пути; кнопка «проверить» в настройках) |
| Модели | `agy models` | `models.ts` |
| Квота | `agy -p "/usage"` — две строки с TAB: семейство, «Weekly Limit Remaining», процент остатка, время сброса; ~5–7 с, модель не нужна, stdin закрываем; таймаут 30 с + сторож 35 с с SIGKILL | `quota.ts` (парсер и запуск), `src/extension/agyQuota.ts` (кэш, не чаще раза в 10 минут, склейка запросов) |

Управляющего протокола нет: Stop = убить процесс (следующий ход поднимает его с `--conversation`), смена модели или режима = пересоздание процесса. Подтверждений по действию нет: без флагов `agy` отклоняет всё, что требует разрешения, и перечисляет это в `result.denied_actions`; повтор в более широком режиме — карточка отказа (`retryWithMode`).

## Что читаем с диска (`~/.gemini/antigravity-cli`, только чтение)

Единственное место, знающее пути, — `src/agent/antigravity/storage.ts` (корень — параметр, тесты на временной папке). Мы **никогда не пишем** в `~/.gemini`.

| Файл | Зачем | Деградация |
| --- | --- | --- |
| `brain/<id>/.system_generated/logs/transcript_full.jsonl` | лента истории при resume; детали правки (`args` вызова, unified diff между `[diff_block_start]` и `[diff_block_end]`) — в стриме диффов нет | нет файла или не тот формат — пустая история / правка без диффа; файл больше 32 МБ — только хвост, ранние ходы считаются потоком («N ранних ходов скрыто») |
| `conversation_summaries.db` (SQLite, WAL) | список бесед проекта (`listSessions`): id, заголовок, время, `workspace_uris` | читается через `node:sqlite` (Node ≥ 22.13; в VS Code на Electron/Node 20 может не быть) **копией** вместе с `-wal`/`-shm` во временную папку, копия удаляется; нет модуля, файла или схема другая — запасной индекс из `globalState` расширения |
| `conversations/<id>.db` | не читаем (SQLite с protobuf-блобами) | — |
| `history.jsonl` | не читаем: туда попадают только интерактивные запуски | — |

Всё, что принадлежит Agentura, живёт в `globalState` VS Code: `agentura.antigravity.sessions` (запасной индекс бесед) и `agentura.antigravity.names` (имена после переименования — `agy` своего rename не имеет).

## Что хрупко

- Формат стрима (`step_update`, `usage`, `denied_actions`): `usage` в `result` накопительный, за ход считаем сумму `usage` шагов DONE.
- Распознавание отказа — по тексту `permission check failed` в `tool_info.error.message`.
- Транскрипт и база сводок — внутренний формат; версия, на которой он снят, — `AGY_STORAGE_VERSION` в `storage.ts`.
- Вывод `/usage` — разбирается мягко (первое `NN%` и первое поле-дата в строке); не разобрали — квота не показывается, чат не страдает.
