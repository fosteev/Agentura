# Vendored: Agentmeter

Источник — `/Users/fost/Projects/Agentmeter` (монорепозиторий, пакет `@agentmeter/core` и
`apps/desktop`), коммит `1f4780820c9ec518c018a998888aade85f45aafe` (2026-09-06).
Лицензия MIT, © 2026 Андрей Фостеев (тот же автор). Скопировано 2026-09-30, этап 2 roadmap.

## Что взято

Байт в байт (проверено `cmp`), пути относительно `packages/core/src/`:

| Файл | Зачем |
|---|---|
| `sources/claude/parse.ts` | разбор транскрипта Claude Code: запросы с дедупом по `requestId`, токены, сабагенты |
| `sources/types.ts`, `sources/jsonl.ts` | типы и чтение JSONL для парсера |
| `sources/files.ts`, `attribution/marginal.ts`, `attribution/prefix.ts`, `attribution/calibration.ts` | зависимости `parse.ts` (атрибуция расхода по инструментам; нам пока не нужна, но без них парсер не собрать) |
| `limits/oauth.ts` | разбор ответа `/api/oauth/usage`, `Retry-After`, токена из `.credentials.json` / Keychain |
| `limits/windows.ts` | окна лимитов (в roadmap в списке; сейчас не используется — Codex-окна) |
| `format/tokens.ts` | форматирование токенов (для этапа 4) |

С правками:

| Файл | Источник | Правка |
|---|---|---|
| `limits/usage.ts` | `packages/core/src/limits/usage.ts`, строки 34–85 | только типы `UsageWindowSample`, `UsageSnapshot`, `UsageModelSample`, которые импортирует `oauth.ts`; журнал и калибровка не взяты |
| `desktop/token.ts` | `apps/desktop/src/main/oauth.ts`, `readToken` и `defaultKeychain` | `OauthHost` без `fetch`; тип источника токена — свой литерал вместо `UsageApiStatus` из `@agentmeter/ipc`; `parseCredentials` из vendored `limits/oauth.ts`; опрос, журнал, статус не взяты |

Импорты с расширением `.ts`, как в источнике — для этого в `tsconfig.json` включён
`allowImportingTsExtensions`.

## Как обновлять

Правок в Agentmeter отсюда не делаем. Обновление — заново скопировать файлы из нужного коммита,
прогнать `cmp` по списку «байт в байт», перенести правки из второй таблицы, сменить коммит выше,
прогнать `npm test` (парсер проверяется на эталонах `test/fixtures/claude` — копия
`fixtures/claude` Agentmeter того же коммита: `plain`, `compact`, `parallel`, `sidechain` с
сабагентом, `version-old`).
