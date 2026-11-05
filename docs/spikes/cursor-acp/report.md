# Спайк `agent acp` · 2026-11-05

Живой протокол Cursor CLI. Версия бинарника `agent` — `2026.11.05-86047df` (`agent --version` и `agent about` совпали, `agent status` показал вход). Бинарник и токены в репозиторий не клались. stderr у всех прогонов был пустой (0 байт): шумом его считать не пришлось, контракт — только stdout.

Фикстура `test/fixtures/cursor/acp-pong.ndjson`. Каждая строка — обёртка спайка, не поле протокола: `dir` (`in` — клиент в stdin, `out` — сервер в stdout), `scenario`, `msg` (сам кадр JSON-RPC).

## Запуск

Основной след (pong, чтение `note.txt`, запись `out.txt`, план, вопрос, cancel `sleep 12`, `session/load` в том же процессе и в новом):

```text
agent --model composer-2.5 acp
```

Сервер на `session/new` всё равно ответил `models.currentModelId` = `gpt-5.4-nano[reasoning=medium]`. Отдельные процессы с `--model composer-2.5`, `--model composer-2.5[fast=true]` и без флага модели дали тот же id. Флаг `--model` у `agent acp` в этом билде текущую модель не переключает.

Первый процесс (`agent --model gpt-5.4-nano-none acp`) нормализовал модель в тот же `gpt-5.4-nano[reasoning=medium]`, и каждый ход вернул текст «Add a payment method to continue» и `stopReason` `end_turn`, без инструментов. В фикстуру этот след не входил. Следующий процесс с той же моделью уже провёл нормальные ходы. Стена оплаты в отчёт записана, контрактом хода она не считается.

Модель меняется кадром `session/set_config_option`: `{sessionId, configId: "model", value: "<modelId>"}`. `value` `composer-2.5[fast=true]` сменил `currentValue`, следующий ход (curl) шёл уже на ней. Список id — `session/new` → `models.availableModels[]` (`modelId`, `name`) и дубль в `configOptions` (`id: "model"`, `category: "model"`, `type: "select"`). Перед спайком `agent about` показывал Auto. После прогона модель возвращена на `default[]`: следующий `session/new` без промпта снова отдал `default[]`.

Ход с разрешением снят отдельно, `agent acp` без флага модели, после переключения на `composer-2.5[fast=true]`. Read, edit и `sleep 12` разрешения не просили. `curl -sI https://example.com | head -n 1` попросил: в `toolCall.content` текст «Not in allowlist: curl, head». Ответ `allow-once` сервер принял, ход закончился `end_turn`, в тексте ответа был статус HTTP.

`--force` и `--yolo` не передавались. Каталог настроек Cursor не читался и не писался.

## Таблица решений

| Вопрос | Что пришло |
| --- | --- |
| Поле `jsonrpc` | Есть на каждом кадре stdin и stdout, значение `2.0`. |
| Разрешение | Запрос `session/request_permission`, id число. В этом снимке id `0` — один запрос, не правило «id всегда 0» (тот же `0` у `cursor/create_plan`; остальные id фикстуры ненулевые). `params`: `sessionId`, `toolCall`, `options`. `optionId`: `allow-once`, `allow-always`, `reject-once`. `kind`: `allow_once`, `allow_always`, `reject_once`. Имени `allow-edits` нет. Рабочий ответ: `{outcome:{outcome:"selected", optionId:"allow-once"}}`. Голой строки `allow-once` вместо объекта не слали. |
| Режим | `session/set_mode` `{sessionId, modeId:"plan"}` → `result` `{}` и уведомление `session/update` с `sessionUpdate:"current_mode_update"`, `currentModeId:"plan"`. В `session/new` режимы `agent`, `plan`, `ask`. |
| Список сессий | ACP-метод `session/list` есть: в `initialize` `sessionCapabilities.list` = `{}`. Запрос `{cwd}`, ответ `{sessions:[{sessionId, cwd, updatedAt}]}` — нашей сессии, без title. `agent ls` — TUI: без tty пишет ошибку raw mode и JSON не отдаёт. |
| Токены и цена | Не видели. `usage_update` не было. Ответ `session/prompt` — только `{stopReason}`. |
| Tool в `session/update` | `tool_call`: `toolCallId`, `title`, `kind`, `status:"pending"`, `rawInput`, иногда `locations[{path}]`. `kind`: `read`, `search`, `edit`, `execute`, `other` (`rawInput._toolName` = `createPlan`). `tool_call_update`: тот же `toolCallId`, `status` `in_progress` или `completed`; у read `rawOutput.content` — текст файла; у edit `content[{type:"diff", path, oldText, newText}]`. |
| `cursor/ask_question` | Не видели. Промпт «задай один выбор ping/pong» ушёл в обычный текст. |
| `cursor/create_plan` | Был, id число, блокирующий. `params`: `toolCallId`, `name`, `overview`, `plan`, `todos[{id,content,status}]`, `isProject`, `phases` (пустой массив). Ответ `{outcome:{outcome:"rejected", reason:"spike"}}` ход не завис (`end_turn`). |
| `sessionUpdate` `plan` | Один кадр: `entries[{content, priority, status}]`. Это не метод `cursor/create_plan`. Нового события ленты под него нет. |

Дальше для этапа 2 это контракт, не страница доков.

## Метод → кадр

`initialize` → `protocolVersion` 1, `agentCapabilities.loadSession` true, `promptCapabilities` `{image:true, audio:false, embeddedContext:false}`, `mcpCapabilities` `{http:true, sse:true}`, `sessionCapabilities` только `list`. `authMethods[].id` = `cursor_login`. Списка RPC-методов нет. `rpc.discover` не вызывали.

`authenticate` `{methodId:"cursor_login"}` → `result` `{}`.

`session/new` `{cwd, mcpServers:[]}` → `sessionId`, `modes`, `models`, `configOptions`.

`session/prompt` `{sessionId, prompt:[{type:"text", text}]}` → поток `session/update`, затем `{stopReason}`. Pong пришёл двумя дельтами `agent_message_chunk`: `p` и `ong`. Мысли — отдельные `agent_thought_chunk` с тем же `content:{type:"text", text}`; это не текст хода. На `session/load` история повторяется, включая `user_message_chunk`. В фикстуре повтор сокращён: хода `sleep`/`cancel` в нём нет, `in_progress` нет, `toolCallId` заменены на `replay-*`. Живая форма id — `tool_…` на сценариях read, write, cancel и permission.

`session/cancel` — уведомление без id, `{sessionId}`. Ход `sleep 12` вернулся `stopReason` `cancelled` (процесс не убит).

`session/load` `{sessionId, cwd, mcpServers:[]}` на живой сессии вернул `{modes, models, configOptions}` и до ответа проиграл историю. Тот же вызов с нового процесса после SIGTERM — тоже. На сессии, которая умела только стену оплаты, тот же вызов дал `-32602` и `data.message` «Session … not found», хотя `session/list` эту сессию показывал. Контракт этапа 2 — успешный load живой сессии, не ошибка стены.

`session/set_config_option` — см. выше. `session/delete` и `session/resume` в capabilities не было, их не вызывали. Метода переименования не видно.

Картинки: capability `image` true, блока с картинкой не слали и не получали. Формат вложения не выдумывать, в v1 по-прежнему дропать.

## Что ужато в фикстуре

Полный `availableModels` заменён на два образца и элемент `{_modelsCount:47}`. У `configOptions` модели на `session/new` тот же приём: два `options` и элемент `{_optionsCount:47}`. В ответе `session/set_config_option` сентинел уже сосед поля `options`, не элемент массива, и `currentValue` в эти два образца не входит. Оба сентинела — обрезка фикстуры, не поля протокола.

Имена `availableCommands` на приёмке заменены двумя образцами и `{_commandsCount:115}`. В сыром списке были локальные скиллы и id плагинов; описания к тому моменту уже были сняты. Обрезки по длине строки нет: прежнее утверждение про срез на 4000 символов было неверным, после замены списка длиннее 1500 символов строк не осталось.

Пути cwd и файлов заменены на `<WORK>` и `<path>`. Абсолютный temp-путь машины лежал в тексте плана, разрезанный по дельтам (`/var/folders/…`); на приёмке он заменён на `<tmp>` / `<path>/work`. Часть дельт плана после этого пустая. Домашних путей, почты и ключей в файле нет.

Кадров флага `--model`, стены оплаты и ошибки `-32602` в фикстуре нет: это запись прогона, не пример кадра. Сценарий `permission` — хвост другого процесса, начинается с `session/set_config_option` id 4, без своего `initialize`.

## Не проверено

Сумма в долларах (поля цены не было; ходы короткие). Формат картинки и файла в `prompt`. `cursor/ask_question`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image`. Переименование. Windows. Повтор стены оплаты. `agent ls` как список. Сессии спайка в аккаунте остались: удаления в протоколе нет, каталог настроек не трогали. Временные каталоги прогона удалены.

go
