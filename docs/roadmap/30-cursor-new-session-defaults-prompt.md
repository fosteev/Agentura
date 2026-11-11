# Промт — Cursor defaults в «Новая сессия»

Сессия 1 — Cursor: честные дефолты новой сессии · Модель: sonnet, effort: high

Работаем в `/Users/fost/Projects/Agentura`. Задача: в ⚙ → «Новая сессия» добавить блок **Cursor** только с тем, что реально уходит в новый чат; прокинуть в `createSession`.

Читай: `~/.cursor/roles/coder.md` (контракт роли); `AGENTS.md`.
Точки входа (открывать только правимый фрагмент):
- UI: `src/webview/components/Settings.tsx` (~905–963) — секции Claude/Codex
- ключи: `src/settings.ts` (`SettingKey`, `SETTING_KEYS`, `SettingsValues`, `validateSetting`, `readSettings`)
- contributes: `package.json` (`agentura.codex.defaultModel` рядом), `package.nls.json`, `package.nls.ru.json`
- строки: `src/webview/strings.ts` / `strings.en.ts` (`settings.model`, `settings.newChat`)
- снимок настроек в чат: `src/extension/chatPanel.ts` (~789–818) `settings()`
- применение: `src/extension/chatController.ts` (~1628–1645) — сейчас модель только для `claude`
- тесты: `src/webview/settingsDom.test.ts`, `src/settings.test.ts`, `src/extension/chatControllerProvider.test.ts` (блок `ChatController: Cursor` ~739)
- доки: `README.md`, `README.ru.md` (фраза про Claude/Codex в «Новая сессия»), `CHANGELOG.md`

Эталон: Claude-поле `defaultModel` (TextField) + прокидка `...(claude && s.defaultModel ? { model: s.defaultModel } : {})`. Не эталон для UI-списка: Codex select/`listModels` — у Cursor CLI `--list-models` даёт другие id, чем ACP `modelId`.

Уже решено, не переспрашивать:
1. Только **`agentura.cursor.defaultModel`** (строка, пусто = выбор движка / Auto). Effort, approval, sandbox, отдельный mode для Cursor — **не** добавлять.
2. UI — **TextField**, как у Claude, не Select и не `agent --list-models` / throwaway `session/new`.
3. Режим новой сессии Cursor уже берётся из общего `defaultPermissionMode` (секция Claude) — не дублировать и не переносить.
4. Placeholder/desc честно: ACP `modelId` из меню модели живой сессии (пример вида `composer-2.5[fast=true]` или `default[]`); не обещать список из CLI.
5. В `createSession` для `provider === 'cursor'`: если настройка непуста — передать `model` (адаптер уже шлёт `session/set_config_option`). Resume: как сейчас — модель из истории, не из дефолта настроек; Claude-`defaultModel` в Cursor по-прежнему не уходит.
6. `session.defaults` / effort для Cursor не слать (как сейчас).
7. Строки en+ru; nls en+ru; короткая правка README/README.ru + одна строка CHANGELOG.
8. Тест до кода: расширить Cursor-тест — с `cursor.defaultModel` в settings уходит `model`; без настройки — свойства `model` нет. DOM/settings: ключ в state, поле пишет `settings.set`.

Порядок:
1. Тесты (settings + DOM + chatControllerProvider Cursor) — красные.
2. Ключ в `settings.ts` / `package.json` / nls / strings.
3. Блок `<h3>Cursor</h3>` + Row TextField после Codex в Settings.
4. `chatPanel.settings()` → значение; `chatController` createSession для cursor с `model` при непустом.
5. README / CHANGELOG.
6. `TZ=UTC npm run check`.

DoD: `TZ=UTC npm run check` зелёный; в настройках виден блок Cursor с одним полем модели; новый чат Cursor с непустым `agentura.cursor.defaultModel` создаётся с этим `model`; пустое — без `model` в опциях; resume без подмены на дефолт.

Примеры:
- дано `cursor.defaultModel=''`, новый cursor → `createSession` без `model` → как сейчас.
- дано `cursor.defaultModel='composer-2.5[fast=true]'`, новый cursor → `createSession({…, model: '…'})`.
- дано дефолт, resume cursor с `history.model` → в resume уходит история, не настройка.
- правка поля в UI → `settings.set` key `cursor.defaultModel`.

Не делать: listModels/select/reload; effort/approval/sandbox; трогать `defaultPermissionMode` layout; MCP/лимиты/субагенты; живой прогон ACP; чужие незакоммиченные файлы; «заодно улучшить».

Не коммитить, не пушить.
Последним сообщением — отчёт: сделано (файлы) / отклонения / не проверено / открытые вопросы.
